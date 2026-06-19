# Requirements: Scrape and Extract

## Overview

The Scrape and Extract (SC) module converts a given URL into clean, readable text content suitable for downstream LLM synthesis. It uses a lightweight primary path (Node.js HTTP fetch → cheerio parse → Mozilla Readability extraction) and automatically falls back to Puppeteer headless-browser rendering for JavaScript-heavy SPA pages when the primary path yields insufficient content. The module handles HTTP errors, character-encoding detection, content truncation, non-HTML resources, timeouts, and retries, and returns a uniform structured result to the pipeline orchestrator.

---

## User Stories

### US-SC-001: Fetch URL via Lightweight HTTP Client
**As a** pipeline orchestrator, **I want** to fetch a URL using a lightweight Node.js HTTP client as the primary fetch method, **so that** static HTML pages are retrieved quickly without the overhead of launching a browser.

**Acceptance Criteria:**
- WHEN a URL is passed to `scrape(url: string): Promise<ScrapeResult>` THEN the system SHALL issue an HTTP/HTTPS GET request using Node.js native `fetch` (or equivalent lightweight client) as the first attempt
- WHEN the response is received THEN the system SHALL check the `Content-Type` header and proceed to HTML extraction (US-SC-002) if the type is `text/html` or `application/xhtml+xml`
- WHEN the HTTP client receives a compressed response (`Content-Encoding: gzip/br/deflate`) THEN the system SHALL decompress it transparently before further processing
- WHEN the fetch succeeds THEN the system SHALL store the raw HTML body, final resolved URL (after redirects), and HTTP status code for downstream extraction steps

---

### US-SC-002: Extract Clean Text via Cheerio and Readability
**As a** pipeline orchestrator, **I want** to parse fetched HTML with cheerio and extract the main article content using `@mozilla/readability`, **so that** I receive clean readable text stripped of navigation, advertisements, sidebars, and boilerplate.

**Acceptance Criteria:**
- WHEN raw HTML is available from the primary fetch THEN the system SHALL load it into a cheerio instance, set base URI, and construct a DOM document compatible with `@mozilla/readability`
- WHEN readability extraction completes THEN the system SHALL return an object containing `title`, `textContent` (plain text), and `length` (character count)
- WHEN readability returns a non-empty `textContent` with length ≥ 200 characters THEN the system SHALL treat the primary path as successful and NOT invoke Puppeteer fallback
- WHEN readability throws an error or returns `textContent` with length < 200 characters THEN the system SHALL flag the result as `extractionMethod: 'readability-failed'` and trigger the Puppeteer fallback path (US-SC-004)
- WHEN readability succeeds THEN the system SHALL set `extractionMethod: 'readability'` in the result object

---

### US-SC-003: Follow HTTP Redirects Automatically
**As a** pipeline orchestrator, **I want** the scraper to follow HTTP 3xx redirects automatically, **so that** the final destination content is fetched even when the original URL has moved.

**Acceptance Criteria:**
- WHEN the HTTP response status is 301, 302, 307, or 308 THEN the system SHALL follow the `Location` header to the redirect target
- WHEN following redirects THEN the system SHALL enforce a maximum of 5 redirect hops to prevent redirect loops
- WHEN the redirect chain exceeds 5 hops THEN the system SHALL abort the fetch and return an error result with message `"Redirect loop or too many redirects"`
- WHEN the final URL after redirects differs from the input URL THEN the system SHALL update the `url` field in the result to the final resolved URL

---

### US-SC-004: Render and Extract JS-Rendered Pages via Puppeteer Fallback
**As a** pipeline orchestrator, **I want** to render pages with Puppeteer's headless browser when the primary path fails or yields insufficient content, **so that** JavaScript-rendered SPA pages (e.g., Vue/React doc sites) are captured.

