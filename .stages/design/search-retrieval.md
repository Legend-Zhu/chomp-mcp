# Design: Search Retrieval (SR)

## Overview

The Search Retrieval module is the data-acquisition entry point of the web research pipeline. It queries one or more SearXNG meta-search instances over HTTP, parses JSON responses into a unified `SearchResult[]` candidate list (`{ title, url, snippet, score }`), and resiliently handles transient failures via configurable exponential-backoff retry and multi-instance failover. The module guarantees that the pipeline orchestrator (PL) always receives a clean, scored, de-duplicated (intra-response), and truncated candidate list—or a typed error describing why no candidates could be obtained.

All HTTP communication uses Node.js 18+ native `fetch` with `AbortController`-based timeouts. No external HTTP libraries, no API keys, and no paid search APIs are used. All diagnostic logging goes to `stderr` exclusively; `stdout` is never touched.

## Architecture

The SR module sits at the head of the pipeline data flow:

```
PL.runWebSearch()
  └─ SR.search(query, options) ──────────────────────────────────┐
       │                                                           │
       ├─ instance-pool.ts ── selects SearXNG instance(s)          │
       │     (self-hosted: single instance, no failover)           │
       │     (public: built-in list with failover + promotion)     │
       │                                                           │
       ├─ retry-failover.ts ── coordinates:                        │
       │     1. validate query (ValidationError)                   │
       │     2. resolve config (env vars + options override)       │
       │     3. overall 30s ceiling tracking                       │
       │     4. per-instance retry loop (exp. backoff + jitter)    │
       │     5. cross-instance failover loop                       │
       │                                                           │
       │     per attempt:                                          │
       │       ┌─ searxng-client.ts ── HTTP GET /search            │
       │       │     AbortController timeout                       │
       │       │     returns status, body, contentType, retryAfter │
       │       │                                                   │
       │       ├─ response-parser.ts ── JSON.parse + field extract │
       │       │     non-JSON detection (US-SR-009)                │
       │       │     malformed-entry skip (US-SR-002)              │
       │       │                                                   │
       │       └─ result-normalizer.ts ── score normalization      │
       │             title/snippet defaults + truncation           │
       │             exact-URL dedup (fragment-insensitive)        │
       │             sort by descending score, truncate to max     │
       │                                                           │
       └─ returns Promise<SearchResult[]> ◄──────────────────────┘
              or throws typed SearchError subclass
```

**Module boundary discipline:** SR imports only `shared/types/*`, `shared/utils/*`, and `shared/config/*`. It does not import any other processing module (SC, DD, SY). PL is the sole caller of `search()`.

**Error propagation contract:** SR throws typed errors (`SearchError` subclasses). PL catches these and may abort the pipeline with a user-facing message. SR never silently swallows errors that should propagate—but it does skip individual malformed result entries within a valid response without aborting the entire parse (NFR-SR-004).

**Configuration source:** The module reads `SEARXNG_URL`, `SEARXNG_TIMEOUT_MS`, `SEARXNG_MAX_RETRIES`, and `SEARXNG_RETRY_BASE_MS` from the centralized `appConfig` singleton (`shared/config/index.ts`), which reads `process.env` at startup with validation and defaults. Per-call `SearchOptions.timeoutMs` overrides the env-var timeout for that call only.

## Data Models

### SearchResult (shared type — defined in `shared/types/search.ts`, re-exported by SR)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | Yes | Result title; defaults to `"(untitled)"` if missing; truncated to 500 chars (497 + `"..."`). |
| `url` | `string` | Yes | Result URL; validated as a parseable URI. |
| `snippet` | `string` | Yes | Result snippet (from SearXNG `content` field); defaults to `""`; truncated to 1000 chars (997 + `"..."`). |
| `score` | `number` | Yes | Normalized relevance score in `[0.0, 1.0]`; first result always has the highest score. |

