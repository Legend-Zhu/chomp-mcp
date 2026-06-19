/**
 * End-to-end tests for the deduplicator pipeline — covers the full
 * `deduplicate()` entry point including URL normalization, exact-URL dedup,
 * exact-content dedup, near-duplicate merge, error resilience, output field
 * validation, determinism, immutability, config override, and stats logging.
 *
 * [Spec: US-DD-009, US-DD-010, US-DD-011, BG-DD-001, BG-DD-002, BG-DD-003]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deduplicate } from '../../../src/modules/deduplicate/index.js';
import type { ContentItem } from '../../../src/shared/types/content.js';
import type { DeduplicatedItem, DDConfig } from '../../../src/shared/types/deduplicate.js';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a ContentItem fixture with the given fields and sensible defaults.
 */
function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    title: overrides.title ?? 'Test Title',
    url: overrides.url ?? 'https://example.com/page',
    snippet: overrides.snippet ?? 'A snippet.',
    score: overrides.score ?? 0.5,
    content:
      overrides.content ??
      'This is some default content text that is long enough.',
  };
}

/** Standard multi-paragraph content strings used across tests. */
const PARA_A = 'The quick brown fox jumps over the lazy dog today.';
const PARA_B = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed.';
const PARA_C = 'A third paragraph about a completely different topic here.';
const PARA_D = 'The fourth paragraph continues the discussion further now.';
const PARA_E = 'Fifth paragraph with additional important context details.';
const PARA_F = 'Sixth paragraph wrapping up the main points discussed.';
const PARA_G = 'Seventh paragraph that is unique to the second source.';

/** Content consisting of paragraphs A through F. */
const CONTENT_ABCEF = [PARA_A, PARA_B, PARA_C, PARA_D, PARA_E, PARA_F].join('\n\n');
/** Content consisting of paragraphs A through F plus G. */
const CONTENT_ABCEFG = [PARA_A, PARA_B, PARA_C, PARA_D, PARA_E, PARA_F, PARA_G].join('\n\n');

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe('deduplicate — empty input', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-011]
  it('returns an empty array for empty input without throwing', () => {
    const result = deduplicate([]);
    expect(result).toEqual([]);
  });

  // [Implements: US-DD-009, BG-DD-001]
  it('logs a summary with zero counts even for empty input', () => {
    deduplicate([]);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DD] summary')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('input=0')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('output=0')
    );
  });
});

// ---------------------------------------------------------------------------
// Single item
// ---------------------------------------------------------------------------

describe('deduplicate — single item', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-011]
  it('returns a single item after URL normalization without pairwise comparison', () => {
    const item = makeItem({
      url: 'https://example.com/page?utm_source=google',
      content: PARA_A,
    });
    const result = deduplicate([item]);
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-010]
  it('normalizes the URL in the output (strips tracking params)', () => {
    const item = makeItem({
      url: 'https://example.com/page?utm_source=google&fbclid=abc',
      content: PARA_A,
    });
    const result = deduplicate([item]);
    expect(result).toHaveLength(1);
    expect(result[0].normalizedUrl).toBe('https://example.com/page');
  });

  // [Implements: US-DD-010]
  it('converts http scheme to https in normalizedUrl', () => {
    const item = makeItem({
      url: 'http://example.com/page',
      content: PARA_A,
    });
    const result = deduplicate([item]);
    expect(result[0].normalizedUrl).toBe('https://example.com/page');
  });

  // [Implements: US-DD-010]
  it('lowercases hostname in normalizedUrl', () => {
    const item = makeItem({
      url: 'https://EXAMPLE.COM/Page',
      content: PARA_A,
    });
    const result = deduplicate([item]);
    expect(result[0].normalizedUrl).toBe('https://example.com/Page');
  });

  // [Implements: US-DD-010]
  it('preserves original url field (not normalized) in output', () => {
    const item = makeItem({
      url: 'https://example.com/page?utm_source=x',
      content: PARA_A,
    });
    const result = deduplicate([item]);
    expect(result[0].url).toBe('https://example.com/page?utm_source=x');
  });
});

// ---------------------------------------------------------------------------
// URL deduplication
// ---------------------------------------------------------------------------

