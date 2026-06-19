/**
 * Deduplicator — full deduplication pipeline entry function.
 *
 * Orchestrates the complete deduplication flow:
 *   1. Filter items with empty/null/whitespace-only content (log warning)
 *   2. URL-normalize each item (per-item error catching)
 *   3. Compute fingerprint sets for each surviving item
 *   4. Exact-URL deduplication (identical normalized URLs)
 *   5. Exact-content deduplication (identical fingerprint sets)
 *   6. Near-duplicate merge (Jaccard similarity >= threshold)
 *   7. Assemble DeduplicatedItem[] with normalizedUrl, mergedSources, fingerprintCount
 *   8. Log summary stats
 *
 * Pure function: never mutates input, returns fresh objects, never throws.
 * All errors are caught, logged to stderr, and the offending item is skipped.
 *
 * [Spec: US-DD-003, US-DD-008, US-DD-009, US-DD-010, US-DD-011,
 *        BG-DD-001, BG-DD-002, NFR-DD-001, NFR-DD-003, NFR-DD-004,
 *        NFR-DD-005, NFR-DD-007, DC-DD-001, DC-DD-003, DC-DD-004]
 */

import type { ContentItem } from '../../shared/types/content.js';
import type { DeduplicatedItem, DDConfig } from '../../shared/types/deduplicate.js';
import type { DedupStats, FingerprintedItem } from './types.js';
import { loadConfig } from './types.js';
import { normalizeUrl } from './url-normalizer.js';
import { computeFingerprintSet } from './fingerprinter.js';
import {
  deduplicateByUrl,
  deduplicateExactContent,
  mergeNearDuplicates,
  clearMergedSources,
  mergedSourcesMap,
} from './content-merger.js';
import { createDedupStats, logStats } from './stats.js';

// [Implements: US-DD-003, US-DD-008, US-DD-009, US-DD-010, US-DD-011,
//  BG-DD-001, BG-DD-002, NFR-DD-001, NFR-DD-003, NFR-DD-004,
//  NFR-DD-005, NFR-DD-007, DC-DD-001, DC-DD-003, DC-DD-004]
/**
 * Execute the full deduplication pipeline on an array of content items.
 *
 * The pipeline performs these stages in order:
 *   1. Filter items with empty/null/whitespace-only content (log warning with URL).
 *   2. URL-normalize each item (catching per-item errors, logging to stderr).
 *   3. Compute paragraph fingerprint sets for each item.
 *   4. Exact-URL deduplication — remove items with identical normalized URLs.
 *   5. Exact-content deduplication — remove items with identical fingerprint sets.
 *   6. Near-duplicate merge — merge items with Jaccard similarity >= threshold.
 *   7. Assemble DeduplicatedItem[] output with dedup metadata.
 *
 * Behavior for edge cases:
 *   - Empty input array — returns empty array (summary still logged with zeros).
 *   - Single item — returns that item after URL normalization, no pairwise comparison.
 *   - Per-item errors — caught, logged to stderr, item skipped, processing continues.
 *
 * The function is pure: it never mutates the input array or its items, always
 * returns fresh objects, and never throws exceptions to the caller.
 *
 * @param items - Array of ContentItems to deduplicate. Never mutated.
 * @param config - Optional DDConfig. When undefined, resolved from environment
 *                 variables via loadConfig().
 * @returns Array of DeduplicatedItems with dedup metadata. Never throws.
 *
 * [Implements: US-DD-003, US-DD-008, US-DD-009, US-DD-010, US-DD-011,
 *  BG-DD-001, BG-DD-002, NFR-DD-001, NFR-DD-003, NFR-DD-004,
 *  NFR-DD-005, NFR-DD-007, DC-DD-001, DC-DD-003, DC-DD-004]
 */
