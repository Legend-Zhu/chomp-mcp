# Requirements: Search Retrieval

## Overview
The Search Retrieval module is the data acquisition entry point for the web research pipeline. It queries SearXNG meta-search instances, parses and normalizes JSON responses into a unified candidate structure (`{title, url, snippet, score}`), and resiliently handles timeouts, retries, and instance failover. This module guarantees that downstream scraping and synthesis always receive a clean, scored, and de-duplicated list of candidate URLs regardless of which SearXNG backend was used.

## User Stories

### US-SR-001: Execute Search Query Against SearXNG
**As a** pipeline orchestrator, **I want** to submit a search query to a SearXNG instance and receive normalized results, **so that** the pipeline has candidate URLs to scrape and synthesize.

**Acceptance Criteria:**
- WHEN `search(query, options)` is called with a non-empty query string THEN the system SHALL send an HTTP GET request to the SearXNG `/search` endpoint with parameters `q={query}`, `format=json`, and `safesearch=1`
- WHEN the SearXNG instance responds with HTTP 200 and a body containing a `results` array THEN the system SHALL return a `Promise<SearchResult[]>` resolved with normalized result objects
- WHEN `options.maxResults` is provided as an integer THEN the system SHALL return at most that many results, sorted by descending score
- WHEN `options.maxResults` is omitted THEN the system SHALL default to returning at most 10 results
- WHEN `search()` is called with an empty, null, or whitespace-only query THEN the system SHALL reject with a `ValidationError` containing the message `"Query must be a non-empty string"`
- WHEN `search()` is called with a query exceeding 500 characters THEN the system SHALL reject with a `ValidationError` containing the message `"Query must not exceed 500 characters"`

### US-SR-002: Parse SearXNG JSON Response
**As a** pipeline orchestrator, **I want** the module to correctly parse the SearXNG JSON response schema, **so that** result fields are reliably extracted regardless of which underlying search engine produced them.

**Acceptance Criteria:**
- WHEN a SearXNG JSON response body is received THEN the system SHALL parse it as JSON and extract the top-level `results` array
- WHEN a result object in the array contains `title`, `url`, and `content` keys THEN the system SHALL extract all three fields for normalization
- WHEN a result object is missing the `url` field or `url` is not a valid URI THEN the system SHALL skip that entry, increment an internal `skippedMalformed` counter, and continue processing remaining entries
- WHEN the parsed JSON body does not contain a `results` key or `results` is not an array THEN the system SHALL treat the response as having zero results and return an empty `SearchResult[]`
- WHEN the JSON body cannot be parsed (invalid JSON syntax) THEN the system SHALL throw a `SearchParseError` with message `"Failed to parse SearXNG response as JSON"`

### US-SR-003: Normalize Results to Unified Candidate Structure
**As a** downstream pipeline consumer (scrape-extract module), **I want** search results in a consistent `{title, url, snippet, score}` structure, **so that** I can process every candidate uniformly without per-engine field mapping.

**Acceptance Criteria:**
- WHEN search results are parsed from SearXNG THEN the system SHALL produce objects conforming to the `SearchResult` interface: `{ title: string; url: string; snippet: string; score: number }`
- WHEN a result's `title` field is empty or missing THEN the system SHALL set `title` to `"(untitled)"`
- WHEN a result's `snippet` (SearXNG `content`) field is empty or missing THEN the system SHALL set `snippet` to an empty string `""`
- WHEN a result's `title` exceeds 500 characters THEN the system SHALL truncate it to 497 characters and append `"..."`
- WHEN a result's `snippet` exceeds 1000 characters THEN the system SHALL truncate it to 997 characters and append `"..."`
- WHEN SearXNG provides a numeric `score` field for results THEN the system SHALL normalize all scores to the range `[0.0, 1.0]` by dividing each score by the maximum score in the result set
- WHEN SearXNG does not provide a `score` field for any results THEN the system SHALL assign scores based on positional rank: `score = 1.0 - (index / totalResults)`, ensuring the first result receives the highest score
- WHEN the result set contains a single result THEN the system SHALL assign it a score of `1.0`

### US-SR-004: Enforce Configurable Request Timeout
**As a** pipeline orchestrator, **I want** search requests to respect a configurable timeout, **so that** an unresponsive SearXNG instance does not indefinitely block the pipeline.

**Acceptance Criteria:**
- WHEN a search HTTP request is initiated THEN the system SHALL enforce a timeout configurable via the `SEARXNG_TIMEOUT_MS` environment variable with a default of `10000` milliseconds
- WHEN the configured `SEARXNG_TIMEOUT_MS` value is not a positive integer THEN the system SHALL fall back to the default of `10000` ms and log a warning to stderr
- WHEN the timeout elapses before a complete response is received THEN the system SHALL abort the underlying HTTP request, log `"SearXNG request timed out after {N}ms"` to stderr, and throw a `SearchTimeoutError`
- WHEN a `SearchTimeoutError` is thrown THEN the system SHALL ensure no dangling TCP connections remain from the aborted request

