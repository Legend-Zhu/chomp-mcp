# Design: Pipeline Orchestration

## Overview

The Pipeline Orchestration (PL) module is the sole integration layer between the MCP Server entry point (MC) and the four processing modules (SR, SC, DD, SY). It coordinates two end-to-end flows:

- **web_search pipeline**: SR.search → SC.scrape (concurrent, capped at `MAX_CONCURRENCY`) → DD.deduplicate → SY.synthesize → formatted digest string
- **web_fetch pipeline**: SC.scrape → SY.synthesizeSingle → formatted digest string

The module is responsible for concurrency limiting during parallel scraping, overall pipeline timeout enforcement via `AbortController`, per-URL failure isolation, graceful degradation at every stage, structured progress logging to stderr, and rendering the final `DigestResult` into a text digest string that MC wraps in the MCP content array. The module performs **no I/O itself** — all HTTP, HTML parsing, LLM calls, and deduplication logic are delegated to SR, SC, DD, and SY. It is stateless across invocations, holding no shared mutable state between `runWebSearch` and `runWebFetch` calls.

## Architecture

PL sits between MC and the processing modules in the compile-time dependency graph:

```
src/index.ts
  └→ modules/mcp-server
       └→ modules/pipeline-orchestration  ← THIS MODULE
            ├→ modules/search-retrieval   (search)
            ├→ modules/scrape-extract     (scrape)
            ├→ modules/deduplicate         (deduplicate)
            └→ modules/synthesize          (synthesize, synthesizeSingle)
            All → shared/types, shared/utils, shared/config
```

**Dependency Injection Boundary**: MC receives `runWebSearch` and `runWebFetch` via factory parameters (`createServer({ runWebSearch, runWebFetch })`), not via direct import of PL. PL is constructed and injected at `src/index.ts`. This enables MC unit testing with mock orchestration functions.

**Data Flow — web_search**:
1. MC calls `runWebSearch({ query, maxResults?, focus? })`
2. PL reads `PipelineConfig` from `appConfig` (shared/config singleton)
3. PL creates an `AbortController`-based timeout guard for `PIPELINE_TIMEOUT_MS`
4. PL calls `search(query, { maxResults })` from SR → `SearchResult[]`
5. PL enriches each `SearchResult` into a scrape task, dispatches concurrently via the concurrency limiter (passing the abort `signal` to each `scrape` call)
6. PL filters successful scrapes, constructs `ContentItem[]` (mapping `ScrapeResult` fields + `SearchResult` metadata)
7. PL calls `deduplicate(contentItems)` from DD → filtered `ContentItem[]`
8. PL calls `synthesize(query, deduplicatedItems, focus)` from SY → `DigestResult`
9. PL formats `DigestResult` into a text string and returns it to MC

**Data Flow — web_fetch**:
1. MC calls `runWebFetch({ url, focus? })`
2. PL creates timeout guard
3. PL calls `scrape(url)` from SC → `ScrapeResult`
4. If scrape fails: PL returns a structured error message (thrown as `PipelineError` for MC to format as `isError: true`)
5. If scrape succeeds: PL calls `synthesizeSingle(url, title, content, focus)` from SY → `DigestResult`
6. PL formats `DigestResult` into text and returns

**Timeout and Abort Propagation**: PL creates an `AbortController` per invocation. The `signal` is passed to `scrape()` calls (via `ScrapeOptions.signal`) so in-flight HTTP/Puppeteer operations can be cancelled. PL checks `signal.aborted` at each stage boundary; if aborted mid-pipeline, it returns the best available partial result (US-PL-004/005).

