# Requirements: Pipeline Orchestration

## Overview
The Pipeline Orchestration module coordinates the end-to-end execution of the research pipeline — Search→Scrape→Deduplicate→Synthesize for `web_search` and Scrape→Synthesize for `web_fetch`. It enforces concurrency limits on parallel scraping, manages overall and per-stage timeouts, and isolates individual URL failures so that a single broken page never crashes the entire pipeline. This module serves as the integration layer between the MCP Server entry point (MC) and the four processing modules (SR, SC, DD, SY).

## User Stories

### US-PL-001: Execute web_search Full Pipeline
**As a** caller of the MCP server, **I want** the orchestration layer to execute the complete Search→Scrape→Deduplicate→Synthesize pipeline for a given query, **so that** I receive a structured digest without managing individual stages.

**Acceptance Criteria:**
- WHEN `executeWebSearch(query, maxResults, focus)` is invoked THEN the system SHALL sequentially call SR.search(query, maxResults), then SC.scrape() for each result URL concurrently, then DD.deduplicate() on the scraped contents, then SY.synthesize() on the deduplicated set
- WHEN the pipeline completes successfully THEN the system SHALL return the structured digest (Answer / Key Points / Sources) produced by SY
- WHEN any stage produces zero usable output but subsequent stages can still proceed with partial data THEN the system SHALL continue the pipeline with available data rather than aborting

### US-PL-002: Execute web_fetch Sub-flow Pipeline
**As a** caller of the MCP server, **I want** the orchestration layer to execute the Scrape→Synthesize sub-flow for a single known URL, **so that** I receive a structured digest of that specific page.

**Acceptance Criteria:**
- WHEN `executeWebFetch(url, focus)` is invoked THEN the system SHALL call SC.scrape(url) to retrieve page content, then SY.synthesize() on the scraped content with the provided focus
- WHEN the scrape succeeds and synthesis succeeds THEN the system SHALL return the structured digest produced by SY
- WHEN the scrape succeeds but the page content is empty or below a minimum meaningful length THEN the system SHALL skip synthesis and return an informative message indicating no meaningful content was extracted

### US-PL-003: Enforce Concurrency Limits During Parallel Scraping
**As a** system operator, **I want** the orchestration layer to limit the number of concurrent HTTP scraping operations, **so that** system resources are protected and downstream services are not overwhelmed.

**Acceptance Criteria:**
- WHEN the web_search pipeline enters the scrape stage with N candidate URLs THEN the system SHALL dispatch scrape operations concurrently up to a maximum of `MAX_CONCURRENCY` (default 3) simultaneous in-flight requests
- WHEN a scrape operation completes or fails THEN the system SHALL immediately dispatch the next queued URL if any remain
- WHEN `MAX_CONCURRENCY` environment variable is set to an invalid value (non-integer, zero, or negative) THEN the system SHALL fall back to the default value of 3 and log a warning to stderr

### US-PL-004: Enforce Overall Pipeline Timeout for web_search
**As a** system operator, **I want** the orchestration layer to enforce an overall timeout on the full web_search pipeline, **so that** the system does not hang indefinitely and returns a result within a predictable timeframe.

**Acceptance Criteria:**
- WHEN the web_search pipeline is initiated THEN the system SHALL start an overall timeout timer configured via `PIPELINE_TIMEOUT_MS` (default 30000ms)
- WHEN the overall timeout elapses before the pipeline completes THEN the system SHALL cancel all in-flight operations and return the best partial result available (e.g., scraped content concatenated if synthesis has not completed, or a timeout error message if no content was scraped)
- WHEN the pipeline completes before the overall timeout THEN the system SHALL cancel the timeout timer and release associated resources

### US-PL-005: Enforce Overall Pipeline Timeout for web_fetch
**As a** system operator, **I want** the orchestration layer to enforce an overall timeout on the web_fetch sub-flow, **so that** individual page fetches do not hang indefinitely.

**Acceptance Criteria:**
- WHEN the web_fetch pipeline is initiated THEN the system SHALL start an overall timeout timer configured via `PIPELINE_TIMEOUT_MS` (default 30000ms)
- WHEN the overall timeout elapses during scraping THEN the system SHALL cancel the in-flight scrape and return a timeout error message with the URL
- WHEN the overall timeout elapses during synthesis (scrape completed) THEN the system SHALL return the truncated scraped content as a graceful-degradation fallback instead of an error