**Acceptance Criteria:**
- WHEN the primary readability path fails or yields < 200 characters THEN the system SHALL launch a Puppeteer headless browser instance and navigate to the same URL
- WHEN the Puppeteer page loads THEN the system SHALL wait for `networkidle0` or a maximum of 10 seconds (whichever comes first) before extracting the rendered HTML
- WHEN the rendered HTML is available THEN the system SHALL pass it through the same cheerio + readability extraction pipeline (US-SC-002)
- WHEN Puppeteer extraction succeeds THEN the system SHALL set `extractionMethod: 'puppeteer'` in the result object
- WHEN Puppeteer extraction also fails (error or < 200 chars) THEN the system SHALL fall through to US-SC-009 (non-HTML / raw fallback) or return an error result if no usable content is found
- WHEN Puppeteer is not installed or fails to launch THEN the system SHALL log a warning to stderr and return an error result rather than crashing the process

---

### US-SC-005: Handle HTTP Error Status Codes
**As a** pipeline orchestrator, **I want** the scraper to gracefully handle HTTP 4xx/5xx error responses, **so that** a single broken URL does not crash the pipeline and a meaningful error is returned to the caller.

**Acceptance Criteria:**
- WHEN the HTTP response status is 4xx (e.g., 403, 404) THEN the system SHALL NOT attempt readability extraction on the error body; instead it SHALL return a `ScrapeResult` with `error` set to a human-readable message including the status code and URL
- WHEN the HTTP response status is 401 or 403 THEN the system SHALL include the suggestion `"Page requires authentication or blocks bots"` in the error message
- WHEN the HTTP response status is 404 THEN the system SHALL include `"Page not found"` in the error message
- WHEN the HTTP response status is 5xx THEN the system SHALL attempt one retry (US-SC-011) before returning the error result
- WHEN the HTTP response status is 429 (Too Many Requests) THEN the system SHALL wait for the `Retry-After` header value (or a default 3-second backoff) and attempt one retry

---

### US-SC-006: Enforce Per-Page Fetch Timeout
**As a** pipeline orchestrator, **I want** each scrape operation to respect a configurable timeout, **so that** slow or unresponsive URLs do not indefinitely block the pipeline.

**Acceptance Criteria:**
- WHEN a scrape operation begins THEN the system SHALL start a timer with the value of `SCRAPE_TIMEOUT_MS` (default 15000 ms)
- WHEN the primary HTTP fetch exceeds `SCRAPE_TIMEOUT_MS` THEN the system SHALL abort the fetch and return an error result with message `"Fetch timed out after {N}ms"`
- WHEN Puppeteer fallback is invoked THEN the system SHALL apply a separate timeout of `SCRAPE_TIMEOUT_MS` for the Puppeteer render phase
- WHEN the total scrape operation (primary + fallback combined) exceeds `SCRAPE_TIMEOUT_MS × 2` THEN the system SHALL abort all remaining work and return the best partial result obtained so far or an error result
- WHEN a timeout occurs THEN the system SHALL log to stderr: `"scrape timeout: {url} after {N}ms"`

---

### US-SC-007: Detect and Decode Character Encoding
**As a** pipeline orchestrator, **I want** the scraper to correctly detect the character encoding of fetched pages, **so that** non-UTF-8 content (e.g., GB2312, GBK, Shift-JIS, Big5, Latin-1) is properly decoded to Unicode text.

**Acceptance Criteria:**
- WHEN the HTTP response includes a `charset` parameter in the `Content-Type` header THEN the system SHALL use that charset to decode the response body
- WHEN no charset is in the `Content-Type` header THEN the system SHALL inspect the HTML `<meta charset="...">` tag (or `<meta http-equiv="Content-Type" content="...; charset=...">`) to determine encoding
- WHEN neither HTTP header nor HTML meta tag specifies a charset THEN the system SHALL default to UTF-8 decoding
- WHEN the detected charset is not UTF-8 THEN the system SHALL use `iconv-lite` (or equivalent) to convert the byte stream to UTF-8 before passing to cheerio
- WHEN decoding produces replacement characters (U+FFFD) exceeding 5% of total characters THEN the system SHALL log a warning to stderr: `"possible encoding mismatch for {url}"`

---

### US-SC-008: Truncate Extracted Content to Configurable Maximum
**As a** pipeline orchestrator, **I want** extracted text to be truncated to a configurable character limit, **so that** overly long pages do not consume excessive downstream LLM tokens or pipeline memory.