### SearchOptions (shared type — defined in `shared/types/search.ts`, re-exported by SR)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `maxResults` | `number` | No | Maximum results to return; default `10` if omitted. |
| `timeoutMs` | `number` | No | Per-request timeout override; falls back to `SEARXNG_TIMEOUT_MS` env var (default `10000`). |
| `categories` | `string` | No | SearXNG `categories` query parameter (e.g., `"general"`, `"it"`, `"science"`). |

### SearXNGRawResult (internal — defined in `response-parser.ts`)

Raw shape of a single entry inside the SearXNG `results` array. All fields are optional because different engines populate different subsets.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `unknown` | No | Raw URL value from SearXNG; validated and type-narrowed during parsing. |
| `title` | `unknown` | No | Raw title value; may be string, undefined, or non-string. |
| `content` | `unknown` | No | Raw snippet/content value; mapped to `snippet` in `SearchResult`. |
| `score` | `unknown` | No | Raw numeric score from SearXNG; may be absent. |

### ParsedResult (internal — defined in `response-parser.ts`)

Intermediate type produced by the parser after validating and type-narrowing each raw entry. Consumed by the normalizer.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | Yes | Raw title string (pre-normalization defaults/truncation). |
| `url` | `string` | Yes | Validated URL string (passes `URL` constructor). |
| `content` | `string` | Yes | Raw content/snippet string (pre-normalization defaults/truncation). |
| `score` | `number \| null` | Yes | Numeric score if SearXNG provided one; `null` if absent. |

### ParseOutput (internal — defined in `response-parser.ts`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `results` | `ParsedResult[]` | Yes | Valid parsed results (malformed entries excluded). |
| `skippedMalformed` | `number` | Yes | Count of entries skipped due to missing/invalid URL. |

### SearXNGFetchResult (internal — defined in `searxng-client.ts`)

The structured result of a single HTTP GET to a SearXNG `/search` endpoint.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | `number` | Yes | HTTP response status code. |
| `body` | `string` | Yes | Response body as a UTF-8 string (for JSON parsing or non-JSON diagnostics). |
| `contentType` | `string \| null` | Yes | Value of the `Content-Type` response header, or `null` if absent. |
| `retryAfterMs` | `number \| null` | Yes | Parsed `Retry-After` header in milliseconds (only for HTTP 429); `null` otherwise. |

### SearchConfig (internal — defined in `retry-failover.ts`)

Per-call resolved configuration, merging env-var defaults with `SearchOptions` overrides.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `timeoutMs` | `number` | Yes | Per-request timeout; from `options.timeoutMs` or `SEARXNG_TIMEOUT_MS` (default `10000`). |
| `maxRetries` | `number` | Yes | Max retry attempts per instance; from `SEARXNG_MAX_RETRIES` (default `2`). |
| `retryBaseMs` | `number` | Yes | Exponential backoff base delay; from `SEARXNG_RETRY_BASE_MS` (default `500`). |
| `maxResults` | `number` | Yes | Max results to return; from `options.maxResults` (default `10`). |
| `categories` | `string \| undefined` | No | Optional SearXNG categories parameter. |

### InstancePool (internal — defined in `instance-pool.ts`)

Mutable state object managing the ordered list of SearXNG instance URLs and cursor position for failover.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | `'self-hosted' \| 'public'` | Yes | `'self-hosted'` when `SEARXNG_URL` is set (single instance, no failover); `'public'` otherwise. |
| `instances` | `string[]` | Yes | Ordered list of instance base URLs. In self-hosted mode, exactly one entry. In public mode, at least 3 entries. Reordered on successful failover promotion. |
| `cursor` | `number` | Yes | Index into `instances` pointing to the current target. Reset to `0` at the start of each `search()` call. |

### SearXNGMode (internal — defined in `instance-pool.ts`)

| Value | Description |
|-------|-------------|
| `'self-hosted'` | `SEARXNG_URL` is set and valid; no failover. |
| `'public'` | `SEARXNG_URL` not set; built-in instance list with failover. |