### US-PL-006: Isolate Individual URL Failures During web_search Scraping
**As a** pipeline consumer, **I want** a single URL scrape failure (404, 403, timeout, network error) to be isolated, **so that** other URLs in the batch are still processed and the pipeline continues.

**Acceptance Criteria:**
- WHEN a single URL scrape operation fails with an HTTP error, timeout, or network error THEN the system SHALL catch that error, log the failure details (URL + error reason) to stderr, and exclude that URL from downstream stages
- WHEN one or more URLs fail but at least one URL scrapes successfully THEN the system SHALL proceed to the deduplicate stage with only the successfully scraped results
- WHEN a scrape operation throws an uncaught exception (not a standard HTTP/timeout/network error) THEN the system SHALL catch it, log the exception to stderr, treat the URL as failed, and continue processing remaining URLs

### US-PL-007: Isolate URL Failure During web_fetch Scraping
**As a** pipeline consumer, **I want** clear and actionable error messaging when the target URL in a web_fetch call fails, **so that** I can take corrective action.

**Acceptance Criteria:**
- WHEN the target URL scrape fails with an HTTP 4xx/5xx error THEN the system SHALL return an error message that includes the HTTP status code, the URL, and a suggested action (e.g., "The page returned 404 — verify the URL is correct")
- WHEN the target URL scrape fails with a timeout THEN the system SHALL return an error message that includes the URL, the timeout value that was exceeded, and the suggestion to check connectivity or increase `SCRAPE_TIMEOUT_MS`
- WHEN the target URL is not reachable due to a DNS or connection error THEN the system SHALL return an error message indicating the URL could not be reached and suggest verifying network connectivity

### US-PL-008: Degrade Gracefully When Synthesis Fails in web_search
**As a** pipeline consumer, **I want** the pipeline to return a structured concatenation of scraped content when the LLM synthesis stage fails, **so that** I still receive useful information even when the LLM is unavailable.

**Acceptance Criteria:**
- WHEN the SY.synthesize() call fails, times out, or returns an invalid response during the web_search pipeline THEN the system SHALL construct a fallback response by concatenating the titles, URLs, and truncated content (respecting `MAX_CONTENT_CHARS` per page) of all deduplicated results
- WHEN the fallback response is constructed THEN the system SHALL prepend a notice indicating that LLM synthesis was unavailable and the content below is raw concatenated excerpts
- WHEN the fallback response is constructed THEN the system SHALL include the Sources section with all contributing URLs so the caller can trace origins

### US-PL-009: Degrade Gracefully When Synthesis Fails in web_fetch
**As a** pipeline consumer, **I want** the web_fetch sub-flow to return truncated page content when synthesis fails, **so that** I still receive the extracted information from the page.

**Acceptance Criteria:**
- WHEN the SY.synthesize() call fails during the web_fetch pipeline THEN the system SHALL return the truncated scraped content (respecting `MAX_CONTENT_CHARS`) with a prepended notice that LLM synthesis was unavailable
- WHEN the scraped content is empty and synthesis also fails THEN the system SHALL return an error message indicating both content extraction and synthesis failed for the given URL

### US-PL-010: Handle Search Stage Failure in web_search Pipeline
**As a** pipeline consumer, **I want** the pipeline to return a clear error when the search stage (SearXNG) fails entirely, **so that** I understand the failure is at the search layer and can take action.

**Acceptance Criteria:**
- WHEN the SR.search() call fails (SearXNG unreachable, timeout after retries, or returns zero results) THEN the system SHALL abort the pipeline before entering the scrape stage and return an error message
- WHEN the error message is constructed for a search failure THEN it SHALL include the reason (unreachable, timeout, empty results), the SearXNG URL used, and the suggestion to verify `SEARXNG_URL` or deploy a self-hosted instance
- WHEN SR.search() returns results but all results have invalid or empty URLs THEN the system SHALL treat this as a search failure and return an error message indicating no usable search results were found

### US-PL-011: Handle Zero Usable Results After Scraping and Deduplication
**As a** pipeline consumer, **I want** the pipeline to return a meaningful message when all scraped results are filtered out by deduplication or all scrapes fail, **so that** I am not left with an empty or confusing response.

**Acceptance Criteria:**
- WHEN all candidate URLs fail to scrape and zero pages have content THEN the system SHALL skip the deduplicate and synthesize stages and return an error message listing the failed URLs and their failure reasons
- WHEN scraping succeeds for some URLs but the DD.deduplicate() stage filters out all results (all content is near-duplicate) THEN the system SHALL return a message indicating that all results were duplicates of each other and include the count of original results vs. remaining results
- WHEN at least one result survives deduplication THEN the system SHALL always proceed to the synthesize stage regardless of how few results remain

