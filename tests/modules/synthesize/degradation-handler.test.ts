/**
 * Unit tests for degradation-handler.ts
 *
 * Tests the degradation fallback DigestResult construction, including:
 * - Answer prefix and 2000-char truncation
 * - keyPoints first-sentence extraction (max 10)
 * - sources completeness
 * - Empty contents edge case
 * - stderr log format for degradation activation
 * - Structural validity guarantees
 *
 * [Spec: US-SY-007, BG-SY-003, NFR-SY-002, NFR-SY-004, DC-SY-003]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { degradationFallback } from '../../../src/modules/synthesize/degradation-handler.js';
import type { ContentItem } from '../../../src/shared/types/content.js';
import type { DigestResult } from '../../../src/shared/types/digest.js';

const DEGRADATION_PREFIX =
  '[Note: LLM synthesis unavailable; showing truncated raw content.]';
const MAX_DEGRADATION_ANSWER = 2000;
const MAX_KEY_POINTS = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a ContentItem with overrides.
 */
function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    title: overrides.title ?? 'Test Title',
    url: overrides.url ?? 'https://example.com/page',
    snippet: overrides.snippet ?? 'A snippet.',
    score: overrides.score ?? 0.5,
    content: overrides.content ?? 'Some content here for testing purposes.',
  };
}

/**
 * Collect all stderr writes during a test.
 */
function captureStderr(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => String(c[0])).join('');
}

// ===========================================================================
// degradationFallback — Answer prefix and basic structure
// ===========================================================================

describe('degradationFallback — answer prefix', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-007] Answer prefixed with the degradation note
  it('prefixes the answer with the degradation note', () => {
    const items = [makeItem({ content: 'Some content here.' })];
    const result = degradationFallback('query', items, 'test reason');

    expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
  });

  it('separates prefix and content with double newlines', () => {
    const items = [makeItem({ content: 'Body content.' })];
    const result = degradationFallback('query', items, 'reason');

    expect(result.answer).toContain(`${DEGRADATION_PREFIX}\n\n`);
    expect(result.answer).toContain('Body content.');
  });

  it('prefix is the exact expected string', () => {
    const items = [makeItem({ content: 'x' })];
    const result = degradationFallback('query', items, 'r');

    expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
    expect(DEGRADATION_PREFIX).toBe(
      '[Note: LLM synthesis unavailable; showing truncated raw content.]'
    );
  });

  it('answer contains the prefix even when content is long', () => {
    const items = [makeItem({ content: 'A'.repeat(5000) })];
    const result = degradationFallback('q', items, 'r');

    expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
  });
});

// ===========================================================================
// degradationFallback — Score-based ordering (top-ranked content first)
// ===========================================================================

