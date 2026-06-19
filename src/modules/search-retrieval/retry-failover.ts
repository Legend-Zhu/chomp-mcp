/**
 * Retry-failover orchestrator for the search-retrieval (SR) module.
 *
 * This module implements the core search orchestrator with per-instance retry
 * (exponential backoff + jitter), cross-instance failover, a 30-second overall
 * ceiling, and structured stderr logging (SEARCH START/OK/RETRY/FAILED).
 *
 * Public API:
 *   - search(query, options?) — entry point used by PL
 *
 * Internal functions (exported for testing):
 *   - validateQuery(query)
 *   - resolveConfig(options?)
 *   - computeBackoffDelay(attemptIndex, retryBaseMs, retryAfterMs?)
 *   - executeWithRetryFailover(query, config, pool)
 *
 * [Spec: US-SR-001, US-SR-005, US-SR-006, US-SR-011, BG-SR-001, BG-SR-002, NFR-SR-001, NFR-SR-002, NFR-SR-005, NFR-SR-006]
 */

import type { SearchResult, SearchOptions } from '../../shared/types/search.js';
import {
  ValidationError,
  SearchFailedError,
  SearchUnavailableError,
  SearchError,
  isRetryableError,
} from './errors.js';
import {
  type SearchConfig,
  fetchSearXNG,
  resolveTimeoutMs,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_MAX_RESULTS,
} from './searxng-client.js';
import {
  type InstancePool,
  createInstancePool,
  getCurrentInstance,
  advanceToNextInstance,
  promoteInstance,
  resetCursor,
  hasMoreInstances,
} from './instance-pool.js';
import { parseResponse } from './response-parser.js';
import { normalizeResults } from './result-normalizer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed query length in characters (US-SR-001). */
const MAX_QUERY_LENGTH = 500;

/** Overall time ceiling for the entire search operation in ms (NFR-SR-001). */
const OVERALL_CEILING_MS = 30_000;

/** Jitter factor for exponential backoff (±20%) (US-SR-005). */
const JITTER_FACTOR = 0.2;

/** Maximum Retry-After value in milliseconds (cap) (US-SR-005). */
const MAX_RETRY_AFTER_MS = 10_000;

// ---------------------------------------------------------------------------
// Module-level singleton instance pool
// ---------------------------------------------------------------------------

let poolSingleton: InstancePool | null = null;

function getPool(): InstancePool {
  if (poolSingleton === null) {
    poolSingleton = createInstancePool();
  }
  return poolSingleton;
}

// ---------------------------------------------------------------------------
// sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// validateQuery
// ---------------------------------------------------------------------------

// [Implements: US-SR-001]
/**
 * Validate the search query parameter.
 *
 * Checks that the query is a non-empty string (after trimming whitespace) and
 * does not exceed 500 characters.
 *
 * @param query - The raw query value to validate.
 * @throws {ValidationError} If the query is empty, null, whitespace-only, or
 *   exceeds 500 characters.
 *
 * [Implements: US-SR-001]
 * [Constraint: NFR-SR-002]
 */
export function validateQuery(query: unknown): void {
  // [Implements: US-SR-001] Must be a non-empty string
  if (typeof query !== 'string' || query.trim() === '') {
    throw new ValidationError('Query must be a non-empty string');
  }

  // [Implements: US-SR-001] Must not exceed 500 characters
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ValidationError('Query must not exceed 500 characters');
  }
}

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

// [Implements: US-SR-005, US-SR-011]
/**
 * Resolve search configuration from environment variables and caller options.
 *
 * Reads SEARXNG_MAX_RETRIES, SEARXNG_RETRY_BASE_MS, and SEARXNG_TIMEOUT_MS
 * from the environment with safe defaults, merging any caller-provided
 * overrides from SearchOptions.
 *
 * @param options - Optional caller-provided overrides.
 * @returns A fully resolved SearchConfig.
 *
 * [Implements: US-SR-005, US-SR-011]
 * [Constraint: DC-SR-004]
 */
