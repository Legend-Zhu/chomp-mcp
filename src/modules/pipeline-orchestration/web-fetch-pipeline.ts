/**
 * Web-Fetch Pipeline — Scrape → Synthesize flow for a single known URL.
 *
 * Implements the web_fetch sub-flow: scrape the target URL, extract clean
 * text content, and synthesize a structured digest. When synthesis fails,
 * the pipeline degrades gracefully by returning the truncated scraped
 * content with a notice prefix.
 *
 * Responsibilities:
 *   - Scrape the target URL via SC.scrape() with timeout and abort signal
 *   - Map scrape failures to actionable error messages (US-PL-007)
 *   - Skip synthesis and return an informative message when content is empty
 *     or below a minimum meaningful length
 *   - Call SY.synthesizeSingle() on the scraped content with optional focus
 *   - Degrade gracefully when synthesis fails (US-PL-009)
 *   - Throw PipelineError when both content extraction and synthesis fail
 *   - Emit structured stage logs to stderr (US-PL-012, NFR-PL-006)
 *
 * [Spec: US-PL-002, US-PL-005, US-PL-007, US-PL-009,
 *        NFR-PL-002, NFR-PL-004, NFR-PL-008, DC-PL-003]
 */

import { scrape } from '../scrape-extract/index.js';
import type { ScrapeOptions } from '../scrape-extract/index.js';
import type { ScrapeResult } from '../../shared/types/scrape.js';
import type { DigestResult } from '../../shared/types/digest.js';
import type { ContentItem } from '../../shared/types/content.js';
import type { ErrorCategory } from '../../shared/utils/errors.js';

import { PipelineError, PipelineTimeoutError } from './orchestrator.js';
import type { PipelineConfig } from './orchestrator.js';

// ===========================================================================
// Constants
// ===========================================================================

/** Minimum meaningful content length to proceed with synthesis (US-PL-002). */
const MIN_MEANINGFUL_CONTENT_CHARS = 50;

/** Notice prefix prepended to degraded content when LLM synthesis is unavailable. */
const DEGRADATION_NOTICE =
  '[Note: LLM synthesis was unavailable. The content below is raw text extracted from the page.]';

/** Truncation marker appended to truncated content. */
const TRUNCATION_MARKER = '…';

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

// [Implements: US-PL-006, US-PL-012]
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

  // [Implements: US-PL-007] HTTP 4xx/5xx — include status code and suggested action
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

  // [Implements: US-PL-007] Timeout — include URL, timeout value, and suggestion
  if (category === 'timeout') {
    return `The request to ${url} timed out after ${config.scrapeTimeoutMs}ms. Check connectivity or increase SCRAPE_TIMEOUT_MS.`;
  }

  // [Implements: US-PL-007] DNS/connection error — suggest verifying connectivity
  if (category === 'network') {
    return `The URL ${url} could not be reached. Verify network connectivity and that the URL is correct.`;
  }

  if (category === 'validation') {
    return `${scrapeError}`;
  }

  return `Failed to scrape ${url}: ${scrapeError}`;
}

// ===========================================================================
// Digest Formatting Helper
// ===========================================================================

// [Implements: US-PL-002, US-PL-009]
function formatDigest(digest: DigestResult): string {
  const parts: string[] = [];

  // [Implements: US-PL-002] Answer section
  parts.push(digest.answer);

  // [Implements: US-PL-002] Key Points section (if any)
  if (digest.keyPoints.length > 0) {
    parts.push('');
    parts.push('Key Points:');
    for (const point of digest.keyPoints) {
      parts.push(`- ${point}`);
    }
  }

  // [Implements: US-PL-002] Sources section (if any)
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
// Content Truncation Helper
// ===========================================================================

// [Implements: US-PL-009, NFR-PL-008]
function truncateContent(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }

  // Search backwards from maxChars for the last whitespace at or before the limit
  let cutIndex = maxChars;
  for (let i = maxChars; i >= 0; i--) {
    if (/\s/.test(text[i])) {
      cutIndex = i;
      break;
    }
  }

  return text.slice(0, cutIndex).trimEnd() + TRUNCATION_MARKER;
}

// ===========================================================================
// Degraded Content Builder
// ===========================================================================

// [Implements: US-PL-009, NFR-PL-008]
function buildDegradedString(
  url: string,
  title: string,
  content: string,
  maxContentChars: number
): string {
  const truncated = truncateContent(content, maxContentChars);
  return `${DEGRADATION_NOTICE}\n\n## ${title}\nSource: ${url}\n\n${truncated}`;
}

// ===========================================================================
// Synthesize Helper
// ===========================================================================

