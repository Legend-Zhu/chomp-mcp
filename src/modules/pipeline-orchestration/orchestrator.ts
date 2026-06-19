/**
 * Pipeline Orchestrator — coordinates the end-to-end research pipeline.
 *
 * Two entry points:
 *   - executeWebSearch: Search → Scrape → Deduplicate → Synthesize (web_search)
 *   - executeWebFetch:  Scrape → Synthesize (web_fetch)
 *
 * Responsibilities:
 *   - Enforce sequential stage ordering (DC-PL-004)
 *   - Limit concurrent scraping via a semaphore (US-PL-003, NFR-PL-003)
 *   - Enforce overall pipeline timeout via TimeoutGuard (US-PL-004, US-PL-005)
 *   - Isolate individual URL failures (US-PL-006, US-PL-007, NFR-PL-004)
 *   - Degrade gracefully when synthesis fails (US-PL-008, US-PL-009, NFR-PL-008)
 *   - Emit structured progress logs to stderr (US-PL-012, NFR-PL-006)
 *   - Read configuration from environment variables (US-PL-013, DC-PL-002)
 *
 * [Spec: US-PL-001, US-PL-002, US-PL-003, US-PL-004, US-PL-005, US-PL-006,
 *        US-PL-007, US-PL-008, US-PL-009, US-PL-010, US-PL-011, US-PL-012,
 *        US-PL-013, US-PL-014, US-PL-015,
 *        BG-PL-001, BG-PL-002, BG-PL-003,
 *        NFR-PL-001, NFR-PL-002, NFR-PL-003, NFR-PL-004, NFR-PL-005,
 *        NFR-PL-006, NFR-PL-007, NFR-PL-008,
 *        DC-PL-001, DC-PL-002, DC-PL-003, DC-PL-004, DC-PL-005]
 */

import { AppError } from '../../shared/utils/errors.js';
import type { ErrorCategory } from '../../shared/utils/errors.js';
import type { ContentItem } from '../../shared/types/content.js';
import type { DeduplicatedItem } from '../../shared/types/deduplicate.js';
import type { DigestResult, SourceRef } from '../../shared/types/digest.js';
import type { ScrapeResult } from '../../shared/types/scrape.js';

import { scrape } from '../scrape-extract/index.js';
import type { ScrapeOptions } from '../scrape-extract/index.js';
import { deduplicate } from '../deduplicate/index.js';

