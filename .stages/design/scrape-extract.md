# Design: Scrape and Extract (SC)

## Overview

The Scrape and Extract (SC) module converts a single URL into clean, readable text content suitable for downstream LLM synthesis. It implements a two-tier extraction strategy: a **lightweight primary path** (native `fetch` → encoding decode → content-type routing → jsdom + Mozilla Readability) that handles the majority of static HTML pages, and a **Puppeteer headless-browser fallback** that renders JavaScript-heavy SPA pages when the primary path yields insufficient content (< 200 characters). The module also handles HTTP redirects (max 5 hops), transient-error retries with exponential backoff, character-encoding detection and conversion (GBK, Shift-JIS, Big5, Latin-1, etc.), non-HTML resource routing (JSON, XML, plain text), content truncation at configurable limits, SSRF protection, and per-page timeout enforcement.

The module guarantees a **uniform `ScrapeResult` return type** for every invocation — it never throws for expected failures (HTTP errors, timeouts, parse failures). Failures are surfaced as `ScrapeResult` objects with `success: false` and a human-readable `error` field, allowing the pipeline orchestrator to isolate per-URL failures without try/catch.

## Architecture

The SC module sits between the Search Retrieval (SR) module and the Deduplicate (DD) module in the pipeline flow:

```
SR (search results)
  │
  ▼  PL calls scrape(url) per result, concurrently up to MAX_CONCURRENCY
SC (scrape-extract)
  │  ├─ http-fetcher      → native fetch, redirects, retries, timeout
  │  ├─ encoding-detector  → charset detection + iconv-lite decode
  │  ├─ content-type-router → dispatch by Content-Type (HTML/JSON/XML/text/binary)
  │  ├─ content-extractor  → jsdom + Readability (primary extraction)
  │  ├─ puppeteer-renderer → headless browser (fallback for JS pages)
  │  ├─ truncator          → word-boundary truncation at MAX_CONTENT_CHARS
  │  └─ url-validator      → format + SSRF validation
  │
  ▼  ScrapeResult { success, url, textContent, ... }
DD (deduplicate) → SY (synthesize)
```

**Key architectural properties:**
- **Never throws** for expected failures — PL can call `scrape()` without try/catch (per cross-module error propagation rules in index.md).
- **Stateless** — no shared mutable state between scrape invocations; each call is fully independent.
- **stderr-only logging** — all diagnostic output goes to `process.stderr`; stdout is reserved for MCP JSON-RPC.
- **Environment-variable configuration** — reads `SCRAPE_TIMEOUT_MS` (default 15000) and `MAX_CONTENT_CHARS` (default 8000) from env via the shared config singleton.
- **Dependency injection boundary** — PL calls `scrape(url: string): Promise<ScrapeResult>`; SC never calls PL, SR, DD, or SY directly.

## Data Models

### ScrapeResult (defined in `shared/types/scrape.ts`, produced by SC)

The primary output contract. Always returned by `scrape()` — never thrown.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `success` | `boolean` | Yes | `true` if content was extracted successfully; `false` on any failure |
| `url` | `string` | Yes | The original input URL |
| `finalUrl` | `string \| null` | Yes | Final URL after all redirects; `null` on failure before any fetch response |
| `title` | `string \| null` | Yes | Extracted page title; `null` on failure |
| `textContent` | `string \| null` | Yes | Clean extracted text content; `null` on failure. When `success === true`, guaranteed non-null and non-empty (≥ 1 char) |
| `extractionMethod` | `ExtractionMethod \| null` | Yes | Method used for extraction; `null` on failure |
| `truncated` | `boolean` | Yes | `true` if text was truncated at `MAX_CONTENT_CHARS`; always `false` on failure |
| `contentLength` | `number` | Yes | Character count of the final (post-truncation) `textContent`; `0` on failure |
| `elapsedMs` | `number` | Yes | Wall-clock elapsed time in milliseconds from scrape start to completion |
| `error` | `string \| null` | Yes | Human-readable error message; `null` on success; non-empty string on failure |

