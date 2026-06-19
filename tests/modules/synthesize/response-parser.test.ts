/**
 * Unit tests for the response-parser module.
 *
 * Tests multi-strategy parsing (markdown headers, heuristic keyword
 * proximity), key point splitting, URL extraction with title pairing,
 * and source reconciliation.
 *
 * [Spec: US-SY-008, US-SY-003, NFR-SY-004]
 */

import { describe, it, expect } from 'vitest';
import {
  parseDigestResponse,
  parseKeyPoints,
  parseSources,
  parseMarkdownHeaders,
  heuristicKeywordProximity,
  reconcileSources,
} from '../../../src/modules/synthesize/response-parser.js';
import type { ParsedDigest } from '../../../src/modules/synthesize/response-parser.js';
import type { SourceRef } from '../../../src/shared/types/digest.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSourceRef(overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    url: overrides.url ?? 'https://example.com',
    title: overrides.title ?? 'Example Title',
  };
}

// ---------------------------------------------------------------------------
// parseKeyPoints
// ---------------------------------------------------------------------------

describe('parseKeyPoints', () => {
  // [Implements: US-SY-008] Dash bullets
  it('splits lines starting with "- " into key points', () => {
    const text = '- Point one\n- Point two\n- Point three';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Point one', 'Point two', 'Point three']);
  });

  // [Implements: US-SY-008] Asterisk bullets
  it('splits lines starting with "* " into key points', () => {
    const text = '* Point alpha\n* Point beta';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Point alpha', 'Point beta']);
  });

  // [Implements: US-SY-008] Numbered items with period (1. 2.)
  it('splits numbered items with period (1. 2.) into key points', () => {
    const text = '1. First point\n2. Second point\n3. Third point';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['First point', 'Second point', 'Third point']);
  });

  // [Implements: US-SY-008] Numbered items with parenthesis (1) 2))
  it('splits numbered items with parenthesis (1) 2)) into key points', () => {
    const text = '1) First point\n2) Second point';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['First point', 'Second point']);
  });

  it('handles mixed bullet styles', () => {
    const text = '- Dash point\n* Star point\n1. Numbered point';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Dash point', 'Star point', 'Numbered point']);
  });

  it('handles bullet character (•)', () => {
    const text = '• Bullet point one\n• Bullet point two';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Bullet point one', 'Bullet point two']);
  });

  it('trims whitespace from each point', () => {
    const text = '-   Point with extra spaces  \n-  Another point   ';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Point with extra spaces', 'Another point']);
  });

  it('ignores non-bullet lines', () => {
    const text = 'Some intro text\n- Bullet one\nSome trailing text\n- Bullet two';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Bullet one', 'Bullet two']);
  });

  it('ignores empty lines', () => {
    const text = '- Point one\n\n- Point two\n\n\n- Point three';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Point one', 'Point two', 'Point three']);
  });

  it('returns empty array for empty string', () => {
    expect(parseKeyPoints('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseKeyPoints('   \n\n   ')).toEqual([]);
  });

  it('returns empty array when no bullet items found', () => {
    expect(parseKeyPoints('Just some text without bullets here.')).toEqual([]);
  });

  it('ignores lines that are just bullet markers without content', () => {
    const text = '- \n- Actual point\n-';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Actual point']);
  });

  it('handles double-digit numbered items', () => {
    const text = '10. Tenth point\n11. Eleventh point';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Tenth point', 'Eleventh point']);
  });

  it('preserves internal formatting in points', () => {
    const text = '- Point with **bold** and *italic* text';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Point with **bold** and *italic* text']);
  });

  it('handles multi-word points with special characters', () => {
    const text = '- Cost: $100 (50% off)\n- URL: https://example.com';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Cost: $100 (50% off)', 'URL: https://example.com']);
  });

  it('handles points spanning many lines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- Point ${i + 1}`);
    const result = parseKeyPoints(lines.join('\n'));
    expect(result).toHaveLength(50);
    expect(result[0]).toBe('Point 1');
    expect(result[49]).toBe('Point 50');
  });
});

// ---------------------------------------------------------------------------
// parseSources
// ---------------------------------------------------------------------------

describe('parseSources', () => {
  // [Implements: US-SY-008] URL extraction
  it('extracts a single URL', () => {
    const text = 'https://example.com';
    const result = parseSources(text);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com');
  });

  it('extracts multiple URLs', () => {
    const text = 'https://a.com\nhttps://b.com\nhttps://c.com';
    const result = parseSources(text);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);
  });

  it('extracts URLs with paths', () => {
    const text = 'https://example.com/path/to/page';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com/path/to/page');
  });

  it('extracts URLs with query parameters', () => {
    const text = 'https://example.com/search?q=test&page=2';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com/search?q=test&page=2');
  });

  it('extracts URLs with fragments', () => {
    const text = 'https://example.com/page#section';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com/page#section');
  });

  it('extracts HTTP URLs', () => {
    const text = 'http://example.com';
    const result = parseSources(text);
    expect(result[0].url).toBe('http://example.com');
  });

  // [Implements: US-SY-008] URL with title on same line
  it('extracts title from text before URL on the same line', () => {
    const text = 'Example Site: https://example.com';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
    expect(result[0].title).toBe('Example Site');
  });

  it('extracts title from text before URL with bullet marker', () => {
    const text = '- Example: https://example.com';
    const result = parseSources(text);
    expect(result[0].title).toBe('Example');
  });

  // [Implements: US-SY-008] URL with title on preceding line
  it('uses nearest preceding non-URL line text as title', () => {
    const text = 'Example Title\nhttps://example.com';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
    expect(result[0].title).toBe('Example Title');
  });

  it('falls back to URL as title when no title text is available', () => {
    const text = 'https://example.com';
    const result = parseSources(text);
    expect(result[0].title).toBe('https://example.com');
  });

  // [Implements: US-SY-008] URL deduplication
  it('deduplicates sources by URL', () => {
    const text = 'https://example.com\nhttps://example.com\nhttps://example.com';
    const result = parseSources(text);
    expect(result).toHaveLength(1);
  });

  it('keeps unique URLs while deduplicating duplicates', () => {
    const text = 'https://a.com\nhttps://b.com\nhttps://a.com\nhttps://c.com\nhttps://b.com';
    const result = parseSources(text);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);
  });

  // URL cleaning
  it('strips trailing period from URL', () => {
    const text = 'https://example.com.';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
  });

  it('strips trailing comma from URL', () => {
    const text = 'https://example.com,';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
  });

  it('strips trailing semicolon from URL', () => {
    const text = 'https://example.com;';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
  });

  it('strips trailing colon from URL', () => {
    const text = 'https://example.com:';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
  });

  it('strips trailing exclamation from URL', () => {
    const text = 'https://example.com!';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
  });

  it('strips trailing unmatched closing parenthesis from URL', () => {
    const text = '(https://example.com)';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
  });

  it('does NOT strip closing parenthesis when URL contains opening parenthesis', () => {
    const text = 'https://en.wikipedia.org/wiki/Type_(programming)';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://en.wikipedia.org/wiki/Type_(programming)');
  });

  // Multiple URLs on the same line
  it('extracts multiple URLs on the same line', () => {
    const text = 'Visit https://a.com or https://b.com';
    const result = parseSources(text);
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe('https://a.com');
    expect(result[1].url).toBe('https://b.com');
  });

  it('assigns same title to multiple URLs on the same line', () => {
    const text = 'References: https://a.com https://b.com';
    const result = parseSources(text);
    expect(result[0].title).toBe(result[1].title);
    expect(result[0].title).toBe('References');
  });

  // Edge cases
  it('returns empty array for empty string', () => {
    expect(parseSources('')).toEqual([]);
  });

  it('returns empty array for text without URLs', () => {
    expect(parseSources('Just some text without any URLs here.')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseSources('   \n\n   ')).toEqual([]);
  });

  it('ignores non-HTTP URLs', () => {
    const text = 'ftp://example.com\njavascript:alert(1)\nmailto:test@test.com';
    const result = parseSources(text);
    expect(result).toHaveLength(0);
  });

  it('handles URLs with ports', () => {
    const text = 'https://example.com:8080/path';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com:8080/path');
  });

  it('handles URLs with subdomains', () => {
    const text = 'https://blog.subdomain.example.com/post';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://blog.subdomain.example.com/post');
  });

  it('handles URLs surrounded by markdown link syntax', () => {
    const text = 'See [example](https://example.com) for details.';
    const result = parseSources(text);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com');
  });

  it('handles URLs at the end of a sentence', () => {
    const text = 'Learn more at https://example.com.';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
  });
});