## API Endpoints

This module exposes a programmatic TypeScript function API, not HTTP/REST endpoints. The single public entry point is:

| Method | Signature | Request Parameters | Response | Error Codes | User Story |
|--------|-----------|-------------------|----------|-------------|------------|
| `search` | `search(query: string, options?: SearchOptions): Promise<SearchResult[]>` | `query` — non-empty string, ≤ 500 chars; `options.maxResults` — positive int (default 10); `options.timeoutMs` — positive int; `options.categories` — string | `Promise<SearchResult[]>` — array of normalized results sorted by descending `score`, length 0 to `maxResults`. | `ValidationError` — empty/whitespace query or query > 500 chars (US-SR-001). `ConfigurationError` — invalid `SEARXNG_URL` at init (US-SR-007). `SearchTimeoutError` — per-request timeout exceeded after all retries (US-SR-004). `SearchParseError` — non-JSON response after all retries (US-SR-009). `SearchFailedError` — self-hosted instance exhausted all retries (US-SR-005/006). `SearchUnavailableError` — all public instances exhausted (US-SR-006). | US-SR-001, US-SR-008, US-SR-012 |

**Public exports** (from `index.ts`):

| Export | Source File | Kind |
|--------|------------|------|
| `search` | `retry-failover.ts` | Function |
| `SearchResult` | `shared/types/search.ts` (re-export) | Interface |
| `SearchOptions` | `shared/types/search.ts` (re-export) | Interface |
| `SearchError` | `errors.ts` | Class |
| `SearchTimeoutError` | `errors.ts` | Class |
| `SearchParseError` | `errors.ts` | Class |
| `SearchFailedError` | `errors.ts` | Class |
| `SearchUnavailableError` | `errors.ts` | Class |
| `ConfigurationError` | `errors.ts` | Class |
| `ValidationError` | `errors.ts` | Class |

## Error Handling

### Error Hierarchy

All SR errors extend the shared `AppError` abstract class (`shared/utils/errors.ts`) which provides a `category` field and an optional `details` record. `SearchError` is the concrete base for all SR-specific errors.

```
AppError (shared/utils/errors.ts)
  └─ SearchError (errors.ts)              category: varies (set by subclass)
       ├─ SearchTimeoutError              category: 'timeout'
       ├─ SearchParseError                category: 'parse_error'
       ├─ SearchFailedError               category: 'http_error'
       ├─ SearchUnavailableError          category: 'network'
       ├─ ConfigurationError              category: 'config'
       └─ ValidationError                 category: 'validation'
```

### Error Response Format

Errors thrown by this module are typed `SearchError` instances (or subclasses). Each error contains:

| Property | Type | Description |
|----------|------|-------------|
| `message` | `string` | Human-readable error description (exact messages specified in acceptance criteria). |
| `category` | `string` | One of: `'timeout'`, `'parse_error'`, `'http_error'`, `'network'`, `'config'`, `'validation'`. |
| `details` | `Record<string, unknown> \| undefined` | Optional structured context (e.g., `{ instance: url, statusCode: 503 }`). |
| `name` | `string` | Class name for `instanceof` checks. |

### Module-Specific Error Behaviors

| Error Class | Thrown When | Retryable? | Failover? |
|-------------|------------|------------|-----------|
| `ValidationError` | Empty/whitespace/null query; query > 500 chars | No (caller error) | No |
| `ConfigurationError` | `SEARXNG_URL` set but not a valid HTTP(S) URL | No (config error at init) | No |
| `SearchTimeoutError` | Per-request `SEARXNG_TIMEOUT_MS` exceeded | Yes (same instance) | Yes (next instance) |
| `SearchParseError` | Response body not valid JSON (or non-JSON content type with unparseable body) | Yes (same instance) | Yes (next instance) |
| `SearchFailedError` | Self-hosted mode: all retries exhausted | Terminal | No (self-hosted has no failover) |
| `SearchUnavailableError` | Public mode: all instances exhausted all retries | Terminal | No (all candidates exhausted) |