**Discriminated union shape:**

- Success: `{ success: true, url, finalUrl: string, title: string, textContent: string, extractionMethod: ExtractionMethod, truncated: boolean, contentLength: number, elapsedMs: number, error: null }`
- Failure: `{ success: false, url, finalUrl: string | null, title: null, textContent: null, extractionMethod: null, truncated: false, contentLength: 0, elapsedMs: number, error: string }`

### ExtractionMethod (defined in `shared/types/scrape.ts`)

A string literal union identifying how content was extracted:

| Value | Description |
|-------|-------------|
| `'readability'` | Primary path succeeded — jsdom + Readability extracted ≥ 200 chars |
| `'readability-failed'` | Intermediate flag — Readability yielded < 200 chars or threw; triggers Puppeteer fallback. Not a terminal value in successful results |
| `'puppeteer'` | Puppeteer headless browser rendered the page, then Readability extracted content |
| `'json'` | `Content-Type: application/json` — parsed and formatted to text |
| `'xml'` | `Content-Type: application/xml` / `text/xml` / `application/rss+xml` — tags stripped via cheerio |
| `'raw-text'` | `Content-Type: text/plain` / `text/markdown` — returned as-is after encoding decode |

### ScrapeOptions (defined in `scrape-extract/types.ts`)

Optional per-call overrides passed to `scrape()`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `timeoutMs` | `number` | No | Override `SCRAPE_TIMEOUT_MS` for this call |
| `maxContentChars` | `number` | No | Override `MAX_CONTENT_CHARS` for this call |

### ScrapeConfig (defined in `scrape-extract/types.ts`)

Resolved configuration used internally by all SC components:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `timeoutMs` | `number` | Yes | Per-fetch timeout in ms (env `SCRAPE_TIMEOUT_MS`, default 15000) |
| `maxContentChars` | `number` | Yes | Maximum extracted text length in characters (env `MAX_CONTENT_CHARS`, default 8000). 0 or negative disables truncation |
| `maxRedirects` | `number` | Yes | Maximum HTTP redirect hops (constant: 5) |
| `minContentChars` | `number` | Yes | Threshold for Readability success — below this triggers Puppeteer fallback (constant: 200) |
| `maxTotalTimeoutMs` | `number` | Yes | Total scrape timeout including fallback (computed: `timeoutMs × 2`) |

### FetchResult (internal, `scrape-extract/types.ts`)

Raw HTTP response data returned by `http-fetcher`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `success` | `boolean` | Yes | `true` if a usable HTTP response was received (2xx status) |
| `statusCode` | `number` | Yes | HTTP status code (0 if no response received) |
| `statusText` | `string` | Yes | HTTP status text or error message |
| `contentType` | `string \| null` | Yes | Value of `Content-Type` response header; `null` if missing |
| `bodyBytes` | `Uint8Array \| null` | Yes | Raw response body bytes; `null` on fetch failure |
| `finalUrl` | `string \| null` | Yes | Final URL after redirect chain; `null` if no response |
| `redirectCount` | `number` | Yes | Number of redirects followed |
| `error` | `string \| null` | Yes | Error message if `success === false`; `null` otherwise |
| `retryAfterMs` | `number \| null` | Yes | Value parsed from `Retry-After` header (ms); `null` if absent |

### ExtractionOutput (internal, `scrape-extract/types.ts`)

Result of jsdom + Readability extraction:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | Yes | Extracted page title (may be empty string) |
| `textContent` | `string` | Yes | Extracted plain text |
| `extractionMethod` | `ExtractionMethod` | Yes | `'readability'` if ≥ 200 chars, `'readability-failed'` if < 200 chars |
| `charCount` | `number` | Yes | Character count of `textContent` |

### RenderResult (internal, `scrape-extract/types.ts`)

Result of Puppeteer headless rendering:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `success` | `boolean` | Yes | `true` if browser launched and page rendered successfully |
| `html` | `string \| null` | Yes | Rendered HTML source; `null` on failure |
| `error` | `string \| null` | Yes | Error message; `null` on success |

