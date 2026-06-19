/**
 * URL normalizer — canonical URL form with tracking-param stripping.
 *
 * Uses the WHATWG URL constructor for safe parsing (NFR-DD-006). Applies a
 * series of deterministic transformations to produce a canonical URL string
 * suitable for exact-URL deduplication:
 *
 * - Convert `http:` scheme to `https:`
 * - Lowercase hostname
 * - Remove fragment identifier
 * - Remove default ports (80 for http, 443 for https)
 * - Remove trailing slash when path length > 1
 * - Strip tracking parameters (built-in blocklist + caller-provided extras)
 * - Sort remaining query parameters alphabetically by key
 *
 * Percent-encoding in the path is preserved without double-decoding.
 *
 * [Spec: US-DD-001, US-DD-002, DC-DD-006, NFR-DD-006]
 */

/**
 * Built-in blocklist of tracking parameter names to strip during URL
 * normalization. These are common analytics/marketing tracking parameters
 * that do not affect the canonical content of a page.
 *
 * Matching is case-insensitive — e.g. `UTM_SOURCE` is also removed.
 *
 * [Constraint: DC-DD-006, US-DD-002]
 */
export const TRACKING_PARAM_BLOCKLIST: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
  '_hsenc',
  '_hsmi',
  'igshid',
  'si',
];

/**
 * Normalize a URL to its canonical form.
 *
 * Applies the following transformations in order:
 * 1. Convert `http:` scheme to `https:`
 * 2. Lowercase the hostname
 * 3. Remove any fragment identifier (`#section`)
 * 4. Remove default ports (80 for http, 443 for https)
 * 5. Remove trailing slash when path length > 1
 * 6. Strip tracking parameters (built-in blocklist + caller-provided extras,
 *    case-insensitive match)
 * 7. Sort remaining query parameters alphabetically by key
 *
 * The WHATWG URL constructor throws `TypeError` for malformed input.
 * The caller is responsible for catching this error.
 *
 * Percent-encoding in the path is preserved without double-decoding or
 * re-encoding — the URL constructor and pathname getter/setter round-trip
 * already-encoded sequences verbatim.
 *
 * @param rawUrl The raw URL string to normalize.
 * @param extraTrackingParams Additional tracking parameter names to strip
 *   beyond the built-in blocklist (case-insensitive, merged with blocklist).
 * @returns The canonical normalized URL string.
 * @throws TypeError if `rawUrl` is not a valid URL (caller must catch).
 *
 * [Implements: US-DD-001, US-DD-002, DC-DD-006, NFR-DD-006]
 */
export function normalizeUrl(
  rawUrl: string,
  extraTrackingParams?: string[]
): string {
  // [Constraint: NFR-DD-006] Use the WHATWG URL constructor for safe parsing.
  // Throws TypeError for malformed input — the caller catches this.
  const url = new URL(rawUrl);

  // [Implements: US-DD-002] Convert http → https
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
  }

  // [Implements: US-DD-002] Lowercase hostname
  url.hostname = url.hostname.toLowerCase();

  // [Implements: US-DD-002] Remove fragment identifier
  url.hash = '';

  // [Implements: US-DD-002] Remove default ports (80 for http, 443 for https)
  if (url.port !== '') {
    const isDefaultPort =
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443');
    if (isDefaultPort) {
      url.port = '';
    }
  }

  // [Implements: US-DD-002] Remove trailing slash when path length > 1.
  // Preserves percent-encoding in the path — only the trailing '/' character
  // is removed, the rest of the pathname is left intact.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  // [Implements: US-DD-001, DC-DD-006] Build merged blocklist (case-insensitive)
  const blocklist = new Set<string>();
  for (const param of TRACKING_PARAM_BLOCKLIST) {
    blocklist.add(param.toLowerCase());
  }
  if (extraTrackingParams !== undefined) {
    for (const param of extraTrackingParams) {
      blocklist.add(param.toLowerCase());
    }
  }

  // [Implements: US-DD-001] Collect non-tracking params, sort by key alphabetically
  const remaining: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    if (!blocklist.has(key.toLowerCase())) {
      remaining.push([key, value]);
    }
  }
  // Stable sort by key in ASCII/lexicographic order (alphabetical)
  remaining.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  // Clear existing search and rebuild with sorted non-tracking params.
  // If all params were tracking params, search remains empty (no trailing '?').
  url.search = '';
  for (const [key, value] of remaining) {
    url.searchParams.append(key, value);
  }

  // [Implements: US-DD-001] Produce final output, strip trailing '?' if present.
  // When url.search is empty, toString() should not emit '?', but we guard
  // against any edge cases.
  let result = url.toString();
  if (result.endsWith('?')) {
    result = result.slice(0, -1);
  }

  return result;
}