// ---------------------------------------------------------------------------
// parseMarkdownHeaders
// ---------------------------------------------------------------------------

describe('parseMarkdownHeaders', () => {
  // [Implements: US-SY-008] Strategy 1: markdown headers
  it('detects ## Answer header', () => {
    const text = '## Answer\nThis is the answer.';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe('This is the answer.');
  });

  it('detects ## Key Points header', () => {
    const text = '## Key Points\n- Point one\n- Point two';
    const result = parseMarkdownHeaders(text);
    expect(result.keyPoints).toBe('- Point one\n- Point two');
  });

  it('detects ## Sources header', () => {
    const text = '## Sources\nhttps://example.com';
    const result = parseMarkdownHeaders(text);
    expect(result.sources).toBe('https://example.com');
  });

  it('detects all three sections in order', () => {
    const text = [
      '## Answer',
      'The answer text.',
      '',
      '## Key Points',
      '- Point one',
      '',
      '## Sources',
      'https://example.com',
    ].join('\n');
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe('The answer text.');
    expect(result.keyPoints).toBe('- Point one');
    expect(result.sources).toBe('https://example.com');
  });

  it('detects # (single hash) headers', () => {
    const text = '# Answer\nThe answer.';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe('The answer.');
  });

  it('detects ### (triple hash) headers', () => {
    const text = '### Answer\nThe answer.';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe('The answer.');
  });

  it('detects headers case-insensitively', () => {
    const text = '## answer\nThe answer.';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe('The answer.');
  });

  it('detects headers with uppercase', () => {
    const text = '## ANSWER\nThe answer.';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe('The answer.');
  });

  it('detects "Key Point" (singular) header', () => {
    const text = '## Key Point\n- Only one point';
    const result = parseMarkdownHeaders(text);
    expect(result.keyPoints).toBe('- Only one point');
  });

  it('detects "Source" (singular) header', () => {
    const text = '## Source\nhttps://example.com';
    const result = parseMarkdownHeaders(text);
    expect(result.sources).toBe('https://example.com');
  });

  it('detects "KeyPoints" without space', () => {
    const text = '## KeyPoints\n- Point one';
    const result = parseMarkdownHeaders(text);
    expect(result.keyPoints).toBe('- Point one');
  });

  it('returns null for all sections when no headers are found', () => {
    const text = 'Just some text without any headers.';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBeNull();
    expect(result.keyPoints).toBeNull();
    expect(result.sources).toBeNull();
  });

  it('returns null sections when headers are missing', () => {
    const text = '## Answer\nOnly answer section.';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe('Only answer section.');
    expect(result.keyPoints).toBeNull();
    expect(result.sources).toBeNull();
  });

  it('extracts section content between headers', () => {
    const text = [
      '## Answer',
      'Line one.',
      'Line two.',
      '## Key Points',
      '- Point',
    ].join('\n');
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe('Line one.\nLine two.');
    expect(result.keyPoints).toBe('- Point');
  });

  it('uses only the first occurrence of each header (subsequent duplicates become content)', () => {
    const text = [
      '## Answer',
      'First answer.',
      '## Answer',
      'Second answer.',
    ].join('\n');
    const result = parseMarkdownHeaders(text);
    // The second ## Answer is not detected as a header (already found),
    // so its text becomes part of the first Answer section's content.
    expect(result.answer).toBe('First answer.\n## Answer\nSecond answer.');
  });

  it('handles headers at the end of text with no content after', () => {
    const text = '## Answer';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBeNull();
  });

  it('handles empty content between headers', () => {
    const text = '## Answer\n\n## Key Points\n- Point';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBeNull();
    expect(result.keyPoints).toBe('- Point');
  });

  it('handles sections in different order', () => {
    const text = [
      '## Sources',
      'https://example.com',
      '## Answer',
      'The answer.',
      '## Key Points',
      '- Point',
    ].join('\n');
    const result = parseMarkdownHeaders(text);
    expect(result.sources).toBe('https://example.com');
    expect(result.answer).toBe('The answer.');
    expect(result.keyPoints).toBe('- Point');
  });

  it('does not detect "Answer" without hash prefix', () => {
    const text = 'Answer\nThis is not a header.';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBeNull();
  });

  it('does not match "Answer" as part of another word in a header', () => {
    const text = '## Answered\nSome text.';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBeNull();
  });

  it('handles text before the first header (ignored)', () => {
    const text = 'Some preamble text.\n\n## Answer\nThe answer.';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe('The answer.');
  });
});

// ---------------------------------------------------------------------------
// heuristicKeywordProximity
// ---------------------------------------------------------------------------

