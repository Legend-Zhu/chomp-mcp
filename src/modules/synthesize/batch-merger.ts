/**
 * Batch-and-merge token-overflow handler.
 *
 * When the assembled synthesis prompt exceeds the model's safe context
 * threshold, this module splits content items into token-safe batches,
 * synthesizes each batch via an LLM call, collects intermediate digests,
 * and merges them via a final merge LLM call. If the merge prompt itself
 * exceeds token limits, the intermediate digests are recursively re-batched
 * and merged until the result fits.
 *
 * Concurrency during batch processing is limited by a semaphore configured
 * via `SynthesizeConfig.maxBatchConcurrency` (default: 2).
 *
 * [Spec: US-SY-005, NFR-SY-001, NFR-SY-005]
 */

import { callLLMWithRetry } from './llm-client.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildMergePrompt,
} from './prompt-builder.js';
import { estimateTokens } from './token-estimator.js';
import {
  parseDigestResponse,
  reconcileSources,
} from './response-parser.js';
import { degradationFallback } from './degradation-handler.js';

import type { ContentItem } from '../../shared/types/content.js';
import type { DigestResult, SourceRef } from '../../shared/types/digest.js';
import type { SynthesizeConfig, OpenAIClient } from './types.js';

// ---------------------------------------------------------------------------
// Semaphore — async concurrency limiter
// ---------------------------------------------------------------------------

