/**
 * Search-retrieval (SR) module — public API barrel.
 *
 * Re-exports the search function, SearchResult and SearchOptions types,
 * and all seven custom error classes so that consumers can import from
 * a single entry point with full type safety and ESM export syntax.
 *
 * Public API surface:
 *   - search(query, options?) — SearXNG meta-search with retry and failover
 *   - SearchResult — normalized search result item { title, url, snippet, score }
 *   - SearchOptions — optional per-call overrides { maxResults?, timeoutMs?, categories? }
 *   - SearchError — base error for all search operational failures
 *   - SearchTimeoutError — request exceeded configured timeout
 *   - SearchParseError — SearXNG response could not be parsed as JSON
 *   - SearchFailedError — all retries exhausted (self-hosted mode)
 *   - SearchUnavailableError — all instances exhausted (public mode)
 *   - ConfigurationError — invalid environment configuration
 *   - ValidationError — invalid input parameters
 *
 * [Spec: US-SR-012, DC-SR-002, DC-SR-003]
 */

// [Implements: US-SR-012] Public search function — SearXNG meta-search with retry, failover, and 30s ceiling
export { search } from './retry-failover.js';

// [Implements: DC-SR-002, DC-SR-003] Shared types — normalized search result and per-call options
export type { SearchResult, SearchOptions } from '../../shared/types/search.js';

// [Implements: US-SR-012, DC-SR-002] Error classes — typed error hierarchy for search-retrieval failures
export {
  SearchError,
  SearchTimeoutError,
  SearchParseError,
  SearchFailedError,
  SearchUnavailableError,
  ConfigurationError,
  ValidationError,
} from './errors.js';