describe('deduplicate — URL deduplication', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-003]
  it('retains the highest-scored item when URLs normalize to the same value', () => {
    const items = [
      makeItem({ url: 'https://example.com/article?utm_source=a', score: 0.3, content: PARA_A }),
      makeItem({ url: 'https://example.com/article', score: 0.9, content: PARA_B }),
      makeItem({ url: 'http://example.com/article/?ref=nav', score: 0.5, content: PARA_C }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
  });

  // [Implements: US-DD-003]
  it('retains earliest originalIndex when scores are equal', () => {
    const items = [
      makeItem({ url: 'https://example.com/article?utm_source=a', score: 0.8, content: PARA_A }),
      makeItem({ url: 'https://example.com/article', score: 0.8, content: PARA_B }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com/article?utm_source=a');
  });

  // [Implements: US-DD-003]
  it('copies discarded URLs into mergedSources of the retained item', () => {
    const items = [
      makeItem({ url: 'https://example.com/article?utm_source=a', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://example.com/article', score: 0.3, content: PARA_B }),
      makeItem({ url: 'http://example.com/article/?ref=nav', score: 0.5, content: PARA_C }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].mergedSources).toContain('https://example.com/article');
    expect(result[0].mergedSources).toContain('http://example.com/article/?ref=nav');
    // Retained item's own URL should NOT be in mergedSources
    expect(result[0].mergedSources).not.toContain('https://example.com/article?utm_source=a');
  });

  // [Implements: US-DD-003]
  it('handles multiple independent URL-duplicate groups', () => {
    const items = [
      makeItem({ url: 'https://a.com/1?utm_source=x', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://a.com/1', score: 0.3, content: PARA_B }),
      makeItem({ url: 'https://b.com/2?ref=nav', score: 0.8, content: PARA_C }),
      makeItem({ url: 'https://b.com/2/', score: 0.2, content: PARA_D }),
      makeItem({ url: 'https://c.com/3', score: 0.7, content: PARA_E }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(3);
    expect(result.some((r) => r.score === 0.9)).toBe(true);
    expect(result.some((r) => r.score === 0.8)).toBe(true);
    expect(result.some((r) => r.score === 0.7)).toBe(true);
  });

  // [Implements: BG-DD-001]
  it('logs the exact-url-dups removal count to stderr', () => {
    const items = [
      makeItem({ url: 'https://a.com?utm_source=x', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://a.com', score: 0.3, content: PARA_B }),
    ];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-url-dups removed=1')
    );
  });
});

// ---------------------------------------------------------------------------
// Exact-content deduplication
// ---------------------------------------------------------------------------

describe('deduplicate — exact-content deduplication', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-007]
  it('merges items with identical content (different URLs) into one', () => {
    const items = [
      makeItem({ url: 'https://site-a.com/page', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://site-b.com/page', score: 0.5, content: PARA_A }),
      makeItem({ url: 'https://site-c.com/page', score: 0.3, content: PARA_A }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
    expect(result[0].url).toBe('https://site-a.com/page');
  });

  // [Implements: US-DD-007]
  it('populates mergedSources with URLs of exact-content duplicates', () => {
    const items = [
      makeItem({ url: 'https://site-a.com/page', score: 0.9, content: CONTENT_ABCEF }),
      makeItem({ url: 'https://site-b.com/page', score: 0.3, content: CONTENT_ABCEF }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].mergedSources).toContain('https://site-b.com/page');
  });

  // [Implements: US-DD-007]
  it('does not merge items with different content', () => {
    const items = [
      makeItem({ url: 'https://site-a.com/page', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://site-b.com/page', score: 0.5, content: PARA_B }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(2);
  });

  // [Implements: BG-DD-001]
  it('logs the exact-content-dups removal count to stderr', () => {
    const items = [
      makeItem({ url: 'https://a.com', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://b.com', score: 0.3, content: PARA_A }),
    ];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-content-dups removed=1')
    );
  });
});

// ---------------------------------------------------------------------------
// Near-duplicate merge
// ---------------------------------------------------------------------------

describe('deduplicate — near-duplicate merge', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-008] Two items with 6/7 shared paragraphs → Jaccard ≈ 0.857 ≥ 0.85
  it('merges near-duplicate items at default threshold (6/7 ≈ 0.857)', () => {
    const items = [
      makeItem({ url: 'https://site-a.com/article', score: 0.9, content: CONTENT_ABCEF }),
      makeItem({ url: 'https://site-b.com/article', score: 0.5, content: CONTENT_ABCEFG }),
    ];
    const result = deduplicate(items);
    // A has fingerprints {fpA..fpF}, B has {fpA..fpF, fpG}
    // Jaccard = 6/7 ≈ 0.857 ≥ 0.85 → merge
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
  });

  // [Implements: US-DD-008]
  it('populates mergedSources for near-duplicate merge', () => {
    const items = [
      makeItem({ url: 'https://site-a.com/article', score: 0.9, content: CONTENT_ABCEF }),
      makeItem({ url: 'https://site-b.com/article', score: 0.3, content: CONTENT_ABCEFG }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].mergedSources).toContain('https://site-b.com/article');
  });

  // [Implements: US-DD-008] Items with no shared paragraphs → no merge
  it('does not merge items with completely different content', () => {
    const items = [
      makeItem({ url: 'https://site-a.com', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://site-b.com', score: 0.5, content: PARA_B }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(2);
  });

  // [Implements: BG-DD-001]
  it('logs near-dup removal count to stderr', () => {
    const items = [
      makeItem({ url: 'https://site-a.com', score: 0.9, content: CONTENT_ABCEF }),
      makeItem({ url: 'https://site-b.com', score: 0.3, content: CONTENT_ABCEFG }),
    ];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('near-dups removed=1')
    );
  });
});

// ---------------------------------------------------------------------------
// Empty content removal
// ---------------------------------------------------------------------------

describe('deduplicate — empty content removal', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-011]
  it('removes items with empty string content', () => {
    const items = [
      makeItem({ url: 'https://empty.com', content: '', score: 0.5 }),
      makeItem({ url: 'https://valid.com', content: PARA_A, score: 0.8 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://valid.com');
  });

  // [Implements: US-DD-011]
  it('removes items with whitespace-only content', () => {
    const items = [
      makeItem({ url: 'https://ws.com', content: '   \n\t  ', score: 0.5 }),
      makeItem({ url: 'https://valid.com', content: PARA_A, score: 0.8 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://valid.com');
  });

  // [Implements: US-DD-011]
  it('logs a warning to stderr with the empty item URL', () => {
    const items = [
      makeItem({ url: 'https://empty.com/page', content: '', score: 0.5 }),
      makeItem({ url: 'https://valid.com', content: PARA_A, score: 0.8 }),
    ];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('WARN empty content')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://empty.com/page')
    );
  });

  // [Implements: US-DD-011]
  it('returns empty array when all items have empty content', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: '', score: 0.5 }),
      makeItem({ url: 'https://b.com', content: '   ', score: 0.3 }),
    ];
    const result = deduplicate(items);
    expect(result).toEqual([]);
  });

  // [Implements: BG-DD-001]
  it('counts empty-removed items in the summary', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: '', score: 0.5 }),
      makeItem({ url: 'https://b.com', content: PARA_A, score: 0.8 }),
    ];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('empty=1')
    );
  });
});

// ---------------------------------------------------------------------------
// Error resilience — malformed URLs
// ---------------------------------------------------------------------------

describe('deduplicate — malformed URL error handling', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-009, BG-DD-002]
  it('skips items with malformed URLs and continues processing remaining items', () => {
    const items = [
      makeItem({ url: 'not-a-valid-url', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://valid.com/page', content: PARA_B, score: 0.8 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://valid.com/page');
  });

  // [Implements: US-DD-009, BG-DD-002]
  it('skips items with URLs lacking a scheme', () => {
    const items = [
      makeItem({ url: 'example.com/path', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://valid.com/page', content: PARA_B, score: 0.8 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://valid.com/page');
  });

  // [Implements: US-DD-009]
  it('logs the error to stderr with the malformed item URL', () => {
    const items = [
      makeItem({ url: 'not-a-valid-url', content: PARA_A, score: 0.5 }),
    ];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('ERROR normalize-url')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('not-a-valid-url')
    );
  });

  // [Implements: US-DD-009]
  it('handles multiple malformed URLs in the same input', () => {
    const items = [
      makeItem({ url: 'bad-url-1', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://valid-a.com', content: PARA_B, score: 0.8 }),
      makeItem({ url: 'bad-url-2', content: PARA_C, score: 0.3 }),
      makeItem({ url: 'https://valid-b.com', content: PARA_D, score: 0.7 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(2);
    expect(result.some((r) => r.url === 'https://valid-a.com')).toBe(true);
    expect(result.some((r) => r.url === 'https://valid-b.com')).toBe(true);
  });

  // [Implements: US-DD-009]
  it('does not throw when all items have malformed URLs', () => {
    const items = [
      makeItem({ url: 'bad-url-1', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'bad-url-2', content: PARA_B, score: 0.3 }),
    ];
    expect(() => deduplicate(items)).not.toThrow();
    expect(deduplicate(items)).toEqual([]);
  });

  // [Implements: BG-DD-001]
  it('counts error-removed items in the summary', () => {
    const items = [
      makeItem({ url: 'bad-url', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://valid.com', content: PARA_B, score: 0.8 }),
    ];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('errors=1')
    );
  });
});

// ---------------------------------------------------------------------------
// Combined error scenarios
// ---------------------------------------------------------------------------

describe('deduplicate — combined error and dedup scenarios', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-009, US-DD-011]
  it('handles a mix of empty-content, malformed-URL, URL-dup, and valid items', () => {
    const items = [
      // Empty content
      makeItem({ url: 'https://empty.com', content: '', score: 0.1 }),
      // Malformed URL
      makeItem({ url: 'not-a-url', content: PARA_A, score: 0.2 }),
      // URL duplicate pair
      makeItem({ url: 'https://dup.com/article?utm_source=x', content: PARA_B, score: 0.3 }),
      makeItem({ url: 'https://dup.com/article', content: PARA_C, score: 0.9 }),
      // Valid unique items
      makeItem({ url: 'https://unique-a.com', content: PARA_D, score: 0.7 }),
      makeItem({ url: 'https://unique-b.com', content: PARA_E, score: 0.6 }),
    ];
    const result = deduplicate(items);
    // 6 input: 1 empty removed, 1 error removed, 1 URL dup removed → 3 output
    expect(result).toHaveLength(3);
    expect(result.some((r) => r.url === 'https://dup.com/article')).toBe(true);
    expect(result.some((r) => r.url === 'https://unique-a.com')).toBe(true);
    expect(result.some((r) => r.url === 'https://unique-b.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Output field validation
// ---------------------------------------------------------------------------

describe('deduplicate — output field validation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-010]
  it('includes all required DeduplicatedItem fields in output', () => {
    const items = [
      makeItem({
        title: 'Test Article',
        url: 'https://example.com/page',
        snippet: 'A test snippet.',
        score: 0.75,
        content: PARA_A,
      }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item.title).toBe('Test Article');
    expect(item.url).toBe('https://example.com/page');
    expect(item.snippet).toBe('A test snippet.');
    expect(item.score).toBe(0.75);
    expect(item.content).toBe(PARA_A);
    expect(item.normalizedUrl).toBe('https://example.com/page');
    expect(item.mergedSources).toEqual([]);
    expect(item.fingerprintCount).toBe(1);
  });

  // [Implements: US-DD-010]
  it('normalizedUrl is always a non-empty string', () => {
    const items = [
      makeItem({ url: 'https://a.com/page', content: PARA_A }),
      makeItem({ url: 'http://b.com:80/path/?q=1', content: PARA_B }),
    ];
    const result = deduplicate(items);
    for (const item of result) {
      expect(typeof item.normalizedUrl).toBe('string');
      expect(item.normalizedUrl.length).toBeGreaterThan(0);
    }
  });

  // [Implements: US-DD-010]
  it('mergedSources is always an array (possibly empty)', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A }),
      makeItem({ url: 'https://b.com', content: PARA_B }),
    ];
    const result = deduplicate(items);
    for (const item of result) {
      expect(Array.isArray(item.mergedSources)).toBe(true);
    }
    // No merges → all mergedSources should be empty
    expect(result.every((r) => r.mergedSources.length === 0)).toBe(true);
  });

  // [Implements: US-DD-010]
  it('fingerprintCount is always a non-negative integer', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A }),
      makeItem({ url: 'https://b.com', content: `${PARA_A}\n\n${PARA_B}\n\n${PARA_C}` }),
    ];
    const result = deduplicate(items);
    for (const item of result) {
      expect(Number.isInteger(item.fingerprintCount)).toBe(true);
      expect(item.fingerprintCount).toBeGreaterThanOrEqual(0);
    }
  });

  // [Implements: US-DD-010]
  it('fingerprintCount equals the number of unique qualifying paragraphs', () => {
    const multiParaContent = [PARA_A, PARA_B, PARA_C].join('\n\n');
    const items = [
      makeItem({ url: 'https://a.com', content: multiParaContent }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].fingerprintCount).toBe(3);
  });

  // [Implements: US-DD-010]
  it('retained item retains the original content field', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_A, score: 0.3 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(PARA_A);
  });
});

// ---------------------------------------------------------------------------
// Input immutability
// ---------------------------------------------------------------------------

describe('deduplicate — input immutability (pure function)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: BG-DD-003]
  it('does not mutate the input array', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://b.com', content: PARA_B, score: 0.8 }),
    ];
    const originalLength = items.length;
    deduplicate(items);
    expect(items.length).toBe(originalLength);
  });

  // [Implements: BG-DD-003]
  it('does not mutate any item in the input array (deep clone comparison)', () => {
    const items = [
      makeItem({ url: 'https://a.com?utm_source=x', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://b.com', content: PARA_B, score: 0.8 }),
      makeItem({ url: 'https://a.com?ref=nav', content: PARA_A, score: 0.3 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(items));
    deduplicate(items);
    expect(JSON.parse(JSON.stringify(items))).toEqual(snapshot);
  });

  // [Implements: BG-DD-003]
  it('does not mutate item content strings', () => {
    const content = `${PARA_A}\n\n${PARA_B}`;
    const items = [
      makeItem({ url: 'https://a.com', content, score: 0.5 }),
    ];
    deduplicate(items);
    expect(items[0].content).toBe(content);
  });

  // [Implements: BG-DD-003]
  it('does not mutate item url strings', () => {
    const url = 'https://example.com/page?utm_source=google';
    const items = [
      makeItem({ url, content: PARA_A, score: 0.5 }),
    ];
    deduplicate(items);
    expect(items[0].url).toBe(url);
  });

  // [Implements: BG-DD-003]
  it('returns a new array (not the same reference as input)', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.5 }),
    ];
    const result = deduplicate(items);
    expect(result).not.toBe(items);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('deduplicate — determinism', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: BG-DD-002]
  it('produces identical output for the same input across two calls', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://b.com', content: PARA_B, score: 0.8 }),
      makeItem({ url: 'https://a.com?utm_source=x', content: PARA_C, score: 0.3 }),
    ];
    const result1 = deduplicate(items);
    const result2 = deduplicate(items);
    expect(result1.length).toBe(result2.length);
    for (let i = 0; i < result1.length; i++) {
      expect(result1[i].url).toBe(result2[i].url);
      expect(result1[i].normalizedUrl).toBe(result2[i].normalizedUrl);
      expect(result1[i].score).toBe(result2[i].score);
      expect(result1[i].fingerprintCount).toBe(result2[i].fingerprintCount);
      expect(result1[i].mergedSources).toEqual(result2[i].mergedSources);
    }
  });

  // [Implements: BG-DD-002]
  it('produces identical output for the same input across many calls', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: CONTENT_ABCEF, score: 0.5 }),
      makeItem({ url: 'https://b.com', content: CONTENT_ABCEFG, score: 0.9 }),
    ];
    const results: DeduplicatedItem[][] = [];
    for (let i = 0; i < 5; i++) {
      results.push(deduplicate(items));
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i].length).toBe(results[0].length);
      for (let j = 0; j < results[0].length; j++) {
        expect(results[i][j].url).toBe(results[0][j].url);
        expect(results[i][j].mergedSources).toEqual(results[0][j].mergedSources);
      }
    }
  });

  // [Implements: BG-DD-002]
  it('produces consistent mergedSources across repeated calls', () => {
    const items = [
      makeItem({ url: 'https://a.com?utm_source=x', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://a.com', content: PARA_B, score: 0.3 }),
      makeItem({ url: 'https://a.com?ref=nav', content: PARA_C, score: 0.5 }),
    ];
    const result1 = deduplicate(items);
    const result2 = deduplicate(items);
    expect(result1[0].mergedSources).toEqual(result2[0].mergedSources);
  });
});

// ---------------------------------------------------------------------------
// Config override
// ---------------------------------------------------------------------------

describe('deduplicate — config override', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-010] Custom similarityThreshold affects near-dup merge
  it('uses custom similarityThreshold to merge items that would not merge at default', () => {
    // Items A and B share 2 of 4 unique paragraphs → Jaccard = 2/4 = 0.5
    const contentA = `${PARA_A}\n\n${PARA_B}\n\n${PARA_C}`;
    const contentB = `${PARA_A}\n\n${PARA_B}\n\n${PARA_D}`;

    const items = [
      makeItem({ url: 'https://a.com', score: 0.9, content: contentA }),
      makeItem({ url: 'https://b.com', score: 0.5, content: contentB }),
    ];

    // At default threshold 0.85: 0.5 < 0.85 → no merge
    const defaultResult = deduplicate(items);
    expect(defaultResult).toHaveLength(2);

    // At custom threshold 0.5: 0.5 >= 0.5 → merge
    const customConfig: DDConfig = {
      similarityThreshold: 0.5,
      minParagraphChars: 20,
      extraTrackingParams: [],
    };
    const customResult = deduplicate(items, customConfig);
    expect(customResult).toHaveLength(1);
    expect(customResult[0].score).toBe(0.9);
  });

  // [Implements: US-DD-010] Custom minParagraphChars affects fingerprinting
  it('uses custom minParagraphChars to fingerprint more paragraphs', () => {
    // Content with a short paragraph (below default 20 but above 5)
    const shortPara = 'Short text here.'; // 16 chars
    const content = `${shortPara}\n\n${PARA_A}`;

    const items = [
      makeItem({ url: 'https://a.com', content, score: 0.9 }),
    ];

    // Default minParagraphChars (20) → shortPara is filtered → 1 fingerprint
    const defaultResult = deduplicate(items);
    expect(defaultResult[0].fingerprintCount).toBe(1);

    // Custom minParagraphChars (5) → shortPara passes → 2 fingerprints
    const customConfig: DDConfig = {
      similarityThreshold: 0.85,
      minParagraphChars: 5,
      extraTrackingParams: [],
    };
    const customResult = deduplicate(items, customConfig);
    expect(customResult[0].fingerprintCount).toBe(2);
  });

  // [Implements: US-DD-010] Custom extraTrackingParams strips additional params
  it('uses custom extraTrackingParams for URL normalization', () => {
    const items = [
      makeItem({ url: 'https://a.com/page?custom_track=1&keep=1', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://a.com/page?keep=1', content: PARA_B, score: 0.5 }),
    ];

    const customConfig: DDConfig = {
      similarityThreshold: 0.85,
      minParagraphChars: 20,
      extraTrackingParams: ['custom_track'],
    };
    const result = deduplicate(items, customConfig);
    // With custom_track stripped, both URLs normalize to the same → URL dedup → 1 item
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-010]
  it('threshold 0.0 merges all items with any content', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_B, score: 0.5 }),
      makeItem({ url: 'https://c.com', content: PARA_C, score: 0.3 }),
    ];
    const config: DDConfig = {
      similarityThreshold: 0.0,
      minParagraphChars: 20,
      extraTrackingParams: [],
    };
    const result = deduplicate(items, config);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
  });

  // [Implements: US-DD-010]
  it('threshold 1.0 only merges identical content', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://c.com', content: PARA_B, score: 0.3 }),
    ];
    const config: DDConfig = {
      similarityThreshold: 1.0,
      minParagraphChars: 20,
      extraTrackingParams: [],
    };
    const result = deduplicate(items, config);
    // Items with PARA_A are exact-content dups (merged regardless of threshold)
    // Item with PARA_B is unique → no near-dup at threshold 1.0
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Duplicate reduction ratio
// ---------------------------------------------------------------------------

describe('deduplicate — duplicate reduction ratio', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-010]
  it('significantly reduces item count on a dataset with duplicates at every level', () => {
    const items: ContentItem[] = [
      // 3 URL duplicates (same normalized URL, different tracking params)
      makeItem({ url: 'https://example.com/article?utm_source=a', score: 0.3, content: PARA_A }),
      makeItem({ url: 'https://example.com/article', score: 0.9, content: PARA_B }),
      makeItem({ url: 'http://example.com/article/?ref=nav', score: 0.5, content: PARA_C }),
      // 3 exact-content duplicates (same content, different URLs)
      makeItem({ url: 'https://site-a.com/page', score: 0.8, content: PARA_D }),
      makeItem({ url: 'https://site-b.com/page', score: 0.6, content: PARA_D }),
      makeItem({ url: 'https://site-c.com/page', score: 0.4, content: PARA_D }),
      // 2 unique items
      makeItem({ url: 'https://unique-a.com', score: 0.7, content: PARA_E }),
      makeItem({ url: 'https://unique-b.com', score: 0.2, content: PARA_F }),
    ];

    const result = deduplicate(items);
    // 3 URL dups → 1, 3 content dups → 1, 2 unique → 2, total = 4
    expect(result.length).toBeLessThan(items.length);
    expect(result.length).toBe(4);
    // Reduction ratio: (8 - 4) / 8 = 50%
    const reductionRatio = (items.length - result.length) / items.length;
    expect(reductionRatio).toBeGreaterThanOrEqual(0.5);
  });

  // [Implements: US-DD-010]
  it('does not reduce item count when no duplicates exist', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_B, score: 0.8 }),
      makeItem({ url: 'https://c.com', content: PARA_C, score: 0.7 }),
    ];
    const result = deduplicate(items);
    expect(result.length).toBe(items.length);
  });

  // [Implements: US-DD-010]
  it('handles a larger dataset with mixed duplicates', () => {
    const items: ContentItem[] = [];

    // 5 pairs of URL duplicates (10 items → 5 retained)
    for (let i = 0; i < 5; i++) {
      items.push(
        makeItem({
          url: `https://site-${i}.com/article?utm_source=x`,
          score: 0.3 + i * 0.01,
          content: `Paragraph content for item ${i} that is long enough to pass.`,
        })
      );
      items.push(
        makeItem({
          url: `https://site-${i}.com/article`,
          score: 0.9 - i * 0.01,
          content: `Different content for dup ${i} that is long enough to pass.`,
        })
      );
    }

    // 3 exact-content duplicates (3 items → 1 retained)
    for (let i = 0; i < 3; i++) {
      items.push(
        makeItem({
          url: `https://mirror-${i}.com/same`,
          score: 0.5 + i * 0.1,
          content: PARA_E,
        })
      );
    }

    // 2 unique items
    items.push(makeItem({ url: 'https://uniq-1.com', score: 0.6, content: PARA_A }));
    items.push(makeItem({ url: 'https://uniq-2.com', score: 0.4, content: PARA_B }));

    const result = deduplicate(items);
    // 10 URL dups → 5, 3 content dups → 1, 2 unique → 2, total = 8
    // But the content dedup items have different URLs from URL dups, and PARA_E
    // is different from all URL dup content, so they are separate.
    expect(result.length).toBeLessThan(items.length);
  });
});

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

