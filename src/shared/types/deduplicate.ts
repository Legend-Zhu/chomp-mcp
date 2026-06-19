/**
 * Deduplicate module shared types — DeduplicatedItem and DDConfig.
 *
 * These interfaces form the contract surface between the DD (deduplicate)
 * module and the PL (pipeline-orchestration) and SY (synthesize) modules.
 *
 * [Spec: US-DD-010, US-DD-011]
 */

import type { ContentItem } from './content.js';

/**
 * Output item after deduplication — extends ContentItem with dedup metadata.
 *
 * Each field from ContentItem is inherited; three additional fields carry the
 * results of the deduplication pipeline (URL normalization, content merging,
 * and fingerprinting).
 */
export interface DeduplicatedItem extends ContentItem {
  /**
   * Page title from search result or scrape (inherited from ContentItem).
   * @inheritdoc
   */
  title: string;

  /**
   * Original URL of the retained representative item.
   * @inheritdoc
   */
  url: string;

  /**
   * Search-result snippet text (inherited from ContentItem).
   * @inheritdoc
   */
  snippet: string;

  /**
   * Relevance score of the retained representative item.
   * @inheritdoc
   */
  score: number;

  /**
   * Content text of the retained representative item.
   * @inheritdoc
   */
  content: string;

  /**
   * Canonical normalized URL after tracking-param strip, scheme/port/fragment
   * slash unification, and query-param sorting.
   */
  normalizedUrl: string;

  /**
   * Array of original URLs from items merged into this representative during
   * content-level dedup (empty if no merges occurred).
   */
  mergedSources: string[];

  /**
   * Number of unique paragraph fingerprints in this item's fingerprint set.
   * Always a non-negative integer.
   */
  fingerprintCount: number;
}

/**
 * Configuration for the deduplication pipeline.
 *
 * Values are resolved from environment variables with safe defaults. All
 * fields are required on the resolved configuration object.
 */
export interface DDConfig {
  /**
   * Jaccard similarity threshold for near-duplicate classification.
   * Range: `[0.0, 1.0]`. Default: `0.85`.
   * Environment variable: `DEDUP_SIMILARITY_THRESHOLD`.
   */
  similarityThreshold: number;

  /**
   * Minimum character count for a paragraph to be fingerprinted.
   * Must be a positive integer (`>= 1`). Default: `20`.
   * Environment variable: `MIN_PARAGRAPH_CHARS`.
   */
  minParagraphChars: number;

  /**
   * Additional tracking-parameter names to strip beyond the built-in blocklist.
   * Empty array means only the built-in blocklist is used. Default: `[]`.
   * Environment variable: `DEDUP_EXTRA_TRACKING_PARAMS` (comma-separated).
   */
  extraTrackingParams: string[];
}