### ContentTypeResult (internal, `scrape-extract/types.ts`)

Result of content-type routing:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `'html' \| 'json' \| 'xml' \| 'text' \| 'binary' \| 'unsupported'` | Yes | Detected content category |
| `textContent` | `string \| null` | Yes | Extracted text for non-HTML types; `null` for HTML (requires further Readability extraction) |
| `extractionMethod` | `ExtractionMethod \| null` | Yes | Set for non-HTML types; `null` for HTML |
| `error` | `string \| null` | Yes | Error message for binary/unsupported types; `null` otherwise |

### ValidationResult (internal, `scrape-extract/types.ts`)

Result of URL validation:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `valid` | `boolean` | Yes | `true` if URL passes all checks |
| `error` | `string \| null` | Yes | Error message if `valid === false`; `null` otherwise |

### TruncationResult (internal, `scrape-extract/types.ts`)

Result of content truncation:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | `string` | Yes | Truncated or original text |
| `truncated` | `boolean` | Yes | `true` if text was shortened |

## API Endpoints

This module does not expose HTTP endpoints. Its public API is a single function consumed by the Pipeline Orchestration (PL) module.

### Public Function API

| Function | Signature | User Stories | Description |
|----------|-----------|--------------|-------------|
| `scrape` | `(url: string, options?: ScrapeOptions): Promise<ScrapeResult>` | US-SC-001 through US-SC-013 | Fetches a URL and extracts clean text content. Always resolves (never rejects for expected failures). Returns `ScrapeResult` with `success: true/false`. |

### `scrape()` Behavioral Contract

| Condition | User Story | Return |
|-----------|------------|--------|
| URL is empty or not a string | US-SC-013 | `ScrapeResult { success: false, error: "URL is required" }` |
| URL fails `new URL()` parse | US-SC-013 | `ScrapeResult { success: false, error: "Invalid URL: {input}" }` |
| URL scheme is not `http:` or `https:` | US-SC-013 | `ScrapeResult { success: false, error: "Only HTTP(S) URLs are supported" }` |
| URL hostname resolves to private/loopback IP | US-SC-013 | `ScrapeResult { success: false, error: "URL resolves to a private or loopback address; blocked for security" }` |
| HTTP fetch times out (`SCRAPE_TIMEOUT_MS`) | US-SC-006 | `ScrapeResult { success: false, error: "Fetch timed out after {N}ms" }` |
| Redirect chain exceeds 5 hops | US-SC-003 | `ScrapeResult { success: false, error: "Redirect loop or too many redirects" }` |
| HTTP 404 | US-SC-005 | `ScrapeResult { success: false, error: "HTTP 404: Page not found ({url})" }` |
| HTTP 401/403 | US-SC-005 | `ScrapeResult { success: false, error: "HTTP {status}: Page requires authentication or blocks bots ({url})" }` |
| HTTP 429 (after retry exhausted) | US-SC-005 | `ScrapeResult { success: false, error: "HTTP 429: Too Many Requests ({url})" }` |
| HTTP 5xx (after retry exhausted) | US-SC-005 | `ScrapeResult { success: false, error: "HTTP {status}: {statusText} ({url})" }` |
| Transient network error (after retries) | US-SC-010 | `ScrapeResult { success: false, error: "{errorCode}: {errorMessage}" }` |
| Binary content type (PDF, image, etc.) | US-SC-009 | `ScrapeResult { success: false, error: "Unsupported content type: {contentType}" }` |
| HTML with Readability success (≥ 200 chars) | US-SC-002 | `ScrapeResult { success: true, extractionMethod: 'readability', textContent: <text>, ... }` |
| HTML with Readability failure → Puppeteer success | US-SC-004 | `ScrapeResult { success: true, extractionMethod: 'puppeteer', textContent: <text>, ... }` |
| JSON content | US-SC-009 | `ScrapeResult { success: true, extractionMethod: 'json', textContent: <formatted>, ... }` |
| XML content | US-SC-009 | `ScrapeResult { success: true, extractionMethod: 'xml', textContent: <stripped>, ... }` |
| Plain text / Markdown | US-SC-009 | `ScrapeResult { success: true, extractionMethod: 'raw-text', textContent: <body>, ... }` |