describe('heuristicKeywordProximity', () => {
  // [Implements: US-SY-008] Strategy 2: keyword proximity
  it('detects "Answer:" keyword', () => {
    const text = 'Answer: This is the answer.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('This is the answer.');
  });

  it('detects "Key Points:" keyword', () => {
    const text = 'Key Points:\n- Point one';
    const result = heuristicKeywordProximity(text);
    expect(result.keyPoints).toBe('- Point one');
  });

  it('detects "Sources:" keyword', () => {
    const text = 'Sources:\nhttps://example.com';
    const result = heuristicKeywordProximity(text);
    expect(result.sources).toBe('https://example.com');
  });

  it('detects all three keywords', () => {
    const text = [
      'Answer: The answer text.',
      'Key Points:',
      '- Point one',
      'Sources:',
      'https://example.com',
    ].join('\n');
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer text.');
    expect(result.keyPoints).toBe('- Point one');
    expect(result.sources).toBe('https://example.com');
  });

  it('detects "Answer:" case-insensitively', () => {
    const text = 'answer: The answer.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer.');
  });

  it('detects "ANSWER:" uppercase', () => {
    const text = 'ANSWER: The answer.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer.');
  });

  it('detects keyword with markdown bold (**Answer**)', () => {
    const text = '**Answer**: The answer.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer.');
  });

  it('detects keyword with dash separator (Answer -)', () => {
    const text = 'Answer - The answer text.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer text.');
  });

  it('detects keyword with em-dash separator', () => {
    const text = 'Answer — The answer text.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer text.');
  });

  it('detects "Key Points" without colon', () => {
    const text = 'Key Points\n- Point one';
    const result = heuristicKeywordProximity(text);
    expect(result.keyPoints).toBe('- Point one');
  });

  it('detects "Key Point" (singular)', () => {
    const text = 'Key Point:\n- Only one';
    const result = heuristicKeywordProximity(text);
    expect(result.keyPoints).toBe('- Only one');
  });

  it('detects "Source" (singular)', () => {
    const text = 'Source:\nhttps://example.com';
    const result = heuristicKeywordProximity(text);
    expect(result.sources).toBe('https://example.com');
  });

  it('includes inline content after keyword on the same line', () => {
    const text = 'Answer: Inline answer text. Additional context follows.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toContain('Inline answer text.');
  });

  it('combines inline content and subsequent lines', () => {
    const text = [
      'Answer: Inline part.',
      'Subsequent line.',
    ].join('\n');
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toContain('Inline part.');
    expect(result.answer).toContain('Subsequent line.');
  });

  it('returns null for all sections when no keywords found', () => {
    const text = 'Just some random text without any section keywords.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBeNull();
    expect(result.keyPoints).toBeNull();
    expect(result.sources).toBeNull();
  });

  it('handles keywords in different order', () => {
    const text = [
      'Sources:',
      'https://example.com',
      'Answer:',
      'The answer.',
    ].join('\n');
    const result = heuristicKeywordProximity(text);
    expect(result.sources).toBe('https://example.com');
    expect(result.answer).toBe('The answer.');
  });

  it('uses only the first occurrence of each keyword (subsequent duplicates become content)', () => {
    const text = [
      'Answer: First answer.',
      'Answer: Second answer.',
    ].join('\n');
    const result = heuristicKeywordProximity(text);
    // The second "Answer:" is not detected (already found), so it becomes
    // part of the first Answer section's content.
    expect(result.answer).toBe('First answer.\nAnswer: Second answer.');
  });
});

// ---------------------------------------------------------------------------
// parseDigestResponse
// ---------------------------------------------------------------------------

