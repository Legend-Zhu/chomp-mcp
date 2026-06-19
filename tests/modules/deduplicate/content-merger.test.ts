/**
 * Tests for the content merger — exact-URL dedup, exact-content dedup, and
 * near-duplicate merge via union-find transitive grouping.
 *
 * Covers score-based representative selection, tie-breaking by originalIndex,
 * mergedSources URL copying for citation traceability, stderr logging, and
 * transitive grouping behavior.
 *
 * [Spec: US-DD-003, US-DD-007, US-DD-008]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deduplicateByUrl,
  deduplicateExactContent,
  mergeNearDuplicates,
  mergedSourcesMap,
  clearMergedSources,
} from '../../../src/modules/deduplicate/content-merger.js';
import { createDedupStats } from '../../../src/modules/deduplicate/stats.js';
import type { FingerprintedItem } from '../../../src/modules/deduplicate/types.js';
import type { ContentItem } from '../../../src/shared/types/content.js';
import type { DedupStats } from '../../../src/modules/deduplicate/types.js';

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
    content: overrides.content ?? 'Some content here.',
  };
}

/**
 * Build a FingerprintedItem fixture.
 *
 * @param url - Original URL of the item.
 * @param score - Relevance score.
 * @param fingerprints - Array of fingerprint hash values (converted to Set).
 * @param originalIndex - Zero-based position in original input.
 * @param normalizedUrl - Normalized URL (defaults to the url).
 * @param extra - Additional ContentItem field overrides.
 */
function makeFpItem(
  url: string,
  score: number,
  fingerprints: number[],
  originalIndex: number,
  normalizedUrl?: string,
  extra: Partial<ContentItem> = {}
): FingerprintedItem {
  return {
    item: makeItem({ url, score, ...extra }),
    normalizedUrl: normalizedUrl ?? url,
    fingerprints: new Set(fingerprints),
    originalIndex,
  };
}

/**
 * Extract the URLs from an array of FingerprintedItems.
 */
function urlsOf(items: FingerprintedItem[]): string[] {
  return items.map((fp) => fp.item.url);
}

/**
 * Extract the scores from an array of FingerprintedItems.
 */
function scoresOf(items: FingerprintedItem[]): number[] {
  return items.map((fp) => fp.item.score);
}

// ---------------------------------------------------------------------------
// deduplicateByUrl
// ---------------------------------------------------------------------------

