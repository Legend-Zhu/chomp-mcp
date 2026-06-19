/**
 * Content merger — exact-URL, exact-content, and near-duplicate merging.
 *
 * Three pure transformation functions that reduce a list of FingerprintedItems
 * by removing duplicates at three levels:
 *
 *   1. deduplicateByUrl       — identical normalized URL
 *   2. deduplicateExactContent — identical fingerprint sets
 *   3. mergeNearDuplicates    — Jaccard similarity ≥ threshold (union-find)
 *
 * Each function retains the highest-scored item per group (ties → earliest
 * originalIndex) and copies discarded items' source URLs into the retained
 * item's mergedSources for citation traceability. Removal counts are logged
 * to stderr.
 *
 * Merged source URLs are tracked in an exported module-level Map keyed by
 * the returned FingerprintedItem reference. The deduplicator entry point
 * reads from this Map when constructing DeduplicatedItem objects.
 *
 * [Spec: US-DD-003, US-DD-007, US-DD-008, NFR-DD-002, NFR-DD-003, NFR-DD-004]
 */

import type { FingerprintedItem } from './types.js';
import type { DedupStats } from './types.js';
import { jaccardSimilarity, warnHighPairwiseCost } from './similarity-computer.js';
import { SIMILARITY_THRESHOLD_DEFAULT } from './types.js';

// ---------------------------------------------------------------------------
// Merged sources tracking
// ---------------------------------------------------------------------------

/**
 * Side-channel Map for tracking merged source URLs per FingerprintedItem.
 *
 * FingerprintedItem does not have a mergedSources field (that field exists
 * only on DeduplicatedItem). This Map carries merged URLs through the dedup
 * pipeline stages. The deduplicator.ts entry point reads from this Map when
 * constructing DeduplicatedItem objects.
 *
 * Call `clearMergedSources()` between independent deduplication runs to
 * prevent stale entries from accumulating.
 *
 * [Spec: US-DD-003, US-DD-007, US-DD-008]
 */
export const mergedSourcesMap = new Map<FingerprintedItem, string[]>();

/**
 * Clear all merged-source tracking entries.
 *
 * Should be called by the deduplicator before starting a new deduplication
 * run to ensure no stale state leaks between invocations.
 */
export function clearMergedSources(): void {
  mergedSourcesMap.clear();
}

// ---------------------------------------------------------------------------
// Union-Find (disjoint set) with path compression + union-by-rank
// ---------------------------------------------------------------------------

/**
 * Disjoint-set (union-find) data structure with path compression and
 * union-by-rank for near-duplicate transitive grouping.
 *
 * Used by mergeNearDuplicates to form transitive equivalence groups from
 * pairwise similarity relationships.
 *
 * [Spec: US-DD-008, NFR-DD-004]
 */
