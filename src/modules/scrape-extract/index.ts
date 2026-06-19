/**
 * Scrape-extract (SC) module — public API surface.
 *
 * This barrel file is the single import point for the Pipeline Orchestration
 * (PL) module and any other downstream consumers. It re-exports the `scrape()`
 * entry function from `./scraper.js` and re-exports the public types
 * `ScrapeResult`, `ExtractionMethod` (from shared types) and `ScrapeOptions`,
 * `ScrapeConfig` (from internal types) so callers never need to reach into
 * individual source files.
 *
 * [Spec: DC-SC-006]
 */

// Public entry function — orchestrates the full scrape pipeline.
export { scrape } from './scraper.js';

// Public types from shared types (the cross-module contract surface).
export type { ScrapeResult, ExtractionMethod } from '../../shared/types/scrape.js';

// Internal types exposed for callers that need to pass ScrapeOptions or
// inspect the resolved ScrapeConfig shape.
export type { ScrapeOptions, ScrapeConfig } from './types.js';