## Error Handling

### Error Return Strategy

The SC module **never rejects** the `Promise<ScrapeResult>` for expected failures. All anticipated error conditions (HTTP errors, timeouts, network failures, parse failures, binary content, SSRF violations) are converted into `ScrapeResult` objects with `success: false` and a descriptive `error` string. Only truly unexpected internal errors (e.g., a bug causing `TypeError`) may propagate as thrown exceptions — the PL module catches these per the cross-module error propagation rules.

### Error Message Construction

| Scenario | Error Message Format | Example |
|----------|---------------------|---------|
| Empty/null URL | `"URL is required"` | `"URL is required"` |
| Malformed URL | `"Invalid URL: {input}"` | `"Invalid URL: not a url"` |
| Non-HTTP scheme | `"Only HTTP(S) URLs are supported"` | `"Only HTTP(S) URLs are supported"` |
| SSRF blocked | `"URL resolves to a private or loopback address; blocked for security"` | — |
| Timeout | `"Fetch timed out after {N}ms"` | `"Fetch timed out after 15000ms"` |
| Too many redirects | `"Redirect loop or too many redirects"` | — |
| HTTP 404 | `"HTTP 404: Page not found ({finalUrl})"` | `"HTTP 404: Page not found (https://example.com/missing)"` |
| HTTP 401/403 | `"HTTP {status}: Page requires authentication or blocks bots ({finalUrl})"` | `"HTTP 403: Page requires authentication or blocks bots (https://example.com)"` |
| HTTP 429 | `"HTTP 429: Too Many Requests ({finalUrl})"` | — |
| HTTP 5xx | `"HTTP {status}: {statusText} ({finalUrl})"` | `"HTTP 503: Service Unavailable (https://example.com)"` |
| Network error | `"{errorCode}: {errorMessage}"` | `"ECONNRESET: socket hang up"` |
| Binary content | `"Unsupported content type: {contentType}"` | `"Unsupported content type: application/pdf"` |
| Puppeteer launch failure | `"Puppeteer rendering failed: {errorMessage}"` | `"Puppeteer rendering failed: No browser found"` |
| Total content empty (all paths) | `"Failed to extract meaningful content from {url}"` | — |

### Logging (stderr only)

Per US-SC-011 and NFR-SC-006, all log output goes to `process.stderr` exclusively:

| Event | Log Format |
|-------|-----------|
| Scrape start | `[scrape] START {url}` |
| Scrape success | `[scrape] OK {url} method={method} chars={N} truncated={true\|false} ms={elapsed}` |
| Scrape failure | `[scrape] FAIL {url} error={message} ms={elapsed}` |
| Puppeteer fallback triggered | `[scrape] FALLBACK {url} → puppeteer` |
| Non-UTF-8 charset detected | `[scrape] ENCODING {url} charset={charset}` |
| Timeout | `[scrape] timeout: {url} after {N}ms` |
| Retry succeeded | `[scrape] retry succeeded for {url} on attempt {N}` |
| Possible encoding mismatch | `[scrape] possible encoding mismatch for {url}` |

## Component Interfaces

### `url-validator.ts` — URL format + SSRF validation

```typescript
/**
 * Validates a URL for scraping: checks that it is a non-empty string,
 * parses via the WHATWG URL constructor, requires http/https scheme,
 * and blocks hostnames resolving to private/loopback/link-local IPs.
 *
 * Uses shared/utils/url-utils for SSRF IP range checks.
 *
 * @returns ValidationResult with valid=true or a descriptive error
 */
function validateScrapeUrl(url: string): ValidationResult;
```

**Maps to:** US-SC-013, NFR-SC-003

### `http-fetcher.ts` — Native fetch with redirect following, timeout, retry