describe('degradationFallback — score-based content ordering', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-007] Content sorted by descending score
  it('places highest-scored content first in the answer', () => {
    const items = [
      makeItem({ url: 'https://low.com', score: 0.1, content: 'Low score content here.' }),
      makeItem({ url: 'https://high.com', score: 0.9, content: 'High score content here.' }),
      makeItem({ url: 'https://mid.com', score: 0.5, content: 'Mid score content here.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    const afterPrefix = result.answer.slice(DEGRADATION_PREFIX.length + 2);
    // Highest-scored content should appear first
    expect(afterPrefix.indexOf('High score')).toBeLessThan(
      afterPrefix.indexOf('Mid score')
    );
    expect(afterPrefix.indexOf('Mid score')).toBeLessThan(
      afterPrefix.indexOf('Low score')
    );
  });

  it('uses content from highest-scored item even when others have more text', () => {
    const items = [
      makeItem({
        url: 'https://big.com',
        score: 0.3,
        content: 'Big but low priority content for testing the sort order here.',
      }),
      makeItem({
        url: 'https://small.com',
        score: 0.9,
        content: 'Small but high priority.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    const afterPrefix = result.answer.slice(DEGRADATION_PREFIX.length + 2);
    expect(afterPrefix.indexOf('Small but high priority')).toBeLessThan(
      afterPrefix.indexOf('Big but low priority')
    );
  });

  it('equal scores preserve original order (stable sort)', () => {
    const items = [
      makeItem({ url: 'https://first.com', score: 0.5, content: 'First item content here.' }),
      makeItem({ url: 'https://second.com', score: 0.5, content: 'Second item content here.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    const afterPrefix = result.answer.slice(DEGRADATION_PREFIX.length + 2);
    expect(afterPrefix.indexOf('First item')).toBeLessThan(
      afterPrefix.indexOf('Second item')
    );
  });

  it('handles negative scores correctly (higher = less negative)', () => {
    const items = [
      makeItem({ url: 'https://neg.com', score: -0.9, content: 'Very negative score content here.' }),
      makeItem({ url: 'https://zero.com', score: 0.0, content: 'Zero score content here.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    const afterPrefix = result.answer.slice(DEGRADATION_PREFIX.length + 2);
    // 0.0 > -0.9 → zero score content should come first
    expect(afterPrefix.indexOf('Zero score')).toBeLessThan(
      afterPrefix.indexOf('Very negative')
    );
  });
});

// ===========================================================================
// degradationFallback — 2000-char truncation
// ===========================================================================

describe('degradationFallback — 2000-char truncation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-007] Answer does not exceed 2000 chars
  it('truncates the answer at 2000 characters (single large item)', () => {
    const items = [makeItem({ content: 'A'.repeat(5000) })];
    const result = degradationFallback('q', items, 'r');

    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
  });

  it('truncates at 2000 when multiple items overflow combined', () => {
    const items = Array.from(
      { length: 10 },
      (_, i) =>
        makeItem({
          url: `https://item${i}.com`,
          score: 1 - i * 0.05,
          content: 'B'.repeat(500),
        })
    );

    const result = degradationFallback('q', items, 'r');

    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
  });

  it('keeps answer under 2000 with mixed-size items', () => {
    const items = [
      makeItem({ score: 0.9, content: 'C'.repeat(800) }),
      makeItem({ score: 0.5, content: 'D'.repeat(800) }),
      makeItem({ score: 0.3, content: 'E'.repeat(800) }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
  });

  it('does not truncate when content is well under 2000', () => {
    const items = [makeItem({ content: 'Short content.' })];
    const result = degradationFallback('q', items, 'r');

    expect(result.answer.length).toBeLessThan(MAX_DEGRADATION_ANSWER);
    // Prefix + separator + content
    expect(result.answer).toBe(`${DEGRADATION_PREFIX}\n\nShort content.`);
  });

  it('truncates at word boundary when possible for large content', () => {
    const items = [
      makeItem({ content: 'word '.repeat(1000) }), // 5000 chars with word boundaries
    ];
    const result = degradationFallback('q', items, 'r');

    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
    // Should not end mid-word if a space is available
    // (the implementation finds last space if it's past 50% of the remaining window)
  });

  it('answer fits within 2000 even with prefix consuming part of the budget', () => {
    const items = [makeItem({ content: 'X'.repeat(3000) })];
    const result = degradationFallback('q', items, 'r');

    // Prefix length + separator + content must all fit in 2000
    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
    // Answer starts with prefix
    expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
  });

  it('prefers to include content from higher-ranked items before lower-ranked', () => {
    const items = [
      makeItem({ score: 0.9, content: 'Important high-priority content that should be included first.' }),
      makeItem({ score: 0.1, content: 'Z'.repeat(3000) }),
    ];

    const result = degradationFallback('q', items, 'r');

    // High-priority content should be present
    expect(result.answer).toContain('Important high-priority');
    // Total should not exceed limit
    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
  });
});

// ===========================================================================
// degradationFallback — keyPoints extraction (first sentence, max 10)
// ===========================================================================

describe('degradationFallback — keyPoints extraction', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-007] keyPoints are first sentences
  it('extracts the first sentence of each content item', () => {
    const items = [
      makeItem({
        score: 0.9,
        content: 'First sentence here. Second sentence here. Third sentence here.',
      }),
      makeItem({
        score: 0.5,
        content: 'Another first sentence. And more text after.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints).toEqual([
      'First sentence here.',
      'Another first sentence.',
    ]);
  });

  it('detects first sentence by period followed by whitespace', () => {
    const items = [
      makeItem({
        content: 'The quick brown fox jumps. The lazy dog sleeps.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints).toEqual(['The quick brown fox jumps.']);
  });

  it('detects first sentence by period at end of string (no trailing whitespace)', () => {
    const items = [
      makeItem({ content: 'Only one sentence with no trailing text.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints).toEqual([
      'Only one sentence with no trailing text.',
    ]);
  });

  it('returns full text as keyPoint when no period is found', () => {
    const items = [makeItem({ content: 'No period at all here' })];

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints).toEqual(['No period at all here']);
  });

  // [Implements: US-SY-007] Max 10 keyPoints
  it('limits keyPoints to at most 10 items', () => {
    const items = Array.from(
      { length: 15 },
      (_, i) =>
        makeItem({
          url: `https://kp${i}.com`,
          score: 1 - i * 0.01,
          content: `Item ${i} first sentence. More text.`,
        })
    );

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints.length).toBeLessThanOrEqual(MAX_KEY_POINTS);
    expect(result.keyPoints.length).toBe(10);
  });

  it('returns fewer than 10 keyPoints when input has fewer items', () => {
    const items = Array.from(
      { length: 3 },
      (_, i) =>
        makeItem({
          content: `Point ${i}. More text here.`,
        })
    );

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints.length).toBe(3);
  });

  it('uses top 10 by score for keyPoints', () => {
    const items = Array.from(
      { length: 15 },
      (_, i) =>
        makeItem({
          url: `https://rank${i}.com`,
          score: 1 - i * 0.05,
          content: `Rank ${i} sentence. More.`,
        })
    );

    const result = degradationFallback('q', items, 'r');

    // Top 10 by score → items 0 through 9 (scores 1.0 down to 0.55)
    expect(result.keyPoints.length).toBe(10);
    expect(result.keyPoints[0]).toContain('Rank 0');
    expect(result.keyPoints[9]).toContain('Rank 9');
    // Items 10-14 should NOT appear
    const allKp = result.keyPoints.join(' ');
    expect(allKp).not.toContain('Rank 10');
    expect(allKp).not.toContain('Rank 14');
  });

  it('skips items with empty content for keyPoints', () => {
    const items = [
      makeItem({ score: 0.9, content: 'Valid sentence here.' }),
      makeItem({ score: 0.5, content: '' }),
      makeItem({ score: 0.3, content: '   ' }),
    ];

    const result = degradationFallback('q', items, 'r');

    // Only the first item produces a keyPoint
    expect(result.keyPoints).toEqual(['Valid sentence here.']);
  });

  it('skips items with whitespace-only content for keyPoints', () => {
    const items = [
      makeItem({ content: '   ' }),
      makeItem({ content: 'Real content sentence. More.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints).toEqual(['Real content sentence.']);
  });

  it('handles content with only a period (empty first sentence)', () => {
    const items = [makeItem({ content: '.' })];

    const result = degradationFallback('q', items, 'r');

    // After trim, the first sentence regex should match the period
    // The implementation matches ^([^.]*\.(?=\s|$)) which for "." gives "."
    expect(result.keyPoints.length).toBe(1);
  });

  it('trims leading and trailing whitespace from keyPoints', () => {
    const items = [
      makeItem({ content: '  Trimmed sentence.  More text.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints).toEqual(['Trimmed sentence.']);
  });

  it('handles period in the middle of text (abbreviations)', () => {
    // The regex [^.]*\. matches text up to the FIRST period
    const items = [
      makeItem({ content: 'Dr. Smith went home. Later he returned.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    // First period is after "Dr" → "Dr." is the first sentence match
    expect(result.keyPoints).toEqual(['Dr.']);
  });

  it('handles multiple sentences in content', () => {
    const items = [
      makeItem({ content: 'Sentence one. Sentence two. Sentence three.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints).toEqual(['Sentence one.']);
  });

  it('handles content with newlines before the first sentence', () => {
    const items = [
      makeItem({ content: '\n\nFirst actual sentence. Second one.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints).toEqual(['First actual sentence.']);
  });
});

// ===========================================================================
// degradationFallback — sources completeness
// ===========================================================================

describe('degradationFallback — sources completeness', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-007] All input URLs present in sources
  it('includes all input URLs in sources', () => {
    const items = [
      makeItem({ url: 'https://a.com', title: 'Title A' }),
      makeItem({ url: 'https://b.com', title: 'Title B' }),
      makeItem({ url: 'https://c.com', title: 'Title C' }),
    ];

    const result = degradationFallback('q', items, 'r');

    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://a.com');
    expect(urls).toContain('https://b.com');
    expect(urls).toContain('https://c.com');
  });

  it('includes all input titles in sources', () => {
    const items = [
      makeItem({ url: 'https://a.com', title: 'First Title' }),
      makeItem({ url: 'https://b.com', title: 'Second Title' }),
    ];

    const result = degradationFallback('q', items, 'r');

    const titles = result.sources.map((s) => s.title);
    expect(titles).toContain('First Title');
    expect(titles).toContain('Second Title');
  });

  it('preserves source URL and title pairing', () => {
    const items = [
      makeItem({ url: 'https://paired.com', title: 'Paired Title' }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.sources.length).toBe(1);
    expect(result.sources[0].url).toBe('https://paired.com');
    expect(result.sources[0].title).toBe('Paired Title');
  });

  it('does not deduplicate sources with identical URLs', () => {
    const items = [
      makeItem({ url: 'https://same.com', title: 'First' }),
      makeItem({ url: 'https://same.com', title: 'Second' }),
    ];

    const result = degradationFallback('q', items, 'r');

    // Both should be present — sources uses all input items, not sorted
    expect(result.sources.length).toBe(2);
    const titles = result.sources.map((s) => s.title);
    expect(titles).toContain('First');
    expect(titles).toContain('Second');
  });

  it('sources include items even with empty content', () => {
    const items = [
      makeItem({ url: 'https://has-content.com', title: 'Has Content', content: 'Text.' }),
      makeItem({ url: 'https://empty.com', title: 'Empty', content: '' }),
    ];

    const result = degradationFallback('q', items, 'r');

    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://has-content.com');
    expect(urls).toContain('https://empty.com');
  });

  it('sources use original input order (not sorted by score)', () => {
    const items = [
      makeItem({ url: 'https://low.com', title: 'Low', score: 0.1 }),
      makeItem({ url: 'https://high.com', title: 'High', score: 0.9 }),
    ];

    const result = degradationFallback('q', items, 'r');

    // Sources should preserve input order
    expect(result.sources[0].url).toBe('https://low.com');
    expect(result.sources[1].url).toBe('https://high.com');
  });

  it('includes sources from all items even when answer is truncated', () => {
    const items = Array.from(
      { length: 5 },
      (_, i) =>
        makeItem({
          url: `https://src${i}.com`,
          title: `Source ${i}`,
          score: 1 - i * 0.1,
          content: 'X'.repeat(1000),
        })
    );

    const result = degradationFallback('q', items, 'r');

    // All 5 sources should be present even though answer is truncated
    expect(result.sources.length).toBe(5);
    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://src0.com');
    expect(urls).toContain('https://src4.com');
  });
});

// ===========================================================================
// degradationFallback — empty contents edge case
// ===========================================================================

describe('degradationFallback — empty contents', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-007] Empty contents returns structurally valid result
  it('returns a DigestResult with empty keyPoints and sources for empty contents', () => {
    const result = degradationFallback('q', [], 'no content');

    expect(result.keyPoints).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it('answer still starts with the prefix for empty contents', () => {
    const result = degradationFallback('q', [], 'no content');

    expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
  });

  it('answer includes "No content available" note for empty contents', () => {
    const result = degradationFallback('q', [], 'no content');

    expect(result.answer).toContain('No content available');
  });

  it('answer is non-empty even with no contents', () => {
    const result = degradationFallback('q', [], 'no content');

    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('answer does not include double-newline separator for empty contents', () => {
    const result = degradationFallback('q', [], 'r');

    // Empty contents returns prefix + " No content available." with no \n\n
    expect(result.answer).toBe(
      `${DEGRADATION_PREFIX} No content available.`
    );
  });
});

// ===========================================================================
// degradationFallback — items with empty/whitespace content
// ===========================================================================

describe('degradationFallback — items with empty content', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('skips items with empty content in the answer', () => {
    const items = [
      makeItem({ score: 0.9, content: '' }),
      makeItem({ score: 0.5, content: 'Real content here.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    // Only the non-empty item should be in the answer
    expect(result.answer).toContain('Real content here.');
    // Answer should be prefix + separator + content
    expect(result.answer).toBe(`${DEGRADATION_PREFIX}\n\nReal content here.`);
  });

  it('skips items with whitespace-only content in the answer', () => {
    const items = [
      makeItem({ score: 0.9, content: '   ' }),
      makeItem({ score: 0.5, content: 'Actual content.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer).toContain('Actual content.');
    expect(result.answer).not.toContain('   ');
  });

  it('produces prefix-only answer when all items have empty content', () => {
    const items = [
      makeItem({ score: 0.9, content: '' }),
      makeItem({ score: 0.5, content: '  ' }),
    ];

    const result = degradationFallback('q', items, 'r');

    // No valid content → answer is prefix + \n\n + empty join = prefix + \n\n
    expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
    expect(result.answer).toBe(`${DEGRADATION_PREFIX}\n\n`);
  });

  it('still includes empty-content items in sources', () => {
    const items = [
      makeItem({ url: 'https://empty.com', title: 'Empty', content: '' }),
      makeItem({ url: 'https://full.com', title: 'Full', content: 'Text.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.sources.length).toBe(2);
    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://empty.com');
    expect(urls).toContain('https://full.com');
  });

  it('produces empty keyPoints when all items have empty content', () => {
    const items = [makeItem({ content: '' }), makeItem({ content: '   ' })];

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints).toEqual([]);
  });
});

// ===========================================================================
// degradationFallback — stderr degradation log format
// ===========================================================================

describe('degradationFallback — stderr logging', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: NFR-SY-004] Logs "[SY] degradation activated: {reason}"
  it('logs degradation activation with the reason to stderr', () => {
    degradationFallback('q', [makeItem()], 'LLM timed out');

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] degradation activated:');
    expect(output).toContain('LLM timed out');
  });

  it('logs the exact reason string passed', () => {
    degradationFallback('q', [makeItem()], 'auth failed — check LLM_API_KEY');

    const output = captureStderr(stderrSpy);
    expect(output).toContain(
      '[SY] degradation activated: auth failed — check LLM_API_KEY'
    );
  });

  it('logs degradation message exactly once per call', () => {
    degradationFallback('q', [makeItem()], 'test');

    const degradationCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('degradation activated')
    );
    expect(degradationCalls.length).toBe(1);
  });

  it('does not write to stdout', () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      degradationFallback('q', [makeItem()], 'test');
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('logs to stderr even for empty contents', () => {
    degradationFallback('q', [], 'no content');

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] degradation activated:');
    expect(output).toContain('no content');
  });

  it('includes [SY] module tag in log', () => {
    degradationFallback('q', [makeItem()], 'test');

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY]');
  });
});

// ===========================================================================
// degradationFallback — structural validity guarantees
// ===========================================================================

describe('degradationFallback — structural validity', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-007] Returned result is structurally valid
  it('returns a valid DigestResult shape with answer, keyPoints, sources', () => {
    const result = degradationFallback('q', [makeItem()], 'r');

    expect(result).toHaveProperty('answer');
    expect(result).toHaveProperty('keyPoints');
    expect(result).toHaveProperty('sources');
    expect(typeof result.answer).toBe('string');
    expect(Array.isArray(result.keyPoints)).toBe(true);
    expect(Array.isArray(result.sources)).toBe(true);
  });

  it('answer is always non-empty', () => {
    const result1 = degradationFallback('q', [makeItem()], 'r');
    const result2 = degradationFallback('q', [], 'r');

    expect(result1.answer.length).toBeGreaterThan(0);
    expect(result2.answer.length).toBeGreaterThan(0);
  });

  it('answer always starts with the degradation prefix', () => {
    const results = [
      degradationFallback('q', [makeItem()], 'r'),
      degradationFallback('q', [], 'r'),
      degradationFallback('q', [makeItem({ content: 'X'.repeat(5000) })], 'r'),
      degradationFallback('q', [makeItem({ content: '' })], 'r'),
    ];

    for (const result of results) {
      expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
    }
  });

  it('sources contain at least one entry when input is non-empty', () => {
    const result = degradationFallback('q', [makeItem()], 'r');

    expect(result.sources.length).toBeGreaterThanOrEqual(1);
  });

  it('sources may be empty when input is empty (structurally valid)', () => {
    const result = degradationFallback('q', [], 'r');

    expect(result.sources).toEqual([]);
    // Still structurally valid — downstream handles empty sources
  });

  it('keyPoints is always an array (may be empty)', () => {
    const result1 = degradationFallback('q', [makeItem()], 'r');
    const result2 = degradationFallback('q', [], 'r');

    expect(Array.isArray(result1.keyPoints)).toBe(true);
    expect(Array.isArray(result2.keyPoints)).toBe(true);
  });

  it('all keyPoints are non-empty strings', () => {
    const items = [
      makeItem({ content: 'First sentence. More.' }),
      makeItem({ content: 'Second sentence. More.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    for (const kp of result.keyPoints) {
      expect(typeof kp).toBe('string');
      expect(kp.length).toBeGreaterThan(0);
    }
  });

  it('all sources have url and title properties', () => {
    const items = [
      makeItem({ url: 'https://a.com', title: 'Title A' }),
      makeItem({ url: 'https://b.com', title: 'Title B' }),
    ];

    const result = degradationFallback('q', items, 'r');

    for (const src of result.sources) {
      expect(src).toHaveProperty('url');
      expect(src).toHaveProperty('title');
      expect(typeof src.url).toBe('string');
      expect(typeof src.title).toBe('string');
    }
  });
});

// ===========================================================================
// degradationFallback — does not mutate input
// ===========================================================================

describe('degradationFallback — input immutability', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('does not mutate the input contents array', () => {
    const items = [
      makeItem({ score: 0.9, content: 'High score.' }),
      makeItem({ score: 0.1, content: 'Low score.' }),
    ];
    const originalOrder = items.map((i) => i.url);
    const originalScores = items.map((i) => i.score);

    degradationFallback('q', items, 'r');

    expect(items.map((i) => i.url)).toEqual(originalOrder);
    expect(items.map((i) => i.score)).toEqual(originalScores);
  });

  it('does not mutate the input content items', () => {
    const items = [makeItem({ content: 'Original content text here.' })];
    const originalContent = items[0].content;

    degradationFallback('q', items, 'r');

    expect(items[0].content).toBe(originalContent);
  });
});

// ===========================================================================
// degradationFallback — query parameter
// ===========================================================================

describe('degradationFallback — query parameter', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('does not include the query in the answer', () => {
    const items = [makeItem({ content: 'Content text.' })];
    const result = degradationFallback('secret query text', items, 'r');

    expect(result.answer).not.toContain('secret query text');
  });

  it('does not include the query in keyPoints', () => {
    const items = [makeItem({ content: 'Content sentence. More.' })];
    const result = degradationFallback('special query 123', items, 'r');

    for (const kp of result.keyPoints) {
      expect(kp).not.toContain('special query 123');
    }
  });

  it('does not include the query in sources', () => {
    const items = [makeItem({ url: 'https://x.com', title: 'Title' })];
    const result = degradationFallback('unique query 456', items, 'r');

    for (const src of result.sources) {
      expect(src.url).not.toContain('unique query 456');
      expect(src.title).not.toContain('unique query 456');
    }
  });

  it('works with empty query string', () => {
    const items = [makeItem({ content: 'Some content here.' })];
    const result = degradationFallback('', items, 'r');

    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('works with undefined-like query (empty string)', () => {
    const items = [makeItem({ content: 'Content.' })];
    const result = degradationFallback('', items, 'r');

    expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
  });
});

// ===========================================================================
// degradationFallback — multiple items integration
// ===========================================================================

describe('degradationFallback — multiple items integration', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('builds a complete digest from multiple items', () => {
    const items = [
      makeItem({
        url: 'https://article1.com',
        title: 'Article One',
        score: 0.95,
        content: 'This is the first article. It has important information.',
      }),
      makeItem({
        url: 'https://article2.com',
        title: 'Article Two',
        score: 0.80,
        content: 'The second article covers different topics. Additional details.',
      }),
      makeItem({
        url: 'https://article3.com',
        title: 'Article Three',
        score: 0.50,
        content: 'Third article with yet more content. Final paragraph here.',
      }),
    ];

    const result = degradationFallback('search query', items, 'all retries exhausted');

    // Answer starts with prefix and contains content from items
    expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
    expect(result.answer).toContain('This is the first article.');
    expect(result.answer).toContain('The second article');

    // keyPoints are first sentences sorted by score
    expect(result.keyPoints.length).toBe(3);
    expect(result.keyPoints[0]).toBe('This is the first article.');
    expect(result.keyPoints[1]).toBe('The second article covers different topics.');

    // sources include all items
    expect(result.sources.length).toBe(3);
    const sourceUrls = result.sources.map((s) => s.url);
    expect(sourceUrls).toContain('https://article1.com');
    expect(sourceUrls).toContain('https://article2.com');
    expect(sourceUrls).toContain('https://article3.com');

    // stderr logged the degradation reason
    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] degradation activated: all retries exhausted');
  });

  it('handles 15+ items with correct truncation and keyPoint limits', () => {
    const items = Array.from(
      { length: 15 },
      (_, i) =>
        makeItem({
          url: `https://page${i}.com`,
          title: `Page ${i}`,
          score: 1 - i * 0.05,
          content: `Page ${i} content sentence. Additional detail text here for testing.`,
        })
    );

    const result = degradationFallback('q', items, 'r');

    // keyPoints capped at 10
    expect(result.keyPoints.length).toBe(10);

    // Answer within limit
    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);

    // Sources include all 15
    expect(result.sources.length).toBe(15);

    // Answer starts with prefix
    expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
  });

  it('handles mixed empty and non-empty content items', () => {
    const items = [
      makeItem({ url: 'https://full1.com', title: 'Full 1', score: 0.9, content: 'Full content one. More text.' }),
      makeItem({ url: 'https://empty.com', title: 'Empty', score: 0.7, content: '' }),
      makeItem({ url: 'https://full2.com', title: 'Full 2', score: 0.5, content: 'Full content two. More text.' }),
      makeItem({ url: 'https://ws.com', title: 'Whitespace', score: 0.3, content: '   ' }),
    ];

    const result = degradationFallback('q', items, 'r');

    // Answer only contains non-empty items (sorted by score)
    expect(result.answer).toContain('Full content one.');
    expect(result.answer).toContain('Full content two.');

    // keyPoints only from non-empty items
    expect(result.keyPoints).toEqual([
      'Full content one.',
      'Full content two.',
    ]);

    // Sources include ALL items (even empty ones)
    expect(result.sources.length).toBe(4);
    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://full1.com');
    expect(urls).toContain('https://empty.com');
    expect(urls).toContain('https://full2.com');
    expect(urls).toContain('https://ws.com');
  });
});

// ===========================================================================
// degradationFallback — reason string variations
// ===========================================================================

describe('degradationFallback — reason string variations', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('handles multi-word reason', () => {
    degradationFallback('q', [makeItem()], 'all three retry attempts failed with 429');

    const output = captureStderr(stderrSpy);
    expect(output).toContain(
      '[SY] degradation activated: all three retry attempts failed with 429'
    );
  });

  it('handles reason with special characters', () => {
    degradationFallback('q', [makeItem()], 'LLM error: {code: 500} — server error!');

    const output = captureStderr(stderrSpy);
    expect(output).toContain('{code: 500}');
    expect(output).toContain('server error!');
  });

  it('handles very long reason string', () => {
    const longReason = 'A'.repeat(500);
    degradationFallback('q', [makeItem()], longReason);

    const output = captureStderr(stderrSpy);
    expect(output).toContain(longReason);
  });

  it('handles empty reason string', () => {
    degradationFallback('q', [makeItem()], '');

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] degradation activated: \n');
  });
});

// ===========================================================================
// degradationFallback — does not call the LLM
// ===========================================================================

describe('degradationFallback — no LLM invocation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns synchronously without any async delay', () => {
    const items = [makeItem({ content: 'Content.' })];
    const start = Date.now();
    degradationFallback('q', items, 'r');
    const elapsed = Date.now() - start;

    // Should be near-instant (< 100ms)
    expect(elapsed).toBeLessThan(100);
  });

  it('produces a result purely from content (no external calls)', () => {
    const items = [
      makeItem({
        url: 'https://source.com',
        title: 'Source Title',
        score: 0.8,
        content: 'This is the raw content. It should appear verbatim.',
      }),
    ];

    const result: DigestResult = degradationFallback('q', items, 'r');

    // The content text should appear directly in the answer
    expect(result.answer).toContain('This is the raw content.');
  });
});

// ===========================================================================
// degradationFallback — Unicode and special character handling
// ===========================================================================

describe('degradationFallback — unicode and special characters', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('handles content with CJK characters in the answer', () => {
    const items = [
      makeItem({
        score: 0.9,
        content: '这是一个测试内容。更多的文本在这里。',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer).toContain('这是一个测试内容。');
  });

  it('handles CJK content for first-sentence keyPoint extraction', () => {
    const items = [
      makeItem({
        content: '这是第一句话。这是第二句话。',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    // The ASCII period in CJK text is detected as a sentence boundary
    expect(result.keyPoints.length).toBe(1);
    expect(result.keyPoints[0]).toContain('这是第一句话');
  });

  it('handles content with emoji characters', () => {
    const items = [
      makeItem({
        content: 'Content with emoji 🎉 here. More text after emoji.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer).toContain('🎉');
    expect(result.keyPoints[0]).toContain('🎉');
  });

  it('handles content with HTML entities in text', () => {
    const items = [
      makeItem({
        content: 'Content with &amp; and &lt; entities. More text.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    // The implementation uses raw content — entities are NOT decoded
    expect(result.answer).toContain('&amp;');
    expect(result.answer).toContain('&lt;');
  });

  it('handles content with markdown syntax', () => {
    const items = [
      makeItem({
        content: '## Heading\n\n**Bold** and *italic* text. More.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    // Markdown syntax is preserved in the raw degradation answer
    expect(result.answer).toContain('## Heading');
    expect(result.answer).toContain('**Bold**');
  });

  it('handles content with tab characters', () => {
    const items = [
      makeItem({
        content: 'Tab\tseparated\tcontent here. More text.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer).toContain('Tab');
    // First sentence includes the tabs up to the period
    expect(result.keyPoints[0]).toContain('Tab');
  });

  it('handles content with mixed encoding characters (em-dash, smart quotes)', () => {
    const items = [
      makeItem({
        content: 'Text with — em-dash and "smart" quotes. More.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer).toContain('—');
    expect(result.answer).toContain('"smart"');
    expect(result.keyPoints[0]).toContain('—');
  });

  it('handles very long CJK content truncation', () => {
    const items = [
      makeItem({
        score: 0.9,
        content: '一'.repeat(3000),
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
  });

  it('preserves multi-byte characters at truncation boundary', () => {
    const items = [
      makeItem({
        content: '文'.repeat(5000),
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    // Answer should be within the limit
    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
    // Answer should still be valid (no broken surrogate pairs)
    expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
  });
});

// ===========================================================================
// degradationFallback — boundary conditions
// ===========================================================================

describe('degradationFallback — boundary conditions', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('handles single-item input', () => {
    const items = [
      makeItem({
        url: 'https://only.com',
        title: 'Only',
        score: 1.0,
        content: 'Single item content. More text.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.sources.length).toBe(1);
    expect(result.keyPoints.length).toBe(1);
    expect(result.answer).toContain('Single item content.');
  });

  it('handles all items with score 0', () => {
    const items = [
      makeItem({ url: 'https://zero1.com', score: 0, content: 'Zero score content one. More.' }),
      makeItem({ url: 'https://zero2.com', score: 0, content: 'Zero score content two. More.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.sources.length).toBe(2);
    expect(result.keyPoints.length).toBe(2);
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('handles all items with identical scores and identical content', () => {
    const items = [
      makeItem({ url: 'https://dup1.com', score: 0.5, content: 'Identical content text here.' }),
      makeItem({ url: 'https://dup2.com', score: 0.5, content: 'Identical content text here.' }),
      makeItem({ url: 'https://dup3.com', score: 0.5, content: 'Identical content text here.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.sources.length).toBe(3);
    // keyPoints from all three (sorted, equal scores, stable)
    expect(result.keyPoints.length).toBe(3);
  });

  it('handles content with only a single character (no period)', () => {
    const items = [makeItem({ content: 'X' })];

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints).toEqual(['X']);
  });

  it('handles content with only a period and a space', () => {
    const items = [makeItem({ content: '. ' })];

    const result = degradationFallback('q', items, 'r');

    // After trim: "." — the regex matches "." at end of string
    expect(result.keyPoints.length).toBe(1);
  });

  it('handles content with multiple consecutive periods', () => {
    const items = [makeItem({ content: 'Text... More text here.' })];

    const result = degradationFallback('q', items, 'r');

    // The regex [^.]*\.(?=\s|$) does NOT match "Text." because the period
    // is followed by another period (not whitespace). So the full text is
    // returned as the keyPoint.
    expect(result.keyPoints.length).toBe(1);
    expect(result.keyPoints[0]).toContain('Text');
  });

  it('handles content with only whitespace and one sentence', () => {
    const items = [makeItem({ content: '   \n\n  Sentence here.  \n\n  ' })];

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints).toEqual(['Sentence here.']);
  });

  it('handles content that is exactly the truncation limit', () => {
    // Craft content so prefix + separator + content is near 2000
    const prefixLen = DEGRADATION_PREFIX.length;
    const contentLen = MAX_DEGRADATION_ANSWER - prefixLen - 2; // -2 for \n\n
    const items = [makeItem({ content: 'A'.repeat(contentLen) })];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
  });

  it('handles content that is exactly one char over the truncation limit', () => {
    const prefixLen = DEGRADATION_PREFIX.length;
    const contentLen = MAX_DEGRADATION_ANSWER - prefixLen - 1; // one over
    const items = [makeItem({ content: 'A'.repeat(contentLen) })];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
  });

  it('handles items where the highest score item has empty content', () => {
    const items = [
      makeItem({ url: 'https://empty-high.com', score: 1.0, content: '' }),
      makeItem({ url: 'https://full-low.com', score: 0.1, content: 'Lower score content here.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    // The empty-content high-score item should be skipped in answer
    expect(result.answer).toContain('Lower score content here.');
    // But still present in sources
    expect(result.sources.length).toBe(2);
    // keyPoints: empty-content item skipped, so only 1 keyPoint
    expect(result.keyPoints).toEqual(['Lower score content here.']);
  });

  it('handles extreme score values (Infinity, -Infinity)', () => {
    const items = [
      makeItem({ url: 'https://neg.com', score: -Infinity, content: 'Negative infinity content here.' }),
      makeItem({ url: 'https://pos.com', score: Infinity, content: 'Positive infinity content here.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    // Infinity > -Infinity → positive infinity should come first
    const afterPrefix = result.answer.slice(DEGRADATION_PREFIX.length + 2);
    expect(afterPrefix.indexOf('Positive infinity')).toBeLessThan(
      afterPrefix.indexOf('Negative infinity')
    );
  });
});

// ===========================================================================
// degradationFallback — large-scale stress tests
// ===========================================================================

describe('degradationFallback — large-scale stress tests', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('handles 100 items with correct keyPoints and answer limits', () => {
    const items = Array.from(
      { length: 100 },
      (_, i) =>
        makeItem({
          url: `https://item${i}.com`,
          title: `Item ${i}`,
          score: 1 - i * 0.001,
          content: `Item ${i} first sentence. Additional text for item ${i}.`,
        })
    );

    const result = degradationFallback('q', items, 'r');

    // keyPoints capped at 10
    expect(result.keyPoints.length).toBe(10);

    // Answer within limit
    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);

    // Sources include all 100
    expect(result.sources.length).toBe(100);

    // Answer starts with prefix
    expect(result.answer.startsWith(DEGRADATION_PREFIX)).toBe(true);
  });

  it('handles 100 items all with empty content', () => {
    const items = Array.from(
      { length: 100 },
      (_, i) =>
        makeItem({
          url: `https://empty${i}.com`,
          title: `Empty ${i}`,
          score: 0.5,
          content: '',
        })
    );

    const result = degradationFallback('q', items, 'r');

    // All sources present
    expect(result.sources.length).toBe(100);
    // No keyPoints (all empty)
    expect(result.keyPoints).toEqual([]);
    // Answer is prefix + separator (no content)
    expect(result.answer).toBe(`${DEGRADATION_PREFIX}\n\n`);
  });

  it('handles 100 items with large content', () => {
    const items = Array.from(
      { length: 100 },
      (_, i) =>
        makeItem({
          url: `https://big${i}.com`,
          title: `Big ${i}`,
          score: 1 - i * 0.001,
          content: 'Large content. ' + 'X'.repeat(500),
        })
    );

    const result = degradationFallback('q', items, 'r');

    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
    expect(result.sources.length).toBe(100);
    expect(result.keyPoints.length).toBe(10);
  });

  it('handles alternating empty and non-empty items in a large batch', () => {
    const items = Array.from(
      { length: 40 },
      (_, i) =>
        makeItem({
          url: `https://mix${i}.com`,
          title: `Mix ${i}`,
          score: 1 - i * 0.01,
          content: i % 2 === 0 ? `Content ${i} here. More text.` : '',
        })
    );

    const result = degradationFallback('q', items, 'r');

    // All 40 sources
    expect(result.sources.length).toBe(40);
    // Only items 0,2,4,...,18 (even indices in top 10 by score) have content
    // → at most 10 keyPoints (capped, but only top 10 by score are checked)
    const nonEmptyInTop10 = items.slice(0, 10).filter(i => i.content.trim().length > 0).length;
    expect(result.keyPoints.length).toBe(nonEmptyInTop10);
    // Answer within limit
    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
  });

  it('handles items where only the last items have content', () => {
    const items = Array.from(
      { length: 20 },
      (_, i) =>
        makeItem({
          url: `https://last${i}.com`,
          title: `Last ${i}`,
          score: 1 - i * 0.01,
          content: i >= 18 ? `Item ${i} content here. More.` : '',
        })
    );

    const result = degradationFallback('q', items, 'r');

    // All 20 sources
    expect(result.sources.length).toBe(20);
    // keyPoints are from top 10 by score (items 0-9), which all have empty
    // content → 0 keyPoints. Items 18 and 19 are ranked below 10.
    expect(result.keyPoints.length).toBe(0);
  });
});

// ===========================================================================
// degradationFallback — answer content integrity
// ===========================================================================

describe('degradationFallback — answer content integrity', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('answer contains raw content without modification (no truncation)', () => {
    const content = 'This is the exact content text that should appear.';
    const items = [makeItem({ content })];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer).toBe(`${DEGRADATION_PREFIX}\n\n${content}`);
  });

  it('answer does not contain snippet field from ContentItem', () => {
    const items = [
      makeItem({
        snippet: 'This snippet should not appear.',
        content: 'Content text here. More.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer).not.toContain('This snippet should not appear.');
  });

  it('answer does not contain score field from ContentItem', () => {
    const items = [
      makeItem({
        score: 0.42,
        content: 'Content text here. More.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer).not.toContain('0.42');
    expect(result.answer).not.toContain('score');
  });

  it('answer does not contain URL field from ContentItem (unless in content)', () => {
    const items = [
      makeItem({
        url: 'https://very-special-url-12345.com',
        content: 'Content text here. More.',
      }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer).not.toContain('https://very-special-url-12345.com');
  });

  it('answer includes content from multiple items joined by double newlines', () => {
    const items = [
      makeItem({ score: 0.9, content: 'First content. More.' }),
      makeItem({ score: 0.5, content: 'Second content. More.' }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer).toContain(`${DEGRADATION_PREFIX}\n\nFirst content.`);
    expect(result.answer).toContain('\n\nSecond content.');
  });

  it('answer respects the 2000-char budget across prefix and all content', () => {
    const items = [
      makeItem({ score: 0.9, content: 'A'.repeat(1000) }),
      makeItem({ score: 0.5, content: 'B'.repeat(1000) }),
      makeItem({ score: 0.3, content: 'C'.repeat(1000) }),
    ];

    const result = degradationFallback('q', items, 'r');

    expect(result.answer.length).toBeLessThanOrEqual(MAX_DEGRADATION_ANSWER);
    // The highest-scored content (A's) should be fully included
    expect(result.answer).toContain('A'.repeat(1000));
  });

  it('keyPoints do not include content from items ranked below position 10', () => {
    const items = Array.from(
      { length: 12 },
      (_, i) =>
        makeItem({
          url: `https://kp-rank${i}.com`,
          score: 1 - i * 0.01,
          content: `Rank ${i} sentence here. More text.`,
        })
    );

    const result = degradationFallback('q', items, 'r');

    expect(result.keyPoints.length).toBe(10);
    // Items 10 and 11 should NOT be in keyPoints
    const allKp = result.keyPoints.join(' ');
    expect(allKp).not.toContain('Rank 10');
    expect(allKp).not.toContain('Rank 11');
    // Items 0-9 should be present
    expect(allKp).toContain('Rank 0');
    expect(allKp).toContain('Rank 9');
  });
});