**Non-JSON response error enrichment** (US-SR-009): When `SearchParseError` is thrown for a response that appears to be HTML (body contains `<`), the error message includes the first 200 characters of the response body for diagnostic purposes.

**Malformed entry handling** (US-SR-002, NFR-SR-004): A single malformed entry in a SearXNG `results` array (missing/invalid URL) does NOT throw an error. The entry is skipped, an internal `skippedMalformed` counter is incremented, and remaining entries are processed normally. The counter is logged to stderr at debug level.

**Empty results handling** (US-SR-008): An empty `results` array from a valid HTTP 200 response is a successful result (resolves with `[]`). It does NOT trigger retry, failover, or throw any error.

**Overall ceiling** (NFR-SR-001): If 30 seconds elapse from `search()` invocation (across all retries and failover attempts), the module throws `SearchFailedError` with message `"Search exceeded overall time ceiling of 30000ms"`.

## Component Interfaces

### errors.ts — Error Class Definitions

```typescript
import { AppError } from '../../shared/utils/errors.js';

/** Base error for all search-retrieval errors. */
export class SearchError extends AppError {
  constructor(message: string, category: ErrorCategory, details?: Record<string, unknown>);
}

/** Per-request timeout exceeded. Retryable + failover-eligible. */
export class SearchTimeoutError extends SearchError {
  constructor(message: string, details?: Record<string, unknown>);
  // category: 'timeout'
}

/** Response body could not be parsed as JSON. Retryable + failover-eligible. */
export class SearchParseError extends SearchError {
  constructor(message: string, details?: Record<string, unknown>);
  // category: 'parse_error'
}

/** Self-hosted instance exhausted all retries. Terminal. */
export class SearchFailedError extends SearchError {
  constructor(message: string, details?: Record<string, unknown>);
  // category: 'http_error'
}

/** All public instances exhausted. Terminal. */
export class SearchUnavailableError extends SearchError {
  constructor(message: string, details?: Record<string, unknown>);
  // category: 'network'
}

/** SEARXNG_URL is set but invalid. Terminal (config error at init). */
export class ConfigurationError extends SearchError {
  constructor(message: string, details?: Record<string, unknown>);
  // category: 'config'
}

/** Query validation failed. Terminal (caller error). */
export class ValidationError extends SearchError {
  constructor(message: string, details?: Record<string, unknown>);
  // category: 'validation'
}
```

### instance-pool.ts — Instance Management

```typescript
export type SearXNGMode = 'self-hosted' | 'public';

export interface InstancePool {
  readonly mode: SearXNGMode;
  instances: string[];
  cursor: number;
}

/** Built-in public SearXNG instance URLs (at least 3). */
export const PUBLIC_SEARXNG_INSTANCES: readonly string[];

/**
 * Creates and initializes the instance pool.
 * Reads SEARXNG_URL from appConfig:
 *   - Set + valid HTTP(S) URL → self-hosted mode (single instance, no failover).
 *   - Set + invalid → throws ConfigurationError.
 *   - Unset → public mode with built-in instance list.
 * Logs initialization details to stderr.
 */
export function createInstancePool(): InstancePool;

/** Returns the instance URL at the current cursor position. */
export function currentInstance(pool: InstancePool): string;

/**
 * Advances cursor to the next instance.
 * @returns true if a next instance is available; false if exhausted.
 * In self-hosted mode, always returns false.
 */
export function advanceInstance(pool: InstancePool): boolean;

/** Returns true if the cursor has moved past the last instance. */
export function isExhausted(pool: InstancePool): boolean;

/** Resets cursor to 0 for the start of a new search() call. */
export function resetCursor(pool: InstancePool): void;

/**
 * Moves the instance at the current cursor to the front of the list.
 * Called after a successful failover to promote the working instance.
 * Logs the new ordering to stderr at debug level.
 */
export function promoteCurrent(pool: InstancePool): void;
```

