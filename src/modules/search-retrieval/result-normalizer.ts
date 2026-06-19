/**
 * Result normalizer for the search-retrieval (SR) module.
 *
 * Transforms raw ParsedResult[] (from response-parser) into final SearchResult[]
 * by applying field defaults, field truncation, score normalization to [0.0, 1.0],
 * fragment-insensitive exact-URL deduplication, descending score sort, and
 * maxResults truncation.
 *
 * Designed for memory efficiency (NFR-SR-003): each transformation step produces
 * a new array, releasing the previous intermediate for garbage collection so
 * that raw SearXNG response data is not retained beyond the normalization call.
 *
 * [Spec: US-SR-003, US-SR-010, NFR-SR-003, DC-SR-002, DC-SR-003]
 */

import type { SearchResult } from '../../shared/types/search.js';

// ---------------------------------------------------------------------------
// Module-internal types (also consumed by response-parser)
// ---------------------------------------------------------------------------

/**
 * A single result extracted from a SearXNG response, after URL validation
 * but before normalization (defaults, truncation, score normalization).
 *
 * The `score` field is nullable — SearXNG may omit it entirely.
 *
 * [Spec: US-SR-003, US-SR-010]
 */
export interface ParsedResult {
  /** Raw title string pre-normalization (may be empty string). */
  title: string;
  /** Validated URL string that passes the WHATWG URL constructor. */
  url: string;
  /** Raw content/snippet string pre-normalization (may be empty string). */
  content: string;
  /** Numeric score if SearXNG provided one; null if not provided. */
  score: number | null;
}

/**
 * Output of the response-parser stage: validated results + malformed-skip count.
 *
 * [Spec: US-SR-002]
 */
