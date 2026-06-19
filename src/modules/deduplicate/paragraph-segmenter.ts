/**
 * Paragraph segmenter — splits text content into meaningful paragraph segments.
 *
 * Splits at boundaries of 2+ consecutive newlines as well as HTML-style break
 * and paragraph tags (<br>, <br/>, <br />, </p>, </div>). Discards segments
 * shorter than the configured minimum character threshold. Returns trimmed,
 * internal-whitespace-collapsed paragraph strings ready for fingerprinting.
 *
 * [Spec: US-DD-004, NFR-DD-005, DC-DD-005]
 */

import { MIN_PARAGRAPH_CHARS_DEFAULT } from './types.js';

/**
 * Regex to match HTML-style paragraph boundary tags: <br>, <br/>, <br />,
 * </p>, and </div>. Case-insensitive. Whitespace inside the tag (e.g.
 * <br /> or <br  />) is tolerated.
 */
const HTML_BOUNDARY_RE = /<(?:br\s*\/?|\/p|\/div)>/gi;

/**
 * Regex to detect two or more consecutive newline characters.
 */
const MULTI_NEWLINE_RE = /\n{2,}/;

/**
 * Regex to collapse all consecutive whitespace characters (spaces, tabs,
 * newlines, etc.) into a single space.
 */
const WHITESPACE_COLLAPSE_RE = /\s+/g;

/**
 * Split text content into meaningful paragraph segments.
 *
 * The splitting process:
 *   1. If `text` is falsy or contains only whitespace, return an empty array.
 *   2. Replace HTML break/paragraph/div tags with newlines (case-insensitive).
 *   3. Normalize `\r\n` and `\r` to `\n` so cross-platform line endings are
 *      handled uniformly.
 *   4. Split on boundaries of 2 or more consecutive newlines.
 *   5. For each raw segment, collapse internal whitespace to single spaces and
 *      trim leading/trailing whitespace.
 *   6. Discard segments whose final length is below `minChars`.
 *
 * @param text Raw text content to segment.
 * @param minChars Minimum character count for a segment to be retained.
 *                 Defaults to `MIN_PARAGRAPH_CHARS_DEFAULT` (20) when not
 *                 provided or invalid.
 * @returns Array of cleaned, trimmed paragraph strings. Empty array for
 *          empty or whitespace-only input.
 *
 * [Implements: US-DD-004, NFR-DD-005]
 * [Constraint: DC-DD-005]
 */
export function segmentParagraphs(
  text: string,
  minChars: number = MIN_PARAGRAPH_CHARS_DEFAULT
): string[] {
  // [Implements: US-DD-004] Empty, null, or whitespace-only text produces zero segments.
  if (!text || text.trim().length === 0) {
    return [];
  }

  // [Constraint: DC-DD-005] Guard against invalid minChars — use default.
  const threshold: number =
    typeof minChars === 'number' && minChars >= 1 ? minChars : MIN_PARAGRAPH_CHARS_DEFAULT;

  // [Implements: US-DD-004] Replace HTML break/paragraph/div tags with newlines.
  const htmlReplaced: string = text.replace(HTML_BOUNDARY_RE, '\n');

  // [Implements: US-DD-004] Normalize \r\n and \r to \n for cross-platform handling.
  const normalized: string = htmlReplaced.replace(/\r\n?/g, '\n');

  // [Implements: US-DD-004] Split on 2+ consecutive newlines.
  const rawSegments: string[] = normalized.split(MULTI_NEWLINE_RE);

  const results: string[] = [];

  for (const raw of rawSegments) {
    // [Implements: US-DD-004] Collapse internal whitespace to a single space and trim.
    const cleaned: string = raw.replace(WHITESPACE_COLLAPSE_RE, ' ').trim();

    // [Implements: US-DD-004] Discard segments shorter than minChars.
    if (cleaned.length >= threshold) {
      results.push(cleaned);
    }
  }

  return results;
}