### searxng-client.ts — HTTP Client

```typescript
/**
 * Performs a single HTTP GET request to a SearXNG /search endpoint.
 *
 * Request parameters: q={query}, format=json, safesearch=1,
 * and optional categories={categories}.
 *
 * Uses AbortController for per-request timeout. On timeout, aborts
 * the fetch and throws SearchTimeoutError. On network error, throws
 * SearchError with category 'network'.
 *
 * @returns SearXNGFetchResult containing status, body, contentType, retryAfterMs.
 * @throws SearchTimeoutError — per-request timeout exceeded.
 * @throws SearchError — network-level failure (category 'network').
 */
export async function fetchFromSearXNG(params: {
  instanceUrl: string;
  query: string;
  timeoutMs: number;
  categories?: string;
}): Promise<SearXNGFetchResult>;
```

### response-parser.ts — JSON Parsing

```typescript
export interface SearXNGRawResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  score?: unknown;
}

export interface ParsedResult {
  title: string;
  url: string;
  content: string;
  score: number | null;
}

export interface ParseOutput {
  results: ParsedResult[];
  skippedMalformed: number;
}

/**
 * Parses a raw SearXNG response body into typed intermediate results.
 *
 * Behavior:
 *   1. Non-JSON detection (US-SR-009): if contentType does not include
 *      'application/json', checks if body starts with '{' or '['. If not,
 *      throws SearchParseError with diagnostic context (first 200 chars
 *      if HTML-like).
 *   2. JSON.parse: if parsing fails, throws SearchParseError.
 *   3. Extracts top-level 'results' array. If absent or not an array,
 *      returns empty ParseOutput (zero results).
 *   4. For each entry: validates url is present and parseable via URL
 *      constructor. Skips malformed entries, increments skippedMalformed.
 *      Extracts title, content (→snippet), score (if numeric).
 *
 * @throws SearchParseError — invalid JSON or non-JSON body.
 */
export function parseSearXNGResponse(
  body: string,
  contentType: string | null,
): ParseOutput;
```

### result-normalizer.ts — Normalization

```typescript
/** Maximum title length before truncation. */
export const MAX_TITLE_LENGTH = 500;
/** Maximum snippet length before truncation. */
export const MAX_SNIPPET_LENGTH = 1000;

/**
 * Transforms parsed intermediate results into final SearchResult[].
 *
 * Pipeline:
 *   1. Field normalization (US-SR-003):
 *      - title: default "(untitled)" if empty; truncate to 497 + "...".
 *      - snippet: default "" if empty; truncate to 997 + "...".
 *   2. Score normalization (US-SR-003):
 *      - If SearXNG provided scores: normalize by dividing each by max score.
 *      - If no scores: positional rank: score = 1.0 - (index / total).
 *      - Single result: score = 1.0.
 *   3. Exact-URL dedup (US-SR-010):
 *      - Fragment-insensitive comparison (strip '#' before comparing).
 *      - Retain highest-scored entry per unique URL.
 *      - Log count removed.
 *   4. Sort by descending score.
 *   5. Truncate to maxResults.
 *
 * @returns SearchResult[] sorted by descending score, length ≤ maxResults.
 */
export function normalizeResults(
  parsed: ParsedResult[],
  maxResults: number,
): SearchResult[];
```

### retry-failover.ts — Orchestration Entry Point