// [Implements: US-PL-002, US-PL-009, DC-PL-003]
async function synthesizeForFetch(
  url: string,
  title: string,
  content: string,
  focus: string | undefined
): Promise<DigestResult> {
  const contentItem: ContentItem = {
    title,
    url,
    snippet: '',
    score: 1.0,
    content,
  };

  // Try to use the synthesize module's synthesizeSingle function
  try {
    const syModule = await import('../synthesize/index.js');

    if (typeof syModule.synthesizeSingle === 'function') {
      return await syModule.synthesizeSingle(url, title, content, focus);
    }

    // Fall back to synthesize with a single content item
    if (typeof syModule.synthesize === 'function') {
      return await syModule.synthesize(url, [contentItem], focus);
    }
  } catch {
    // Module not available — fall through to degradation handler
  }

  // Fallback: use the degradation handler
  const { degradationFallback } = await import(
    '../synthesize/degradation-handler.js'
  );
  return degradationFallback(
    url,
    [contentItem],
    'synthesize module not available'
  );
}

// ===========================================================================
// Main Pipeline Function
// ===========================================================================

// [Implements: US-PL-002, US-PL-005, US-PL-007, US-PL-009, US-PL-012,
//  NFR-PL-002, NFR-PL-004, NFR-PL-008, DC-PL-003]
/**
 * Execute the web_fetch pipeline: Scrape → Synthesize for a single URL.
 *
 * Flow:
 *   1. Scrape the target URL via SC.scrape() with the provided signal and
 *      timeout configuration.
 *   2. If the scrape fails, throw a PipelineError with an actionable message
 *      (HTTP status code + suggestion, timeout value + suggestion, or DNS/
 *      connection suggestion) per US-PL-007.
 *   3. If the scrape succeeds but content is empty or below a minimum
 *      meaningful length (< 50 chars), skip synthesis and return an
 *      informative message indicating no meaningful content was extracted.
 *   4. Call SY.synthesizeSingle() on the scraped content with the provided
 *      focus directive.
 *   5. If synthesis succeeds, return the formatted digest string.
 *   6. If synthesis fails, return the truncated scraped content (respecting
 *      MAX_CONTENT_CHARS) with a prepended notice that LLM synthesis was
 *      unavailable.
 *   7. If both content extraction yielded no content and synthesis fails,
 *      throw a PipelineError indicating both extraction and synthesis failed.
 *   8. If the pipeline timeout fires during the scrape phase, throw a
 *      PipelineTimeoutError.
 *   9. If the pipeline timeout fires during the synthesis phase (content
 *      available), return the truncated content as a degradation fallback.
 *
 * @param url - Target URL to fetch and synthesize.
 * @param focus - Optional focus directive for synthesis emphasis.
 * @param config - Pipeline configuration (scrapeTimeoutMs, maxContentChars,
 *   pipelineTimeoutMs).
 * @param signal - Abort signal from the pipeline timeout guard for
 *   cooperative cancellation.
 * @returns A formatted digest string, or a degraded content string on
 *   synthesis failure, or an informative message on empty content.
 * @throws {PipelineError} On scrape failure, or when both content extraction
 *   and synthesis fail.
 * @throws {PipelineTimeoutError} On pipeline timeout during the scrape phase.
 *
 * [Spec: US-PL-002, US-PL-005, US-PL-007, US-PL-009,
 *        NFR-PL-002, NFR-PL-004, NFR-PL-008, DC-PL-003]
 */