import {
  TimeoutGuard,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from './timeout-guard.js';

// ===========================================================================
// Types and Interfaces
// ===========================================================================

/**
 * A single search result item returned by the search-retrieve (SR) module.
 *
 * Contains the minimal fields needed by the pipeline: title, url, snippet,
 * and relevance score.
 *
 * [Spec: US-PL-014]
 */
export interface SearchResultItem {
  /** Page title from the search engine result. */
  title: string;
  /** Canonical URL of the search result. */
  url: string;
  /** Search-result snippet text. */
  snippet: string;
  /** Relevance score from search (normalized [0.0, 1.0]). */
  score: number;
}

/**
 * A URL that failed during the scrape stage, with its failure reason.
 *
 * [Spec: US-PL-006, US-PL-011, US-PL-012]
 */
export interface FailedUrl {
  /** The URL that failed. */
  url: string;
  /** Error category: http_error, timeout, network, parse_error, validation, config, unknown. */
  category: ErrorCategory;
  /** Human-readable error message. */
  error: string;
}

/**
 * Search function signature for dependency injection.
 *
 * The search-retrieve module must export a function matching this signature.
 *
 * [Spec: US-PL-001, US-PL-010, DC-PL-003]
 */
export type SearchFunction = (
  query: string,
  maxResults?: number
) => Promise<SearchResultItem[]>;

/**
 * Synthesize function signature for dependency injection.
 *
 * The synthesize module must export a function matching this signature.
 *
 * [Spec: US-PL-001, US-PL-002, US-PL-008, US-PL-009, DC-PL-003]
 */
export type SynthesizeFunction = (
  query: string,
  contents: ContentItem[],
  focus?: string
) => Promise<DigestResult>;

/**
 * Injectable dependencies for the pipeline. Allows tests to mock the four
 * processing modules without requiring actual network or LLM calls.
 *
 * [Spec: DC-PL-003, DC-PL-005]
 */
export interface PipelineDeps {
  /** Search-retrieve module entry function. */
  search: SearchFunction;
  /** Scrape-extract module entry function. */
  scrape: typeof scrape;
  /** Deduplicate module entry function. */
  deduplicate: typeof deduplicate;
  /** Synthesize module entry function. */
  synthesize: SynthesizeFunction;
}

/**
 * Pipeline configuration resolved from environment variables.
 *
 * [Spec: US-PL-013, DC-PL-002]
 */
export interface PipelineConfig {
  /** Maximum concurrent scrape operations (env MAX_CONCURRENCY, default 3). */
  maxConcurrency: number;
  /** Per-scrape timeout in ms (env SCRAPE_TIMEOUT_MS, default 15000). */
  scrapeTimeoutMs: number;
  /** Max extracted text length in chars (env MAX_CONTENT_CHARS, default 8000). */
  maxContentChars: number;
  /** Overall pipeline timeout in ms (env PIPELINE_TIMEOUT_MS, default 30000). */
  pipelineTimeoutMs: number;
}

// ===========================================================================
// Error Classes
// ===========================================================================

/**
 * Error thrown by the pipeline for hard failures that the MCP server should
 * present as `isError: true`.
 *
 * Extends AppError with an array of failed URLs for diagnostic context.
 *
 * [Spec: US-PL-006, US-PL-007, US-PL-010, US-PL-011, NFR-PL-004]
 */
// [Implements: NFR-PL-004, US-PL-006]
export class PipelineError extends AppError {
  /** URLs that failed during scraping, for diagnostic context. */
  readonly failedUrls: FailedUrl[];

  constructor(
    message: string,
    category: ErrorCategory = 'unknown',
    failedUrls: FailedUrl[] = []
  ) {
    super(message, category);
    this.name = 'PipelineError';
    this.failedUrls = failedUrls;
  }
}

/**
 * Error thrown when the overall pipeline timeout elapses during an
 * unrecoverable phase (e.g., during scrape in web_fetch).
 *
 * [Spec: US-PL-004, US-PL-005, US-PL-015]
 */
// [Implements: US-PL-004, US-PL-005]
export class PipelineTimeoutError extends PipelineError {
  /** The configured timeout value (in ms) that was exceeded. */
  readonly timeoutMs: number;

  constructor(
    message: string,
    timeoutMs: number,
    failedUrls: FailedUrl[] = []
  ) {
    super(message, 'timeout', failedUrls);
    this.name = 'PipelineTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

// ===========================================================================
// Constants
// ===========================================================================

/** Default maximum concurrency for parallel scraping (DC-PL-002). */
const DEFAULT_MAX_CONCURRENCY = 3;

/** Default per-scrape timeout in ms (DC-PL-002). */
const DEFAULT_SCRAPE_TIMEOUT_MS = 15_000;

/** Default max content length in characters (DC-PL-002). */
const DEFAULT_MAX_CONTENT_CHARS = 8_000;

/** Minimum meaningful content length for web_fetch (US-PL-002). */
const MIN_MEANINGFUL_CONTENT_CHARS = 1;

// ===========================================================================
// Configuration
// ===========================================================================

/**
 * Parse a positive integer from an environment variable string.
 * Returns undefined if the value is missing, non-numeric, zero, or negative.
 *
 * [Constraint: US-PL-013]
 */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

/**
 * Resolve pipeline configuration from environment variables with safe defaults.
 *
 * Reads MAX_CONCURRENCY, SCRAPE_TIMEOUT_MS, MAX_CONTENT_CHARS, and
 * PIPELINE_TIMEOUT_MS. Invalid values trigger a stderr warning and fall back
 * to the documented defaults.
 *
 * [Implements: US-PL-013, DC-PL-002, NFR-PL-003]
 */
// [Implements: US-PL-013, DC-PL-002]
export function loadPipelineConfig(): PipelineConfig {
  // [Implements: US-PL-013, US-PL-003] MAX_CONCURRENCY
  const envConcurrency = process.env['MAX_CONCURRENCY'];
  const concurrency = parsePositiveInt(envConcurrency);
  const maxConcurrency =
    concurrency !== undefined
      ? concurrency
      : (() => {
          if (envConcurrency !== undefined && envConcurrency !== '') {
            process.stderr.write(
              `[PL] WARN invalid MAX_CONCURRENCY="${envConcurrency}" — using default ${DEFAULT_MAX_CONCURRENCY}\n`
            );
          }
          return DEFAULT_MAX_CONCURRENCY;
        })();

  // [Implements: US-PL-013] SCRAPE_TIMEOUT_MS
  const envScrapeTimeout = process.env['SCRAPE_TIMEOUT_MS'];
  const scrapeTimeout = parsePositiveInt(envScrapeTimeout);
  const scrapeTimeoutMs =
    scrapeTimeout !== undefined
      ? scrapeTimeout
      : (() => {
          if (envScrapeTimeout !== undefined && envScrapeTimeout !== '') {
            process.stderr.write(
              `[PL] WARN invalid SCRAPE_TIMEOUT_MS="${envScrapeTimeout}" — using default ${DEFAULT_SCRAPE_TIMEOUT_MS}\n`
            );
          }
          return DEFAULT_SCRAPE_TIMEOUT_MS;
        })();

  // [Implements: US-PL-013] MAX_CONTENT_CHARS
  const envMaxChars = process.env['MAX_CONTENT_CHARS'];
  const maxCharsParsed = parseInt(envMaxChars ?? '', 10);
  const maxContentChars =
    envMaxChars === undefined || envMaxChars === '' || Number.isNaN(maxCharsParsed)
      ? (() => {
          if (envMaxChars !== undefined && envMaxChars !== '') {
            process.stderr.write(
              `[PL] WARN invalid MAX_CONTENT_CHARS="${envMaxChars}" — using default ${DEFAULT_MAX_CONTENT_CHARS}\n`
            );
          }
          return DEFAULT_MAX_CONTENT_CHARS;
        })()
      : maxCharsParsed;

  // [Implements: US-PL-013, US-PL-004] PIPELINE_TIMEOUT_MS
  const envPipelineTimeout = process.env['PIPELINE_TIMEOUT_MS'];
  const pipelineTimeout = parsePositiveInt(envPipelineTimeout);
  const pipelineTimeoutMs =
    pipelineTimeout !== undefined
      ? pipelineTimeout
      : (() => {
          if (envPipelineTimeout !== undefined && envPipelineTimeout !== '') {
            process.stderr.write(
              `[PL] WARN invalid PIPELINE_TIMEOUT_MS="${envPipelineTimeout}" — using default ${DEFAULT_PIPELINE_TIMEOUT_MS}\n`
            );
          }
          return DEFAULT_PIPELINE_TIMEOUT_MS;
        })();

  return {
    maxConcurrency,
    scrapeTimeoutMs,
    maxContentChars,
    pipelineTimeoutMs,
  };
}

// ===========================================================================
// Concurrency Semaphore
// ===========================================================================

/**
 * Simple async semaphore for limiting concurrent operations.
 *
 * Guarantees that at most `maxConcurrency` operations run simultaneously.
 *
 * [Implements: US-PL-003, NFR-PL-003]
 */
// [Implements: US-PL-003, NFR-PL-003]
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void>;

  constructor(max: number) {
    this.available = max;
    this.waiters = [];
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.available--;
  }

  release(): void {
    this.available++;
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next();
    }
  }
}

// ===========================================================================
// Logging Helpers
// ===========================================================================

// [Implements: US-PL-012, NFR-PL-006]
function logStageComplete(
  stage: string,
  inputCount: number,
  outputCount: number,
  elapsedMs: number
): void {
  process.stderr.write(
    `[PL] stage=${stage} in=${inputCount} out=${outputCount} ms=${elapsedMs}\n`
  );
}

function logScrapeFailure(
  url: string,
  category: string,
  error: string
): void {
  process.stderr.write(
    `[PL] scrape-failed url=${url} category=${category} error=${error}\n`
  );
}

function logPipelineOutcome(
  outcome: 'success' | 'partial' | 'degraded' | 'failed',
  elapsedMs: number,
  stageCounts: Record<string, number>
): void {
  const countsStr = Object.entries(stageCounts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  process.stderr.write(
    `[PL] outcome=${outcome} ms=${elapsedMs} ${countsStr}\n`
  );
}

// ===========================================================================
// Error Classification Helpers
// ===========================================================================

/**
 * Classify a scrape failure error message into an ErrorCategory.
 *
 * [Implements: US-PL-006, US-PL-012]
 */
function classifyScrapeError(errorMessage: string): ErrorCategory {
  const lower = errorMessage.toLowerCase();

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'timeout';
  }
  if (lower.includes('dns') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network') || lower.includes('unreachable') || lower.includes('connection')) {
    return 'network';
  }
  if (lower.startsWith('http ') || /\bhttp \d{3}\b/.test(lower)) {
    return 'http_error';
  }
  if (lower.includes('parse') || lower.includes('extract')) {
    return 'parse_error';
  }
  if (lower.includes('validation') || lower.includes('invalid url') || lower.includes('url is required') || lower.includes('ssrf') || lower.includes('loopback') || lower.includes('private')) {
    return 'validation';
  }
  return 'unknown';
}

/**
 * Format a user-friendly error message for a web_fetch scrape failure.
 *
 * Includes actionable suggestions based on the error category.
 *
 * [Implements: US-PL-007]
 */
// [Implements: US-PL-007]
function formatFetchErrorMessage(
  url: string,
  scrapeError: string,
  config: PipelineConfig
): string {
  const category = classifyScrapeError(scrapeError);

  // Extract HTTP status code if present
  const httpMatch = /\bHTTP (\d{3})\b/.exec(scrapeError);
  const statusCode = httpMatch ? parseInt(httpMatch[1], 10) : 0;

  if (category === 'http_error' && statusCode > 0) {
    if (statusCode === 404) {
      return `The page returned 404 — verify the URL is correct (${url})`;
    }
    if (statusCode === 401 || statusCode === 403) {
      return `The page returned ${statusCode} — the page requires authentication or blocks automated access (${url})`;
    }
    if (statusCode === 429) {
      return `The page returned 429 (Too Many Requests) — the site is rate-limiting requests (${url})`;
    }
    return `The page returned HTTP ${statusCode} — the server returned an error (${url})`;
  }

  if (category === 'timeout') {
    return `The request to ${url} timed out after ${config.scrapeTimeoutMs}ms. Check connectivity or increase SCRAPE_TIMEOUT_MS.`;
  }

  if (category === 'network') {
    return `The URL ${url} could not be reached. Verify network connectivity and that the URL is correct.`;
  }

  if (category === 'validation') {
    return `${scrapeError}`;
  }

  return `Failed to scrape ${url}: ${scrapeError}`;
}

// ===========================================================================
// Graceful Degration Helpers
// ===========================================================================

/**
 * Build a fallback DigestResult from scraped content when synthesis fails.
 *
 * Concatenates titles, URLs, and truncated content of all items, prepended
 * with a notice that LLM synthesis was unavailable.
 *
 * [Implements: US-PL-008, US-PL-009, NFR-PL-008]
 */
// [Implements: US-PL-008, US-PL-009, NFR-PL-008]
function buildDegradedResult(
  contents: ContentItem[],
  reason: string,
  maxContentChars: number
): DigestResult {
  process.stderr.write(`[PL] degradation activated: ${reason}\n`);

  const DEGRADATION_NOTICE =
    '[Note: LLM synthesis was unavailable. The content below is raw concatenated excerpts from scraped pages.]';

  if (contents.length === 0) {
    return {
      answer: DEGRADATION_NOTICE,
      keyPoints: [],
      sources: [],
    };
  }

  // Sort by descending score for best content first
  const sorted = [...contents].sort((a, b) => b.score - a.score);

  const parts: string[] = [];
  let totalLength = DEGRADATION_NOTICE.length;

  for (const item of sorted) {
    if (totalLength >= maxContentChars) {
      break;
    }

    const separator = '\n\n';
    const remaining = maxContentChars - totalLength - separator.length;
    if (remaining <= 0) break;

    const entry = `[${item.title}](${item.url})\n${item.content}`;
    const trimmed = entry.length <= remaining
      ? entry
      : entry.slice(0, remaining).trimEnd() + '…';

    parts.push(trimmed);
    totalLength += separator.length + trimmed.length;
  }

  const answer = `${DEGRADATION_NOTICE}\n\n${parts.join('\n\n')}`;

  // Build sources from all content items
  const sources: SourceRef[] = contents.map((item) => ({
    url: item.url,
    title: item.title,
  }));

  // Build key points from first sentences
  const keyPoints: string[] = [];
  for (const item of sorted.slice(0, 10)) {
    const match = item.content.trim().match(/^([^.]*\.(?=\s|$))/);
    const sentence = match ? match[1].trim() : item.content.trim().slice(0, 200);
    if (sentence.length > 0) {
      keyPoints.push(sentence);
    }
  }

  return { answer, keyPoints, sources };
}

// ===========================================================================
// Concurrency-Limited Scraping
// ===========================================================================

/**
 * Scrape a single URL within the pipeline, catching all errors and converting
 * them to a FailedUrl entry. Never throws.
 *
 * [Implements: US-PL-006, NFR-PL-004]
 */
async function scrapeWithIsolation(
  url: string,
  deps: PipelineDeps,
  config: PipelineConfig,
  signal: AbortSignal
): Promise<{ ok: true; content: string; title: string } | { ok: false; failure: FailedUrl }> {
  const options: ScrapeOptions = {
    timeoutMs: config.scrapeTimeoutMs,
    maxContentChars: config.maxContentChars,
    signal,
  };

  try {
    const result: ScrapeResult = await deps.scrape(url, options);

    if (result.success) {
      // [Implements: US-PL-006] Success — return content
      return { ok: true, content: result.textContent, title: result.title };
    }

    // [Implements: US-PL-006, US-PL-012] Log failure and isolate
    const category = classifyScrapeError(result.error);
    logScrapeFailure(url, category, result.error);
    return {
      ok: false,
      failure: { url, category, error: result.error },
    };
  } catch (error) {
    // [Implements: US-PL-006, NFR-PL-004] Catch uncaught exceptions
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[PL] uncaught scrape exception url=${url} error=${message}\n`
    );
    logScrapeFailure(url, 'unknown', message);
    return {
      ok: false,
      failure: { url, category: 'unknown', error: message },
    };
  }
}

/**
 * Scrape all candidate URLs concurrently with a concurrency limit.
 *
 * Returns successful content items and failed URLs separately.
 *
 * [Implements: US-PL-003, US-PL-006, US-PL-014, US-PL-015, NFR-PL-003, NFR-PL-004]
 */
// [Implements: US-PL-003, US-PL-006, US-PL-014]
async function scrapeAllUrls(
  searchResults: SearchResultItem[],
  deps: PipelineDeps,
  config: PipelineConfig,
  signal: AbortSignal
): Promise<{ items: ContentItem[]; failures: FailedUrl[] }> {
  const semaphore = new Semaphore(config.maxConcurrency);
  const items: ContentItem[] = [];
  const failures: FailedUrl[] = [];

  // [Implements: US-PL-003] Dispatch concurrently with semaphore
  const scrapePromises = searchResults.map(async (result) => {
    await semaphore.acquire();
    try {
      // [Implements: US-PL-015] Check abort signal before starting
      if (signal.aborted) {
        return;
      }

      const outcome = await scrapeWithIsolation(
        result.url,
        deps,
        config,
        signal
      );

      if (outcome.ok) {
        // [Implements: US-PL-014] Attach content to the result object
        items.push({
          title: outcome.title || result.title,
          url: result.url,
          snippet: result.snippet,
          score: result.score,
          content: outcome.content,
        });
      } else {
        failures.push(outcome.failure);
      }
    } finally {
      // [Implements: US-PL-015, NFR-PL-003] Release semaphore slot
      semaphore.release();
    }
  });

  await Promise.all(scrapePromises);

  return { items, failures };
}

// ===========================================================================
// web_search Pipeline
// ===========================================================================

/**
 * Execute the full web_search pipeline: Search → Scrape → Deduplicate → Synthesize.
 *
 * Stage ordering is strictly sequential (DC-PL-004). Within the scrape stage,
 * individual URLs are scraped concurrently up to MAX_CONCURRENCY (US-PL-003).
 *
 * Error handling:
 *   - Search failure → throws PipelineError (US-PL-010)
 *   - Individual URL scrape failure → isolated, logged, excluded (US-PL-006)
 *   - All URLs fail → throws PipelineError listing failures (US-PL-011)
 *   - Deduplication removes all results → returns message (US-PL-011)
 *   - Synthesis failure → graceful degradation fallback (US-PL-008)
 *   - Overall timeout → returns best partial result or throws (US-PL-004)
 *
 * @param query - Non-empty search query string.
 * @param maxResults - Maximum number of search results (default 5).
 * @param focus - Optional focus directive for synthesis.
 * @param deps - Optional injected dependencies for testing.
 * @returns A DigestResult with synthesized answer, key points, and sources.
 *
 * [Spec: US-PL-001, US-PL-003, US-PL-004, US-PL-006, US-PL-008, US-PL-010,
 *        US-PL-011, US-PL-012, US-PL-013, US-PL-014, US-PL-015,
 *        BG-PL-001, BG-PL-002, BG-PL-003,
 *        NFR-PL-001, NFR-PL-003, NFR-PL-004, NFR-PL-005, NFR-PL-006,
 *        NFR-PL-007, NFR-PL-008,
 *        DC-PL-001, DC-PL-002, DC-PL-003, DC-PL-004, DC-PL-005]
 */
// [Implements: US-PL-001, US-PL-003, US-PL-004, US-PL-006, US-PL-008,
//  US-PL-010, US-PL-011, US-PL-012, US-PL-013, US-PL-014, US-PL-015]
export async function executeWebSearch(
  query: string,
  maxResults: number = 5,
  focus?: string,
  deps?: PipelineDeps
): Promise<DigestResult> {
  const config = loadPipelineConfig();
  const resolvedDeps = deps ?? (await resolveDefaultDeps());
  const startTime = Date.now();

  // [Implements: US-PL-004, US-PL-012] Start overall timeout guard
  const guard = new TimeoutGuard(config.pipelineTimeoutMs);

  // [Implements: US-PL-012] Log pipeline start
  process.stderr.write(
    `[PL] web_search query="${query}" max_results=${maxResults} focus="${focus ?? ''}"\n`
  );

  const stageCounts: Record<string, number> = {};

  try {
    // =====================================================================
    // Stage 1: Search (SR)
    // =====================================================================

    // [Implements: US-PL-010, DC-PL-004] Sequential stage ordering
    const searchStartTime = Date.now();
    let searchResults: SearchResultItem[];
    try {
      searchResults = await resolvedDeps.search(query, maxResults);
    } catch (error) {
      // [Implements: US-PL-010] Search stage failure
      const message = error instanceof Error ? error.message : String(error);
      const searxngUrl = process.env['SEARXNG_URL'] ?? '(not configured)';
      throw new PipelineError(
        `Search failed: ${message}. SearXNG URL: ${searxngUrl}. Verify SEARXNG_URL or deploy a self-hosted instance.`,
        classifyScrapeError(message)
      );
    }

    // [Implements: US-PL-010] Treat zero results as search failure
    if (searchResults.length === 0) {
      const searxngUrl = process.env['SEARXNG_URL'] ?? '(not configured)';
      throw new PipelineError(
        `Search returned zero results. SearXNG URL: ${searxngUrl}. Verify SEARXNG_URL or deploy a self-hosted instance.`,
        'unknown'
      );
    }

    // [Implements: US-PL-010] Filter out results with invalid/empty URLs
    const validResults = searchResults.filter(
      (r) => r.url && r.url.trim().length > 0
    );
    if (validResults.length === 0) {
      throw new PipelineError(
        'No usable search results found (all results had invalid or empty URLs).',
        'validation'
      );
    }

    const searchElapsed = Date.now() - searchStartTime;
    stageCounts['search'] = validResults.length;
    // [Implements: US-PL-012]
    logStageComplete('search', searchResults.length, validResults.length, searchElapsed);

    // [Implements: US-PL-004] Check timeout after search
    if (guard.isAborted) {
      return handleTimeoutDegradation([], 'web_search', config, startTime, stageCounts);
    }

    // =====================================================================
    // Stage 2: Scrape (SC) — concurrent with semaphore
    // =====================================================================

    // [Implements: US-PL-003, US-PL-006]
    const scrapeStartTime = Date.now();
    const { items: scrapedItems, failures: scrapeFailures } =
      await scrapeAllUrls(validResults, resolvedDeps, config, guard.signal);

    const scrapeElapsed = Date.now() - scrapeStartTime;
    stageCounts['scraped'] = scrapedItems.length;
    // [Implements: US-PL-012]
    logStageComplete(
      'scrape',
      validResults.length,
      scrapedItems.length,
      scrapeElapsed
    );

    // [Implements: US-PL-011] All URLs failed — abort pipeline
    if (scrapedItems.length === 0 && scrapeFailures.length > 0) {
      const failedUrlList = scrapeFailures
        .map((f) => `  - ${f.url}: ${f.error}`)
        .join('\n');
      throw new PipelineError(
        `All ${scrapeFailures.length} URL(s) failed to scrape:\n${failedUrlList}`,
        'http_error',
        scrapeFailures
      );
    }

    // [Implements: US-PL-004] Check timeout after scrape
    if (guard.isAborted) {
      // Return best partial result — concatenated scraped content
      return handleTimeoutDegradation(
        scrapedItems,
        'web_search',
        config,
        startTime,
        stageCounts
      );
    }

    // =====================================================================
    // Stage 3: Deduplicate (DD)
    // =====================================================================

    // [Implements: US-PL-014, DC-PL-004]
    const dedupStartTime = Date.now();
    let dedupedItems: DeduplicatedItem[];
    try {
      dedupedItems = resolvedDeps.deduplicate(scrapedItems);
    } catch (error) {
      // [Implements: NFR-PL-004] Catch DD errors — use scraped items as-is
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[PL] deduplicate error: ${message}\n`);
      // Fall back to scraped items (treat them as deduped)
      dedupedItems = scrapedItems.map((item) => ({
        ...item,
        normalizedUrl: item.url,
        mergedSources: [],
        fingerprintCount: 0,
      }));
    }

    const dedupElapsed = Date.now() - dedupStartTime;
    stageCounts['deduplicated'] = dedupedItems.length;
    // [Implements: US-PL-012]
    logStageComplete(
      'deduplicate',
      scrapedItems.length,
      dedupedItems.length,
      dedupElapsed
    );

    // [Implements: US-PL-011] All results filtered out by deduplication
    if (dedupedItems.length === 0) {
      // [Implements: US-PL-001] Continue with partial data (scraped items)
      // if dedup removed everything, use the original scraped items
      process.stderr.write(
        `[PL] deduplication removed all results — falling back to pre-dedup items\n`
      );
      dedupedItems = scrapedItems.map((item) => ({
        ...item,
        normalizedUrl: item.url,
        mergedSources: [],
        fingerprintCount: 0,
      }));
    }

    // =====================================================================
    // Stage 4: Synthesize (SY) — with graceful degradation
    // =====================================================================

    // [Implements: US-PL-001, DC-PL-004]
    const synthesizeStartTime = Date.now();
    let result: DigestResult;
    try {
      const contentItems: ContentItem[] = dedupedItems.map((d) => ({
        title: d.title,
        url: d.url,
        snippet: d.snippet,
        score: d.score,
        content: d.content,
      }));

      result = await resolvedDeps.synthesize(query, contentItems, focus);

      // [Implements: US-PL-001] Check for empty/unmeaningful result
      if (!result.answer || result.answer.trim().length === 0) {
        throw new Error('Synthesis returned empty answer');
      }
    } catch (error) {
      // [Implements: US-PL-008, NFR-PL-008] Graceful degradation
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[PL] synthesize failed: ${message} — degrading\n`);

      const contentItems: ContentItem[] = dedupedItems.map((d) => ({
        title: d.title,
        url: d.url,
        snippet: d.snippet,
        score: d.score,
        content: d.content,
      }));

      result = buildDegradedResult(
        contentItems,
        `synthesize error: ${message}`,
        config.maxContentChars
      );
    }

    const synthesizeElapsed = Date.now() - synthesizeStartTime;
    stageCounts['synthesized'] = result.sources.length;
    // [Implements: US-PL-012]
    logStageComplete(
      'synthesize',
      dedupedItems.length,
      result.sources.length,
      synthesizeElapsed
    );

    // [Implements: US-PL-012] Log final outcome
    const totalElapsed = Date.now() - startTime;
    const outcome = scrapeFailures.length > 0 ? 'partial' : 'success';
    logPipelineOutcome(outcome, totalElapsed, stageCounts);

    return result;
  } finally {
    // [Implements: US-PL-004, US-PL-005, NFR-PL-005] Always clean up the timeout guard
    guard.cleanup();
  }
}

// ===========================================================================
// web_fetch Pipeline
// ===========================================================================

/**
 * Execute the web_fetch sub-flow: Scrape → Synthesize for a single known URL.
 *
 * Error handling:
 *   - Scrape failure → throws PipelineError with actionable message (US-PL-007)
 *   - Empty content → returns informative message (US-PL-002)
 *   - Synthesis failure → returns truncated content with notice (US-PL-009)
 *   - Overall timeout during scrape → throws PipelineTimeoutError (US-PL-005)
 *   - Overall timeout during synthesis → returns truncated content (US-PL-005)
 *
 * @param url - Target URL to fetch and synthesize.
 * @param focus - Optional focus directive for synthesis.
 * @param deps - Optional injected dependencies for testing.
 * @returns A DigestResult with synthesized answer, key points, and sources.
 *
 * [Spec: US-PL-002, US-PL-005, US-PL-007, US-PL-009, US-PL-012, US-PL-013,
 *        US-PL-015,
 *        BG-PL-001, NFR-PL-002, NFR-PL-004, NFR-PL-005, NFR-PL-006,
 *        NFR-PL-008, DC-PL-001, DC-PL-003, DC-PL-005]
 */
// [Implements: US-PL-002, US-PL-005, US-PL-007, US-PL-009, US-PL-012,
//  US-PL-013, US-PL-015]
export async function executeWebFetch(
  url: string,
  focus?: string,
  deps?: PipelineDeps
): Promise<DigestResult> {
  const config = loadPipelineConfig();
  const resolvedDeps = deps ?? (await resolveDefaultDeps());
  const startTime = Date.now();

  // [Implements: US-PL-005] Start overall timeout guard
  const guard = new TimeoutGuard(config.pipelineTimeoutMs);

  // [Implements: US-PL-012] Log pipeline start
  process.stderr.write(
    `[PL] web_fetch url="${url}" focus="${focus ?? ''}"\n`
  );

  try {
    // =====================================================================
    // Stage 1: Scrape (SC)
    // =====================================================================

    const options: ScrapeOptions = {
      timeoutMs: config.scrapeTimeoutMs,
      maxContentChars: config.maxContentChars,
      signal: guard.signal,
    };

    let scrapeResult: ScrapeResult;
    try {
      scrapeResult = await resolvedDeps.scrape(url, options);
    } catch (error) {
      // [Implements: US-PL-005, NFR-PL-004] Check if timeout caused this
      if (guard.isAborted) {
        throw new PipelineTimeoutError(
          `Timeout: scrape of ${url} exceeded ${config.pipelineTimeoutMs}ms pipeline timeout`,
          config.pipelineTimeoutMs,
          [{ url, category: 'timeout', error: 'pipeline timeout' }]
        );
      }
      // [Implements: US-PL-007, NFR-PL-004] Unexpected scrape exception
      const message = error instanceof Error ? error.message : String(error);
      throw new PipelineError(
        formatFetchErrorMessage(url, message, config),
        classifyScrapeError(message),
        [{ url, category: classifyScrapeError(message), error: message }]
      );
    }

    // [Implements: US-PL-005] Timeout during scrape
    if (guard.isAborted && !scrapeResult.success) {
      throw new PipelineTimeoutError(
        `Timeout: scrape of ${url} exceeded ${config.pipelineTimeoutMs}ms pipeline timeout`,
        config.pipelineTimeoutMs,
        [{ url, category: 'timeout', error: 'pipeline timeout during scrape' }]
      );
    }

    // [Implements: US-PL-007] Scrape failure — return actionable error
    if (!scrapeResult.success) {
      throw new PipelineError(
        formatFetchErrorMessage(url, scrapeResult.error, config),
        classifyScrapeError(scrapeResult.error),
        [
          {
            url,
            category: classifyScrapeError(scrapeResult.error),
            error: scrapeResult.error,
          },
        ]
      );
    }

    // [Implements: US-PL-002] Empty or below minimum content — skip synthesis
    const content = scrapeResult.textContent ?? '';
    if (
      !content ||
      content.trim().length < MIN_MEANINGFUL_CONTENT_CHARS
    ) {
      // [Implements: US-PL-012]
      logPipelineOutcome('failed', Date.now() - startTime, {
        scrape: 0,
        synthesize: 0,
      });
      return {
        answer: `No meaningful content was extracted from ${url}. The page may be empty, require JavaScript rendering, or block automated access.`,
        keyPoints: [],
        sources: [{ url, title: scrapeResult.title || url }],
      };
    }

    // [Implements: US-PL-012]
    logStageComplete('scrape', 1, 1, scrapeResult.elapsedMs);

    const contentItem: ContentItem = {
      title: scrapeResult.title || url,
      url: scrapeResult.url,
      snippet: '',
      score: 1.0,
      content,
    };

    // =====================================================================
    // Stage 2: Synthesize (SY) — with graceful degradation
    // =====================================================================

    const synthesizeStartTime = Date.now();
    let result: DigestResult;
    try {
      // [Implements: US-PL-005] Timeout during synthesis — graceful fallback
      result = await resolvedDeps.synthesize(url, [contentItem], focus);
    } catch (error) {
      // [Implements: US-PL-009, NFR-PL-008] Return truncated content
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[PL] synthesize failed for ${url}: ${message} — returning raw content\n`
      );

      result = buildDegradedResult(
        [contentItem],
        `synthesize error: ${message}`,
        config.maxContentChars
      );
    }

    const synthesizeElapsed = Date.now() - synthesizeStartTime;
    // [Implements: US-PL-012]
    logStageComplete('synthesize', 1, result.sources.length, synthesizeElapsed);

    // [Implements: US-PL-012]
    logPipelineOutcome('success', Date.now() - startTime, {
      scrape: 1,
      synthesize: result.sources.length,
    });

    return result;
  } finally {
    // [Implements: US-PL-005, NFR-PL-005] Always clean up the timeout guard
    guard.cleanup();
  }
}