describe('deduplicate — latency', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: BG-DD-002]
  it('completes processing of 5 items in under 500ms', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      makeItem({
        url: `https://example-${i}.com/page`,
        score: 0.5 + i * 0.05,
        content: `This is paragraph number ${i} with enough text content to pass the minimum threshold.`,
      })
    );
    const start = Date.now();
    deduplicate(items);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  // [Implements: BG-DD-002]
  it('completes processing of 8 items with duplicates in under 500ms', () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      makeItem({
        url: i < 4
          ? `https://example.com/article?utm_source=${i}`
          : `https://unique-${i}.com/page`,
        score: 0.5 + i * 0.05,
        content: `Paragraph content for item ${i} with enough text to pass threshold.`,
      })
    );
    const start = Date.now();
    deduplicate(items);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  // [Implements: BG-DD-002]
  it('completes processing of 6 items with multi-paragraph content in under 500ms', () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      makeItem({
        url: `https://example-${i}.com/page`,
        score: 0.5 + i * 0.05,
        content: [PARA_A, PARA_B, PARA_C, PARA_D].join('\n\n'),
      })
    );
    const start = Date.now();
    deduplicate(items);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Stats summary logging
// ---------------------------------------------------------------------------

describe('deduplicate — stats summary logging', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-009, BG-DD-001]
  it('logs a summary line containing all required counts', () => {
    const items = [
      makeItem({ url: 'https://a.com?utm_source=x', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://a.com', content: PARA_B, score: 0.3 }),
    ];
    deduplicate(items);
    // Summary should contain input count, exact-url-dups, exact-content-dups,
    // near-dups, and output count
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DD] summary')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('input=2')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-url-dups=1')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-content-dups=0')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('near-dups=0')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('output=1')
    );
  });

  // [Implements: US-DD-009, BG-DD-001]
  it('logs summary with zero counts when no items are removed', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_B, score: 0.5 }),
    ];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-url-dups=0')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-content-dups=0')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('near-dups=0')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('output=2')
    );
  });

  // [Implements: US-DD-009, BG-DD-001]
  it('logs summary even when input is empty', () => {
    deduplicate([]);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DD] summary')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('input=0')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('output=0')
    );
  });

  // [Implements: US-DD-009]
  it('logs summary with elapsed time', () => {
    const items = [makeItem({ url: 'https://a.com', content: PARA_A, score: 0.5 })];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('elapsedMs=')
    );
  });

  // [Implements: US-DD-009]
  it('logs all removal counts for a complex dataset', () => {
    const items = [
      // Empty content
      makeItem({ url: 'https://empty.com', content: '', score: 0.1 }),
      // Malformed URL
      makeItem({ url: 'bad-url', content: PARA_A, score: 0.2 }),
      // URL duplicate
      makeItem({ url: 'https://dup.com/a?utm_source=x', content: PARA_B, score: 0.3 }),
      makeItem({ url: 'https://dup.com/a', content: PARA_C, score: 0.9 }),
      // Exact content duplicate
      makeItem({ url: 'https://cont-a.com', content: PARA_D, score: 0.5 }),
      makeItem({ url: 'https://cont-b.com', content: PARA_D, score: 0.4 }),
    ];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('input=6')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('empty=1')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('errors=1')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-url-dups=1')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-content-dups=1')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('output=2')
    );
  });
});

