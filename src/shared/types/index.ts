/**
 * Shared type definitions — barrel re-exports for all cross-module types.
 *
 * Import from `../../shared/types/index.js` (or the package root) to access
 * any shared type without reaching into individual type files.
 */

// Search — normalized search result items and search options
export type { SearchResult, SearchOptions } from './search.js';

// Content — enriched search result with scraped text content
export type { ContentItem } from './content.js';

// Deduplicate — deduplication output items and configuration
export type { DeduplicatedItem, DDConfig } from './deduplicate.js';
