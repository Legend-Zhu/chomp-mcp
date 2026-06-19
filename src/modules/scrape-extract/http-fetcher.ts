/**
 * HTTP fetcher — primary HTTP client for the scrape-extract (SC) module.
 *
 * Uses Node.js native `fetch` to retrieve URL content with:
 *   - Manual HTTP redirect following (max 5 hops)
 *   - Transient error retries with exponential backoff (1s, 3s)
 *   - HTTP 429 Retry-After handling (retry once)
 *   - HTTP 5xx single retry
 *   - HTTP 4xx immediate failure (no retry)
 *   - Per-request timeout via AbortController
 *   - Transparent decompression of gzip/br/deflate
 *
 * Returns a `FetchResult` with status code, final URL, body bytes, and error info.
 *
 * [Spec: US-SC-001, US-SC-003, US-SC-005, US-SC-006, US-SC-010, DC-SC-003]
 */

import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import type { FetchResult, ScrapeConfig } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Transient network error codes that warrant retries. */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
]);

/** Exponential backoff delays (ms) for transient error retries: 1s, then 3s. */
const BACKOFF_DELAYS: readonly number[] = [1000, 3000];

/** Default Retry-After delay (ms) when the header is missing on HTTP 429. */
const DEFAULT_RETRY_AFTER_MS = 3000;

/** HTTP status codes that indicate a redirect to follow. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 307, 308]);

/** Maximum retries for HTTP 5xx server errors. */
const MAX_SERVER_ERROR_RETRIES = 1;

/** Maximum retries for HTTP 429 rate limiting. */
const MAX_RATE_LIMIT_RETRIES = 1;

/** Delay (ms) before retrying after a 5xx error. */
const SERVER_ERROR_RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Error inspection helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a network error code is transient (retryable).
 *
 * Transient codes: ECONNRESET, ETIMEDOUT, ECONNREFUSED, EAI_AGAIN.
 * Non-transient codes (e.g., ENOTFOUND) do NOT trigger retries.
 *
 * [Implements: US-SC-010]
 * [Constraint: DC-SC-003]
 */
// [Implements: US-SC-010]
function isTransientError(code: string): boolean {
  return TRANSIENT_ERROR_CODES.has(code);
}

/**
 * Extract the error code from a thrown error, checking both the error's own
 * `code` property and its `cause.code` (undici wraps network errors inside a
 * `TypeError` whose `cause` carries the real Node.js errno code).
 */
function getErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object') {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== null && typeof cause === 'object') {
      const causeCode = (cause as { code?: unknown }).code;
      if (typeof causeCode === 'string') return causeCode;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Extract a human-readable message from a thrown error, preferring the
 * `cause.message` (undici wraps the real network error in a generic TypeError).
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) {
      return cause.message;
    }
    return error.message;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Header parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse the `Retry-After` HTTP header into milliseconds.
 *
 * Supports both delta-seconds (e.g. `"120"`) and HTTP-date
 * (e.g. `"Wed, 21 Oct 2025 07:28:00 GMT"`) formats per RFC 7231 §7.1.3.
 * Falls back to `DEFAULT_RETRY_AFTER_MS` (3 000 ms) when the header is
 * missing or unparseable.
 *
 * [Implements: US-SC-005]
 * [Constraint: DC-SC-003]
 */
// [Implements: US-SC-005]
function parseRetryAfter(headerValue: string | null): number {
  if (!headerValue) {
    return DEFAULT_RETRY_AFTER_MS;
  }

  const trimmed = headerValue.trim();

  // Try parsing as delta-seconds (non-negative integer)
  const seconds = parseInt(trimmed, 10);
  if (!Number.isNaN(seconds) && seconds >= 0 && /^\d+$/.test(trimmed)) {
    return seconds * 1000;
  }

  // Try parsing as HTTP-date
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.max(0, diff);
  }

  // Fallback
  return DEFAULT_RETRY_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Decompression helper
// ---------------------------------------------------------------------------

/**
 * Transparently decompress the response body if a `Content-Encoding` header
 * is present.
 *
 * Handles `gzip`, `deflate`, and `br` (brotli) encodings using Node.js
 * `node:zlib`. If decompression fails (e.g., the body was already
 * decompressed by native fetch/undici), the original bytes are returned
 * unchanged so that processing can continue.
 *
 * [Implements: US-SC-001]
 * [Constraint: DC-SC-003]
 */
