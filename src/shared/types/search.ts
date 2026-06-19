/**
 * Shared search type definitions — the public contract for the
 * search-retrieval (SR) module.
 *
 * Consumed by downstream modules: PL (pipeline-orchestration), SC
 * (scrape-extract), DD (deduplicate), and SY (synthesize).
 *
 * [Spec: US-SR-012, DC-SR-002, DC-SR-003]
 */

/**
 * A single normalized search result returned by the search-retrieval module.
 *
 * The `search()` function resolves with an array of `SearchResult` objects.
 * Each field carries content from the underlying SearXNG meta-search response,
 * normalized to a stable shape with defaults applied for missing values.
 *
 * [Spec: DC-SR-002, US-SR-012]
 */
export interface SearchResult {
  /**
   * Result title.
   *
   * Defaults to `"(untitled)"` if the source engine omits a title.
   * Truncated to 500 characters (497 + `"..."`) when excessively long.
   */
  title: string;

  /**
   * Result URL.
   *
   * Validated as a parseable URI via the WHATWG `URL` constructor.
   * Entries with missing or invalid URLs are filtered out during parsing.
   */
  url: string;

  /**
   * Result snippet or description text.
   *
   * Sourced from the SearXNG `content` field.
   * Defaults to `""` (empty string) when no snippet is available.
   * Truncated to 1000 characters (997 + `"..."`) when excessively long.
   */
  snippet: string;

  /**
   * Normalized relevance score in the range `[0.0, 1.0]`.
   *
   * The first (top-ranked) result always receives the highest score.
   * Scores are derived from SearXNG result ordering or the engine's
   * `score` field when present.
   */
  score: number;
}

/**
 * Optional parameters passed to the `search()` function.
 *
 * All fields are optional — when omitted, values fall back to
 * environment-variable defaults resolved at call time.
 *
 * [Spec: DC-SR-003, US-SR-012]
 */
export interface SearchOptions {
  /**
   * Maximum number of results to return.
   *
   * Default: `10` when omitted. Must be a positive integer.
   * The underlying request may retrieve more results from SearXNG;
   * this value controls the final count after normalization and dedup.
   */
  maxResults?: number;

  /**
   * Per-request timeout override in milliseconds.
   *
   * Falls back to the `SEARXNG_TIMEOUT_MS` environment variable
   * (default `10000`) when omitted.
   */
  timeoutMs?: number;

  /**
   * SearXNG `categories` query parameter.
   *
   * Restricts the search to specific result categories (e.g.,
   * `"general"`, `"it"`, `"science"`). Passed through to SearXNG as-is.
   */
  categories?: string;
}