// ===========================================================================
// Timeout Degradation Helper
// ===========================================================================

/**
 * Handle pipeline timeout for web_search by returning the best partial result.
 *
 * If some content was scraped, return a degraded concatenation. Otherwise,
 * throw a PipelineTimeoutError.
 *
 * [Implements: US-PL-004]
 */
// [Implements: US-PL-004]
function handleTimeoutDegradation(
  scrapedItems: ContentItem[],
  pipelineType: string,
  config: PipelineConfig,
  startTime: number,
  stageCounts: Record<string, number>
): DigestResult {
  process.stderr.write(
    `[PL] timeout: ${pipelineType} pipeline exceeded ${config.pipelineTimeoutMs}ms\n`
  );

  // [Implements: US-PL-004] Return best partial result if content available
  if (scrapedItems.length > 0) {
    const result = buildDegradedResult(
      scrapedItems,
      `pipeline timeout after ${config.pipelineTimeoutMs}ms`,
      config.maxContentChars
    );

    logPipelineOutcome('degraded', Date.now() - startTime, stageCounts);
    return result;
  }

  // No content available — throw timeout error
  throw new PipelineTimeoutError(
    `Pipeline timed out after ${config.pipelineTimeoutMs}ms with no content retrieved`,
    config.pipelineTimeoutMs
  );
}