### US-SR-005: Retry Failed Requests with Exponential Backoff
**As a** pipeline orchestrator, **I want** transient search failures to be retried automatically with backoff, **so that** momentary network instability or rate limiting does not cause an immediate hard failure.

**Acceptance Criteria:**
- WHEN a search request fails due to a network error, timeout (`SearchTimeoutError`), or HTTP 5xx status code THEN the system SHALL retry the request against the same instance
- WHEN `SEARXNG_MAX_RETRIES` environment variable is set THEN the system SHALL use that value as the maximum retry count; otherwise, the default SHALL be `2` retries (3 total attempts)
- WHEN retrying THEN the system SHALL wait using exponential backoff with a base delay configurable via `SEARXNG_RETRY_BASE_MS` (default `500` ms), computing delay as `base * 2^(attemptIndex)` with jitter of ±20%
- WHEN an HTTP 429 (Too Many Requests) response is received and the response includes a `Retry-After` header THEN the system SHALL honor that header value (capped at 10 seconds) instead of the computed backoff delay
- WHEN all retry attempts against the current instance are exhausted without success THEN the system SHALL proceed to failover logic (US-SR-006) or throw a `SearchFailedError` if no failover candidates remain
- WHEN a retry succeeds THEN the system SHALL log `"Search succeeded on attempt {N} after retry"` to stderr

### US-SR-006: Failover to Alternate SearXNG Instances
**As a** pipeline orchestrator, **I want** the module to automatically try alternate SearXNG instances when the primary instance fails, **so that** search availability is maximized without manual intervention.

**Acceptance Criteria:**
- WHEN the `SEARXNG_URL` environment variable is set THEN the system SHALL use it as the sole SearXNG endpoint and SHALL NOT attempt failover to any other instance; if it fails after all retries, the system SHALL throw a `SearchFailedError`
- WHEN `SEARXNG_URL` is not set THEN the system SHALL maintain a built-in ordered list of at least 3 public SearXNG instance URLs as failover candidates
- WHEN all retries against the current instance are exhausted and additional failover candidates exist THEN the system SHALL advance to the next candidate in the list and reset the retry counter for that instance
- WHEN a failover instance returns a successful response THEN the system SHALL log `"Failover succeeded using instance: {url}"` to stderr and SHALL promote that instance to the front of the candidate list for subsequent searches
- WHEN all instances in the failover list have been exhausted without success THEN the system SHALL throw a `SearchUnavailableError` with message `"All SearXNG instances unavailable. Set SEARXNG_URL to a self-hosted instance for improved reliability."`
- WHEN the failover candidate list is rotated or reordered THEN the system SHALL log the new ordering to stderr at debug level

### US-SR-007: Configure SearXNG Instance via Environment Variable
**As a** system administrator, **I want** to specify which SearXNG instance to use through an environment variable, **so that** I can point the module to a self-hosted instance for improved reliability, privacy, and rate-limit control.

**Acceptance Criteria:**
- WHEN the module initializes THEN the system SHALL read `SEARXNG_URL` from the process environment
- WHEN `SEARXNG_URL` is present and is a valid `http://` or `https://` URL THEN the system SHALL configure it as the sole search endpoint and disable public-instance failover
- WHEN `SEARXNG_URL` is present but is not a valid URL (missing protocol, malformed syntax) THEN the system SHALL throw a `ConfigurationError` with message `"SEARXNG_URL must be a valid HTTP(S) URL"`
- WHEN `SEARXNG_URL` is absent THEN the system SHALL enter public-instance mode using the built-in candidate list and SHALL log `"SearXNG mode: public instances with failover"` to stderr
- WHEN the module initializes successfully THEN the system SHALL log `"SearXNG endpoint configured: {url}, mode: {self-hosted|public}"` to stderr

### US-SR-008: Handle Empty Search Results Gracefully
**As a** pipeline orchestrator, **I want** queries that return zero results to be handled without errors, **so that** the pipeline can produce a meaningful "no results found" digest rather than crashing.

**Acceptance Criteria:**
- WHEN SearXNG returns a valid JSON response with an empty `results` array THEN the system SHALL resolve the search promise with an empty `SearchResult[]` (length 0)
- WHEN zero results are returned from a successful response THEN the system SHALL log `"SearXNG returned 0 results for query: {query}"` to stderr
- WHEN zero results are returned THEN the system SHALL NOT throw an error, trigger a retry, or initiate failover (an empty result set is a valid response)
- WHEN the pipeline receives an empty result array from this module THEN the downstream behavior (producing a "no results" digest) SHALL be the responsibility of the orchestration layer, not this module

