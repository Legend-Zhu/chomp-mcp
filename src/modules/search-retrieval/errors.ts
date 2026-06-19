/**
 * Custom search error class hierarchy and isRetryableError classifier.
 *
 * This module defines the error infrastructure for the search-retrieval (SR)
 * module. All search-related failures are represented as typed error objects
 * carrying a SearchErrorCategory discriminator. The retry-failover logic in
 * retry-failover.ts uses isRetryableError() to decide whether to retry the
 * current instance, failover to an alternate instance, or propagate the error.
 *
 * Security: Per NFR-SR-002, error messages NEVER contain credentials, API
 * keys, or tokens. SearXNG access requires no authentication, so no secrets
 * are ever present in request parameters or response bodies to begin with.
 * Error constructors do not accept or store sensitive data.
 *
 * Error class hierarchy:
 *
 *   Error
 *   ├── SearchError (base — carries `category: SearchErrorCategory`)
 *   │   ├── SearchTimeoutError      (category: 'timeout')
 *   │   ├── SearchParseError         (category: 'parse_error')
 *   │   ├── SearchFailedError        (category: 'http_error')
 *   │   └── SearchUnavailableError   (category: 'network')
 *   ├── ConfigurationError           (category: 'config')
 *   └── ValidationError              (category: 'validation')
 *
 * Retryable categories (per US-SR-005, US-SR-009):
 *   - timeout      → transient; retry same instance then failover
 *   - network      → transient; retry same instance then failover
 *   - http_error   → transient (5xx/429); retry same instance then failover
 *   - parse_error  → may be instance-specific; retry then failover
 *
 * Non-retryable categories:
 *   - config       → environment misconfiguration; no retry helps
 *   - validation   → invalid input; no retry helps
 *
 * [Spec: US-SR-012, NFR-SR-002, NFR-SR-005, DC-SR-002]
 */

// ---------------------------------------------------------------------------
// SearchErrorCategory
// ---------------------------------------------------------------------------

/**
 * Discriminator for SearchError subclasses and other search errors.
 *
 * Used by isRetryableError() and the retry-failover logic to make automated
 * retry and instance-failover decisions without instanceof chains.
 *
 * Values:
 * - `'timeout'`      — Request exceeded the configured timeout (US-SR-004)
 * - `'parse_error'`  — SearXNG response could not be parsed as JSON (US-SR-002, US-SR-009)
 * - `'http_error'`   — SearXNG returned an HTTP error status (5xx, 429) (US-SR-005)
 * - `'network'`      — All SearXNG instances are unreachable (US-SR-006)
 * - `'config'`       — Environment configuration is invalid (US-SR-007)
 * - `'validation'`   — Input parameters are invalid (US-SR-001)
 *
 * [Constraint: DC-SR-002]
 */
export type SearchErrorCategory =
  | 'timeout'
  | 'parse_error'
  | 'http_error'
  | 'network'
  | 'config'
  | 'validation';

// ---------------------------------------------------------------------------
// SearchError — base class for all search-related operational errors
// ---------------------------------------------------------------------------

/**
 * Base error for all search-retrieval operational failures.
 *
 * Carries a `category` discriminator so that retry-failover logic and
 * upstream callers can branch on error type without instanceof chains.
 *
 * Subclasses set a fixed category in their constructors.
 *
 * [Implements: US-SR-012, Constraint: NFR-SR-002]
 */
export class SearchError extends Error {
  /** Classification of the error for retry/failover decisions. */
  readonly category: SearchErrorCategory;

