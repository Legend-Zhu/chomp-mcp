/**
 * Digest module shared types — DigestResult and SourceRef.
 *
 * These interfaces form the contract surface for digested/scraped content
 * that is consumed by downstream modules such as SY (synthesize).
 */

/**
 * A reference to a source document, carrying its origin URL and title.
 */
export interface SourceRef {
  /** Canonical or original URL of the source document. */
  url: string;

  /** Human-readable title of the source document. */
  title: string;
}

/**
 * The result of digesting source material into structured text suitable
 * for downstream synthesis.
 */
export interface DigestResult {
  /** Synthesized answer text. Non-empty in all returns including degradation. */
  answer: string;

  /** Array of key point strings. May be empty. */
  keyPoints: string[];

  /** References to the source documents included in this digest. */
  sources: SourceRef[];
}
