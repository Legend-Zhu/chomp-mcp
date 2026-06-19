/**
 * Scraper — main scrape orchestrator with full pipeline.
 *
 * Ties together URL validation, HTTP fetching, encoding detection,
 * content-type routing, Readability extraction, Puppeteer fallback, and
 * truncation into a single coherent flow. Manages per-page and total
 * timeouts, resolves configuration from ScrapeOptions, enforces error
 * isolation (never throws for expected failures), and emits structured
 * stderr lifecycle logs (START/OK/FAIL/FALLBACK/ENCODING). Always returns
 * a ScrapeResult. Releases intermediate buffers for memory efficiency.
 *
 * [Spec: US-SC-001, US-SC-002, US-SC-004, US-SC-005, US-SC-006, US-SC-009,
 *        US-SC-011, US-SC-012, BG-SC-001, BG-SC-002, BG-SC-004, NFR-SC-001,
 *        NFR-SC-004, NFR-SC-005, NFR-SC-006]
 */

import type {
  ScrapeResult,
  ScrapeSuccessResult,
  ScrapeFailureResult,
  ExtractionMethod,
} from '../../shared/types/scrape.js';
import type { ScrapeOptions, ScrapeConfig } from './types.js';
import { validateUrl } from './url-validator.js';
import { fetchUrl } from './http-fetcher.js';
import { detectCharset, decodeToUtf8 } from './encoding-detector.js';
import { routeContent } from './content-type-router.js';
import { extractWithReadability } from './content-extractor.js';
import { renderPage } from './puppeteer-renderer.js';
import { truncate } from './truncator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-fetch timeout in ms (env SCRAPE_TIMEOUT_MS, fallback: 15000). */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Default max content length in characters (env MAX_CONTENT_CHARS, fallback: 8000). */
const DEFAULT_MAX_CONTENT_CHARS = 8_000;

/** Maximum HTTP redirect hops (constant: 5). */
const MAX_REDIRECTS = 5;

/** Minimum character count for Readability success (constant: 200). */
const MIN_CONTENT_CHARS = 200;

// ---------------------------------------------------------------------------
// Configuration resolver
// ---------------------------------------------------------------------------

// [Implements: US-SC-012, BG-SC-004, DC-SC-005]
/**
 * Resolve scrape configuration from environment variables with safe defaults,
 * applying any per-call overrides from ScrapeOptions.
 *
 * Reads `SCRAPE_TIMEOUT_MS` (default 15000) and `MAX_CONTENT_CHARS` (default
 * 8000) from the environment. Invalid or missing values fall back to
 * defaults. Caller-provided overrides in `options` take the highest priority.
 * `maxTotalTimeoutMs` is computed as `timeoutMs * 2`.
 *
 * [Constraint: DC-SC-005]
 */
function resolveConfig(options?: ScrapeOptions): ScrapeConfig {
  const envTimeout = parseInt(process.env['SCRAPE_TIMEOUT_MS'] ?? '', 10);
  const envMaxChars = parseInt(process.env['MAX_CONTENT_CHARS'] ?? '', 10);

  const baseTimeout =
    Number.isNaN(envTimeout) || envTimeout <= 0
      ? DEFAULT_TIMEOUT_MS
      : envTimeout;
  const baseMaxChars = Number.isNaN(envMaxChars)
    ? DEFAULT_MAX_CONTENT_CHARS
    : envMaxChars;

  const timeoutMs = options?.timeoutMs ?? baseTimeout;
  const maxContentChars = options?.maxContentChars ?? baseMaxChars;

  return {
    timeoutMs,
    maxContentChars,
    maxRedirects: MAX_REDIRECTS,
    minContentChars: MIN_CONTENT_CHARS,
    maxTotalTimeoutMs: timeoutMs * 2,
  };
}

// ---------------------------------------------------------------------------
// Logging helpers — all output to process.stderr only (NFR-SC-006)
// ---------------------------------------------------------------------------

// [Implements: US-SC-011, NFR-SC-006]
function logStart(url: string): void {
  process.stderr.write(`[scrape] START ${url}\n`);
}