```typescript
/**
 * Public search entry point. Executes a search query against SearXNG
 * with retry, failover, timeout, and normalization.
 *
 * Flow:
 *   1. Validate query (US-SR-001): reject empty/whitespace/null or > 500 chars
 *      with ValidationError.
 *   2. Resolve SearchConfig from appConfig + options overrides.
 *   3. Reset instance pool cursor.
 *   4. Enter failover loop over instances:
 *      a. Enter retry loop (0..maxRetries) against current instance.
 *      b. Per attempt: fetchFromSearXNG → parseSearXNGResponse → normalizeResults.
 *      c. On 200 + valid parse: return results (success).
 *      d. On retryable failure: compute backoff delay, sleep, continue.
 *      e. On non-retryable failure (4xx except 429): break retry loop.
 *      f. On all retries exhausted: advance to next instance (or throw).
 *   5. Overall 30s ceiling check before each attempt.
 *
 * Retryable conditions (US-SR-005, US-SR-009):
 *   - Network error, SearchTimeoutError, HTTP 5xx, HTTP 429, SearchParseError.
 *
 * Backoff (US-SR-005):
 *   - delay = retryBaseMs * 2^attemptIndex, with ±20% jitter.
 *   - For 429: honor Retry-After header (capped at 10s) instead of computed delay.
 *
 * Failover (US-SR-006):
 *   - Self-hosted mode: no failover; throw SearchFailedError on exhaustion.
 *   - Public mode: advance to next instance; promote on success.
 *   - All instances exhausted: throw SearchUnavailableError.
 *
 * @throws ValidationError — invalid query.
 * @throws SearchFailedError — self-hosted instance exhausted or overall ceiling.
 * @throws SearchUnavailableError — all public instances exhausted.
 */
export async function search(
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]>;
```

### index.ts — Public Barrel

```typescript
// Re-export shared types
export type { SearchResult, SearchOptions } from '../../shared/types/search.js';

// Re-export errors
export {
  SearchError,
  SearchTimeoutError,
  SearchParseError,
  SearchFailedError,
  SearchUnavailableError,
  ConfigurationError,
  ValidationError,
} from './errors.js';

// Re-export public function
export { search } from './retry-failover.js';
```

## Dependencies

This module uses **only Node.js built-in APIs and shared project utilities**. No external npm packages are required beyond the dev-dependencies already listed in `index.md`.

| Package | Version | Purpose |
|---------|---------|---------|
| _(none — external packages)_ | — | SR uses native `fetch` (Node.js 18+) for all HTTP. No HTTP client library is needed. |

**Shared internal dependencies (project modules, not npm packages):**

| Internal Module | Import Path | Purpose |
|----------------|-------------|---------|
| `AppError`, `ErrorCategory` | `shared/utils/errors.ts` | Base error class and category type for all SR errors. |
| `logger` | `shared/utils/logger.ts` | Structured stderr-only logger (`log.info`, `log.warn`, `log.error`, `log.debug`). Used for all US-SR-011 logging. |
| `env` | `shared/utils/env.ts` | `envInt()`, `envString()` helpers for parsing env vars with defaults. Used indirectly via `appConfig`. |
| `appConfig` | `shared/config/index.ts` | Centralized config singleton providing `searxngUrl`, `searxngTimeoutMs`, `searxngMaxRetries`, `searxngRetryBaseMs`. |
| `SearchResult`, `SearchOptions` | `shared/types/search.ts` | Shared type contracts for input/output of `search()`. |

**No new external packages are introduced.** This module adheres to DC-SR-001 (no paid APIs), DC-SR-004 (Node.js 18+ native APIs only), and the project-wide prohibition on `axios`/`got`/other HTTP client libraries.

## File Generation Order

Files are listed in dependency order — each file may import only from files listed above it or from `shared/`.

