/**
 * ContentItem — enriched search result with scraped text content.
 *
 * Produced by the PL pipeline after merging SearchResult (from SR) with
 * ScrapeResult (from SC). Consumed by the DD (deduplicate) and SY
 * (synthesize) modules.
 *
 * [Spec: US-DD-010]
 */

/**
 * An enriched search result item that includes the scraped page content.
 */
export interface ContentItem {
  /** Page title from search result or scrape. */
  title: string;

  /** Original URL of the page. */
  url: string;

  /** Search-result snippet text from the search engine. */
  snippet: string;

  /** Relevance score from search (normalized `[0.0, 1.0]`). */
  score: number;

  /** Scraped text content of the page (may be empty string for failed scrapes). */
  content: string;
}
