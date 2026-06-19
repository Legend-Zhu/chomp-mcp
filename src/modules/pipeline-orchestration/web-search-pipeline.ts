/**
 * web-search-pipeline.ts — Search → Scrape → Deduplicate → Synthesize flow.
 *
 * This module implements the full web_search pipeline, coordinating the four
 * processing modules (SR, SC, DD, SY) in strict sequential stage ordering.
 * Within the scrape stage, individual URLs are scraped concurrently up to
 * MAX_CONCURRENCY via ConcurrencyLimiter.
 *
 * Stage ordering is strictly sequential (DC-PL-004):
 *   1. Search (SR) — retrieve {title, url, snippet, score} items
 *   2. Scrape (SC) — concurrently fetch each URL, attach content
 *   3. Deduplicate (DD) — filter near-duplicates, pass filtered set forward
 *   4. Synthesize (SY) — produce structured digest (with graceful degradation)
 *
 * Error handling:
 *   - Search failure → throws PipelineError (US-PL-010)
 *   - Individual URL scrape failure → isolated, logged, excluded (US-PL-006)
 *   - All URLs fail → throws PipelineError listing failures (US-PL-011)
 *   - Deduplication removes all results → returns message (US-PL-011)
 *   - Synthesis failure → graceful degradation fallback (US-PL-008)
 *   - Overall timeout → returns best partial result or throws (US-PL-004)
 *
 * [Spec: US-PL-001, US-PL-006, US-PL-008, US-PL-010, US-PL-011,
 *        US-PL-014, US-PL-015,
 *        BG-PL-001,
 *        NFR-PL-001, NFR-PL-004, NFR-PL-006, NFR-PL-007, NFR-PL-008,
 *        DC-PL-003, DC-PL-004]
 */

import type { ErrorCategory } from '../../shared/utils/errors.js';
import type { ContentItem } from '../../shared/types/content.js';
import type { DeduplicatedItem } from '../../shared/types/deduplicate.js';
import type { DigestResult, SourceRef } from '../../shared/types/digest.js';
import type { ScrapeResult } from '../../shared/types/scrape.js';
import type { ScrapeOptions } from '../scrape-extract/types.js';

import {
  PipelineError,
  PipelineTimeoutError,
  loadPipelineConfig,
} from './orchestrator.js';
import type {
  PipelineDeps,
  PipelineConfig,
  SearchResultItem,
  FailedUrl,
} from './orchestrator.js';
import { TimeoutGuard } from './timeout-guard.js';
import { ConcurrencyLimiter } from './concurrency-limiter.js';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Outcome of an individual URL scrape attempt.
 *
 * @internal
 */
type ScrapeOutcome =
  | { ok: true; content: string; title: string }
  | { ok: false; failure: FailedUrl };

/**
 * Result of the scrape stage: successfully scraped content items and
 * a list of URLs that failed.
 *
 * @internal
 */
interface ScrapeStageResult {
  items: ContentItem[];
  failures: FailedUrl[];
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

function logScrapeFailure(url: string, category: string, error: string): void {
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
// Error Classification Helper
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
  if (
    lower.includes('dns') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('network') ||
    lower.includes('unreachable') ||
    lower.includes('connection')
  ) {
    return 'network';
  }
  if (lower.startsWith('http ') || /\bhttp \d{3}\b/.test(lower)) {
    return 'http_error';
  }
  if (lower.includes('parse') || lower.includes('extract')) {
    return 'parse_error';
  }
  if (
    lower.includes('validation') ||
    lower.includes('invalid url') ||
    lower.includes('url is required') ||
    lower.includes('ssrf') ||
    lower.includes('loopback') ||
    lower.includes('private')
  ) {
    return 'validation';
  }
  return 'unknown';
}

// ===========================================================================
// Graceful Degradation Helper
// ===========================================================================

/** Notice prepended to degraded results when LLM synthesis is unavailable. */
const DEGRADATION_NOTICE =
  '[Note: LLM synthesis was unavailable. The content below is raw concatenated excerpts from scraped pages.]';

/**
 * Build a fallback DigestResult from scraped content when synthesis fails.
 *
 * Concatenates titles, URLs, and truncated content of all items, prepended
 * with a notice that LLM synthesis was unavailable. Includes the Sources
 * section with all contributing URLs so the caller can trace origins.
 *
 * [Implements: US-PL-008, NFR-PL-008]
 */
// [Implements: US-PL-008, NFR-PL-008]
function buildDegradedResult(
  contents: ContentItem[],
  reason: string,
  maxContentChars: number
): DigestResult {
  process.stderr.write(`[PL] degradation activated: ${reason}\n`);

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

    // [Implements: NFR-PL-007] Respect MAX_CONTENT_CHARS per page
    const entry = `[${item.title}](${item.url})\n${item.content}`;
    const trimmed =
      entry.length <= remaining
        ? entry
        : entry.slice(0, remaining).trimEnd() + '\u2026';

    parts.push(trimmed);
    totalLength += separator.length + trimmed.length;
  }

