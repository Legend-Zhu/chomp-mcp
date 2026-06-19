/**
 * SearXNG response parser — JSON validation, malformed-entry skipping, and
 * non-JSON detection.
 *
 * This module transforms a raw HTTP response from SearXNG into a validated
 * ParseOutput containing ParsedResult[] (one entry per valid result) and a
 * count of malformed entries that were skipped.
 *
 * Parsing strategy:
 *   1. Detect whether the response is JSON by checking the Content-Type header.
 *      If the header does not include `application/json`, inspect the body
 *      prefix for `{` or `[` to detect JSON regardless of header.
 *   2. JSON.parse the body. If parsing fails, throw SearchParseError with a
 *      diagnostic message including the Content-Type and first 200 chars.
 *   3. Extract the top-level `results` array. If absent or not an array, return
 *      an empty results list (valid response, just no results).
 *   4. For each entry in the array, type-narrow the `url` field via the WHATWG
 *      URL constructor. Entries with missing or invalid URLs are skipped and
 *      counted in `skippedMalformed`. Valid entries have `title`, `content`,
 *      and `score` extracted.
 *   5. When the final results array is empty (whether from missing `results`
 *      key, empty array, or all-malformed), log a stderr message with the query.
 *
 * [Spec: US-SR-002, US-SR-008, US-SR-009, NFR-SR-004]
 */

import type { ParsedResult, ParseOutput } from './result-normalizer.js';
import { SearchParseError } from './errors.js';

// ---------------------------------------------------------------------------
// SearXNGFetchResult — input shape for parseResponse
// ---------------------------------------------------------------------------

/**
 * The raw HTTP response data from a SearXNG fetch, simplified for the parser.
 *
 * [Spec: DC-SR-002]
 */
export interface SearXNGFetchResult {
  /** HTTP response status code. */
  status: number;
  /** Response body as a UTF-8 string for JSON parsing or non-JSON diagnostics. */
  body: string;
  /** Value of the Content-Type response header, or `null` if absent. */
  contentType: string | null;
  /** Parsed Retry-After header in ms (only for HTTP 429); `null` otherwise. */
  retryAfterMs: number | null;
}

// ---------------------------------------------------------------------------
// SearXNGRawResult — untyped shape of a single SearXNG result object
// ---------------------------------------------------------------------------

/**
 * Untyped representation of a single result object from the SearXNG
 * `results` array. All fields are `unknown` because SearXNG responses are
 * loosely typed — the parser type-narrows each field before use.
 *
 * [Spec: DC-SR-002]
 */
export interface SearXNGRawResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  score?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of body characters included in a SearchParseError message. */
const BODY_EXCERPT_LENGTH = 200;

// ---------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------

// [Implements: US-SR-002]
/**
 * Validate that a raw value is a string containing a parseable URI.
 *
 * Coerces the value to a string (if it is not already one, returns `null`),
 * then validates it using the WHATWG `URL` constructor. A valid URL must have
 * both a protocol and a hostname.
 *
 * @param rawUrl - The raw (untyped) URL value from a SearXNG result object.
 * @returns The validated URL string, or `null` if the value is not a string or
 *          does not parse as a valid URI.
 *
 * [Implements: US-SR-002, US-SR-008]
 */
export function validateUrl(rawUrl: unknown): string | null {
  // [Constraint: US-SR-008] Must be a string
  if (typeof rawUrl !== 'string') {
    return null;
  }

  // [Constraint: US-SR-002] Validate with WHATWG URL constructor
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  // Reject URLs that lack a protocol or hostname (e.g. "not-a-url")
  if (!parsed.protocol || !parsed.hostname) {
    return null;
  }

  return rawUrl;
}

// ---------------------------------------------------------------------------
// extractFields
// ---------------------------------------------------------------------------

// [Implements: US-SR-002, US-SR-008]
/**
 * Type-narrow and extract fields from a single raw SearXNG result object.
 *
 * Validates the `url` field via {@link validateUrl}. If the URL is missing or
 * invalid, returns `null` (caller increments `skippedMalformed`).
 *
 * For valid URLs, narrows `title` and `content` to strings (defaulting to
 * empty string if absent or non-string) and `score` to a number or `null`.
 *
 * @param rawResult - The untyped SearXNG result object.
 * @returns A ParsedResult if the URL is valid, or `null` if malformed.
 *
 * [Implements: US-SR-002, US-SR-008]
 */
export function extractFields(rawResult: SearXNGRawResult): ParsedResult | null {
  // [Constraint: US-SR-008] URL must be present and valid
  const url = validateUrl(rawResult.url);
  if (url === null) {
    return null;
  }

  // [Implements: US-SR-002] Extract title (default empty string)
  const title = typeof rawResult.title === 'string' ? rawResult.title : '';

  // [Implements: US-SR-002] Extract content/snippet (default empty string)
  const content = typeof rawResult.content === 'string' ? rawResult.content : '';

  // [Implements: US-SR-002] Extract score (null if absent or non-numeric)
  let score: number | null = null;
  if (typeof rawResult.score === 'number' && Number.isFinite(rawResult.score)) {
    score = rawResult.score;
  }

  return { title, url, content, score };
}