export function deduplicate(
  items: ContentItem[],
  config?: DDConfig
): DeduplicatedItem[] {
  // [Implements: US-DD-009] Record start time for elapsed tracking
  const startTime = Date.now();

  // [Implements: US-DD-009] Initialize stats accumulator with all fields zeroed
  const stats: DedupStats = createDedupStats();
  stats.inputCount = items.length;

  // [Implements: DC-DD-003, NFR-DD-001] Clear stale merged-source entries from
  // any previous deduplication run to prevent state leakage between calls.
  clearMergedSources();

  // [Implements: US-DD-011] Empty input — return empty array immediately,
  // but still log the summary with zero counts.
  if (items.length === 0) {
    stats.outputCount = 0;
    stats.elapsedMs = Date.now() - startTime;
    // [Implements: US-DD-009, NFR-DD-003] Always log summary, even with zero counts
    logStats(stats);
    return [];
  }

  // [Implements: US-DD-010] Resolve config from environment when undefined.
  // When a full DDConfig is provided by the caller, use it directly.
  const resolvedConfig: DDConfig =
    config === undefined ? loadConfig() : config;

  // [Implements: US-DD-009, NFR-DD-007] Build FingerprintedItems with
  // per-item error handling — never abort the entire pipeline on one item.
  const fingerprinted: FingerprintedItem[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // [Implements: US-DD-004, US-DD-011] Filter empty/null/whitespace-only content.
    // Log a warning to stderr with the item's URL and increment the counter.
    if (!item.content || item.content.trim().length === 0) {
      process.stderr.write(`[DD] WARN empty content: url=${item.url}\n`);
      stats.emptyContentRemoved++;
      continue;
    }

    // [Implements: NFR-DD-007, DC-DD-003] Per-item error handling — URL normalization.
    // The normalizeUrl function may throw TypeError for malformed URLs.
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeUrl(
        item.url,
        resolvedConfig.extraTrackingParams
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[DD] ERROR normalize-url: url=${item.url} error=${msg}\n`
      );
      stats.errorItemsRemoved++;
      continue;
    }

    // [Implements: NFR-DD-007, DC-DD-003] Per-item error handling — fingerprinting.
    // The computeFingerprintSet function should not normally throw, but we guard
    // against unexpected errors to satisfy the never-throw contract.
    let fingerprints: Set<number>;
    try {
      fingerprints = computeFingerprintSet(
        item.content,
        resolvedConfig.minParagraphChars
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[DD] ERROR fingerprint: url=${item.url} error=${msg}\n`
      );
      stats.errorItemsRemoved++;
      continue;
    }

    // [Implements: US-DD-010] Build FingerprintedItem with normalizedUrl and originalIndex
    fingerprinted.push({
      item,
      normalizedUrl,
      fingerprints,
      originalIndex: i,
    });
  }

  // [Implements: US-DD-003, NFR-DD-004] Exact-URL deduplication — group by
  // identical normalized URL, retain highest-scored (ties → earliest input).
  const urlDeduped: FingerprintedItem[] = deduplicateByUrl(fingerprinted, stats);

  // [Implements: US-DD-007] Exact-content deduplication — group by identical
  // fingerprint sets. Removed items are excluded from near-duplicate comparison.
  const contentDeduped: FingerprintedItem[] = deduplicateExactContent(
    urlDeduped,
    stats
  );

  // [Implements: US-DD-008, NFR-DD-004] Near-duplicate merge — pairwise Jaccard
  // similarity >= threshold with union-find transitive grouping. Skips pairwise
  // comparison automatically when <= 1 item remains.
  const merged: FingerprintedItem[] = mergeNearDuplicates(
    contentDeduped,
    resolvedConfig.similarityThreshold,
    stats
  );

  // [Implements: US-DD-010, US-DD-011] Assemble DeduplicatedItem[] output.
  // Each output item includes: inherited ContentItem fields, normalizedUrl,
  // mergedSources (from the side-channel Map, may be empty), and fingerprintCount.
  const result: DeduplicatedItem[] = merged.map((fpItem) => {
    // Read merged source URLs from the side-channel Map populated by the
    // content-merger stages. Copy into a fresh array for purity.
    const sources = mergedSourcesMap.get(fpItem);
    const mergedSources: string[] = sources !== undefined ? [...sources] : [];

    return {
      title: fpItem.item.title,
      url: fpItem.item.url,
      snippet: fpItem.item.snippet,
      score: fpItem.item.score,
      content: fpItem.item.content,
      normalizedUrl: fpItem.normalizedUrl,
      mergedSources,
      fingerprintCount: fpItem.fingerprints.size,
    };
  });

  // [Implements: US-DD-009] Finalize output count and elapsed time
  stats.outputCount = result.length;
  stats.elapsedMs = Date.now() - startTime;

  // [Implements: US-DD-009, NFR-DD-003] Log summary to stderr — always emitted,
  // even when zero items were removed at every stage.
  logStats(stats);

  return result;
}