export function resolveConfig(options?: SearchOptions | null): SearchConfig {
  // [Implements: US-SR-004] Resolve timeout from override or env
  const timeoutMs = resolveTimeoutMs(options?.timeoutMs);

  // [Implements: US-SR-005] Resolve max retries from env
  let maxRetries = DEFAULT_MAX_RETRIES;
  const envMaxRetries = process.env['SEARXNG_MAX_RETRIES'];
  if (envMaxRetries !== undefined) {
    const trimmed = envMaxRetries.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (parsed >= 0) {
        maxRetries = parsed;
      } else {
        process.stderr.write(
          `[SR] WARN invalid SEARXNG_MAX_RETRIES: value=${envMaxRetries} fallback=${DEFAULT_MAX_RETRIES}\n`
        );
      }
    } else {
      process.stderr.write(
        `[SR] WARN invalid SEARXNG_MAX_RETRIES: value=${envMaxRetries} fallback=${DEFAULT_MAX_RETRIES}\n`
      );
    }
  }

  // [Implements: US-SR-005] Resolve retry base delay from env
  let retryBaseMs = DEFAULT_RETRY_BASE_MS;
  const envRetryBaseMs = process.env['SEARXNG_RETRY_BASE_MS'];
  if (envRetryBaseMs !== undefined) {
    const trimmed = envRetryBaseMs.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (parsed > 0) {
        retryBaseMs = parsed;
      } else {
        process.stderr.write(
          `[SR] WARN invalid SEARXNG_RETRY_BASE_MS: value=${envRetryBaseMs} fallback=${DEFAULT_RETRY_BASE_MS}\n`
        );
      }
    } else {
      process.stderr.write(
        `[SR] WARN invalid SEARXNG_RETRY_BASE_MS: value=${envRetryBaseMs} fallback=${DEFAULT_RETRY_BASE_MS}\n`
      );
    }
  }

  // [Implements: US-SR-011] Resolve max results from options
  let maxResults = DEFAULT_MAX_RESULTS;
  if (options?.maxResults !== undefined) {
    if (Number.isInteger(options.maxResults) && options.maxResults > 0) {
      maxResults = options.maxResults;
    } else {
      process.stderr.write(
        `[SR] WARN invalid maxResults: value=${options.maxResults} fallback=${DEFAULT_MAX_RESULTS}\n`
      );
    }
  }

  return {
    timeoutMs,
    maxRetries,
    retryBaseMs,
    maxResults,
    categories: options?.categories,
  };
}

// ---------------------------------------------------------------------------
// computeBackoffDelay
// ---------------------------------------------------------------------------

// [Implements: US-SR-005]
/**
 * Compute the backoff delay for a retry attempt.
 *
 * Uses exponential backoff: `base * 2^(attemptIndex)` with ±20% jitter.
 * When `retryAfterMs` is provided (from a 429 Retry-After header), that value
 * is used instead (capped at 10 seconds).
 *
 * @param attemptIndex - Zero-based index of the failed attempt (0 = first failure).
 * @param retryBaseMs  - Base delay in ms (from SEARXNG_RETRY_BASE_MS).
 * @param retryAfterMs - Optional Retry-After value in ms (from HTTP 429 header).
 * @returns The delay in milliseconds before the next retry.
 *
 * [Implements: US-SR-005]
 * [Constraint: DC-SR-004]
 */
export function computeBackoffDelay(
  attemptIndex: number,
  retryBaseMs: number,
  retryAfterMs?: number | null
): number {
  // [Implements: US-SR-005] Honor Retry-After header if provided (capped at 10s)
  if (retryAfterMs != null) {
    return Math.min(Math.max(0, retryAfterMs), MAX_RETRY_AFTER_MS);
  }

  // [Implements: US-SR-005] Exponential backoff: base * 2^(attemptIndex)
  const baseDelay = retryBaseMs * Math.pow(2, attemptIndex);

  // [Implements: US-SR-005] Jitter of ±20%
  const jitter = baseDelay * JITTER_FACTOR * (Math.random() * 2 - 1);

  return Math.max(0, Math.round(baseDelay + jitter));
}

// ---------------------------------------------------------------------------
// logSearchFailed helper
// ---------------------------------------------------------------------------

// [Implements: US-SR-005, NFR-SR-005]
/**
 * Log the SEARCH FAILED event to stderr.
 *
 * @param query  - The search query.
 * @param errors - Array of error messages encountered during all attempts.
 *
 * [Implements: US-SR-005, NFR-SR-005]
 */
function logSearchFailed(query: string, errors: string[]): void {
  const errorSummary = errors.length > 0 ? errors.join('; ') : 'unknown';
  process.stderr.write(
    `[SR] SEARCH FAILED | query: ${query} | errors: ${errorSummary}\n`
  );
}

