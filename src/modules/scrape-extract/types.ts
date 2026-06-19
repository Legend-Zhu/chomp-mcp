/**
 * Internal type definitions for the scrape-extract (SC) module.
 *
 * Defines configuration, options, and intermediate result types used by
 * internal components: http-fetcher, content-extractor, puppeteer-renderer,
 * content-type-router, truncator, url-validator, and scraper.
 *
 * Public types (`ExtractionMethod`, `ScrapeResult`) are imported from
 * shared/types and not redefined here.
 *
 * [Spec: US-SC-012, DC-SC-001, DC-SC-002, DC-SC-005, DC-SC-006, NFR-SC-005]
 */

import type { ExtractionMethod } from '../../shared/types/scrape.js';

/**
 * Optional per-call overrides passed to `scrape()`.
 *
 * All fields are optional — when omitted, values fall back to `ScrapeConfig`
 * resolved from environment variables.
 *
 * [Spec: DC-SC-006]
 */
export interface ScrapeOptions {
  /** Override the default per-fetch timeout (`SCRAPE_TIMEOUT_MS`) for this call. */
  timeoutMs?: number;
  /** Override the default max content length (`MAX_CONTENT_CHARS`) for this call. */
  maxContentChars?: number;
  /** Optional abort signal for cooperative cancellation (passed by PL timeout guard). */
  signal?: AbortSignal;
}

/**
 * Resolved configuration used internally by all SC components.
 *
 * Merged from environment-variable defaults with any `ScrapeOptions` overrides.
 *
 * [Spec: DC-SC-005]
 */
export interface ScrapeConfig {
  /** Per-fetch timeout in ms (env `SCRAPE_TIMEOUT_MS`, default `15000`). */
  timeoutMs: number;
  /** Maximum extracted text length in characters (env `MAX_CONTENT_CHARS`, default `8000`). `0` or negative disables truncation. */
  maxContentChars: number;
  /** Maximum HTTP redirect hops (constant: `5`). */
  maxRedirects: number;
  /** Threshold for Readability success — below this triggers Puppeteer fallback (constant: `200`). */
  minContentChars: number;
  /** Total scrape timeout including fallback (computed: `timeoutMs × 2`). */
  maxTotalTimeoutMs: number;
}

/**
 * Raw HTTP response data returned by `http-fetcher`.
 *
 * Represents the outcome of a single HTTP fetch attempt, including redirect
 * following and timeout handling.
 */
export interface FetchResult {
  /** `true` if a usable HTTP response was received (2xx status). */
  success: boolean;
  /** HTTP status code (`0` if no response was received). */
  statusCode: number;
  /** HTTP status text or error message. */
  statusText: string;
  /** Value of the `Content-Type` response header; `null` if missing. */
  contentType: string | null;
  /** Raw response body bytes; `null` on fetch failure. */
  bodyBytes: Uint8Array | null;
  /** Final URL after redirect chain; `null` if no response was received. */
  finalUrl: string | null;
  /** Number of redirects followed. */
  redirectCount: number;
  /** Error message if `success === false`; `null` otherwise. */
  error: string | null;
  /** Value parsed from `Retry-After` header (in ms); `null` if absent. */
  retryAfterMs: number | null;
}

/**
 * Result of jsdom + Readability extraction.
 *
 * Produced by `content-extractor` when processing HTML responses.
 */
export interface ExtractionOutput {
  /** Extracted page title (may be empty string). */
  title: string;
  /** Extracted plain text content. */
  textContent: string;
  /** `'readability'` if ≥ `minContentChars`, `'readability-failed'` if below. */
  extractionMethod: ExtractionMethod;
  /** Character count of `textContent`. */
  charCount: number;
}

/**
 * Result of Puppeteer headless rendering.
 *
 * Produced by `puppeteer-renderer` as a fallback when the primary Readability
 * path yields insufficient content.
 */
export interface RenderResult {
  /** `true` if the browser launched and the page rendered successfully. */
  success: boolean;
  /** Rendered HTML source; `null` on failure. */
  html: string | null;
  /** Error message; `null` on success. */
  error: string | null;
}

/**
 * Result of content-type routing.
 *
 * Produced by `content-type-router` to categorize a fetched response and
 * extract text for non-HTML types. HTML responses require further Readability
 * extraction and have `textContent: null`.
 */
export interface ContentTypeResult {
  /** Detected content category. */
  kind: 'html' | 'json' | 'xml' | 'text' | 'binary' | 'unsupported';
  /** Extracted text for non-HTML types; `null` for HTML (requires further Readability extraction). */
  textContent: string | null;
  /** Set for non-HTML types; `null` for HTML. */
  extractionMethod: ExtractionMethod | null;
  /** Error message for `binary`/`unsupported` types; `null` otherwise. */
  error: string | null;
}

/**
 * Result of URL validation.
 *
 * Produced by `url-validator` to check URL format, scheme, and SSRF safety.
 */
export interface ValidationResult {
  /** `true` if the URL passes all checks (format, scheme, non-private IP). */
  valid: boolean;
  /** Error message if `valid === false`; `null` otherwise. */
  error: string | null;
}

/**
 * Result of content truncation.
 *
 * Produced by `truncator` to enforce `MAX_CONTENT_CHARS` with word-boundary
 * preservation.
 */
export interface TruncationResult {
  /** Truncated or original text (within `maxContentChars`). */
  text: string;
  /** `true` if the text was shortened. */
  truncated: boolean;
}