// [Implements: US-PL-002, US-PL-005, US-PL-007, US-PL-009]
export async function executeWebFetchPipeline(
  url: string,
  focus: string | undefined,
  config: PipelineConfig,
  signal: AbortSignal
): Promise<string> {
  const startTime = Date.now();

  // [Implements: US-PL-012] Log pipeline start
  process.stderr.write(
    `[PL] web_fetch url="${url}" focus="${focus ?? ''}"\n`
  );

  // =====================================================================
  // Stage 1: Scrape (SC)
  // =====================================================================

  // [Implements: US-PL-002] Call SC.scrape() to retrieve page content
  let scrapeResult: ScrapeResult;

  try {
    const options: ScrapeOptions = {
      timeoutMs: config.scrapeTimeoutMs,
      maxContentChars: config.maxContentChars,
      signal,
    };

    // [Implements: US-PL-002, US-PL-015] Scrape with abort signal propagation
    scrapeResult = await scrape(url, options);
  } catch (error) {
    // [Implements: US-PL-005] Abort during scrape → throw PipelineTimeoutError
    if (signal.aborted) {
      throw new PipelineTimeoutError(
        `Timeout: scrape of ${url} exceeded ${config.pipelineTimeoutMs}ms pipeline timeout`,
        config.pipelineTimeoutMs,
        [
          {
            url,
            category: 'timeout',
            error: 'pipeline timeout during scrape',
          },
        ]
      );
    }

    // [Implements: US-PL-007, NFR-PL-004] Unexpected scrape exception
    const message = error instanceof Error ? error.message : String(error);
    const category = classifyScrapeError(message);
    logScrapeFailure(url, category, message);
    throw new PipelineError(
      formatFetchErrorMessage(url, message, config),
      category,
      [{ url, category, error: message }]
    );
  }

  // [Implements: US-PL-005] Timeout during scrape phase
  if (signal.aborted && !scrapeResult.success) {
    throw new PipelineTimeoutError(
      `Timeout: scrape of ${url} exceeded ${config.pipelineTimeoutMs}ms pipeline timeout`,
      config.pipelineTimeoutMs,
      [
        {
          url,
          category: 'timeout',
          error: 'pipeline timeout during scrape',
        },
      ]
    );
  }

  // [Implements: US-PL-007] Scrape failure — throw actionable error
  if (!scrapeResult.success) {
    const category = classifyScrapeError(scrapeResult.error);
    logScrapeFailure(url, category, scrapeResult.error);

    // [Implements: US-PL-012] Log failed outcome
    logPipelineOutcome('failed', Date.now() - startTime, {
      scrape: 0,
      synthesize: 0,
    });

    throw new PipelineError(
      formatFetchErrorMessage(url, scrapeResult.error, config),
      category,
      [{ url, category, error: scrapeResult.error }]
    );
  }

  // [Implements: US-PL-012] Log scrape stage completion
  logStageComplete('scrape', 1, 1, scrapeResult.elapsedMs);

  // Extract title and content from the successful scrape result
  const title = scrapeResult.title || url;
  const content = scrapeResult.textContent ?? '';

  // =====================================================================
  // Stage 1.5: Check for empty or insufficient content
  // =====================================================================

  // [Implements: US-PL-002] Skip synthesis when content is empty or below
  // a minimum meaningful length — return an informative message
  const isContentMeaningful =
    content.trim().length >= MIN_MEANINGFUL_CONTENT_CHARS;

  if (!isContentMeaningful) {
    // [Implements: US-PL-012] Log failed outcome
    logPipelineOutcome('failed', Date.now() - startTime, {
      scrape: 1,
      synthesize: 0,
    });

    return `No meaningful content was extracted from ${url}. The page may be empty, require JavaScript rendering, or block automated access.`;
  }

  // =====================================================================
  // Stage 2: Synthesize (SY)
  // =====================================================================

  // [Implements: US-PL-002, US-PL-009] Call SY.synthesizeSingle()
  const synthesizeStartTime = Date.now();
  let result: DigestResult;

  try {
    // [Implements: US-PL-002] Synthesize the scraped content with focus
    result = await synthesizeForFetch(url, title, content, focus);

    // [Implements: US-PL-002] Verify the result is non-empty
    if (!result.answer || result.answer.trim().length === 0) {
      throw new Error('Synthesis returned an empty answer');
    }
  } catch (error) {
    // [Implements: US-PL-005] Timeout during synthesis — content available,
    // return truncated content as degradation fallback
    if (signal.aborted) {
      process.stderr.write(
        `[PL] timeout during synthesis for ${url} — returning raw content\n`
      );

      logPipelineOutcome('degraded', Date.now() - startTime, {
        scrape: 1,
        synthesize: 0,
      });

      return buildDegradedString(url, title, content, config.maxContentChars);
    }

    // [Implements: US-PL-009, NFR-PL-008] Synthesis failed — return truncated
    // content with a prepended notice
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[PL] synthesize failed for ${url}: ${message} — returning raw content\n`
    );

    logPipelineOutcome('degraded', Date.now() - startTime, {
      scrape: 1,
      synthesize: 0,
    });

    return buildDegradedString(url, title, content, config.maxContentChars);
  }

  const synthesizeElapsed = Date.now() - synthesizeStartTime;

  // [Implements: US-PL-012] Log synthesis stage completion
  logStageComplete('synthesize', 1, result.sources.length, synthesizeElapsed);

  // [Implements: US-PL-012] Log final outcome
  logPipelineOutcome('success', Date.now() - startTime, {
    scrape: 1,
    synthesize: result.sources.length,
  });

  // [Implements: US-PL-002, US-PL-009] Return the formatted digest string
  return formatDigest(result);
}
