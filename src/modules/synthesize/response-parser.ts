/**
 * Response Parser — multi-strategy LLM response parsing and source reconciliation.
 *
 * Parses raw LLM text responses into structured ParsedDigest objects using a
 * two-strategy approach:
 *   Strategy 1: Markdown header detection (## Answer, ## Key Points, ## Sources)
 *   Strategy 2: Heuristic keyword proximity (Answer:, Key Points:, Sources:)
 *
 * Also provides source reconciliation to ensure all known input sources are
 * represented in the final result.
 *
 * [Spec: US-SY-008, US-SY-003, NFR-SY-004]
 */

import type { SourceRef } from '../../shared/types/digest.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Internal representation of a parsed LLM response, before conversion to
 * DigestResult by the synthesizer.
 */
export interface ParsedDigest {
  /** Synthesized answer text. May be empty if the LLM produced no recognizable answer. */
  answer: string;
  /** Array of individual key point strings (may be empty). */
  keyPoints: string[];
  /** Array of source references extracted from the LLM response. */
  sources: SourceRef[];
}

/**
 * Intermediate section container — each field is the raw text extracted for
 * that section, or null if the section was not found.
 */
interface Sections {
  answer: string | null;
  keyPoints: string | null;
  sources: string | null;
}

type SectionName = 'answer' | 'keyPoints' | 'sources';

// ---------------------------------------------------------------------------
// URL extraction helpers
// ---------------------------------------------------------------------------

/**
 * Regex for extracting URLs from text. Matches http/https URLs, stopping at
 * whitespace, angle brackets, or quote characters.
 */
const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

/**
 * Clean trailing punctuation from a URL that is unlikely to be part of the
 * actual URL (e.g., trailing periods, commas, or unmatched closing parens).
 */
function cleanUrl(url: string): string {
  let cleaned = url;
  // Only strip trailing ) if there is no matching ( in the URL
  if (cleaned.endsWith(')') && !cleaned.includes('(')) {
    cleaned = cleaned.slice(0, -1);
  }
  cleaned = cleaned.replace(/[.,;:!]+$/, '');
  return cleaned;
}

/**
 * Strip bullet markers, markdown formatting, and trailing delimiters from a
 * title string.
 */
function cleanTitle(text: string): string {
  let cleaned = text.trim();
  // Strip leading bullet markers: -, *, •, or numbered (1., 2., etc.)
  cleaned = cleaned.replace(/^[-*•]\s*/, '');
  cleaned = cleaned.replace(/^\d+[.)]\s*/, '');
  // Strip markdown bold/italic markers
  cleaned = cleaned.replace(/^\*{1,2}/, '').replace(/\*{1,2}$/, '');
  // Strip trailing delimiters
  cleaned = cleaned.replace(/[:\-–—,;]+$/, '');
  return cleaned.trim();
}

// ---------------------------------------------------------------------------
// Key Points parsing
// ---------------------------------------------------------------------------

// [Implements: US-SY-008]
/**
 * Parse the "Key Points" section text into an array of individual point
 * strings.
 *
 * Splits the section text by newlines, filters lines that start with bullet
 * markers (`-`, `*`, `•`) or numbered items (`1.`, `2.`), strips the markers,
 * trims whitespace, and returns the resulting strings.
 *
 * Lines that do not start with a bullet marker are ignored.
 *
 * @param sectionText - The raw text of the "Key Points" section.
 * @returns Array of individual key point strings (may be empty).
 *
 * [Spec: US-SY-008]
 */
export function parseKeyPoints(sectionText: string): string[] {
  const lines = sectionText.split('\n');
  const points: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if line starts with a bullet marker: -, *, •, or numbered (N.)
    if (/^[-*•]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      const point = trimmed
        .replace(/^[-*•]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .trim();
      if (point) {
        points.push(point);
      }
    }
  }

  return points;
}

// ---------------------------------------------------------------------------
// Sources parsing
// ---------------------------------------------------------------------------

// [Implements: US-SY-008]
/**
 * Extract sources from the "Sources" section text.
 *
 * Scans each line for URLs using a URL regex pattern. For each URL, the title
 * is derived from:
 *   1. Text on the same line preceding the first URL (after stripping bullet
 *      markers and delimiters), or
 *   2. The nearest preceding non-URL line's text, or
 *   3. The URL itself as a fallback.
 *
 * Sources are deduplicated by URL.
 *
 * @param sectionText - The raw text of the "Sources" section.
 * @returns Array of SourceRef objects (may be empty).
 *
 * [Spec: US-SY-008]
 */
