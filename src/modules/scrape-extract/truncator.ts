/**
 * Truncator — enforces MAX_CONTENT_CHARS with word-boundary preservation.
 *
 * Truncates extracted text at the nearest word boundary at or before
 * MAX_CONTENT_CHARS characters, appending the marker '…[truncated]'.
 * When maxChars is 0 or negative, truncation is disabled and a warning
 * is logged to stderr.
 *
 * [Spec: US-SC-008]
 */

import type { TruncationResult } from './types.js';

/** Marker appended to truncated content. */
const TRUNCATION_MARKER = '…[truncated]';

/**
 * Truncate text at the nearest word boundary at or before maxChars.
 *
 * Always preserves content from the beginning of the text (title +
 * first paragraphs) rather than from the middle.
 *
 * - If `maxChars <= 0`, truncation is disabled and a warning is logged.
 * - If `text.length <= maxChars`, the original text is returned unchanged.
 * - Otherwise the text is cut at the last whitespace at or before `maxChars`
 *   (falling back to a hard cut at `maxChars` when no whitespace is found)
 *   and the truncation marker is appended.
 *
 * [Implements: US-SC-008]
 * [Constraint: DC-SC-005, DC-SC-006]
 */
export function truncate(text: string, maxChars: number): TruncationResult {
  // [Implements: US-SC-008] When maxChars is 0 or negative, truncation is disabled.
  if (maxChars <= 0) {
    process.stderr.write(
      `[SC] WARN truncation disabled: maxChars=${maxChars}\n`
    );
    return { text, truncated: false };
  }

  // [Implements: US-SC-008] If text fits within the limit, no truncation needed.
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  // [Implements: US-SC-008] Search backwards from maxChars for the last
  // whitespace character at or before the limit to find a clean word boundary.
  // Falls back to a hard cut at maxChars when no whitespace is found.
  let cutIndex = maxChars;
  for (let i = maxChars; i >= 0; i--) {
    if (/\s/.test(text[i])) {
      cutIndex = i;
      break;
    }
  }

  // Trim trailing whitespace before appending the truncation marker.
  const truncatedText =
    text.slice(0, cutIndex).trimEnd() + TRUNCATION_MARKER;

  return { text: truncatedText, truncated: true };
}
