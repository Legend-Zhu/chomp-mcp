/**
 * Token Estimator — heuristic token counting with EN/CJK awareness.
 *
 * Estimates the token count of a text string using character-to-token
 * ratios that differ for English (~1 token per 4 characters) and CJK
 * content (~1 token per 1.5 characters). This pure function is used by
 * the synthesizer and batch-merger to decide between single-call and
 * batch-and-merge routing based on the model's context window.
 *
 * [Spec: US-SY-009, NFR-SY-005]
 */

/** Approximate characters per token for non-CJK (English/Latin) text. */
const ENGLISH_CHARS_PER_TOKEN = 4;

/** Approximate characters per token for CJK text. */
const CJK_CHARS_PER_TOKEN = 1.5;

// [Implements: US-SY-009]
/**
 * Determine whether a Unicode code point belongs to a CJK script.
 *
 * Covers:
 * - CJK Symbols and Punctuation (U+3000–U+303F)
 * - Hiragana (U+3040–U+309F)
 * - Katakana (U+30A0–U+30FF)
 * - CJK Unified Ideographs Extension A (U+3400–U+4DBF)
 * - CJK Unified Ideographs (U+4E00–U+9FFF)
 * - Hangul Jamo (U+1100–U+11FF)
 * - Hangul Syllables (U+AC00–U+D7AF)
 * - CJK Compatibility Ideographs (U+F900–U+FAFF)
 * - Halfwidth and Fullwidth Forms (U+FF00–U+FFEF)
 * - CJK Unified Ideographs Extensions B–F (U+20000–U+2FFFF)
 *
 * @param codePoint - The Unicode code point to test.
 * @returns `true` if the code point falls within any CJK range.
 *
 * [Spec: US-SY-009]
 */
export function isCJK(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ffff)
  );
}

// [Implements: US-SY-009, NFR-SY-005]
/**
 * Estimate the token count of a text string using a heuristic that
 * distinguishes CJK characters from English/Latin text.
 *
 * Token estimation ratios:
 * - CJK characters: ~1 token per 1.5 characters
 * - Non-CJK characters: ~1 token per 4 characters
 *
 * The estimate is the sum of CJK and non-CJK token contributions,
 * rounded up to the nearest integer. Empty or whitespace-only input
 * returns 0.
 *
 * @param text - The input string to estimate tokens for.
 * @returns Estimated token count (non-negative integer).
 *
 * [Spec: US-SY-009]
 * [Constraint: NFR-SY-005]
 */
export function estimateTokens(text: string): number {
  // Return 0 for empty or whitespace-only input.
  if (text.trim().length === 0) {
    return 0;
  }

  let cjkChars = 0;
  let nonCjkChars = 0;

  // for...of iterates by code point, correctly handling surrogate pairs
  // for supplementary-plane CJK characters (e.g., Extension B+).
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isCJK(codePoint)) {
      cjkChars++;
    } else {
      nonCjkChars++;
    }
  }

  // Calculate: cjkChars / 1.5 + nonCjkChars / 4, rounded up.
  const estimate = Math.ceil(
    cjkChars / CJK_CHARS_PER_TOKEN + nonCjkChars / ENGLISH_CHARS_PER_TOKEN
  );

  return estimate;
}

// [Implements: US-SY-009, NFR-SY-005]
/**
 * Estimate tokens for a text and log the result with the safe threshold
 * to stderr for diagnostics.
 *
 * The threshold is computed as `maxContextTokens * safeThresholdRatio`
 * (floored). When the estimate is within the threshold (≤), callers
 * should use a single LLM call; when it exceeds the threshold, callers
 * should route to the batch-and-merge flow.
 *
 * @param text - The input string to estimate tokens for.
 * @param maxContextTokens - The model's maximum context window in tokens.
 * @param safeThresholdRatio - Fraction of maxContextTokens considered safe
 *   (e.g., `0.8` for 80%).
 * @returns Estimated token count (non-negative integer).
 *
 * [Spec: US-SY-009]
 * [Constraint: NFR-SY-005]
 */
export function estimateAndLogTokens(
  text: string,
  maxContextTokens: number,
  safeThresholdRatio: number
): number {
  const estimated = estimateTokens(text);
  const threshold = Math.floor(maxContextTokens * safeThresholdRatio);

  process.stderr.write(
    `[SY] estimated tokens: ${estimated} (threshold: ${threshold})\n`
  );

  return estimated;
}