### US-SR-009: Detect and Handle Non-JSON Responses
**As a** pipeline orchestrator, **I want** the module to detect when SearXNG returns an HTML or unexpected content type instead of JSON, **so that** the failure is diagnosed accurately rather than producing a cryptic parse error.

**Acceptance Criteria:**
- WHEN the SearXNG HTTP response has a `Content-Type` header that does not include `application/json` THEN the system SHALL read the response body and check if it starts with `{` or `[` to detect JSON regardless of header
- WHEN the response body cannot be parsed as valid JSON THEN the system SHALL throw a `SearchParseError` with message `"SearXNG returned non-JSON response (Content-Type: {type}). Ensure the instance supports format=json."`
- WHEN a `SearchParseError` is thrown for a response that appears to be HTML THEN the system SHALL include the first 200 characters of the body in the error message for diagnostic purposes
- WHEN `SearchParseError` occurs THEN the system SHALL treat it as a retryable error for the purposes of retry and failover logic

### US-SR-010: Remove Exact Duplicate URLs Within a Single Response
**As a** pipeline orchestrator, **I want** exact duplicate URLs within a single SearXNG response removed, **so that** the candidate list sent downstream is not polluted by SearXNG's multi-engine aggregation redundancy.

**Acceptance Criteria:**
- WHEN the parsed results contain two or more entries with exactly identical URL strings (case-sensitive) THEN the system SHALL retain only the entry with the highest score and discard the rest
- WHEN duplicate removal occurs THEN the system SHALL log `"Removed {N} exact-duplicate URLs from SearXNG response"` to stderr
- WHEN two entries have URLs that differ only in URL fragment (e.g., `page.html#section1` vs `page.html#section2`) THEN the system SHALL treat them as duplicates and retain only the higher-scored entry (this is lightweight intra-response dedup; comprehensive URL normalization is the responsibility of the deduplicate module)
- WHEN no duplicates are found THEN the system SHALL pass the full result set through unchanged

### US-SR-011: Log Search Activity for Observability
**As a** system operator, **I want** the module to emit structured log entries for key search events to stderr, **so that** I can monitor search behavior, diagnose failures, and track performance without interfering with stdio JSON-RPC communication.

**Acceptance Criteria:**
- WHEN a search request is initiated THEN the system SHALL log `"SEARCH START | query: {query} | instance: {url} | attempt: {N}"` to stderr
- WHEN a search request completes successfully THEN the system SHALL log `"SEARCH OK | results: {count} | duration_ms: {elapsed} | instance: {url}"` to stderr
- WHEN a search request fails and will be retried THEN the system SHALL log `"SEARCH RETRY | reason: {errorType} | nextAttemptIn: {delayMs}ms"` to stderr
- WHEN all search attempts fail THEN the system SHALL log `"SEARCH FAILED | query: {query} | errors: {errorSummary}"` to stderr
- WHEN any log entry is written THEN the system SHALL write exclusively to stderr and SHALL NEVER write log content to stdout (stdout is reserved for MCP JSON-RPC protocol)

### US-SR-012: Expose Typed SearchResult Interface and Search Function
**As a** pipeline orchestrator developer, **I want** a well-typed `search()` function and `SearchResult` interface exported from this module, **so that** I can integrate search retrieval with compile-time type safety.

**Acceptance Criteria:**
- WHEN the module is imported THEN the system SHALL export a `search` function with signature `search(query: string, options?: SearchOptions): Promise<SearchResult[]>`
- WHEN the module is imported THEN the system SHALL export the `SearchResult` interface: `{ title: string; url: string; snippet: string; score: number }`
- WHEN the module is imported THEN the system SHALL export the `SearchOptions` interface: `{ maxResults?: number; timeoutMs?: number; categories?: string }`
- WHEN the module is imported THEN the system SHALL export custom error classes: `SearchError` (base), `SearchTimeoutError`, `SearchParseError`, `SearchFailedError`, `SearchUnavailableError`, `ConfigurationError`, and `ValidationError`
- WHEN TypeScript is compiled in strict mode (`tsc --noEmit`) THEN the module SHALL produce zero type errors

## Business Goals

### BG-SR-001: High Search Availability
- Description: Ensure that search queries succeed reliably even when individual public SearXNG instances are down or rate-limited, by leveraging retry and multi-instance failover.
- Metric: Percentage of unique queries that return at least one result (or a definitive empty-result signal) without throwing `SearchUnavailableError`, measured over a rolling 7-day window.
- Target: ≥ 95% success rate in public-instance mode; ≥ 99% success rate in self-hosted mode

