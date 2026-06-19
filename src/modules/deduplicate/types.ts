/**
 * Internal type definitions and configuration for the deduplicate (DD) module.
 *
 * Defines the DedupStats accumulator interface, the FingerprintedItem working
 * structure used during content-level deduplication, the three core constants
 * (MAX_PAIRWISE_ITEMS, MIN_PARAGRAPH_CHARS_DEFAULT, SIMILARITY_THRESHOLD_DEFAULT),
 * and the loadConfig() environment-based configuration loader.
 *
 * The shared DDConfig type is imported from shared/types/deduplicate.ts and
 * not redefined here.
 *
 * [Spec: US-DD-006, US-DD-010, DC-DD-005, NFR-DD-003]
 */

import type { DDConfig } from '../../shared/types/deduplicate.js';
import type { ContentItem } from '../../shared/types/content.js';

// ---------------------------------------------------------------------------
// Core constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of items for which pairwise content comparison is considered
 * acceptable. When the number of items after URL deduplication exceeds this
 * value, a warning is logged to stderr indicating high pairwise comparison
 * cost (N*(N-1)/2 comparisons).
 *
 * [Constraint: DC-DD-005]
 */
export const MAX_PAIRWISE_ITEMS = 50;

/**
 * Default minimum character count for a paragraph to be eligible for
 * fingerprinting. Paragraphs shorter than this threshold are skipped to
 * avoid noise from boilerplate text.
 *
 * [Constraint: DC-DD-005, US-DD-006]
 */
export const MIN_PARAGRAPH_CHARS_DEFAULT = 20;

/**
 * Default Jaccard similarity threshold for near-duplicate classification.
 * Items whose fingerprint-set Jaccard similarity meets or exceeds this value
 * are treated as near-duplicates.
 *
 * [Constraint: DC-DD-005, US-DD-006]
 */
export const SIMILARITY_THRESHOLD_DEFAULT = 0.85;

// ---------------------------------------------------------------------------
// Module-internal types
// ---------------------------------------------------------------------------

/**
 * Accumulator for deduplication pipeline statistics.
 *
 * Tracks counts at each dedup stage to produce a summary logged to stderr
 * at the end of processing. All fields are non-negative integers except
 * `elapsedMs`.
 *
 * [Spec: US-DD-010, DC-DD-005]
 */
export interface DedupStats {
  /** Number of ContentItems received as input. */
  inputCount: number;

  /** Items removed because content was empty, null, or whitespace-only. */
  emptyContentRemoved: number;

  /** Items removed due to processing errors (caught exceptions). */
  errorItemsRemoved: number;

  /** Items removed by identical normalized URL. */
  exactUrlDuplicatesRemoved: number;

  /** Items removed by identical fingerprint sets. */
  exactContentDuplicatesRemoved: number;

  /** Items removed by near-duplicate Jaccard similarity. */
  nearDuplicatesRemoved: number;

  /** Number of DeduplicatedItems returned as output. */
  outputCount: number;

  /** Total wall-clock processing time in milliseconds. */
  elapsedMs: number;
}

/**
 * Intermediate working structure used during content-level deduplication.
 *
 * Each FingerprintedItem bundles a reference to the original ContentItem with
 * its computed fingerprint set and normalization metadata. Used internally by
 * the similarity-computer and content-merger components.
 *
 * [Spec: US-DD-006]
 */
export interface FingerprintedItem {
  /** Reference to the original content item. */
  item: ContentItem;

  /** Canonical normalized URL after URL normalization. */
  normalizedUrl: string;

  /** Set of 32-bit paragraph fingerprint hashes. */
  fingerprints: Set<number>;

  /** Zero-based position in the original input array (for deterministic tie-breaking). */
  originalIndex: number;
}

// ---------------------------------------------------------------------------
// Configuration loader
// ---------------------------------------------------------------------------

// [Implements: US-DD-006, DC-DD-005, NFR-DD-003]
/**
 * Resolve deduplication configuration from environment variables with safe
 * defaults, merging any caller-provided overrides.
 *
 * Environment variables read:
 * - `DEDUP_SIMILARITY_THRESHOLD`: Jaccard threshold in `[0.0, 1.0]`. Default: `0.85`.
 * - `MIN_PARAGRAPH_CHARS`: Minimum paragraph length (positive integer `>= 1`). Default: `20`.
 * - `DEDUP_EXTRA_TRACKING_PARAMS`: Comma-separated extra tracking-param names. Default: `[]`.
 *
 * Invalid values trigger a stderr warning and fall back to the corresponding
 * default. Caller-provided fields in `config` take precedence over both env
 * vars and defaults.
 *
 * @param config Optional partial overrides to apply on top of env/defaults.
 * @returns A fully resolved DDConfig.
 *
 * [Implements: US-DD-006, DC-DD-005, NFR-DD-003]
 */
export function loadConfig(config?: Partial<DDConfig>): DDConfig {
  // --- Resolve similarityThreshold from env ---
  let similarityThreshold = SIMILARITY_THRESHOLD_DEFAULT;

  const envThreshold = process.env['DEDUP_SIMILARITY_THRESHOLD'];
  if (envThreshold !== undefined) {
    const parsed = parseFloat(envThreshold);
    // [Constraint: DC-DD-005] Valid range check [0.0, 1.0]
    if (!Number.isNaN(parsed) && parsed >= 0.0 && parsed <= 1.0) {
      similarityThreshold = parsed;
    } else {
      // [Implements: US-DD-006] Invalid range — log warning and fall back to default
      process.stderr.write(
        `[DD] WARN invalid similarity threshold: value=${envThreshold} fallback=${SIMILARITY_THRESHOLD_DEFAULT}\n`
      );
    }
  }

  // --- Resolve minParagraphChars from env ---
  let minParagraphChars = MIN_PARAGRAPH_CHARS_DEFAULT;

  const envMinChars = process.env['MIN_PARAGRAPH_CHARS'];
  if (envMinChars !== undefined) {
    const parsed = parseInt(envMinChars, 10);
    // [Constraint: DC-DD-005] Must be a positive integer (>= 1)
    if (!Number.isNaN(parsed) && parsed >= 1) {
      minParagraphChars = parsed;
    } else {
      // [Implements: US-DD-006] Invalid value — log warning and fall back to default
      process.stderr.write(
        `[DD] WARN invalid min paragraph chars: value=${envMinChars} fallback=${MIN_PARAGRAPH_CHARS_DEFAULT}\n`
      );
    }
  }

  // --- Resolve extraTrackingParams from env ---
  let extraTrackingParams: string[] = [];

  const envExtraParams = process.env['DEDUP_EXTRA_TRACKING_PARAMS'];
  if (envExtraParams !== undefined) {
    // [Implements: US-DD-006] Split on commas and filter out empty strings
    extraTrackingParams = envExtraParams
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  // --- Apply caller-provided overrides (highest priority) ---
  if (config !== undefined) {
    if (config.similarityThreshold !== undefined) {
      similarityThreshold = config.similarityThreshold;
    }
    if (config.minParagraphChars !== undefined) {
      minParagraphChars = config.minParagraphChars;
    }
    if (config.extraTrackingParams !== undefined) {
      extraTrackingParams = config.extraTrackingParams;
    }
  }

  return {
    similarityThreshold,
    minParagraphChars,
    extraTrackingParams,
  };
}