export function parseSources(sectionText: string): SourceRef[] {
  const lines = sectionText.split('\n');
  const sources: SourceRef[] = [];
  let lastTitle = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Find all URLs on this line with their positions
    const re = new RegExp(URL_REGEX.source, 'g');
    let match: RegExpExecArray | null;
    const found: { url: string; index: number }[] = [];

    while ((match = re.exec(trimmed)) !== null) {
      found.push({ url: cleanUrl(match[0]), index: match.index });
    }

    if (found.length > 0) {
      // Title is the text before the first URL on this line
      const beforeFirstUrl = trimmed.substring(0, found[0].index);
      const lineTitle = cleanTitle(beforeFirstUrl) || lastTitle;

      for (const { url } of found) {
        sources.push({ url, title: lineTitle || url });
      }
    } else {
      // No URL on this line — store as potential title for subsequent URLs
      const cleaned = cleanTitle(trimmed);
      if (cleaned) {
        lastTitle = cleaned;
      }
    }
  }

  // Deduplicate sources by URL
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Strategy 1: Markdown header parsing
// ---------------------------------------------------------------------------

/**
 * Markdown header detection patterns. Matches lines like `## Answer`,
 * `### Key Points`, `# Sources`, etc.
 */
const MARKDOWN_HEADER_PATTERNS: { name: SectionName; re: RegExp }[] = [
  { name: 'answer', re: /^#{1,3}\s+Answer\b/i },
  { name: 'keyPoints', re: /^#{1,3}\s+Key\s*Points?\b/i },
  { name: 'sources', re: /^#{1,3}\s+Sources?\b/i },
];

// [Implements: US-SY-008]
/**
 * Strategy 1 — parse the LLM response by detecting markdown section headers.
 *
 * Scans each line for markdown headers (`#`, `##`, or `###`) followed by
 * "Answer", "Key Points", or "Sources". The content of each section is the
 * text between that header and the next detected header (or end of text).
 *
 * @param rawResponse - The raw LLM response text.
 * @returns Sections object with extracted text for each section, or null if
 *   the section was not found.
 *
 * [Spec: US-SY-008]
 */
export function parseMarkdownHeaders(rawResponse: string): Sections {
  const lines = rawResponse.split('\n');
  const markers: { name: SectionName; lineIndex: number }[] = [];
  const found = new Set<SectionName>();

  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of MARKDOWN_HEADER_PATTERNS) {
      if (found.has(name)) continue;
      if (re.test(lines[i])) {
        found.add(name);
        markers.push({ name, lineIndex: i });
        break;
      }
    }
  }

  if (markers.length === 0) {
    return { answer: null, keyPoints: null, sources: null };
  }

  // Sort markers by line index for sequential extraction
  markers.sort((a, b) => a.lineIndex - b.lineIndex);

  const result: Sections = { answer: null, keyPoints: null, sources: null };

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].lineIndex + 1;
    const end = i + 1 < markers.length ? markers[i + 1].lineIndex : lines.length;
    const content = lines.slice(start, end).join('\n').trim();

    result[markers[i].name] = content || null;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Strategy 2: Heuristic keyword proximity
// ---------------------------------------------------------------------------

/**
 * Heuristic keyword detection patterns. Matches lines where a section keyword
 * appears at the start (optionally with markdown bold/italic and a delimiter).
 */
const HEURISTIC_KEYWORD_PATTERNS: { name: SectionName; re: RegExp }[] = [
  { name: 'answer', re: /^[ \t]*(?:\*{1,2})?[ \t]*Answer(?:\*{1,2})?[ \t]*[:\-–—]?[ \t]*/i },
  { name: 'keyPoints', re: /^[ \t]*(?:\*{1,2})?[ \t]*Key[ \t]*Points?(?:\*{1,2})?[ \t]*[:\-–—]?[ \t]*/i },
  { name: 'sources', re: /^[ \t]*(?:\*{1,2})?[ \t]*Sources?(?:\*{1,2})?[ \t]*[:\-–—]?[ \t]*/i },
];

// [Implements: US-SY-008]
/**
 * Strategy 2 — parse the LLM response using heuristic keyword proximity
 * detection.
 *
 * Falls back to this strategy when markdown headers are not found. Searches
 * for lines beginning with section keywords ("Answer", "Key Points",
 * "Sources") optionally followed by markdown formatting and a delimiter
 * (`:`, `-`, `–`, `—`).
 *
 * For each detected keyword, the section content includes:
 *   - Any text on the same line after the keyword and delimiter (inline content)
 *   - All subsequent lines until the next keyword or end of text
 *
 * @param rawResponse - The raw LLM response text.
 * @returns Sections object with extracted text for each section, or null if
 *   the section was not found.
 *
 * [Spec: US-SY-008]
 */
export function heuristicKeywordProximity(rawResponse: string): Sections {
  const lines = rawResponse.split('\n');
  const markers: { name: SectionName; lineIndex: number; keywordEnd: number }[] = [];
  const found = new Set<SectionName>();

  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of HEURISTIC_KEYWORD_PATTERNS) {
      if (found.has(name)) continue;
      const m = re.exec(lines[i]);
      if (m) {
        found.add(name);
        markers.push({
          name,
          lineIndex: i,
          keywordEnd: m.index + m[0].length,
        });
        break;
      }
    }
  }

  if (markers.length === 0) {
    return { answer: null, keyPoints: null, sources: null };
  }

  // Sort markers by line index for sequential extraction
  markers.sort((a, b) => a.lineIndex - b.lineIndex);

  const result: Sections = { answer: null, keyPoints: null, sources: null };

  for (let i = 0; i < markers.length; i++) {
    const { lineIndex, keywordEnd } = markers[i];
    const nextLineIdx = i + 1 < markers.length ? markers[i + 1].lineIndex : lines.length;

    // Inline content on the header line (after the keyword and delimiter)
    const inline = lines[lineIndex].substring(keywordEnd).trim();

    // Content from subsequent lines until the next keyword
    const subsequent = lines.slice(lineIndex + 1, nextLineIdx).join('\n').trim();

    // Combine inline and subsequent content
    const content = [inline, subsequent].filter((s) => s.length > 0).join('\n');

    result[markers[i].name] = content || null;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

// [Implements: US-SY-008, US-SY-003]
/**
 * Parse a raw LLM response into a structured ParsedDigest using a
 * multi-strategy approach.
 *
 * Parsing flow:
 *   1. Attempt Strategy 1 (markdown headers: ## Answer, ## Key Points, ## Sources)
 *   2. If no Answer section is found, attempt Strategy 2 (heuristic keyword proximity)
 *   3. If still no Answer section, treat the entire response as the answer
 *      and set keyPoints to an empty array
 *
 * Key Points are parsed by splitting bullet items (lines starting with `-`,
 * `*`, or numbered items) into individual strings.
 *
 * Sources are parsed by extracting URLs via regex and pairing each with the
 * nearest preceding title text.
 *
 * @param rawResponse - The raw text content from the LLM response.
 * @returns ParsedDigest with answer, keyPoints, and sources.
 *
 * [Spec: US-SY-008, US-SY-003, NFR-SY-004]
 */
export function parseDigestResponse(rawResponse: string): ParsedDigest {
  // [Implements: US-SY-008] Strategy 1: markdown headers
  let sections = parseMarkdownHeaders(rawResponse);

  // [Implements: US-SY-008] Strategy 2: heuristic keyword proximity (fallback)
  if (!sections.answer) {
    sections = heuristicKeywordProximity(rawResponse);
  }

  // [Implements: US-SY-008] If no Answer section found after both strategies,
  // treat the entire response as the answer with empty keyPoints.
  if (!sections.answer) {
    return {
      answer: rawResponse.trim(),
      keyPoints: [],
      sources: sections.sources ? parseSources(sections.sources) : [],
    };
  }

  // [Implements: US-SY-008] Answer was found — parse all available sections
  return {
    answer: sections.answer,
    keyPoints: sections.keyPoints ? parseKeyPoints(sections.keyPoints) : [],
    sources: sections.sources ? parseSources(sections.sources) : [],
  };
}

// ---------------------------------------------------------------------------
// Source reconciliation
// ---------------------------------------------------------------------------

// [Implements: US-SY-003]
/**
 * Reconcile parsed sources against known input sources.
 *
 * Appends any known input sources whose URL is not already present in the
 * parsed result's sources array. This ensures all referenced URLs from the
 * input content are represented in the final digest, even if the LLM omitted
 * them from its Sources section.
 *
 * @param parsed - The parsed digest from parseDigestResponse.
 * @param knownSources - All known input sources (from ContentItems).
 * @returns A new ParsedDigest with reconciled sources.
 *
 * [Spec: US-SY-003, NFR-SY-004]
 */
export function reconcileSources(
  parsed: ParsedDigest,
  knownSources: SourceRef[]
): ParsedDigest {
  // Build a set of existing URLs in the parsed sources
  const existingUrls = new Set(parsed.sources.map((s) => s.url));

  // Append any known source whose URL is not already present
  const additional = knownSources.filter((s) => !existingUrls.has(s.url));

  return {
    answer: parsed.answer,
    keyPoints: [...parsed.keyPoints],
    sources: [...parsed.sources, ...additional],
  };
}
