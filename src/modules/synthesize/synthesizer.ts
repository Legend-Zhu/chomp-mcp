/**
 * Synthesizer — main orchestrator for LLM synthesis.
 *
 * Implements the public entry points `synthesize()` and `synthesizeSingle()`.
 * The orchestrator ties together prompt building, token estimation, single-call
 * vs batch-and-merge routing, response parsing, source reconciliation, and
 * comprehensive observability logging. Guarantees that the returned Promise
 * never rejects — all errors route to degradationFallback.
 *
 * [Spec: US-SY-003, US-SY-004, US-SY-005, US-SY-007, US-SY-008, US-SY-009,
 *  US-SY-010, BG-SY-001, BG-SY-002, BG-SY-003, NFR-SY-001, NFR-SY-002,
 *  NFR-SY-004, NFR-SY-005, DC-SY-003, DC-SY-005]
 */

import { createLLMClient, callLLMWithRetry } from './llm-client.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildSingleSourcePrompt,
} from './prompt-builder.js';
import { estimateAndLogTokens } from './token-estimator.js';
import {
  parseDigestResponse,
  reconcileSources,
} from './response-parser.js';
import { batchAndMerge } from './batch-merger.js';
import { degradationFallback } from './degradation-handler.js';

import type { ContentItem } from '../../shared/types/content.js';
import type { DigestResult, SourceRef } from '../../shared/types/digest.js';

import type { SynthesizeConfig, OpenAIClient } from './types.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_SAFE_THRESHOLD_RATIO,
  DEFAULT_MAX_BATCH_CONCURRENCY,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// [Constraint: NFR-SY-004] Maximum characters of query text to include in logs.
const MAX_QUERY_LOG_LENGTH = 80;

// [Constraint: US-SY-004] Minimum content length for meaningful single-page synthesis.
const MIN_SINGLE_CONTENT_CHARS = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// [Implements: US-SY-010, NFR-SY-004]
/**
 * Truncate the query text to the maximum log length to avoid log noise.
 */
function truncateQueryForLog(query: string): string {
  if (query.length <= MAX_QUERY_LOG_LENGTH) {
    return query;
  }
  return query.slice(0, MAX_QUERY_LOG_LENGTH);
}

/**
 * Extract a human-readable message from an unknown error value.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Parse a positive integer from an environment variable, falling back to
 * the provided default on missing or invalid values.
 */
function parsePositiveInt(
  value: string | undefined,
  defaultValue: number
): number {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

/**
 * Check whether a DigestResult was produced by the degradation handler
 * by looking for the degradation prefix in the answer.
 */
function isDegradedResult(result: DigestResult): boolean {
  return result.answer.startsWith('[Note: LLM synthesis unavailable');
}

// ---------------------------------------------------------------------------
// Configuration loader
// ---------------------------------------------------------------------------

// [Implements: DC-SY-004, DC-SY-005, NFR-SY-002]
/**
 * Resolve synthesis configuration from environment variables with safe defaults.
 *
 * Environment variables read:
 * - `LLM_API_KEY`: OpenAI-compatible API key (required, empty string if missing).
 * - `LLM_BASE_URL`: LLM API base URL (default: `https://api.openai.com/v1`).
 * - `LLM_MODEL`: Model identifier (default: `gpt-4o-mini`).
 * - `LLM_TIMEOUT_MS`: HTTP timeout for LLM calls (default: `60000`).
 * - `LLM_MAX_CONTEXT_TOKENS`: Maximum context window (default: `128000`).
 * - `LLM_SAFE_THRESHOLD_RATIO`: Safe threshold fraction (default: `0.8`).
 * - `LLM_MAX_BATCH_CONCURRENCY`: Max concurrent batch requests (default: `2`).
 *
 * @returns A fully resolved SynthesizeConfig.
 *
 * [Spec: DC-SY-004, DC-SY-005]
 * [Constraint: NFR-SY-002]
 */
function loadSynthesizeConfig(): SynthesizeConfig {
  const apiKey = process.env['LLM_API_KEY'] ?? '';
  const baseUrl = process.env['LLM_BASE_URL'] ?? DEFAULT_BASE_URL;
  const model = process.env['LLM_MODEL'] ?? DEFAULT_MODEL;
  const timeoutMs = parsePositiveInt(
    process.env['LLM_TIMEOUT_MS'],
    DEFAULT_TIMEOUT_MS
  );
  const maxContextTokens = parsePositiveInt(
    process.env['LLM_MAX_CONTEXT_TOKENS'],
    DEFAULT_MAX_CONTEXT_TOKENS
  );

  // [Constraint: DC-SY-005] Parse safeThresholdRatio with validation
  let safeThresholdRatio = DEFAULT_SAFE_THRESHOLD_RATIO;
  const ratioStr = process.env['LLM_SAFE_THRESHOLD_RATIO'];
  if (ratioStr !== undefined && ratioStr !== '') {
    const parsed = parseFloat(ratioStr);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 1.0) {
      safeThresholdRatio = parsed;
    }
  }

  const maxBatchConcurrency = parsePositiveInt(
    process.env['LLM_MAX_BATCH_CONCURRENCY'],
    DEFAULT_MAX_BATCH_CONCURRENCY
  );

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs,
    maxContextTokens,
    safeThresholdRatio,
    maxBatchConcurrency,
  };
}