export interface ParseOutput {
  /** Valid parsed results with malformed entries excluded. */
  results: ParsedResult[];
  /** Count of entries skipped due to missing or invalid URL. */
  skippedMalformed: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum title length including potential truncation suffix. */
const TITLE_MAX_LENGTH = 500;

/** Maximum snippet length including potential truncation suffix. */
const SNIPPET_MAX_LENGTH = 1000;

/** Suffix appended when a field is truncated. */
const TRUNCATION_SUFFIX = '...';

/** Default title when the source engine omits one. */
const DEFAULT_TITLE = '(untitled)';

// ---------------------------------------------------------------------------
// truncateField
// ---------------------------------------------------------------------------

/**
 * Truncate a string to at most `maxLength` characters, appending `"..."` when
 * truncation occurs.
 *
 * When `value.length > maxLength`, the result is `maxLength` characters long:
 * the first `maxLength - 3` characters of the original value followed by `"..."`.
 * When `value.length <= maxLength`, the original value is returned unchanged.
 *
 * [Implements: US-SR-003]
 * [Constraint: DC-SR-002]
 *
 * @param value    The string to potentially truncate.
 * @param maxLength Maximum allowed output length (including suffix).
 * @returns The original string if within limit, or truncated string with `"..."`.
 */
export function truncateField(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  // [Constraint: US-SR-003] Truncate to maxLength-3 chars, then append "..."
  return value.slice(0, maxLength - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

// ---------------------------------------------------------------------------
// normalizeUrlForDedup
// ---------------------------------------------------------------------------

/**
 * Normalize a URL for lightweight intra-response deduplication by stripping
 * the fragment (hash) portion.
 *
 * This is a lightweight operation (string split on `'#'`) — comprehensive URL
 * normalization (tracking-param strip, scheme/port unification, query-param
 * sorting) is the responsibility of the deduplicate module.
 *
 * [Implements: US-SR-010]
 * [Constraint: DC-SR-002]
 *
 * @param url The URL string to normalize.
 * @returns The URL with its fragment stripped (e.g. `"page.html#sec"` → `"page.html"`).
 */
export function normalizeUrlForDedup(url: string): string {
  const hashIndex = url.indexOf('#');
  if (hashIndex >= 0) {
    return url.slice(0, hashIndex);
  }
  return url;
}

// ---------------------------------------------------------------------------
// normalizeScore
// ---------------------------------------------------------------------------

/**
 * Normalize result scores to the range `[0.0, 1.0]`.
 *
 * Decision logic:
 *   1. **Single result** → always assigned `1.0`.
 *   2. **At least one result has a non-null numeric score** → divide each score
 *      by the maximum score in the set (max becomes `1.0`). Null scores are
 *      treated as `0` for the division.
 *   3. **No results have scores** → assign positional rank:
 *      `score = 1.0 - (index / totalResults)`.
 *
 * Returns a new array; the input is not mutated.
 *
 * [Implements: US-SR-003]
 * [Constraint: DC-SR-002, NFR-SR-003]
 *
 * @param results Array of ParsedResult items with potentially-null scores.
 * @returns New array of ParsedResult items with concrete numeric scores.
 */
export function normalizeScore(results: ParsedResult[]): ParsedResult[] {
  const total = results.length;

  if (total === 0) {
    return [];
  }

  // [Implements: US-SR-003] Single result always receives score 1.0
  if (total === 1) {
    return [{ ...results[0]!, score: 1.0 }];
  }

  // Check if at least one result has a numeric score
  const hasScores = results.some((r) => r.score !== null && typeof r.score === 'number');

  if (hasScores) {
    // Find the maximum score among all results (null treated as 0)
    const maxScore = Math.max(...results.map((r) => r.score ?? 0));

    if (maxScore > 0) {
      // [Implements: US-SR-003] Normalize by dividing each score by max
      return results.map((r) => ({
        ...r,
        score: (r.score ?? 0) / maxScore,
      }));
    }
    // maxScore is 0 or negative — fall through to positional ranking
  }

  // [Implements: US-SR-003] No scores provided — assign positional rank
  return results.map((r, i) => ({
    ...r,
    score: 1.0 - (i / total),
  }));
}

// ---------------------------------------------------------------------------
// deduplicateByExactUrl
// ---------------------------------------------------------------------------

/**
 * Remove exact-URL duplicates from a set of SearchResults, retaining the
 * entry with the highest score for each unique URL.
 *
 * URL comparison is **case-sensitive** and **fragment-insensitive**: two URLs
 * that differ only in fragment (e.g. `"page.html#section1"` vs
 * `"page.html#section2"`) are treated as duplicates.
 *
 * When duplicate removal occurs, a message is logged to stderr:
 * `"Removed {N} exact-duplicate URLs from SearXNG response"`.
 *
 * This is lightweight intra-response dedup; comprehensive URL normalization
 * (tracking params, scheme, port, trailing slash) is the responsibility of the
 * deduplicate module.
 *
 * [Implements: US-SR-010]
 * [Constraint: DC-SR-002, NFR-SR-005]
 *
 * @param results Array of SearchResult items with normalized scores.
 * @returns New array with exact-URL duplicates removed.
 */
export function deduplicateByExactUrl(results: SearchResult[]): SearchResult[] {
  // [Constraint: US-SR-010] Map keyed by fragment-stripped URL (case-sensitive)
  const dedupMap = new Map<string, SearchResult>();

  for (const result of results) {
    const key = normalizeUrlForDedup(result.url);
    const existing = dedupMap.get(key);

    if (existing === undefined) {
      dedupMap.set(key, result);
    } else {
      // [Implements: US-SR-010] Retain entry with highest score
      if (result.score > existing.score) {
        dedupMap.set(key, result);
      }
    }
  }

  const deduped = Array.from(dedupMap.values());
  const removed = results.length - deduped.length;

  // [Implements: US-SR-010, NFR-SR-005] Log removal count to stderr only
  if (removed > 0) {
    process.stderr.write(
      `[SR] Removed ${removed} exact-duplicate URLs from SearXNG response\n`
    );
  }

  return deduped;
}

// ---------------------------------------------------------------------------
// normalizeResults
// ---------------------------------------------------------------------------

/**
 * Transform raw ParsedResult[] into final SearchResult[].
 *
 * Pipeline:
 *   1. **Score normalization** — compute concrete scores in `[0.0, 1.0]`.
 *   2. **Field defaults** — empty title → `"(untitled)"`, empty content → `""`.
 *   3. **Field truncation** — title capped at 500 chars (497 + `"..."`),
 *      snippet capped at 1000 chars (997 + `"..."`).
 *   4. **Exact-URL dedup** — remove fragment-insensitive URL duplicates,
 *      retaining highest-scored entry.
 *   5. **Sort** — descending by score.
 *   6. **Truncate** — keep at most `maxResults` items.
 *
 * Each step produces a new array, allowing intermediate data to be released
 * for garbage collection immediately (NFR-SR-003).
 *
 * [Implements: US-SR-003, US-SR-010, NFR-SR-003]
 * [Constraint: DC-SR-002, DC-SR-003]
 *
 * @param results    Parsed results from the response-parser.
 * @param maxResults Maximum number of results to return.
 * @returns Normalized, de-duplicated, sorted, and truncated SearchResult[].
 */
export function normalizeResults(
  results: ParsedResult[],
  maxResults: number
): SearchResult[] {
  if (results.length === 0) {
    return [];
  }

  // Step 1: Normalize scores — produces new ParsedResult[] with concrete scores.
  // (Intermediate array; original `results` reference released after this block.)
  const scored: ParsedResult[] = normalizeScore(results);

  // Step 2-3: Apply field defaults, truncation, and map ParsedResult → SearchResult.
  // (Intermediate array; `scored` reference released after this block.)
  const mapped: SearchResult[] = scored.map((r) => {
    // [Implements: US-SR-003] Title default: empty → "(untitled)"
    const rawTitle = r.title !== '' ? r.title : DEFAULT_TITLE;
    const title = truncateField(rawTitle, TITLE_MAX_LENGTH);

    // [Implements: US-SR-003] Snippet default: empty content → ""
    const snippet = truncateField(r.content, SNIPPET_MAX_LENGTH);

    return {
      title,
      url: r.url,
      snippet,
      score: r.score ?? 0,
    };
  });

  // Step 4: Deduplicate by exact URL (fragment-insensitive, retain highest score).
  // (Intermediate array; `mapped` reference released after this block.)
  const deduped: SearchResult[] = deduplicateByExactUrl(mapped);

  // Step 5: Sort by descending score.
  deduped.sort((a, b) => b.score - a.score);

  // Step 6: Truncate to maxResults.
  return deduped.slice(0, maxResults);
}