// ===========================================================================
// Default Dependency Resolution
// ===========================================================================

/**
 * Resolve default pipeline dependencies by importing from the four processing
 * modules. The scrape and deduplicate modules are already imported at the top
 * of this file. The search-retrieve and synthesize modules are loaded lazily.
 *
 * For modules that do not yet have a published entry function, placeholder
 * functions are used that throw informative errors when invoked.
 *
 * [Implements: DC-PL-003]
 */
// [Implements: DC-PL-003]
async function resolveDefaultDeps(): Promise<PipelineDeps> {
  // SC and DD are imported statically at the top of this file.
  const scrapeFn = scrape;
  const deduplicateFn = deduplicate;

  // SR — dynamic import with fallback
  let searchFn: SearchFunction;
  try {
    const srModulePath = '../search-retrieval/index.js';
    const srModule = await import(srModulePath);
    searchFn = srModule.search as SearchFunction;
  } catch {
    searchFn = async (_query: string, _maxResults?: number): Promise<SearchResultItem[]> => {
      throw new Error(
        'Search module (search-retrieval) is not available. Ensure the module is properly configured.'
      );
    };
  }

  // SY — dynamic import with fallback to degradation
  let synthesizeFn: SynthesizeFunction;
  try {
    const syModule = await import('../synthesize/index.js');
    synthesizeFn = syModule.synthesize as SynthesizeFunction;
  } catch {
    // Fallback: use the degradation handler as a synthesize implementation
    const { degradationFallback } = await import(
      '../synthesize/degradation-handler.js'
    );
    synthesizeFn = async (
      query: string,
      contents: ContentItem[],
      _focus?: string
    ): Promise<DigestResult> => {
      return degradationFallback(query, contents, 'synthesize module not available');
    };
  }

  return {
    search: searchFn,
    scrape: scrapeFn,
    deduplicate: deduplicateFn,
    synthesize: synthesizeFn,
  };
}