```typescript
/**
 * Fetches a URL using Node.js native fetch with manual redirect control.
 * Follows 301/302/307/308 redirects (max MAX_REDIRECTS=5), validates
 * each redirect target for SSRF, enforces timeout via AbortController,
 * and retries transient errors with exponential backoff.
 *
 * @returns FetchResult with raw body bytes and metadata
 */
async function httpFetch(url: string, config: ScrapeConfig): Promise<FetchResult>;

/**
 * Internal: single fetch attempt with manual redirect following.
 */
async function fetchWithRedirects(
  url: string,
  config: ScrapeConfig
): Promise<FetchResult>;

/**
 * Internal: determines if a network error code is retryable
 * (ECONNRESET, ETIMEDOUT, ECONNREFUSED, EAI_AGAIN).
 */
function isTransientError(error: NodeJS.ErrnoException): boolean;

/**
 * Internal: computes exponential backoff delay for retry attempt N.
 * Attempt 1: 1000ms, Attempt 2: 3000ms.
 */
function computeBackoffDelay(attempt: number): number;
```

**Maps to:** US-SC-001, US-SC-003, US-SC-005, US-SC-006, US-SC-010

### `encoding-detector.ts` — Charset detection + iconv-lite conversion

```typescript
/**
 * Detects the character encoding of a response body by checking:
 * (1) Content-Type header charset parameter, (2) HTML <meta charset> tag,
 * (3) HTML <meta http-equiv> charset, (4) defaults to 'utf-8'.
 *
 * @param contentType - Raw Content-Type header value or null
 * @param bodyBytes - First 1024+ bytes of the response body for meta-tag inspection
 * @returns Lowercased charset identifier (e.g., 'utf-8', 'gbk', 'shift_jis')
 */
function detectCharset(contentType: string | null, bodyBytes: Uint8Array): string;

/**
 * Decodes raw bytes to a UTF-8 string using the detected charset.
 * Uses iconv-lite for non-UTF-8 encodings.
 *
 * @param bodyBytes - Full response body bytes
 * @param charset - Detected charset identifier
 * @returns Decoded UTF-8 string
 */
function decodeBody(bodyBytes: Uint8Array, charset: string): string;

/**
 * Checks if a decoded string has an excessive number of replacement
 * characters (U+FFFD), indicating a possible encoding mismatch.
 *
 * @param text - Decoded text
 * @returns true if replacement chars exceed 5% of total characters
 */
function hasExcessiveReplacementChars(text: string): boolean;
```

**Maps to:** US-SC-007

### `content-type-router.ts` — Route by Content-Type

```typescript
/**
 * Routes a decoded response body to the appropriate extraction path
 * based on Content-Type header. When Content-Type is missing, sniffs
 * the first 512 bytes to determine type.
 *
 * For HTML: returns { kind: 'html', textContent: null } — caller must
 *   run content-extractor.
 * For JSON: parses and formats to indented text.
 * For XML: strips tags via cheerio.
 * For text/markdown: returns body as-is.
 * For binary: returns error.
 *
 * @param contentType - Raw Content-Type header or null
 * @param bodyText - Decoded response body string
 * @param url - Source URL (for error messages)
 * @param config - Scrape config (for maxContentChars)
 * @returns ContentTypeResult indicating extraction path or error
 */
async function routeContentType(
  contentType: string | null,
  bodyText: string,
  url: string,
  config: ScrapeConfig
): Promise<ContentTypeResult>;

/**
 * Internal: sniffs the first 512 bytes of bodyText to determine type
 * when Content-Type header is missing.
 *
 * Checks for: <html, <!doctype, <body → HTML; { or [ → JSON;
 * <?xml → XML; otherwise → plain text.
 */
function sniffContentType(bodyText: string): 'html' | 'json' | 'xml' | 'text';

/**
 * Internal: formats a JSON string to readable indented text.
 */
function formatJsonToText(jsonText: string, maxChars: number): string;
```

**Maps to:** US-SC-009

### `content-extractor.ts` — jsdom + Readability extraction pipeline