| # | File Path | Description | Primary User Stories |
|---|-----------|-------------|---------------------|
| 1 | `src/modules/search-retrieval/errors.ts` | All error class definitions: `SearchError` (base), `SearchTimeoutError`, `SearchParseError`, `SearchFailedError`, `SearchUnavailableError`, `ConfigurationError`, `ValidationError`. Each extends `AppError` with appropriate category. | US-SR-012 |
| 2 | `src/modules/search-retrieval/instance-pool.ts` | Instance pool management: `PUBLIC_SEARXNG_INSTANCES` constant, `InstancePool` interface, `SearXNGMode` type, `createInstancePool()`, `currentInstance()`, `advanceInstance()`, `isExhausted()`, `resetCursor()`, `promoteCurrent()`. Reads `SEARXNG_URL` from `appConfig`, validates format, throws `ConfigurationError` on invalid URL. | US-SR-006, US-SR-007 |
| 3 | `src/modules/search-retrieval/searxng-client.ts` | HTTP client: `SearXNGFetchResult` interface, `fetchFromSearXNG()`. Builds GET request URL with `q`, `format=json`, `safesearch=1`, optional `categories`. Uses `AbortController` for per-request timeout. Returns status/body/contentType/retryAfterMs. Throws `SearchTimeoutError` on timeout, `SearchError` (network) on fetch failure. | US-SR-001, US-SR-004 |
| 4 | `src/modules/search-retrieval/response-parser.ts` | JSON response parser: `SearXNGRawResult`, `ParsedResult`, `ParseOutput` interfaces, `parseSearXNGResponse()`. Non-JSON detection (content-type sniff + body prefix check). Malformed-entry skip with counter. Throws `SearchParseError` on invalid JSON. | US-SR-002, US-SR-008, US-SR-009 |
| 5 | `src/modules/search-retrieval/result-normalizer.ts` | Result normalizer: `MAX_TITLE_LENGTH`, `MAX_SNIPPET_LENGTH` constants, `normalizeResults()`. Field defaults + truncation, score normalization (max-divide or positional), fragment-insensitive exact-URL dedup, descending-score sort, `maxResults` truncation. | US-SR-003, US-SR-010 |
| 6 | `src/modules/search-retrieval/retry-failover.ts` | Main orchestrator: `SearchConfig` interface, `search()` public function, internal retry-loop and failover-loop helpers, exponential backoff with jitter, `Retry-After` header handling, 30s overall ceiling tracking. Coordinates calls to `instance-pool`, `searxng-client`, `response-parser`, and `result-normalizer`. Emits all `SEARCH START / OK / RETRY / FAILED` log lines. | US-SR-001, US-SR-004, US-SR-005, US-SR-006, US-SR-008, US-SR-011 |
| 7 | `src/modules/search-retrieval/index.ts` | Public barrel: re-exports `search`, `SearchResult`, `SearchOptions` (from shared types), and all 7 error classes. | US-SR-012 |

**Test files** (mirrored under `tests/`):

| # | File Path | Description |
|---|-----------|-------------|
| 8 | `tests/modules/search-retrieval/errors.test.ts` | Unit tests for error class instantiation, `instanceof` checks, category assignment, message formatting. |
| 9 | `tests/modules/search-retrieval/instance-pool.test.ts` | Unit tests for pool initialization (self-hosted vs public mode), `ConfigurationError` on invalid URL, cursor advance/exhaustion, promotion reordering, reset. |
| 10 | `tests/modules/search-retrieval/searxng-client.test.ts` | Unit tests with mocked `fetch`: URL construction, timeout via `AbortController`, network error wrapping, 429 `Retry-After` extraction, `SearXNGFetchResult` shape. |
| 11 | `tests/modules/search-retrieval/response-parser.test.ts` | Unit tests: valid JSON parsing, empty results array, missing `results` key, malformed entry skip + counter, non-JSON content-type detection, `SearchParseError` on invalid JSON, HTML diagnostic in error message. |
| 12 | `tests/modules/search-retrieval/result-normalizer.test.ts` | Unit tests: title/snippet defaults + truncation, score normalization (max-divide vs positional vs single), fragment-insensitive dedup, sort order, `maxResults` truncation. |
| 13 | `tests/modules/search-retrieval/retry-failover.test.ts` | Integration tests with mocked client: success on first try, retry on 5xx then success, 429 `Retry-After` handling, failover across instances, promotion on failover success, self-hosted `SearchFailedError`, public `SearchUnavailableError`, overall 30s ceiling, `ValidationError` on bad query, empty results return `[]`. |