// ---------------------------------------------------------------------------
// executeWithRetryFailover
// ---------------------------------------------------------------------------

// [Implements: US-SR-005, US-SR-006, NFR-SR-001]
/**
 * Execute a search with per-instance retry and cross-instance failover.
 *
 * Algorithm:
 *   1. Start with the current instance (cursor reset to 0 by caller).
 *   2. For each attempt (0..maxRetries):
 *      a. Check the 30s overall ceiling — throw SearchFailedError if exceeded.
 *      b. Log SEARCH START.
 *      c. Call fetchSearXNG → parseResponse → normalizeResults.
 *      d. On HTTP 200: log SEARCH OK, promote instance if failover, return results.
 *      e. On retryable HTTP error (429/5xx): log SEARCH RETRY, sleep, retry.
 *      f. On thrown retryable error (timeout/network/parse): log SEARCH RETRY, sleep, retry.
 *      g. On non-retryable error: rethrow immediately.
 *   3. When all retries exhausted for current instance:
 *      a. If more instances exist: advance cursor, reset retry counter, goto 2.
 *      b. If no more instances: log SEARCH FAILED, throw appropriate error.
 *
 * @param query  - The validated search query string.
 * @param config - The resolved search configuration.
 * @param pool   - The instance pool (cursor should be reset to 0 by caller).
 * @returns An array of normalized SearchResult objects.
 * @throws {SearchFailedError} If the 30s ceiling is exceeded or all retries
 *   are exhausted in self-hosted mode.
 * @throws {SearchUnavailableError} If all instances are exhausted in public mode.
 *
 * [Implements: US-SR-005, US-SR-006, NFR-SR-001, NFR-SR-002, NFR-SR-005]
 */
export async function executeWithRetryFailover(
  query: string,
  config: SearchConfig,
  pool: InstancePool
): Promise<SearchResult[]> {
  const startTime = Date.now();
  const errors: string[] = [];

  // [Implements: NFR-SR-001] Overall 30-second ceiling check helper
  const checkCeiling = (): boolean => {
    return Date.now() - startTime >= OVERALL_CEILING_MS;
  };

  // Outer loop: failover across instances
  for (;;) {
    // [Implements: NFR-SR-001] Check ceiling before starting with a new instance
    if (checkCeiling()) {
      logSearchFailed(query, errors);
      throw new SearchFailedError(
        'Search exceeded overall time ceiling of 30000ms'
      );
    }

    const instanceUrl = getCurrentInstance(pool);

    // Inner loop: per-instance retry
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      // [Implements: NFR-SR-001] Check ceiling before each attempt
      if (checkCeiling()) {
        logSearchFailed(query, errors);
        throw new SearchFailedError(
          'Search exceeded overall time ceiling of 30000ms'
        );
      }

      // [Implements: US-SR-005] Log SEARCH START
      process.stderr.write(
        `[SR] SEARCH START | query: ${query} | instance: ${instanceUrl} | attempt: ${attempt + 1}\n`
      );

      try {
        // [Implements: US-SR-001] Fetch from SearXNG
        const fetchResult = await fetchSearXNG(instanceUrl, query, config);

        // [Implements: US-SR-002] HTTP 200 — parse and normalize
        if (fetchResult.status === 200) {
          const parseOutput = parseResponse(fetchResult, query);
          const results = normalizeResults(
            parseOutput.results,
            config.maxResults
          );

          // [Implements: US-SR-005] Log SEARCH OK
          const elapsed = Date.now() - startTime;
          process.stderr.write(
            `[SR] SEARCH OK | results: ${results.length} | duration_ms: ${elapsed} | instance: ${instanceUrl}\n`
          );

          // [Implements: US-SR-005] Log retry success if this wasn't the first attempt
          if (attempt > 0) {
            process.stderr.write(
              `[SR] Search succeeded on attempt ${attempt + 1} after retry\n`
            );
          }

          // [Implements: US-SR-006] Promote instance if this was a failover success
          if (pool.cursor > 0) {
            promoteInstance(pool, instanceUrl);
          }

          return results;
        }

        // HTTP error status — classify retryability
        const isRetryableStatus =
          fetchResult.status === 429 || fetchResult.status >= 500;
        const errorMsg = `HTTP ${fetchResult.status} from ${instanceUrl}`;
        errors.push(errorMsg);

        if (isRetryableStatus && attempt < config.maxRetries) {
          // [Implements: US-SR-005] Retry with backoff
          const retryAfterMs =
            fetchResult.status === 429 ? fetchResult.retryAfterMs : null;
          const delay = computeBackoffDelay(
            attempt,
            config.retryBaseMs,
            retryAfterMs
          );
          const reason =
            fetchResult.status === 429
              ? 'rate_limited'
              : `http_${fetchResult.status}`;

          // [Implements: US-SR-005] Log SEARCH RETRY
          process.stderr.write(
            `[SR] SEARCH RETRY | reason: ${reason} | nextAttemptIn: ${delay}ms\n`
          );

          await sleep(delay);
          continue;
        }

        // Not retryable or retries exhausted — break to failover
        break;
      } catch (error) {
        // [Implements: US-SR-005] Classify error via isRetryableError
        if (!isRetryableError(error)) {
          // Non-retryable error — rethrow immediately
          throw error;
        }

        // Retryable error (timeout, network, parse_error)
        const errorType =
          error instanceof SearchError ? error.category : 'unknown';
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(errorMsg);

        if (attempt < config.maxRetries) {
          // [Implements: US-SR-005] Retry with backoff
          const delay = computeBackoffDelay(attempt, config.retryBaseMs);

          // [Implements: US-SR-005] Log SEARCH RETRY
          process.stderr.write(
            `[SR] SEARCH RETRY | reason: ${errorType} | nextAttemptIn: ${delay}ms\n`
          );

          await sleep(delay);
          continue;
        }

        // Retries exhausted — break to failover
        break;
      }
    }

    // [Implements: US-SR-006] All retries exhausted for current instance — try failover
    if (hasMoreInstances(pool)) {
      advanceToNextInstance(pool);
      continue; // Continue outer loop with next instance
    }

    // [Implements: US-SR-006] No more instances — all exhausted
    logSearchFailed(query, errors);

    if (pool.mode === 'self-hosted') {
      // [Implements: US-SR-005] Self-hosted mode — throw SearchFailedError
      throw new SearchFailedError(
        `All retry attempts exhausted for instance ${getCurrentInstance(pool)}`
      );
    }

    // [Implements: US-SR-006] Public mode — throw SearchUnavailableError
    throw new SearchUnavailableError(
      'All SearXNG instances unavailable. Set SEARXNG_URL to a self-hosted instance for improved reliability.'
    );
  }
}