```typescript
/**
 * Extracts main-content text from an HTML string using jsdom to construct
 * a DOM document compatible with @mozilla/readability, then running
 * Readability.parse().
 *
 * Returns extractionMethod 'readability' if textContent length >= 200,
 * 'readability-failed' if < 200 chars or Readability throws.
 *
 * @param html - Raw HTML string
 * @param url - Base URL for the document (used for relative link resolution)
 * @returns ExtractionOutput with title, textContent, method, charCount
 */
async function extractContent(html: string, url: string): Promise<ExtractionOutput>;

/**
 * Internal: constructs a jsdom JSDOM instance from HTML with proper URL.
 * Must set `url` option and `contentType: "text/html"` for Readability
 * compatibility.
 */
function constructDocument(html: string, url: string): JSDOM;

/**
 * Internal: wraps Readability.parse() in try/catch to prevent throws
 * from propagating. Returns null on error.
 */
function safeReadabilityParse(document: Document): ReadabilityParseResult | null;
```

**Maps to:** US-SC-002

### `puppeteer-renderer.ts` — Headless-browser fallback for JS pages

```typescript
/**
 * Launches a Puppeteer headless browser, navigates to the URL, waits for
 * networkidle0 or a max of 10 seconds (whichever comes first), then
 * extracts the rendered HTML.
 *
 * Uses launch args: --no-sandbox, --disable-gpu, --disable-dev-shm-usage.
 * Captures page console/error events to stderr only.
 * Always closes the browser and page in a finally block.
 *
 * @param url - URL to render
 * @param config - Scrape config (for timeout enforcement)
 * @returns RenderResult with rendered HTML or error
 */
async function renderWithPuppeteer(
  url: string,
  config: ScrapeConfig
): Promise<RenderResult>;

/**
 * Internal: launches a Puppeteer browser with the required args.
 * Returns null if Puppeteer fails to launch (logs warning to stderr).
 */
async function launchBrowser(): Promise<Browser | null>;
```

**Maps to:** US-SC-004, NFR-SC-002, NFR-SC-006

### `truncator.ts` — Word-boundary truncation at MAX_CONTENT_CHARS

```typescript
/**
 * Truncates text to maxChars at the nearest word boundary at or before
 * the limit. Appends "…[truncated]" marker if truncated.
 *
 * If maxChars is 0 or negative, returns the original text with
 * truncated: false (no truncation mode) and logs a warning.
 *
 * Preserves content from the beginning (title + first paragraphs).
 *
 * @param text - Input text
 * @param maxChars - Maximum character count
 * @returns TruncationResult { text, truncated }
 */
function truncate(text: string, maxChars: number): TruncationResult;
```

**Maps to:** US-SC-008

### `scraper.ts` — Main scrape orchestrator

```typescript
/**
 * Main entry point — orchestrates the full scrape flow:
 * 1. Validate URL (US-SC-013)
 * 2. HTTP fetch with redirects, retries, timeout (US-SC-001/003/005/006/010)
 * 3. Encoding detection and decode (US-SC-007)
 * 4. Content-type routing (US-SC-009)
 * 5. Content extraction: Readability primary → Puppeteer fallback (US-SC-002/004)
 * 6. Truncation (US-SC-008)
 * 7. Build ScrapeResult
 *
 * Never throws for expected failures. Returns ScrapeResult with
 * success: false and descriptive error on any anticipated failure.
 *
 * @param url - URL to scrape
 * @param options - Optional per-call overrides
 * @returns Promise<ScrapeResult>
 */
async function scrape(url: string, options?: ScrapeOptions): Promise<ScrapeResult>;

/**
 * Internal: constructs a success ScrapeResult from extraction output.
 */
function buildSuccessResult(
  url: string,
  finalUrl: string,
  extraction: ExtractionOutput,
  truncated: boolean,
  contentLength: number,
  elapsedMs: number
): ScrapeResult;

/**
 * Internal: constructs a failure ScrapeResult.
 */
function buildErrorResult(
  url: string,
  finalUrl: string | null,
  error: string,
  elapsedMs: number
): ScrapeResult;

/**
 * Internal: resolves ScrapeConfig from shared appConfig + optional overrides.
 */
function resolveConfig(options?: ScrapeOptions): ScrapeConfig;
```

