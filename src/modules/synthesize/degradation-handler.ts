/**
 * Degradation handler — constructs a structurally valid DigestResult
 * WITHOUT calling the LLM, used as a fallback when synthesis fails.
 *
 * When triggered, this module builds a best-effort digest from the raw
 * content: the answer is a truncated concatenation of top-ranked content
 * (max 2000 chars), prefixed with an availability note. Key points are
 * first sentences of each content item. Sources include all input URLs
 * and titles.
 *
 * [Spec: US-SY-007, BG-SY-003, NFR-SY-002, NFR-SY-004, DC-SY-003]
 */

import type { DigestResult, SourceRef } from '../../shared/types/digest.js';
import type { ContentItem } from '../../shared/types/content.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Prefix prepended to the degradation answer to signal that LLM synthesis
 * was unavailable and the content is raw/truncated.
 *
 * [Constraint: DC-SY-003, US-SY-007]
 */
const DEGRADATION_PREFIX =
  '[Note: LLM synthesis unavailable; showing truncated raw content.]';

/**
 * Maximum number of characters allowed in the degradation answer, including
 * the prefix.
 *
 * [Constraint: US-SY-007]
 */
const MAX_DEGRADATION_ANSWER = 2000;

/**
 * Maximum number of key points to extract from the content items.
 *
 * [Constraint: US-SY-007]
 */
const MAX_KEY_POINTS = 10;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

// [Implements: US-SY-007]
/**
 * Extract the first sentence from a text string. A sentence is defined as
 * text up to and including the first period (`.`) that is followed by
 * whitespace or end-of-string. If no such period is found, the full trimmed
 * text is returned.
 *
 * @param text - The input text.
 * @returns The first sentence (trimmed), or the full text if no period found.
 *
 * [Spec: US-SY-007]
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '';
  }

  // Match text up to the first '.' followed by whitespace or end-of-string.
  const match = trimmed.match(/^([^.]*\.(?=\s|$))/);
  if (match !== null) {
    return match[1].trim();
  }

  // No period found — return the full text.
  return trimmed;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

// [Implements: US-SY-007, BG-SY-003, NFR-SY-002, NFR-SY-004]
/**
 * Construct a structurally valid `DigestResult` from raw content WITHOUT
 * calling the LLM. This is the degradation fallback used when all LLM
 * synthesis attempts have failed.
 *
 * The returned `DigestResult` is guaranteed to be structurally valid:
 * - `answer` is non-empty (at minimum contains the prefix + availability note)
 * - `sources` includes all input source URLs and titles
 *
 * @param query - The original search/fetch query (unused in content but
 *   available for context).
 * @param contents - The content items to build the fallback from.
 * @param reason - Human-readable reason for the degradation activation.
 * @returns A structurally valid `DigestResult`.
 *
 * [Spec: US-SY-007, NFR-SY-002, NFR-SY-004]
 * [Constraint: DC-SY-003]
 */
export function degradationFallback(
  _query: string,
  contents: ContentItem[],
  reason: string
): DigestResult {
  // [Implements: NFR-SY-004] Log degradation activation to stderr
  process.stderr.write(`[SY] degradation activated: ${reason}\n`);

  // [Implements: US-SY-007] Handle empty contents — return structurally valid
  // result with the prefix and an explicit "no content" note.
  if (contents.length === 0) {
    return {
      answer: `${DEGRADATION_PREFIX} No content available.`,
      keyPoints: [],
      sources: [],
    };
  }

  // [Implements: US-SY-007] Sort contents by descending score for ranking
  const sorted = [...contents].sort((a, b) => b.score - a.score);

  // [Implements: US-SY-007] Build answer: truncated concatenation of top-ranked
  // content, max MAX_DEGRADATION_ANSWER chars including prefix.
  const parts: string[] = [];
  let totalLength = DEGRADATION_PREFIX.length;

  for (const item of sorted) {
    // If we've already reached the limit, stop.
    if (totalLength >= MAX_DEGRADATION_ANSWER) {
      break;
    }

    const snippet = item.content.trim();
    if (snippet.length === 0) {
      continue;
    }

    // Account for separator between snippets (\n\n = 2 chars). For the first
    // snippet this is the separator between prefix and content; for subsequent
    // snippets this is the join separator.
    const separator = '\n\n';
    const remaining = MAX_DEGRADATION_ANSWER - totalLength - separator.length;

    if (remaining <= 0) {
      break;
    }

    if (snippet.length <= remaining) {
      parts.push(snippet);
      totalLength += separator.length + snippet.length;
    } else {
      // Truncate at the character boundary — find last word boundary if possible
      let truncated = snippet.slice(0, remaining);
      const lastSpace = truncated.lastIndexOf(' ');
      if (lastSpace > remaining * 0.5) {
        truncated = truncated.slice(0, lastSpace);
      }
      parts.push(truncated);
      totalLength = MAX_DEGRADATION_ANSWER;
      break;
    }
  }

  const answer = `${DEGRADATION_PREFIX}\n\n${parts.join('\n\n')}`;

  // [Implements: US-SY-007] Build keyPoints: first sentence of each content
  // item, max MAX_KEY_POINTS items.
  const keyPoints: string[] = [];
  for (const item of sorted.slice(0, MAX_KEY_POINTS)) {
    const sentence = firstSentence(item.content);
    if (sentence.length > 0) {
      keyPoints.push(sentence);
    }
  }

  // [Implements: US-SY-007] Build sources: all input source URLs and titles.
  const sources: SourceRef[] = contents.map((item) => ({
    url: item.url,
    title: item.title,
  }));

  return {
    answer,
    keyPoints,
    sources,
  };
}