**Acceptance Criteria:**
- WHEN extracted text exceeds `MAX_CONTENT_CHARS` (default 8000) THEN the system SHALL truncate at the nearest word boundary at or before `MAX_CONTENT_CHARS` characters and append the marker `"…[truncated]"`
- WHEN text is truncated THEN the system SHALL set `truncated: true` in the result object
- WHEN text is within the limit THEN the system SHALL set `truncated: false`
- WHEN the input URL is a known long-form content type (e.g., blog post, documentation) and `MAX_CONTENT_CHARS` is exceeded THEN the system SHALL preserve text from the beginning (title + first paragraphs) rather than from the middle
- WHEN `MAX_CONTENT_CHARS` is set to 0 or a negative value via environment variable THEN the system SHALL treat it as "no truncation" and log a warning

---

### US-SC-009: Handle Non-HTML Resources (JSON, XML, Plain Text)
**As a** pipeline orchestrator, **I want** the scraper to detect and handle non-HTML content types, **so that** API documentation returned as JSON, RSS/Atom feeds as XML, and plain-text files are extracted as usable text rather than being incorrectly parsed as HTML.

**Acceptance Criteria:**
- WHEN the `Content-Type` is `application/json` THEN the system SHALL parse the JSON and convert it to a formatted, indented text representation (up to `MAX_CONTENT_CHARS`), set `extractionMethod: 'json'`, and return it as `textContent`
- WHEN the `Content-Type` is `application/xml`, `text/xml`, or `application/rss+xml` THEN the system SHALL strip XML tags and extract text content using cheerio, set `extractionMethod: 'xml'`, and return it as `textContent`
- WHEN the `Content-Type` is `text/plain` or `text/markdown` THEN the system SHALL return the body as-is (after encoding decode and truncation), set `extractionMethod: 'raw-text'`
- WHEN the `Content-Type` is a binary type (e.g., `application/pdf`, `image/*`, `application/octet-stream`) THEN the system SHALL NOT attempt text extraction and return an error result with message `"Unsupported content type: {contentType}"`
- WHEN the `Content-Type` header is missing THEN the system SHALL sniff the first 512 bytes of the body to determine if it is HTML (presence of `<html`, `<!doctype`, or `<body`), JSON (starts with `{` or `[`), XML (starts with `<?xml`), or plain text, and route accordingly

---

### US-SC-010: Retry on Transient Fetch Failures
**As a** pipeline orchestrator, **I want** the scraper to retry on transient network errors with exponential backoff, **so that** temporary connectivity blips do not cause unnecessary scrape failures.

