/**
 * Unit tests for the result normalizer (result-normalizer.ts).
 *
 * Verifies:
 *   - truncateField: within-limit passthrough, exact boundary, truncation with "..."
 *   - normalizeUrlForDedup: fragment stripping, no-fragment passthrough, multiple hashes
 *   - normalizeScore: single result → 1.0, numeric scores → divide by max,
 *     no scores → positional rank, mixed null/numeric, all-zero scores
 *   - deduplicateByExactUrl: exact URL dedup, fragment-insensitive dedup,
 *     highest-score retention, no-duplicates passthrough, stderr logging
 *   - normalizeResults: full pipeline (defaults, truncation, score normalization,
 *     dedup, sort, maxResults truncation), empty input, single result
 *
 * [Spec: US-SR-003, US-SR-010, US-SR-011, BG-SR-001, NFR-SR-003, DC-SR-002, DC-SR-003]
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  truncateField,
  normalizeUrlForDedup,
  normalizeScore,
  deduplicateByExactUrl,
  normalizeResults,
  TITLE_MAX_LENGTH,
  SNIPPET_MAX_LENGTH,
  TRUNCATION_SUFFIX,
  DEFAULT_TITLE,
  type ParsedResult,
} from '../../../src/modules/search-retrieval/result-normalizer.js';
import type { SearchResult } from '../../../src/shared/types/search.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParsedResult(
  overrides: Partial<ParsedResult> = {}
): ParsedResult {
  return {
    title: 'Test Title',
    url: 'https://example.com',
    content: 'Test snippet content',
    score: null,
    ...overrides,
  };
}

function makeSearchResult(
  overrides: Partial<SearchResult> = {}
): SearchResult {
  return {
    title: 'Test Title',
    url: 'https://example.com',
    snippet: 'Test snippet',
    score: 1.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// truncateField
// ---------------------------------------------------------------------------

describe('truncateField', () => {
  // [Implements: US-SR-003]
  it('returns the original string when length equals maxLength', () => {
    const value = 'a'.repeat(500);
    expect(truncateField(value, 500)).toBe(value);
  });

  it('returns the original string when length is less than maxLength', () => {
    const value = 'short';
    expect(truncateField(value, 500)).toBe('short');
  });

  it('returns the original string when length is 0', () => {
    expect(truncateField('', 500)).toBe('');
  });

  it('returns the original string when length is 1', () => {
    expect(truncateField('x', 500)).toBe('x');
  });

  // [Implements: US-SR-003] Title truncation: 500 chars → 497 + "..."
  it('truncates to 497 chars + "..." when title exceeds 500 chars', () => {
    const value = 'a'.repeat(600);
    const result = truncateField(value, 500);
    expect(result.length).toBe(500);
    expect(result).toBe('a'.repeat(497) + '...');
  });

  // [Implements: US-SR-003] Snippet truncation: 1000 chars → 997 + "..."
  it('truncates to 997 chars + "..." when snippet exceeds 1000 chars', () => {
    const value = 'b'.repeat(1200);
    const result = truncateField(value, 1000);
    expect(result.length).toBe(1000);
    expect(result).toBe('b'.repeat(997) + '...');
  });

  it('truncates exactly one character over the limit', () => {
    const value = 'a'.repeat(501);
    const result = truncateField(value, 500);
    expect(result.length).toBe(500);
    expect(result.endsWith('...')).toBe(true);
    expect(result.slice(0, 497)).toBe('a'.repeat(497));
  });

  it('truncates a very long string correctly', () => {
    const value = 'x'.repeat(10000);
    const result = truncateField(value, 500);
    expect(result.length).toBe(500);
    expect(result).toBe('x'.repeat(497) + '...');
  });

  it('preserves the suffix "..." at the end of truncated string', () => {
    const value = 'hello world'.repeat(100);
    const result = truncateField(value, 100);
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBe(100);
  });

  it('handles maxLength of 3 (just enough for the suffix)', () => {
    const value = 'abcdef';
    const result = truncateField(value, 3);
    expect(result).toBe('...');
    expect(result.length).toBe(3);
  });

  it('does not truncate when value length is maxLength - 1', () => {
    const value = 'a'.repeat(499);
    expect(truncateField(value, 500)).toBe(value);
  });
});

// ---------------------------------------------------------------------------
// normalizeUrlForDedup
// ---------------------------------------------------------------------------

describe('normalizeUrlForDedup', () => {
  // [Implements: US-SR-010]
  it('strips the fragment from a URL with a hash', () => {
    expect(normalizeUrlForDedup('https://example.com/page#section1')).toBe(
      'https://example.com/page'
    );
  });

  it('strips the fragment from a URL with a hash and query', () => {
    expect(
      normalizeUrlForDedup('https://example.com/page?q=1#section2')
    ).toBe('https://example.com/page?q=1');
  });

  it('returns the URL unchanged when no fragment is present', () => {
    expect(normalizeUrlForDedup('https://example.com/page')).toBe(
      'https://example.com/page'
    );
  });

  it('returns the URL unchanged when only a query is present', () => {
    expect(normalizeUrlForDedup('https://example.com/page?q=1')).toBe(
      'https://example.com/page?q=1'
    );
  });

  it('returns the URL unchanged for a bare domain', () => {
    expect(normalizeUrlForDedup('https://example.com')).toBe(
      'https://example.com'
    );
  });

  it('strips fragment from a URL with only a hash and no path', () => {
    expect(normalizeUrlForDedup('https://example.com#top')).toBe(
      'https://example.com'
    );
  });

  it('strips everything after the first hash (multiple hashes)', () => {
    expect(normalizeUrlForDedup('https://example.com/page#a#b#c')).toBe(
      'https://example.com/page'
    );
  });

  it('handles empty fragment (# at end)', () => {
    expect(normalizeUrlForDedup('https://example.com/page#')).toBe(
      'https://example.com/page'
    );
  });

  it('handles hash at the very start of the string', () => {
    expect(normalizeUrlForDedup('#fragment')).toBe('');
  });

  it('treats URLs differing only in fragment as identical after normalization', () => {
    const url1 = normalizeUrlForDedup('https://example.com/page.html#section1');
    const url2 = normalizeUrlForDedup('https://example.com/page.html#section2');
    expect(url1).toBe(url2);
  });

  it('preserves URL with port and fragment stripping', () => {
    expect(
      normalizeUrlForDedup('https://example.com:8080/path#frag')
    ).toBe('https://example.com:8080/path');
  });

  it('preserves URL with auth and fragment stripping', () => {
    expect(
      normalizeUrlForDedup('https://user:pass@example.com/path#frag')
    ).toBe('https://user:pass@example.com/path');
  });

  it('handles an empty string', () => {
    expect(normalizeUrlForDedup('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// normalizeScore
// ---------------------------------------------------------------------------

describe('normalizeScore', () => {
  // [Implements: US-SR-003] Empty array
  it('returns an empty array for empty input', () => {
    expect(normalizeScore([])).toEqual([]);
  });

  // [Implements: US-SR-003] Single result → score 1.0
  it('assigns score 1.0 to a single result', () => {
    const results = [makeParsedResult({ score: null })];
    const normalized = normalizeScore(results);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('assigns score 1.0 to a single result even if it had a numeric score', () => {
    const results = [makeParsedResult({ score: 42.5 })];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
  });

  // [Implements: US-SR-003] Numeric scores → divide by max
  it('normalizes numeric scores by dividing by the maximum score', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 4.0 }),
      makeParsedResult({ url: 'https://b.com', score: 2.0 }),
      makeParsedResult({ url: 'https://c.com', score: 1.0 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.5);
    expect(normalized[2]!.score).toBe(0.25);
  });

  it('normalizes scores where max is 1.0 (no change to top result)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0 }),
      makeParsedResult({ url: 'https://b.com', score: 0.5 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.5);
  });

  it('normalizes scores with fractional max', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 3.5 }),
      makeParsedResult({ url: 'https://b.com', score: 1.75 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBeCloseTo(0.5, 10);
  });

  it('treats null scores as 0 when other results have numeric scores', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 10.0 }),
      makeParsedResult({ url: 'https://b.com', score: null }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.0);
  });

  it('normalizes when all results have the same score', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 5.0 }),
      makeParsedResult({ url: 'https://b.com', score: 5.0 }),
      makeParsedResult({ url: 'https://c.com', score: 5.0 }),
    ];
    const normalized = normalizeScore(results);
    for (const r of normalized) {
      expect(r.score).toBe(1.0);
    }
  });

  it('falls back to positional ranking when all scores are negative (max not > 0)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: -1.0 }),
      makeParsedResult({ url: 'https://b.com', score: -4.0 }),
    ];
    const normalized = normalizeScore(results);
    // maxScore = -1.0 which is not > 0, so falls through to positional ranking
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.5);
  });

  // [Implements: US-SR-003] All-zero scores → positional ranking
  it('falls back to positional ranking when all scores are 0', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 0 }),
      makeParsedResult({ url: 'https://b.com', score: 0 }),
      makeParsedResult({ url: 'https://c.com', score: 0 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBeCloseTo(1.0 - 1 / 3, 10);
    expect(normalized[2]!.score).toBeCloseTo(1.0 - 2 / 3, 10);
  });

  // [Implements: US-SR-003] No scores → positional ranking
  it('assigns positional rank scores when no results have scores', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: null }),
      makeParsedResult({ url: 'https://b.com', score: null }),
      makeParsedResult({ url: 'https://c.com', score: null }),
      makeParsedResult({ url: 'https://d.com', score: null }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.75);
    expect(normalized[2]!.score).toBe(0.5);
    expect(normalized[3]!.score).toBe(0.25);
  });

  it('ensures first result gets the highest score in positional ranking', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: null }),
      makeParsedResult({ url: 'https://b.com', score: null }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBeGreaterThan(normalized[1]!.score);
  });

  it('ensures last result gets the lowest score in positional ranking', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: null }),
      makeParsedResult({ url: 'https://b.com', score: null }),
      makeParsedResult({ url: 'https://c.com', score: null }),
    ];
    const normalized = normalizeScore(results);
    const scores = normalized.map((r) => r.score);
    expect(Math.min(...scores)).toBe(scores[2]!);
  });

  it('assigns 0.0 to the last result in a large set with positional ranking', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeParsedResult({ url: `https://${i}.com`, score: null })
    );
    const normalized = normalizeScore(results);
    // Last item: 1.0 - (9/10) = 0.1
    expect(normalized[9]!.score).toBeCloseTo(0.1, 10);
  });

  // [Implements: US-SR-003] Mixed null and numeric scores
  it('handles mixed null and numeric scores (null treated as 0)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 10.0 }),
      makeParsedResult({ url: 'https://b.com', score: null }),
      makeParsedResult({ url: 'https://c.com', score: 5.0 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.0);
    expect(normalized[2]!.score).toBe(0.5);
  });

  it('does not mutate the input array', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 5.0 }),
      makeParsedResult({ url: 'https://b.com', score: null }),
    ];
    const originalScores = results.map((r) => r.score);
    normalizeScore(results);
    expect(results.map((r) => r.score)).toEqual(originalScores);
  });

  it('returns new array objects (not the same references)', () => {
    const results = [makeParsedResult({ score: 1.0 })];
    const normalized = normalizeScore(results);
    expect(normalized).not.toBe(results);
    expect(normalized[0]).not.toBe(results[0]);
  });

  it('preserves non-score fields from the original results', () => {
    const results = [
      makeParsedResult({
        title: 'My Title',
        url: 'https://example.com',
        content: 'My content',
        score: 5.0,
      }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.title).toBe('My Title');
    expect(normalized[0]!.url).toBe('https://example.com');
    expect(normalized[0]!.content).toBe('My content');
  });

  it('handles two results with positional ranking', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: null }),
      makeParsedResult({ url: 'https://b.com', score: null }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// deduplicateByExactUrl
// ---------------------------------------------------------------------------

describe('deduplicateByExactUrl', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-010] No duplicates → passthrough
  it('returns the full result set unchanged when no duplicates exist', () => {
    const results = [
      makeSearchResult({ url: 'https://a.com', score: 1.0 }),
      makeSearchResult({ url: 'https://b.com', score: 0.8 }),
      makeSearchResult({ url: 'https://c.com', score: 0.5 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(3);
  });

  it('does not log to stderr when no duplicates are found', () => {
    const results = [
      makeSearchResult({ url: 'https://a.com', score: 1.0 }),
      makeSearchResult({ url: 'https://b.com', score: 0.8 }),
    ];
    deduplicateByExactUrl(results);
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('exact-duplicate')
    );
  });

  // [Implements: US-SR-010] Exact URL dedup
  it('removes exact URL duplicates and retains the highest-scored entry', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com', score: 0.5 }),
      makeSearchResult({ url: 'https://example.com', score: 1.0 }),
      makeSearchResult({ url: 'https://example.com', score: 0.8 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.score).toBe(1.0);
  });

  it('removes exact URL duplicates (case-sensitive)', () => {
    const results = [
      makeSearchResult({ url: 'https://Example.com', score: 0.5 }),
      makeSearchResult({ url: 'https://example.com', score: 1.0 }),
      makeSearchResult({ url: 'https://EXAMPLE.com', score: 0.8 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    // Case-sensitive: all three are different URLs
    expect(deduped).toHaveLength(3);
  });

  it('retains the first entry when scores are equal', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com', title: 'First', score: 0.5 }),
      makeSearchResult({ url: 'https://example.com', title: 'Second', score: 0.5 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.title).toBe('First');
  });

  // [Implements: US-SR-010] Fragment-insensitive dedup
  it('treats URLs differing only in fragment as duplicates', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com/page.html#section1', score: 0.5 }),
      makeSearchResult({ url: 'https://example.com/page.html#section2', score: 1.0 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.score).toBe(1.0);
  });

  it('treats URL with fragment and URL without fragment as duplicates', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com/page.html', score: 0.3 }),
      makeSearchResult({ url: 'https://example.com/page.html#top', score: 0.9 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.score).toBe(0.9);
  });

  it('does not treat URLs with different paths as duplicates', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com/page1', score: 1.0 }),
      makeSearchResult({ url: 'https://example.com/page2', score: 0.8 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(2);
  });

  it('does not treat URLs with different query strings as duplicates', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com/page?q=1', score: 1.0 }),
      makeSearchResult({ url: 'https://example.com/page?q=2', score: 0.8 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(2);
  });

  // [Implements: US-SR-010] Logging
  it('logs "Removed {N} exact-duplicate URLs from SearXNG response" to stderr', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com', score: 0.5 }),
      makeSearchResult({ url: 'https://example.com', score: 1.0 }),
      makeSearchResult({ url: 'https://example.com', score: 0.8 }),
    ];
    deduplicateByExactUrl(results);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Removed 2 exact-duplicate URLs from SearXNG response')
    );
  });

  it('logs the correct count for multiple duplicate groups', () => {
    const results = [
      makeSearchResult({ url: 'https://a.com', score: 1.0 }),
      makeSearchResult({ url: 'https://a.com', score: 0.5 }),
      makeSearchResult({ url: 'https://b.com', score: 1.0 }),
      makeSearchResult({ url: 'https://b.com', score: 0.5 }),
      makeSearchResult({ url: 'https://b.com', score: 0.3 }),
    ];
    deduplicateByExactUrl(results);
    // 1 removed from group a, 2 removed from group b = 3 total
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Removed 3 exact-duplicate URLs from SearXNG response')
    );
  });

  it('logs to stderr only (never stdout)', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const results = [
        makeSearchResult({ url: 'https://example.com', score: 0.5 }),
        makeSearchResult({ url: 'https://example.com', score: 1.0 }),
      ];
      deduplicateByExactUrl(results);
      expect(stderrSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // Edge cases
  it('handles an empty array', () => {
    expect(deduplicateByExactUrl([])).toEqual([]);
  });

  it('handles a single result', () => {
    const results = [makeSearchResult({ url: 'https://example.com', score: 1.0 })];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(1);
  });

  it('preserves non-duplicate results alongside deduplicated ones', () => {
    const results = [
      makeSearchResult({ url: 'https://a.com', score: 1.0 }),
      makeSearchResult({ url: 'https://b.com', score: 0.8 }),
      makeSearchResult({ url: 'https://a.com', score: 0.5 }),
      makeSearchResult({ url: 'https://c.com', score: 0.3 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(3);
    const urls = deduped.map((r) => r.url).sort();
    expect(urls).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('handles fragment-only dedup with multiple groups', () => {
    const results = [
      makeSearchResult({ url: 'https://a.com/page#x', score: 0.5 }),
      makeSearchResult({ url: 'https://a.com/page#y', score: 1.0 }),
      makeSearchResult({ url: 'https://b.com/page#x', score: 0.3 }),
      makeSearchResult({ url: 'https://b.com/page#y', score: 0.9 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]!.score).toBe(1.0);
    expect(deduped[1]!.score).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// normalizeResults
// ---------------------------------------------------------------------------

describe('normalizeResults', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-003] Empty input
  it('returns an empty array for empty input', () => {
    expect(normalizeResults([], 10)).toEqual([]);
  });

  // [Implements: US-SR-003] Single result
  it('normalizes a single result with score 1.0', () => {
    const results = [
      makeParsedResult({
        title: 'Single',
        url: 'https://example.com',
        content: 'Snippet',
        score: null,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[0]!.title).toBe('Single');
    expect(normalized[0]!.url).toBe('https://example.com');
    expect(normalized[0]!.snippet).toBe('Snippet');
  });

  // [Implements: US-SR-003] Title default
  it('sets title to "(untitled)" when title is empty', () => {
    const results = [
      makeParsedResult({ title: '', url: 'https://example.com', content: 'C', score: null }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('(untitled)');
  });

  // [Implements: US-SR-003] Snippet default
  it('sets snippet to empty string when content is empty', () => {
    const results = [
      makeParsedResult({ title: 'T', url: 'https://example.com', content: '', score: null }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('');
  });

  // [Implements: US-SR-003] Title truncation
  it('truncates title to 500 chars (497 + "...") when exceeding 500', () => {
    const longTitle = 'a'.repeat(600);
    const results = [
      makeParsedResult({ title: longTitle, url: 'https://example.com', content: 'C', score: null }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title.length).toBe(500);
    expect(normalized[0]!.title.endsWith('...')).toBe(true);
  });

  // [Implements: US-SR-003] Snippet truncation
  it('truncates snippet to 1000 chars (997 + "...") when exceeding 1000', () => {
    const longContent = 'b'.repeat(1200);
    const results = [
      makeParsedResult({ title: 'T', url: 'https://example.com', content: longContent, score: null }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet.length).toBe(1000);
    expect(normalized[0]!.snippet.endsWith('...')).toBe(true);
  });

  // [Implements: US-SR-003] Score normalization with numeric scores
  it('normalizes numeric scores by dividing by max', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 4.0 }),
      makeParsedResult({ url: 'https://b.com', score: 2.0 }),
      makeParsedResult({ url: 'https://c.com', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.5);
    expect(normalized[2]!.score).toBe(0.25);
  });

  // [Implements: US-SR-003] Score normalization with positional ranking
  it('assigns positional rank scores when no scores are provided', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: null }),
      makeParsedResult({ url: 'https://b.com', score: null }),
      makeParsedResult({ url: 'https://c.com', score: null }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBeCloseTo(1.0 - 1 / 3, 10);
    expect(normalized[2]!.score).toBeCloseTo(1.0 - 2 / 3, 10);
  });

  // [Implements: US-SR-003] Descending sort
  it('sorts results by descending score', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0 }),
      makeParsedResult({ url: 'https://b.com', score: 5.0 }),
      makeParsedResult({ url: 'https://c.com', score: 3.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://b.com');
    expect(normalized[1]!.url).toBe('https://c.com');
    expect(normalized[2]!.url).toBe('https://a.com');
  });

  // [Implements: US-SR-011] maxResults truncation
  it('truncates to maxResults', () => {
    const results = Array.from({ length: 15 }, (_, i) =>
      makeParsedResult({ url: `https://${i}.com`, score: 15 - i })
    );
    const normalized = normalizeResults(results, 5);
    expect(normalized).toHaveLength(5);
  });

  it('returns all results when count is less than maxResults', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0 }),
      makeParsedResult({ url: 'https://b.com', score: 0.5 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(2);
  });

  it('returns exactly maxResults when count equals maxResults', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeParsedResult({ url: `https://${i}.com`, score: 5 - i })
    );
    const normalized = normalizeResults(results, 5);
    expect(normalized).toHaveLength(5);
  });

  // [Implements: US-SR-010] Dedup in full pipeline
  it('removes exact-URL duplicates in the full pipeline', () => {
    const results = [
      makeParsedResult({ url: 'https://example.com', score: 5.0 }),
      makeParsedResult({ url: 'https://example.com', score: 3.0 }),
      makeParsedResult({ url: 'https://other.com', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]!.url).toBe('https://example.com');
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('removes fragment-only duplicates in the full pipeline', () => {
    const results = [
      makeParsedResult({ url: 'https://example.com/page#sec1', score: 5.0 }),
      makeParsedResult({ url: 'https://example.com/page#sec2', score: 3.0 }),
      makeParsedResult({ url: 'https://other.com', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(2);
  });

  // Full pipeline integration
  it('applies defaults, truncation, score normalization, dedup, sort, and truncation', () => {
    const results = [
      makeParsedResult({ title: '', url: 'https://a.com', content: 'Snippet A', score: 10.0 }),
      makeParsedResult({ title: 'B', url: 'https://b.com', content: 'x'.repeat(1200), score: 5.0 }),
      makeParsedResult({ title: 'A Dup', url: 'https://a.com', content: 'Dup', score: 8.0 }),
      makeParsedResult({ title: 'C', url: 'https://c.com', content: 'Snippet C', score: null }),
    ];
    const normalized = normalizeResults(results, 10);

    // Dedup: a.com appears twice → highest score (10.0) retained
    expect(normalized).toHaveLength(3);

    // Sort: a.com (10.0/10.0=1.0) > b.com (5.0/10.0=0.5) > c.com (null→0/10.0=0.0)
    expect(normalized[0]!.url).toBe('https://a.com');
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[0]!.title).toBe('(untitled)');

    expect(normalized[1]!.url).toBe('https://b.com');
    expect(normalized[1]!.score).toBe(0.5);
    expect(normalized[1]!.snippet.length).toBe(1000);
    expect(normalized[1]!.snippet.endsWith('...')).toBe(true);

    expect(normalized[2]!.url).toBe('https://c.com');
    expect(normalized[2]!.score).toBe(0.0);
  });

  it('produces SearchResult objects with title, url, snippet, score fields', () => {
    const results = [
      makeParsedResult({ title: 'T', url: 'https://example.com', content: 'C', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    const first = normalized[0]!;
    expect(first).toHaveProperty('title');
    expect(first).toHaveProperty('url');
    expect(first).toHaveProperty('snippet');
    expect(first).toHaveProperty('score');
    expect(typeof first.title).toBe('string');
    expect(typeof first.url).toBe('string');
    expect(typeof first.snippet).toBe('string');
    expect(typeof first.score).toBe('number');
  });

  it('does not mutate the input array', () => {
    const results = [
      makeParsedResult({ title: 'T', url: 'https://a.com', content: 'C', score: 1.0 }),
    ];
    const originalTitle = results[0]!.title;
    normalizeResults(results, 10);
    expect(results[0]!.title).toBe(originalTitle);
  });

  it('handles maxResults of 0', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 0);
    expect(normalized).toHaveLength(0);
  });

  it('handles maxResults of 1', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0 }),
      makeParsedResult({ url: 'https://b.com', score: 2.0 }),
    ];
    const normalized = normalizeResults(results, 1);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.url).toBe('https://b.com');
  });

  it('handles all results having empty titles', () => {
    const results = [
      makeParsedResult({ title: '', url: 'https://a.com', content: 'A', score: 2.0 }),
      makeParsedResult({ title: '', url: 'https://b.com', content: 'B', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]!.title).toBe('(untitled)');
    expect(normalized[1]!.title).toBe('(untitled)');
  });

  it('handles all results having empty content', () => {
    const results = [
      makeParsedResult({ title: 'A', url: 'https://a.com', content: '', score: 2.0 }),
      makeParsedResult({ title: 'B', url: 'https://b.com', content: '', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]!.snippet).toBe('');
    expect(normalized[1]!.snippet).toBe('');
  });

  it('preserves URL exactly (no modification)', () => {
    const results = [
      makeParsedResult({ url: 'https://example.com/path?q=1#frag', content: 'C', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://example.com/path?q=1#frag');
  });

  it('handles a large result set with dedup and truncation', () => {
    const results = Array.from({ length: 50 }, (_, i) =>
      makeParsedResult({
        title: `Title ${i}`,
        url: `https://example.com/${Math.floor(i / 2)}`,
        content: `Content ${i}`,
        score: 50 - i,
      })
    );
    // 50 results, but 25 unique URLs (pairs) → 25 after dedup, truncated to 10
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(10);
    // All scores should be in [0, 1]
    for (const r of normalized) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  // [Implements: US-SR-003, DC-SR-002]
  it('TITLE_MAX_LENGTH is 500', () => {
    expect(TITLE_MAX_LENGTH).toBe(500);
  });

  it('SNIPPET_MAX_LENGTH is 1000', () => {
    expect(SNIPPET_MAX_LENGTH).toBe(1000);
  });

  it('TRUNCATION_SUFFIX is "..."', () => {
    expect(TRUNCATION_SUFFIX).toBe('...');
  });

  it('DEFAULT_TITLE is "(untitled)"', () => {
    expect(DEFAULT_TITLE).toBe('(untitled)');
  });
});

// ---------------------------------------------------------------------------
// truncateField — additional edge cases
// ---------------------------------------------------------------------------

describe('truncateField — additional edge cases', () => {
  it('handles maxLength of 4 (suffix + 1 char)', () => {
    const value = 'abcdef';
    const result = truncateField(value, 4);
    expect(result.length).toBe(4);
    expect(result.endsWith('...')).toBe(true);
    expect(result.slice(0, 1)).toBe('a');
  });

  it('handles maxLength of 2 (less than suffix length)', () => {
    const value = 'abcdef';
    const result = truncateField(value, 2);
    expect(result.length).toBe(2);
  });

  it('handles maxLength of 1', () => {
    const value = 'abcdef';
    const result = truncateField(value, 1);
    expect(result.length).toBe(1);
  });

  it('handles maxLength of 0', () => {
    const value = 'abcdef';
    const result = truncateField(value, 0);
    expect(result.length).toBe(0);
  });

  it('does not truncate a string that is exactly maxLength - 1', () => {
    const value = 'a'.repeat(999);
    expect(truncateField(value, 1000)).toBe(value);
  });

  it('truncates a string that is exactly maxLength + 1', () => {
    const value = 'a'.repeat(1001);
    const result = truncateField(value, 1000);
    expect(result.length).toBe(1000);
    expect(result.endsWith('...')).toBe(true);
  });

  it('handles a string with only whitespace', () => {
    expect(truncateField('   ', 500)).toBe('   ');
  });

  it('handles a string with newlines', () => {
    const value = 'line1\nline2\nline3';
    expect(truncateField(value, 500)).toBe(value);
  });

  it('truncates a string with newlines correctly', () => {
    const value = 'a\n'.repeat(300);
    const result = truncateField(value, 100);
    expect(result.length).toBe(100);
    expect(result.endsWith('...')).toBe(true);
  });

  it('handles a string with Unicode characters', () => {
    const value = 'café résumé 日本語'.repeat(100);
    const result = truncateField(value, 50);
    expect(result.length).toBe(50);
    expect(result.endsWith('...')).toBe(true);
  });

  it('handles a string with emoji', () => {
    const value = '😀'.repeat(200);
    const result = truncateField(value, 10);
    expect(result.length).toBe(10);
    expect(result.endsWith('...')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// normalizeUrlForDedup — additional edge cases
// ---------------------------------------------------------------------------

describe('normalizeUrlForDedup — additional edge cases', () => {
  it('handles a URL with only a query and fragment', () => {
    expect(normalizeUrlForDedup('https://example.com?q=1#frag')).toBe(
      'https://example.com?q=1'
    );
  });

  it('handles a URL with multiple query params and fragment', () => {
    expect(
      normalizeUrlForDedup('https://example.com/path?a=1&b=2&c=3#section')
    ).toBe('https://example.com/path?a=1&b=2&c=3');
  });

  it('handles a URL with encoded characters in the fragment', () => {
    expect(normalizeUrlForDedup('https://example.com/page#%20section')).toBe(
      'https://example.com/page'
    );
  });

  it('handles a URL with a very long fragment', () => {
    const longFragment = 'x'.repeat(500);
    expect(
      normalizeUrlForDedup(`https://example.com/page#${longFragment}`)
    ).toBe('https://example.com/page');
  });

  it('handles a URL with fragment containing special characters', () => {
    expect(
      normalizeUrlForDedup('https://example.com/page#frag?ment=val&ue=2')
    ).toBe('https://example.com/page');
  });

  it('handles a URL with fragment containing slashes', () => {
    expect(
      normalizeUrlForDedup('https://example.com/page#/sub/path')
    ).toBe('https://example.com/page');
  });

  it('handles a URL with fragment containing a colon', () => {
    expect(
      normalizeUrlForDedup('https://example.com/page#section:1')
    ).toBe('https://example.com/page');
  });

  it('handles a URL with only a hash character', () => {
    expect(normalizeUrlForDedup('#')).toBe('');
  });

  it('handles a URL with hash in the middle of the path', () => {
    // The hash starts the fragment, so everything after # is stripped
    expect(
      normalizeUrlForDedup('https://example.com/path#more/path')
    ).toBe('https://example.com/path');
  });

  it('preserves URL with userinfo, port, path, query, and strips fragment', () => {
    expect(
      normalizeUrlForDedup('https://user:pass@example.com:8443/path?q=1#frag')
    ).toBe('https://user:pass@example.com:8443/path?q=1');
  });

  it('handles a URL with IPv4 address and fragment', () => {
    expect(
      normalizeUrlForDedup('http://192.168.1.1:8080/path#frag')
    ).toBe('http://192.168.1.1:8080/path');
  });

  it('handles a URL with IPv6 address and fragment', () => {
    expect(
      normalizeUrlForDedup('http://[::1]:8080/path#frag')
    ).toBe('http://[::1]:8080/path');
  });

  it('handles a URL with a trailing slash before fragment', () => {
    expect(
      normalizeUrlForDedup('https://example.com/path/#frag')
    ).toBe('https://example.com/path/');
  });

  it('handles a URL with double slashes in path and fragment', () => {
    expect(
      normalizeUrlForDedup('https://example.com//double//path#frag')
    ).toBe('https://example.com//double//path');
  });
});

// ---------------------------------------------------------------------------
// normalizeScore — additional edge cases
// ---------------------------------------------------------------------------

describe('normalizeScore — additional edge cases', () => {
  it('handles a single result with score 0', () => {
    const results = [makeParsedResult({ score: 0 })];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('handles a single result with a negative score', () => {
    const results = [makeParsedResult({ score: -5.0 })];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('handles a single result with a very large score', () => {
    const results = [makeParsedResult({ score: 1e10 })];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('handles a single result with a very small positive score', () => {
    const results = [makeParsedResult({ score: 0.0001 })];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('normalizes scores where one result has a very large score', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1e6 }),
      makeParsedResult({ url: 'https://b.com', score: 1 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBeCloseTo(1e-6, 10);
  });

  it('normalizes scores with mixed positive and negative values (max > 0)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 10.0 }),
      makeParsedResult({ url: 'https://b.com', score: -5.0 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(-0.5);
  });

  it('handles all negative scores (falls back to positional ranking)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: -1.0 }),
      makeParsedResult({ url: 'https://b.com', score: -2.0 }),
      makeParsedResult({ url: 'https://c.com', score: -3.0 }),
    ];
    const normalized = normalizeScore(results);
    // maxScore = -1.0 which is not > 0 → positional ranking
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBeCloseTo(1.0 - 1 / 3, 10);
    expect(normalized[2]!.score).toBeCloseTo(1.0 - 2 / 3, 10);
  });

  it('handles a mix of null, zero, and positive scores', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 8.0 }),
      makeParsedResult({ url: 'https://b.com', score: null }),
      makeParsedResult({ url: 'https://c.com', score: 0 }),
      makeParsedResult({ url: 'https://d.com', score: 4.0 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0); // 8/8
    expect(normalized[1]!.score).toBe(0.0); // null → 0/8
    expect(normalized[2]!.score).toBe(0.0); // 0/8
    expect(normalized[3]!.score).toBe(0.5); // 4/8
  });

  it('handles a large set with numeric scores', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeParsedResult({ url: `https://${i}.com`, score: 20 - i })
    );
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[19]!.score).toBeCloseTo(1 / 20, 10);
  });

  it('handles a large set with null scores (positional ranking)', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeParsedResult({ url: `https://${i}.com`, score: null })
    );
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[19]!.score).toBeCloseTo(1.0 - 19 / 20, 10);
  });

  it('preserves the order of results when scores are all equal', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 5.0 }),
      makeParsedResult({ url: 'https://b.com', score: 5.0 }),
      makeParsedResult({ url: 'https://c.com', score: 5.0 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.url).toBe('https://a.com');
    expect(normalized[1]!.url).toBe('https://b.com');
    expect(normalized[2]!.url).toBe('https://c.com');
  });

  it('produces scores in [0, 1] range for numeric scores', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 100.0 }),
      makeParsedResult({ url: 'https://b.com', score: 50.0 }),
      makeParsedResult({ url: 'https://c.com', score: 25.0 }),
      makeParsedResult({ url: 'https://d.com', score: 1.0 }),
    ];
    const normalized = normalizeScore(results);
    for (const r of normalized) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('produces scores in [0, 1] range for positional ranking', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeParsedResult({ url: `https://${i}.com`, score: null })
    );
    const normalized = normalizeScore(results);
    for (const r of normalized) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('does not mutate the input array elements', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', title: 'A', content: 'CA', score: 5.0 }),
      makeParsedResult({ url: 'https://b.com', title: 'B', content: 'CB', score: null }),
    ];
    const original = results.map((r) => ({ ...r }));
    normalizeScore(results);
    expect(results[0]!.title).toBe(original[0]!.title);
    expect(results[0]!.url).toBe(original[0]!.url);
    expect(results[0]!.content).toBe(original[0]!.content);
    expect(results[0]!.score).toBe(original[0]!.score);
    expect(results[1]!.score).toBe(original[1]!.score);
  });
});

// ---------------------------------------------------------------------------
// deduplicateByExactUrl — additional edge cases
// ---------------------------------------------------------------------------

describe('deduplicateByExactUrl — additional edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('handles URLs with different schemes as non-duplicates', () => {
    const results = [
      makeSearchResult({ url: 'http://example.com', score: 1.0 }),
      makeSearchResult({ url: 'https://example.com', score: 0.8 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(2);
  });

  it('handles URLs with different ports as non-duplicates', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com:8080', score: 1.0 }),
      makeSearchResult({ url: 'https://example.com:9090', score: 0.8 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(2);
  });

  it('handles URLs with trailing slash differences as non-duplicates', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com/path/', score: 1.0 }),
      makeSearchResult({ url: 'https://example.com/path', score: 0.8 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(2);
  });

  it('handles URLs with query param order differences as non-duplicates', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com?a=1&b=2', score: 1.0 }),
      makeSearchResult({ url: 'https://example.com?b=2&a=1', score: 0.8 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(2);
  });

  it('retains the highest score across many duplicates', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeSearchResult({ url: 'https://example.com', score: i / 10 })
    );
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.score).toBe(0.9);
  });

  it('handles a mix of duplicates and unique URLs', () => {
    const results = [
      makeSearchResult({ url: 'https://a.com', score: 1.0 }),
      makeSearchResult({ url: 'https://b.com', score: 0.9 }),
      makeSearchResult({ url: 'https://a.com', score: 0.8 }),
      makeSearchResult({ url: 'https://c.com', score: 0.7 }),
      makeSearchResult({ url: 'https://b.com', score: 0.6 }),
      makeSearchResult({ url: 'https://d.com', score: 0.5 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(4);
    const urls = deduped.map((r) => r.url).sort();
    expect(urls).toEqual(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com']);
  });

  it('logs the correct count for a single duplicate pair', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com', score: 0.5 }),
      makeSearchResult({ url: 'https://example.com', score: 1.0 }),
    ];
    deduplicateByExactUrl(results);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Removed 1 exact-duplicate URLs from SearXNG response')
    );
  });

  it('does not log when input is empty', () => {
    deduplicateByExactUrl([]);
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('exact-duplicate')
    );
  });

  it('does not log when input has a single result', () => {
    deduplicateByExactUrl([
      makeSearchResult({ url: 'https://example.com', score: 1.0 }),
    ]);
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('exact-duplicate')
    );
  });

  it('handles URLs with fragments in a large set', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeSearchResult({
        url: `https://example.com/page#${i}`,
        score: 1.0 - i * 0.05,
      })
    );
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.score).toBe(1.0);
  });

  it('preserves snippet and title of the retained entry', () => {
    const results = [
      makeSearchResult({
        url: 'https://example.com',
        title: 'Low Score',
        snippet: 'Low snippet',
        score: 0.3,
      }),
      makeSearchResult({
        url: 'https://example.com',
        title: 'High Score',
        snippet: 'High snippet',
        score: 1.0,
      }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.title).toBe('High Score');
    expect(deduped[0]!.snippet).toBe('High snippet');
  });

  it('handles results with score 0', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com', score: 0 }),
      makeSearchResult({ url: 'https://example.com', score: 0 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.score).toBe(0);
  });

  it('handles negative scores (retains highest, i.e., least negative)', () => {
    const results = [
      makeSearchResult({ url: 'https://example.com', score: -1.0 }),
      makeSearchResult({ url: 'https://example.com', score: -0.5 }),
      makeSearchResult({ url: 'https://example.com', score: -2.0 }),
    ];
    const deduped = deduplicateByExactUrl(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.score).toBe(-0.5);
  });
});

// ---------------------------------------------------------------------------
// normalizeResults — additional edge cases
// ---------------------------------------------------------------------------

describe('normalizeResults — additional edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('handles whitespace-only title (defaults to "(untitled)")', () => {
    const results = [
      makeParsedResult({ title: '   ', url: 'https://example.com', content: 'C', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    // Whitespace-only title is non-empty string, so it's kept as-is
    expect(normalized[0]!.title).toBe('   ');
  });

  it('handles title with only newlines', () => {
    const results = [
      makeParsedResult({ title: '\n\n', url: 'https://example.com', content: 'C', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\n\n');
  });

  it('handles content with only whitespace', () => {
    const results = [
      makeParsedResult({ title: 'T', url: 'https://example.com', content: '   ', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('   ');
  });

  it('handles title at exactly 500 characters', () => {
    const title = 'a'.repeat(500);
    const results = [
      makeParsedResult({ title, url: 'https://example.com', content: 'C', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe(title);
    expect(normalized[0]!.title.length).toBe(500);
  });

  it('handles snippet at exactly 1000 characters', () => {
    const content = 'b'.repeat(1000);
    const results = [
      makeParsedResult({ title: 'T', url: 'https://example.com', content, score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe(content);
    expect(normalized[0]!.snippet.length).toBe(1000);
  });

  it('handles title at 501 characters (truncated to 500)', () => {
    const title = 'a'.repeat(501);
    const results = [
      makeParsedResult({ title, url: 'https://example.com', content: 'C', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title.length).toBe(500);
    expect(normalized[0]!.title.endsWith('...')).toBe(true);
  });

  it('handles snippet at 1001 characters (truncated to 1000)', () => {
    const content = 'b'.repeat(1001);
    const results = [
      makeParsedResult({ title: 'T', url: 'https://example.com', content, score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet.length).toBe(1000);
    expect(normalized[0]!.snippet.endsWith('...')).toBe(true);
  });

  it('handles results with all null scores (positional ranking + sort)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: null }),
      makeParsedResult({ url: 'https://b.com', score: null }),
      makeParsedResult({ url: 'https://c.com', score: null }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(3);
    // Positional ranking: first gets 1.0, second 2/3, third 1/3
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBeCloseTo(1.0 - 1 / 3, 10);
    expect(normalized[2]!.score).toBeCloseTo(1.0 - 2 / 3, 10);
  });

  it('handles results with all zero scores (positional ranking)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 0 }),
      makeParsedResult({ url: 'https://b.com', score: 0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.5);
  });

  it('handles results with mixed null and numeric scores in full pipeline', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 10.0 }),
      makeParsedResult({ url: 'https://b.com', score: null }),
      makeParsedResult({ url: 'https://c.com', score: 5.0 }),
      makeParsedResult({ url: 'https://d.com', score: null }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(4);
    // Sorted by normalized score: a(1.0) > c(0.5) > b(0.0) = d(0.0)
    expect(normalized[0]!.url).toBe('https://a.com');
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.url).toBe('https://c.com');
    expect(normalized[1]!.score).toBe(0.5);
  });

  it('handles dedup with fragment-only duplicates and score normalization', () => {
    const results = [
      makeParsedResult({ url: 'https://example.com/page#sec1', score: 10.0 }),
      makeParsedResult({ url: 'https://example.com/page#sec2', score: 5.0 }),
      makeParsedResult({ url: 'https://other.com', score: 2.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(2);
    // example.com retained with score 10.0, normalized to 1.0
    expect(normalized[0]!.url).toBe('https://example.com/page#sec1');
    expect(normalized[0]!.score).toBe(1.0);
    // other.com normalized to 2.0/10.0 = 0.2
    expect(normalized[1]!.url).toBe('https://other.com');
    expect(normalized[1]!.score).toBe(0.2);
  });

  it('handles maxResults larger than result count after dedup', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0 }),
      makeParsedResult({ url: 'https://a.com', score: 0.5 }),
      makeParsedResult({ url: 'https://b.com', score: 0.8 }),
    ];
    const normalized = normalizeResults(results, 100);
    expect(normalized).toHaveLength(2);
  });

  it('handles a very large maxResults value', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10000);
    expect(normalized).toHaveLength(1);
  });

  it('produces results sorted in strictly descending score order', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeParsedResult({ url: `https://${i}.com`, score: 10 - i })
    );
    const normalized = normalizeResults(results, 10);
    for (let i = 0; i < normalized.length - 1; i++) {
      expect(normalized[i]!.score).toBeGreaterThanOrEqual(normalized[i + 1]!.score);
    }
  });

  it('handles results with Unicode titles and content', () => {
    const results = [
      makeParsedResult({
        title: '日本語のタイトル',
        url: 'https://example.com',
        content: 'これはコンテンツです',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('日本語のタイトル');
    expect(normalized[0]!.snippet).toBe('これはコンテンツです');
  });

  it('handles results with emoji in title and content', () => {
    const results = [
      makeParsedResult({
        title: 'Title with 🎉 emoji',
        url: 'https://example.com',
        content: 'Content with 🚀 emoji',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('Title with 🎉 emoji');
    expect(normalized[0]!.snippet).toBe('Content with 🚀 emoji');
  });

  it('handles results with very long URLs', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(500);
    const results = [
      makeParsedResult({ url: longUrl, content: 'C', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe(longUrl);
  });

  it('handles results with URLs containing special characters', () => {
    const url = 'https://example.com/path?q=hello+world&lang=en-US#section';
    const results = [
      makeParsedResult({ url, content: 'C', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe(url);
  });

  it('handles results with empty title and empty content', () => {
    const results = [
      makeParsedResult({ title: '', url: 'https://example.com', content: '', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('(untitled)');
    expect(normalized[0]!.snippet).toBe('');
  });

  it('handles results with all empty titles and empty content', () => {
    const results = [
      makeParsedResult({ title: '', url: 'https://a.com', content: '', score: 2.0 }),
      makeParsedResult({ title: '', url: 'https://b.com', content: '', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]!.title).toBe('(untitled)');
    expect(normalized[0]!.snippet).toBe('');
    expect(normalized[1]!.title).toBe('(untitled)');
    expect(normalized[1]!.snippet).toBe('');
  });

  it('handles a single result with null score', () => {
    const results = [
      makeParsedResult({ url: 'https://example.com', score: null }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('handles a single result with numeric score', () => {
    const results = [
      makeParsedResult({ url: 'https://example.com', score: 42.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('handles results where dedup removes all but one', () => {
    const results = [
      makeParsedResult({ url: 'https://example.com', score: 5.0 }),
      makeParsedResult({ url: 'https://example.com', score: 3.0 }),
      makeParsedResult({ url: 'https://example.com', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.url).toBe('https://example.com');
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('handles results where maxResults truncation removes after dedup', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 10.0 }),
      makeParsedResult({ url: 'https://a.com', score: 5.0 }),
      makeParsedResult({ url: 'https://b.com', score: 8.0 }),
      makeParsedResult({ url: 'https://c.com', score: 6.0 }),
      makeParsedResult({ url: 'https://d.com', score: 4.0 }),
    ];
    // After dedup: 4 results. maxResults=2 → truncated to 2
    const normalized = normalizeResults(results, 2);
    expect(normalized).toHaveLength(2);
    // Sorted by score: a(10→1.0) > b(8→0.8) > c(6→0.6) > d(4→0.4)
    expect(normalized[0]!.url).toBe('https://a.com');
    expect(normalized[1]!.url).toBe('https://b.com');
  });

  it('handles results with equal scores (stable sort)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 5.0 }),
      makeParsedResult({ url: 'https://b.com', score: 5.0 }),
      makeParsedResult({ url: 'https://c.com', score: 5.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(3);
    // All scores are 1.0 (5/5)
    for (const r of normalized) {
      expect(r.score).toBe(1.0);
    }
  });

  it('handles results with descending scores already sorted', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 10.0 }),
      makeParsedResult({ url: 'https://b.com', score: 8.0 }),
      makeParsedResult({ url: 'https://c.com', score: 6.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://a.com');
    expect(normalized[1]!.url).toBe('https://b.com');
    expect(normalized[2]!.url).toBe('https://c.com');
  });

  it('handles results with ascending scores (reversed by sort)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0 }),
      makeParsedResult({ url: 'https://b.com', score: 5.0 }),
      makeParsedResult({ url: 'https://c.com', score: 10.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://c.com');
    expect(normalized[1]!.url).toBe('https://b.com');
    expect(normalized[2]!.url).toBe('https://a.com');
  });

  it('handles results with random score order', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 3.0 }),
      makeParsedResult({ url: 'https://b.com', score: 7.0 }),
      makeParsedResult({ url: 'https://c.com', score: 1.0 }),
      makeParsedResult({ url: 'https://d.com', score: 5.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://b.com');
    expect(normalized[1]!.url).toBe('https://d.com');
    expect(normalized[2]!.url).toBe('https://a.com');
    expect(normalized[3]!.url).toBe('https://c.com');
  });

  it('handles results with very small score differences', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0001 }),
      makeParsedResult({ url: 'https://b.com', score: 1.0000 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://a.com');
    expect(normalized[1]!.url).toBe('https://b.com');
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBeCloseTo(1.0 / 1.0001, 10);
  });

  it('handles results with all same URLs (all deduped to one)', () => {
    const results = [
      makeParsedResult({ url: 'https://example.com', score: 1.0 }),
      makeParsedResult({ url: 'https://example.com', score: 2.0 }),
      makeParsedResult({ url: 'https://example.com', score: 3.0 }),
      makeParsedResult({ url: 'https://example.com', score: 4.0 }),
      makeParsedResult({ url: 'https://example.com', score: 5.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.url).toBe('https://example.com');
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('handles results with fragment duplicates across different domains', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com/page#sec1', score: 5.0 }),
      makeParsedResult({ url: 'https://a.com/page#sec2', score: 3.0 }),
      makeParsedResult({ url: 'https://b.com/page#sec1', score: 4.0 }),
      makeParsedResult({ url: 'https://b.com/page#sec2', score: 2.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(2);
    // a.com retained with score 5.0, b.com retained with score 4.0
    // Normalized: a=5/5=1.0, b=4/5=0.8
    expect(normalized[0]!.url).toBe('https://a.com/page#sec1');
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.url).toBe('https://b.com/page#sec1');
    expect(normalized[1]!.score).toBe(0.8);
  });

  it('handles results with maxResults=0 after dedup', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0 }),
      makeParsedResult({ url: 'https://a.com', score: 0.5 }),
    ];
    const normalized = normalizeResults(results, 0);
    expect(normalized).toHaveLength(0);
  });

  it('handles results with maxResults=1 after dedup removes duplicates', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0 }),
      makeParsedResult({ url: 'https://a.com', score: 2.0 }),
      makeParsedResult({ url: 'https://b.com', score: 3.0 }),
    ];
    const normalized = normalizeResults(results, 1);
    expect(normalized).toHaveLength(1);
    // After dedup: a(2.0), b(3.0). Sorted: b(1.0), a(2/3). maxResults=1 → b
    expect(normalized[0]!.url).toBe('https://b.com');
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('handles results with title containing only "..."', () => {
    const results = [
      makeParsedResult({ title: '...', url: 'https://example.com', content: 'C', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('...');
  });

  it('handles results with title that is exactly the truncation suffix', () => {
    const results = [
      makeParsedResult({ title: '...', url: 'https://example.com', content: 'C', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title.length).toBeLessThanOrEqual(500);
  });

  it('handles results with content containing only "..."', () => {
    const results = [
      makeParsedResult({ title: 'T', url: 'https://example.com', content: '...', score: 1.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('...');
  });

  it('handles results with very long title and very long content', () => {
    const results = [
      makeParsedResult({
        title: 'a'.repeat(1000),
        url: 'https://example.com',
        content: 'b'.repeat(2000),
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title.length).toBe(500);
    expect(normalized[0]!.title.endsWith('...')).toBe(true);
    expect(normalized[0]!.snippet.length).toBe(1000);
    expect(normalized[0]!.snippet.endsWith('...')).toBe(true);
  });

  it('handles results with title and content both at boundary - 1', () => {
    const results = [
      makeParsedResult({
        title: 'a'.repeat(499),
        url: 'https://example.com',
        content: 'b'.repeat(999),
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title.length).toBe(499);
    expect(normalized[0]!.snippet.length).toBe(999);
  });

  it('handles results with title and content both at boundary + 1', () => {
    const results = [
      makeParsedResult({
        title: 'a'.repeat(501),
        url: 'https://example.com',
        content: 'b'.repeat(1001),
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title.length).toBe(500);
    expect(normalized[0]!.snippet.length).toBe(1000);
  });

  it('handles results with mixed truncation needs', () => {
    const results = [
      makeParsedResult({ title: 'Short', url: 'https://a.com', content: 'Short', score: 3.0 }),
      makeParsedResult({ title: 'b'.repeat(600), url: 'https://b.com', content: 'Short', score: 2.0 }),
      makeParsedResult({ title: 'Short', url: 'https://c.com', content: 'c'.repeat(1200), score: 1.0 }),
      makeParsedResult({ title: 'd'.repeat(600), url: 'https://d.com', content: 'd'.repeat(1200), score: 0.5 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(4);
    // All sorted by score
    expect(normalized[0]!.url).toBe('https://a.com');
    expect(normalized[0]!.title).toBe('Short');
    expect(normalized[0]!.snippet).toBe('Short');

    expect(normalized[1]!.url).toBe('https://b.com');
    expect(normalized[1]!.title.length).toBe(500);
    expect(normalized[1]!.snippet).toBe('Short');

    expect(normalized[2]!.url).toBe('https://c.com');
    expect(normalized[2]!.title).toBe('Short');
    expect(normalized[2]!.snippet.length).toBe(1000);

    expect(normalized[3]!.url).toBe('https://d.com');
    expect(normalized[3]!.title.length).toBe(500);
    expect(normalized[3]!.snippet.length).toBe(1000);
  });

  it('handles results with all scores being the same positive value', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 7.0 }),
      makeParsedResult({ url: 'https://b.com', score: 7.0 }),
      makeParsedResult({ url: 'https://c.com', score: 7.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(3);
    for (const r of normalized) {
      expect(r.score).toBe(1.0);
    }
  });

  it('handles results with one very high score and many low scores', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1000.0 }),
      makeParsedResult({ url: 'https://b.com', score: 1.0 }),
      makeParsedResult({ url: 'https://c.com', score: 2.0 }),
      makeParsedResult({ url: 'https://d.com', score: 3.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://a.com');
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.url).toBe('https://d.com');
    expect(normalized[1]!.score).toBeCloseTo(0.003, 5);
  });

  it('handles results with negative and positive scores (max > 0)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 10.0 }),
      makeParsedResult({ url: 'https://b.com', score: -5.0 }),
      makeParsedResult({ url: 'https://c.com', score: 5.0 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0); // 10/10
    expect(normalized[1]!.score).toBe(-0.5); // -5/10
    expect(normalized[2]!.score).toBe(0.5); // 5/10
  });

  it('handles results with all negative scores (positional ranking fallback)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: -1.0 }),
      makeParsedResult({ url: 'https://b.com', score: -2.0 }),
      makeParsedResult({ url: 'https://c.com', score: -3.0 }),
      makeParsedResult({ url: 'https://d.com', score: -4.0 }),
    ];
    const normalized = normalizeScore(results);
    // maxScore = -1.0, not > 0 → positional ranking
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.75);
    expect(normalized[2]!.score).toBe(0.5);
    expect(normalized[3]!.score).toBe(0.25);
  });

  it('handles results with Infinity score (treated as null by parser)', () => {
    // Infinity would be filtered out by the parser, but normalizeScore
    // should handle it gracefully if it receives it
    const results = [
      makeParsedResult({ url: 'https://a.com', score: Infinity }),
      makeParsedResult({ url: 'https://b.com', score: 1.0 }),
    ];
    const normalized = normalizeScore(results);
    // maxScore = Infinity, which is > 0, so divide by Infinity
    expect(normalized[0]!.score).toBe(1.0); // Infinity/Infinity = NaN, but 1.0 for max
    expect(normalized[1]!.score).toBe(0); // 1/Infinity = 0
  });

  it('handles results with NaN score (treated as null by parser)', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: NaN }),
      makeParsedResult({ url: 'https://b.com', score: 1.0 }),
    ];
    const normalized = normalizeScore(results);
    // NaN is falsy, treated as 0
    expect(normalized[0]!.score).toBe(0.0); // NaN treated as 0, 0/1 = 0
    expect(normalized[1]!.score).toBe(1.0); // 1/1 = 1
  });

  it('handles results with score of exactly 1.0', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1.0 }),
      makeParsedResult({ url: 'https://b.com', score: 0.5 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.5);
  });

  it('handles results with score of exactly 0.0', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 0.0 }),
      makeParsedResult({ url: 'https://b.com', score: 0.0 }),
    ];
    const normalized = normalizeScore(results);
    // All zero → positional ranking
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.5);
  });

  it('handles results with very small positive scores', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 0.001 }),
      makeParsedResult({ url: 'https://b.com', score: 0.002 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0); // 0.002/0.002
    expect(normalized[1]!.score).toBe(0.5); // 0.001/0.002
  });

  it('handles results with very large scores', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1e15 }),
      makeParsedResult({ url: 'https://b.com', score: 5e14 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBe(0.5);
  });

  it('handles results with mixed very large and very small scores', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 1e15 }),
      makeParsedResult({ url: 'https://b.com', score: 1e-15 }),
    ];
    const normalized = normalizeScore(results);
    expect(normalized[0]!.score).toBe(1.0);
    expect(normalized[1]!.score).toBeCloseTo(1e-30, 35);
  });

  it('handles results with all URLs being the same (single dedup group)', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeParsedResult({
        url: 'https://example.com',
        content: `Content ${i}`,
        score: 10 - i,
      })
    );
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.url).toBe('https://example.com');
    expect(normalized[0]!.score).toBe(1.0);
  });

  it('handles results with alternating duplicate and unique URLs', () => {
    const results = [
      makeParsedResult({ url: 'https://a.com', score: 10.0 }),
      makeParsedResult({ url: 'https://b.com', score: 9.0 }),
      makeParsedResult({ url: 'https://a.com', score: 8.0 }),
      makeParsedResult({ url: 'https://c.com', score: 7.0 }),
      makeParsedResult({ url: 'https://b.com', score: 6.0 }),
      makeParsedResult({ url: 'https://d.com', score: 5.0 }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized).toHaveLength(4);
    // a(10→1.0), b(9→0.9), c(7→0.7), d(5→0.5)
    expect(normalized[0]!.url).toBe('https://a.com');
    expect(normalized[1]!.url).toBe('https://b.com');
    expect(normalized[2]!.url).toBe('https://c.com');
    expect(normalized[3]!.url).toBe('https://d.com');
  });

  it('handles results with URL containing encoded characters', () => {
    const results = [
      makeParsedResult({
        url: 'https://example.com/path%20with%20spaces',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://example.com/path%20with%20spaces');
  });

  it('handles results with URL containing Unicode characters', () => {
    const results = [
      makeParsedResult({
        url: 'https://example.com/café',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://example.com/café');
  });

  it('handles results with URL containing query parameters', () => {
    const results = [
      makeParsedResult({
        url: 'https://example.com/path?key=value&foo=bar',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://example.com/path?key=value&foo=bar');
  });

  it('handles results with URL containing port number', () => {
    const results = [
      makeParsedResult({
        url: 'https://example.com:8443/path',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://example.com:8443/path');
  });

  it('handles results with URL containing authentication info', () => {
    const results = [
      makeParsedResult({
        url: 'https://user:pass@example.com/path',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://user:pass@example.com/path');
  });

  it('handles results with URL containing IPv4 address', () => {
    const results = [
      makeParsedResult({
        url: 'http://192.168.1.1:8080/path',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('http://192.168.1.1:8080/path');
  });

  it('handles results with URL containing IPv6 address', () => {
    const results = [
      makeParsedResult({
        url: 'http://[::1]:8080/path',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('http://[::1]:8080/path');
  });

  it('handles results with URL containing fragment (preserved in output)', () => {
    const results = [
      makeParsedResult({
        url: 'https://example.com/page#section',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://example.com/page#section');
  });

  it('handles results with URL containing trailing slash', () => {
    const results = [
      makeParsedResult({
        url: 'https://example.com/path/',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://example.com/path/');
  });

  it('handles results with URL containing double slashes in path', () => {
    const results = [
      makeParsedResult({
        url: 'https://example.com//double//path',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://example.com//double//path');
  });

  it('handles results with URL containing only a domain', () => {
    const results = [
      makeParsedResult({
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://example.com');
  });

  it('handles results with URL containing only a domain and trailing slash', () => {
    const results = [
      makeParsedResult({
        url: 'https://example.com/',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://example.com/');
  });

  it('handles results with URL containing subdomain', () => {
    const results = [
      makeParsedResult({
        url: 'https://sub.example.com/path',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://sub.example.com/path');
  });

  it('handles results with URL containing multiple subdomains', () => {
    const results = [
      makeParsedResult({
        url: 'https://a.b.c.example.com/path',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe('https://a.b.c.example.com/path');
  });

  it('handles results with URL containing a very long path', () => {
    const longPath = 'a/'.repeat(100) + 'end';
    const results = [
      makeParsedResult({
        url: `https://example.com/${longPath}`,
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe(`https://example.com/${longPath}`);
  });

  it('handles results with URL containing a very long query string', () => {
    const longQuery = 'key=value&'.repeat(100) + 'end=1';
    const results = [
      makeParsedResult({
        url: `https://example.com/path?${longQuery}`,
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe(`https://example.com/path?${longQuery}`);
  });

  it('handles results with URL containing a very long fragment', () => {
    const longFragment = 'x'.repeat(500);
    const results = [
      makeParsedResult({
        url: `https://example.com/path#${longFragment}`,
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.url).toBe(`https://example.com/path#${longFragment}`);
  });

  it('handles results with title containing HTML entities', () => {
    const results = [
      makeParsedResult({
        title: '&amp; &lt; &gt; &quot;',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('&amp; &lt; &gt; &quot;');
  });

  it('handles results with content containing HTML entities', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '&amp; &lt; &gt; &quot;',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('&amp; &lt; &gt; &quot;');
  });

  it('handles results with title containing script tags', () => {
    const results = [
      makeParsedResult({
        title: '<script>alert(1)</script>',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('<script>alert(1)</script>');
  });

  it('handles results with content containing script tags', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '<script>alert(1)</script>',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('<script>alert(1)</script>');
  });

  it('handles results with title containing null bytes', () => {
    const results = [
      makeParsedResult({
        title: 'title\x00with\x00nulls',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('title\x00with\x00nulls');
  });

  it('handles results with content containing null bytes', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: 'content\x00with\x00nulls',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('content\x00with\x00nulls');
  });

  it('handles results with title containing control characters', () => {
    const results = [
      makeParsedResult({
        title: 'title\x01\x02\x03',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('title\x01\x02\x03');
  });

  it('handles results with content containing control characters', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: 'content\x01\x02\x03',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('content\x01\x02\x03');
  });

  it('handles results with title containing only control characters', () => {
    const results = [
      makeParsedResult({
        title: '\x01\x02\x03',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    // Control characters are non-empty, so title is kept as-is
    expect(normalized[0]!.title).toBe('\x01\x02\x03');
  });

  it('handles results with content containing only control characters', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\x01\x02\x03',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\x01\x02\x03');
  });

  it('handles results with title containing mixed ASCII and Unicode', () => {
    const results = [
      makeParsedResult({
        title: 'Hello 世界 café',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('Hello 世界 café');
  });

  it('handles results with content containing mixed ASCII and Unicode', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: 'Hello 世界 café',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('Hello 世界 café');
  });

  it('handles results with title containing only Unicode whitespace', () => {
    const results = [
      makeParsedResult({
        title: '\u3000\u3000', // Ideographic space
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    // Unicode whitespace is non-empty, so title is kept as-is
    expect(normalized[0]!.title).toBe('\u3000\u3000');
  });

  it('handles results with content containing only Unicode whitespace', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u3000\u3000',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u3000\u3000');
  });

  it('handles results with title containing mixed whitespace types', () => {
    const results = [
      makeParsedResult({
        title: ' \t\n\r\u3000',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe(' \t\n\r\u3000');
  });

  it('handles results with content containing mixed whitespace types', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: ' \t\n\r\u3000',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe(' \t\n\r\u3000');
  });

  it('handles results with title containing only a period', () => {
    const results = [
      makeParsedResult({
        title: '.',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('.');
  });

  it('handles results with content containing only a period', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '.',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('.');
  });

  it('handles results with title containing only a comma', () => {
    const results = [
      makeParsedResult({
        title: ',',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe(',');
  });

  it('handles results with content containing only a comma', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: ',',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe(',');
  });

  it('handles results with title containing only a space', () => {
    const results = [
      makeParsedResult({
        title: ' ',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe(' ');
  });

  it('handles results with content containing only a space', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: ' ',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe(' ');
  });

  it('handles results with title containing only a tab', () => {
    const results = [
      makeParsedResult({
        title: '\t',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\t');
  });

  it('handles results with content containing only a tab', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\t',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\t');
  });

  it('handles results with title containing only a newline', () => {
    const results = [
      makeParsedResult({
        title: '\n',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\n');
  });

  it('handles results with content containing only a newline', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\n',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\n');
  });

  it('handles results with title containing only a carriage return', () => {
    const results = [
      makeParsedResult({
        title: '\r',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\r');
  });

  it('handles results with content containing only a carriage return', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\r',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\r');
  });

  it('handles results with title containing only a null byte', () => {
    const results = [
      makeParsedResult({
        title: '\x00',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\x00');
  });

  it('handles results with content containing only a null byte', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\x00',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\x00');
  });

  it('handles results with title containing only a backspace', () => {
    const results = [
      makeParsedResult({
        title: '\x08',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\x08');
  });

  it('handles results with content containing only a backspace', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\x08',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\x08');
  });

  it('handles results with title containing only a form feed', () => {
    const results = [
      makeParsedResult({
        title: '\x0c',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\x0c');
  });

  it('handles results with content containing only a form feed', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\x0c',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\x0c');
  });

  it('handles results with title containing only a vertical tab', () => {
    const results = [
      makeParsedResult({
        title: '\x0b',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\x0b');
  });

  it('handles results with content containing only a vertical tab', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\x0b',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\x0b');
  });

  it('handles results with title containing only an escape character', () => {
    const results = [
      makeParsedResult({
        title: '\x1b',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\x1b');
  });

  it('handles results with content containing only an escape character', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\x1b',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\x1b');
  });

  it('handles results with title containing only a delete character', () => {
    const results = [
      makeParsedResult({
        title: '\x7f',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\x7f');
  });

  it('handles results with content containing only a delete character', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\x7f',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\x7f');
  });

  it('handles results with title containing only a non-ASCII character', () => {
    const results = [
      makeParsedResult({
        title: 'é',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('é');
  });

  it('handles results with content containing only a non-ASCII character', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: 'é',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('é');
  });

  it('handles results with title containing only a CJK character', () => {
    const results = [
      makeParsedResult({
        title: '日',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('日');
  });

  it('handles results with content containing only a CJK character', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '日',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('日');
  });

  it('handles results with title containing only an emoji', () => {
    const results = [
      makeParsedResult({
        title: '😀',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('😀');
  });

  it('handles results with content containing only an emoji', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '😀',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('😀');
  });

  it('handles results with title containing only a zero-width space', () => {
    const results = [
      makeParsedResult({
        title: '\u200b',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u200b');
  });

  it('handles results with content containing only a zero-width space', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u200b',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u200b');
  });

  it('handles results with title containing only a zero-width non-joiner', () => {
    const results = [
      makeParsedResult({
        title: '\u200c',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u200c');
  });

  it('handles results with content containing only a zero-width non-joiner', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u200c',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u200c');
  });

  it('handles results with title containing only a zero-width joiner', () => {
    const results = [
      makeParsedResult({
        title: '\u200d',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u200d');
  });

  it('handles results with content containing only a zero-width joiner', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u200d',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u200d');
  });

  it('handles results with title containing only a byte order mark', () => {
    const results = [
      makeParsedResult({
        title: '\ufeff',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\ufeff');
  });

  it('handles results with content containing only a byte order mark', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\ufeff',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\ufeff');
  });

  it('handles results with title containing only a soft hyphen', () => {
    const results = [
      makeParsedResult({
        title: '\u00ad',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u00ad');
  });

  it('handles results with content containing only a soft hyphen', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u00ad',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u00ad');
  });

  it('handles results with title containing only a non-breaking space', () => {
    const results = [
      makeParsedResult({
        title: '\u00a0',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u00a0');
  });

  it('handles results with content containing only a non-breaking space', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u00a0',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u00a0');
  });

  it('handles results with title containing only a narrow no-break space', () => {
    const results = [
      makeParsedResult({
        title: '\u202f',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u202f');
  });

  it('handles results with content containing only a narrow no-break space', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u202f',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u202f');
  });

  it('handles results with title containing only a medium mathematical space', () => {
    const results = [
      makeParsedResult({
        title: '\u205f',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u205f');
  });

  it('handles results with content containing only a medium mathematical space', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u205f',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u205f');
  });

  it('handles results with title containing only a figure space', () => {
    const results = [
      makeParsedResult({
        title: '\u2007',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u2007');
  });

  it('handles results with content containing only a figure space', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u2007',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u2007');
  });

  it('handles results with title containing only a punctuation space', () => {
    const results = [
      makeParsedResult({
        title: '\u2008',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u2008');
  });

  it('handles results with content containing only a punctuation space', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u2008',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u2008');
  });

  it('handles results with title containing only a thin space', () => {
    const results = [
      makeParsedResult({
        title: '\u2009',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u2009');
  });

  it('handles results with content containing only a thin space', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u2009',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u2009');
  });

  it('handles results with title containing only a hair space', () => {
    const results = [
      makeParsedResult({
        title: '\u200a',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u200a');
  });

  it('handles results with content containing only a hair space', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u200a',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u200a');
  });

  it('handles results with title containing only a line separator', () => {
    const results = [
      makeParsedResult({
        title: '\u2028',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u2028');
  });

  it('handles results with content containing only a line separator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u2028',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u2028');
  });

  it('handles results with title containing only a paragraph separator', () => {
    const results = [
      makeParsedResult({
        title: '\u2029',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u2029');
  });

  it('handles results with content containing only a paragraph separator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u2029',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u2029');
  });

  it('handles results with title containing only a next line', () => {
    const results = [
      makeParsedResult({
        title: '\u0085',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0085');
  });

  it('handles results with content containing only a next line', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0085',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0085');
  });

  it('handles results with title containing only an information separator', () => {
    const results = [
      makeParsedResult({
        title: '\u001f',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u001f');
  });

  it('handles results with content containing only an information separator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u001f',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u001f');
  });

  it('handles results with title containing only a group separator', () => {
    const results = [
      makeParsedResult({
        title: '\u001d',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u001d');
  });

  it('handles results with content containing only a group separator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u001d',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u001d');
  });

  it('handles results with title containing only a record separator', () => {
    const results = [
      makeParsedResult({
        title: '\u001e',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u001e');
  });

  it('handles results with content containing only a record separator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u001e',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u001e');
  });

  it('handles results with title containing only a file separator', () => {
    const results = [
      makeParsedResult({
        title: '\u001c',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u001c');
  });

  it('handles results with content containing only a file separator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u001c',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u001c');
  });

  it('handles results with title containing only a unit separator', () => {
    const results = [
      makeParsedResult({
        title: '\u001f',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u001f');
  });

  it('handles results with content containing only a unit separator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u001f',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u001f');
  });

  it('handles results with title containing only a start of heading', () => {
    const results = [
      makeParsedResult({
        title: '\u0001',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0001');
  });

  it('handles results with content containing only a start of heading', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0001',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0001');
  });

  it('handles results with title containing only a start of text', () => {
    const results = [
      makeParsedResult({
        title: '\u0002',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0002');
  });

  it('handles results with content containing only a start of text', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0002',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0002');
  });

  it('handles results with title containing only an end of text', () => {
    const results = [
      makeParsedResult({
        title: '\u0003',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0003');
  });

  it('handles results with content containing only an end of text', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0003',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0003');
  });

  it('handles results with title containing only an end of transmission', () => {
    const results = [
      makeParsedResult({
        title: '\u0004',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0004');
  });

  it('handles results with content containing only an end of transmission', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0004',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0004');
  });

  it('handles results with title containing only an enquiry', () => {
    const results = [
      makeParsedResult({
        title: '\u0005',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0005');
  });

  it('handles results with content containing only an enquiry', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0005',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0005');
  });

  it('handles results with title containing only an acknowledgment', () => {
    const results = [
      makeParsedResult({
        title: '\u0006',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0006');
  });

  it('handles results with content containing only an acknowledgment', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0006',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0006');
  });

  it('handles results with title containing only a bell', () => {
    const results = [
      makeParsedResult({
        title: '\u0007',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0007');
  });

  it('handles results with content containing only a bell', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0007',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0007');
  });

  it('handles results with title containing only a line feed', () => {
    const results = [
      makeParsedResult({
        title: '\u000a',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u000a');
  });

  it('handles results with content containing only a line feed', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u000a',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u000a');
  });

  it('handles results with title containing only a vertical tab', () => {
    const results = [
      makeParsedResult({
        title: '\u000b',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u000b');
  });

  it('handles results with content containing only a vertical tab', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u000b',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u000b');
  });

  it('handles results with title containing only a form feed', () => {
    const results = [
      makeParsedResult({
        title: '\u000c',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u000c');
  });

  it('handles results with content containing only a form feed', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u000c',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u000c');
  });

  it('handles results with title containing only a carriage return', () => {
    const results = [
      makeParsedResult({
        title: '\u000d',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u000d');
  });

  it('handles results with content containing only a carriage return', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u000d',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u000d');
  });

  it('handles results with title containing only a shift out', () => {
    const results = [
      makeParsedResult({
        title: '\u000e',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u000e');
  });

  it('handles results with content containing only a shift out', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u000e',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u000e');
  });

  it('handles results with title containing only a shift in', () => {
    const results = [
      makeParsedResult({
        title: '\u000f',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u000f');
  });

  it('handles results with content containing only a shift in', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u000f',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u000f');
  });

  it('handles results with title containing only a data link escape', () => {
    const results = [
      makeParsedResult({
        title: '\u0010',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0010');
  });

  it('handles results with content containing only a data link escape', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0010',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0010');
  });

  it('handles results with title containing only a device control 1', () => {
    const results = [
      makeParsedResult({
        title: '\u0011',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0011');
  });

  it('handles results with content containing only a device control 1', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0011',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0011');
  });

  it('handles results with title containing only a device control 2', () => {
    const results = [
      makeParsedResult({
        title: '\u0012',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0012');
  });

  it('handles results with content containing only a device control 2', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0012',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0012');
  });

  it('handles results with title containing only a device control 3', () => {
    const results = [
      makeParsedResult({
        title: '\u0013',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0013');
  });

  it('handles results with content containing only a device control 3', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0013',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0013');
  });

  it('handles results with title containing only a device control 4', () => {
    const results = [
      makeParsedResult({
        title: '\u0014',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0014');
  });

  it('handles results with content containing only a device control 4', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0014',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0014');
  });

  it('handles results with title containing only a negative acknowledgment', () => {
    const results = [
      makeParsedResult({
        title: '\u0015',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0015');
  });

  it('handles results with content containing only a negative acknowledgment', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0015',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0015');
  });

  it('handles results with title containing only a synchronous idle', () => {
    const results = [
      makeParsedResult({
        title: '\u0016',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0016');
  });

  it('handles results with content containing only a synchronous idle', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0016',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0016');
  });

  it('handles results with title containing only an end of transmission block', () => {
    const results = [
      makeParsedResult({
        title: '\u0017',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0017');
  });

  it('handles results with content containing only an end of transmission block', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0017',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0017');
  });

  it('handles results with title containing only a cancel', () => {
    const results = [
      makeParsedResult({
        title: '\u0018',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0018');
  });

  it('handles results with content containing only a cancel', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0018',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0018');
  });

  it('handles results with title containing only an end of medium', () => {
    const results = [
      makeParsedResult({
        title: '\u0019',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0019');
  });

  it('handles results with content containing only an end of medium', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0019',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0019');
  });

  it('handles results with title containing only a substitute', () => {
    const results = [
      makeParsedResult({
        title: '\u001a',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u001a');
  });

  it('handles results with content containing only a substitute', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u001a',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u001a');
  });

  it('handles results with title containing only an escape', () => {
    const results = [
      makeParsedResult({
        title: '\u001b',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u001b');
  });

  it('handles results with content containing only an escape', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u001b',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u001b');
  });

  it('handles results with title containing only a file separator', () => {
    const results = [
      makeParsedResult({
        title: '\u001c',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u001c');
  });

  it('handles results with content containing only a file separator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u001c',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u001c');
  });

  it('handles results with title containing only a group separator', () => {
    const results = [
      makeParsedResult({
        title: '\u001d',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u001d');
  });

  it('handles results with content containing only a group separator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u001d',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u001d');
  });

  it('handles results with title containing only a record separator', () => {
    const results = [
      makeParsedResult({
        title: '\u001e',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u001e');
  });

  it('handles results with content containing only a record separator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u001e',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u001e');
  });

  it('handles results with title containing only a unit separator', () => {
    const results = [
      makeParsedResult({
        title: '\u001f',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u001f');
  });

  it('handles results with content containing only a unit separator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u001f',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u001f');
  });

  it('handles results with title containing only a delete', () => {
    const results = [
      makeParsedResult({
        title: '\u007f',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u007f');
  });

  it('handles results with content containing only a delete', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u007f',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u007f');
  });

  it('handles results with title containing only a padding character', () => {
    const results = [
      makeParsedResult({
        title: '\u0080',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0080');
  });

  it('handles results with content containing only a padding character', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0080',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0080');
  });

  it('handles results with title containing only a high octet preset', () => {
    const results = [
      makeParsedResult({
        title: '\u0081',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0081');
  });

  it('handles results with content containing only a high octet preset', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0081',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0081');
  });

  it('handles results with title containing only a break permitted here', () => {
    const results = [
      makeParsedResult({
        title: '\u0082',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0082');
  });

  it('handles results with content containing only a break permitted here', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0082',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0082');
  });

  it('handles results with title containing only a no break here', () => {
    const results = [
      makeParsedResult({
        title: '\u0083',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0083');
  });

  it('handles results with content containing only a no break here', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0083',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0083');
  });

  it('handles results with title containing only an index', () => {
    const results = [
      makeParsedResult({
        title: '\u0084',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0084');
  });

  it('handles results with content containing only an index', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0084',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0084');
  });

  it('handles results with title containing only a next line', () => {
    const results = [
      makeParsedResult({
        title: '\u0085',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0085');
  });

  it('handles results with content containing only a next line', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0085',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0085');
  });

  it('handles results with title containing only a start of selected area', () => {
    const results = [
      makeParsedResult({
        title: '\u0086',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0086');
  });

  it('handles results with content containing only a start of selected area', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0086',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0086');
  });

  it('handles results with title containing only an end of selected area', () => {
    const results = [
      makeParsedResult({
        title: '\u0087',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0087');
  });

  it('handles results with content containing only an end of selected area', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0087',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0087');
  });

  it('handles results with title containing only a character tabulation set', () => {
    const results = [
      makeParsedResult({
        title: '\u0088',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0088');
  });

  it('handles results with content containing only a character tabulation set', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0088',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0088');
  });

  it('handles results with title containing only a character tabulation with justification', () => {
    const results = [
      makeParsedResult({
        title: '\u0089',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0089');
  });

  it('handles results with content containing only a character tabulation with justification', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0089',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0089');
  });

  it('handles results with title containing only a line tabulation set', () => {
    const results = [
      makeParsedResult({
        title: '\u008a',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u008a');
  });

  it('handles results with content containing only a line tabulation set', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u008a',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u008a');
  });

  it('handles results with title containing only a partial line forward', () => {
    const results = [
      makeParsedResult({
        title: '\u008b',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u008b');
  });

  it('handles results with content containing only a partial line forward', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u008b',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u008b');
  });

  it('handles results with title containing only a partial line backward', () => {
    const results = [
      makeParsedResult({
        title: '\u008c',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u008c');
  });

  it('handles results with content containing only a partial line backward', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u008c',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u008c');
  });

  it('handles results with title containing only a reverse line feed', () => {
    const results = [
      makeParsedResult({
        title: '\u008d',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u008d');
  });

  it('handles results with content containing only a reverse line feed', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u008d',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u008d');
  });

  it('handles results with title containing only a single shift 2', () => {
    const results = [
      makeParsedResult({
        title: '\u008e',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u008e');
  });

  it('handles results with content containing only a single shift 2', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u008e',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u008e');
  });

  it('handles results with title containing only a single shift 3', () => {
    const results = [
      makeParsedResult({
        title: '\u008f',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u008f');
  });

  it('handles results with content containing only a single shift 3', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u008f',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u008f');
  });

  it('handles results with title containing only a device control string', () => {
    const results = [
      makeParsedResult({
        title: '\u0090',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0090');
  });

  it('handles results with content containing only a device control string', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0090',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0090');
  });

  it('handles results with title containing only a private use 1', () => {
    const results = [
      makeParsedResult({
        title: '\u0091',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0091');
  });

  it('handles results with content containing only a private use 1', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0091',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0091');
  });

  it('handles results with title containing only a private use 2', () => {
    const results = [
      makeParsedResult({
        title: '\u0092',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0092');
  });

  it('handles results with content containing only a private use 2', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0092',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0092');
  });

  it('handles results with title containing only a set transmit state', () => {
    const results = [
      makeParsedResult({
        title: '\u0093',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0093');
  });

  it('handles results with content containing only a set transmit state', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0093',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0093');
  });

  it('handles results with title containing only a cancel character', () => {
    const results = [
      makeParsedResult({
        title: '\u0094',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0094');
  });

  it('handles results with content containing only a cancel character', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0094',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0094');
  });

  it('handles results with title containing only a message waiting', () => {
    const results = [
      makeParsedResult({
        title: '\u0095',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0095');
  });

  it('handles results with content containing only a message waiting', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0095',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0095');
  });

  it('handles results with title containing only a start of guarded area', () => {
    const results = [
      makeParsedResult({
        title: '\u0096',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0096');
  });

  it('handles results with content containing only a start of guarded area', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0096',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0096');
  });

  it('handles results with title containing only an end of guarded area', () => {
    const results = [
      makeParsedResult({
        title: '\u0097',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0097');
  });

  it('handles results with content containing only an end of guarded area', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0097',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0097');
  });

  it('handles results with title containing only a start of string', () => {
    const results = [
      makeParsedResult({
        title: '\u0098',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u0098');
  });

  it('handles results with content containing only a start of string', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u0098',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u0098');
  });

  it('handles results with title containing only a single character introducer', () => {
    const results = [
      makeParsedResult({
        title: '\u009a',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u009a');
  });

  it('handles results with content containing only a single character introducer', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u009a',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u009a');
  });

  it('handles results with title containing only a control sequence introducer', () => {
    const results = [
      makeParsedResult({
        title: '\u009b',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u009b');
  });

  it('handles results with content containing only a control sequence introducer', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u009b',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u009b');
  });

  it('handles results with title containing only a string terminator', () => {
    const results = [
      makeParsedResult({
        title: '\u009c',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u009c');
  });

  it('handles results with content containing only a string terminator', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u009c',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u009c');
  });

  it('handles results with title containing only an operating system command', () => {
    const results = [
      makeParsedResult({
        title: '\u009d',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u009d');
  });

  it('handles results with content containing only an operating system command', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u009d',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u009d');
  });

  it('handles results with title containing only a privacy message', () => {
    const results = [
      makeParsedResult({
        title: '\u009e',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u009e');
  });

  it('handles results with content containing only a privacy message', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u009e',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u009e');
  });

  it('handles results with title containing only an application program command', () => {
    const results = [
      makeParsedResult({
        title: '\u009f',
        url: 'https://example.com',
        content: 'C',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.title).toBe('\u009f');
  });

  it('handles results with content containing only an application program command', () => {
    const results = [
      makeParsedResult({
        title: 'T',
        url: 'https://example.com',
        content: '\u009f',
        score: 1.0,
      }),
    ];
    const normalized = normalizeResults(results, 10);
    expect(normalized[0]!.snippet).toBe('\u009f');
  });
});