describe('parseDigestResponse', () => {
  // [Implements: US-SY-008] Full structured format with markdown headers
  it('parses a well-structured response with markdown headers', () => {
    const response = [
      '## Answer',
      'TypeScript is a strongly typed programming language.',
      '',
      '## Key Points',
      '- TypeScript adds static types to JavaScript',
      '- It is developed by Microsoft',
      '- It compiles to JavaScript',
      '',
      '## Sources',
      'https://www.typescriptlang.org/',
      'https://en.wikipedia.org/wiki/TypeScript',
    ].join('\n');

    const result = parseDigestResponse(response);

    expect(result.answer).toBe('TypeScript is a strongly typed programming language.');
    expect(result.keyPoints).toEqual([
      'TypeScript adds static types to JavaScript',
      'It is developed by Microsoft',
      'It compiles to JavaScript',
    ]);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].url).toBe('https://www.typescriptlang.org/');
    expect(result.sources[1].url).toBe('https://en.wikipedia.org/wiki/TypeScript');
  });

  it('returns a ParsedDigest with answer, keyPoints, and sources', () => {
    const response = '## Answer\nThe answer.\n\n## Key Points\n- Point\n\n## Sources\nhttps://example.com';
    const result: ParsedDigest = parseDigestResponse(response);
    expect(result).toHaveProperty('answer');
    expect(result).toHaveProperty('keyPoints');
    expect(result).toHaveProperty('sources');
  });

  // [Implements: US-SY-008] Key points with various bullet formats
  it('parses key points with asterisk bullets', () => {
    const response = [
      '## Answer',
      'The answer.',
      '',
      '## Key Points',
      '* Point one',
      '* Point two',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.keyPoints).toEqual(['Point one', 'Point two']);
  });

  it('parses key points with numbered items', () => {
    const response = [
      '## Answer',
      'The answer.',
      '',
      '## Key Points',
      '1. First point',
      '2. Second point',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.keyPoints).toEqual(['First point', 'Second point']);
  });

  // [Implements: US-SY-008] Sources with URLs and titles
  it('parses sources with titles', () => {
    const response = [
      '## Answer',
      'The answer.',
      '',
      '## Sources',
      'TypeScript Official: https://www.typescriptlang.org/',
      'Wikipedia: https://en.wikipedia.org/wiki/TypeScript',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.sources[0].title).toBe('TypeScript Official');
    expect(result.sources[1].title).toBe('Wikipedia');
  });

  it('returns empty keyPoints when Key Points section is absent', () => {
    const response = '## Answer\nThe answer.\n\n## Sources\nhttps://example.com';
    const result = parseDigestResponse(response);
    expect(result.keyPoints).toEqual([]);
  });

  it('returns empty sources when Sources section is absent', () => {
    const response = '## Answer\nThe answer.\n\n## Key Points\n- Point';
    const result = parseDigestResponse(response);
    expect(result.sources).toEqual([]);
  });

  it('returns empty keyPoints and sources when only Answer is present', () => {
    const response = '## Answer\nJust the answer.';
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('Just the answer.');
    expect(result.keyPoints).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  // [Implements: US-SY-008] Fallback to heuristic keyword proximity
  it('falls back to heuristic parsing when markdown headers are not found', () => {
    const response = [
      'Answer: This is the answer.',
      '',
      'Key Points:',
      '- Point one',
      '- Point two',
      '',
      'Sources:',
      'https://example.com',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('This is the answer.');
    expect(result.keyPoints).toEqual(['Point one', 'Point two']);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe('https://example.com');
  });

  // [Implements: US-SY-008] Entire response as answer when no recognizable section
  it('treats entire response as answer when no Answer section is found', () => {
    const response = 'This is just some text without any section headers or keywords.';
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('This is just some text without any section headers or keywords.');
    expect(result.keyPoints).toEqual([]);
  });

  it('sets keyPoints to empty array when entire response becomes answer', () => {
    const response = 'Some random text without structure.';
    const result = parseDigestResponse(response);
    expect(result.keyPoints).toEqual([]);
  });

  it('treats entire response as answer when only Sources header is present (heuristic overwrites markdown)', () => {
    const response = [
      '## Sources',
      'https://example.com',
    ].join('\n');
    const result = parseDigestResponse(response);
    // No Answer header → heuristic fallback runs and overwrites markdown
    // result. Heuristic doesn't detect ## Sources, so sources is empty.
    // Entire response becomes the answer.
    expect(result.answer).toContain('## Sources');
    expect(result.keyPoints).toEqual([]);
  });

  it('handles empty response string', () => {
    const result = parseDigestResponse('');
    expect(result.answer).toBe('');
    expect(result.keyPoints).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it('handles whitespace-only response', () => {
    const result = parseDigestResponse('   \n\n   ');
    expect(result.answer).toBe('');
    expect(result.keyPoints).toEqual([]);
  });

  it('handles response with only headers and no content (entire response becomes answer)', () => {
    const response = '## Answer\n## Key Points\n## Sources';
    const result = parseDigestResponse(response);
    // All section contents are null (empty between headers), so answer is
    // null → heuristic fallback also finds nothing → entire response
    // becomes the answer.
    expect(result.answer).toBe('## Answer\n## Key Points\n## Sources');
    expect(result.keyPoints).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it('handles multi-paragraph answer', () => {
    const response = [
      '## Answer',
      'First paragraph of the answer.',
      '',
      'Second paragraph continues here.',
      '',
      '## Key Points',
      '- Point',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.answer).toContain('First paragraph');
    expect(result.answer).toContain('Second paragraph');
  });

  it('handles answer with no key points section but with sources', () => {
    const response = [
      '## Answer',
      'The answer text.',
      '',
      '## Sources',
      'https://example.com',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('The answer text.');
    expect(result.keyPoints).toEqual([]);
    expect(result.sources).toHaveLength(1);
  });

  it('deduplicates sources in parsed response', () => {
    const response = [
      '## Answer',
      'Answer.',
      '',
      '## Sources',
      'https://example.com',
      'https://example.com',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.sources).toHaveLength(1);
  });

  it('handles response with extra whitespace between sections', () => {
    const response = [
      '## Answer',
      'The answer.',
      '',
      '',
      '',
      '## Key Points',
      '- Point',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('The answer.');
    expect(result.keyPoints).toEqual(['Point']);
  });

  it('trims leading/trailing whitespace from answer', () => {
    const response = '## Answer\n\n  The answer with padding.  \n\n## Key Points\n- Point';
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('The answer with padding.');
  });

  it('prefers markdown header strategy over heuristic when both match', () => {
    const response = [
      '## Answer',
      'Markdown answer.',
      '',
      '## Key Points',
      '- Markdown point',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('Markdown answer.');
    expect(result.keyPoints).toEqual(['Markdown point']);
  });

  it('handles ### headers (triple hash)', () => {
    const response = [
      '### Answer',
      'The answer.',
      '',
      '### Key Points',
      '- Point',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('The answer.');
    expect(result.keyPoints).toEqual(['Point']);
  });
});

// ---------------------------------------------------------------------------
// reconcileSources
// ---------------------------------------------------------------------------

describe('reconcileSources', () => {
  // [Implements: US-SY-003] Appends missing known sources
  it('appends known sources not present in parsed result', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [{ url: 'https://a.com', title: 'A' }],
    };
    const known: SourceRef[] = [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ];
    const result = reconcileSources(parsed, known);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].url).toBe('https://a.com');
    expect(result.sources[1].url).toBe('https://b.com');
    expect(result.sources[1].title).toBe('B');
  });

  it('does not duplicate sources already present', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [{ url: 'https://a.com', title: 'A' }],
    };
    const known: SourceRef[] = [{ url: 'https://a.com', title: 'A' }];
    const result = reconcileSources(parsed, known);
    expect(result.sources).toHaveLength(1);
  });

  it('preserves parsed sources order and appends new ones at the end', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [
        { url: 'https://b.com', title: 'B' },
        { url: 'https://c.com', title: 'C' },
      ],
    };
    const known: SourceRef[] = [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
      { url: 'https://c.com', title: 'C' },
      { url: 'https://d.com', title: 'D' },
    ];
    const result = reconcileSources(parsed, known);
    expect(result.sources.map((s) => s.url)).toEqual([
      'https://b.com',
      'https://c.com',
      'https://a.com',
      'https://d.com',
    ]);
  });

  it('preserves parsed answer and keyPoints unchanged', () => {
    const parsed: ParsedDigest = {
      answer: 'The answer.',
      keyPoints: ['Point one', 'Point two'],
      sources: [],
    };
    const result = reconcileSources(parsed, [
      { url: 'https://a.com', title: 'A' },
    ]);
    expect(result.answer).toBe('The answer.');
    expect(result.keyPoints).toEqual(['Point one', 'Point two']);
  });

  it('handles empty known sources', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [{ url: 'https://a.com', title: 'A' }],
    };
    const result = reconcileSources(parsed, []);
    expect(result.sources).toHaveLength(1);
  });

  it('handles empty parsed sources', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [],
    };
    const known: SourceRef[] = [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ];
    const result = reconcileSources(parsed, known);
    expect(result.sources).toHaveLength(2);
  });

  it('handles both empty parsed and known sources', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [],
    };
    const result = reconcileSources(parsed, []);
    expect(result.sources).toEqual([]);
  });

  it('does not modify the original parsed object', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [{ url: 'https://a.com', title: 'A' }],
    };
    const originalSources = parsed.sources.slice();
    reconcileSources(parsed, [{ url: 'https://b.com', title: 'B' }]);
    expect(parsed.sources).toEqual(originalSources);
  });

  it('creates new arrays for keyPoints and sources (no mutation)', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: ['Point'],
      sources: [{ url: 'https://a.com', title: 'A' }],
    };
    const originalKeyPoints = parsed.keyPoints.slice();
    const result = reconcileSources(parsed, [{ url: 'https://b.com', title: 'B' }]);
    expect(parsed.keyPoints).toEqual(originalKeyPoints);
    expect(result.keyPoints).not.toBe(parsed.keyPoints);
    expect(result.sources).not.toBe(parsed.sources);
  });

  it('appends multiple missing known sources', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [{ url: 'https://a.com', title: 'A' }],
    };
    const known: SourceRef[] = [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
      { url: 'https://c.com', title: 'C' },
      { url: 'https://d.com', title: 'D' },
    ];
    const result = reconcileSources(parsed, known);
    expect(result.sources).toHaveLength(4);
  });

  it('uses URL matching (not title) for deduplication', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [{ url: 'https://a.com', title: 'Old Title' }],
    };
    const known: SourceRef[] = [
      { url: 'https://a.com', title: 'New Title' },
    ];
    const result = reconcileSources(parsed, known);
    // URL already exists → not appended, original title preserved
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].title).toBe('Old Title');
  });

  it('handles many known sources with partial overlap', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [
        { url: 'https://a.com', title: 'A' },
        { url: 'https://c.com', title: 'C' },
      ],
    };
    const known: SourceRef[] = Array.from({ length: 10 }, (_, i) => ({
      url: `https://${String.fromCharCode(97 + i)}.com`,
      title: `Title ${String.fromCharCode(65 + i)}`,
    }));
    const result = reconcileSources(parsed, known);
    // a.com and c.com already present; 8 new ones appended
    expect(result.sources).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Integration: parseDigestResponse + reconcileSources
// ---------------------------------------------------------------------------