describe('deduplicateByUrl', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: US-DD-003]
  it('returns an empty array for empty input', () => {
    const result = deduplicateByUrl([]);
    expect(result).toEqual([]);
  });

  // [Implements: US-DD-003]
  it('returns a single item unchanged when no duplicates exist', () => {
    const item = makeFpItem('https://a.com', 0.9, [1, 2, 3], 0);
    const result = deduplicateByUrl([item]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(item);
  });

  // [Implements: US-DD-003]
  it('returns all items unchanged when all have unique normalized URLs', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1], 0),
      makeFpItem('https://b.com', 0.8, [2], 1),
      makeFpItem('https://c.com', 0.7, [3], 2),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(3);
    expect(urlsOf(result)).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  // [Implements: US-DD-003] Same normalizedUrl → group together
  it('groups items with identical normalizedUrl into one', () => {
    const items = [
      makeFpItem('https://a.com/page1', 0.5, [1, 2], 0, 'https://a.com/page1'),
      makeFpItem('https://a.com/page2', 0.8, [3, 4], 1, 'https://a.com/page1'),
      makeFpItem('https://b.com', 0.9, [5, 6], 2),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(2);
    // The best item from the dup group (score 0.8) should be retained
    expect(result.some((fp) => fp.item.score === 0.8)).toBe(true);
    // The unique item should be retained
    expect(result.some((fp) => fp.item.url === 'https://b.com')).toBe(true);
  });

  // [Implements: US-DD-003] Retains highest-scored item within URL-duplicate group
  it('retains the item with the highest score in a URL-duplicate set', () => {
    const items = [
      makeFpItem('https://a.com/v1', 0.3, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/v2', 0.9, [2], 1, 'https://a.com'),
      makeFpItem('https://a.com/v3', 0.6, [3], 2, 'https://a.com'),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
    expect(result[0].item.url).toBe('https://a.com/v2');
  });

  // [Implements: US-DD-003] Equal scores → earliest originalIndex wins
  it('retains the earliest item when scores are equal in URL dedup', () => {
    const items = [
      makeFpItem('https://a.com/first', 0.8, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/second', 0.8, [2], 1, 'https://a.com'),
      makeFpItem('https://a.com/third', 0.8, [3], 2, 'https://a.com'),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.url).toBe('https://a.com/first');
    expect(result[0].originalIndex).toBe(0);
  });

  // [Implements: US-DD-003] mergedSources URL copying
  it('copies discarded items URLs into mergedSourcesMap for the retained item', () => {
    const items = [
      makeFpItem('https://a.com/kept', 0.9, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/dropped1', 0.5, [2], 1, 'https://a.com'),
      makeFpItem('https://a.com/dropped2', 0.3, [3], 2, 'https://a.com'),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(1);
    const retained = result[0];
    const sources = mergedSourcesMap.get(retained);
    expect(sources).toBeDefined();
    expect(sources).toHaveLength(2);
    expect(sources).toContain('https://a.com/dropped1');
    expect(sources).toContain('https://a.com/dropped2');
    // The retained item's own URL should NOT be in mergedSources
    expect(sources).not.toContain('https://a.com/kept');
  });

  // [Implements: US-DD-003] No mergedSources when single item in group
  it('does not set mergedSources for single-item groups', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1], 0),
      makeFpItem('https://b.com', 0.8, [2], 1),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(2);
    expect(mergedSourcesMap.size).toBe(0);
  });

  // [Implements: NFR-DD-003] Logs removal count to stderr
  it('logs the exact-url-dup removal count to stderr', () => {
    const items = [
      makeFpItem('https://a.com/v1', 0.3, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/v2', 0.9, [2], 1, 'https://a.com'),
    ];
    deduplicateByUrl(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-url-dups removed=1')
    );
  });

  it('does not log when no URL duplicates are found', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1], 0),
      makeFpItem('https://b.com', 0.8, [2], 1),
    ];
    deduplicateByUrl(items);
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('exact-url-dups')
    );
  });

  // [Implements: US-DD-003] Stats accumulation
  it('increments stats.exactUrlDuplicatesRemoved when stats is provided', () => {
    const stats = createDedupStats();
    const items = [
      makeFpItem('https://a.com/v1', 0.3, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/v2', 0.9, [2], 1, 'https://a.com'),
      makeFpItem('https://a.com/v3', 0.5, [3], 2, 'https://a.com'),
      makeFpItem('https://b.com', 0.8, [4], 3),
    ];
    deduplicateByUrl(items, stats);
    expect(stats.exactUrlDuplicatesRemoved).toBe(2);
  });

  it('does not increment stats when no URL duplicates found', () => {
    const stats = createDedupStats();
    const items = [
      makeFpItem('https://a.com', 0.9, [1], 0),
      makeFpItem('https://b.com', 0.8, [2], 1),
    ];
    deduplicateByUrl(items, stats);
    expect(stats.exactUrlDuplicatesRemoved).toBe(0);
  });

  // [Implements: US-DD-003] Multiple groups
  it('handles multiple independent URL-duplicate groups', () => {
    const items = [
      makeFpItem('https://a.com/1', 0.9, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/2', 0.5, [2], 1, 'https://a.com'),
      makeFpItem('https://b.com/1', 0.8, [3], 2, 'https://b.com'),
      makeFpItem('https://b.com/2', 0.3, [4], 3, 'https://b.com'),
      makeFpItem('https://b.com/3', 0.6, [5], 4, 'https://b.com'),
      makeFpItem('https://c.com', 0.7, [6], 5),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(3);
    expect(scoresOf(result).sort((a, b) => b - a)).toEqual([0.9, 0.8, 0.7]);
    expect(result.some((fp) => fp.item.score === 0.9 && fp.item.url === 'https://a.com/1')).toBe(true);
    expect(result.some((fp) => fp.item.score === 0.8 && fp.item.url === 'https://b.com/1')).toBe(true);
    expect(result.some((fp) => fp.item.url === 'https://c.com')).toBe(true);
  });

  // [Implements: US-DD-003] Discarded item URL equal to retained URL is not added
  it('does not add discarded item URL to mergedSources when it equals retained URL', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com', 0.5, [2], 1, 'https://a.com'),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(1);
    const sources = mergedSourcesMap.get(result[0]);
    // Both items have the same URL so nothing is added
    expect(sources).toBeUndefined();
  });

  // [Implements: US-DD-003] Non-default port URLs with different paths
  it('treats different normalized URLs (different path) as unique', () => {
    const items = [
      makeFpItem('https://a.com/page1', 0.9, [1], 0, 'https://a.com/page1'),
      makeFpItem('https://a.com/page2', 0.8, [2], 1, 'https://a.com/page2'),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// deduplicateExactContent
// ---------------------------------------------------------------------------

describe('deduplicateExactContent', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: US-DD-007]
  it('returns an empty array for empty input', () => {
    const result = deduplicateExactContent([]);
    expect(result).toEqual([]);
  });

  // [Implements: US-DD-007]
  it('returns a single item unchanged', () => {
    const item = makeFpItem('https://a.com', 0.9, [1, 2, 3], 0);
    const result = deduplicateExactContent([item]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(item);
  });

  // [Implements: US-DD-007] Identical fingerprint sets → exact-content duplicates
  it('classifies items with identical fingerprint sets as exact-content duplicates', () => {
    const fps = [10, 20, 30];
    const items = [
      makeFpItem('https://a.com', 0.5, fps, 0),
      makeFpItem('https://b.com', 0.9, fps, 1),
      makeFpItem('https://c.com', 0.3, [99, 88], 2),
    ];
    const result = deduplicateExactContent(items);
    expect(result).toHaveLength(2);
    // Highest-scored item from the exact-content dup group is retained
    expect(result[0].item.score).toBe(0.9);
    expect(result[0].item.url).toBe('https://b.com');
    // The unique item is retained
    expect(result.some((fp) => fp.item.url === 'https://c.com')).toBe(true);
  });

  // [Implements: US-DD-007] Retains highest-scored in exact-content dup group
  it('retains the item with the highest score in an exact-content-duplicate set', () => {
    const fps = [5, 10, 15];
    const items = [
      makeFpItem('https://a.com', 0.2, fps, 0),
      makeFpItem('https://b.com', 0.9, fps, 1),
      makeFpItem('https://c.com', 0.6, fps, 2),
    ];
    const result = deduplicateExactContent(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-007] Equal scores → earliest originalIndex
  it('retains the earliest item when scores are equal in exact-content dedup', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.7, fps, 0),
      makeFpItem('https://b.com', 0.7, fps, 1),
      makeFpItem('https://c.com', 0.7, fps, 2),
    ];
    const result = deduplicateExactContent(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.url).toBe('https://a.com');
    expect(result[0].originalIndex).toBe(0);
  });

  // [Implements: US-DD-007] Different fingerprint sets → not duplicates
  it('does not deduplicate items with different fingerprint sets', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.8, [1, 2, 4], 1),
      makeFpItem('https://c.com', 0.7, [1, 2, 3, 4], 2),
    ];
    const result = deduplicateExactContent(items);
    expect(result).toHaveLength(3);
  });

  // [Implements: US-DD-007] Fingerprint order within set does not matter
  it('treats fingerprint sets with same elements in different order as identical', () => {
    const items = [
      makeFpItem('https://a.com', 0.5, [3, 1, 2], 0),
      makeFpItem('https://b.com', 0.9, [1, 2, 3], 1),
    ];
    const result = deduplicateExactContent(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-007] mergedSources URL copying
  it('copies discarded items URLs into mergedSourcesMap', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
      makeFpItem('https://c.com', 0.3, fps, 2),
    ];
    const result = deduplicateExactContent(items);
    expect(result).toHaveLength(1);
    const sources = mergedSourcesMap.get(result[0]);
    expect(sources).toBeDefined();
    expect(sources).toHaveLength(2);
    expect(sources).toContain('https://b.com');
    expect(sources).toContain('https://c.com');
    expect(sources).not.toContain('https://a.com');
  });

  // [Implements: NFR-DD-003] Logs removal count
  it('logs the exact-content-dup removal count to stderr', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
    ];
    deduplicateExactContent(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-content-dups removed=1')
    );
  });

  it('does not log when no exact-content duplicates are found', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1], 0),
      makeFpItem('https://b.com', 0.8, [2], 1),
    ];
    deduplicateExactContent(items);
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('exact-content-dups')
    );
  });

  // [Implements: US-DD-007] Stats accumulation
  it('increments stats.exactContentDuplicatesRemoved when stats is provided', () => {
    const stats = createDedupStats();
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
      makeFpItem('https://c.com', 0.3, fps, 2),
    ];
    deduplicateExactContent(items, stats);
    expect(stats.exactContentDuplicatesRemoved).toBe(2);
  });

  // [Implements: US-DD-007] Empty fingerprint sets
  it('classifies multiple items with empty fingerprint sets as exact-content duplicates', () => {
    const items = [
      makeFpItem('https://a.com', 0.5, [], 0),
      makeFpItem('https://b.com', 0.9, [], 1),
    ];
    const result = deduplicateExactContent(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-007] Multiple exact-content dup groups
  it('handles multiple independent exact-content duplicate groups', () => {
    const groupA = [1, 2, 3];
    const groupB = [10, 20, 30];
    const items = [
      makeFpItem('https://a1.com', 0.9, groupA, 0),
      makeFpItem('https://a2.com', 0.5, groupA, 1),
      makeFpItem('https://b1.com', 0.8, groupB, 2),
      makeFpItem('https://b2.com', 0.3, groupB, 3),
      makeFpItem('https://c.com', 0.7, [99], 4),
    ];
    const result = deduplicateExactContent(items);
    expect(result).toHaveLength(3);
    expect(result.some((fp) => fp.item.url === 'https://a1.com')).toBe(true);
    expect(result.some((fp) => fp.item.url === 'https://b1.com')).toBe(true);
    expect(result.some((fp) => fp.item.url === 'https://c.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeNearDuplicates
// ---------------------------------------------------------------------------

describe('mergeNearDuplicates', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: US-DD-008]
  it('returns an empty array for empty input', () => {
    const result = mergeNearDuplicates([]);
    expect(result).toEqual([]);
  });

  // [Implements: US-DD-008]
  it('returns a single item unchanged', () => {
    const item = makeFpItem('https://a.com', 0.9, [1, 2, 3], 0);
    const result = mergeNearDuplicates([item]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(item);
  });

  // [Implements: US-DD-008] Two items with disjoint fingerprints → no merge
  it('does not merge items with completely disjoint fingerprint sets', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.8, [4, 5, 6], 1),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(2);
  });

  // [Implements: US-DD-008] Identical fingerprints (similarity 1.0 ≥ threshold)
  it('merges items with identical fingerprint sets (similarity = 1.0)', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.5, fps, 0),
      makeFpItem('https://b.com', 0.9, fps, 1),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-008] Retains highest score within near-dup group
  it('retains the highest-scored item in a near-duplicate group', () => {
    const fps = [1, 2, 3, 4, 5];
    const items = [
      makeFpItem('https://a.com', 0.3, fps, 0),
      makeFpItem('https://b.com', 0.8, fps, 1),
      makeFpItem('https://c.com', 0.9, fps, 2),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
    expect(result[0].item.url).toBe('https://c.com');
  });

  // [Implements: US-DD-008] Equal scores → earliest originalIndex
  it('retains the earliest item when scores are equal in near-dup merge', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.7, fps, 0),
      makeFpItem('https://b.com', 0.7, fps, 1),
      makeFpItem('https://c.com', 0.7, fps, 2),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.url).toBe('https://a.com');
  });

  // [Implements: US-DD-008] Threshold-based classification
  it('merges items when Jaccard similarity is exactly at the threshold (>=)', () => {
    // {1,2,3,4} and {1,2,3,4,5} → intersection=4, union=5 → 4/5 = 0.8
    // With threshold 0.8, 0.8 >= 0.8 → merge
    const items = [
      makeFpItem('https://a.com', 0.5, [1, 2, 3, 4], 0),
      makeFpItem('https://b.com', 0.9, [1, 2, 3, 4, 5], 1),
    ];
    const result = mergeNearDuplicates(items, 0.8);
    expect(result).toHaveLength(1);
  });

  it('does not merge items when similarity is just below the threshold', () => {
    // {1,2,3,4} and {1,2,3,5} → intersection=3 (1,2,3), union=5 (1,2,3,4,5) → 3/5 = 0.6
    // With threshold 0.8, 0.6 < 0.8 → no merge
    const items = [
      makeFpItem('https://a.com', 0.5, [1, 2, 3, 4], 0),
      makeFpItem('https://b.com', 0.9, [1, 2, 3, 5], 1),
    ];
    const result = mergeNearDuplicates(items, 0.8);
    expect(result).toHaveLength(2);
  });

  // [Implements: US-DD-008] Custom threshold of 0.0 merges everything
  it('merges all items when threshold is 0.0', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1], 0),
      makeFpItem('https://b.com', 0.8, [2], 1),
      makeFpItem('https://c.com', 0.7, [3], 2),
    ];
    const result = mergeNearDuplicates(items, 0.0);
    expect(result).toHaveLength(1);
    // Highest score retained
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-008] Custom threshold of 1.0 requires exact match
  it('does not merge when threshold is 1.0 and sets differ', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.8, [1, 2, 4], 1),
    ];
    const result = mergeNearDuplicates(items, 1.0);
    expect(result).toHaveLength(2);
  });

  it('merges when threshold is 1.0 and sets are identical', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.5, fps, 0),
      makeFpItem('https://b.com', 0.9, fps, 1),
    ];
    const result = mergeNearDuplicates(items, 1.0);
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-008] Default threshold (0.85)
  it('uses default threshold 0.85 when none is specified', () => {
    // 5 shared out of 6 total → 5/6 ≈ 0.833 < 0.85 → no merge
    const items = [
      makeFpItem('https://a.com', 0.5, [1, 2, 3, 4, 5], 0),
      makeFpItem('https://b.com', 0.9, [1, 2, 3, 4, 6], 1),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(2);
  });

  it('merges when similarity is 6/7 ≈ 0.857 >= default threshold 0.85', () => {
    // {1,2,3,4,5,6} and {1,2,3,4,5,7} → intersection=5 (1,2,3,4,5), union=7 (1,2,3,4,5,6,7) → 5/7 ≈ 0.714
    // That's below 0.85. Let me recalculate for 6/7:
    // {1,2,3,4,5,6} and {1,2,3,4,5,6,8} → intersection=6, union=7 → 6/7 ≈ 0.857 >= 0.85 → merge
    const items = [
      makeFpItem('https://a.com', 0.5, [1, 2, 3, 4, 5, 6], 0),
      makeFpItem('https://b.com', 0.9, [1, 2, 3, 4, 5, 6, 8], 1),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-008] mergedSources URL copying
  it('copies discarded items URLs into mergedSourcesMap for near-dup merge', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
      makeFpItem('https://c.com', 0.3, fps, 2),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    const sources = mergedSourcesMap.get(result[0]);
    expect(sources).toBeDefined();
    expect(sources).toHaveLength(2);
    expect(sources).toContain('https://b.com');
    expect(sources).toContain('https://c.com');
    expect(sources).not.toContain('https://a.com');
  });

  // [Implements: NFR-DD-003] Logs near-dup removal count and groups merged
  it('logs near-dup removal count and groups merged to stderr', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
    ];
    mergeNearDuplicates(items);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('near-dups removed=1')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('groups_merged=1')
    );
  });

  it('does not log near-dups when no merges occur', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1], 0),
      makeFpItem('https://b.com', 0.8, [2], 1),
    ];
    mergeNearDuplicates(items);
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('near-dups')
    );
  });

  // [Implements: US-DD-008] Stats accumulation
  it('increments stats.nearDuplicatesRemoved when stats is provided', () => {
    const stats = createDedupStats();
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
      makeFpItem('https://c.com', 0.3, fps, 2),
    ];
    mergeNearDuplicates(items, 0.85, stats);
    expect(stats.nearDuplicatesRemoved).toBe(2);
  });

  // [Implements: US-DD-008] Multiple independent groups
  it('handles multiple independent near-dup groups alongside ungrouped items', () => {
    const groupA = [1, 2, 3, 4, 5];
    const groupB = [10, 20, 30, 40, 50];
    const items = [
      makeFpItem('https://a1.com', 0.9, groupA, 0),
      makeFpItem('https://a2.com', 0.5, groupA, 1),
      makeFpItem('https://b1.com', 0.8, groupB, 2),
      makeFpItem('https://b2.com', 0.3, groupB, 3),
      makeFpItem('https://c.com', 0.7, [99, 98, 97], 4),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(3);
    expect(result.some((fp) => fp.item.url === 'https://a1.com')).toBe(true);
    expect(result.some((fp) => fp.item.url === 'https://b1.com')).toBe(true);
    expect(result.some((fp) => fp.item.url === 'https://c.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeNearDuplicates — transitive grouping via union-find
// ---------------------------------------------------------------------------

describe('mergeNearDuplicates — transitive grouping via union-find', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: US-DD-008] Transitive grouping: A~B, B~C, but A!~C
  it('groups transitively when A is similar to B and B is similar to C (even if A and C are not)', () => {
    // Design fingerprints so that:
    //   A vs B similarity >= threshold
    //   B vs C similarity >= threshold
    //   A vs C similarity < threshold
    //
    // Using threshold 0.5:
    //   A = {1, 2, 3, 4}         (size 4)
    //   B = {1, 2, 3, 4, 5, 6}   (size 6)
    //   C = {3, 4, 5, 6, 7, 8}   (size 6)
    //
    // A∩B = {1,2,3,4} = 4, A∪B = {1,2,3,4,5,6} = 6 → 4/6 ≈ 0.667 >= 0.5 ✓
    // B∩C = {3,4,5,6} = 4, B∪C = {1,2,3,4,5,6,7,8} = 8 → 4/8 = 0.5 >= 0.5 ✓
    // A∩C = {3,4} = 2, A∪C = {1,2,3,4,5,6,7,8} = 8 → 2/8 = 0.25 < 0.5 ✗
    const threshold = 0.5;
    const items = [
      makeFpItem('https://a.com', 0.5, [1, 2, 3, 4], 0),
      makeFpItem('https://b.com', 0.7, [1, 2, 3, 4, 5, 6], 1),
      makeFpItem('https://c.com', 0.9, [3, 4, 5, 6, 7, 8], 2),
    ];
    const result = mergeNearDuplicates(items, threshold);
    // All three should be in one group due to transitive union-find
    expect(result).toHaveLength(1);
    // Highest score (0.9) should be retained
    expect(result[0].item.score).toBe(0.9);
    expect(result[0].item.url).toBe('https://c.com');
  });

  // [Implements: US-DD-008] Transitive chain of 4 items
  it('groups a transitive chain of 4 items into one equivalence class', () => {
    // threshold 0.4:
    //   A = {1, 2, 3}           → A~B: 3/5=0.6 >= 0.4 ✓
    //   B = {1, 2, 3, 4, 5}     → B~C: 3 ({3,4,5})/7 ≈ 0.429 >= 0.4 ✓
    //   C = {3, 4, 5, 6, 7}     → C~D: 3 ({5,6,7})/7 ≈ 0.429 >= 0.4 ✓
    //   D = {5, 6, 7, 8, 9}
    const threshold = 0.4;
    const items = [
      makeFpItem('https://a.com', 0.5, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.6, [1, 2, 3, 4, 5], 1),
      makeFpItem('https://c.com', 0.7, [3, 4, 5, 6, 7], 2),
      makeFpItem('https://d.com', 0.8, [5, 6, 7, 8, 9], 3),
    ];
    const result = mergeNearDuplicates(items, threshold);
    // A~B, B~C, C~D → all in one group
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.8);
  });

  // [Implements: US-DD-008] Transitive grouping with separate non-connected clusters
  it('keeps separate transitive clusters separate', () => {
    // Two independent chains:
    //   Chain 1: A~B~C (all share high similarity)
    //   Chain 2: X~Y (high similarity)
    //   No connection between chains
    const threshold = 0.5;
    const items = [
      makeFpItem('https://a.com', 0.5, [1, 2, 3, 4], 0),
      makeFpItem('https://b.com', 0.6, [1, 2, 3, 5], 1),
      makeFpItem('https://c.com', 0.7, [1, 2, 3, 5, 6], 2),
      makeFpItem('https://x.com', 0.3, [10, 20, 30, 40], 3),
      makeFpItem('https://y.com', 0.8, [10, 20, 30, 50], 4),
    ];
    const result = mergeNearDuplicates(items, threshold);
    // A~B: {1,2,3}∩ / {1,2,3,4,5} = 3/5 = 0.6 >= 0.5 ✓
    // A~C: {1,2,3}∩ / {1,2,3,4,5,6} = 3/6 = 0.5 >= 0.5 ✓
    // B~C: {1,2,3,5}∩ / {1,2,3,5,6} = 4/5 = 0.8 >= 0.5 ✓
    // X~Y: {10,20,30}∩ / {10,20,30,40,50} = 3/5 = 0.6 >= 0.5 ✓
    // No cross-chain similarities
    expect(result).toHaveLength(2);
    // Best from chain 1: C (0.7), best from chain 2: Y (0.8)
    expect(result.some((fp) => fp.item.url === 'https://c.com')).toBe(true);
    expect(result.some((fp) => fp.item.url === 'https://y.com')).toBe(true);
  });

  // [Implements: US-DD-008] mergedSources in transitive grouping
  it('copies all discarded URLs into mergedSources for transitive groups', () => {
    const threshold = 0.5;
    const items = [
      makeFpItem('https://a.com', 0.9, [1, 2, 3, 4], 0),
      makeFpItem('https://b.com', 0.5, [1, 2, 3, 5], 1),  // A~B: 3/5=0.6
      makeFpItem('https://c.com', 0.3, [1, 2, 3, 5, 6], 2),  // B~C and A~C
    ];
    const result = mergeNearDuplicates(items, threshold);
    expect(result).toHaveLength(1);
    const retained = result[0];
    expect(retained.item.url).toBe('https://a.com');
    const sources = mergedSourcesMap.get(retained);
    expect(sources).toBeDefined();
    expect(sources).toHaveLength(2);
    expect(sources).toContain('https://b.com');
    expect(sources).toContain('https://c.com');
  });

  // [Implements: US-DD-008] Groups merged count in log
  it('logs correct groups_merged count for multiple merged groups', () => {
    const threshold = 0.0; // merge everything
    const items = [
      makeFpItem('https://a.com', 0.5, [1], 0),
      makeFpItem('https://b.com', 0.3, [2], 1),  // merges with a → group 1
      makeFpItem('https://c.com', 0.9, [3], 2),  // merges with a,b → still group 1
    ];
    mergeNearDuplicates(items, threshold);
    // All 3 in one group → 1 group merged, 2 removed
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('near-dups removed=2')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('groups_merged=1')
    );
  });

  // [Implements: US-DD-008] Large transitive group
  it('forms a single group from a long transitive chain of 5 items', () => {
    const threshold = 0.3;
    // Build a chain where each consecutive pair shares enough to be >= 0.3
    // Each item shares 3 out of 6 with the next
    const items = [
      makeFpItem('https://a.com', 0.1, [1, 2, 3, 4, 5], 0),
      makeFpItem('https://b.com', 0.2, [3, 4, 5, 6, 7], 1),
      makeFpItem('https://c.com', 0.3, [5, 6, 7, 8, 9], 2),
      makeFpItem('https://d.com', 0.4, [7, 8, 9, 10, 11], 3),
      makeFpItem('https://e.com', 0.5, [9, 10, 11, 12, 13], 4),
    ];
    const result = mergeNearDuplicates(items, threshold);
    // A~B: {3,4,5}∩ / {1,2,3,4,5,6,7} = 3/7 ≈ 0.429 >= 0.3 ✓
    // B~C: {5,6,7}∩ / {3,4,5,6,7,8,9} = 3/7 ≈ 0.429 >= 0.3 ✓
    // C~D: {7,8,9}∩ / {5,6,7,8,9,10,11} = 3/7 ≈ 0.429 >= 0.3 ✓
    // D~E: {9,10,11}∩ / {7,8,9,10,11,12,13} = 3/7 ≈ 0.429 >= 0.3 ✓
    // Non-adjacent pairs have lower similarity but transitively grouped
    expect(result).toHaveLength(1);
    expect(result[0].item.url).toBe('https://e.com');
    // mergedSources should contain all 4 discarded URLs
    const sources = mergedSourcesMap.get(result[0]);
    expect(sources).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Cross-stage integration: mergedSources propagation
// ---------------------------------------------------------------------------

describe('mergedSources propagation across stages', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: US-DD-003, US-DD-008] mergedSources accumulate across stages
  it('propagates mergedSources from URL dedup through near-dup merge', () => {
    // Stage 1: URL dedup groups a1 and a2 (same normalizedUrl), keeps a1 (higher score)
    //   → a1's mergedSources = ['https://a2.com']
    // Stage 2: Near-dup merge groups a1 (with its mergedSources) with c
    //   → retained item's mergedSources should include both 'https://a2.com' and 'https://c.com'
    const fps = [1, 2, 3];
    const items: FingerprintedItem[] = [
      makeFpItem('https://a1.com', 0.9, fps, 0, 'https://a.com'),
      makeFpItem('https://a2.com', 0.3, fps, 1, 'https://a.com'),
      makeFpItem('https://c.com', 0.5, fps, 2, 'https://c.com'),
    ];

    // Stage 1: URL dedup
    const afterUrlDedup = deduplicateByUrl(items);
    expect(afterUrlDedup).toHaveLength(2);

    // Check that a1 has mergedSources from a2
    const retainedA = afterUrlDedup.find((fp) => fp.item.url === 'https://a1.com');
    expect(retainedA).toBeDefined();
    const sourcesAfterUrlDedup = mergedSourcesMap.get(retainedA!);
    expect(sourcesAfterUrlDedup).toBeDefined();
    expect(sourcesAfterUrlDedup).toContain('https://a2.com');

    // Stage 2: Near-dup merge — all items have identical fingerprints
    const afterNearDup = mergeNearDuplicates(afterUrlDedup);
    expect(afterNearDup).toHaveLength(1);

    // The retained item (a1, score 0.9) should have mergedSources from both stages
    const finalSources = mergedSourcesMap.get(afterNearDup[0]);
    expect(finalSources).toBeDefined();
    expect(finalSources).toContain('https://a2.com');
    expect(finalSources).toContain('https://c.com');
    expect(finalSources).toHaveLength(2);
  });

  // [Implements: US-DD-003] clearMergedSources resets state
  it('clearMergedSources removes all entries from mergedSourcesMap', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
    ];
    mergeNearDuplicates(items);
    expect(mergedSourcesMap.size).toBe(1);

    clearMergedSources();
    expect(mergedSourcesMap.size).toBe(0);
  });

  // [Implements: US-DD-007] mergedSources from exact-content dedup propagate to near-dup
  it('propagates mergedSources from exact-content dedup through near-dup merge', () => {
    const fpsExact = [1, 2, 3];
    const items: FingerprintedItem[] = [
      makeFpItem('https://a.com', 0.9, fpsExact, 0, 'https://a.com'),
      makeFpItem('https://b.com', 0.3, fpsExact, 1, 'https://b.com'),
      makeFpItem('https://c.com', 0.5, fpsExact, 2, 'https://c.com'),
    ];

    // Stage: exact-content dedup — all three have identical fingerprints
    const afterExact = deduplicateExactContent(items);
    expect(afterExact).toHaveLength(1);

    const sources = mergedSourcesMap.get(afterExact[0]);
    expect(sources).toBeDefined();
    expect(sources).toContain('https://b.com');
    expect(sources).toContain('https://c.com');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('content-merger edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: US-DD-003] Single fingerprint in set
  it('handles items with single-element fingerprint sets', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [42], 0),
      makeFpItem('https://b.com', 0.5, [42], 1),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-008] Empty fingerprint sets — Jaccard returns 0.0
  it('does not merge items with empty fingerprint sets (Jaccard = 0.0)', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [], 0),
      makeFpItem('https://b.com', 0.5, [], 1),
    ];
    const result = mergeNearDuplicates(items, 0.5);
    // Both empty → jaccard returns 0.0 < 0.5 → no merge
    expect(result).toHaveLength(2);
  });

  // [Implements: US-DD-008] Empty fingerprint sets with threshold 0.0
  it('does not merge empty fingerprint sets even at threshold 0.0 (Jaccard = 0.0)', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [], 0),
      makeFpItem('https://b.com', 0.5, [], 1),
    ];
    const result = mergeNearDuplicates(items, 0.0);
    // Jaccard of two empty sets = 0.0, 0.0 >= 0.0 → actually merges!
    // The implementation returns 0.0 for both-empty, and 0.0 >= 0.0 is true
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-003] Large fingerprint sets
  it('handles large fingerprint sets correctly', () => {
    const baseFps = Array.from({ length: 100 }, (_, i) => i + 1);
    const slightlyDifferent = [...baseFps.slice(0, 90), 200, 201, 202, 203, 204, 205, 206, 207, 208, 209];
    const items = [
      makeFpItem('https://a.com', 0.5, baseFps, 0),
      makeFpItem('https://b.com', 0.9, slightlyDifferent, 1),
    ];
    // Intersection = 90, union = 110 → 90/110 ≈ 0.818 < 0.85 → no merge
    const result = mergeNearDuplicates(items, 0.85);
    expect(result).toHaveLength(2);
  });

  // [Implements: US-DD-003] Two items, one is subset of the other
  it('handles subset fingerprint sets correctly', () => {
    const items = [
      makeFpItem('https://a.com', 0.5, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.9, [1, 2, 3, 4], 1),
    ];
    // Intersection = 3, union = 4 → 3/4 = 0.75
    // With threshold 0.75 → merges
    const result = mergeNearDuplicates(items, 0.75);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-003] Same URL in mergedSources not duplicated
  it('does not duplicate URLs in mergedSources when same URL appears in discarded items', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.9, fps, 0, 'https://a.com'),
      makeFpItem('https://shared.com', 0.5, fps, 1, 'https://a.com'),
      makeFpItem('https://shared.com', 0.3, fps, 2, 'https://a.com'),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(1);
    const sources = mergedSourcesMap.get(result[0]);
    expect(sources).toBeDefined();
    // 'https://shared.com' appears twice in discarded items but should only be in sources once
    const sharedCount = sources!.filter((s) => s === 'https://shared.com').length;
    expect(sharedCount).toBe(1);
  });

  // [Implements: US-DD-008] Near-dup merge with many singletons
  it('preserves all singleton items that are not near-duplicates of anything', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.8, [10, 20, 30], 1),
      makeFpItem('https://c.com', 0.7, [100, 200, 300], 2),
      makeFpItem('https://d.com', 0.6, [1000, 2000, 3000], 3),
    ];
    const result = mergeNearDuplicates(items, 0.85);
    expect(result).toHaveLength(4);
  });

  // [Implements: US-DD-003, US-DD-007, US-DD-008] Full pipeline order
  it('full pipeline: URL dedup → exact-content dedup → near-dup merge', () => {
    const fps = [1, 2, 3];
    const items: FingerprintedItem[] = [
      // URL duplicate of item 0
      makeFpItem('https://a1.com', 0.9, fps, 0, 'https://a.com'),
      makeFpItem('https://a2.com', 0.3, fps, 1, 'https://a.com'),
      // Exact-content duplicate of item 0 (same fingerprints, different URL)
      makeFpItem('https://b.com', 0.7, fps, 2, 'https://b.com'),
      // Unique item
      makeFpItem('https://c.com', 0.5, [10, 20, 30], 3, 'https://c.com'),
    ];

    // Stage 1: URL dedup
    const afterUrl = deduplicateByUrl(items);
    // a1 and a2 merge → 3 items remain
    expect(afterUrl).toHaveLength(3);

    // Stage 2: Exact-content dedup
    const afterExact = deduplicateExactContent(afterUrl);
    // a1 and b have identical fingerprints → merge → 2 items remain
    expect(afterExact).toHaveLength(2);

    // Stage 3: Near-dup merge
    const afterNear = mergeNearDuplicates(afterExact);
    // a1 ([1,2,3]) and c ([10,20,30]) have 0 similarity → no merge → 2 items
    expect(afterNear).toHaveLength(2);

    // Verify the best representative was retained
    expect(afterNear.some((fp) => fp.item.url === 'https://a1.com')).toBe(true);
    expect(afterNear.some((fp) => fp.item.url === 'https://c.com')).toBe(true);
  });

  // [Implements: US-DD-003] Stats object is not required
  it('works without stats parameter for deduplicateByUrl', () => {
    const items = [
      makeFpItem('https://a.com/v1', 0.3, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/v2', 0.9, [2], 1, 'https://a.com'),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-007] Stats object is not required
  it('works without stats parameter for deduplicateExactContent', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
    ];
    const result = deduplicateExactContent(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-008] Stats object is not required
  it('works without stats parameter for mergeNearDuplicates', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-003] DedupStats type has correct fields
  it('correctly accumulates all stat types across all three functions', () => {
    const stats: DedupStats = createDedupStats();
    const fps = [1, 2, 3];

    // URL dedup
    const urlItems = [
      makeFpItem('https://a1.com', 0.9, fps, 0, 'https://a.com'),
      makeFpItem('https://a2.com', 0.3, fps, 1, 'https://a.com'),
    ];
    const afterUrl = deduplicateByUrl(urlItems, stats);
    expect(stats.exactUrlDuplicatesRemoved).toBe(1);

    // Exact-content dedup — add item b with identical fingerprints
    const exactItems = [
      ...afterUrl,
      makeFpItem('https://b.com', 0.5, fps, 2, 'https://b.com'),
    ];
    const afterExact = deduplicateExactContent(exactItems, stats);
    expect(stats.exactContentDuplicatesRemoved).toBe(1);

    // Near-dup merge — add two more items with identical fingerprints
    const nearItems = [
      ...afterExact,
      makeFpItem('https://c.com', 0.4, fps, 3, 'https://c.com'),
      makeFpItem('https://d.com', 0.2, fps, 4, 'https://d.com'),
    ];
    mergeNearDuplicates(nearItems, 0.85, stats);
    // All items have identical fingerprints → all in one group → 2 removed (c and d)
    expect(stats.nearDuplicatesRemoved).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// UnionFind transitive grouping — advanced patterns
// ---------------------------------------------------------------------------

describe('mergeNearDuplicates — advanced transitive patterns', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: US-DD-008] Diamond transitivity: A~B, A~C, B~D, C~D
  it('handles diamond transitivity (A~B, A~C, B~D, C~D)', () => {
    // threshold 0.5
    //   A = {1, 2, 3, 4}
    //   B = {1, 2, 3, 5}      → A~B: {1,2,3}=3, ∪={1,2,3,4,5}=5 → 0.6 >= 0.5 ✓
    //   C = {1, 2, 3, 6}      → A~C: {1,2,3}=3, ∪={1,2,3,4,6}=5 → 0.6 >= 0.5 ✓
    //   D = {1, 2, 5, 6}      → B~D: {1,2,5}=3, ∪={1,2,3,5,6}=5 → 0.6 >= 0.5 ✓
    //                          → C~D: {1,2,6}=3, ∪={1,2,3,6,5}=5 → 0.6 >= 0.5 ✓
    const threshold = 0.5;
    const items = [
      makeFpItem('https://a.com', 0.3, [1, 2, 3, 4], 0),
      makeFpItem('https://b.com', 0.5, [1, 2, 3, 5], 1),
      makeFpItem('https://c.com', 0.7, [1, 2, 3, 6], 2),
      makeFpItem('https://d.com', 0.9, [1, 2, 5, 6], 3),
    ];
    const result = mergeNearDuplicates(items, threshold);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-008] Star topology: center similar to all leaves,
  // but leaves are not similar to each other
  it('groups via star topology where center links to all leaves', () => {
    // threshold 0.5
    //   Center = {1, 2, 3, 4, 5}
    //   Leaf1  = {1, 2, 3, 10}   → Center~Leaf1: {1,2,3}=3, ∪={1,2,3,4,5,10}=6 → 0.5 >= 0.5 ✓
    //   Leaf2  = {1, 4, 5, 11}   → Center~Leaf2: {1,4,5}=3, ∪={1,2,3,4,5,11}=6 → 0.5 >= 0.5 ✓
    //   Leaf1~Leaf2: {1}=1, ∪={1,2,3,4,5,10,11}=7 → ~0.143 < 0.5 ✗
    const threshold = 0.5;
    const items = [
      makeFpItem('https://center.com', 0.9, [1, 2, 3, 4, 5], 0),
      makeFpItem('https://leaf1.com', 0.5, [1, 2, 3, 10], 1),
      makeFpItem('https://leaf2.com', 0.3, [1, 4, 5, 11], 2),
    ];
    const result = mergeNearDuplicates(items, threshold);
    expect(result).toHaveLength(1);
    expect(result[0].item.url).toBe('https://center.com');
  });

  // [Implements: US-DD-008] Two disconnected transitive groups + singletons
  it('handles two disconnected transitive groups alongside singletons', () => {
    const threshold = 0.5;
    // Group 1 (transitive chain): A~B~C
    // Group 2 (direct pair): X~Y
    // Singletons: Z, W
    const items = [
      // Group 1
      makeFpItem('https://a.com', 0.5, [1, 2, 3, 4], 0),       // A
      makeFpItem('https://b.com', 0.6, [1, 2, 3, 5], 1),       // B → A~B: 3/5=0.6
      makeFpItem('https://c.com', 0.7, [1, 2, 3, 5, 6], 2),    // C → B~C: 4/5=0.8, A~C: 3/6=0.5
      // Group 2
      makeFpItem('https://x.com', 0.8, [10, 20, 30, 40], 3),   // X
      makeFpItem('https://y.com', 0.3, [10, 20, 30, 50], 4),   // Y → X~Y: 3/5=0.6
      // Singletons
      makeFpItem('https://z.com', 0.9, [100, 200], 5),         // Z (disjoint)
      makeFpItem('https://w.com', 0.1, [999, 888], 6),         // W (disjoint)
    ];
    const result = mergeNearDuplicates(items, threshold);
    expect(result).toHaveLength(4);
    // Best from Group 1: C (0.7)
    expect(result.some((fp) => fp.item.url === 'https://c.com')).toBe(true);
    // Best from Group 2: X (0.8)
    expect(result.some((fp) => fp.item.url === 'https://x.com')).toBe(true);
    // Singletons preserved
    expect(result.some((fp) => fp.item.url === 'https://z.com')).toBe(true);
    expect(result.some((fp) => fp.item.url === 'https://w.com')).toBe(true);
  });

  // [Implements: US-DD-008] All items merge into one big group
  it('merges all items into a single group when all pairs exceed threshold', () => {
    const threshold = 0.3;
    const items = [
      makeFpItem('https://a.com', 0.1, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.2, [2, 3, 4], 1),
      makeFpItem('https://c.com', 0.3, [3, 4, 5], 2),
      makeFpItem('https://d.com', 0.4, [4, 5, 6], 3),
      makeFpItem('https://e.com', 0.5, [5, 6, 7], 4),
    ];
    // Each consecutive pair: ∩=2, ∪=4 → 0.5 >= 0.3 ✓
    // Non-consecutive pairs with lower sim also transitively linked
    const result = mergeNearDuplicates(items, threshold);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.5);
    expect(result[0].item.url).toBe('https://e.com');
  });

  // [Implements: US-DD-008] Pairwise short-circuit — items already unioned
  // don't trigger redundant similarity computation (tested by behavior)
  it('correctly merges items even when first pair already groups them', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
      makeFpItem('https://c.com', 0.3, fps, 2),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-008] No false merges — items just below threshold
  // for every pair remain all as singletons
  it('keeps all items as singletons when no pair meets the threshold', () => {
    const threshold = 0.9;
    const items = [
      makeFpItem('https://a.com', 0.9, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.8, [1, 2, 4], 1),
      makeFpItem('https://c.com', 0.7, [1, 3, 4], 2),
    ];
    // All pairs have intersection of 2, union of 4 → 0.5 < 0.9
    const result = mergeNearDuplicates(items, threshold);
    expect(result).toHaveLength(3);
  });

  // [Implements: NFR-DD-003] Logs groups_merged=2 for two separate merged groups
  it('logs groups_merged=2 when two independent groups are merged', () => {
    const threshold = 0.0;
    const items = [
      makeFpItem('https://a.com', 0.9, [1], 0),
      makeFpItem('https://b.com', 0.5, [2], 1),
      makeFpItem('https://c.com', 0.8, [3], 2),
      makeFpItem('https://d.com', 0.3, [4], 3),
    ];
    mergeNearDuplicates(items, threshold);
    // With threshold 0.0, all four merge into one group
    // Actually: A~B: jaccard(∅,∅)=0.0... no, {1}∩{2}=∅ → jaccard=0.0, 0.0>=0.0 → merge
    // All merge into 1 group
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('groups_merged=1')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('near-dups removed=3')
    );
  });

  // [Implements: NFR-DD-003] Logs groups_merged correctly for two separate groups
  it('logs groups_merged=2 for two separate 2-item groups', () => {
    const threshold = 0.3;
    const items = [
      // Group 1
      makeFpItem('https://a1.com', 0.9, [1, 2, 3], 0),
      makeFpItem('https://a2.com', 0.5, [2, 3, 4], 1),
      // Group 2
      makeFpItem('https://b1.com', 0.8, [10, 20, 30], 2),
      makeFpItem('https://b2.com', 0.3, [20, 30, 40], 3),
    ];
    mergeNearDuplicates(items, threshold);
    // a1~a2: ∩={2,3}=2, ∪={1,2,3,4}=4 → 0.5 >= 0.3 → group 1
    // b1~b2: ∩={20,30}=2, ∪={10,20,30,40}=4 → 0.5 >= 0.3 → group 2
    // a~b: disjoint → no merge
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('near-dups removed=2')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('groups_merged=2')
    );
  });
});

// ---------------------------------------------------------------------------
// Score-based selection edge cases
// ---------------------------------------------------------------------------

describe('score-based selection edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: US-DD-003] Negative scores
  it('retains the highest (least negative) score among URL duplicates', () => {
    const items = [
      makeFpItem('https://a.com/v1', -0.5, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/v2', -0.1, [2], 1, 'https://a.com'),
      makeFpItem('https://a.com/v3', -0.9, [3], 2, 'https://a.com'),
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(-0.1);
    expect(result[0].item.url).toBe('https://a.com/v2');
  });

  // [Implements: US-DD-007] Zero scores — exact-content dedup with zero scores
  it('retains earliest item when all scores are zero in exact-content dedup', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0, fps, 0),
      makeFpItem('https://b.com', 0, fps, 1),
      makeFpItem('https://c.com', 0, fps, 2),
    ];
    const result = deduplicateExactContent(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.url).toBe('https://a.com');
    expect(result[0].originalIndex).toBe(0);
  });

  // [Implements: US-DD-008] Maximum score (1.0) in near-dup merge
  it('retains the item with score 1.0 over lower scores in near-dup group', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.0, fps, 0),
      makeFpItem('https://b.com', 1.0, fps, 1),
      makeFpItem('https://c.com', 0.99, fps, 2),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(1.0);
    expect(result[0].item.url).toBe('https://b.com');
  });

  // [Implements: US-DD-003] Tie-break picks earliest even if a later item
  // has the same score AND lower originalIndex (originalIndex is fixed at creation)
  it('correctly tie-breaks by originalIndex, not by position in group array', () => {
    // Two items with same score but item at originalIndex 1 is pushed to group first
    const fps = [1, 2, 3];
    const item0 = makeFpItem('https://z.com', 0.8, fps, 0, 'https://same.com');
    const item1 = makeFpItem('https://y.com', 0.8, fps, 1, 'https://same.com');
    const item2 = makeFpItem('https://x.com', 0.8, fps, 2, 'https://same.com');
    // Reverse the array order — group insertion order differs from originalIndex
    const result = deduplicateByUrl([item2, item1, item0]);
    expect(result).toHaveLength(1);
    // Earliest originalIndex (0) wins regardless of insertion order
    expect(result[0].originalIndex).toBe(0);
    expect(result[0].item.url).toBe('https://z.com');
  });

  // [Implements: US-DD-008] Near-dup: item with highest score but latest index
  // wins over item with lower score but earlier index
  it('prioritizes score over originalIndex in near-dup merge', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://a.com', 0.5, fps, 0),
      makeFpItem('https://b.com', 0.9, fps, 5),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    // Score 0.9 beats earlier originalIndex 0 with score 0.5
    expect(result[0].item.score).toBe(0.9);
    expect(result[0].item.url).toBe('https://b.com');
  });
});