### BG-SR-002: Low Search Latency
- Description: Minimize the time from `search()` invocation to result return, so the overall pipeline can meet its 30-second end-to-end target.
- Metric: 95th percentile wall-clock time from `search()` call to promise resolution, measured per query including retries but excluding failover that succeeds on the first alternate instance.
- Target: p95 ≤ 5 seconds in self-hosted mode; p95 ≤ 8 seconds in public-instance mode

### BG-SR-003: Zero-Cost Zero-API-Key Operation
- Description: Ensure the search module requires no paid third-party API keys and incurs no monetary cost per query, making the MCP server accessible to all users.
- Metric: Count of paid API dependencies and required API keys for this module.
- Target: 0 paid dependencies, 0 required API keys

## Non-Functional Requirements

### NFR-SR-001: Search Response Time Bound
- Category: performance
- Description: The module SHALL complete a single search query (including all retries and failover attempts) within a hard ceiling of 30 seconds. If this ceiling is reached, the system SHALL abort all pending requests and throw `SearchFailedError`.
- Priority: critical

### NFR-SR-002: No Credential or API Key Leakage
- Category: security
- Description: The module SHALL NOT transmit, log, or expose any API keys, tokens, or credentials in request parameters, response bodies, log messages, or error objects. The module SHALL NOT require any API key for SearXNG access.
- Priority: critical

### NFR-SR-003: Memory Efficiency Under Large Result Sets
- Category: performance
- Description: The module SHALL not retain more than the `maxResults` normalized SearchResult objects in memory at any time. Raw SearXNG response bodies SHALL be released for garbage collection immediately after parsing. Peak memory usage for a single search call SHALL not exceed 5 MB for a response of up to 100 raw results.
- Priority: important

### NFR-SR-004: Graceful Degradation Under Partial Failure
- Category: reliability
- Description: The failure of one SearXNG instance SHALL NOT prevent the module from attempting other instances. A single malformed result entry in a SearXNG response SHALL NOT cause the entire response parse to fail; malformed entries SHALL be skipped with a counter increment.
- Priority: critical

### NFR-SR-005: Stdout Protocol Integrity
- Category: reliability
- Description: The module SHALL NEVER write any content (logs, debug output, error messages, raw HTML) to stdout. All diagnostic output SHALL be directed exclusively to stderr. stdout is reserved for MCP JSON-RPC protocol messages.
- Priority: critical

### NFR-SR-006: Configurable Timeout and Retry Parameters
- Category: usability
- Description: The module SHALL expose all operational parameters (timeout, max retries, retry base delay, instance URL) via environment variables with sensible defaults, requiring zero configuration for first-time use with public instances.
- Priority: important

## Design Constraints

### DC-SR-001: No Paid Third-Party API Dependencies
- Description: The module SHALL only interact with SearXNG instances (public or self-hosted). No paid search APIs (Tavily, SerpAPI, Google CSE, Bing Web Search API) SHALL be used. No API keys SHALL be required for search functionality.
- Severity: critical

### DC-SR-002: TypeScript Strict Mode Compatibility
- Description: All module source code SHALL compile under TypeScript strict mode (`"strict": true`) with `tsc --noEmit` producing zero errors. All function parameters, return types, and exported interfaces SHALL have explicit type annotations.
- Severity: critical

### DC-SR-003: ESM Module Format
- Description: The module SHALL be authored and distributed as ECMAScript Modules (ESM) using `import`/`export` syntax. CommonJS (`require`) SHALL NOT be used. The `package.json` SHALL include `"type": "module"`.
- Severity: critical

### DC-SR-004: Node.js 18+ Runtime
- Description: The module SHALL use only APIs available in Node.js 18 LTS or later. The module MAY use global `fetch` (available natively in Node 18+). No polyfills or additional HTTP client libraries (e.g., `axios`, `got`) SHALL be required for SearXNG communication.
- Severity: important

### DC-SR-005: Environment-Variable-Only Configuration
- Description: All module configuration SHALL be provided exclusively through environment variables (`SEARXNG_URL`, `SEARXNG_TIMEOUT_MS`, `SEARXNG_MAX_RETRIES`, `SEARXNG_RETRY_BASE_MS`). No configuration files, CLI flags, or constructor parameters SHALL be required for initial setup.
- Severity: important

### DC-SR-006: SearXNG `/search` API Compatibility
- Description: The module SHALL construct requests compatible with the SearXNG `/search` endpoint, sending `format=json` as a mandatory query parameter. The module SHALL NOT depend on SearXNG-specific features beyond the standard JSON search response schema (the `results` array with `title`, `url`, `content`, and `score` fields).
- Severity: critical

### DC-SR-007: No Persistent State or Database
- Description: The module SHALL be stateless between search calls. Instance failover ordering adjustments (promoting a successful instance) SHALL be stored only in process-memory volatile state and SHALL NOT be persisted to disk or any database. A process restart SHALL reset the failover candidate list to its built-in default ordering.
- Severity: important