// ---------------------------------------------------------------------------
// search — public entry point
// ---------------------------------------------------------------------------

// [Implements: US-SR-001, US-SR-005, US-SR-006, US-SR-011]
/**
 * Search for results using SearXNG meta-search with retry and failover.
 *
 * This is the public entry point for the search-retrieval module. It validates
 * the query, resolves configuration from environment variables and options,
 * and delegates to executeWithRetryFailover for the actual search with
 * per-instance retry, cross-instance failover, and a 30-second overall ceiling.
 *
 * @param query   - The search query string (non-empty, ≤ 500 chars).
 * @param options - Optional parameters (maxResults, timeoutMs, categories).
 * @returns A Promise resolving to an array of normalized SearchResult objects,
 *   sorted by descending score, with at most `maxResults` entries.
 * @throws {ValidationError} If the query is empty, null, whitespace-only, or
 *   exceeds 500 characters.
 * @throws {SearchFailedError} If the 30s ceiling is exceeded or all retries are
 *   exhausted in self-hosted mode.
 * @throws {SearchUnavailableError} If all instances are exhausted in public mode.
 *
 * [Implements: US-SR-001, US-SR-005, US-SR-006, US-SR-011, NFR-SR-001, NFR-SR-002, NFR-SR-005]
 */
export async function search(
  query: string,
  options?: SearchOptions
): Promise<SearchResult[]> {
  // [Implements: US-SR-001] Validate query
  validateQuery(query);

  // [Implements: US-SR-005, US-SR-011] Resolve configuration
  const config = resolveConfig(options);

  // [Implements: US-SR-006] Get or create instance pool
  const pool = getPool();

  // [Implements: US-SR-006] Reset cursor to start with the preferred instance
  resetCursor(pool);

  // [Implements: US-SR-005, US-SR-006, NFR-SR-001] Execute with retry and failover
  return executeWithRetryFailover(query, config, pool);
}