**Maps to:** US-SC-001 through US-SC-013

### `index.ts` — Public exports barrel

```typescript
export { scrape } from './scraper.js';
export type { ScrapeOptions, ScrapeConfig } from './types.js';
// ScrapeResult and ExtractionMethod are re-exported from shared/types
```

## Dependencies

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `cheerio` | ^1.0.0 | HTML parsing and DOM manipulation for XML tag stripping and content-type sniffing |
| `jsdom` | ^24.0.0 | DOM construction for `@mozilla/readability` compatibility — Readability requires a browser-like DOM |
| `@mozilla/readability` | ^0.5.0 | Main-content extraction from HTML — strips navigation, ads, sidebars, and boilerplate |
| `puppeteer` | ^22.6.0 | Headless-browser fallback for JavaScript-rendered SPA pages (Vue, React, Angular doc sites) |
| `iconv-lite` | ^0.6.3 | Character-encoding detection and conversion for non-UTF-8 content (GBK, Shift-JIS, Big5, Latin-1, etc.) |

### Internal Module Dependencies (shared)

| Import Source | Usage |
|---------------|-------|
| `shared/types/scrape.ts` | `ScrapeResult`, `ExtractionMethod` type definitions |
| `shared/utils/logger.ts` | `log.info()`, `log.warn()`, `log.error()` — stderr-only structured logging |
| `shared/utils/env.ts` | `envInt()`, `envString()` — environment variable parsing with defaults |
| `shared/utils/errors.ts` | `AppError` base class for internal typed errors (not propagated to caller) |
| `shared/utils/url-utils.ts` | `isPrivateIP()`, `validateHttpUrl()` — SSRF protection and URL validation helpers |
| `shared/config/index.ts` | `appConfig` singleton — reads `SCRAPE_TIMEOUT_MS` and `MAX_CONTENT_CHARS` from env |

### Development Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@types/jsdom` | ^21.1.0 | TypeScript type definitions for jsdom |
| `typescript` | ^5.4.0 | TypeScript compiler — `tsc --noEmit` strict mode type-checking |
| `tsx` | ^4.7.0 | TypeScript execution for development and testing |
| `@types/node` | ^18.19.0 | Node.js type definitions (includes `fetch`, `AbortController`, `Headers` types) |

### Notes on Dependency Compatibility

- **cheerio** and **iconv-lite** are CommonJS packages — imported via ESM interop using default import (`import * as cheerio from 'cheerio'`) or namespace import as needed, per index.md ESM interop allowance.
- **puppeteer** 22.x ships with its own TypeScript types — no separate `@types/puppeteer` needed.
- **@mozilla/readability** 0.5.x does not ship bundled types — a local ambient module declaration (`declare module '@mozilla/readability'`) will be added in the types file to provide type safety.
- No HTTP client library (`axios`, `got`) is used — native `fetch` (Node.js 18+) handles all HTTP, per project constraints.

## File Generation Order

Files are listed in dependency order — each file depends only on files listed before it and on shared/external modules.