class UnionFind {
  private readonly parent: Int32Array;
  private readonly rank: Int8Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    this.rank = new Int8Array(size);
    for (let i = 0; i < size; i++) {
      this.parent[i] = i;
    }
  }

  // [Implements: US-DD-008] Find root with path compression
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) {
      root = this.parent[root];
    }
    // Path compression: point all traversed nodes directly to the root
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  // [Implements: US-DD-008] Union by rank
  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) {
      return;
    }

    // [Implements: US-DD-008] Attach shorter tree under taller one
    if (this.rank[rootA] < this.rank[rootB]) {
      this.parent[rootA] = rootB;
    } else if (this.rank[rootA] > this.rank[rootB]) {
      this.parent[rootB] = rootA;
    } else {
      // Equal ranks — choose rootA as new root, increment its rank
      this.parent[rootB] = rootA;
      this.rank[rootA]++;
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: select best representative from a group
// ---------------------------------------------------------------------------

/**
 * Select the index of the best item within a group of FingerprintedItems.
 *
 * Selection criteria:
 *   1. Highest `item.score`
 *   2. Ties broken by lowest `originalIndex` (earliest in input order)
 *
 * @param group - Array of FingerprintedItems in the same equivalence class.
 * @returns Index of the best (representative) item within `group`.
 *
 * [Implements: US-DD-003, US-DD-007, US-DD-008]
 * [Constraint: NFR-DD-004]
 */
function selectBestIndex(group: FingerprintedItem[]): number {
  let bestIdx = 0;
  for (let i = 1; i < group.length; i++) {
    const best = group[bestIdx];
    const candidate = group[i];

    // [Implements: US-DD-003] Higher score wins
    if (candidate.item.score > best.item.score) {
      bestIdx = i;
    }
    // [Implements: US-DD-003] Equal score → earliest originalIndex wins
    else if (
      candidate.item.score === best.item.score &&
      candidate.originalIndex < best.originalIndex
    ) {
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Collect merged source URLs from a discarded item into the accumulator.
 *
 * Adds the discarded item's own URL and any previously-merged source URLs
 * (from earlier pipeline stages) into the `accum` array, skipping duplicates
 * and the retained item's own URL.
 *
 * @param discarded - The FingerprintedItem being discarded.
 * @param retainedUrl - The URL of the retained item (excluded from sources).
 * @param accum - Accumulator array of unique merged source URLs.
 */
function collectMergedSources(
  discarded: FingerprintedItem,
  retainedUrl: string,
  accum: string[]
): void {
  // Add the discarded item's own URL
  if (discarded.item.url !== retainedUrl && !accum.includes(discarded.item.url)) {
    accum.push(discarded.item.url);
  }

  // Include any previously merged sources from earlier stages
  const priorSources = mergedSourcesMap.get(discarded);
  if (priorSources !== undefined) {
    for (const src of priorSources) {
      if (src !== retainedUrl && !accum.includes(src)) {
        accum.push(src);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Exact-URL deduplication
// ---------------------------------------------------------------------------

// [Implements: US-DD-003, NFR-DD-003]
/**
 * Deduplicate FingerprintedItems by identical normalized URL.
 *
 * Groups items by their `normalizedUrl` field. Within each group, retains
 * only the item with the highest `score` (ties → earliest `originalIndex`).
 * Discarded items' source URLs are copied into the retained item's
 * mergedSources via the module-level mergedSourcesMap for citation
 * traceability.
 *
 * @param items - Array of FingerprintedItems to deduplicate.
 * @param stats - Optional mutable DedupStats accumulator
 *                (`exactUrlDuplicatesRemoved` is incremented).
 * @returns New array of FingerprintedItems with URL-duplicates removed.
 *
 * [Implements: US-DD-003, NFR-DD-003, NFR-DD-004]
 */
export function deduplicateByUrl(
  items: FingerprintedItem[],
  stats?: DedupStats
): FingerprintedItem[] {
  if (items.length === 0) {
    return [];
  }

  // [Implements: US-DD-003] Group items by normalizedUrl
  const groups = new Map<string, FingerprintedItem[]>();

  for (const fpItem of items) {
    const key = fpItem.normalizedUrl;
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    group.push(fpItem);
  }

  const result: FingerprintedItem[] = [];
  let removedCount = 0;

  for (const group of groups.values()) {
    // Single-item group — no dedup needed
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // [Implements: US-DD-003] Retain highest-scored (ties → earliest originalIndex)
    const bestIdx = selectBestIndex(group);
    const best = group[bestIdx];

    // [Implements: US-DD-003] Copy discarded items' URLs into mergedSources
    const mergedSources: string[] = [];

    // Carry over any previously tracked merged sources for the retained item
    const existing = mergedSourcesMap.get(best);
    if (existing !== undefined) {
      for (const src of existing) {
        mergedSources.push(src);
      }
    }

    for (let i = 0; i < group.length; i++) {
      if (i === bestIdx) {
        continue;
      }
      collectMergedSources(group[i], best.item.url, mergedSources);
    }

    if (mergedSources.length > 0) {
      mergedSourcesMap.set(best, mergedSources);
    }

    result.push(best);
    removedCount += group.length - 1;
  }

  // [Implements: NFR-DD-003] Log removal count to stderr
  if (removedCount > 0) {
    process.stderr.write(
      `[DD] exact-url-dups removed=${removedCount}\n`
    );
  }

  if (stats !== undefined) {
    stats.exactUrlDuplicatesRemoved += removedCount;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 2. Exact-content deduplication
// ---------------------------------------------------------------------------

// [Implements: US-DD-007, NFR-DD-003]
/**
 * Deduplicate FingerprintedItems with identical fingerprint sets.
 *
 * Two items are exact-content duplicates when their fingerprint sets contain
 * the exact same elements. Comparison is done by sorting each set's elements
 * and comparing the resulting arrays, which is equivalent to a sorted-array
 * join.
 *
 * Within each exact-content-duplicate group, retains only the item with the
 * highest `score` (ties → earliest `originalIndex`). Discarded items' URLs
 * are copied into the retained item's mergedSources.
 *
 * @param items - Array of FingerprintedItems to deduplicate (typically the
 *                output of deduplicateByUrl).
 * @param stats - Optional mutable DedupStats accumulator
 *                (`exactContentDuplicatesRemoved` is incremented).
 * @returns New array of FingerprintedItems with exact-content duplicates
 *          removed.
 *
 * [Implements: US-DD-007, NFR-DD-003, NFR-DD-004]
 */
export function deduplicateExactContent(
  items: FingerprintedItem[],
  stats?: DedupStats
): FingerprintedItem[] {
  if (items.length === 0) {
    return [];
  }

  // [Implements: US-DD-007] Compute canonical fingerprint key per item.
  // Sort fingerprint values numerically and join into a string for a
  // deterministic key that uniquely identifies an identical set.
  const groups = new Map<string, FingerprintedItem[]>();

  for (const fpItem of items) {
    const sorted = Array.from(fpItem.fingerprints).sort((a, b) => a - b);
    const key = sorted.join(',');

    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    group.push(fpItem);
  }

  const result: FingerprintedItem[] = [];
  let removedCount = 0;

  for (const group of groups.values()) {
    // Single-item group — no dedup needed
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // [Implements: US-DD-007] Retain highest-scored (ties → earliest originalIndex)
    const bestIdx = selectBestIndex(group);
    const best = group[bestIdx];

    // [Implements: US-DD-007] Copy discarded items' URLs into mergedSources
    const mergedSources: string[] = [];

    // Carry over previously tracked merged sources for the retained item
    const existing = mergedSourcesMap.get(best);
    if (existing !== undefined) {
      for (const src of existing) {
        mergedSources.push(src);
      }
    }

    for (let i = 0; i < group.length; i++) {
      if (i === bestIdx) {
        continue;
      }
      collectMergedSources(group[i], best.item.url, mergedSources);
    }

    if (mergedSources.length > 0) {
      mergedSourcesMap.set(best, mergedSources);
    }

    result.push(best);
    removedCount += group.length - 1;
  }

  // [Implements: NFR-DD-003] Log removal count to stderr
  if (removedCount > 0) {
    process.stderr.write(
      `[DD] exact-content-dups removed=${removedCount}\n`
    );
  }

  if (stats !== undefined) {
    stats.exactContentDuplicatesRemoved += removedCount;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 3. Near-duplicate merge
// ---------------------------------------------------------------------------

// [Implements: US-DD-008, NFR-DD-002, NFR-DD-003, NFR-DD-004]
/**
 * Merge near-duplicate FingerprintedItems using pairwise Jaccard similarity
 * and union-find transitive grouping.
 *
 * Computes N*(N-1)/2 pairwise Jaccard similarities between all items. When
 * two items have similarity ≥ `similarityThreshold`, they are unioned into
 * the same equivalence group via union-find. This ensures transitive
 * grouping: if A≈B and B≈C, then A, B, C are all in the same group even if
 * A≈C falls below the threshold.
 *
 * Within each group, retains only the highest-scored item (ties → earliest
 * originalIndex) and copies discarded items' URLs into mergedSources.
 *
 * @param items - Array of FingerprintedItems to merge (typically the output
 *                of deduplicateExactContent).
 * @param similarityThreshold - Jaccard threshold for near-duplicate
 *        classification. Items with similarity ≥ this value are merged.
 *        Defaults to `SIMILARITY_THRESHOLD_DEFAULT` (0.85).
 * @param stats - Optional mutable DedupStats accumulator
 *                (`nearDuplicatesRemoved` is incremented).
 * @returns New array of FingerprintedItems with near-duplicates merged.
 *
 * [Implements: US-DD-008, NFR-DD-002, NFR-DD-003, NFR-DD-004]
 */
export function mergeNearDuplicates(
  items: FingerprintedItem[],
  similarityThreshold: number = SIMILARITY_THRESHOLD_DEFAULT,
  stats?: DedupStats
): FingerprintedItem[] {
  if (items.length <= 1) {
    return items;
  }

  // [Implements: NFR-DD-002] Warn if pairwise comparison cost is high
  warnHighPairwiseCost(items.length);

  const n = items.length;

  // [Implements: US-DD-008] Initialize union-find for transitive grouping
  const uf = new UnionFind(n);

  // [Implements: US-DD-008, NFR-DD-002] Compute N*(N-1)/2 pairwise similarities
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Skip if already in the same group (short-circuit optimization)
      if (uf.find(i) === uf.find(j)) {
        continue;
      }

      const sim = jaccardSimilarity(
        items[i].fingerprints,
        items[j].fingerprints
      );

      // [Implements: US-DD-008] Similarity ≥ threshold → union into same group
      if (sim >= similarityThreshold) {
        uf.union(i, j);
      }
    }
  }

  // [Implements: US-DD-008] Collect items into groups by union-find root
  const groupMap = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    let group = groupMap.get(root);
    if (group === undefined) {
      group = [];
      groupMap.set(root, group);
    }
    group.push(i);
  }

  const result: FingerprintedItem[] = [];
  let removedCount = 0;
  let groupsMerged = 0;

  for (const indices of groupMap.values()) {
    // Single-item group — no merge needed
    if (indices.length === 1) {
      result.push(items[indices[0]]);
      continue;
    }

    // Multi-item group — select best representative
    const groupItems = indices.map((idx) => items[idx]);

    // [Implements: US-DD-008] Retain highest-scored (ties → earliest originalIndex)
    const bestIdx = selectBestIndex(groupItems);
    const best = groupItems[bestIdx];

    // [Implements: US-DD-008] Copy discarded items' URLs into mergedSources
    const mergedSources: string[] = [];

    // Carry over previously tracked merged sources for the retained item
    const existing = mergedSourcesMap.get(best);
    if (existing !== undefined) {
      for (const src of existing) {
        mergedSources.push(src);
      }
    }

    for (let i = 0; i < groupItems.length; i++) {
      if (i === bestIdx) {
        continue;
      }
      collectMergedSources(groupItems[i], best.item.url, mergedSources);
    }

    if (mergedSources.length > 0) {
      mergedSourcesMap.set(best, mergedSources);
    }

    result.push(best);
    removedCount += groupItems.length - 1;
    groupsMerged++;
  }

  // [Implements: NFR-DD-003] Log near-duplicate removal count and groups merged
  if (removedCount > 0) {
    process.stderr.write(
      `[DD] near-dups removed=${removedCount} groups_merged=${groupsMerged}\n`
    );
  }

  if (stats !== undefined) {
    stats.nearDuplicatesRemoved += removedCount;
  }

  return result;
}