// ---------------------------------------------------------------------------
// parseResponse
// ---------------------------------------------------------------------------

// [Implements: US-SR-002, US-SR-008, US-SR-009, NFR-SR-004]
/**
 * Parse a SearXNG HTTP response into a validated ParseOutput.
 *
 * Steps:
 *   1. Detect JSON via Content-Type header or body prefix (`{` / `[`).
 *   2. JSON.parse the body. On failure, throw SearchParseError with
 *      Content-Type and first 200 chars of body for diagnostics.
 *   3. Extract the `results` array. If missing or not an array, return empty.
 *   4. Iterate results, calling extractFields. Skip malformed entries,
 *      counting them in `skippedMalformed`.
 *   5. If the final results array is empty, log a stderr message with the query.
 *
 * An empty result set (zero valid results) is NOT an error — it is a valid
 * response. Downstream "no results" handling is the responsibility of the
 * orchestration layer, not this module.
 *
 * @param fetchResult - The raw SearXNG HTTP response.
 * @param query       - The search query (used only for empty-result logging).
 * @returns A ParseOutput with validated results and a malformed-skip count.
 * @throws {SearchParseError} When the body cannot be parsed as valid JSON.
 *
 * [Implements: US-SR-002, US-SR-008, US-SR-009, NFR-SR-004]
 */
export function parseResponse(
  fetchResult: SearXNGFetchResult,
  query: string
): ParseOutput {
  const contentType = fetchResult.contentType;
  const body = fetchResult.body;

  // -----------------------------------------------------------------------
  // Step 1: Detect whether the response is JSON
  // -----------------------------------------------------------------------

  // [Implements: US-SR-009] Check Content-Type header for application/json
  const contentTypeIsJson =
    contentType !== null && contentType.toLowerCase().includes('application/json');

  // [Implements: US-SR-009] If header does not indicate JSON, check body prefix
  let bodyLooksLikeJson = false;
  if (body.length > 0) {
    const firstNonWhitespace = body.trimStart()[0];
    bodyLooksLikeJson = firstNonWhitespace === '{' || firstNonWhitespace === '[';
  }

  // If neither the header nor the body suggests JSON, throw a diagnostic error
  if (!contentTypeIsJson && !bodyLooksLikeJson) {
    const excerpt = body.slice(0, BODY_EXCERPT_LENGTH);
    throw new SearchParseError(
      `SearXNG returned non-JSON response (Content-Type: ${contentType ?? 'null'}). Ensure the instance supports format=json.`,
      excerpt
    );
  }

  // -----------------------------------------------------------------------
  // Step 2: JSON.parse the body
  // -----------------------------------------------------------------------

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    // [Implements: US-SR-002] Invalid JSON syntax — throw with diagnostic
    // [Implements: US-SR-009] Include first 200 chars of body for HTML responses
    const excerpt = body.slice(0, BODY_EXCERPT_LENGTH);
    throw new SearchParseError(
      `Failed to parse SearXNG response as JSON`,
      excerpt
    );
  }

  // -----------------------------------------------------------------------
  // Step 3: Extract the top-level `results` array
  // -----------------------------------------------------------------------

  // [Implements: US-SR-002] Missing or non-array results → treat as zero results
  let resultsArray: SearXNGRawResult[];
  if (
    parsedBody !== null &&
    typeof parsedBody === 'object' &&
    !Array.isArray(parsedBody) &&
    Array.isArray((parsedBody as Record<string, unknown>).results)
  ) {
    resultsArray = (parsedBody as { results: SearXNGRawResult[] }).results;
  } else {
    // `results` key missing or not an array — return empty (valid, just no results)
    resultsArray = [];
  }

  // -----------------------------------------------------------------------
  // Step 4: Iterate results, extract fields, skip malformed
  // -----------------------------------------------------------------------

  const results: ParsedResult[] = [];
  let skippedMalformed = 0;

  for (const rawResult of resultsArray) {
    // Skip non-object entries (e.g. null, string, number in the array)
    if (
      rawResult === null ||
      typeof rawResult !== 'object' ||
      Array.isArray(rawResult)
    ) {
      // [Constraint: US-SR-008] Skip malformed entries
      skippedMalformed++;
      continue;
    }

    const extracted = extractFields(rawResult as SearXNGRawResult);

    if (extracted === null) {
      // [Implements: US-SR-008] Missing or invalid URL — skip and count
      skippedMalformed++;
    } else {
      results.push(extracted);
    }
  }

  // -----------------------------------------------------------------------
  // Step 5: Log empty results to stderr (not an error)
  // -----------------------------------------------------------------------

  // [Implements: US-SR-002] Zero results from a successful response is valid
  if (results.length === 0) {
    process.stderr.write(
      `[SR] SearXNG returned 0 results for query: ${query}\n`
    );
  }

  return { results, skippedMalformed };
}