| # | File Path | Description | Depends On |
|---|-----------|-------------|------------|
| 1 | `src/modules/scrape-extract/types.ts` | `ScrapeOptions`, `ScrapeConfig`, internal interfaces (`FetchResult`, `ExtractionOutput`, `RenderResult`, `ContentTypeResult`, `ValidationResult`, `TruncationResult`), and constants (`MAX_REDIRECTS`, `READABILITY_MIN_CHARS`, `TRANSIENT_ERROR_CODES`, `RETRY_BACKOFF_MS`, `RETRY_AFTER_DEFAULT_MS`) | `shared/types/scrape.ts` |
| 2 | `src/modules/scrape-extract/url-validator.ts` | URL validation: format check, scheme check, SSRF private-IP check via shared `url-utils` | `shared/utils/url-utils.ts`, `./types.ts` |
| 3 | `src/modules/scrape-extract/encoding-detector.ts` | Charset detection (Content-Type header → HTML meta tag → default UTF-8) and body decoding via `iconv-lite`; replacement-character detection | `iconv-lite`, `./types.ts` |
| 4 | `src/modules/scrape-extract/truncator.ts` | Word-boundary truncation at `MAX_CONTENT_CHARS` with `…[truncated]` marker; handles 0/negative as no-truncation mode | `./types.ts` |
| 5 | `src/modules/scrape-extract/content-type-router.ts` | Content-Type header dispatch: HTML (signals further extraction), JSON (parse + format), XML (cheerio strip), text (raw), binary (error); content-type sniffing when header missing | `cheerio`, `./types.ts`, `./truncator.ts` |
| 6 | `src/modules/scrape-extract/content-extractor.ts` | jsdom DOM construction + `@mozilla/readability` extraction; returns `ExtractionOutput` with title, textContent, charCount, method flag | `jsdom`, `@mozilla/readability`, `./types.ts` |
| 7 | `src/modules/scrape-extract/puppeteer-renderer.ts` | Puppeteer headless-browser launch, page navigation with `networkidle0` wait (max 10s), rendered HTML extraction; browser lifecycle management; stderr-only console capture | `puppeteer`, `shared/utils/logger.ts`, `./types.ts` |
| 8 | `src/modules/scrape-extract/http-fetcher.ts` | Native `fetch` with manual redirect following (max 5 hops + SSRF per hop), `AbortController` timeout, transient-error retry with exponential backoff (1s/3s), 5xx retry, 429 `Retry-After` handling | `shared/utils/url-utils.ts`, `shared/utils/logger.ts`, `./types.ts`, `./url-validator.ts` |
| 9 | `src/modules/scrape-extract/scraper.ts` | Main orchestrator: validate → fetch → decode → route → extract (primary → Puppeteer fallback) → truncate → build `ScrapeResult`. Implements per-page and total timeouts, error isolation, and structured stderr logging | `shared/config/index.ts`, `shared/utils/logger.ts`, `./types.ts`, `./url-validator.ts`, `./http-fetcher.ts`, `./encoding-detector.ts`, `./content-type-router.ts`, `./content-extractor.ts`, `./puppeteer-renderer.ts`, `./truncator.ts` |
| 10 | `src/modules/scrape-extract/index.ts` | Public exports barrel: `scrape()`, `ScrapeOptions`, `ScrapeConfig`; re-exports `ScrapeResult`, `ExtractionMethod` from shared types | `./scraper.ts`, `./types.ts`, `shared/types/scrape.ts` |

### Test Files (mirror `src/` structure under `tests/`)

| # | File Path | Description |
|---|-----------|-------------|
| 11 | `tests/modules/scrape-extract/url-validator.test.ts` | URL validation: valid URLs, invalid schemes, private IPs, malformed strings |
| 12 | `tests/modules/scrape-extract/encoding-detector.test.ts` | Charset detection from headers, meta tags, defaults; GBK/Shift-JIS decode; replacement char detection |
| 13 | `tests/modules/scrape-extract/truncator.test.ts` | Word-boundary truncation, no-truncation mode, marker appending |
| 14 | `tests/modules/scrape-extract/content-type-router.test.ts` | Routing for HTML/JSON/XML/text/binary; missing Content-Type sniffing |
| 15 | `tests/modules/scrape-extract/content-extractor.test.ts` | Readability extraction from sample HTML; short content flagging; error handling |
| 16 | `tests/modules/scrape-extract/http-fetcher.test.ts` | Redirect following, timeout via AbortController, transient retry logic, 429 Retry-After, SSRF on redirects |
| 17 | `tests/modules/scrape-extract/scraper.test.ts` | End-to-end scrape orchestration: primary success, Puppeteer fallback trigger, all error paths, timeout, ScrapeResult structure |
