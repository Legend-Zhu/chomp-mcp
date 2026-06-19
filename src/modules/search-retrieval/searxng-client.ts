/**
 * SearXNG HTTP client — transport layer for the search-retrieval (SR) module.
 *
 * Uses Node.js 18+ native `fetch` (no axios/got polyfills) to send GET requests
 * to a SearXNG `/search` endpoint with `format=json`, `safesearch=1`, and
 * optional `categories`. Enforces per-request timeout via `AbortController`,
 * ensures no dangling TCP connections by clearing the timeout timer in a
 * `finally` block, and returns a `SearXNGFetchResult` with status, body,
 * contentType, and parsed Retry-After.
 *
 * [Spec: US-SR-001, US-SR-004, DC-SR-004, DC-SR-006, NFR-SR-002]
 */

import type { SearXNGFetchResult } from './response-parser.js';
import { SearchTimeoutError, SearchError } from './errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-request timeout in milliseconds (env: SEARXNG_TIMEOUT_MS). */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Default max retry attempts per instance (env: SEARXNG_MAX_RETRIES). */
export const DEFAULT_MAX_RETRIES = 2;

/** Default exponential backoff base delay in ms (env: SEARXNG_RETRY_BASE_MS). */
export const DEFAULT_RETRY_BASE_MS = 500;

/** Default maximum number of results to return. */
export const DEFAULT_MAX_RESULTS = 10;

/** Maximum Retry-After value in milliseconds (cap). */
const MAX_RETRY_AFTER_MS = 10_000;

/** SafeSearch level (1 = moderate). */
const SAFESEARCH_LEVEL = '1';

// ---------------------------------------------------------------------------
// SearchConfig — per-call resolved configuration
// ---------------------------------------------------------------------------

/**
 * Per-call resolved search configuration, merging env-var defaults with
 * `SearchOptions` overrides.
 *
 * [Spec: DC-SR-004, DC-SR-006]
 */
export interface SearchConfig {
  /** Per-request timeout in ms (from `options.timeoutMs` or `SEARXNG_TIMEOUT_MS`, default 10000). */
  timeoutMs: number;
  /** Max retry attempts per instance (from `SEARXNG_MAX_RETRIES`, default 2). */
  maxRetries: number;
  /** Exponential backoff base delay in ms (from `SEARXNG_RETRY_BASE_MS`, default 500). */
  retryBaseMs: number;
  /** Max results to return (from `options.maxResults`, default 10). */
  maxResults: number;
  /** Optional SearXNG categories parameter (from `options.categories`). */
  categories?: string;
}

// ---------------------------------------------------------------------------
// resolveTimeoutMs
// ---------------------------------------------------------------------------

// [Implements: US-SR-004]
/**
 * Resolve the per-request timeout from an optional override or the
 * `SEARXNG_TIMEOUT_MS` environment variable, with a safe default.
 *
 * Resolution order:
 *   1. `override` — if provided and a positive integer, use it directly.
 *   2. `SEARXNG_TIMEOUT_MS` env var — if set and a positive integer, use it.
 *   3. Default — `DEFAULT_TIMEOUT_MS` (10 000 ms).
 *
 * When `SEARXNG_TIMEOUT_MS` is set but not a positive integer, a warning is
 * logged to stderr and the default is used.
 *
 * @param override Optional per-call timeout override (from `SearchOptions.timeoutMs`).
 * @returns The resolved timeout in milliseconds.
 *
 * [Implements: US-SR-004]
 * [Constraint: DC-SR-004]
 */
export function resolveTimeoutMs(override?: number): number {
  // [Constraint: DC-SR-004] Override takes precedence if valid
  if (override !== undefined) {
    if (Number.isInteger(override) && override > 0) {
      return override;
    }
    process.stderr.write(
      `[SR] WARN invalid timeout override: value=${override} fallback=${DEFAULT_TIMEOUT_MS}\n`
    );
  }

  // [Implements: US-SR-004] Read SEARXNG_TIMEOUT_MS env var
  const envValue = process.env['SEARXNG_TIMEOUT_MS'];
  if (envValue !== undefined) {
    const trimmed = envValue.trim();
    // [Constraint: DC-SR-004] Must be a positive integer (digits only)
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (parsed > 0) {
        return parsed;
      }
    }
    // [Implements: US-SR-004] Invalid env value — log warning and fall back to default
    process.stderr.write(
      `[SR] WARN invalid SEARXNG_TIMEOUT_MS: value=${envValue} fallback=${DEFAULT_TIMEOUT_MS}\n`
    );
  }

  return DEFAULT_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// buildSearchUrl
// ---------------------------------------------------------------------------

// [Implements: US-SR-001]
/**
 * Build the SearXNG search URL with proper query parameter encoding.
 *
 * Constructs a URL with the following parameters:
 *   - `q` — the search query (URL-encoded via `URLSearchParams`)
 *   - `format` — always `json`
 *   - `safesearch` — always `1` (moderate)
 *   - `categories` — optional, only included when `config.categories` is set
 *
 * Uses `URL` and `URLSearchParams` for proper encoding of special characters
 * in the query string.
 *
 * @param instanceUrl The base URL of the SearXNG instance (e.g. `https://searx.be`).
 * @param query       The search query string.
 * @param config      The resolved search configuration (uses `categories` field).
 * @returns The fully constructed search URL string.
 *
 * [Implements: US-SR-001]
 * [Constraint: DC-SR-006]
 */