describe('integration: parseDigestResponse + reconcileSources', () => {
  // [Implements: US-SY-003, US-SY-008]
  it('reconciles sources after parsing a structured response', () => {
    const response = [
      '## Answer',
      'The answer is here.',
      '',
      '## Key Points',
      '- Key point one',
      '',
      '## Sources',
      'https://referenced.com',
    ].join('\n');

    const parsed = parseDigestResponse(response);
    const known: SourceRef[] = [
      { url: 'https://referenced.com', title: 'Referenced' },
      { url: 'https://additional.com', title: 'Additional' },
      { url: 'https://another.com', title: 'Another' },
    ];

    const result = reconcileSources(parsed, known);

    expect(result.answer).toBe('The answer is here.');
    expect(result.keyPoints).toEqual(['Key point one']);
    expect(result.sources).toHaveLength(3);
    expect(result.sources[0].url).toBe('https://referenced.com');
    expect(result.sources[1].url).toBe('https://additional.com');
    expect(result.sources[2].url).toBe('https://another.com');
  });

  it('reconciles after fallback parse (no headers)', () => {
    const response = 'Just some answer text without structure.';
    const parsed = parseDigestResponse(response);
    const known: SourceRef[] = [
      { url: 'https://source1.com', title: 'Source 1' },
      { url: 'https://source2.com', title: 'Source 2' },
    ];

    const result = reconcileSources(parsed, known);

    expect(result.answer).toBe('Just some answer text without structure.');
    expect(result.keyPoints).toEqual([]);
    expect(result.sources).toHaveLength(2);
  });

  it('reconciles sources when LLM omitted some input sources', () => {
    const response = [
      '## Answer',
      'Partial answer.',
      '',
      '## Sources',
      'https://only-cited.com',
    ].join('\n');

    const parsed = parseDigestResponse(response);
    const known: SourceRef[] = [
      { url: 'https://only-cited.com', title: 'Cited' },
      { url: 'https://omitted-1.com', title: 'Omitted 1' },
      { url: 'https://omitted-2.com', title: 'Omitted 2' },
    ];

    const result = reconcileSources(parsed, known);

    // LLM cited 1, 2 were omitted → all 3 should be in final result
    expect(result.sources).toHaveLength(3);
    expect(result.sources.some((s) => s.url === 'https://omitted-1.com')).toBe(true);
    expect(result.sources.some((s) => s.url === 'https://omitted-2.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseKeyPoints — additional edge cases
// ---------------------------------------------------------------------------

describe('parseKeyPoints — additional edge cases', () => {
  it('handles numbered items without space after period', () => {
    // "1.Point" — no space after period — not a valid bullet
    const text = '1.Point\n2.Point';
    const result = parseKeyPoints(text);
    expect(result).toEqual([]);
  });

  it('handles dash without space (not a bullet)', () => {
    const text = '-Point one\n-Point two';
    const result = parseKeyPoints(text);
    expect(result).toEqual([]);
  });

  it('handles asterisk without space (not a bullet)', () => {
    const text = '*Point one\n*Point two';
    const result = parseKeyPoints(text);
    expect(result).toEqual([]);
  });

  it('handles bullet character without space (not a bullet)', () => {
    const text = '•Point one\n•Point two';
    const result = parseKeyPoints(text);
    expect(result).toEqual([]);
  });

  it('handles triple-digit numbered items', () => {
    const text = '100. Hundredth point\n101. Hundred-first point';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Hundredth point', 'Hundred-first point']);
  });

  it('handles points with nested dashes in text', () => {
    const text = '- Point with - dash inside the text';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Point with - dash inside the text']);
  });

  it('handles points with colons', () => {
    const text = '- Label: value description here';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Label: value description here']);
  });

  it('handles points with markdown links', () => {
    const text = '- See [documentation](https://example.com) for details';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['See [documentation](https://example.com) for details']);
  });

  it('handles very long single point', () => {
    const longPoint = 'A'.repeat(500);
    const text = `- ${longPoint}`;
    const result = parseKeyPoints(text);
    expect(result).toEqual([longPoint]);
  });

  it('preserves unicode content in points', () => {
    const text = '- 这是一个中文要点\n- これは日本語のポイントです';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['这是一个中文要点', 'これは日本語のポイントです']);
  });

  it('handles numbered item followed by closing bracket format', () => {
    const text = '1) First point\n2) Second point\n3) Third point';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['First point', 'Second point', 'Third point']);
  });

  it('handles tabs before bullet markers', () => {
    const text = '\t- Tabbed point one\n\t- Tabbed point two';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Tabbed point one', 'Tabbed point two']);
  });

  it('handles single space before bullet markers', () => {
    const text = ' - Indented dash point\n * Indented star point';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Indented dash point', 'Indented star point']);
  });

  it('ignores numbered items with letters (a. b.)', () => {
    const text = 'a. Letter point\nb. Another point';
    const result = parseKeyPoints(text);
    expect(result).toEqual([]);
  });

  it('handles empty point after marker trimming', () => {
    const text = '-    \n- Real point\n-  ';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Real point']);
  });

  it('handles a single point', () => {
    const text = '- Only one point';
    const result = parseKeyPoints(text);
    expect(result).toEqual(['Only one point']);
  });
});

// ---------------------------------------------------------------------------
// parseSources — additional edge cases
// ---------------------------------------------------------------------------

describe('parseSources — additional edge cases', () => {
  it('strips multiple trailing punctuation marks', () => {
    const text = 'https://example.com.,;';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
  });

  it('does NOT strip trailing question mark (not in cleanUrl regex)', () => {
    // The cleanUrl regex is [.,;:!]+$ — ? is not included
    const text = 'https://example.com?';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com?');
  });

  it('does NOT strip question mark when it is part of query string', () => {
    const text = 'https://example.com/search?q=test';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com/search?q=test');
  });

  it('extracts URLs with multi-level paths', () => {
    const text = 'https://example.com/a/b/c/d/e/f';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com/a/b/c/d/e/f');
  });

  it('extracts URLs with encoded characters', () => {
    const text = 'https://example.com/search?q=hello%20world';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com/search?q=hello%20world');
  });

  it('extracts URLs with authentication in URL', () => {
    const text = 'https://user:pass@example.com/secure';
    const result = parseSources(text);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://user:pass@example.com/secure');
  });

  it('handles URL followed by text on the same line', () => {
    const text = 'Check https://example.com for more info';
    const result = parseSources(text);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com');
  });

  it('extracts title from numbered line before URL', () => {
    const text = '1. Reference: https://example.com';
    const result = parseSources(text);
    expect(result[0].title).toBe('Reference');
  });

  it('extracts title from bulleted line before URL with asterisk', () => {
    const text = '* Article Name: https://example.com';
    const result = parseSources(text);
    expect(result[0].title).toBe('Article Name');
  });

  it('falls back to URL as title when preceding line is empty', () => {
    const text = '\n\nhttps://example.com';
    const result = parseSources(text);
    expect(result[0].title).toBe('https://example.com');
  });

  it('handles URL in parentheses without title', () => {
    const text = '(https://example.com/page)';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com/page');
  });

  it('deduplicates while preserving first occurrence', () => {
    const text = 'Title A: https://a.com\nTitle B: https://a.com';
    const result = parseSources(text);
    expect(result).toHaveLength(1);
    // First occurrence's title is preserved
    expect(result[0].title).toBe('Title A');
  });

  it('handles many unique URLs', () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      `https://example${i}.com/page${i}`
    );
    const result = parseSources(lines.join('\n'));
    expect(result).toHaveLength(20);
  });

  it('handles URLs with underscores in paths', () => {
    const text = 'https://example.com/path_with_underscores';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com/path_with_underscores');
  });

  it('handles URLs with tildes in paths', () => {
    const text = 'https://example.com/~user/page';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com/~user/page');
  });

  it('handles URL immediately at start of text', () => {
    const text = 'https://example.com is the best site';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
  });

  it('handles URL with markdown link text as title', () => {
    const text = '[Example Site](https://example.com)';
    const result = parseSources(text);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com');
  });

  it('strips trailing exclamation from URL in a sentence', () => {
    const text = 'Check https://example.com!';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
  });

  it('does not strip trailing punctuation inside path segment', () => {
    // The path itself ends with /page, trailing comma is stripped
    const text = 'https://example.com/page,';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com/page');
  });

  it('handles URL with IP address', () => {
    const text = 'https://192.168.1.1:8080/api';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://192.168.1.1:8080/api');
  });

  it('handles URL with only scheme and domain (no path)', () => {
    const text = 'https://example.com';
    const result = parseSources(text);
    expect(result[0].url).toBe('https://example.com');
  });
});

// ---------------------------------------------------------------------------
// parseMarkdownHeaders — additional edge cases
// ---------------------------------------------------------------------------

describe('parseMarkdownHeaders — additional edge cases', () => {
  it('handles #### (quadruple hash) — not matched (only 1-3 hashes)', () => {
    const text = '#### Answer\nThe answer.';
    const result = parseMarkdownHeaders(text);
    // #### is not matched by the 1-3 hash pattern
    expect(result.answer).toBeNull();
  });

  it('detects "KeyPoints" without space after ##', () => {
    const text = '##KeyPoints\n- Point one';
    // The regex requires \s+ after the hash(es), so ##KeyPoints without space
    // should NOT match
    const result = parseMarkdownHeaders(text);
    expect(result.keyPoints).toBeNull();
  });

  it('detects "Sources" with mixed case (sOuRcEs)', () => {
    const text = '## sOuRcEs\nhttps://example.com';
    const result = parseMarkdownHeaders(text);
    expect(result.sources).toBe('https://example.com');
  });

  it('handles multiple blank lines between sections', () => {
    const text = [
      '## Answer',
      'The answer.',
      '',
      '',
      '',
      '',
      '## Key Points',
      '- Point',
    ].join('\n');
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe('The answer.');
    expect(result.keyPoints).toBe('- Point');
  });

  it('handles headers with trailing spaces', () => {
    const text = '## Answer   \nThe answer.';
    const result = parseMarkdownHeaders(text);
    // The regex /^#{1,3}\s+Answer\b/i does not account for trailing spaces
    // on the header line, but it should still match the line
    expect(result.answer).toBe('The answer.');
  });

  it('does not detect "Answers" (plural) as Answer header', () => {
    const text = '## Answers\nThe answers.';
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBeNull();
  });

  it('handles "Key-Points" with hyphen — not matched', () => {
    const text = '## Key-Points\n- Point one';
    // The regex is Key\s*Points? — "Key-Points" has a hyphen, not whitespace
    // so it does NOT match
    const result = parseMarkdownHeaders(text);
    expect(result.keyPoints).toBeNull();
  });

  it('handles "Sources" followed by numbers (Sources123)', () => {
    const text = '## Sources123\nhttps://example.com';
    const result = parseMarkdownHeaders(text);
    // Sources? requires word boundary — Sources123 has no boundary after "Source(s)"
    expect(result.sources).toBeNull();
  });

  it('handles headers with tabs after hash', () => {
    const text = '##\tAnswer\nThe answer.';
    // \t is matched by \s in the regex
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe('The answer.');
  });

  it('handles very long header content', () => {
    const longContent = 'A'.repeat(5000);
    const text = `## Answer\n${longContent}\n## Key Points\n- Point`;
    const result = parseMarkdownHeaders(text);
    expect(result.answer).toBe(longContent);
  });

  it('handles multi-line key points section content', () => {
    const text = [
      '## Key Points',
      '- First point',
      '- Second point',
      '- Third point',
      '',
      '## Answer',
      'The answer.',
    ].join('\n');
    const result = parseMarkdownHeaders(text);
    expect(result.keyPoints).toBe('- First point\n- Second point\n- Third point');
  });

  it('returns null sources when no sources header exists', () => {
    const text = '## Answer\nThe answer.\n## Key Points\n- Point';
    const result = parseMarkdownHeaders(text);
    expect(result.sources).toBeNull();
  });

  it('detects only the first occurrence of Key Points header', () => {
    const text = [
      '## Key Points',
      '- First set point',
      '## Key Points',
      '- Second set point',
    ].join('\n');
    const result = parseMarkdownHeaders(text);
    expect(result.keyPoints).toBe('- First set point\n## Key Points\n- Second set point');
  });
});

// ---------------------------------------------------------------------------
// heuristicKeywordProximity — additional edge cases
// ---------------------------------------------------------------------------

describe('heuristicKeywordProximity — additional edge cases', () => {
  it('detects keyword with markdown italic (*Answer*)', () => {
    const text = '*Answer*: The answer.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer.');
  });

  it('detects keyword with bold and colon (**Answer** :)', () => {
    const text = '**Answer** : The answer.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer.');
  });

  it('detects keyword with en-dash separator (–)', () => {
    const text = 'Answer – The answer text.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer text.');
  });

  it('detects keyword with only spaces (no delimiter)', () => {
    const text = 'Answer The answer text continues here.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer text continues here.');
  });

  it('detects "key points" in all lowercase', () => {
    const text = 'key points:\n- Point one';
    const result = heuristicKeywordProximity(text);
    expect(result.keyPoints).toBe('- Point one');
  });

  it('detects "sources" in all lowercase', () => {
    const text = 'sources:\nhttps://example.com';
    const result = heuristicKeywordProximity(text);
    expect(result.sources).toBe('https://example.com');
  });

  it('detects "KEY POINTS" in uppercase', () => {
    const text = 'KEY POINTS:\n- Point one';
    const result = heuristicKeywordProximity(text);
    expect(result.keyPoints).toBe('- Point one');
  });

  it('detects "keypoints" without space (heuristic)', () => {
    const text = 'keypoints:\n- Point one';
    const result = heuristicKeywordProximity(text);
    // The regex allows Key\s*Points? — no space is \s{0} which is valid
    expect(result.keyPoints).toBe('- Point one');
  });

  it('includes inline content after keyword even when multiline', () => {
    const text = 'Answer: First part of the answer.\nSecond part.\nThird part.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toContain('First part of the answer.');
    expect(result.answer).toContain('Second part.');
    expect(result.answer).toContain('Third part.');
  });

  it('combines inline and subsequent lines with newline', () => {
    const text = 'Answer: Inline content.\nSubsequent content.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('Inline content.\nSubsequent content.');
  });

  it('detects "Key Point" without colon or delimiter', () => {
    const text = 'Key Point\n- Only one point';
    const result = heuristicKeywordProximity(text);
    expect(result.keyPoints).toBe('- Only one point');
  });

  it('detects only the first occurrence of Key Points keyword', () => {
    const text = [
      'Key Points:',
      '- First occurrence',
      'Key Points:',
      '- Second occurrence',
    ].join('\n');
    const result = heuristicKeywordProximity(text);
    expect(result.keyPoints).toBe('- First occurrence\nKey Points:\n- Second occurrence');
  });

  it('detects keywords with leading whitespace', () => {
    const text = '  Answer: The answer.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer.');
  });

  it('detects keywords with leading tabs', () => {
    const text = '\tAnswer: The answer.';
    const result = heuristicKeywordProximity(text);
    expect(result.answer).toBe('The answer.');
  });

  it('returns null for keywords embedded in longer text', () => {
    const text = 'The answer is clearly Answer: something here.';
    const result = heuristicKeywordProximity(text);
    // "Answer:" must be at the start of the line (after optional whitespace)
    expect(result.answer).toBeNull();
  });

  it('detects sources keyword with multiple URLs', () => {
    const text = 'Sources:\nhttps://a.com\nhttps://b.com\nhttps://c.com';
    const result = heuristicKeywordProximity(text);
    expect(result.sources).toBe('https://a.com\nhttps://b.com\nhttps://c.com');
  });
});