// ---------------------------------------------------------------------------
// Full pipeline order verification
// ---------------------------------------------------------------------------

describe('deduplicate — full pipeline order', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-010] URL dedup happens before content dedup
  it('URL dedup runs before exact-content dedup', () => {
    // Two items with same URL AND same content → URL dedup removes one
    const items = [
      makeItem({ url: 'https://same.com?utm_source=a', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://same.com', content: PARA_A, score: 0.3 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    // URL dedup should count 1 removal, content dedup should count 0
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-url-dups removed=1')
    );
    // Content dedup should NOT log (no duplicates after URL dedup)
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('exact-content-dups removed=')
    );
  });

  // [Implements: US-DD-010] Content dedup runs before near-dup merge
  it('exact-content dedup runs before near-dup merge', () => {
    // Three items with identical content → exact-content dedup removes 2
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://c.com', content: PARA_A, score: 0.3 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    // Exact-content dedup should count 2 removals
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-content-dups removed=2')
    );
    // Near-dup should NOT log (only 1 item after content dedup)
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('near-dups removed=')
    );
  });

  // [Implements: US-DD-010]
  it('all three stages contribute to the final output', () => {
    const items: ContentItem[] = [
      // URL duplicate group
      makeItem({ url: 'https://url-dup.com/a?utm_source=x', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://url-dup.com/a', content: PARA_B, score: 0.3 }),
      // Exact content duplicate (different URLs, same content)
      makeItem({ url: 'https://cont-1.com', content: PARA_C, score: 0.8 }),
      makeItem({ url: 'https://cont-2.com', content: PARA_C, score: 0.2 }),
      // Unique items that will go through near-dup without merging
      makeItem({ url: 'https://uniq-1.com', content: PARA_D, score: 0.7 }),
      makeItem({ url: 'https://uniq-2.com', content: PARA_E, score: 0.6 }),
    ];
    const result = deduplicate(items);
    // URL dup: 2 → 1; content dup: 2 → 1; unique: 2; total = 4
    expect(result).toHaveLength(4);
  });
});

// ===========================================================================
// ADDITIONAL ADVANCED TESTS (Part 2)
// ===========================================================================

// ---------------------------------------------------------------------------
// Cross-stage mergedSources propagation
// ---------------------------------------------------------------------------