export function buildSearchUrl(
  instanceUrl: string,
  query: string,
  config: SearchConfig
): string {
  const url = new URL(instanceUrl);

  // Append /search to the existing pathname (handles trailing slashes)
  url.pathname = url.pathname.replace(/\/+$/, '') + '/search';

  // [Constraint: DC-SR-006] Build query parameters with proper encoding
  const params = new URLSearchParams();
  params.set('q', query);
  params.set('format', 'json');
  params.set('safesearch', SAFESEARCH_LEVEL);

  // [Implements: US-SR-001] Optional categories parameter
  if (config.categories !== undefined) {
    params.set('categories', config.categories);
  }

  url.search = params.toString();
  return url.toString();
}

// ---------------------------------------------------------------------------
// parseRetryAfterMs
// ---------------------------------------------------------------------------

/**
 * Parse the `Retry-After` HTTP header into milliseconds, capped at
 * `MAX_RETRY_AFTER_MS` (10 000 ms).
 *
 * Supports both delta-seconds (e.g. `"120"`) and HTTP-date
 * (e.g. `"Wed, 21 Oct 2025 07:28:00 GMT"`) formats per RFC 7231 §7.1.3.
 *
 * @param headerValue The raw `Retry-After` header value, or `null` if absent.
 * @returns The parsed delay in milliseconds (capped at 10 000), or `null` if
 *          the header is absent or unparseable.
 *
 * [Constraint: DC-SR-006]
 */
function parseRetryAfterMs(headerValue: string | null): number | null {
  if (headerValue === null) {
    return null;
  }

  const trimmed = headerValue.trim();
  if (trimmed === '') {
    return null;
  }

  // Try parsing as delta-seconds (non-negative integer)
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  // Try parsing as HTTP-date
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.min(Math.max(0, diff), MAX_RETRY_AFTER_MS);
  }

  // Unparseable header — return null
  return null;
}

// ---------------------------------------------------------------------------
// fetchSearXNG
// ---------------------------------------------------------------------------

// [Implements: US-SR-004]
/**
 * Send an HTTP GET request to a SearXNG `/search` endpoint and return the
 * raw response data as a `SearXNGFetchResult`.
 *
 * Uses Node.js 18+ native `fetch` with an `AbortController` to enforce a
 * per-request timeout. When the timeout elapses before a complete response is
 * received:
 *   1. The underlying HTTP request is aborted (closing the TCP connection).
 *   2. `"SearXNG request timed out after {N}ms"` is logged to stderr.
 *   3. A `SearchTimeoutError` is thrown.
 *
 * The timeout timer is always cleared in a `finally` block to prevent dangling
 * timer handles and ensure no dangling TCP connections remain.
 *
 * For non-timeout network errors (connection refused, DNS failure, etc.), a
 * `SearchError` with category `'network'` is thrown.
 *
 * For any HTTP status code (200, 429, 500, etc.), the response is returned as
 * a `SearXNGFetchResult` — the caller (retry-failover logic) inspects the
 * `status` field to decide whether to retry or failover.
 *
 * @param instanceUrl The base URL of the SearXNG instance.
 * @param query       The search query string.
 * @param config      The resolved search configuration (uses `timeoutMs` and `categories`).
 * @returns A `SearXNGFetchResult` with status, body, contentType, and retryAfterMs.
 * @throws {SearchTimeoutError} When the per-request timeout elapses.
 * @throws {SearchError} When a non-timeout network error occurs.
 *
 * [Implements: US-SR-004]
 * [Constraint: DC-SR-004, DC-SR-006, NFR-SR-002]
 */
export async function fetchSearXNG(
  instanceUrl: string,
  query: string,
  config: SearchConfig
): Promise<SearXNGFetchResult> {
  // [Constraint: DC-SR-006] Build the search URL with proper encoding
  const searchUrl = buildSearchUrl(instanceUrl, query, config);
  const timeoutMs = config.timeoutMs;

  // [Implements: US-SR-004] Set up per-request timeout via AbortController
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    // [Implements: US-SR-004] Issue HTTP GET via native fetch
    const response = await fetch(searchUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'chomp-mcp/1.0',
      },
    });

    // [Constraint: DC-SR-006] Read Content-Type and Retry-After headers
    const contentType = response.headers.get('content-type');
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));

    // [Constraint: DC-SR-006] Convert response body to text
    const body = await response.text();

    return {
      status: response.status,
      body,
      contentType,
      retryAfterMs,
    };
  } catch (error) {
    // [Implements: US-SR-004] On timeout, log to stderr and throw SearchTimeoutError
    if (controller.signal.aborted) {
      process.stderr.write(
        `SearXNG request timed out after ${timeoutMs}ms\n`
      );
      throw new SearchTimeoutError(
        `SearXNG request timed out after ${timeoutMs}ms`
      );
    }

    // Non-timeout network error — wrap in SearchError with 'network' category
    const message = error instanceof Error ? error.message : String(error);
    throw new SearchError(
      `SearXNG request failed: ${message}`,
      'network'
    );
  } finally {
    // [Implements: US-SR-004] Always clear the timeout timer to prevent dangling handles
    clearTimeout(timer);
  }
}