// ===========================================================================
// Public Entry Points (runWebSearch / runWebFetch)
// ===========================================================================

/**
 * Validated parameter object for the web_search pipeline.
 *
 * Maps from MCP snake_case input to PL camelCase fields.
 *
 * [Spec: US-PL-001, DC-PL-005]
 */
export interface WebSearchParams {
  /** Non-empty search query string. */
  query: string;
  /** Maximum number of search results to process (default: 5). */
  maxResults?: number;
  /** Optional focus directive for synthesis emphasis. */
  focus?: string;
}

/**
 * Validated parameter object for the web_fetch pipeline.
 *
 * [Spec: US-PL-002, DC-PL-005]
 */
export interface WebFetchParams {
  /** Target URL to fetch and synthesize. */
  url: string;
  /** Optional focus directive for synthesis emphasis. */
  focus?: string;
}

// ===========================================================================
// Digest Formatting Helper
// ===========================================================================

/**
 * Format a DigestResult into a human-readable string with sections for
 * Answer, Key Points, and Sources.
 *
 * [Implements: US-PL-001, US-PL-002, NFR-PL-006]
 */
// [Implements: US-PL-001, US-PL-002, NFR-PL-006]
function formatDigestResult(digest: DigestResult): string {
  const parts: string[] = [];

  // [Implements: US-PL-001] Answer section
  parts.push(digest.answer);

  // Key Points section (if any)
  if (digest.keyPoints.length > 0) {
    parts.push('');
    parts.push('Key Points:');
    for (const point of digest.keyPoints) {
      parts.push(`- ${point}`);
    }
  }

  // Sources section (if any)
  if (digest.sources.length > 0) {
    parts.push('');
    parts.push('Sources:');
    for (const source of digest.sources) {
      parts.push(`- ${source.title}: ${source.url}`);
    }
  }

  return parts.join('\n');
}