function logSuccess(
  url: string,
  method: ExtractionMethod,
  chars: number,
  truncated: boolean,
  elapsedMs: number
): void {
  process.stderr.write(
    `[scrape] OK ${url} method=${method} chars=${chars} truncated=${truncated} ms=${elapsedMs}\n`
  );
}

function logFail(url: string, error: string, elapsedMs: number): void {
  process.stderr.write(`[scrape] FAIL ${url} error=${error} ms=${elapsedMs}\n`);
}

function logFallback(url: string): void {
  process.stderr.write(`[scrape] FALLBACK ${url} \u2192 puppeteer\n`);
}

// ---------------------------------------------------------------------------
// Result factory helpers
// ---------------------------------------------------------------------------

// [Implements: US-SC-012, NFR-SC-005]
function makeFailureResult(
  url: string,
  finalUrl: string | null,
  error: string,
  elapsedMs: number
): ScrapeFailureResult {
  return {
    success: false,
    url,
    finalUrl,
    title: null,
    textContent: null,
    extractionMethod: null,
    truncated: false,
    contentLength: 0,
    elapsedMs,
    error,
  };
}

// [Implements: US-SC-012, NFR-SC-005]
function makeSuccessResult(
  url: string,
  finalUrl: string,
  title: string,
  textContent: string,
  extractionMethod: ExtractionMethod,
  truncated: boolean,
  elapsedMs: number
): ScrapeSuccessResult {
  return {
    success: true,
    url,
    finalUrl,
    title,
    textContent,
    extractionMethod,
    truncated,
    contentLength: textContent.length,
    elapsedMs,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// HTTP error message formatting
// ---------------------------------------------------------------------------

// [Implements: US-SC-005]
/**
 * Format a human-readable error message for HTTP error status codes.
 *
 * Includes specific suggestions for common error codes:
 *   - 401/403: "Page requires authentication or blocks bots"
 *   - 404: "Page not found"
 *   - 429: "Too Many Requests"
 *   - Other: generic "{statusText}" message
 *
 * [Constraint: DC-SC-005]
 */
function formatHttpError(
  statusCode: number,
  statusText: string,
  url: string
): string {
  if (statusCode === 401 || statusCode === 403) {
    return `HTTP ${statusCode}: Page requires authentication or blocks bots (${url})`;
  }
  if (statusCode === 404) {
    return `HTTP 404: Page not found (${url})`;
  }
  if (statusCode === 429) {
    return `HTTP 429: Too Many Requests (${url})`;
  }
  return `HTTP ${statusCode}: ${statusText} (${url})`;
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

// [Implements: US-SC-001, US-SC-002, US-SC-004, US-SC-005, US-SC-006,
//               US-SC-009, US-SC-011, US-SC-012, BG-SC-001, BG-SC-002,
//               BG-SC-004, NFR-SC-001, NFR-SC-004, NFR-SC-005, NFR-SC-006]
/**
 * Scrape a URL and extract clean text content.
 *
 * Executes the full extraction pipeline:
 *   1. Validate URL (format, scheme, SSRF safety)
 *   2. HTTP GET via native fetch with redirect following, retries, timeout
 *   3. Detect charset and decode body to UTF-8
 *   4. Route by Content-Type (HTML/JSON/XML/text/binary)
 *   5. For HTML: Readability extraction → Puppeteer fallback on failure
 *   6. Truncate to MAX_CONTENT_CHARS
 *   7. Return ScrapeResult
 *
 * **Never rejects** the returned Promise for expected failures (HTTP errors,
 * timeouts, network failures, parse failures, binary content, SSRF violations).
 * All such conditions are converted into `ScrapeResult` objects with
 * `success: false` and a descriptive `error` string. Only truly unexpected
 * internal errors (bugs) propagate as thrown exceptions, which PL catches.
 *
 * All log output goes to `process.stderr` exclusively — never `stdout`
 * (NFR-SC-006). Lifecycle logs: START, OK, FAIL, FALLBACK, ENCODING.
 *
 * @param url     - The URL to scrape.
 * @param options - Optional per-call overrides for timeout and max content chars.
 * @returns       - A `ScrapeResult` (success or failure), always resolved.
 *
 * [Spec: US-SC-001, US-SC-002, US-SC-004, US-SC-005, US-SC-006, US-SC-009,
 *        US-SC-011, US-SC-012, BG-SC-001, BG-SC-002, BG-SC-004, NFR-SC-001,
 *        NFR-SC-004, NFR-SC-005, NFR-SC-006]
 */
export async function scrape(
  url: string,
  options?: ScrapeOptions
): Promise<ScrapeResult> {
  const startTime = Date.now();
  const config = resolveConfig(options);

  // [Implements: US-SC-011] Log scrape start
  logStart(url);

  try {
    // --- Step 8: Validate URL (format, scheme, SSRF) ---
    // [Implements: US-SC-013, NFR-SC-003]
    const validation = await validateUrl(url);
    if (!validation.valid) {
      const elapsed = Date.now() - startTime;
      const error = validation.error ?? 'URL validation failed';
      logFail(url, error, elapsed);
      return makeFailureResult(url, null, error, elapsed);
    }

    // --- Step 9: Fetch URL with timeout, redirects, retries ---
    // [Implements: US-SC-001, US-SC-003, US-SC-005, US-SC-006, US-SC-010]
    const fetchResult = await fetchUrl(url, config, options?.signal);

    if (!fetchResult.success) {
      const elapsed = Date.now() - startTime;
      let error: string;

      if (fetchResult.statusCode > 0) {
        // [Implements: US-SC-005] HTTP error — format based on status code
        const errorUrl = fetchResult.finalUrl ?? url;
        error = formatHttpError(
          fetchResult.statusCode,
          fetchResult.statusText,
          errorUrl
        );
      } else {
        // Network error or timeout — use the error message from fetcher
        error = fetchResult.error ?? 'Unknown fetch error';
      }

      logFail(url, error, elapsed);
      return makeFailureResult(url, fetchResult.finalUrl, error, elapsed);
    }

    // --- Step 10: Detect charset and decode body to UTF-8 ---
    // [Implements: US-SC-007, US-SC-011]
    const bodyBytes = fetchResult.bodyBytes;
    if (bodyBytes === null || bodyBytes.length === 0) {
      const elapsed = Date.now() - startTime;
      const error = `Failed to extract meaningful content from ${url}`;
      logFail(url, error, elapsed);
      return makeFailureResult(url, fetchResult.finalUrl, error, elapsed);
    }

    const charset = detectCharset(fetchResult.contentType, bodyBytes);
    // [Implements: US-SC-011] decodeToUtf8 emits the ENCODING log line
    // internally for non-UTF-8 charsets — no need to duplicate here.
    const bodyText = decodeToUtf8(bodyBytes, charset, url);

    // Release reference to raw bytes for memory efficiency
    // (NFR-SC-001) — bodyText is a decoded string, bodyBytes no longer needed

    // --- Step 11: Route content by Content-Type ---
    // [Implements: US-SC-009]
    const routed = routeContent(fetchResult.contentType, bodyText);

    // Binary / unsupported content type — return error
    // [Implements: US-SC-009]
    if (routed.kind === 'binary' || routed.kind === 'unsupported') {
      const elapsed = Date.now() - startTime;
      const error =
        routed.error ??
        `Unsupported content type: ${fetchResult.contentType ?? 'unknown'}`;
      logFail(url, error, elapsed);
      return makeFailureResult(url, fetchResult.finalUrl, error, elapsed);
    }

    // Non-HTML types (json, xml, text) — return success after truncation
    // [Implements: US-SC-009]
    if (routed.kind !== 'html') {
      const textContent = routed.textContent ?? '';
      if (textContent.length === 0) {
        const elapsed = Date.now() - startTime;
        const error = `Failed to extract meaningful content from ${url}`;
        logFail(url, error, elapsed);
        return makeFailureResult(url, fetchResult.finalUrl, error, elapsed);
      }

      const truncResult = truncate(textContent, config.maxContentChars);
      const elapsed = Date.now() - startTime;
      const method = routed.extractionMethod!;
      logSuccess(
        url,
        method,
        truncResult.text.length,
        truncResult.truncated,
        elapsed
      );
      return makeSuccessResult(
        url,
        fetchResult.finalUrl!,
        '',
        truncResult.text,
        method,
        truncResult.truncated,
        elapsed
      );
    }

    // --- Step 12: HTML — Readability extraction (primary path) ---
    // [Implements: US-SC-002, BG-SC-001, BG-SC-002]
    const extraction = extractWithReadability(
      bodyText,
      fetchResult.finalUrl!,
      config.minContentChars
    );

    // Readability succeeded (textContent length >= minContentChars)
    // [Implements: US-SC-002]
    if (extraction.extractionMethod === 'readability') {
      const truncResult = truncate(
        extraction.textContent,
        config.maxContentChars
      );
      const elapsed = Date.now() - startTime;
      logSuccess(
        url,
        'readability',
        truncResult.text.length,
        truncResult.truncated,
        elapsed
      );
      return makeSuccessResult(
        url,
        fetchResult.finalUrl!,
        extraction.title,
        truncResult.text,
        'readability',
        truncResult.truncated,
        elapsed
      );
    }

    // --- Steps 13-14: readability-failed → Puppeteer fallback ---
    // [Implements: US-SC-004, BG-SC-003]
    logFallback(url);

    // [Implements: US-SC-006] Check total timeout before Puppeteer
    const elapsedBeforeFallback = Date.now() - startTime;
    if (elapsedBeforeFallback >= config.maxTotalTimeoutMs) {
      process.stderr.write(
        `[scrape] timeout: ${url} after ${config.maxTotalTimeoutMs}ms\n`
      );
      const error = `scrape timeout: ${url} after ${config.maxTotalTimeoutMs}ms`;
      logFail(url, error, elapsedBeforeFallback);
      return makeFailureResult(
        url,
        fetchResult.finalUrl,
        error,
        elapsedBeforeFallback
      );
    }

    // [Implements: US-SC-004] Launch Puppeteer headless browser fallback
    // Apply separate per-phase timeout of SCRAPE_TIMEOUT_MS for Puppeteer
    const renderResult = await renderPage(
      fetchResult.finalUrl!,
      config.timeoutMs
    );

    // [Implements: US-SC-004] If Puppeteer rendered HTML, re-run Readability
    if (renderResult.success && renderResult.html !== null) {
      const puppetExtraction = extractWithReadability(
        renderResult.html,
        fetchResult.finalUrl!,
        config.minContentChars
      );

      // Puppeteer extraction succeeded (>= minContentChars)
      // [Implements: US-SC-004]
      if (puppetExtraction.charCount >= config.minContentChars) {
        const truncResult = truncate(
          puppetExtraction.textContent,
          config.maxContentChars
        );
        const elapsed = Date.now() - startTime;
        logSuccess(
          url,
          'puppeteer',
          truncResult.text.length,
          truncResult.truncated,
          elapsed
        );
        return makeSuccessResult(
          url,
          fetchResult.finalUrl!,
          puppetExtraction.title,
          truncResult.text,
          'puppeteer',
          truncResult.truncated,
          elapsed
        );
      }
    }

    // [Implements: US-SC-004] Puppeteer not installed, failed to launch, or
    // extraction still yielded insufficient content — fall through to error.
    // [Implements: NFR-SC-004] Puppeteer failure is logged by renderPage to stderr.

    // --- Step 15: All extraction paths yielded insufficient content ---
    const elapsed = Date.now() - startTime;
    const error = `Failed to extract meaningful content from ${url}`;
    logFail(url, error, elapsed);
    return makeFailureResult(url, fetchResult.finalUrl, error, elapsed);
  } catch (error) {
    // --- Step 17: Catch unexpected internal errors ---
    // [Implements: NFR-SC-005] Never reject for expected failures;
    // unexpected errors are converted to failure results.
    const elapsed = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    logFail(url, message, elapsed);
    return makeFailureResult(url, null, message, elapsed);
  }
}