**Error Handling Boundary**: PL is the only module that decides between returning a degraded string result (success from MC's perspective) or throwing a `PipelineError` (formatted as `isError: true` by MC). Hard failures — search stage failure (US-PL-010), all scrapes failing (US-PL-011), web_fetch target URL failure (US-PL-007) — are thrown. Synthesis failures always trigger graceful degradation returning a string (US-PL-008/009).

## Data Models

All shared types are defined in `src/shared/types/` and imported by PL. PL defines its own parameter types and error classes.

### WebSearchParams *(defined in PL)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | `string` | Yes | Non-empty search query string |
| `maxResults` | `number` | No | Maximum results from search (default: `5`) |
| `focus` | `string` | No | Optional focus directive for synthesis emphasis |

### WebFetchParams *(defined in PL)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | Target URL to fetch and synthesize |
| `focus` | `string` | No | Optional focus directive for synthesis emphasis |

### PipelineConfig *(imported from shared/types/pipeline.ts)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `maxConcurrency` | `number` | Yes | Max concurrent scrape operations (env: `MAX_CONCURRENCY`, default `3`) |
| `scrapeTimeoutMs` | `number` | Yes | Per-page scrape timeout (env: `SCRAPE_TIMEOUT_MS`, default `15000`) |
| `maxContentChars` | `number` | Yes | Max chars of content per page (env: `MAX_CONTENT_CHARS`, default `8000`) |
| `pipelineTimeoutMs` | `number` | Yes | Overall pipeline timeout (env: `PIPELINE_TIMEOUT_MS`, default `30000`) |

### StageLog *(imported from shared/types/pipeline.ts)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `stageName` | `string` | Yes | Name of the pipeline stage (`search`, `scrape`, `deduplicate`, `synthesize`) |
| `inputCount` | `number` | Yes | Number of items entering the stage |
| `outputCount` | `number` | Yes | Number of items exiting the stage |
| `elapsedMs` | `number` | Yes | Wall-clock time spent in the stage |
| `errors` | `string[]` | No | Per-item error messages logged during the stage |

### PipelineResult *(imported from shared/types/pipeline.ts)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `digest` | `string` | Yes | Formatted digest text returned to MC |
| `outcome` | `PipelineOutcome` | Yes | Final outcome: `Success`, `Partial`, `Degraded`, `Failed` |
| `totalElapsedMs` | `number` | Yes | Total wall-clock time of the pipeline |
| `stageLogs` | `StageLog[]` | Yes | Per-stage execution logs |
| `failedUrls` | `FailedUrl[]` | No | URLs that failed scraping with reasons |

### PipelineOutcome *(imported from shared/types/pipeline.ts)*

PascalCase enum with members: `Success`, `Partial`, `Degraded`, `Failed`.

### FailedUrl *(imported from shared/types/pipeline.ts)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | URL that failed |
| `reason` | `string` | Yes | Human-readable failure reason |

### SearchResult *(imported from shared/types/search.ts)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | Yes | Result title |
| `url` | `string` | Yes | Result URL |
| `snippet` | `string` | Yes | Result snippet/description |
| `score` | `number` | Yes | Normalized relevance score `[0.0, 1.0]` |

### ScrapeResult *(imported from shared/types/scrape.ts)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `success` | `boolean` | Yes | Whether extraction succeeded |
| `url` | `string` | Yes | Original input URL |
| `finalUrl` | `string \| null` | Yes | Final URL after redirects |
| `title` | `string \| null` | Yes | Extracted page title |
| `textContent` | `string \| null` | Yes | Extracted clean text |
| `extractionMethod` | `string \| null` | Yes | Method used: `readability`, `puppeteer`, `json`, `xml`, `raw-text` |
| `truncated` | `boolean` | Yes | Whether content was truncated |
| `contentLength` | `number` | Yes | Character count of extracted text |
| `elapsedMs` | `number` | Yes | Scrape wall-clock time |
| `error` | `string \| null` | Yes | Error message if `success` is false |

### ContentItem *(imported from shared/types/content.ts)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | Yes | Page title (from scrape or search result) |
| `url` | `string` | Yes | Page URL |
| `snippet` | `string` | Yes | Search snippet from SR |
| `score` | `number` | Yes | Relevance score from SR |
| `content` | `string` | Yes | Extracted text content from SC |

### DigestResult *(imported from shared/types/digest.ts)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `answer` | `string` | Yes | Synthesized answer text |
| `keyPoints` | `string[]` | Yes | Array of key point strings |
| `sources` | `SourceRef[]` | Yes | Array of source references |

### SourceRef *(imported from shared/types/digest.ts)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | Source URL |
| `title` | `string` | Yes | Source title |

### PipelineError *(defined in PL, extends shared AppError)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Always `"PipelineError"` |
| `message` | `string` | Yes | Human-readable error message |
| `category` | `ErrorCategory` | Yes | Inherited from `AppError` — one of `http_error`, `timeout`, `network`, `parse_error`, `validation`, `config` |
| `failedUrls` | `FailedUrl[]` | No | URLs that failed (for diagnostic context) |

### PipelineTimeoutError *(defined in PL, extends PipelineError)*

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Always `"PipelineTimeoutError"` |
| `message` | `string` | Yes | Timeout error message |
| `category` | `ErrorCategory` | Yes | Always `timeout` |
| `timeoutMs` | `number` | Yes | The timeout value that was exceeded |

## API Endpoints

PL does not expose HTTP endpoints. It exposes two functions consumed by MC via dependency injection.

### Public Functions

| Function | Parameters | Return | User Stories |
|----------|-----------|--------|--------------|
| `runWebSearch` | `params: WebSearchParams` | `Promise<string>` | US-PL-001, US-PL-003, US-PL-004, US-PL-006, US-PL-008, US-PL-010, US-PL-011, US-PL-012, US-PL-013, US-PL-014, US-PL-015 |
| `runWebFetch` | `params: WebFetchParams` | `Promise<string>` | US-PL-002, US-PL-005, US-PL-007, US-PL-009, US-PL-012, US-PL-013, US-PL-015 |

**Return contract**: Both functions return `Promise<string>` on success, partial success, or degraded fallback. They **throw** `PipelineError` (or `PipelineTimeoutError`) for hard failures that MC should present as `isError: true`:

| Scenario | Return / Throw | US |
|----------|---------------|-----|
| Full pipeline success | Resolves with formatted digest string | US-PL-001 |
| Partial results (some URLs failed) | Resolves with formatted digest string | US-PL-006 |
| Synthesis failure, content available | Resolves with degraded digest string (raw excerpts + notice) | US-PL-008/009 |
| Pipeline timeout, partial content available | Resolves with degraded digest string | US-PL-004/005 |
| Search stage failure | Throws `PipelineError` | US-PL-010 |
| All scrapes failed (zero content) | Throws `PipelineError` | US-PL-011 |
| web_fetch scrape failure | Throws `PipelineError` | US-PL-007 |
| web_fetch: empty content + synthesis failure | Throws `PipelineError` | US-PL-009 |
| web_fetch timeout during scrape | Throws `PipelineTimeoutError` | US-PL-005 |

## Error Handling

### Error Response Format

PL distinguishes two categories of outcomes:

**Degraded string results** (resolved normally, MC presents as `isError: false`):
- Synthesis failure with available content → degraded digest with `[Note: LLM synthesis unavailable; showing truncated raw content.]` prefix (US-PL-008, US-PL-009)
- Pipeline timeout with partial content → degraded digest from available scraped content (US-PL-004)
- Some URLs failed but ≥1 succeeded → normal digest from surviving results (US-PL-006)

**Thrown errors** (MC catches and presents as `isError: true`):
- Search stage failure: `PipelineError` with message including failure reason, SearXNG URL, and remediation suggestion (US-PL-010)
- All scrapes failed: `PipelineError` with message listing failed URLs and reasons (US-PL-011)
- web_fetch scrape failure: `PipelineError` with HTTP status code or timeout value, URL, and suggested action (US-PL-007)
- web_fetch empty content + synthesis failure: `PipelineError` indicating both extraction and synthesis failed (US-PL-009)
- web_fetch timeout during scrape: `PipelineTimeoutError` with URL and timeout value (US-PL-005)

### Module-Specific Error Types

| Error Class | Extends | Category | When Thrown |
|-------------|---------|----------|-------------|
| `PipelineError` | `AppError` | varies | Hard pipeline failures (search down, all scrapes failed, web_fetch scrape error) |
| `PipelineTimeoutError` | `PipelineError` | `timeout` | Pipeline timeout with no partial content to degrade to |

### Error Isolation Strategy

- **Per-URL scrape failures** (US-PL-006): Each `scrape()` call is wrapped in try/catch. Failed URLs are logged to stderr with the URL, error category, and error message, added to `failedUrls` array, and excluded from downstream stages. Remaining URLs proceed normally.
- **Uncaught exceptions during scrape**: Caught by the same try/catch wrapper, treated as scrape failure, logged with full details. Pipeline continues.
- **Deduplication errors**: DD never throws (per cross-module contract). PL does not need to catch DD errors.
- **Synthesis errors**: SY never throws (per cross-module contract). PL calls `synthesize`/`synthesizeSingle` in a try/catch; on rejection, constructs a degraded fallback from available content (US-PL-008/009).
- **Search errors**: SR throws typed errors. PL catches them and decides whether to abort (throw `PipelineError`) or proceed (empty results → throw `PipelineError`).

### Timeout Abort Strategy

PL creates a per-invocation `AbortController`. On timeout:
1. `controller.abort()` fires, setting `signal.aborted = true`
2. All `scrape()` calls passed `signal` via `ScrapeOptions.signal` receive the abort and cancel their underlying HTTP/Puppeteer operations (US-PL-015)
3. The concurrency limiter stops dispatching queued items when `signal.aborted` is true
4. PL checks `signal.aborted` at each stage boundary; if aborted, it returns the best partial result available (US-PL-004)
5. Resources (timers, semaphore releases) are cleaned up via `finally` blocks

## Component Interfaces

### Public API (orchestrator.ts)

```typescript
/** US-PL-001, US-PL-003, US-PL-004, US-PL-006, US-PL-008, US-PL-010, US-PL-011, US-PL-012, US-PL-014, US-PL-015 */
function runWebSearch(params: WebSearchParams): Promise<string>;

/** US-PL-002, US-PL-005, US-PL-007, US-PL-009, US-PL-012, US-PL-015 */
function runWebFetch(params: WebFetchParams): Promise<string>;
```

### Internal Pipeline Functions

#### web-search-pipeline.ts

```typescript
/**
 * Executes the full Search → Scrape → Dedup → Synthesize pipeline.
 * US-PL-001, US-PL-014, US-PL-012
 */
function executeWebSearchPipeline(
  query: string,
  maxResults: number,
  focus: string | undefined,
  config: PipelineConfig,
  signal: AbortSignal
): Promise<PipelineResult>;

/**
 * Runs the search stage: calls SR.search() and validates results.
 * US-PL-001, US-PL-010, US-PL-014
 * Returns: SearchResult[] — sorted by descending score.
 * Throws: PipelineError if search fails or returns zero results.
 */
function runSearchStage(
  query: string,
  maxResults: number,
  signal: AbortSignal
): Promise<SearchResult[]>;

/**
 * Runs the scrape stage: dispatches concurrent scrape() calls for each URL.
 * US-PL-003, US-PL-006, US-PL-014, US-PL-015
 * Returns: { contentItems: ContentItem[]; failedUrls: FailedUrl[] }
 * Never throws — all per-URL failures are isolated.
 */
function runScrapeStage(
  searchResults: SearchResult[],
  maxConcurrency: number,
  signal: AbortSignal
): Promise<{ contentItems: ContentItem[]; failedUrls: FailedUrl[] }>;

/**
 * Runs the deduplicate stage: calls DD.deduplicate().
 * US-PL-001, US-PL-011, US-PL-014
 * Returns: ContentItem[] — deduplicated, filtered set.
 */
function runDeduplicateStage(
  contentItems: ContentItem[]
): Promise<ContentItem[]>;

/**
 * Runs the synthesize stage: calls SY.synthesize().
 * US-PL-001, US-PL-008, US-PL-014
 * Returns: DigestResult — always resolves, degrades on failure.
 */
function runSynthesizeStage(
  query: string,
  contentItems: ContentItem[],
  focus: string | undefined
): Promise<DigestResult>;

/**
 * Constructs a degraded fallback digest when SY.synthesize() fails.
 * Concatenates titles, URLs, and truncated content from all deduplicated items.
 * US-PL-008
 */
function buildDegradedDigest(
  contentItems: ContentItem[]
): DigestResult;
```

#### web-fetch-pipeline.ts

```typescript
/**
 * Executes the Scrape → Synthesize sub-flow pipeline.
 * US-PL-002, US-PL-005, US-PL-012
 */
function executeWebFetchPipeline(
  url: string,
  focus: string | undefined,
  config: PipelineConfig,
  signal: AbortSignal
): Promise<PipelineResult>;

/**
 * Runs the scrape stage for a single URL.
 * US-PL-002, US-PL-007
 * Returns: ScrapeResult
 * Throws: PipelineError with actionable message on failure.
 */
function runFetchScrapeStage(
  url: string,
  config: PipelineConfig,
  signal: AbortSignal
): Promise<ScrapeResult>;

/**
 * Runs the synthesis stage for a single URL.
 * US-PL-002, US-PL-009
 * Returns: DigestResult — always resolves, degrades on failure.
 */
function runFetchSynthesizeStage(
  url: string,
  title: string,
  content: string,
  focus: string | undefined
): Promise<DigestResult>;

/**
 * Constructs an actionable error message for a web_fetch scrape failure.
 * US-PL-007
 */
function buildScrapeErrorMessage(
  url: string,
  scrapeResult: ScrapeResult
): string;
```

#### concurrency-limiter.ts

```typescript
/**
 * Processes items concurrently up to maxConcurrency, with per-item error isolation
 * and abort-signal-aware dispatch. Each item's task function receives the AbortSignal.
 * US-PL-003, US-PL-006, US-PL-015
 *
 * @param items - Items to process
 * @param maxConcurrency - Maximum concurrent operations
 * @param signal - AbortSignal; when aborted, stops dispatching new items
 * @param task - Async function executed per item; receives (item, index, signal)
 * @returns Array of results in the same order as input items; failed items are
 *          represented by a Result wrapper distinguishing success/failure
 */
function runWithConcurrencyLimit<T, R>(
  items: T[],
  maxConcurrency: number,
  signal: AbortSignal,
  task: (item: T, index: number, signal: AbortSignal) => Promise<R>
): Promise<ConcurrencyResult<T, R>[]>;
```

#### timeout-guard.ts

```typescript
/**
 * Creates an AbortController-based timeout guard for a pipeline invocation.
 * The timer fires after timeoutMs, calling controller.abort().
 * cleanup() must be called when the pipeline completes (success or error)
 * to clear the timer and release resources.
 * US-PL-004, US-PL-005, US-PL-013, US-PL-015
 *
 * @param timeoutMs - Timeout duration in milliseconds
 * @returns Object with signal, cleanup, and isTimedOut methods
 */
function createTimeoutGuard(timeoutMs: number): TimeoutGuard;

interface TimeoutGuard {
  /** AbortSignal that fires when the timeout elapses */
  readonly signal: AbortSignal;
  /** Clears the timeout timer; call in finally block */
  cleanup: () => void;
  /** Returns true if the timeout has elapsed */
  isTimedOut: () => boolean;
}
```

#### digest-formatter.ts (internal helper, not a separate file — lives in orchestrator.ts)

```typescript
/**
 * Renders a DigestResult into a formatted text string with sections:
 * ## Answer, ## Key Points (bullets), ## Sources (numbered).
 * Prepends degradation notice if provided.
 * US-PL-001, US-PL-002, US-PL-008, US-PL-009
 */
function formatDigest(digest: DigestResult, notice?: string): string;
```

### Processing Module Dependencies (called by PL)

| Module | Function Called | Signature | PL Call Site |
|--------|----------------|-----------|-------------|
| SR | `search` | `(query: string, options?: SearchOptions) => Promise<SearchResult[]>` | `runSearchStage` |
| SC | `scrape` | `(url: string, options?: ScrapeOptions) => Promise<ScrapeResult>` | `runScrapeStage`, `runFetchScrapeStage` |
| DD | `deduplicate` | `(items: ContentItem[], config?: DDConfig) => ContentItem[]` | `runDeduplicateStage` |
| SY | `synthesize` | `(query: string, contents: ContentItem[], focus?: string) => Promise<DigestResult>` | `runSynthesizeStage` |
| SY | `synthesizeSingle` | `(url: string, title: string, content: string, focus?: string) => Promise<DigestResult>` | `runFetchSynthesizeStage` |

> **Note on `scrape` signature**: PL passes `{ signal: abortSignal, timeoutMs: config.scrapeTimeoutMs }` as `ScrapeOptions` to enable cancellation (US-PL-015) and per-page timeout enforcement.

## Dependencies

PL does not require any external packages beyond those already listed in index.md. All I/O, parsing, and LLM operations are delegated to processing modules.

| Package | Version | Purpose |
|---------|---------|---------|
| _(none — no external packages)_ | — | PL only imports from shared types, shared utils, shared config, and the four processing modules |

**Internal module dependencies (compile-time imports):**

| Import Source | Symbols Used |
|---------------|-------------|
| `../../shared/types/index.ts` | `SearchResult`, `SearchOptions`, `ScrapeResult`, `ContentItem`, `DeduplicatedItem`, `DDConfig`, `DigestResult`, `SourceRef`, `PipelineConfig`, `PipelineResult`, `PipelineOutcome`, `StageLog`, `FailedUrl` |
| `../../shared/utils/logger.ts` | `log` (stderr logger with `info`, `warn`, `error` methods) |
| `../../shared/utils/errors.ts` | `AppError`, `ErrorCategory` |
| `../../shared/utils/semaphore.ts` | `Semaphore` (used by `concurrency-limiter.ts`) |
| `../../shared/config/index.ts` | `appConfig` (frozen `AppConfig` singleton) |
| `../search-retrieval/index.ts` | `search` |
| `../scrape-extract/index.ts` | `scrape` |
| `../deduplicate/index.ts` | `deduplicate` |
| `../synthesize/index.ts` | `synthesize`, `synthesizeSingle` |

## File Generation Order

Files are listed in dependency order — each file depends only on files listed before it.

| # | File Path | Description | Key User Stories |
|---|-----------|-------------|-----------------|
| 1 | `src/modules/pipeline-orchestration/timeout-guard.ts` | AbortController-based timeout guard: `createTimeoutGuard()`, `TimeoutGuard` interface. Provides `signal`, `cleanup()`, `isTimedOut()`. Foundation for pipeline timeout enforcement. | US-PL-004, US-PL-005, US-PL-013, US-PL-015 |
| 2 | `src/modules/pipeline-orchestration/concurrency-limiter.ts` | Semaphore-based concurrent task dispatcher: `runWithConcurrencyLimit()` and `ConcurrencyResult` type. Uses shared `Semaphore`. Abort-signal-aware dispatch. | US-PL-003, US-PL-006, US-PL-015 |
| 3 | `src/modules/pipeline-orchestration/web-search-pipeline.ts` | Full Search→Scrape→Dedup→Synthesize pipeline implementation: `executeWebSearchPipeline()` and stage functions (`runSearchStage`, `runScrapeStage`, `runDeduplicateStage`, `runSynthesizeStage`, `buildDegradedDigest`). Imports SR, SC, DD, SY, shared types, and depends on files 1–2. | US-PL-001, US-PL-003, US-PL-004, US-PL-006, US-PL-008, US-PL-010, US-PL-011, US-PL-012, US-PL-014 |
| 4 | `src/modules/pipeline-orchestration/web-fetch-pipeline.ts` | Scrape→Synthesize sub-flow implementation: `executeWebFetchPipeline()` and stage functions (`runFetchScrapeStage`, `runFetchSynthesizeStage`, `buildScrapeErrorMessage`). Imports SC, SY, shared types, and depends on file 1. | US-PL-002, US-PL-005, US-PL-007, US-PL-009, US-PL-012 |
| 5 | `src/modules/pipeline-orchestration/orchestrator.ts` | Top-level entry functions `runWebSearch()` and `runWebFetch()`. Reads config from `appConfig`, creates timeout guards, delegates to pipeline functions (files 3–4), renders `DigestResult` to text via `formatDigest()`, logs final outcome. Defines `PipelineError`, `PipelineTimeoutError`, `WebSearchParams`, `WebFetchParams`. | US-PL-001, US-PL-002, US-PL-012, US-PL-013 |
| 6 | `src/modules/pipeline-orchestration/index.ts` | Public API barrel: re-exports `runWebSearch`, `runWebFetch`, `WebSearchParams`, `WebFetchParams`, `PipelineError`, `PipelineTimeoutError`. | — |

### Test Files (mirror src/ structure under `tests/`)

| # | File Path | Description |
|---|-----------|-------------|
| 7 | `tests/modules/pipeline-orchestration/timeout-guard.test.ts` | Unit tests for timeout guard creation, abort firing, cleanup, and `isTimedOut`. |
| 8 | `tests/modules/pipeline-orchestration/concurrency-limiter.test.ts` | Unit tests for concurrency enforcement, abort-aware dispatch, error isolation, and ordering. |
| 9 | `tests/modules/pipeline-orchestration/web-search-pipeline.test.ts` | Integration tests with mocked SR/SC/DD/SY: full pipeline success, partial failures, synthesis degradation, search failure, zero results, timeout abort, stage logging. |
| 10 | `tests/modules/pipeline-orchestration/web-fetch-pipeline.test.ts` | Integration tests with mocked SC/SY: scrape success, scrape failure (HTTP/timeout/DNS), synthesis degradation, empty content, timeout abort. |
| 11 | `tests/modules/pipeline-orchestration/orchestrator.test.ts` | End-to-end tests with mocked processing modules: config resolution, digest formatting, error wrapping, outcome logging. |