describe('deduplicate — cross-stage mergedSources propagation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-003, US-DD-007] mergedSources accumulate from URL dedup through exact-content dedup
  it('accumulates mergedSources from URL dedup through exact-content dedup', () => {
    // Items a1 and a2 are URL dups → URL dedup removes a2 (mergedSources = [a2])
    // Items a1 and c have identical content → exact-content dedup removes c (mergedSources = [a2, c])
    const items = [
      makeItem({ url: 'https://a1.com?utm_source=x', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://a1.com', content: PARA_A, score: 0.3 }),
      makeItem({ url: 'https://c.com', content: PARA_A, score: 0.5 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].mergedSources).toContain('https://a1.com');
    expect(result[0].mergedSources).toContain('https://c.com');
    expect(result[0].mergedSources.length).toBe(2);
  });

  // [Implements: US-DD-003, US-DD-008] mergedSources from URL dedup propagate through near-dup merge
  it('accumulates mergedSources from URL dedup through near-dup merge', () => {
    const items = [
      // URL dup pair
      makeItem({ url: 'https://a.com?utm_source=x', content: CONTENT_ABCEF, score: 0.9 }),
      makeItem({ url: 'https://a.com', content: CONTENT_ABCEF, score: 0.3 }),
      // Near-dup of a (6/7 shared → Jaccard ≈ 0.857 ≥ 0.85)
      makeItem({ url: 'https://b.com', content: CONTENT_ABCEFG, score: 0.5 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    // mergedSources should contain both the URL-dup URL and the near-dup URL
    expect(result[0].mergedSources).toContain('https://a.com');
    expect(result[0].mergedSources).toContain('https://b.com');
    expect(result[0].mergedSources.length).toBe(2);
  });

  // [Implements: US-DD-007, US-DD-008] mergedSources from exact-content dedup propagate through near-dup merge
  it('accumulates mergedSources from exact-content dedup through near-dup merge', () => {
    const items = [
      // Exact-content dup pair (identical content)
      makeItem({ url: 'https://a.com', content: CONTENT_ABCEF, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: CONTENT_ABCEF, score: 0.3 }),
      // Near-dup of a (6/7 shared → Jaccard ≈ 0.857 ≥ 0.85)
      makeItem({ url: 'https://c.com', content: CONTENT_ABCEFG, score: 0.5 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    // mergedSources should contain both b (exact-content dup) and c (near-dup)
    expect(result[0].mergedSources).toContain('https://b.com');
    expect(result[0].mergedSources).toContain('https://c.com');
    expect(result[0].mergedSources.length).toBe(2);
  });

  // [Implements: US-DD-003, US-DD-007, US-DD-008] Full 3-stage mergedSources propagation
  it('accumulates mergedSources across all three stages (URL → content → near-dup)', () => {
    const items = [
      // Stage 1: URL dup of item 0
      makeItem({ url: 'https://a.com?utm_source=x', content: CONTENT_ABCEF, score: 0.9 }),
      makeItem({ url: 'https://a.com', content: CONTENT_ABCEF, score: 0.2 }),
      // Stage 2: Exact-content dup of item 0 (same content, different URL)
      makeItem({ url: 'https://b.com', content: CONTENT_ABCEF, score: 0.3 }),
      // Stage 3: Near-dup of item 0
      makeItem({ url: 'https://c.com', content: CONTENT_ABCEFG, score: 0.5 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    // The retained item (a.com?utm_source=x, score 0.9) should have mergedSources
    // from all three stages
    expect(result[0].mergedSources).toContain('https://a.com');
    expect(result[0].mergedSources).toContain('https://b.com');
    expect(result[0].mergedSources).toContain('https://c.com');
    expect(result[0].mergedSources.length).toBe(3);
  });

  // [Implements: US-DD-003] mergedSources does not include the retained item's own URL
  it('never includes the retained item own URL in mergedSources', () => {
    const items = [
      makeItem({ url: 'https://keep.com?utm_source=x', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://keep.com', content: PARA_A, score: 0.3 }),
      makeItem({ url: 'https://drop.com', content: PARA_A, score: 0.5 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].mergedSources).not.toContain('https://keep.com?utm_source=x');
    expect(result[0].mergedSources).not.toContain(result[0].url);
  });
});

// ---------------------------------------------------------------------------
// fingerprintCount edge cases
// ---------------------------------------------------------------------------

describe('deduplicate — fingerprintCount edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-010] Duplicate paragraphs within content produce deduplicated fingerprints
  it('deduplicates identical paragraphs within content (fingerprintCount < paragraph count)', () => {
    const content = [PARA_A, PARA_A, PARA_A].join('\n\n');
    const items = [makeItem({ url: 'https://a.com', content, score: 0.9 })];
    const result = deduplicate(items);
    expect(result[0].fingerprintCount).toBe(1);
  });

  // [Implements: US-DD-010]
  it('counts only paragraphs meeting minParagraphChars threshold', () => {
    const shortPara = 'Too short.'; // 10 chars, below default 20
    const content = [shortPara, PARA_A].join('\n\n');
    const items = [makeItem({ url: 'https://a.com', content, score: 0.9 })];
    const result = deduplicate(items);
    // Only PARA_A passes the 20-char threshold
    expect(result[0].fingerprintCount).toBe(1);
  });

  // [Implements: US-DD-010]
  it('returns fingerprintCount=0 for content with only sub-threshold paragraphs', () => {
    const content = 'Short.\n\nTiny.\n\nAbc.';
 // All below threshold
    const items = [makeItem({ url: 'https://a.com', content, score: 0.9 })];
    const result = deduplicate(items);
    expect(result[0].fingerprintCount).toBe(0);
  });

  // [Implements: US-DD-010]
  it('preserves fingerprintCount of retained item after merge', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: CONTENT_ABCEF, score: 0.9 }), // 6 fingerprints
      makeItem({ url: 'https://b.com', content: CONTENT_ABCEFG, score: 0.3 }), // 7 fingerprints
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    // The retained item is a.com (score 0.9) with 6 fingerprints
    expect(result[0].fingerprintCount).toBe(6);
  });

  // [Implements: US-DD-010] Different fingerprints produce different fingerprintCount values
  it('each output item has its own correct fingerprintCount', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }), // 1
      makeItem({ url: 'https://b.com', content: [PARA_A, PARA_B, PARA_C].join('\n\n'), score: 0.8 }), // 3
      makeItem({ url: 'https://c.com', content: [PARA_A, PARA_B, PARA_C, PARA_D, PARA_E].join('\n\n'), score: 0.7 }), // 5
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(3);
    const counts = result.map((r) => r.fingerprintCount).sort((a, b) => a - b);
    expect(counts).toEqual([1, 3, 5]);
  });
});

// ---------------------------------------------------------------------------
// Score edge cases
// ---------------------------------------------------------------------------

describe('deduplicate — score edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-003] Retains highest score even when all are negative
  it('retains the highest (least negative) score among URL duplicates', () => {
    const items = [
      makeItem({ url: 'https://a.com?utm_source=x', score: -0.5, content: PARA_A }),
      makeItem({ url: 'https://a.com', score: -0.1, content: PARA_B }),
      makeItem({ url: 'https://a.com?ref=nav', score: -0.9, content: PARA_C }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(-0.1);
  });

  // [Implements: US-DD-007] Retains highest score with zero scores in exact-content dedup
  it('retains item with score 0.0 over negative scores in exact-content dedup', () => {
    const items = [
      makeItem({ url: 'https://a.com', score: -0.5, content: PARA_A }),
      makeItem({ url: 'https://b.com', score: 0.0, content: PARA_A }),
      makeItem({ url: 'https://c.com', score: -0.3, content: PARA_A }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.0);
  });

  // [Implements: US-DD-008] Near-dup merge retains max score 1.0
  it('retains item with score 1.0 in near-dup merge', () => {
    const items = [
      makeItem({ url: 'https://a.com', score: 0.0, content: CONTENT_ABCEF }),
      makeItem({ url: 'https://b.com', score: 1.0, content: CONTENT_ABCEFG }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(1.0);
  });

  // [Implements: US-DD-003] Tie at zero scores → earliest originalIndex wins
  it('tie-breaks by originalIndex when all scores are zero', () => {
    const items = [
      makeItem({ url: 'https://z.com?utm_source=x', score: 0, content: PARA_A }),
      makeItem({ url: 'https://z.com', score: 0, content: PARA_A }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://z.com?utm_source=x');
  });

  // [Implements: US-DD-010] Score is preserved exactly in output (no rounding)
  it('preserves exact fractional scores in output', () => {
    const items = [
      makeItem({ url: 'https://a.com', score: 0.123456789, content: PARA_A }),
    ];
    const result = deduplicate(items);
    expect(result[0].score).toBe(0.123456789);
  });
});

// ---------------------------------------------------------------------------
// Near-dup transitive grouping at pipeline level
// ---------------------------------------------------------------------------

describe('deduplicate — near-dup transitive grouping (pipeline level)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-008] Transitive near-dup grouping at the deduplicate() level
  it('groups transitively: A~B, B~C (A and C not directly similar) with custom threshold', () => {
    // Using threshold 0.5:
    // A = [PARA_A, PARA_B, PARA_C]       → A~B: 3/5=0.6 >= 0.5
    // B = [PARA_A, PARA_B, PARA_C, PARA_D, PARA_E] → B~C: {D,E}∩{D,E,F} = 2/6 = 0.333 < 0.5
    // Let me design better fingerprints for transitivity at threshold 0.5
    // A = [1,2,3,4], B = [1,2,3,5,6], C = [5,6,7,8]
    // A~B: {1,2,3}=3, union={1,2,3,4,5,6}=6 → 0.5 >= 0.5 ✓
    // B~C: {5,6}=2, union={1,2,3,5,6,7,8}=7 → 0.286 < 0.5 ✗
    // Not transitive. Let's use higher threshold items:
    // A=[1..5], B=[1..5,6], C=[3,4,5,6,7] at threshold 0.5
    // A~B: 5/6≈0.833, B~C: {3,4,5,6}=4/8=0.5 ✓, A~C: {3,4,5}=3/7≈0.429 < 0.5
    // So A~B and B~C transitively but A!~C → all in one group
    const contentA = [PARA_A, PARA_B, PARA_C, PARA_D, PARA_E].join('\n\n');
    const contentB = [PARA_A, PARA_B, PARA_C, PARA_D, PARA_E, PARA_F].join('\n\n');
    const contentC = [PARA_C, PARA_D, PARA_E, PARA_F, PARA_G].join('\n\n');

    const items = [
      makeItem({ url: 'https://a.com', content: contentA, score: 0.3 }),
      makeItem({ url: 'https://b.com', content: contentB, score: 0.7 }),
      makeItem({ url: 'https://c.com', content: contentC, score: 0.9 }),
    ];
    const config: DDConfig = {
      similarityThreshold: 0.5,
      minParagraphChars: 20,
      extraTrackingParams: [],
    };
    const result = deduplicate(items, config);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
  });

  // [Implements: US-DD-008] Near-dup merge with multiple independent groups + singletons
  it('handles multiple near-dup groups alongside singletons', () => {
    const items = [
      // Group 1: two near-dup items (6/7 shared → Jaccard ≈ 0.857 ≥ 0.85)
      makeItem({ url: 'https://g1-a.com', content: CONTENT_ABCEF, score: 0.9 }),
      makeItem({ url: 'https://g1-b.com', content: CONTENT_ABCEFG, score: 0.5 }),
      // Group 2: two items with 4/5 = 0.8 < 0.85 → no merge at default threshold
      makeItem({ url: 'https://g2-a.com', content: [PARA_C, PARA_D, PARA_E, PARA_F].join('\n\n'), score: 0.8 }),
      makeItem({ url: 'https://g2-b.com', content: [PARA_C, PARA_D, PARA_E, PARA_F, PARA_G].join('\n\n'), score: 0.4 }),
      // Singleton
      makeItem({ url: 'https://singleton.com', content: PARA_A, score: 0.6 }),
    ];
    const result = deduplicate(items);
    // Group 1: 2 → 1 (near-dup merge, Jaccard ≈ 0.857 ≥ 0.85)
    // Group 2: 2 → 2 (no merge, Jaccard = 0.8 < 0.85)
    // Singleton: 1 → 1
    // Total: 1 + 2 + 1 = 4
    expect(result).toHaveLength(4);
    expect(result.some((r) => r.url === 'https://g1-a.com')).toBe(true);
    expect(result.some((r) => r.url === 'https://g2-a.com')).toBe(true);
    expect(result.some((r) => r.url === 'https://g2-b.com')).toBe(true);
    expect(result.some((r) => r.url === 'https://singleton.com')).toBe(true);
  });

  // [Implements: US-DD-008] Near-dup group merges all items into one with all URLs in mergedSources
  it('accumulates all dropped URLs in mergedSources for a large near-dup group', () => {
    // All items have identical fingerprints → all merge into one
    const items = [
      makeItem({ url: 'https://a.com', content: CONTENT_ABCEF, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: CONTENT_ABCEF, score: 0.3 }),
      makeItem({ url: 'https://c.com', content: CONTENT_ABCEF, score: 0.5 }),
      makeItem({ url: 'https://d.com', content: CONTENT_ABCEF, score: 0.7 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://a.com');
    expect(result[0].mergedSources).toContain('https://b.com');
    expect(result[0].mergedSources).toContain('https://c.com');
    expect(result[0].mergedSources).toContain('https://d.com');
    expect(result[0].mergedSources.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Content normalization behavior
// ---------------------------------------------------------------------------

describe('deduplicate — content normalization behavior', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-005, US-DD-007] Content differing only in case is treated as exact-content duplicate
  it('classifies content differing only in case as exact-content duplicate', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_A.toUpperCase(), score: 0.3 }),
    ];
    const result = deduplicate(items);
    // After normalization (lowercase), both produce identical fingerprints
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-005, US-DD-007] Content differing only in whitespace is treated as exact-content duplicate
  it('classifies content differing only in extra whitespace as exact-content duplicate', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: `   ${PARA_A}   `, score: 0.3 }),
    ];
    const result = deduplicate(items);
    // After normalization (trim + collapse whitespace), both produce identical fingerprints
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-007] Content with internal whitespace variation is treated as identical
  it('classifies content with internal whitespace differences as exact-content duplicate', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_A.replace(/ /g, '  '), score: 0.3 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-010] Original content is NOT normalized in the output
  it('does not normalize the content field in the output (preserves original)', () => {
    const rawContent = `   ${PARA_A}   `;
    const items = [makeItem({ url: 'https://a.com', content: rawContent, score: 0.9 })];
    const result = deduplicate(items);
    expect(result[0].content).toBe(rawContent);
  });
});

// ---------------------------------------------------------------------------
// URL normalization edge cases in pipeline
// ---------------------------------------------------------------------------

describe('deduplicate — URL normalization edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-002, US-DD-003] URLs that normalize to the same value are deduped
  it('deduplicates URLs with different schemes and ports that normalize identically', () => {
    const items = [
      makeItem({ url: 'http://example.com:80/article', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://example.com:443/article', score: 0.3, content: PARA_B }),
      makeItem({ url: 'https://example.com/article', score: 0.5, content: PARA_C }),
    ];
    const result = deduplicate(items);
    // All three normalize to https://example.com/article
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
  });

  // [Implements: US-DD-002, US-DD-003] Trailing slash normalization causes dedup
  it('deduplicates URLs differing only in trailing slash', () => {
    const items = [
      makeItem({ url: 'https://example.com/page/', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://example.com/page', score: 0.3, content: PARA_B }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-002, US-DD-003] Fragment removal causes dedup
  it('deduplicates URLs differing only in fragment', () => {
    const items = [
      makeItem({ url: 'https://example.com/page#section1', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://example.com/page#section2', score: 0.3, content: PARA_B }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-002, US-DD-003] Query param sorting causes dedup
  it('deduplicates URLs with same query params in different order', () => {
    const items = [
      makeItem({ url: 'https://example.com/page?a=1&b=2', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://example.com/page?b=2&a=1', score: 0.3, content: PARA_B }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-010] All tracking params stripped → root URL normalized correctly
  it('normalizes URLs with all tracking params stripped to clean form', () => {
    const items = [
      makeItem({
        url: 'http://EXAMPLE.COM:80/Page/?utm_source=a&utm_medium=b&utm_campaign=c&fbclid=d&gclid=e&ref=f#top',
        content: PARA_A,
        score: 0.9,
      }),
    ];
    const result = deduplicate(items);
    expect(result[0].normalizedUrl).toBe('https://example.com/Page');
  });
});

// ---------------------------------------------------------------------------
// Output ordering invariance
// ---------------------------------------------------------------------------

describe('deduplicate — output ordering invariance', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: BG-DD-002] Same items in different order produce the same result set
  it('produces the same result set regardless of input order', () => {
    const itemsA = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_B, score: 0.8 }),
      makeItem({ url: 'https://c.com', content: PARA_C, score: 0.7 }),
    ];
    const itemsB = [
      makeItem({ url: 'https://c.com', content: PARA_C, score: 0.7 }),
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_B, score: 0.8 }),
    ];

    const resultA = deduplicate(itemsA);
    const resultB = deduplicate(itemsB);

    // Same number of output items
    expect(resultA.length).toBe(resultB.length);
    // Same set of URLs (regardless of order)
    const urlsA = resultA.map((r) => r.url).sort();
    const urlsB = resultB.map((r) => r.url).sort();
    expect(urlsA).toEqual(urlsB);
  });

  // [Implements: BG-DD-002] URL dedup retains same item regardless of input order
  it('URL dedup retains the highest-scored item regardless of input order', () => {
    const itemsOrder1 = [
      makeItem({ url: 'https://a.com?utm_source=x', content: PARA_A, score: 0.3 }),
      makeItem({ url: 'https://a.com', content: PARA_B, score: 0.9 }),
    ];
    const itemsOrder2 = [
      makeItem({ url: 'https://a.com', content: PARA_B, score: 0.9 }),
      makeItem({ url: 'https://a.com?utm_source=x', content: PARA_A, score: 0.3 }),
    ];

    const result1 = deduplicate(itemsOrder1);
    const result2 = deduplicate(itemsOrder2);

    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
    // Both should retain the highest-scored item
    expect(result1[0].score).toBe(0.9);
    expect(result2[0].score).toBe(0.9);
  });

  // [Implements: BG-DD-002] mergedSources content is the same regardless of input order
  it('produces the same mergedSources set regardless of input order', () => {
    const itemsOrder1 = [
      makeItem({ url: 'https://a.com?utm_source=x', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.3 }),
      makeItem({ url: 'https://a.com?ref=nav', content: PARA_A, score: 0.5 }),
    ];
    const itemsOrder2 = [
      makeItem({ url: 'https://a.com?ref=nav', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://a.com?utm_source=x', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.3 }),
    ];

    const result1 = deduplicate(itemsOrder1);
    const result2 = deduplicate(itemsOrder2);

    expect(result1[0].score).toBe(result2[0].score);
    const sources1 = [...result1[0].mergedSources].sort();
    const sources2 = [...result2[0].mergedSources].sort();
    expect(sources1).toEqual(sources2);
  });
});

// ---------------------------------------------------------------------------
// Error resilience — edge cases
// ---------------------------------------------------------------------------

describe('deduplicate — error resilience edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-009, NFR-DD-007] Mixed empty content and malformed URLs
  it('handles mixed empty content and malformed URLs without throwing', () => {
    const items = [
      makeItem({ url: 'https://valid.com', content: '', score: 0.5 }),
      makeItem({ url: 'bad-url', content: PARA_A, score: 0.3 }),
      makeItem({ url: 'https://another.com', content: '   ', score: 0.7 }),
    ];
    const result = deduplicate(items);
    expect(result).toEqual([]);
  });

  // [Implements: US-DD-009, BG-DD-001] Counts errors and empties separately in summary
  it('counts empty and error removals separately in the summary', () => {
    const items = [
      makeItem({ url: 'https://empty.com', content: '', score: 0.5 }), // empty
      makeItem({ url: 'bad-url', content: PARA_A, score: 0.3 }), // error
      makeItem({ url: 'https://valid.com', content: PARA_B, score: 0.9 }), // valid
    ];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('empty=1')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('errors=1')
    );
  });

  // [Implements: US-DD-009] First item is malformed, subsequent valid items still process
  it('processes valid items even when the first item has a malformed URL', () => {
    const items = [
      makeItem({ url: 'bad-url', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://valid-a.com', content: PARA_B, score: 0.9 }),
      makeItem({ url: 'https://valid-b.com', content: PARA_C, score: 0.8 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(2);
    expect(result.some((r) => r.url === 'https://valid-a.com')).toBe(true);
    expect(result.some((r) => r.url === 'https://valid-b.com')).toBe(true);
  });

  // [Implements: US-DD-009] Last item is malformed, previous valid items still process
  it('processes valid items even when the last item has a malformed URL', () => {
    const items = [
      makeItem({ url: 'https://valid-a.com', content: PARA_B, score: 0.9 }),
      makeItem({ url: 'https://valid-b.com', content: PARA_C, score: 0.8 }),
      makeItem({ url: 'bad-url', content: PARA_A, score: 0.5 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(2);
    expect(result.some((r) => r.url === 'https://valid-a.com')).toBe(true);
    expect(result.some((r) => r.url === 'https://valid-b.com')).toBe(true);
  });

  // [Implements: US-DD-011] Content with only newlines is treated as empty
  it('removes items with newline-only content', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: '\n\n\n', score: 0.5 }),
      makeItem({ url: 'https://valid.com', content: PARA_A, score: 0.9 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://valid.com');
  });

  // [Implements: US-DD-011] Content with only tabs is treated as empty
  it('removes items with tab-only content', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: '\t\t\t', score: 0.5 }),
      makeItem({ url: 'https://valid.com', content: PARA_A, score: 0.9 }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://valid.com');
  });
});

// ---------------------------------------------------------------------------
// Large-scale integration test
// ---------------------------------------------------------------------------

describe('deduplicate — large-scale integration', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-003, US-DD-007, US-DD-008, US-DD-010, BG-DD-002]
  it('handles a comprehensive dataset with all dedup scenarios at once', () => {
    const items: ContentItem[] = [
      // --- URL duplicates ---
      makeItem({ url: 'https://news.com/article?utm_source=a', score: 0.9, content: PARA_A }),
      makeItem({ url: 'https://news.com/article', score: 0.3, content: PARA_B }),
      makeItem({ url: 'http://news.com/article/?ref=nav', score: 0.5, content: PARA_C }),

      // --- Exact-content duplicates ---
      makeItem({ url: 'https://mirror-1.com', score: 0.8, content: PARA_D }),
      makeItem({ url: 'https://mirror-2.com', score: 0.6, content: PARA_D }),
      makeItem({ url: 'https://mirror-3.com', score: 0.4, content: PARA_D }),

      // --- Near-duplicates ---
      makeItem({ url: 'https://blog-a.com', score: 0.7, content: CONTENT_ABCEF }),
      makeItem({ url: 'https://blog-b.com', score: 0.2, content: CONTENT_ABCEFG }),

      // --- Empty content ---
      makeItem({ url: 'https://empty.com', content: '', score: 0.1 }),

      // --- Malformed URL ---
      makeItem({ url: 'broken-url', content: PARA_E, score: 0.15 }),

      // --- Unique items ---
      makeItem({ url: 'https://unique-1.com', score: 0.65, content: PARA_E }),
      makeItem({ url: 'https://unique-2.com', score: 0.55, content: PARA_F }),
    ];

    const result = deduplicate(items);

    // Expected:
    // 3 URL dups → 1 (news.com/article?utm_source=a retained, score 0.9)
    // 3 content dups → 1 (mirror-1.com retained, score 0.8)
    // 2 near-dups → 1 (blog-a.com retained, score 0.7)
    // 1 empty removed
    // 1 error removed
    // 2 unique → 2
    // Total output: 1 + 1 + 1 + 2 = 5
    expect(result).toHaveLength(5);

    // Verify retained items
    expect(result.some((r) => r.score === 0.9)).toBe(true); // news.com
    expect(result.some((r) => r.score === 0.8)).toBe(true); // mirror-1
    expect(result.some((r) => r.score === 0.7)).toBe(true); // blog-a
    expect(result.some((r) => r.url === 'https://unique-1.com')).toBe(true);
    expect(result.some((r) => r.url === 'https://unique-2.com')).toBe(true);

    // Verify mergedSources
    const newsItem = result.find((r) => r.score === 0.9);
    expect(newsItem).toBeDefined();
    expect(newsItem!.mergedSources).toContain('https://news.com/article');
    expect(newsItem!.mergedSources).toContain('http://news.com/article/?ref=nav');

    const mirrorItem = result.find((r) => r.score === 0.8);
    expect(mirrorItem).toBeDefined();
    expect(mirrorItem!.mergedSources).toContain('https://mirror-2.com');
    expect(mirrorItem!.mergedSources).toContain('https://mirror-3.com');

    const blogItem = result.find((r) => r.score === 0.7);
    expect(blogItem).toBeDefined();
    expect(blogItem!.mergedSources).toContain('https://blog-b.com');

    // Unique items have empty mergedSources
    const unique1 = result.find((r) => r.url === 'https://unique-1.com');
    expect(unique1).toBeDefined();
    expect(unique1!.mergedSources).toEqual([]);
  });

  // [Implements: BG-DD-002] Large-scale dataset completes within latency target
  it('completes a 15-item comprehensive dataset in under 500ms', () => {
    const items: ContentItem[] = Array.from({ length: 15 }, (_, i) => {
      const paraSet = [PARA_A, PARA_B, PARA_C, PARA_D, PARA_E, PARA_F];
      return makeItem({
        url: `https://example-${i}.com/article?utm_source=${i}`,
        score: 0.5 + i * 0.03,
        content: paraSet[i % paraSet.length],
      });
    });
    // Add some URL dups
    items.push(makeItem({ url: 'https://example-0.com/article', content: PARA_A, score: 0.1 }));
    items.push(makeItem({ url: 'https://example-1.com/article', content: PARA_B, score: 0.1 }));

    const start = Date.now();
    deduplicate(items);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  // [Implements: US-DD-009] Summary correctly reports all counts for a large dataset
  it('logs correct counts for a large-scale dataset', () => {
    const items: ContentItem[] = [
      // 2 URL dups
      makeItem({ url: 'https://a.com?utm_source=x', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://a.com', content: PARA_B, score: 0.3 }),
      // 2 content dups
      makeItem({ url: 'https://c.com', content: PARA_C, score: 0.8 }),
      makeItem({ url: 'https://d.com', content: PARA_C, score: 0.2 }),
      // 1 empty
      makeItem({ url: 'https://e.com', content: '', score: 0.5 }),
      // 1 error
      makeItem({ url: 'bad', content: PARA_D, score: 0.1 }),
      // 2 unique
      makeItem({ url: 'https://f.com', content: PARA_D, score: 0.7 }),
      makeItem({ url: 'https://g.com', content: PARA_E, score: 0.6 }),
    ];
    deduplicate(items);
    // 8 input, 1 URL dup, 1 content dup, 1 empty, 1 error → 4 output
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('input=8'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('exact-url-dups=1'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('exact-content-dups=1'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('empty=1'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('errors=1'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('output=4'));
  });
});

// ---------------------------------------------------------------------------
// DeduplicatedItem interface completeness
// ---------------------------------------------------------------------------

describe('deduplicate — DeduplicatedItem interface completeness', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-010] All inherited ContentItem fields are present and correct
  it('preserves title, url, snippet, score, content from input items', () => {
    const items = [
      makeItem({
        title: 'Unique Article Title',
        url: 'https://example.com/page',
        snippet: 'This is the snippet text from the search result.',
        score: 0.42,
        content: PARA_A,
      }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Unique Article Title');
    expect(result[0].url).toBe('https://example.com/page');
    expect(result[0].snippet).toBe('This is the snippet text from the search result.');
    expect(result[0].score).toBe(0.42);
    expect(result[0].content).toBe(PARA_A);
  });

  // [Implements: US-DD-010] Retained item after dedup preserves original title and snippet
  it('preserves title and snippet of the retained item after dedup', () => {
    const items = [
      makeItem({ title: 'Winner', url: 'https://a.com', snippet: 'Best snippet.', score: 0.9, content: PARA_A }),
      makeItem({ title: 'Loser', url: 'https://b.com', snippet: 'Worse snippet.', score: 0.3, content: PARA_A }),
    ];
    const result = deduplicate(items);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Winner');
    expect(result[0].snippet).toBe('Best snippet.');
  });

  // [Implements: US-DD-010] All three extra fields are always present
  it('always includes normalizedUrl, mergedSources, and fingerprintCount fields', () => {
    const items = [makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 })];
    const result = deduplicate(items);
    expect(result[0]).toHaveProperty('normalizedUrl');
    expect(result[0]).toHaveProperty('mergedSources');
    expect(result[0]).toHaveProperty('fingerprintCount');
    expect(typeof result[0].normalizedUrl).toBe('string');
    expect(Array.isArray(result[0].mergedSources)).toBe(true);
    expect(typeof result[0].fingerprintCount).toBe('number');
  });

  // [Implements: US-DD-010] DeduplicatedItem satisfies ContentItem interface
  it('output items satisfy all ContentItem fields', () => {
    const items = [makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 })];
    const result = deduplicate(items);
    const item: ContentItem = result[0];
    expect(item.title).toBeDefined();
    expect(item.url).toBeDefined();
    expect(item.snippet).toBeDefined();
    expect(item.score).toBeDefined();
    expect(item.content).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// No-state-leakage between calls
// ---------------------------------------------------------------------------

describe('deduplicate — no state leakage between calls', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: DC-DD-003, NFR-DD-001] mergedSources from a previous call do not leak
  it('does not leak mergedSources from a previous call into the next', () => {
    // First call: items that produce mergedSources
    const items1 = [
      makeItem({ url: 'https://a.com?utm_source=x', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.3 }),
    ];
    const result1 = deduplicate(items1);
    expect(result1[0].mergedSources).toHaveLength(1);

    // Second call: items that should NOT have any mergedSources
    const items2 = [
      makeItem({ url: 'https://x.com', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'https://y.com', content: PARA_B, score: 0.3 }),
    ];
    const result2 = deduplicate(items2);
    expect(result2).toHaveLength(2);
    expect(result2[0].mergedSources).toEqual([]);
    expect(result2[1].mergedSources).toEqual([]);
  });

  // [Implements: DC-DD-003] Sequential calls with different inputs are independent
  it('processes independent datasets correctly in sequential calls', () => {
    const set1 = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_B, score: 0.3 }),
    ];
    const set2 = [
      makeItem({ url: 'https://c.com', content: PARA_C, score: 0.8 }),
      makeItem({ url: 'https://c.com?utm_source=x', content: PARA_D, score: 0.2 }),
    ];

    const result1 = deduplicate(set1);
    const result2 = deduplicate(set2);

    expect(result1).toHaveLength(2); // no dedup in set1
    expect(result2).toHaveLength(1); // URL dedup in set2

    // set2 result has correct mergedSources from its own dedup
    expect(result2[0].mergedSources).toContain('https://c.com?utm_source=x');
    expect(result2[0].mergedSources.length).toBe(1);
  });

  // [Implements: NFR-DD-001] Repeated identical calls don't accumulate state
  it('does not accumulate mergedSources across repeated identical calls', () => {
    const items = [
      makeItem({ url: 'https://a.com?utm_source=x', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.3 }),
    ];
    for (let i = 0; i < 10; i++) {
      const result = deduplicate(items);
      expect(result).toHaveLength(1);
      expect(result[0].mergedSources).toHaveLength(1);
      expect(result[0].mergedSources).toContain('https://a.com');
    }
  });
});

// ---------------------------------------------------------------------------
// Config edge cases
// ---------------------------------------------------------------------------

describe('deduplicate — config edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-010] Empty extraTrackingParams array works correctly
  it('works correctly with empty extraTrackingParams array', () => {
    const items = [
      makeItem({ url: 'https://a.com/page?q=1', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com/page?q=2', content: PARA_B, score: 0.3 }),
    ];
    const config: DDConfig = {
      similarityThreshold: 0.85,
      minParagraphChars: 20,
      extraTrackingParams: [],
    };
    const result = deduplicate(items, config);
    expect(result).toHaveLength(2);
  });

  // [Implements: US-DD-010] Multiple extraTrackingParams all stripped
  it('strips multiple custom tracking params via extraTrackingParams', () => {
    const items = [
      makeItem({ url: 'https://a.com/page?track1=1&track2=2&keep=1', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://a.com/page?keep=1', content: PARA_B, score: 0.3 }),
    ];
    const config: DDConfig = {
      similarityThreshold: 0.85,
      minParagraphChars: 20,
      extraTrackingParams: ['track1', 'track2'],
    };
    const result = deduplicate(items, config);
    // Both URLs normalize to https://a.com/page?keep=1 → URL dedup → 1 item
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-010] minParagraphChars=1 fingerprints everything
  it('fingerprints all paragraphs when minParagraphChars is 1', () => {
    const content = 'A\n\nB\n\nC'; // All 1-char paragraphs
    const items = [makeItem({ url: 'https://a.com', content, score: 0.9 })];
    const config: DDConfig = {
      similarityThreshold: 0.85,
      minParagraphChars: 1,
      extraTrackingParams: [],
    };
    const result = deduplicate(items, config);
    expect(result[0].fingerprintCount).toBe(3);
  });

  // [Implements: US-DD-010] Very high minParagraphChars filters everything
  it('returns fingerprintCount=0 when minParagraphChars is very high', () => {
    const items = [makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 })];
    const config: DDConfig = {
      similarityThreshold: 0.85,
      minParagraphChars: 10000,
      extraTrackingParams: [],
    };
    const result = deduplicate(items, config);
    expect(result[0].fingerprintCount).toBe(0);
  });

  // [Implements: US-DD-008] Custom threshold 0.0 merges items with no shared fingerprints
  it('merges items with no shared fingerprints at threshold 0.0', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: PARA_A, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: PARA_B, score: 0.5 }),
    ];
    const config: DDConfig = {
      similarityThreshold: 0.0,
      minParagraphChars: 20,
      extraTrackingParams: [],
    };
    const result = deduplicate(items, config);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Content with HTML tags
// ---------------------------------------------------------------------------

describe('deduplicate — content with HTML tags', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-004, US-DD-007] Content with HTML paragraph boundaries is segmented correctly
  it('segments content with HTML </p> tags as paragraph boundaries', () => {
    const content = '<p>This is a long enough paragraph to pass.</p>\n\n<p>Second paragraph also long enough.</p>';
    const items = [makeItem({ url: 'https://a.com', content, score: 0.9 })];
    const result = deduplicate(items);
    // Two paragraphs after </p> boundary splitting
    expect(result[0].fingerprintCount).toBeGreaterThanOrEqual(1);
  });

  // [Implements: US-DD-004, US-DD-007] Content with <br> tags is handled
  it('handles content with <br> tags combined with newlines', () => {
    const content = 'First paragraph is long enough.<br>\n\nSecond paragraph is also long.';
    const items = [makeItem({ url: 'https://a.com', content, score: 0.9 })];
    const result = deduplicate(items);
    // <br> followed by \n\n creates a paragraph boundary
    expect(result[0].fingerprintCount).toBe(2);
  });

  // [Implements: US-DD-005, US-DD-007] Content with different paragraph separation produces similar fingerprints
  it('classifies content with different separators as exact-content duplicate', () => {
    const plain = 'First paragraph is long enough.\n\nSecond paragraph is also long.';
    const doubleNewline = 'First paragraph is long enough.\n\n\nSecond paragraph is also long.';
    const items = [
      makeItem({ url: 'https://a.com', content: plain, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: doubleNewline, score: 0.3 }),
    ];
    const result = deduplicate(items);
    // Both produce the same fingerprints after paragraph segmentation
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Stats summary edge cases
// ---------------------------------------------------------------------------

describe('deduplicate — stats summary edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-009] Summary includes elapsedMs with a numeric value
  it('logs elapsedMs as a non-negative integer-like value', () => {
    deduplicate([makeItem({ url: 'https://a.com', content: PARA_A, score: 0.5 })]);
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const summaryCall = calls.find((c) => c.includes('[DD] summary'));
    expect(summaryCall).toBeDefined();
    const match = summaryCall!.match(/elapsedMs=(\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1], 10)).toBeGreaterThanOrEqual(0);
  });

  // [Implements: US-DD-009] Summary is always a single line
  it('logs exactly one summary line per call', () => {
    deduplicate([makeItem({ url: 'https://a.com', content: PARA_A, score: 0.5 })]);
    const summaryCalls = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('[DD] summary'));
    expect(summaryCalls).toHaveLength(1);
  });

  // [Implements: US-DD-009] Summary is logged even when all items have empty content
  it('logs summary with all-zero dedup counts when all items have empty content', () => {
    deduplicate([
      makeItem({ url: 'https://a.com', content: '', score: 0.5 }),
      makeItem({ url: 'https://b.com', content: '  ', score: 0.3 }),
    ]);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('input=2'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('empty=2'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('output=0'));
  });

  // [Implements: US-DD-009] Summary is logged even when all items have malformed URLs
  it('logs summary with error counts when all items have malformed URLs', () => {
    deduplicate([
      makeItem({ url: 'bad-1', content: PARA_A, score: 0.5 }),
      makeItem({ url: 'bad-2', content: PARA_B, score: 0.3 }),
    ]);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('input=2'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('errors=2'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('output=0'));
  });

  // [Implements: US-DD-009, BG-DD-001] near-dups count appears in summary
  it('logs near-dups count in summary when near-dups are removed', () => {
    const items = [
      makeItem({ url: 'https://a.com', content: CONTENT_ABCEF, score: 0.9 }),
      makeItem({ url: 'https://b.com', content: CONTENT_ABCEFG, score: 0.3 }),
    ];
    deduplicate(items);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('near-dups=1'));
  });
});

// ---------------------------------------------------------------------------
// Whitespace and encoding edge cases in content
// ---------------------------------------------------------------------------

describe('deduplicate — whitespace and encoding edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-DD-004] Content with Windows-style \r\n line endings is handled
  it('handles Windows-style line endings in multi-paragraph content', () => {
    const content = 'First paragraph is long enough.\r\n\r\nSecond paragraph is also long.';
    const items = [makeItem({ url: 'https://a.com', content, score: 0.9 })];
    const result = deduplicate(items);
    expect(result[0].fingerprintCount).toBe(2);
  });

  // [Implements: US-DD-004] Content with old Mac-style \r line endings is handled
  it('handles old Mac-style line endings in multi-paragraph content', () => {
    const content = 'First paragraph is long enough.\r\rSecond paragraph is also long.';
    const items = [makeItem({ url: 'https://a.com', content, score: 0.9 })];
    const result = deduplicate(items);
    expect(result[0].fingerprintCount).toBe(2);
  });

  // [Implements: US-DD-004] Content with CJK characters is fingerprinted correctly
  it('handles CJK character content', () => {
    const content = '这是第一段足够长的中文段落内容需要超过二十个字符才行。';
    const items = [makeItem({ url: 'https://a.com', content, score: 0.9 })];
    const result = deduplicate(items);
    expect(result[0].fingerprintCount).toBe(1);
  });

  // [Implements: US-DD-004] Content with mixed line endings
  it('handles mixed line ending styles within the same content', () => {
    const content = 'First paragraph is long enough.\r\n\r\nSecond paragraph is also long.\n\nThird paragraph too.';
    const items = [makeItem({ url: 'https://a.com', content, score: 0.9 })];
    const result = deduplicate(items);
    expect(result[0].fingerprintCount).toBe(3);
  });
});