### US-PL-012: Track and Log Pipeline Execution State
**As a** system developer, **I want** the orchestration layer to emit structured progress logs to stderr at each pipeline stage transition, **so that** I can diagnose performance issues and failures without interfering with stdio JSON-RPC communication.

**Acceptance Criteria:**
- WHEN the web_search pipeline starts THEN the system SHALL log to stderr: the query string, max_results value, and focus (if provided)
- WHEN each pipeline stage completes THEN the system SHALL log to stderr: the stage name (search/scrape/deduplicate/synthesize), the item count entering and exiting the stage, and the elapsed time in milliseconds
- WHEN a URL scrape fails THEN the system SHALL log to stderr: the failed URL, the error category (http_error/timeout/network/parse_error), and the error message
- WHEN the pipeline completes or aborts THEN the system SHALL log to stderr: the final outcome (success/partial/degraded/failed), total elapsed time, and the count of results at each stage

### US-PL-013: Apply Pipeline Configuration from Environment Variables
**As a** system operator, **I want** the orchestration layer to read and apply pipeline-wide configuration from environment variables, **so that** I can tune behavior without code changes.

**Acceptance Criteria:**
- WHEN the orchestration layer initializes THEN it SHALL read `MAX_CONCURRENCY` (default 3), `SCRAPE_TIMEOUT_MS` (default 15000), `MAX_CONTENT_CHARS` (default 8000), and `PIPELINE_TIMEOUT_MS` (default 30000) from environment variables
- WHEN an environment variable is not set THEN the system SHALL use the documented default value
- WHEN an environment variable is set to an invalid value THEN the system SHALL log a warning to stderr identifying the variable, the invalid value, and the default being used instead

### US-PL-014: Coordinate web_search Stage Handoff Between Modules
**As a** system developer, **I want** the orchestration layer to manage data handoff between pipeline stages with consistent data structures, **so that** each downstream module receives exactly the input format it expects.

**Acceptance Criteria:**
- WHEN the search stage returns results THEN the system SHALL pass an array of `{title, url, snippet, score}` objects to the scrape stage
- WHEN the scrape stage completes for a URL THEN the system SHALL attach the scraped content to the corresponding result object as `{title, url, snippet, score, content}` and pass only successfully scraped items to the deduplicate stage
- WHEN the deduplicate stage completes THEN the system SHALL pass the filtered array of result objects (with content) to the synthesize stage along with the original query and focus parameter

### US-PL-015: Cancel In-Flight Operations on Pipeline Abort
**As a** system developer, **I want** the orchestration layer to properly cancel all in-flight scrape operations when the pipeline is aborted due to timeout or fatal error, **so that** no dangling HTTP connections or Puppeteer browser instances leak resources.

**Acceptance Criteria:**
- WHEN the pipeline is aborted due to overall timeout THEN the system SHALL signal all in-flight scrape operations (both HTTP-based and Puppeteer-based) to abort and clean up their underlying connections
- WHEN a Puppeteer-based scrape is in progress during an abort THEN the system SHALL close the browser page and any associated browser instance
- WHEN all in-flight operations have been cancelled or completed THEN the system SHALL release the concurrency semaphore and allow the pipeline to return its result or error

## Business Goals

### BG-PL-001: Pipeline Reliability Under Partial Failures
- Description: The web_search pipeline should complete successfully (returning at least partial useful content) even when individual URLs fail, rather than aborting entirely.
- Metric: Percentage of web_search invocations that return a non-empty, structured response (success or degraded) divided by total invocations where at least one search result was returned.
- Target: ≥ 95% of invocations with ≥1 search result return a usable response

### BG-PL-002: End-to-End Latency for web_search
- Description: The full web_search pipeline (search + scrape + deduplicate + synthesize) should complete within a predictable timeframe for a typical query.
- Metric: 95th percentile wall-clock time from pipeline invocation to response, measured with max_results=5.
- Target: < 30 seconds at p95

### BG-PL-003: Resource Efficiency Under Concurrency
- Description: The pipeline should respect concurrency limits and not exceed system resource boundaries during parallel scraping.
- Metric: Peak number of concurrent HTTP connections and Puppeteer browser instances during a single web_search invocation with max_results=8.
- Target: Concurrent connections never exceed `MAX_CONCURRENCY` value; zero Puppeteer instances leaked after pipeline completion