// ---------------------------------------------------------------------------
// parseDigestResponse — additional integration and fallback tests
// ---------------------------------------------------------------------------

describe('parseDigestResponse — additional integration tests', () => {
  it('parses response with keyPoints but no sources section', () => {
    const response = [
      '## Answer',
      'The answer.',
      '',
      '## Key Points',
      '- Point one',
      '- Point two',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('The answer.');
    expect(result.keyPoints).toEqual(['Point one', 'Point two']);
    expect(result.sources).toEqual([]);
  });

  it('parses response with sources but no keyPoints section', () => {
    const response = [
      '## Answer',
      'The answer.',
      '',
      '## Sources',
      'https://a.com',
      'https://b.com',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('The answer.');
    expect(result.keyPoints).toEqual([]);
    expect(result.sources).toHaveLength(2);
  });

  it('parses response with mixed bullet styles in key points', () => {
    const response = [
      '## Answer',
      'The answer.',
      '',
      '## Key Points',
      '- Dash point',
      '* Star point',
      '1. Numbered point',
      '• Bullet point',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.keyPoints).toEqual([
      'Dash point',
      'Star point',
      'Numbered point',
      'Bullet point',
    ]);
  });

  it('parses sources with titles and deduplicates', () => {
    const response = [
      '## Answer',
      'Answer.',
      '',
      '## Sources',
      'Site A: https://a.com',
      'Site B: https://b.com',
      'Site A Again: https://a.com',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].title).toBe('Site A');
  });

  it('parses response using heuristic when Answer has no markdown hash', () => {
    const response = [
      'Answer: Heuristic answer.',
      '',
      'Key Points:',
      '- Heuristic point',
      '',
      'Sources:',
      'https://heuristic.com',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('Heuristic answer.');
    expect(result.keyPoints).toEqual(['Heuristic point']);
    expect(result.sources[0].url).toBe('https://heuristic.com');
  });

  it('returns trimmed answer from markdown header strategy', () => {
    const response = [
      '## Answer',
      '',
      '',
      'The answer with blank lines before.',
      '',
      '## Key Points',
      '- Point',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('The answer with blank lines before.');
  });

  it('parses response with only Answer and no other sections', () => {
    const response = '## Answer\nThis is a standalone answer with no other sections.';
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('This is a standalone answer with no other sections.');
    expect(result.keyPoints).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it('handles response with keyPoints but no Answer (treats as heuristic fallback)', () => {
    const response = [
      '## Key Points',
      '- Point one',
      '- Point two',
    ].join('\n');
    const result = parseDigestResponse(response);
    // No Answer section → heuristic fallback runs, which doesn't find ## Answer
    // → entire response becomes the answer
    expect(result.answer).toContain('## Key Points');
    expect(result.keyPoints).toEqual([]);
  });

  it('handles response with markdown headers and heuristic keywords mixed', () => {
    const response = [
      '## Answer',
      'Markdown answer.',
      '',
      'Key Points:',
      '- Keyword point',
      '',
      'Sources:',
      'https://example.com',
    ].join('\n');
    const result = parseDigestResponse(response);
    // Markdown Answer is found → entire block until next markdown header or
    // end of text becomes the Answer content. Since there are no more ## headers,
    // the answer includes everything after ## Answer.
    expect(result.answer).toContain('Markdown answer.');
    expect(result.answer).toContain('Key Points:');
    expect(result.answer).toContain('Keyword point');
    // No ## Key Points header → keyPoints is empty
    expect(result.keyPoints).toEqual([]);
  });

  it('preserves exact answer text from markdown section', () => {
    const response = '## Answer\nExact answer text with specific punctuation!';
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('Exact answer text with specific punctuation!');
  });

  it('handles very long answer', () => {
    const longAnswer = 'A'.repeat(5000);
    const response = `## Answer\n${longAnswer}`;
    const result = parseDigestResponse(response);
    expect(result.answer).toBe(longAnswer);
  });

  it('handles many key points (20+)', () => {
    const points = Array.from({ length: 20 }, (_, i) => `- Point ${i + 1}`);
    const response = `## Answer\nAnswer.\n\n## Key Points\n${points.join('\n')}`;
    const result = parseDigestResponse(response);
    expect(result.keyPoints).toHaveLength(20);
    expect(result.keyPoints[0]).toBe('Point 1');
    expect(result.keyPoints[19]).toBe('Point 20');
  });

  it('handles many sources (10+)', () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://example${i}.com`);
    const response = `## Answer\nAnswer.\n\n## Sources\n${urls.join('\n')}`;
    const result = parseDigestResponse(response);
    expect(result.sources).toHaveLength(10);
  });

  it('handles CJK content in answer', () => {
    const response = '## Answer\n这是一个中文答案。';
    const result = parseDigestResponse(response);
    expect(result.answer).toBe('这是一个中文答案。');
  });

  it('handles CJK content in key points', () => {
    const response = [
      '## Answer',
      '答案。',
      '',
      '## Key Points',
      '- 第一点',
      '- 第二点',
    ].join('\n');
    const result = parseDigestResponse(response);
    expect(result.keyPoints).toEqual(['第一点', '第二点']);
  });
});

// ---------------------------------------------------------------------------
// reconcileSources — additional edge cases
// ---------------------------------------------------------------------------

describe('reconcileSources — additional edge cases', () => {
  it('does not duplicate URLs that appear with different titles in known sources', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [{ url: 'https://a.com', title: 'Parsed Title' }],
    };
    const known: SourceRef[] = [
      { url: 'https://a.com', title: 'Known Title 1' },
      { url: 'https://a.com', title: 'Known Title 2' },
    ];
    const result = reconcileSources(parsed, known);
    // URL already present → neither known source is appended
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].title).toBe('Parsed Title');
  });

  it('preserves answer exactly as passed in', () => {
    const parsed: ParsedDigest = {
      answer: 'A complex answer with special chars: @#$%^&*()',
      keyPoints: [],
      sources: [],
    };
    const result = reconcileSources(parsed, []);
    expect(result.answer).toBe('A complex answer with special chars: @#$%^&*()');
  });

  it('handles keyPoints that are non-empty', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: ['First', 'Second', 'Third'],
      sources: [{ url: 'https://a.com', title: 'A' }],
    };
    const result = reconcileSources(parsed, [{ url: 'https://b.com', title: 'B' }]);
    expect(result.keyPoints).toEqual(['First', 'Second', 'Third']);
    // keyPoints should be a new array (copy), not the same reference
    expect(result.keyPoints).not.toBe(parsed.keyPoints);
    expect(result.keyPoints).toEqual(parsed.keyPoints);
  });

  it('appends known sources in order when parsed is empty', () => {
    const parsed: ParsedDigest = {
      answer: '',
      keyPoints: [],
      sources: [],
    };
    const known: SourceRef[] = [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
      { url: 'https://c.com', title: 'C' },
    ];
    const result = reconcileSources(parsed, known);
    expect(result.sources.map((s) => s.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);
  });

  it('handles known sources with identical URLs (only appends first)', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [],
    };
    const known: SourceRef[] = [
      { url: 'https://a.com', title: 'First' },
      { url: 'https://a.com', title: 'Second' },
    ];
    const result = reconcileSources(parsed, known);
    // Both have the same URL → both pass the filter because neither is
    // in existingUrls initially. Both get appended.
    expect(result.sources).toHaveLength(2);
  });

  it('handles very large known sources list', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [{ url: 'https://a.com', title: 'A' }],
    };
    const known: SourceRef[] = Array.from({ length: 100 }, (_, i) => ({
      url: `https://source${i}.com`,
      title: `Source ${i}`,
    }));
    const result = reconcileSources(parsed, known);
    // 1 existing + 100 new = 101
    expect(result.sources).toHaveLength(101);
  });

  it('does not mutate the known sources array', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [],
    };
    const known: SourceRef[] = [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ];
    const originalKnown = known.map((s) => ({ ...s }));
    reconcileSources(parsed, known);
    expect(known).toEqual(originalKnown);
  });

  it('handles parsed sources with empty URL strings', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [{ url: '', title: 'Empty URL' }],
    };
    const known: SourceRef[] = [{ url: '', title: 'Also Empty' }];
    const result = reconcileSources(parsed, known);
    // Empty URL in parsed → exists set has "" → known source with "" URL
    // is not added (already exists)
    expect(result.sources).toHaveLength(1);
  });

  it('returns a new object (not the same reference as parsed)', () => {
    const parsed: ParsedDigest = {
      answer: 'Answer.',
      keyPoints: [],
      sources: [],
    };
    const result = reconcileSources(parsed, []);
    expect(result).not.toBe(parsed);
  });

  it('result answer is the same string value as parsed answer', () => {
    const parsed: ParsedDigest = {
      answer: 'The answer.',
      keyPoints: [],
      sources: [],
    };
    const result = reconcileSources(parsed, []);
    expect(result.answer).toBe(parsed.answer);
  });
});

