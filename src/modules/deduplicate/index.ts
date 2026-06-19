/**
 * Deduplicate (DD) module — public API barrel file.
 *
 * This is the sole import surface for the PL (pipeline-orchestration) module
 * to invoke deduplication as one atomic step. It exports:
 *
 * - `deduplicate` — the primary entry function that runs the full pipeline:
 *     URL normalization → exact-URL dedup → paragraph segmentation →
 *     fingerprint computation → exact-content dedup → near-duplicate merge
 *     → returns DeduplicatedItem[]
 * - `DeduplicatedItem` — output type (extends ContentItem with dedup metadata)
 * - `DDConfig` — configuration type for the deduplication pipeline
 *
 * No internal symbols (FingerprintedItem, DedupStats, loadConfig, etc.) are
 * re-exported — they remain module-internal implementation details.
 *
 * [Spec: US-DD-011, DC-DD-003]
 */

// [Implements: US-DD-011, DC-DD-003]
export { deduplicate } from './deduplicator.js';

export type { DeduplicatedItem, DDConfig } from '../../shared/types/deduplicate.js';