## Non-Functional Requirements

### NFR-PL-001: End-to-End Pipeline Latency
- Category: performance
- Description: The web_search pipeline with max_results=5 SHALL complete end-to-end (search→scrape→deduplicate→synthesize) within 30 seconds at the 95th percentile under normal network conditions.
- Priority: critical

### NFR-PL-002: web_fetch Sub-flow Latency
- Category: performance
- Description: The web_fetch sub-flow (scrape→synthesize) for a single URL SHALL complete within 20 seconds at the 95th percentile under normal network conditions.
- Priority: critical

### NFR-PL-003: Concurrency Guarantee
- Category: reliability
- Description: The orchestration layer SHALL guarantee that the number of simultaneously in-flight scrape operations never exceeds the configured `MAX_CONCURRENCY` value at any point during execution, enforced via a semaphore or equivalent mechanism.
- Priority: critical

### NFR-PL-004: Error Isolation Completeness
- Category: reliability
- Description: A failure in any single URL scrape (including uncaught exceptions) SHALL NOT propagate to other URLs or cause the pipeline to crash. The orchestration layer SHALL catch all errors from SC, SR, DD, and SY modules and handle them within the pipeline.
- Priority: critical

### NFR-PL-005: Resource Cleanup on Abort
- Category: reliability
- Description: When the pipeline is aborted (timeout, fatal error, or cancellation), all in-flight HTTP requests SHALL be aborted, all Puppeteer browser pages/instances SHALL be closed, and all internal timers SHALL be cleared within 2 seconds of the abort signal.
- Priority: critical

### NFR-PL-006: Pipeline Observability
- Category: usability
- Description: The orchestration layer SHALL emit structured log lines to stderr (not stdout) at every stage boundary, including stage name, item counts, elapsed time, and any per-URL failures, without impacting JSON-RPC communication over stdio.
- Priority: important

### NFR-PL-007: Memory Efficiency Under Large Result Sets
- Category: performance
- Description: The orchestration layer SHALL stream scraped content through deduplication and synthesis without holding all raw HTML pages in memory simultaneously. Intermediate raw HTML from SC SHALL be released after content extraction is complete.
- Priority: important

### NFR-PL-008: Graceful Deggradation Availability
- Category: reliability
- Description: When the SY.synthesize() stage fails for any reason (API error, timeout, rate limit, invalid response), the pipeline SHALL always return a fallback response containing concatenated excerpts from scraped content rather than returning an empty response or crashing.
- Priority: critical

## Design Constraints

### DC-PL-001: TypeScript Strict Mode Compliance
- Description: The orchestration layer SHALL be written in TypeScript with strict mode enabled and SHALL compile with zero errors under `tsc --noEmit`. All inter-module data handoff structures (search results, scraped content, deduplicated items) SHALL be defined as typed interfaces.
- Severity: critical

### DC-PL-002: Zero-Configuration Defaults
- Description: The orchestration layer SHALL operate with zero explicit configuration by relying on documented default values for all environment variables (`MAX_CONCURRENCY=3`, `SCRAPE_TIMEOUT_MS=15000`, `MAX_CONTENT_CHARS=8000`, `PIPELINE_TIMEOUT_MS=30000`). All overrides SHALL be optional via environment variables only — no config files.
- Severity: critical

### DC-PL-003: Module Dependency Boundary
- Description: The orchestration layer SHALL depend only on the four processing modules (SR, SC, DD, SY) and shared type definitions. It SHALL NOT directly perform HTTP requests, HTML parsing, LLM calls, or deduplication logic — all such operations SHALL be delegated to their respective modules. This ensures testability and single-responsibility.
- Severity: critical

### DC-PL-004: Synchronous Stage Ordering with Asynchronous Internals
- Description: The pipeline stages (Search→Scrape→Deduplicate→Synthesize) SHALL execute in strict sequential order — no stage SHALL begin before the previous stage completes. Within the scrape stage, individual URL scrapes SHALL execute concurrently up to the concurrency limit. The orchestration layer SHALL use async/await or Promises for all asynchronous coordination.
- Severity: important

### DC-PL-005: No State Persistence Between Invocations
- Description: The orchestration layer SHALL be stateless across pipeline invocations. Each `executeWebSearch` or `executeWebFetch` call SHALL operate independently with no shared mutable state, caching, or session continuity between calls. This ensures predictable behavior under concurrent MCP tool invocations.
- Severity: important