// [Implements: US-SC-001]
function decompressIfNeeded(
  bodyBytes: Uint8Array,
  contentEncoding: string | null
): Uint8Array {
  if (!contentEncoding || bodyBytes.length === 0) {
    return bodyBytes;
  }

  const encoding = contentEncoding.toLowerCase().trim();

  try {
    if (encoding.includes('gzip')) {
      return gunzipSync(bodyBytes);
    }
    if (encoding.includes('deflate')) {
      return inflateSync(bodyBytes);
    }
    if (encoding.includes('br')) {
      return brotliDecompressSync(bodyBytes);
    }
  } catch {
    // Body was likely already decompressed by native fetch — return as-is.
    return bodyBytes;
  }

  return bodyBytes;
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/**
 * Promise-based sleep that resolves early if the abort signal fires.
 *
 * Always resolves (never rejects) — the caller should check `signal.aborted`
 * before the next operation to detect premature wake-up.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create a combined `AbortSignal` that fires on either the local timeout
 * (set to `timeoutMs`) or the externally provided abort signal (from PL's
 * timeout guard via `ScrapeOptions.signal`).
 *
 * Returns a `cleanup` function that clears the timeout timer and removes the
 * external-signal listener — must be called in a `finally` block.
 *
 * [Implements: US-SC-006]
 * [Constraint: DC-SC-003]
 */
// [Implements: US-SC-006]
function createCombinedSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = (): void => {
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, {
        once: true,
      });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Error result factory
// ---------------------------------------------------------------------------

/**
 * Build a failure `FetchResult` for error cases.
 *
 * Centralises the construction so all error paths produce a consistent shape.
 */
function makeErrorResult(
  statusCode: number,
  statusText: string,
  error: string,
  finalUrl: string | null,
  redirectCount: number,
  retryAfterMs: number | null = null
): FetchResult {
  return {
    success: false,
    statusCode,
    statusText,
    contentType: null,
    bodyBytes: null,
    finalUrl,
    redirectCount,
    error,
    retryAfterMs,
  };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Fetch a URL with manual redirect following, retries, timeout, and
 * transparent decompression.
 *
 * Uses native `fetch` with `redirect: 'manual'` to follow HTTP 301/302/307/308
 * redirects one hop at a time, up to `config.maxRedirects` (5). Implements
 * retry logic for:
 *   - Transient network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED, EAI_AGAIN)
 *     → up to 2 retries with exponential backoff (1 s, 3 s)
 *   - HTTP 429 Too Many Requests → 1 retry after `Retry-After` header
 *     (or 3 s default)
 *   - HTTP 5xx server errors → 1 retry
 *
 * Non-transient errors (e.g., ENOTFOUND) and HTTP 4xx errors (non-429)
 * return immediately without retrying.
 *
 * The per-request timeout is enforced via an `AbortController` set to
 * `config.timeoutMs`. If an external abort signal is provided (from PL's
 * timeout guard), it is combined with the local timeout.
 *
 * @param url            The URL to fetch.
 * @param config         Resolved scrape configuration (timeoutMs, maxRedirects).
 * @param externalSignal Optional abort signal from the caller (PL timeout guard).
 * @returns              A `FetchResult` describing the fetch outcome.
 *
 * [Implements: US-SC-001, US-SC-003, US-SC-005, US-SC-006, US-SC-010]
 * [Constraint: DC-SC-003]
 */
// [Implements: US-SC-001, US-SC-003, US-SC-005, US-SC-006, US-SC-010]
export async function fetchUrl(
  url: string,
  config: ScrapeConfig,
  externalSignal?: AbortSignal
): Promise<FetchResult> {
  // [Implements: US-SC-006] Set up per-request timeout via AbortController
  const { signal, cleanup } = createCombinedSignal(
    config.timeoutMs,
    externalSignal
  );

  let currentUrl = url;
  let redirectCount = 0;
  let transientRetryCount = 0;
  let serverErrorRetryCount = 0;
  let rateLimitRetryCount = 0;
  let attempt = 1;

  try {
    for (;;) {
      // [Implements: US-SC-006] Check for abort/timeout before each attempt
      if (signal.aborted) {
        process.stderr.write(
          `[scrape] timeout: ${url} after ${config.timeoutMs}ms\n`
        );
        return makeErrorResult(
          0,
          '',
          `Fetch timed out after ${config.timeoutMs}ms`,
          redirectCount > 0 ? currentUrl : url,
          redirectCount
        );
      }

      try {
        // [Implements: US-SC-001] Issue HTTP GET via native fetch with manual redirect
        const response = await fetch(currentUrl, {
          redirect: 'manual',
          signal,
          headers: {
            'User-Agent': 'chomp-mcp/1.0',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
          },
        });

        // --- Redirect (301, 302, 307, 308) ---
        // [Implements: US-SC-003] Follow redirects manually
        if (REDIRECT_STATUSES.has(response.status)) {
          // [Implements: US-SC-003] Enforce maximum redirect hops (5)
          if (redirectCount >= config.maxRedirects) {
            return makeErrorResult(
              response.status,
              response.statusText,
              'Redirect loop or too many redirects',
              currentUrl,
              redirectCount
            );
          }

          const location = response.headers.get('location');
          if (!location) {
            return makeErrorResult(
              response.status,
              response.statusText,
              `HTTP ${response.status}: redirect without Location header`,
              currentUrl,
              redirectCount
            );
          }

          // [Implements: US-SC-003] Resolve Location relative to current URL
          currentUrl = new URL(location, currentUrl).toString();
          redirectCount++;
          continue;
        }

        // --- Success (2xx) ---
        // [Implements: US-SC-001] Store body, final URL, status for downstream
        if (response.status >= 200 && response.status < 300) {
          const arrayBuffer = await response.arrayBuffer();
          const rawBytes = new Uint8Array(arrayBuffer);
          const contentType = response.headers.get('content-type');
          const contentEncoding = response.headers.get('content-encoding');

          // [Implements: US-SC-001] Transparent decompression of gzip/br/deflate
          const bodyBytes = decompressIfNeeded(rawBytes, contentEncoding);

          // [Implements: US-SC-010] Log when a retry succeeds
          if (attempt > 1) {
            process.stderr.write(
              `[scrape] retry succeeded for ${url} on attempt ${attempt}\n`
            );
          }

          return {
            success: true,
            statusCode: response.status,
            statusText: response.statusText,
            contentType,
            bodyBytes,
            finalUrl: currentUrl,
            redirectCount,
            error: null,
            retryAfterMs: null,
          };
        }

        // --- Rate Limited (429) ---
        // [Implements: US-SC-005] Wait for Retry-After, retry once
        if (response.status === 429) {
          const retryAfterMs = parseRetryAfter(
            response.headers.get('retry-after')
          );

          // [Implements: US-SC-005] Only one retry for 429
          if (rateLimitRetryCount >= MAX_RATE_LIMIT_RETRIES) {
            return makeErrorResult(
              response.status,
              response.statusText,
              `HTTP 429: Too Many Requests (${currentUrl})`,
              currentUrl,
              redirectCount,
              retryAfterMs
            );
          }

          // Wait for Retry-After (or default 3 s) before retrying
          await sleep(retryAfterMs, signal);
          rateLimitRetryCount++;
          attempt++;
          continue;
        }

        // --- Server Error (5xx) ---
        // [Implements: US-SC-005] Retry once for 5xx
        if (response.status >= 500) {
          if (serverErrorRetryCount >= MAX_SERVER_ERROR_RETRIES) {
            return makeErrorResult(
              response.status,
              response.statusText,
              `HTTP ${response.status}: ${response.statusText} (${currentUrl})`,
              currentUrl,
              redirectCount
            );
          }

          // Brief delay before retrying
          await sleep(SERVER_ERROR_RETRY_DELAY_MS, signal);
          serverErrorRetryCount++;
          attempt++;
          continue;
        }

        // --- Client Error (4xx, non-429) ---
        // [Implements: US-SC-005] No retry for 4xx; return immediately
        return makeErrorResult(
          response.status,
          response.statusText,
          `HTTP ${response.status}: ${response.statusText} (${currentUrl})`,
          currentUrl,
          redirectCount
        );
      } catch (error) {
        // [Implements: US-SC-006] Handle abort/timeout from fetch or body read
        if (signal.aborted) {
          process.stderr.write(
            `[scrape] timeout: ${url} after ${config.timeoutMs}ms\n`
          );
          return makeErrorResult(
            0,
            '',
            `Fetch timed out after ${config.timeoutMs}ms`,
            redirectCount > 0 ? currentUrl : url,
            redirectCount
          );
        }

        const errorCode = getErrorCode(error);

        // [Implements: US-SC-010] Retry transient network errors (ECONNRESET, etc.)
        if (errorCode && isTransientError(errorCode)) {
          // [Implements: US-SC-010] Max 2 retries with backoff [1000, 3000]
          if (transientRetryCount >= BACKOFF_DELAYS.length) {
            const errorMsg = getErrorMessage(error);
            return makeErrorResult(
              0,
              '',
              `${errorCode}: ${errorMsg}`,
              null,
              redirectCount
            );
          }

          // [Implements: US-SC-010] Exponential backoff (1 s, 3 s)
          const delay = BACKOFF_DELAYS[transientRetryCount];
          await sleep(delay, signal);
          transientRetryCount++;
          attempt++;
          continue;
        }

        // [Implements: US-SC-010] Non-transient error (e.g., ENOTFOUND) — no retry
        const errorMsg = getErrorMessage(error);
        const code = errorCode ?? 'UNKNOWN';
        return makeErrorResult(
          0,
          '',
          `${code}: ${errorMsg}`,
          null,
          redirectCount
        );
      }
    }
  } finally {
    // [Implements: US-SC-006] Clean up timeout timer and signal listener
    cleanup();
  }
}