  const answer = `${DEGRADATION_NOTICE}\n\n${parts.join('\n\n')}`;

  // [Implements: US-PL-008] Include Sources section with all contributing URLs
  const sources: SourceRef[] = contents.map((item) => ({
    url: item.url,
    title: item.title,
  }));

  // Build key points from first sentences of top items
  const keyPoints: string[] = [];
  for (const item of sorted.slice(0, 10)) {
    const match = item.content.trim().match(/^([^.]*\.(?=\s|$))/);
    const sentence = match
      ? match[1].trim()
      : item.content.trim().slice(0, 200);
    if (sentence.length > 0) {
      keyPoints.push(sentence);
    }
  }

  return { answer, keyPoints, sources };
}

// ===========================================================================
// Timeout Degradation Helper
// ===========================================================================

/**
 * Handle pipeline timeout by returning the best partial result.
 *
 * If some content was scraped, return a degraded concatenation. Otherwise,
 * throw a PipelineTimeoutError.
 *
 * [Implements: US-PL-004]
 */
// [Implements: US-PL-004]
function handleTimeoutDegradation(
  scrapedItems: ContentItem[],
  config: PipelineConfig,
  startTime: number,
  stageCounts: Record<string, number>
): DigestResult {
  process.stderr.write(
    `[PL] timeout: web_search pipeline exceeded ${config.pipelineTimeoutMs}ms\n`
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
// Stage 1: Search
// ===========================================================================

/**
 * Execute the search stage: call SR.search and validate results.
 *
 * Throws PipelineError on search failure, zero results, or all-invalid URLs.
 *
 * [Implements: US-PL-010, DC-PL-004]
 */
// [Implements: US-PL-010, DC-PL-004]
async function executeSearchStage(
  query: string,
  maxResults: number,
  deps: PipelineDeps
): Promise<SearchResultItem[]> {
  const searchStartTime = Date.now();
  let searchResults: SearchResultItem[];

  try {
    // [Implements: US-PL-001, DC-PL-004] Sequential: search first
    searchResults = await deps.search(query, maxResults);
  } catch (error) {
    // [Implements: US-PL-010] Search stage failure — abort pipeline
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

  // [Implements: US-PL-010] Filter out results with invalid or empty URLs
  const validResults = searchResults.filter(
    (r) => r.url && r.url.trim().length > 0
  );
  if (validResults.length === 0) {
    // [Implements: US-PL-010] All results had invalid/empty URLs
    throw new PipelineError(
      'No usable search results found (all results had invalid or empty URLs).',
      'validation'
    );
  }

  const searchElapsed = Date.now() - searchStartTime;
  // [Implements: US-PL-012]
  logStageComplete(
    'search',
    searchResults.length,
    validResults.length,
    searchElapsed
  );

  return validResults;
}

// ===========================================================================
// Stage 2: Scrape (concurrent with ConcurrencyLimiter)
// ===========================================================================

/**
 * Scrape a single URL within the pipeline, catching all errors and converting
 * them to a FailedUrl entry. Never throws.
 *
 * [Implements: US-PL-006, NFR-PL-004]
 */
// [Implements: US-PL-006, NFR-PL-004]
async function scrapeWithIsolation(
  url: string,
  deps: PipelineDeps,
  config: PipelineConfig,
  signal: AbortSignal
): Promise<ScrapeOutcome> {
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
    // [Implements: US-PL-006, NFR-PL-004] Catch uncaught exceptions (not just
    // standard HTTP/timeout/network errors) — treat the URL as failed
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
 * Scrape all candidate URLs concurrently using ConcurrencyLimiter.
 *
 * Each URL is scraped within a concurrency slot acquired from the limiter.
 * Individual failures are caught, logged, and excluded from the results.
 * When the abort signal fires, remaining queued items are cancelled.
 *
 * Returns successful ContentItem[] and FailedUrl[] separately.
 *
 * [Implements: US-PL-003, US-PL-006, US-PL-014, US-PL-015, NFR-PL-003, NFR-PL-004]
 */
// [Implements: US-PL-003, US-PL-006, US-PL-014, US-PL-015]
async function executeScrapeStage(
  searchResults: SearchResultItem[],
  deps: PipelineDeps,
  config: PipelineConfig,
  signal: AbortSignal
): Promise<ScrapeStageResult> {
  // [Implements: US-PL-003, NFR-PL-003] Use ConcurrencyLimiter for bounded concurrency
  const limiter = new ConcurrencyLimiter(config.maxConcurrency);
  const items: ContentItem[] = [];
  const failures: FailedUrl[] = [];

  // [Implements: US-PL-003] Dispatch all URLs concurrently
  const scrapePromises = searchResults.map(async (result) => {
    try {
      // [Implements: US-PL-015] Acquire concurrency slot with abort signal
      await limiter.acquire(signal);
    } catch {
      // [Implements: US-PL-015] AbortError — signal fired while queued
      return;
    }

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
        // [Implements: US-PL-014] Attach content to the result object as
        // {title, url, snippet, score, content}
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
      // [Implements: US-PL-015, NFR-PL-003] Release concurrency slot
      limiter.release();
    }
  });

  await Promise.allSettled(scrapePromises);

  return { items, failures };
}

// ===========================================================================
// Stage 3: Deduplicate
// ===========================================================================

/**
 * Execute the deduplicate stage: call DD.deduplicate on scraped content.
 *
 * If deduplicate throws (should not happen per contract), falls back to
 * using scraped items as-is. If all items are filtered out, falls back
 * to pre-dedup items so the pipeline can still proceed.
 *
 * [Implements: US-PL-011, US-PL-014, DC-PL-004]
 */
// [Implements: US-PL-014, DC-PL-004]
function executeDeduplicateStage(
  scrapedItems: ContentItem[],
  deps: PipelineDeps
): DeduplicatedItem[] {
  let dedupedItems: DeduplicatedItem[];

  try {
    dedupedItems = deps.deduplicate(scrapedItems);
  } catch (error) {
    // [Implements: NFR-PL-004] Catch DD errors — use scraped items as-is
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[PL] deduplicate error: ${message}\n`);
    dedupedItems = scrapedItems.map((item) => ({
      ...item,
      normalizedUrl: item.url,
      mergedSources: [],
      fingerprintCount: 0,
    }));
  }

  // [Implements: US-PL-011] All results filtered out by deduplication —
  // continue with partial data (original scraped items)
  if (dedupedItems.length === 0 && scrapedItems.length > 0) {
    process.stderr.write(
      `[PL] deduplication removed all ${scrapedItems.length} result(s) — ` +
        `falling back to pre-dedup items\n`
    );
    dedupedItems = scrapedItems.map((item) => ({
      ...item,
      normalizedUrl: item.url,
      mergedSources: [],
      fingerprintCount: 0,
    }));
  }

  return dedupedItems;
}

// ===========================================================================
// Stage 4: Synthesize (with graceful degradation)
// ===========================================================================

/**
 * Execute the synthesize stage with graceful degradation.
 *
 * On synthesis failure, constructs a fallback DigestResult by concatenating
 * titles, URLs, and truncated content of all items.
 *
 * [Implements: US-PL-008, NFR-PL-008]
 */
// [Implements: US-PL-008, NFR-PL-008]
async function executeSynthesizeStage(
  query: string,
  dedupedItems: DeduplicatedItem[],
  focus: string | undefined,
  deps: PipelineDeps,
  config: PipelineConfig
): Promise<DigestResult> {
  // [Implements: US-PL-014] Pass filtered array with content to synthesize
  const contentItems: ContentItem[] = dedupedItems.map((d) => ({
    title: d.title,
    url: d.url,
    snippet: d.snippet,
    score: d.score,
    content: d.content,
  }));

  try {
    const result = await deps.synthesize(query, contentItems, focus);

    // [Implements: US-PL-008] Check for empty/unmeaningful result
    if (!result.answer || result.answer.trim().length === 0) {
      throw new Error('Synthesis returned empty answer');
    }

    return result;
  } catch (error) {
    // [Implements: US-PL-008, NFR-PL-008] Graceful degradation
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[PL] synthesize failed: ${message} — degrading\n`
    );

    return buildDegradedResult(
      contentItems,
      `synthesize error: ${message}`,
      config.maxContentChars
    );
  }
}

// ===========================================================================
// Main Pipeline Entry Point
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
 *   - Deduplication removes all results → falls back to pre-dedup items (US-PL-011)
 *   - Synthesis failure → graceful degradation fallback (US-PL-008)
 *   - Overall timeout → returns best partial result or throws (US-PL-004)
 *
 * @param query - Non-empty search query string.
 * @param maxResults - Maximum number of search results.
 * @param focus - Optional focus directive for synthesis.
 * @param deps - Injected dependencies for the four processing modules.
 * @param config - Pipeline configuration (maxConcurrency, timeouts, etc.).
 * @returns A DigestResult with synthesized answer, key points, and sources.
 * @throws {PipelineError} on hard failures (search down, all scrapes failed).
 * @throws {PipelineTimeoutError} on unrecoverable timeout with no content.
 *
 * [Spec: US-PL-001, US-PL-003, US-PL-004, US-PL-006, US-PL-008,
 *        US-PL-010, US-PL-011, US-PL-014, US-PL-015,
 *        BG-PL-001,
 *        NFR-PL-001, NFR-PL-004, NFR-PL-006, NFR-PL-007, NFR-PL-008,
 *        DC-PL-003, DC-PL-004]
 */
// [Implements: US-PL-001, US-PL-006, US-PL-008, US-PL-010, US-PL-011,
//  US-PL-014, US-PL-015, BG-PL-001, DC-PL-003, DC-PL-004]
export async function executeWebSearchPipeline(
  query: string,
  maxResults: number,
  focus: string | undefined,
  deps: PipelineDeps,
  config: PipelineConfig
): Promise<DigestResult> {
  const startTime = Date.now();

  // [Implements: US-PL-004, US-PL-015] Start overall timeout guard
  const guard = new TimeoutGuard(config.pipelineTimeoutMs);

  // [Implements: US-PL-012, NFR-PL-006] Log pipeline start
  process.stderr.write(
    `[PL] web_search query="${query}" max_results=${maxResults} focus="${focus ?? ''}"\n`
  );

  const stageCounts: Record<string, number> = {};
  let scrapeFailures: FailedUrl[] = [];

  try {
    // =====================================================================
    // Stage 1: Search (SR)
    // =====================================================================

    // [Implements: US-PL-010, DC-PL-004]
    const validResults = await executeSearchStage(query, maxResults, deps);
    stageCounts['search'] = validResults.length;

    // [Implements: US-PL-004] Check timeout after search
    if (guard.isAborted) {
      return handleTimeoutDegradation([], config, startTime, stageCounts);
    }

    // =====================================================================
    // Stage 2: Scrape (SC) — concurrent with ConcurrencyLimiter
    // =====================================================================

    // [Implements: US-PL-003, US-PL-006, US-PL-014]
    const scrapeStartTime = Date.now();
    const { items: scrapedItems, failures } = await executeScrapeStage(
      validResults,
      deps,
      config,
      guard.signal
    );
    scrapeFailures = failures;

    const scrapeElapsed = Date.now() - scrapeStartTime;
    stageCounts['scraped'] = scrapedItems.length;
    // [Implements: US-PL-012]
    logStageComplete(
      'scrape',
      validResults.length,
      scrapedItems.length,
      scrapeElapsed
    );

    // [Implements: US-PL-011] All candidate URLs failed — skip DD/SY
    if (scrapedItems.length === 0 && scrapeFailures.length > 0) {
      const failedUrlList = scrapeFailures
        .map((f) => `  - ${f.url}: ${f.error}`)
        .join('\n');
      // [Implements: US-PL-012]
      logPipelineOutcome('failed', Date.now() - startTime, stageCounts);
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
        config,
        startTime,
        stageCounts
      );
    }

    // [Implements: NFR-PL-007] Release references to raw ScrapeResult objects
    // after ContentItem construction — scrapedItems is the only data needed.

    // =====================================================================
    // Stage 3: Deduplicate (DD)
    // =====================================================================

    // [Implements: US-PL-014, DC-PL-004]
    const dedupStartTime = Date.now();
    const dedupedItems = executeDeduplicateStage(scrapedItems, deps);

    const dedupElapsed = Date.now() - dedupStartTime;
    stageCounts['deduplicated'] = dedupedItems.length;
    // [Implements: US-PL-012]
    logStageComplete(
      'deduplicate',
      scrapedItems.length,
      dedupedItems.length,
      dedupElapsed
    );

    // [Implements: US-PL-011] Check abort signal before synthesize
    if (guard.isAborted) {
      // [Implements: US-PL-011] If aborted and content is available,
      // construct degraded fallback from available content
      const contentItems: ContentItem[] = dedupedItems.map((d) => ({
        title: d.title,
        url: d.url,
        snippet: d.snippet,
        score: d.score,
        content: d.content,
      }));
      return handleTimeoutDegradation(
        contentItems,
        config,
        startTime,
        stageCounts
      );
    }

    // =====================================================================
    // Stage 4: Synthesize (SY) — with graceful degradation
    // =====================================================================

    // [Implements: US-PL-001, US-PL-008, DC-PL-004]
    // At least one result survives → proceed to synthesize
    const synthesizeStartTime = Date.now();
    const result = await executeSynthesizeStage(
      query,
      dedupedItems,
      focus,
      deps,
      config
    );

    const synthesizeElapsed = Date.now() - synthesizeStartTime;
    stageCounts['synthesized'] = result.sources.length;
    // [Implements: US-PL-012]
    logStageComplete(
      'synthesize',
      dedupedItems.length,
      result.sources.length,
      synthesizeElapsed
    );

    // [Implements: US-PL-012, NFR-PL-006] Emit final log line with outcome,
    // total elapsed time, and per-stage item counts
    const totalElapsed = Date.now() - startTime;
    const outcome = scrapeFailures.length > 0 ? 'partial' : 'success';
    logPipelineOutcome(outcome, totalElapsed, stageCounts);

    return result;
  } finally {
    // [Implements: US-PL-004, US-PL-005, US-PL-015, NFR-PL-005] Always
    // clean up the timeout guard — releases the timer and allows
    // in-flight operations to complete their cleanup. ConcurrencyLimiter
    // slots are released in their individual finally blocks within
    // executeScrapeStage.
    guard.cleanup();
  }
}

/**
 * Convenience wrapper that resolves configuration and dependencies from
 * environment variables and module imports, then delegates to
 * executeWebSearchPipeline.
 *
 * This is the primary public entry point for the web_search pipeline.
 * It resolves the pipeline configuration via loadPipelineConfig() and
 * resolves default dependencies via dynamic imports of the four
 * processing modules.
 *
 * @param query - Non-empty search query string.
 * @param maxResults - Maximum number of search results (default 5).
 * @param focus - Optional focus directive for synthesis.
 * @param deps - Optional injected dependencies for testing.
 * @returns A DigestResult with synthesized answer, key points, and sources.
 *
 * [Spec: US-PL-001, US-PL-013, DC-PL-003]
 */
// [Implements: US-PL-001, US-PL-013, DC-PL-003]
export async function runWebSearchPipeline(
  query: string,
  maxResults: number = 5,
  focus?: string,
  deps?: PipelineDeps
): Promise<DigestResult> {
  const config = loadPipelineConfig();
  const resolvedDeps = deps ?? (await resolveDefaultDeps());
  return executeWebSearchPipeline(query, maxResults, focus, resolvedDeps, config);
}

// ===========================================================================
// Default Dependency Resolution
// ===========================================================================

/**
 * Resolve default pipeline dependencies by importing from the four processing
 * modules. SC and DD are imported statically; SR and SY are loaded lazily.
 *
 * [Implements: DC-PL-003]
 */
// [Implements: DC-PL-003]
async function resolveDefaultDeps(): Promise<PipelineDeps> {
  // SC — static import
  const { scrape } = await import('../scrape-extract/index.js');
  const scrapeFn = scrape;

  // DD — static import
  const { deduplicate } = await import('../deduplicate/index.js');
  const deduplicateFn = deduplicate;

  // SR — dynamic import with fallback
  let searchFn: (query: string, maxResults?: number) => Promise<SearchResultItem[]>;
  try {
    // Module may not exist yet — use computed path to defer resolution to runtime
    const srModulePath = '../search-retrieve/index.js';
    const srModule = await import(srModulePath);
    searchFn = srModule.search as typeof searchFn;
  } catch {
    searchFn = async (
      _query: string,
      _maxResults?: number
    ): Promise<SearchResultItem[]> => {
      throw new Error(
        'Search module (search-retrieve) is not available. Ensure the module is properly configured.'
      );
    };
  }

  // SY — dynamic import with fallback to degradation
  let synthesizeFn: (
    query: string,
    contents: ContentItem[],
    focus?: string
  ) => Promise<DigestResult>;
  try {
    // Module may not exist yet — use computed path to defer resolution to runtime
    const syModulePath = '../synthesize/index.js';
    const syModule = await import(syModulePath);
    synthesizeFn = syModule.synthesize as typeof synthesizeFn;
  } catch {
    const { degradationFallback } = await import(
      '../synthesize/degradation-handler.js'
    );
    synthesizeFn = async (
      query: string,
      contents: ContentItem[],
      _focus?: string
    ): Promise<DigestResult> => {
      return degradationFallback(
        query,
        contents,
        'synthesize module not available'
      );
    };
  }

  return {
    search: searchFn,
    scrape: scrapeFn,
    deduplicate: deduplicateFn,
    synthesize: synthesizeFn,
  };
}