**Acceptance Criteria:**
- WHEN the primary fetch encounters a transient error (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`) THEN the system SHALL retry the fetch up to 2 times with exponential backoff (1s, 3s)
- WHEN the HTTP response is 429 THEN the system SHALL apply the retry logic defined in US-SC-005
- WHEN all retries are exhausted THEN the system SHALL return an error result with the last error message
- WHEN a retry succeeds THEN the system SHALL log to stderr: `"retry succeeded for {url} on attempt {N}"`
- WHEN the error is non-transient (e.g., DNS resolution failure `ENOTFOUND`) THEN the system SHALL NOT retry and immediately return the error result

---

### US-SC-011: Log Scrape Operations to Stderr
**As a** developer or operator, **I want** scrape operations to emit structured progress logs to stderr, **so that** I can monitor and debug the pipeline without interfering with the stdio JSON-RPC communication on stdout.

**Acceptance Criteria:**
- WHEN a scrape operation starts THEN the system SHALL log to stderr: `[scrape] START {url}`
- WHEN a scrape operation completes successfully THEN the system SHALL log to stderr: `[scrape] OK {url} method={readability|puppeteer|json|xml|raw-text} chars={N} truncated={true|false} ms={elapsed}`
- WHEN a scrape operation fails THEN the system SHALL log to stderr: `[scrape] FAIL {url} error={message} ms={elapsed}`
- WHEN Puppeteer fallback is triggered THEN the system SHALL log to stderr: `[scrape] FALLBACK {url} → puppeteer`
- WHEN encoding detection identifies a non-UTF-8 charset THEN the system SHALL log to stderr: `[scrape] ENCODING {url} charset={detected}`
- WHEN any log line is emitted THEN the system SHALL ensure it goes to `process.stderr` only, never to `process.stdout`

---

### US-SC-012: Return Structured Scrape Result
**As a** pipeline orchestrator, **I want** the scraper to return a consistent `ScrapeResult` object for every URL — whether successful or failed — **so that** downstream modules (deduplicate, synthesize) can process outputs uniformly without type-checking or exception handling.

**Acceptance Criteria:**
- WHEN the `scrape()` function is called THEN it SHALL always return a `Promise<ScrapeResult>` and SHALL NOT throw exceptions for expected failures (HTTP errors, timeouts, parse failures); unexpected internal errors may throw
- WHEN the scrape succeeds THEN `ScrapeResult` SHALL contain: `{ success: true, url: string, finalUrl: string, title: string, textContent: string, extractionMethod: string, truncated: boolean, contentLength: number, elapsedMs: number, error: null }`
- WHEN the scrape fails THEN `ScrapeResult` SHALL contain: `{ success: false, url: string, finalUrl: string|null, title: null, textContent: null, extractionMethod: null, truncated: false, contentLength: 0, elapsedMs: number, error: string }`
- WHEN `success` is `true` THEN `textContent` SHALL be non-null and non-empty (at least 1 character)
- WHEN `success` is `false` THEN `error` SHALL be a non-empty, human-readable string

---

### US-SC-013: Validate Input URL
**As a** pipeline orchestrator, **I want** the scraper to validate the input URL before attempting any network operation, **so that** malformed URLs are rejected early and clearly.

**Acceptance Criteria:**
- WHEN `scrape()` receives a value that is not a string or is an empty string THEN the system SHALL return a `ScrapeResult` with `success: false` and `error: "URL is required"`
- WHEN the URL does not parse via the `URL` constructor (invalid format) THEN the system SHALL return `success: false` with `error: "Invalid URL: {input}"`
- WHEN the URL scheme is not `http:` or `https:` (e.g., `file:`, `ftp:`, `data:`) THEN the system SHALL return `success: false` with `error: "Only HTTP(S) URLs are supported"`
- WHEN the URL hostname resolves to a private/loopback IP address (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, ::1) THEN the system SHALL return `success: false` with `error: "URL resolves to a private or loopback address; blocked for security"` (SSRF prevention)

---

## Business Goals

### BG-SC-001: High Primary-Path Extraction Success Rate
- Description: Maximize the percentage of URLs successfully extracted via the lightweight cheerio + readability path, avoiding Puppeteer overhead.
- Metric: Percentage of successful scrapes where `extractionMethod === 'readability'` out of all successful scrapes over a rolling sample.
- Target: ≥ 75% of successful extractions use the readability primary path

### BG-SC-002: Fast Primary-Path Latency
- Description: Ensure the primary HTTP + readability path completes quickly so the overall pipeline stays within end-to-end latency budget.
- Metric: Median elapsed time (`elapsedMs`) for successful readability-path scrapes.
- Target: < 3000 ms median per page (excluding Puppeteer fallback)

### BG-SC-003: Effective Fallback Coverage
- Description: Ensure the Puppeteer fallback meaningfully rescues pages that the primary path cannot handle.
- Metric: Percentage of Puppeteer-fallback attempts that yield ≥ 200 characters of extractable text.
- Target: ≥ 60% of Puppeteer fallback attempts succeed

### BG-SC-004: Overall Scrape Success Rate
- Description: Ensure the combined primary + fallback path successfully extracts content from a high proportion of candidate URLs.
- Metric: Percentage of `scrape()` calls returning `success: true` across all URLs attempted.
- Target: ≥ 85% success rate on URLs returned by SearXNG (realistic web pages)

---

## Non-Functional Requirements

### NFR-SC-001: Primary-Path Memory Efficiency
- Category: performance
- Description: The primary fetch + cheerio + readability path SHALL process pages without retaining the full raw HTML in memory after extraction is complete. Intermediate buffers SHALL be released (dereferenced) before returning the result.
- Priority: important

### NFR-SC-002: Puppeteer Browser Instance Lifecycle
- Category: performance
- Description: Puppeteer SHALL launch at most one browser instance per scrape invocation and SHALL close the browser (and all pages) after extraction to prevent zombie processes. The browser launch SHALL use `--no-sandbox` flag in container environments and disable unnecessary features (`--disable-gpu`, `--disable-dev-shm-usage`).
- Priority: critical

### NFR-SC-003: SSRF Protection
- Category: security
- Description: The scraper SHALL validate that resolved target URLs do not point to private IP ranges (RFC 1918), loopback addresses, link-local addresses, or metadata endpoints (169.254.169.254) before issuing HTTP requests. DNS resolution results SHALL be checked, not just hostname strings.
- Priority: critical

### NFR-SC-004: Error Isolation Guarantees
- Category: reliability
- Description: A failure in scraping any single URL SHALL NOT affect other concurrent or subsequent scrape operations. No shared mutable state SHALL exist between scrape calls. Uncaught errors within the Puppeteer path SHALL be caught and surfaced as `ScrapeResult.error`, never propagated as exceptions.
- Priority: critical

### NFR-SC-005: Configurable via Environment Variables
- Category: usability
- Description: The module SHALL read `SCRAPE_TIMEOUT_MS` (default 15000) and `MAX_CONTENT_CHARS` (default 8000) from environment variables at module initialization time. Changes to these variables SHALL take effect on the next process restart without code changes.
- Priority: important

### NFR-SC-006: Stdout Purity
- Category: reliability
- Description: The scraper SHALL NEVER write any data (logs, debug output, Puppeteer console messages) to `process.stdout`. All diagnostic output SHALL go to `process.stderr`. Puppeteer's page console events and error events SHALL be captured and routed to stderr if logged at all.
- Priority: critical

### NFR-SC-007: Encoding Library Bundle Size
- Category: performance
- Description: The character-encoding conversion dependency (e.g., `iconv-lite`) SHALL be tree-shakeable or support loading only the required encoding tables. The module SHALL NOT bundle unused encoding definitions to keep the deployed package size under 5 MB for the SC module's dependencies.
- Priority: nice-to-have

---

## Design Constraints

### DC-SC-001: TypeScript Strict Mode Compliance
- Description: All code in the SC module SHALL compile under TypeScript `strict: true` with `tsc --noEmit` producing zero errors. All function parameters, return types, and `ScrapeResult` fields SHALL be explicitly typed; no `any` types are permitted except in documented third-party adapter code.
- Severity: critical

### DC-SC-002: ESM Module Format
- Description: The module SHALL be written in ESM format (`import`/`export`) with `"type": "module"` in `package.json`. All imports of CommonJS dependencies (cheerio, readability, iconv-lite, puppeteer) SHALL use default-import or namespace-import patterns compatible with Node.js 18+ ESM interop.
- Severity: critical

### DC-SC-003: No Paid or API-Key-Required Dependencies for Fetching
- Description: The scraper SHALL NOT use any paid third-party scraping APIs (e.g., ScraperAPI, ScrapingBee, Tavily). The primary path SHALL use only Node.js built-in HTTP capabilities plus open-source npm packages. Puppeteer SHALL be an optional dependency that degrades gracefully if not installed.
- Severity: important

### DC-SC-004: Puppeteer as Optional Dependency
- Description: Puppeteer SHALL be declared as an `optionalDependencies` entry in `package.json`. The module SHALL dynamically import Puppeteer only when the fallback path is triggered (`await import('puppeteer')`). If the import fails, the module SHALL log a warning and return the best available primary-path result or an error result — it SHALL NOT crash.
- Severity: important

### DC-SC-005: Environment Variable Interface Boundary
- Description: The SC module SHALL NOT read environment variables directly in individual functions. Instead, it SHALL accept a configuration object (`ScrapeConfig`) at initialization with `timeoutMs` and `maxContentChars` fields. The PL orchestration layer (or module entry point) SHALL be responsible for reading env vars and passing the config. This enables unit testing without environment manipulation.
- Severity: important

### DC-SC-006: ScrapeResult Type as Public Contract
- Description: The `ScrapeResult` interface SHALL be exported from the module's public API and treated as a stable contract. Downstream modules (DD, SY, PL) SHALL depend on this type. Any breaking changes to `ScrapeResult` SHALL require a major version bump.
- Severity: important