// ===========================================================================
// runWebSearch — Public web_search Entry Point
// ===========================================================================

/**
 * Public entry point for the web_search pipeline.
 *
 * Delegates to {@link executeWebSearch} for the full Search → Scrape →
 * Deduplicate → Synthesize flow, then formats the resulting DigestResult
 * into a string.
 *
 * This function is stateless across invocations — all state (configuration,
 * timeout guard, dependencies) is resolved per call within executeWebSearch.
 *
 * On hard failures (search down, all scrapes failed), throws PipelineError.
 * On timeout with no content, throws PipelineTimeoutError.
 * On partial or degraded results, resolves with a formatted string.
 *
 * @param params - Validated parameters: { query, maxResults?, focus? }.
 * @returns A formatted digest string with Answer, Key Points, and Sources.
 * @throws {PipelineError} On hard pipeline failures (search down, all scrapes failed).
 * @throws {PipelineTimeoutError} On unrecoverable timeout with no content retrieved.
 *
 * [Spec: US-PL-001, US-PL-004, US-PL-005, US-PL-006, US-PL-008,
 *        US-PL-010, US-PL-011, US-PL-012, US-PL-013, US-PL-014,
 *        US-PL-015,
 *        BG-PL-002,
 *        NFR-PL-005, NFR-PL-006,
 *        DC-PL-002, DC-PL-005]
 */