// ---------------------------------------------------------------------------
// Module-level lazy LLM client
// ---------------------------------------------------------------------------

let _client: OpenAIClient | null = null;
let _config: SynthesizeConfig | null = null;

// [Implements: US-SY-001, DC-SY-002]
/**
 * Lazily initialize and return the LLM client and configuration.
 *
 * The client is created on first call using configuration resolved from
 * environment variables. Subsequent calls return the cached instance.
 */
function getClient(): { client: OpenAIClient; config: SynthesizeConfig } {
  if (_client === null || _config === null) {
    _config = loadSynthesizeConfig();
    _client = createLLMClient(_config);
  }
  return { client: _client, config: _config };
}

// ---------------------------------------------------------------------------
// Public API: synthesize
// ---------------------------------------------------------------------------

// [Implements: US-SY-003, US-SY-005, US-SY-007, US-SY-008, US-SY-009, US-SY-010,
//  BG-SY-001, BG-SY-002, BG-SY-003, NFR-SY-001, NFR-SY-002, NFR-SY-004,
//  NFR-SY-005, DC-SY-003, DC-SY-005]
/**
 * Synthesize a structured digest from multiple content items.
 *
 * Orchestrates the full synthesis flow:
 *   1. Log synthesis start (truncated query, source count, focus).
 *   2. Guard against empty contents → degradation fallback.
 *   3. Build system + user prompts from the query and content items.
 *   4. Estimate token count and log it with the safe threshold.
 *   5. Route to single-call (tokens ≤ threshold) or batch-and-merge.
 *   6. Parse the LLM response, check for empty answer, reconcile sources.
 *   7. Log token usage and synthesis completion metrics.
 *
 * The returned Promise NEVER rejects — all errors are caught and routed
 * to `degradationFallback`.
 *
 * @param query - The search/fetch query string.
 * @param contents - Array of content items with scraped text.
 * @param focus - Optional focus directive for synthesis emphasis.
 * @returns A DigestResult (either synthesized or degraded).
 *
 * [Spec: US-SY-003, US-SY-005, US-SY-007, US-SY-008, US-SY-009, US-SY-010]
 * [Constraint: NFR-SY-001, NFR-SY-002, NFR-SY-004, NFR-SY-005, DC-SY-003]
 */
export async function synthesize(
  query: string,
  contents: ContentItem[],
  focus?: string
): Promise<DigestResult> {
  // [Implements: US-SY-010, NFR-SY-004] Record start time for duration tracking
  const startTime = Date.now();

  try {
    // [Implements: US-SY-010, NFR-SY-004] Log synthesis start with truncated query
    const truncatedQuery = truncateQueryForLog(query);
    const focusDisplay =
      focus !== undefined && focus.trim().length > 0 ? focus : 'none';
    process.stderr.write(
      `[SY] synthesis start: query="${truncatedQuery}", sources=${contents.length}, focus="${focusDisplay}"\n`
    );

    // [Implements: US-SY-003] Guard: empty contents → degradation fallback
    if (contents.length === 0) {
      return degradationFallback(
        query,
        contents,
        'no content to synthesize'
      );
    }

    // [Implements: US-SY-001, DC-SY-002] Get LLM client (lazy initialization)
    const { client, config } = getClient();

    // [Implements: US-SY-003, US-SY-009] Build prompts
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(query, contents, focus);

    // [Implements: US-SY-009, NFR-SY-005] Estimate tokens and log
    const safeThreshold = Math.floor(
      config.maxContextTokens * config.safeThresholdRatio
    );
    const estimatedTokens = estimateAndLogTokens(
      systemPrompt + userPrompt,
      config.maxContextTokens,
      config.safeThresholdRatio
    );

    // [Implements: US-SY-003] Collect known sources for reconciliation
    const knownSources: SourceRef[] = contents.map((item) => ({
      url: item.url,
      title: item.title,
    }));

    let result: DigestResult;
    let totalTokens = 0;
    let batchCount = 1;

    // [Implements: US-SY-009] Route based on token estimate vs threshold
    if (estimatedTokens <= safeThreshold) {
      // --- Single-call path (US-SY-003) ---

      const response = await callLLMWithRetry(
        client,
        systemPrompt,
        userPrompt,
        { model: config.model }
      );

      totalTokens = response.promptTokens + response.completionTokens;

      // [Implements: US-SY-010, NFR-SY-004] Log total token usage
      process.stderr.write(`[SY] synthesis tokens: ${totalTokens}\n`);

      // [Implements: US-SY-008] Parse the LLM response
      const parsed = parseDigestResponse(response.content);

      // [Implements: US-SY-007] Check for empty answer → degradation
      if (parsed.answer.trim().length === 0) {
        return degradationFallback(
          query,
          contents,
          'empty answer from LLM'
        );
      }

      // [Implements: US-SY-003] Reconcile sources — append missing input sources
      const reconciled = reconcileSources(parsed, knownSources);

      result = {
        answer: reconciled.answer,
        keyPoints: reconciled.keyPoints,
        sources: reconciled.sources,
      };
    } else {
      // --- Batch-and-merge path (US-SY-005) ---

      batchCount = 0; // batchAndMerge logs its own batch counts internally
      result = await batchAndMerge(query, contents, focus, client, config);
    }

    // [Implements: US-SY-010, NFR-SY-004] Log synthesis completion
    const elapsedMs = Date.now() - startTime;
    const degraded = isDegradedResult(result);
    process.stderr.write(
      `[SY] synthesis done: duration=${elapsedMs}ms, tokens=${totalTokens}, batches=${batchCount}, degraded=${degraded}\n`
    );

    return result;
  } catch (error) {
    // [Implements: US-SY-007, BG-SY-003] Never reject — degrade on any error
    const message = getErrorMessage(error);
    process.stderr.write(
      `[SY] synthesis error: ${message}, action=degrade\n`
    );
    return degradationFallback(query, contents, message);
  }
}

