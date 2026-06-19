/**
 * Fingerprinter — FNV-1a 32-bit hashing and fingerprint set computation.
 *
 * Provides the content fingerprinting primitives used during content-level
 * deduplication:
 *
 * - `FNV_OFFSET_32` / `FNV_PRIME_32`: FNV-1a constants for 32-bit hashing.
 * - `fnv1a32(text)`: non-cryptographic 32-bit hash of a string. Uses
 *   `Math.imul` for correct 32-bit multiplication and `>>> 0` for unsigned
 *   conversion, guaranteeing deterministic results for identical inputs.
 * - `computeFingerprintSet(content, minChars)`: segments content into
 *   paragraphs (via `segmentParagraphs`), normalizes each paragraph
 *   (trim, collapse whitespace, lowercase), hashes each, and collects
 *   unique hashes into a `Set<number>`.
 *
 * [Spec: US-DD-005, DC-DD-002, NFR-DD-005]
 */

import { segmentParagraphs } from './paragraph-segmenter.js';
import { MIN_PARAGRAPH_CHARS_DEFAULT } from './types.js';

/**
 * FNV-1a offset basis for 32-bit hashing.
 *
 * [Constraint: DC-DD-002]
 */
export const FNV_OFFSET_32 = 2166136261;

/**
 * FNV-1a prime multiplier for 32-bit hashing.
 *
 * [Constraint: DC-DD-002]
 */
export const FNV_PRIME_32 = 16777619;

// [Implements: US-DD-005]
/**
 * Compute the FNV-1a 32-bit non-cryptographic hash of a string.
 *
 * The FNV-1a algorithm processes each character of `text` in order:
 *   1. XOR the current hash with the character's code unit.
 *   2. Multiply by the FNV prime using `Math.imul` (correct 32-bit wrap-around).
 *
 * The final hash is converted to an unsigned 32-bit integer via `>>> 0`.
 *
 * Two identical input strings always produce the same hash value.
 *
 * @param text The string to hash.
 * @returns An unsigned 32-bit integer hash.
 *
 * [Implements: US-DD-005]
 * [Constraint: DC-DD-002, NFR-DD-005]
 */
export function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_32;

  for (let i = 0; i < text.length; i++) {
    // [Implements: US-DD-005] XOR with byte, then multiply by prime
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME_32);
  }

  // [Implements: US-DD-005] Convert to unsigned 32-bit integer
  return hash >>> 0;
}

// [Implements: US-DD-005]
/**
 * Compute a deduplicated set of paragraph fingerprints from content text.
 *
 * The computation process:
 *   1. Segment `content` into meaningful paragraphs via `segmentParagraphs`
 *      (splits at 2+ newlines / HTML break tags, discards short segments).
 *   2. For each paragraph segment, normalize the text:
 *      - Trim leading/trailing whitespace.
 *      - Collapse internal whitespace runs to single spaces.
 *      - Convert to lowercase.
 *   3. Hash each normalized paragraph with `fnv1a32`.
 *   4. Collect all hashes into a `Set<number>`, automatically deduplicating
 *      identical paragraphs.
 *
 * The resulting set represents the article's content fingerprint for
 * downstream Jaccard similarity comparison.
 *
 * @param content The raw text content to fingerprint.
 * @param minChars Minimum character count for a paragraph to be eligible.
 *                 Defaults to `MIN_PARAGRAPH_CHARS_DEFAULT` (20).
 * @returns A `Set<number>` of unique 32-bit fingerprint hashes.
 *
 * [Implements: US-DD-005]
 * [Constraint: DC-DD-002, NFR-DD-005]
 */
export function computeFingerprintSet(
  content: string,
  minChars: number = MIN_PARAGRAPH_CHARS_DEFAULT
): Set<number> {
  // [Implements: US-DD-005] Segment content into paragraphs
  const segments = segmentParagraphs(content, minChars);

  const fingerprints = new Set<number>();

  for (const segment of segments) {
    // [Implements: US-DD-005] Normalize: trim, collapse whitespace, lowercase
    const normalized = segment.trim().replace(/\s+/g, ' ').toLowerCase();

    // [Implements: US-DD-005] Hash the normalized paragraph
    const fp = fnv1a32(normalized);

    // [Implements: US-DD-005] Collect unique hashes (Set deduplicates)
    fingerprints.add(fp);
  }

  return fingerprints;
}