// [Implements: US-PL-001, US-PL-004, US-PL-005, US-PL-012, US-PL-013,
//  BG-PL-002, NFR-PL-005, NFR-PL-006, DC-PL-002, DC-PL-005]
export async function runWebSearch(params: WebSearchParams): Promise<string> {
  const startTime = Date.now();

  // [Implements: US-PL-001] Delegate to the full pipeline execution.
  // executeWebSearch internally resolves config via loadPipelineConfig(),
  // creates a TimeoutGuard, and handles all stage orchestration.
  const result = await executeWebSearch(
    params.query,
    params.maxResults ?? 5,
    params.focus
  );

  // [Implements: US-PL-012, NFR-PL-006] Emit final summary log
  const elapsed = Date.now() - startTime;
  process.stderr.write(
    `[PL] runWebSearch completed ms=${elapsed} sources=${result.sources.length}\n`
  );

  // [Implements: US-PL-001] Return formatted digest string
  return formatDigestResult(result);
}

// ===========================================================================
// runWebFetch — Public web_fetch Entry Point
// ===========================================================================

/**
 * Public entry point for the web_fetch pipeline.
 *
 * Delegates to {@link executeWebFetch} for the Scrape → Synthesize flow,
 * then formats the resulting DigestResult into a string.
 *
 * This function is stateless across invocations — all state is resolved
 * per call within executeWebFetch.
 *
 * On hard failures (scrape failure, empty content + synthesis failure),
 * throws PipelineError. On timeout during scrape, throws PipelineTimeoutError.
 * On partial or degraded results, resolves with a formatted string.
 *
 * @param params - Validated parameters: { url, focus? }.
 * @returns A formatted digest string with Answer, Key Points, and Sources.
 * @throws {PipelineError} On scrape failure or empty content + synthesis failure.
 * @throws {PipelineTimeoutError} On pipeline timeout during the scrape phase.
 *
 * [Spec: US-PL-002, US-PL-005, US-PL-007, US-PL-009, US-PL-012,
 *        US-PL-013, US-PL-015,
 *        BG-PL-002,
 *        NFR-PL-005, NFR-PL-006,
 *        DC-PL-002, DC-PL-005]
 */
// [Implements: US-PL-002, US-PL-005, US-PL-007, US-PL-009, US-PL-012,
//  US-PL-013, BG-PL-002, NFR-PL-005, NFR-PL-006, DC-PL-002, DC-PL-005]
export async function runWebFetch(params: WebFetchParams): Promise<string> {
  const startTime = Date.now();

  // [Implements: US-PL-002] Delegate to the web_fetch pipeline execution.
  // executeWebFetch internally resolves config via loadPipelineConfig(),
  // creates a TimeoutGuard, and handles scrape → synthesize orchestration.
  const result = await executeWebFetch(params.url, params.focus);

  // [Implements: US-PL-012, NFR-PL-006] Emit final summary log
  const elapsed = Date.now() - startTime;
  process.stderr.write(
    `[PL] runWebFetch completed ms=${elapsed} sources=${result.sources.length}\n`
  );

  // [Implements: US-PL-002] Return formatted digest string
  return formatDigestResult(result);
}