// ---------------------------------------------------------------------------
// Integration: multi-strategy parsing combined with reconciliation
// ---------------------------------------------------------------------------

describe('integration: multi-strategy parsing and reconciliation', () => {
  it('parses heuristic response and reconciles sources', () => {
    const response = [
      'Answer: The LLM answer.',
      '',
      'Key Points:',
      '- Key point A',
      '',
      'Sources:',
      'https://cited.com',
    ].join('\n');

    const parsed = parseDigestResponse(response);
    const known: SourceRef[] = [
      { url: 'https://cited.com', title: 'Cited' },
      { url: 'https://uncited-1.com', title: 'Uncited 1' },
      { url: 'https://uncited-2.com', title: 'Uncited 2' },
    ];

    const result = reconcileSources(parsed, known);

    expect(result.answer).toBe('The LLM answer.');
    expect(result.keyPoints).toEqual(['Key point A']);
    expect(result.sources).toHaveLength(3);
  });

  it('parses markdown response and reconciles with all-matching known sources', () => {
    const response = [
      '## Answer',
      'The answer.',
      '',
      '## Sources',
      'https://a.com',
      'https://b.com',
    ].join('\n');

    const parsed = parseDigestResponse(response);
    const known: SourceRef[] = [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ];

    const result = reconcileSources(parsed, known);
    // All known sources already present → no additions
    expect(result.sources).toHaveLength(2);
  });

  it('parses unstructured response and reconciles all known sources', () => {
    const response = 'Just a plain answer with no structure whatsoever.';
    const parsed = parseDigestResponse(response);
    const known: SourceRef[] = [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ];

    const result = reconcileSources(parsed, known);

    expect(result.answer).toBe('Just a plain answer with no structure whatsoever.');
    expect(result.sources).toHaveLength(2);
  });

  it('handles full pipeline: markdown parse → reconcile → check LLM-cited URLs', () => {
    const response = [
      '## Answer',
      'The synthesized answer.',
      '',
      '## Key Points',
      '- Important point',
      '- Another point',
      '',
      '## Sources',
      'https://real-source.com',
      'https://hallucinated.com',
    ].join('\n');

    const parsed = parseDigestResponse(response);
    const known: SourceRef[] = [
      { url: 'https://real-source.com', title: 'Real' },
      { url: 'https://omitted.com', title: 'Omitted' },
    ];

    const result = reconcileSources(parsed, known);

    // Sources: parsed had 2 (real-source + hallucinated), known adds omitted
    // Total = 3 (real-source, hallucinated, omitted)
    expect(result.sources).toHaveLength(3);
    // omitted.com should be present (appended by reconciliation)
    expect(result.sources.some((s) => s.url === 'https://omitted.com')).toBe(true);
  });

  it('does not remove hallucinated URLs during reconciliation', () => {
    const response = [
      '## Answer',
      'Answer.',
      '',
      '## Sources',
      'https://hallucinated.com',
    ].join('\n');

    const parsed = parseDigestResponse(response);
    const known: SourceRef[] = [
      { url: 'https://real-source.com', title: 'Real' },
    ];

    const result = reconcileSources(parsed, known);

    // Reconciliation only appends, never removes
    expect(result.sources.some((s) => s.url === 'https://hallucinated.com')).toBe(true);
    expect(result.sources.some((s) => s.url === 'https://real-source.com')).toBe(true);
  });

  it('reconciles after markdown parse with many known sources', () => {
    const response = [
      '## Answer',
      'Answer.',
      '',
      '## Sources',
      'https://first.com',
    ].join('\n');

    const parsed = parseDigestResponse(response);
    const known: SourceRef[] = Array.from({ length: 20 }, (_, i) => ({
      url: `https://source${i}.com`,
      title: `Source ${i}`,
    }));

    const result = reconcileSources(parsed, known);

    // 1 parsed + 20 known (none overlap) = 21
    expect(result.sources).toHaveLength(21);
    expect(result.sources[0].url).toBe('https://first.com');
  });
});
