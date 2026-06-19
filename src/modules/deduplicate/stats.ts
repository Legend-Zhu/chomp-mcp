/**
 * Stats accumulator — DedupStats creation and stderr summary logging.
 *
 * Provides two utilities used by the deduplicator:
 * - `createDedupStats()`: returns a fresh DedupStats object with every field
 *   zeroed, ready to be mutated during pipeline processing.
 * - `logStats(stats)`: emits a single structured summary line to stderr after
 *   deduplication completes, containing all stage counts and elapsed time.
 *
 * The summary is always logged, even when every count is zero.
 *
 * [Spec: US-DD-009, NFR-DD-003]
 */

import type { DedupStats } from './types.js';

// [Implements: US-DD-009]
/**
 * Create a fresh DedupStats accumulator with all fields initialized to zero.
 *
 * The returned object is a plain mutable record — callers increment the
 * appropriate fields as items are removed at each deduplication stage.
 *
 * @returns A DedupStats with `inputCount`, `emptyContentRemoved`,
 *          `errorItemsRemoved`, `exactUrlDuplicatesRemoved`,
 *          `exactContentDuplicatesRemoved`, `nearDuplicatesRemoved`,
 *          `outputCount`, and `elapsedMs` all set to `0`.
 *
 * [Implements: US-DD-009, NFR-DD-003]
 */
export function createDedupStats(): DedupStats {
  return {
    inputCount: 0,
    emptyContentRemoved: 0,
    errorItemsRemoved: 0,
    exactUrlDuplicatesRemoved: 0,
    exactContentDuplicatesRemoved: 0,
    nearDuplicatesRemoved: 0,
    outputCount: 0,
    elapsedMs: 0,
  };
}

// [Implements: US-DD-009, NFR-DD-003]
/**
 * Emit a structured single-line deduplication summary to stderr.
 *
 * The summary includes: input count, exact-URL duplicates removed,
 * exact-content duplicates removed, near-duplicates removed, empty
 * content removed, error items removed, output count, and elapsed
 * time in milliseconds.
 *
 * This function always emits the summary line, even when all counts
 * are zero. It never throws.
 *
 * @param stats - The accumulated DedupStats to summarize.
 *
 * [Implements: US-DD-009, NFR-DD-003]
 */
export function logStats(stats: DedupStats): void {
  process.stderr.write(
    `[DD] summary ` +
      `input=${stats.inputCount} ` +
      `exact-url-dups=${stats.exactUrlDuplicatesRemoved} ` +
      `exact-content-dups=${stats.exactContentDuplicatesRemoved} ` +
      `near-dups=${stats.nearDuplicatesRemoved} ` +
      `empty=${stats.emptyContentRemoved} ` +
      `errors=${stats.errorItemsRemoved} ` +
      `output=${stats.outputCount} ` +
      `elapsedMs=${stats.elapsedMs}\n`
  );
}
