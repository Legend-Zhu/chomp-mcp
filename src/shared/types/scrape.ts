/**
 * Shared scrape type definitions — the public contract for the scrape-extract module.
 *
 * Consumed by downstream modules: DD, SY, PL.
 *
 * [Spec: US-SC-012, DC-SC-001, DC-SC-002, DC-SC-005, DC-SC-006, NFR-SC-005]
 */

/**
 * Identifies how content was extracted from a page.
 *
 * | Value                 | Description                                                                 |
 * |-----------------------|-----------------------------------------------------------------------------|
 * | `'readability'`       | Primary path succeeded — jsdom + Readability extracted ≥ 200 chars          |
 * | `'readability-failed'`| Readability yielded < 200 chars or threw; triggers Puppeteer fallback       |
 * | `'puppeteer'`         | Puppeteer headless browser rendered, then Readability extracted content     |
 * | `'json'`              | Content-Type: application/json — parsed and formatted to text               |
 * | `'xml'`               | Content-Type: application/xml / text/xml — tags stripped                     |
 * | `'raw-text'`          | Content-Type: text/plain / text/markdown — returned as-is                   |
 *
 * Note: `'readability-failed'` is an intermediate flag — it never appears as the
 * terminal `extractionMethod` in a successful `ScrapeResult`. It signals that the
 * Puppeteer fallback should be attempted.
 *
 * [Spec: DC-SC-002]
 */
export type ExtractionMethod =
  | 'readability'
  | 'readability-failed'
  | 'puppeteer'
  | 'json'
  | 'xml'
  | 'raw-text';

/**
 * Shape returned by `scrape()` when extraction succeeds.
 *
 * When `success` is `true`, `textContent` is guaranteed non-null and non-empty
 * (at least 1 character).
 *
 * [Spec: DC-SC-001, US-SC-012]
 */
export interface ScrapeSuccessResult {
  /** `true` — content was extracted successfully. */
  readonly success: true;
  /** The original input URL. */
  readonly url: string;
  /** Final URL after all redirects. */
  readonly finalUrl: string;
  /** Extracted page title. */
  readonly title: string;
  /** Clean extracted text content — guaranteed non-null and non-empty (≥ 1 char). */
  readonly textContent: string;
  /** Method used for extraction. */
  readonly extractionMethod: ExtractionMethod;
  /** `true` if text was truncated at `MAX_CONTENT_CHARS`. */
  readonly truncated: boolean;
  /** Character count of the final (post-truncation) `textContent`. */
  readonly contentLength: number;
  /** Wall-clock elapsed time in milliseconds from scrape start to completion. */
  readonly elapsedMs: number;
  /** `null` on success. */
  readonly error: null;
}

/**
 * Shape returned by `scrape()` when extraction fails.
 *
 * The `scrape()` function never rejects the Promise for expected failures
 * (HTTP errors, timeouts, network failures, parse failures, binary content,
 * SSRF violations). All such conditions are converted into this shape with a
 * descriptive `error` string.
 *
 * [Spec: DC-SC-001, US-SC-012, NFR-SC-005]
 */
export interface ScrapeFailureResult {
  /** `false` — extraction failed. */
  readonly success: false;
  /** The original input URL. */
  readonly url: string;
  /** Final URL after redirect chain; `null` if no response was received. */
  readonly finalUrl: string | null;
  /** `null` on failure. */
  readonly title: null;
  /** `null` on failure. */
  readonly textContent: null;
  /** `null` on failure. */
  readonly extractionMethod: null;
  /** Always `false` on failure. */
  readonly truncated: false;
  /** Always `0` on failure. */
  readonly contentLength: number;
  /** Wall-clock elapsed time in milliseconds from scrape start to failure. */
  readonly elapsedMs: number;
  /** Non-empty, human-readable error message describing the failure. */
  readonly error: string;
}

/**
 * The primary output contract of the scrape-extract module.
 *
 * The `scrape()` function ALWAYS returns this type as a **resolved** Promise.
 * It never rejects for expected failures (HTTP errors, timeouts, parse failures).
 * Only truly unexpected internal errors (e.g., a bug causing a `TypeError`) may
 * propagate as thrown exceptions — the PL module catches these per the
 * cross-module error propagation rules.
 *
 * Discriminated union on the `success` field:
 * - Use `if (result.success)` to narrow to `ScrapeSuccessResult`
 * - In the `else` branch, TypeScript narrows to `ScrapeFailureResult`
 *
 * [Spec: DC-SC-001, US-SC-012, NFR-SC-005]
 */
export type ScrapeResult = ScrapeSuccessResult | ScrapeFailureResult;