  // [Implements: US-SR-012]
  constructor(message: string, category: SearchErrorCategory = 'http_error') {
    super(message);
    this.name = 'SearchError';
    this.category = category;

    // Maintain a proper prototype chain for instanceof checks in ES2015+.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// SearchTimeoutError
// ---------------------------------------------------------------------------

/**
 * Thrown when a SearXNG HTTP request exceeds the configured timeout
 * (`SEARXNG_TIMEOUT_MS` or the per-call override).
 *
 * Category: `'timeout'` — transient; eligible for retry and failover.
 *
 * [Implements: US-SR-004, US-SR-012, Constraint: NFR-SR-002]
 */
export class SearchTimeoutError extends SearchError {
  // [Implements: US-SR-004]
  constructor(message: string) {
    super(message, 'timeout');
    this.name = 'SearchTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// SearchParseError
// ---------------------------------------------------------------------------

/**
 * Thrown when a SearXNG response cannot be parsed as valid JSON, or when the
 * response content-type does not indicate JSON and the body fails to parse.
 *
 * Category: `'parse_error'` — treated as retryable for retry/failover logic
 * (US-SR-009) since the issue may be instance-specific.
 *
 * The optional `bodyExcerpt` field stores the first 200 characters of the
 * response body for diagnostic purposes when the response appears to be HTML
 * or otherwise non-JSON (US-SR-009).
 *
 * [Implements: US-SR-002, US-SR-009, US-SR-012, Constraint: NFR-SR-002]
 */
export class SearchParseError extends SearchError {
  /** First 200 chars of the response body for diagnostics; `null` if not captured. */
  readonly bodyExcerpt: string | null;

  // [Implements: US-SR-002, US-SR-009]
  constructor(message: string, bodyExcerpt?: string) {
    super(message, 'parse_error');
    this.name = 'SearchParseError';
    this.bodyExcerpt = bodyExcerpt ?? null;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// SearchFailedError
// ---------------------------------------------------------------------------

/**
 * Thrown when all retry attempts against the current (and only, in
 * self-hosted mode) SearXNG instance are exhausted without success.
 *
 * Category: `'http_error'` — transient; eligible for retry if a new
 * search() call is made, but within a single search() invocation this error
 * means all attempts on the current instance have failed.
 *
 * [Implements: US-SR-005, US-SR-006, US-SR-012, Constraint: NFR-SR-002]
 */
export class SearchFailedError extends SearchError {
  // [Implements: US-SR-005]
  constructor(message: string) {
    super(message, 'http_error');
    this.name = 'SearchFailedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// SearchUnavailableError
// ---------------------------------------------------------------------------

/**
 * Thrown when all SearXNG instances in the failover list have been exhausted
 * without a single successful response (public-instance mode only).
 *
 * Category: `'network'` — indicates systemic unavailability; not retried
 * further within the current search() call.
 *
 * [Implements: US-SR-006, US-SR-012, Constraint: NFR-SR-002]
 */
export class SearchUnavailableError extends SearchError {
  // [Implements: US-SR-006]
  constructor(message: string) {
    super(message, 'network');
    this.name = 'SearchUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// ConfigurationError
// ---------------------------------------------------------------------------

/**
 * Thrown when a required environment variable is missing or has an invalid
 * value (e.g., `SEARXNG_URL` is not a valid HTTP(S) URL).
 *
 * Extends `Error` directly (not `SearchError`) because configuration errors
 * are fatal at initialization time and are never retryable. Still carries a
 * `category` field for uniform classification by isRetryableError().
 *
 * Category: `'config'` — non-retryable.
 *
 * [Implements: US-SR-007, US-SR-012, Constraint: NFR-SR-002]
 */
export class ConfigurationError extends Error {
  /** Always `'config'` — configuration errors are non-retryable. */
  readonly category: SearchErrorCategory;

  // [Implements: US-SR-007]
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
    this.category = 'config';

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

/**
 * Thrown when the `query` parameter to `search()` is empty, null, whitespace-
 * only, or exceeds 500 characters.
 *
 * Extends `Error` directly (not `SearchError`) because validation errors
 * indicate invalid caller input and are never retryable. Still carries a
 * `category` field for uniform classification by isRetryableError().
 *
 * Category: `'validation'` — non-retryable.
 *
 * [Implements: US-SR-001, US-SR-012, Constraint: NFR-SR-002]
 */
export class ValidationError extends Error {
  /** Always `'validation'` — input validation errors are non-retryable. */
  readonly category: SearchErrorCategory;

  // [Implements: US-SR-001]
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    this.category = 'validation';

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// isRetryableError classifier
// ---------------------------------------------------------------------------

/**
 * Set of error categories considered retryable by the search-retrieval
 * retry-failover logic.
 *
 * Per US-SR-005: network errors, timeouts, and HTTP 5xx/429 are retryable.
 * Per US-SR-009: parse errors are also retryable (may be instance-specific).
 *
 * `'config'` and `'validation'` are excluded — they represent deterministic
 * failures that no amount of retrying will resolve.
 *
 * [Constraint: DC-SR-002]
 */
const RETRYABLE_CATEGORIES: ReadonlySet<SearchErrorCategory> = new Set<
  SearchErrorCategory
>(['timeout', 'network', 'http_error', 'parse_error']);

/**
 * Classify whether an error is eligible for retry or failover.
 *
 * Returns `true` for errors whose category is in {@link RETRYABLE_CATEGORIES}
 * (`timeout`, `network`, `http_error`, `parse_error`).
 *
 * Returns `false` for:
 * - `ConfigurationError` (category: `'config'`)
 * - `ValidationError` (category: `'validation'`)
 * - Any error without a recognized `category` property
 * - Non-error values (null, undefined, primitives)
 *
 * @param error - The caught error or thrown value to classify.
 * @returns `true` if the error represents a transient condition worth retrying.
 *
 * [Implements: US-SR-005, US-SR-009]
 */
export function isRetryableError(error: unknown): boolean {
  // SearchError subclasses — check the category field directly.
  if (error instanceof SearchError) {
    return RETRYABLE_CATEGORIES.has(error.category);
  }

  // ConfigurationError and ValidationError extend Error directly but still
  // carry a category. Their categories ('config', 'validation') are never
  // in RETRYABLE_CATEGORIES, so this check returns false for them.
  if (error instanceof ConfigurationError) {
    return false;
  }
  if (error instanceof ValidationError) {
    return false;
  }

  // Duck-type fallback: check for any object with a string `category`
  // property matching a known SearchErrorCategory. This handles errors
  // thrown by other modules (e.g., AppError with a compatible category).
  if (error !== null && typeof error === 'object' && 'category' in error) {
    const category = (error as { category: unknown }).category;
    if (typeof category === 'string') {
      return RETRYABLE_CATEGORIES.has(category as SearchErrorCategory);
    }
  }

  // Unknown errors without a category are not retryable.
  return false;
}