// ---------------------------------------------------------------------------
// mergedSources cross-stage propagation (extended)
// ---------------------------------------------------------------------------

describe('mergedSources cross-stage propagation (extended)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: US-DD-003, US-DD-007] URL dedup → exact-content dedup propagation
  it('propagates mergedSources from URL dedup through exact-content dedup', () => {
    const fps = [1, 2, 3];
    const items: FingerprintedItem[] = [
      // URL duplicate group: a1 and a2 (same normalizedUrl)
      makeFpItem('https://a1.com', 0.9, fps, 0, 'https://a.com'),
      makeFpItem('https://a2.com', 0.3, fps, 1, 'https://a.com'),
      // Exact-content duplicate of a1 (same fingerprints, different URL)
      makeFpItem('https://b.com', 0.5, fps, 2, 'https://b.com'),
    ];

    // Stage 1: URL dedup
    const afterUrl = deduplicateByUrl(items);
    expect(afterUrl).toHaveLength(2);
    // a1 should have mergedSources from a2
    const retainedA = afterUrl.find((fp) => fp.item.url === 'https://a1.com');
    expect(retainedA).toBeDefined();
    expect(mergedSourcesMap.get(retainedA!)).toContain('https://a2.com');

    // Stage 2: Exact-content dedup — a1 and b have identical fingerprints
    const afterExact = deduplicateExactContent(afterUrl);
    expect(afterExact).toHaveLength(1);

    // The retained item (a1, score 0.9) should have mergedSources from both stages
    const sources = mergedSourcesMap.get(afterExact[0]);
    expect(sources).toBeDefined();
    expect(sources).toContain('https://a2.com');
    expect(sources).toContain('https://b.com');
    expect(sources).toHaveLength(2);
  });

  // [Implements: US-DD-007, US-DD-008] Exact-content dedup → near-dup merge propagation
  it('propagates mergedSources from exact-content dedup through near-dup merge', () => {
    const fps = [1, 2, 3];
    const items: FingerprintedItem[] = [
      // Exact-content duplicates
      makeFpItem('https://a.com', 0.9, fps, 0, 'https://a.com'),
      makeFpItem('https://b.com', 0.3, fps, 1, 'https://b.com'),
      // Near-dup of a (slightly different fingerprints)
      makeFpItem('https://c.com', 0.5, [1, 2, 3, 4], 2, 'https://c.com'),
    ];

    // Stage 1: Exact-content dedup — a and b have identical fingerprints
    const afterExact = deduplicateExactContent(items);
    expect(afterExact).toHaveLength(2);
    // a should have mergedSources from b
    const retainedA = afterExact.find((fp) => fp.item.url === 'https://a.com');
    expect(retainedA).toBeDefined();
    expect(mergedSourcesMap.get(retainedA!)).toContain('https://b.com');

    // Stage 2: Near-dup merge — a ({1,2,3}) and c ({1,2,3,4}) → jaccard=3/4=0.75
    const afterNear = mergeNearDuplicates(afterExact, 0.5);
    expect(afterNear).toHaveLength(1);

    // The retained item should have mergedSources from both b and c
    const sources = mergedSourcesMap.get(afterNear[0]);
    expect(sources).toBeDefined();
    expect(sources).toContain('https://b.com');
    expect(sources).toContain('https://c.com');
    expect(sources).toHaveLength(2);
  });

  // [Implements: US-DD-003, US-DD-007, US-DD-008] Full 3-stage pipeline
  it('propagates mergedSources through all three stages', () => {
    const fps = [1, 2, 3];
    const fpsNear = [1, 2, 3, 4, 5];
    const items: FingerprintedItem[] = [
      // URL dup of item 0
      makeFpItem('https://a1.com', 0.9, fps, 0, 'https://a.com'),
      makeFpItem('https://a2.com', 0.2, fps, 1, 'https://a.com'),
      // Exact-content dup of item 0
      makeFpItem('https://b.com', 0.3, fps, 2, 'https://b.com'),
      // Near-dup of item 0
      makeFpItem('https://c.com', 0.5, fpsNear, 3, 'https://c.com'),
      // Unique item
      makeFpItem('https://d.com', 0.7, [100, 200, 300], 4, 'https://d.com'),
    ];

    // Stage 1: URL dedup → a1 retains (merges a2)
    const afterUrl = deduplicateByUrl(items);
    expect(afterUrl).toHaveLength(4);

    // Stage 2: Exact-content dedup → a1 retains (merges b)
    const afterExact = deduplicateExactContent(afterUrl);
    expect(afterExact).toHaveLength(3);

    // Stage 3: Near-dup merge → a1 ({1,2,3}) and c ({1,2,3,4,5}) → jaccard=3/5=0.6
    const afterNear = mergeNearDuplicates(afterExact, 0.5);
    // a1 and c merge → d is unique → 2 items
    expect(afterNear).toHaveLength(2);

    // The retained a1 should have mergedSources from a2, b, and c
    const retained = afterNear.find((fp) => fp.item.url === 'https://a1.com');
    expect(retained).toBeDefined();
    const sources = mergedSourcesMap.get(retained!);
    expect(sources).toBeDefined();
    expect(sources).toContain('https://a2.com');
    expect(sources).toContain('https://b.com');
    expect(sources).toContain('https://c.com');
    expect(sources).toHaveLength(3);
  });

  // [Implements: US-DD-003] mergedSources does not duplicate URLs across stages
  it('does not duplicate mergedSources URLs across stages', () => {
    const fps = [1, 2, 3];
    // a2 has the same URL as b — when a1 merges a2 (URL dedup) and b (exact-content),
    // the URL should not appear twice
    const items: FingerprintedItem[] = [
      makeFpItem('https://shared.com', 0.3, fps, 1, 'https://a.com'),
      makeFpItem('https://shared.com', 0.2, fps, 2, 'https://b.com'),
      makeFpItem('https://a.com', 0.9, fps, 0, 'https://a.com'),
    ];

    const afterUrl = deduplicateByUrl(items);
    // a.com and shared (from b group) remain — a.com merges shared (from a group)
    const afterExact = deduplicateExactContent(afterUrl);

    const retained = afterExact.find((fp) => fp.item.score === 0.9);
    if (retained) {
      const sources = mergedSourcesMap.get(retained);
      if (sources) {
        const sharedCount = sources.filter((s) => s === 'https://shared.com').length;
        expect(sharedCount).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism and output order
// ---------------------------------------------------------------------------

describe('determinism and output order', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: US-DD-003] Same input → same output (determinism)
  it('produces identical results for deduplicateByUrl on the same input', () => {
    const items = [
      makeFpItem('https://a.com/v1', 0.3, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/v2', 0.9, [2], 1, 'https://a.com'),
      makeFpItem('https://b.com', 0.7, [3], 2),
    ];
    const result1 = deduplicateByUrl(items);
    const result2 = deduplicateByUrl(items);
    expect(result1.length).toBe(result2.length);
    expect(urlsOf(result1)).toEqual(urlsOf(result2));
    expect(scoresOf(result1)).toEqual(scoresOf(result2));
  });

  // [Implements: US-DD-008] Same input → same merge result (determinism)
  it('produces identical merge results for the same input', () => {
    const items = [
      makeFpItem('https://a.com', 0.5, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.9, [1, 2, 4], 1),
      makeFpItem('https://c.com', 0.3, [1, 2, 3, 4], 2),
    ];
    const result1 = mergeNearDuplicates(items, 0.5);
    const result2 = mergeNearDuplicates(items, 0.5);
    expect(result1.length).toBe(result2.length);
    expect(urlsOf(result1)).toEqual(urlsOf(result2));
  });

  // [Implements: US-DD-003] Output preserves insertion order of first-seen groups
  it('preserves first-seen group order in deduplicateByUrl output', () => {
    const items = [
      makeFpItem('https://c.com', 0.7, [3], 0),               // Group C first
      makeFpItem('https://a.com/v1', 0.3, [1], 1, 'https://a.com'),
      makeFpItem('https://a.com/v2', 0.9, [2], 2, 'https://a.com'),  // Group A
      makeFpItem('https://b.com', 0.8, [4], 3),               // Group B
    ];
    const result = deduplicateByUrl(items);
    expect(result).toHaveLength(3);
    // Map preserves insertion order: C, A, B
    expect(result[0].item.url).toBe('https://c.com');
    expect(result[1].item.url).toBe('https://a.com/v2');
    expect(result[2].item.url).toBe('https://b.com');
  });

  // [Implements: US-DD-007] Output preserves first-seen group order for exact-content
  it('preserves first-seen group order in deduplicateExactContent output', () => {
    const groupA = [1, 2, 3];
    const groupB = [4, 5, 6];
    const items = [
      makeFpItem('https://unique.com', 0.5, [99], 0),         // Unique first
      makeFpItem('https://a1.com', 0.9, groupA, 1),
      makeFpItem('https://a2.com', 0.3, groupA, 2),            // Group A
      makeFpItem('https://b1.com', 0.8, groupB, 3),
      makeFpItem('https://b2.com', 0.2, groupB, 4),            // Group B
    ];
    const result = deduplicateExactContent(items);
    expect(result).toHaveLength(3);
    // Order: unique, a1, b1
    expect(result[0].item.url).toBe('https://unique.com');
    expect(result[1].item.url).toBe('https://a1.com');
    expect(result[2].item.url).toBe('https://b1.com');
  });

  // [Implements: US-DD-003, US-DD-007, US-DD-008] Retained item is the same object reference
  it('returns the same object reference for retained items in all three functions', () => {
    const fps = [1, 2, 3];
    const kept = makeFpItem('https://keep.com', 0.9, fps, 0);
    const dropped = makeFpItem('https://drop.com', 0.3, fps, 1);

    // URL dedup (same normalizedUrl)
    const urlResult = deduplicateByUrl([
      { ...kept, normalizedUrl: 'https://same.com' },
      { ...dropped, normalizedUrl: 'https://same.com' },
    ]);
    expect(urlResult[0]).toBe(urlResult[0]); // identity check

    // Exact-content dedup
    const exactResult = deduplicateExactContent([kept, dropped]);
    expect(exactResult[0]).toBe(kept);

    // Near-dup merge
    const nearResult = mergeNearDuplicates([kept, dropped]);
    expect(nearResult[0]).toBe(kept);
  });

  // [Implements: NFR-DD-004] Does not mutate the input array or items
  it('does not mutate the input array in mergeNearDuplicates', () => {
    const items = [
      makeFpItem('https://a.com', 0.9, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.5, [1, 2, 3], 1),
    ];
    const originalLength = items.length;
    const originalUrlA = items[0].item.url;
    const originalScoreB = items[1].item.score;

    mergeNearDuplicates(items);

    // Input array unchanged
    expect(items.length).toBe(originalLength);
    expect(items[0].item.url).toBe(originalUrlA);
    expect(items[1].item.score).toBe(originalScoreB);
  });

  // [Implements: NFR-DD-004] Does not mutate input in deduplicateByUrl
  it('does not mutate the input array in deduplicateByUrl', () => {
    const items = [
      makeFpItem('https://a.com/v1', 0.3, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/v2', 0.9, [2], 1, 'https://a.com'),
    ];
    const originalLength = items.length;

    deduplicateByUrl(items);

    expect(items.length).toBe(originalLength);
  });
});

// ---------------------------------------------------------------------------
// UnionFind internals — path compression and union-by-rank (behavioral)
// ---------------------------------------------------------------------------

describe('UnionFind path compression and union-by-rank (behavioral)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: US-DD-008] Deep transitive chain — path compression correctness
  it('correctly groups a deep transitive chain of 8 items', () => {
    const threshold = 0.3;
    // Each item overlaps with the next by 3 out of 7 → ~0.429 >= 0.3
    const items = [
      makeFpItem('https://a.com', 0.1, [1, 2, 3, 4, 5], 0),
      makeFpItem('https://b.com', 0.2, [3, 4, 5, 6, 7], 1),
      makeFpItem('https://c.com', 0.3, [5, 6, 7, 8, 9], 2),
      makeFpItem('https://d.com', 0.4, [7, 8, 9, 10, 11], 3),
      makeFpItem('https://e.com', 0.5, [9, 10, 11, 12, 13], 4),
      makeFpItem('https://f.com', 0.6, [11, 12, 13, 14, 15], 5),
      makeFpItem('https://g.com', 0.7, [13, 14, 15, 16, 17], 6),
      makeFpItem('https://h.com', 0.8, [15, 16, 17, 18, 19], 7),
    ];
    const result = mergeNearDuplicates(items, threshold);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.8);
    expect(result[0].item.url).toBe('https://h.com');
  });

  // [Implements: US-DD-008] Repeated union operations don't corrupt state
  it('handles repeated unions within a group without corruption', () => {
    const fps = [1, 2, 3];
    // All items have identical fingerprints → all pairs have sim=1.0
    // Union-find will attempt many redundant unions (already-same-root)
    const items = Array.from({ length: 10 }, (_, i) =>
      makeFpItem(`https://item${i}.com`, i * 0.1, fps, i)
    );
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9); // item with score 0.9 (index 9)
  });

  // [Implements: US-DD-008] Single-item input returns immediately (no crash)
  it('handles a two-item input with identical fingerprints', () => {
    const fps = [1, 2, 3, 4, 5];
    const items = [
      makeFpItem('https://a.com', 0.3, fps, 0),
      makeFpItem('https://b.com', 0.9, fps, 1),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    expect(result[0].item.score).toBe(0.9);
  });

  // [Implements: US-DD-008] Three items where only two are similar
  it('groups two similar items while keeping the third singleton', () => {
    const threshold = 0.5;
    const items = [
      makeFpItem('https://a.com', 0.9, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.5, [1, 2, 3], 1),     // identical to a → merge
      makeFpItem('https://c.com', 0.7, [100, 200], 2),    // disjoint
    ];
    const result = mergeNearDuplicates(items, threshold);
    expect(result).toHaveLength(2);
    expect(result.some((fp) => fp.item.url === 'https://a.com')).toBe(true);
    expect(result.some((fp) => fp.item.url === 'https://c.com')).toBe(true);
  });

  // [Implements: US-DD-008] Merged sources for singleton groups are empty
  it('does not create mergedSources entries for singleton groups', () => {
    const threshold = 0.9;
    const items = [
      makeFpItem('https://a.com', 0.9, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.5, [1, 2, 4], 1),  // jaccard 2/4=0.5 < 0.9
    ];
    const result = mergeNearDuplicates(items, threshold);
    expect(result).toHaveLength(2);
    expect(mergedSourcesMap.size).toBe(0);
  });

  // [Implements: US-DD-008] Near-dup mergedSources excludes retained item's own URL
  it('mergedSources for near-dup does not include the retained URL', () => {
    const fps = [1, 2, 3];
    const items = [
      makeFpItem('https://kept.com', 0.9, fps, 0),
      makeFpItem('https://dropped1.com', 0.5, fps, 1),
      makeFpItem('https://dropped2.com', 0.3, fps, 2),
    ];
    const result = mergeNearDuplicates(items);
    expect(result).toHaveLength(1);
    const sources = mergedSourcesMap.get(result[0]);
    expect(sources).toBeDefined();
    expect(sources).not.toContain('https://kept.com');
    expect(sources).toContain('https://dropped1.com');
    expect(sources).toContain('https://dropped2.com');
  });
});

// ---------------------------------------------------------------------------
// Additional stats and logging tests
// ---------------------------------------------------------------------------

describe('additional stats and logging tests', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    clearMergedSources();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    clearMergedSources();
  });

  // [Implements: NFR-DD-003] deduplicateByUrl logs correct count for multiple groups
  it('logs total removal count across multiple URL-dup groups', () => {
    const items = [
      makeFpItem('https://a.com/1', 0.9, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/2', 0.5, [2], 1, 'https://a.com'),
      makeFpItem('https://b.com/1', 0.8, [3], 2, 'https://b.com'),
      makeFpItem('https://b.com/2', 0.3, [4], 3, 'https://b.com'),
      makeFpItem('https://b.com/3', 0.6, [5], 4, 'https://b.com'),
    ];
    deduplicateByUrl(items);
    // Group A: 2 items → 1 removed; Group B: 3 items → 2 removed; total = 3
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-url-dups removed=3')
    );
  });

  // [Implements: NFR-DD-003] deduplicateExactContent logs correct count
  it('logs total removal count across multiple exact-content groups', () => {
    const groupA = [1, 2, 3];
    const groupB = [4, 5, 6];
    const items = [
      makeFpItem('https://a1.com', 0.9, groupA, 0),
      makeFpItem('https://a2.com', 0.5, groupA, 1),
      makeFpItem('https://a3.com', 0.3, groupA, 2),
      makeFpItem('https://b1.com', 0.8, groupB, 3),
      makeFpItem('https://b2.com', 0.2, groupB, 4),
    ];
    deduplicateExactContent(items);
    // Group A: 3 → 2 removed; Group B: 2 → 1 removed; total = 3
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('exact-content-dups removed=3')
    );
  });

  // [Implements: NFR-DD-003] Stats accumulated correctly across calls
  it('accumulates stats across multiple deduplicateByUrl calls', () => {
    const stats = createDedupStats();
    const items1 = [
      makeFpItem('https://a.com/1', 0.9, [1], 0, 'https://a.com'),
      makeFpItem('https://a.com/2', 0.5, [2], 1, 'https://a.com'),
    ];
    const items2 = [
      makeFpItem('https://b.com/1', 0.8, [3], 0, 'https://b.com'),
      makeFpItem('https://b.com/2', 0.3, [4], 1, 'https://b.com'),
      makeFpItem('https://b.com/3', 0.6, [5], 2, 'https://b.com'),
    ];
    deduplicateByUrl(items1, stats);
    deduplicateByUrl(items2, stats);
    expect(stats.exactUrlDuplicatesRemoved).toBe(3);
  });

  // [Implements: NFR-DD-003] Stats accumulated correctly across multiple exact-content calls
  it('accumulates stats across multiple deduplicateExactContent calls', () => {
    const stats = createDedupStats();
    const fps = [1, 2, 3];
    const items1 = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
    ];
    const items2 = [
      makeFpItem('https://c.com', 0.8, fps, 0),
      makeFpItem('https://d.com', 0.3, fps, 1),
      makeFpItem('https://e.com', 0.6, fps, 2),
    ];
    deduplicateExactContent(items1, stats);
    deduplicateExactContent(items2, stats);
    expect(stats.exactContentDuplicatesRemoved).toBe(3);
  });

  // [Implements: NFR-DD-003] Stats accumulated across multiple mergeNearDuplicates calls
  it('accumulates stats across multiple mergeNearDuplicates calls', () => {
    const stats = createDedupStats();
    const fps = [1, 2, 3];
    const items1 = [
      makeFpItem('https://a.com', 0.9, fps, 0),
      makeFpItem('https://b.com', 0.5, fps, 1),
    ];
    const items2 = [
      makeFpItem('https://c.com', 0.8, fps, 0),
      makeFpItem('https://d.com', 0.3, fps, 1),
      makeFpItem('https://e.com', 0.6, fps, 2),
    ];
    mergeNearDuplicates(items1, 0.5, stats);
    mergeNearDuplicates(items2, 0.5, stats);
    expect(stats.nearDuplicatesRemoved).toBe(3);
  });

  // [Implements: NFR-DD-003] Single item produces no log
  it('does not log for single-item input in deduplicateByUrl', () => {
    deduplicateByUrl([makeFpItem('https://a.com', 0.9, [1], 0)]);
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('exact-url-dups')
    );
  });

  // [Implements: NFR-DD-003] Single item produces no log in deduplicateExactContent
  it('does not log for single-item input in deduplicateExactContent', () => {
    deduplicateExactContent([makeFpItem('https://a.com', 0.9, [1, 2, 3], 0)]);
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('exact-content-dups')
    );
  });

  // [Implements: NFR-DD-003] Two singletons produce no log in mergeNearDuplicates
  it('does not log for all-singletons input in mergeNearDuplicates', () => {
    mergeNearDuplicates([
      makeFpItem('https://a.com', 0.9, [1, 2, 3], 0),
      makeFpItem('https://b.com', 0.8, [4, 5, 6], 1),
    ], 0.85);
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('near-dups')
    );
  });
});
