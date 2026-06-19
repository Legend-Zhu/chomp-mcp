/**
 * Pipeline-Orchestration (PL) Module — Public API barrel exports.
 *
 * Re-exports the public entry points, error classes, and type interfaces
 * consumed by the MCP server (MC) module and external callers.
 *
 * Public functions:
 *   - runWebSearch: Execute the full web_search pipeline
 *     (Search → Scrape → Deduplicate → Synthesize) and return a formatted
 *     digest string.
 *   - runWebFetch: Execute the web_fetch pipeline (Scrape → Synthesize) for
 *     a single known URL and return a formatted digest string.
 *
 * Error factories:
 *   - createPipelineError: Create a PipelineError instance for hard pipeline
 *     failures (search down, all scrapes failed, web_fetch scrape error).
 *   - createPipelineTimeoutError: Create a PipelineTimeoutError instance for
 *     unrecoverable pipeline timeout with no content retrieved.
 *
 * Type interfaces:
 *   - WebSearchParams: Validated parameters for runWebSearch.
 *   - WebFetchParams:  Validated parameters for runWebFetch.
 *   - PipelineError:    Error class for hard pipeline failures.
 *   - PipelineTimeoutError: Error class for pipeline timeout failures.
 *   - FailedUrl:        Diagnostic context for URLs that failed scraping.
 *
 * [Spec: US-PL-001, US-PL-002, US-PL-004, US-PL-005, US-PL-006,
 *        US-PL-007, US-PL-008, US-PL-009, US-PL-010, US-PL-011,
 *        US-PL-012, US-PL-013, US-PL-014, US-PL-015,
 *        BG-PL-001, BG-PL-002, BG-PL-003,
 *        NFR-PL-005, NFR-PL-006, NFR-PL-008,
 *        DC-PL-002, DC-PL-003, DC-PL-005]
 */

// ---------------------------------------------------------------------------
// Imports from orchestrator
// ---------------------------------------------------------------------------

import {
  runWebSearch,
  runWebFetch,
  PipelineError,
  PipelineTimeoutError,
} from './orchestrator.js';

import type {
  WebSearchParams,
  WebFetchParams,
  FailedUrl,
} from './orchestrator.js';

import type { ErrorCategory } from '../../shared/utils/errors.js';

// ---------------------------------------------------------------------------
// Re-export public entry-point functions
// ---------------------------------------------------------------------------

export { runWebSearch, runWebFetch };

// ---------------------------------------------------------------------------
// Re-export error classes
// ---------------------------------------------------------------------------

export { PipelineError, PipelineTimeoutError };

// ---------------------------------------------------------------------------
// Re-export type interfaces
// ---------------------------------------------------------------------------

export type { WebSearchParams, WebFetchParams, FailedUrl };

// ---------------------------------------------------------------------------
// Error factory functions
// ---------------------------------------------------------------------------

/**
 * Create a PipelineError instance for hard pipeline failures.
 *
 * Hard failures include search stage failure (US-PL-010), all scrapes failed
 * (US-PL-011), and web_fetch scrape failure (US-PL-007). The MCP server
 * catches these and presents them as `isError: true` responses.
 *
 * @param message - Human-readable error message.
 * @param category - Error category for classification (default: 'unknown').
 * @param failedUrls - URLs that failed scraping, for diagnostic context.
 * @returns A new PipelineError instance.
 *
 * [Implements: US-PL-006, US-PL-007, US-PL-010, US-PL-011, NFR-PL-004]
 */
// [Implements: US-PL-006, US-PL-007, US-PL-010, US-PL-011, NFR-PL-004]
export function createPipelineError(
  message: string,
  category: ErrorCategory = 'unknown',
  failedUrls: FailedUrl[] = []
): PipelineError {
  return new PipelineError(message, category, failedUrls);
}

/**
 * Create a PipelineTimeoutError instance for unrecoverable pipeline timeout.
 *
 * Thrown when the overall pipeline timeout elapses and no partial content
 * was retrieved to degrade to (US-PL-004, US-PL-005). The MCP server catches
 * these and presents a timeout-specific message to the user.
 *
 * @param message - Timeout error message.
 * @param timeoutMs - The configured timeout value (in ms) that was exceeded.
 * @param failedUrls - URLs that failed, for diagnostic context.
 * @returns A new PipelineTimeoutError instance.
 *
 * [Implements: US-PL-004, US-PL-005, US-PL-015]
 */
// [Implements: US-PL-004, US-PL-005, US-PL-015]
export function createPipelineTimeoutError(
  message: string,
  timeoutMs: number,
  failedUrls: FailedUrl[] = []
): PipelineTimeoutError {
  return new PipelineTimeoutError(message, timeoutMs, failedUrls);
}