/**
 * Minimal async semaphore for limiting concurrent batch processing.
 *
 * Defined inline because the shared semaphore utility has not yet been
 * generated. When `shared/utils/semaphore.ts` is created, this local
 * definition should be replaced with an import.
 *
 * [Constraint: NFR-SY-001]
 */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    this.available = Math.max(1, maxConcurrency);
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter();
    } else {
      this.available++;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Convert a DigestResult into a ContentItem-shaped object suitable for
 * re-batching during recursive merge.
 *
 * The answer text and serialized sources become the content field. A
 * synthetic URL is assigned so the merge prompt builder can interleave
 * the digest as a pseudo-source.
 */
function digestToContentItem(digest: DigestResult, index: number): ContentItem {
  const sourceLines = digest.sources
    .map((src) => `- ${src.url} (${src.title})`)
    .join('\n');

  return {
    title: `Digest ${index + 1}`,
    url: `digest://batch-${index + 1}`,
    snippet: '',
    score: Math.max(0, 1.0 - index * 0.01),
    content: `${digest.answer}\n\nSources:\n${sourceLines}`,
  };
}

// ---------------------------------------------------------------------------
// Batch splitting
// ---------------------------------------------------------------------------

// [Implements: US-SY-005, NFR-SY-005]
/**
 * Split content items into token-safe batches using a greedy packing strategy.
 *
 * Estimates the token cost of fixed prompt overhead (system prompt, query
 * header, optional focus directive, anti-hallucination footer) plus each
 * content item's contribution. Items are added to the current batch until
 * the next item would push the total past the safe threshold
 * (`maxContextTokens * safeThresholdRatio`), at which point a new batch
 * is started.
 *
 * A single item that alone exceeds the threshold is placed in its own
 * batch — the LLM will truncate or the call may fail, triggering
 * degradation fallback at a higher level.
 *
 * @param contents - The content items to batch.
 * @param config - Synthesis configuration with token thresholds.
 * @param query - The search query (contributes to fixed overhead).
 * @param focus - Optional focus directive (contributes to fixed overhead).
 * @returns Array of batches, each a non-empty array of ContentItems (unless
 *   `contents` is empty, in which case a single empty batch is returned).
 *
 * [Spec: US-SY-005]
 * [Constraint: NFR-SY-005]
 */
function splitIntoBatches(
  contents: ContentItem[],
  config: SynthesizeConfig,
  query: string,
  focus: string | undefined
): ContentItem[][] {
  const threshold = Math.floor(
    config.maxContextTokens * config.safeThresholdRatio
  );

  // [Implements: US-SY-005] Estimate fixed prompt overhead
  const systemTokens = estimateTokens(buildSystemPrompt());
  const queryTokens = estimateTokens(`Query: ${query}\n\n`);
  const focusTokens =
    focus !== undefined && focus.trim().length > 0
      ? estimateTokens(`Please focus on: ${focus.trim()}\n\n`)
      : 0;
  const footerTokens = estimateTokens(
    'IMPORTANT: Only cite URLs that appear in the sources above. Do not invent or hallucinate any URLs.'
  );
  const fixedOverhead =
    systemTokens + queryTokens + focusTokens + footerTokens;

  const batches: ContentItem[][] = [];
  let currentBatch: ContentItem[] = [];
  let currentTokens = fixedOverhead;

  for (const item of contents) {
    // [Implements: US-SY-005] Estimate per-item prompt segment tokens
    const itemSegment = `---\nSource: ${item.url}\nTitle: ${item.title}\nContent:\n${item.content}\n\n`;
    const itemTokens = estimateTokens(itemSegment);

    // [Implements: US-SY-005] Start new batch if adding this item exceeds threshold
    if (currentBatch.length > 0 && currentTokens + itemTokens > threshold) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = fixedOverhead;
    }

    currentBatch.push(item);
    currentTokens += itemTokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  // [Implements: US-SY-005] Ensure at least one batch even for empty input
  if (batches.length === 0) {
    batches.push([]);
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

// [Implements: US-SY-005, NFR-SY-001]
/**
 * Process all batches concurrently (limited by semaphore) and collect
 * intermediate digests.
 *
 * For each batch:
 *   1. Acquire a semaphore slot.
 *   2. Build system + user prompts.
 *   3. Call the LLM via `callLLMWithRetry`.
 *   4. Parse the response into a DigestResult.
 *   5. Release the semaphore slot.
 *
 * All batch promises are awaited via `Promise.all`. If any batch fails,
 * the error propagates to the caller (typically `batchAndMerge`'s catch
 * block, which triggers degradation fallback).
 *
 * @param query - The search query.
 * @param batches - Array of content-item batches.
 * @param focus - Optional focus directive.
 * @param client - The OpenAI-compatible LLM client.
 * @param maxConcurrency - Maximum concurrent LLM requests.
 * @returns Array of intermediate DigestResults, one per batch.
 *
 * [Spec: US-SY-005]
 * [Constraint: NFR-SY-001]
 */
async function processBatches(
  query: string,
  batches: ContentItem[][],
  focus: string | undefined,
  client: OpenAIClient,
  config: SynthesizeConfig
): Promise<DigestResult[]> {
  const semaphore = new Semaphore(config.maxBatchConcurrency);

  const promises = batches.map(
    async (batch): Promise<DigestResult> => {
      await semaphore.acquire();
      try {
        const systemPrompt = buildSystemPrompt();
        const userPrompt = buildUserPrompt(query, batch, focus);
        const response = await callLLMWithRetry(
          client,
          systemPrompt,
          userPrompt,
          { model: config.model }
        );
        const parsed = parseDigestResponse(response.content);
        return {
          answer: parsed.answer,
          keyPoints: parsed.keyPoints,
          sources: parsed.sources,
        };
      } finally {
        semaphore.release();
      }
    }
  );

  return Promise.all(promises);
}

// ---------------------------------------------------------------------------
// Merge with recursive re-batching
// ---------------------------------------------------------------------------

// [Implements: US-SY-005, NFR-SY-005]
/**
 * Merge intermediate digests into a single unified DigestResult.
 *
 * If the merge prompt fits within the safe token threshold, a single merge
 * LLM call is made. If the merge prompt exceeds the threshold and there are
 * multiple digests, the digests are converted to ContentItem-like objects,
 * re-batched, re-synthesized into sub-digests, and recursively merged.
 *
 * The recursion terminates when either:
 *   - The merge prompt fits within the threshold, or
 *   - Only one digest remains (cannot split further — the oversized prompt
 *     is sent; if it fails, the error propagates to degradation fallback).
 *
 * @param query - The search query.
 * @param digests - Intermediate digests to merge.
 * @param focus - Optional focus directive.
 * @param client - The OpenAI-compatible LLM client.
 * @param config - Synthesis configuration with token thresholds.
 * @returns A merged DigestResult.
 *
 * [Spec: US-SY-005]
 * [Constraint: NFR-SY-005]
 */
async function mergeDigests(
  query: string,
  digests: DigestResult[],
  focus: string | undefined,
  client: OpenAIClient,
  config: SynthesizeConfig
): Promise<DigestResult> {
  const threshold = Math.floor(
    config.maxContextTokens * config.safeThresholdRatio
  );

  const mergePrompt = buildMergePrompt(query, digests, focus);
  const mergeTokens = estimateTokens(
    mergePrompt.systemPrompt + '\n' + mergePrompt.userPrompt
  );

  // [Implements: US-SY-005] If merge prompt exceeds threshold and we have
  // multiple digests, recursively re-batch and merge.
  if (mergeTokens > threshold && digests.length > 1) {
    process.stderr.write(
      `[SY] merge re-batching: merge prompt exceeds threshold (${mergeTokens} > ${threshold})\n`
    );

    // [Implements: US-SY-005] Convert digests to ContentItem-like objects
    const digestAsContents: ContentItem[] = digests.map((digest, i) =>
      digestToContentItem(digest, i)
    );

    // [Implements: US-SY-005] Re-batch the digests
    const subBatches = splitIntoBatches(
      digestAsContents,
      config,
      query,
      focus
    );

    process.stderr.write(
      `[SY] batching: ${subBatches.length} batches for ${digestAsContents.length} content items\n`
    );

    // [Implements: US-SY-005] Process sub-batches into sub-digests
    const subDigests = await processBatches(
      query,
      subBatches,
      focus,
      client,
      config
    );

    // [Implements: US-SY-005] Recursively merge the sub-digests
    return mergeDigests(query, subDigests, focus, client, config);
  }

  // [Implements: US-SY-005] Merge fits within threshold — make the merge call
  const response = await callLLMWithRetry(
    client,
    mergePrompt.systemPrompt,
    mergePrompt.userPrompt,
    { model: config.model }
  );

  const parsed = parseDigestResponse(response.content);

  return {
    answer: parsed.answer,
    keyPoints: parsed.keyPoints,
    sources: parsed.sources,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// [Implements: US-SY-005, NFR-SY-001, NFR-SY-005]
/**
 * Split content items into token-safe batches, synthesize each batch via
 * an LLM call, and merge the intermediate digests into a single unified
 * DigestResult. Recursively re-batches if the merge prompt itself exceeds
 * token limits.
 *
 * Flow:
 *   1. Compute batches via `splitIntoBatches`.
 *   2. Log `[SY] batching: {N} batches for {M} content items` to stderr.
 *   3. Process batches concurrently (limited by `maxBatchConcurrency`)
 *      and collect intermediate digests.
 *   4. Build a merge prompt and check token fit.
 *   5. If merge exceeds threshold, recursively re-batch and merge.
 *   6. If merge fits, make the merge LLM call and parse the response.
 *   7. Reconcile sources with all original input sources.
 *   8. On any error, return `degradationFallback`.
 *
 * @param query - The search query.
 * @param contents - Content items to synthesize and merge.
 * @param focus - Optional focus directive for synthesis emphasis.
 * @param client - The OpenAI-compatible LLM client.
 * @param config - Synthesis configuration with token thresholds and
 *   concurrency settings.
 * @returns A unified DigestResult, or a degraded fallback on error.
 *
 * [Spec: US-SY-005]
 * [Constraint: NFR-SY-001, NFR-SY-005]
 */
export async function batchAndMerge(
  query: string,
  contents: ContentItem[],
  focus: string | undefined,
  client: OpenAIClient,
  config: SynthesizeConfig
): Promise<DigestResult> {
  try {
    // [Implements: US-SY-005] Guard: empty contents → degradation
    if (contents.length === 0) {
      return degradationFallback(
        query,
        contents,
        'no content to batch-and-merge'
      );
    }

    // [Implements: US-SY-005] Step 1: Compute batches
    const batches = splitIntoBatches(contents, config, query, focus);

    // [Implements: US-SY-005] Step 2: Log batching to stderr
    process.stderr.write(
      `[SY] batching: ${batches.length} batches for ${contents.length} content items\n`
    );

    // [Implements: US-SY-005] Collect all known sources from original content
    const knownSources: SourceRef[] = contents.map((item) => ({
      url: item.url,
      title: item.title,
    }));

    // [Implements: US-SY-005, NFR-SY-001] Step 3: Process batches with
    // concurrency limiting and collect intermediate digests
    const intermediateDigests = await processBatches(
      query,
      batches,
      focus,
      client,
      config
    );

    // [Implements: US-SY-005, NFR-SY-005] Steps 4-6: Merge intermediate
    // digests (with recursive re-batching if the merge prompt is too large)
    const merged = await mergeDigests(
      query,
      intermediateDigests,
      focus,
      client,
      config
    );

    // [Implements: US-SY-005] Step 7: Reconcile sources — ensure all
    // original input sources are represented in the final result
    const reconciled = reconcileSources(merged, knownSources);

    return {
      answer: reconciled.answer,
      keyPoints: reconciled.keyPoints,
      sources: reconciled.sources,
    };
  } catch (error) {
    // [Implements: US-SY-005] Step 8: On any error, return degradation fallback
    return degradationFallback(query, contents, getErrorMessage(error));
  }
}