// ---------------------------------------------------------------------------
// Public API: synthesizeSingle
// ---------------------------------------------------------------------------

// [Implements: US-SY-004, US-SY-007, US-SY-008, US-SY-010,
//  BG-SY-002, NFR-SY-002, NFR-SY-004]
/**
 * Synthesize a digest from a single web page's content.
 *
 * Constructs a single-source prompt, calls the LLM, parses the response,
 * and returns a DigestResult with sources overridden to exactly one entry
 * (the input URL and title).
 *
 * If the content is shorter than 200 characters, the LLM call is skipped
 * and a degradation result is returned indicating the content is too short.
 *
 * The returned Promise NEVER rejects — all errors are caught and routed
 * to `degradationFallback`.
 *
 * @param url - The source URL of the page.
 * @param title - The title of the page.
 * @param content - The scraped text content of the page.
 * @param focus - Optional focus directive for synthesis emphasis.
 * @returns A DigestResult (either synthesized or degraded).
 *
 * [Spec: US-SY-004, US-SY-007, US-SY-008]
 * [Constraint: NFR-SY-002, NFR-SY-004]
 */
export async function synthesizeSingle(
  url: string,
  title: string,
  content: string,
  focus?: string
): Promise<DigestResult> {
  // [Implements: US-SY-010, NFR-SY-004] Record start time
  const startTime = Date.now();

  // Build the content item for degradation fallback
  const singleItem: ContentItem = {
    title,
    url,
    snippet: '',
    score: 1,
    content,
  };

  try {
    // [Implements: US-SY-010, NFR-SY-004] Log synthesis start
    const truncatedQuery = truncateQueryForLog(url);
    const focusDisplay =
      focus !== undefined && focus.trim().length > 0 ? focus : 'none';
    process.stderr.write(
      `[SY] synthesis start: query="${truncatedQuery}", sources=1, focus="${focusDisplay}"\n`
    );

    // [Implements: US-SY-004] Skip LLM call for content too short
    if (content.length < MIN_SINGLE_CONTENT_CHARS) {
      return degradationFallback(
        url,
        [singleItem],
        'content too short for meaningful synthesis'
      );
    }

    // [Implements: US-SY-001, DC-SY-002] Get LLM client (lazy initialization)
    const { client, config } = getClient();

    // [Implements: US-SY-004] Build single-source prompt
    const { systemPrompt, userPrompt } = buildSingleSourcePrompt(
      url,
      url,
      title,
      content,
      focus
    );

    // [Implements: US-SY-004, US-SY-008] Call LLM and parse response
    const response = await callLLMWithRetry(
      client,
      systemPrompt,
      userPrompt,
      { model: config.model }
    );
    const totalTokens = response.promptTokens + response.completionTokens;

    // [Implements: US-SY-010, NFR-SY-004] Log total token usage
    process.stderr.write(`[SY] synthesis tokens: ${totalTokens}\n`);

    // [Implements: US-SY-008] Parse the LLM response
    const parsed = parseDigestResponse(response.content);

    // [Implements: US-SY-007] Check for empty answer → degradation
    if (parsed.answer.trim().length === 0) {
      return degradationFallback(
        url,
        [singleItem],
        'empty answer from LLM'
      );
    }

    // [Implements: US-SY-004] Override sources to exactly one entry
    const result: DigestResult = {
      answer: parsed.answer,
      keyPoints: parsed.keyPoints,
      sources: [{ url, title }],
    };

    // [Implements: US-SY-010, NFR-SY-004] Log synthesis completion
    const elapsedMs = Date.now() - startTime;
    process.stderr.write(
      `[SY] synthesis done: duration=${elapsedMs}ms, tokens=${totalTokens}, batches=1, degraded=false\n`
    );

    return result;
  } catch (error) {
    // [Implements: US-SY-007, BG-SY-003] Never reject — degrade on any error
    const message = getErrorMessage(error);
    process.stderr.write(
      `[SY] synthesis error: ${message}, action=degrade\n`
    );
    return degradationFallback(url, [singleItem], message);
  }
}
