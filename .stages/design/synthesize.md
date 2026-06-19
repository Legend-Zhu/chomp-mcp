# Design: LLM Synthesize (SY)

## Overview

The Synthesize module is the terminal stage of the web research pipeline. It accepts deduplicated `ContentItem[]` from the Pipeline Orchestration layer and transforms them into structured `DigestResult` objects (`{ answer, keyPoints, sources }`) via an OpenAI-compatible LLM. The module encapsulates all LLM concerns: client initialization and health-checking, prompt construction (system + user), heuristic token estimation (EN/CJK aware), single-call and batch-and-merge synthesis strategies, exponential-backoff retry on transient failures, multi-strategy response parsing, source reconciliation, and graceful degradation when the LLM is unavailable. **The module never throws to its caller** — every error path is converted to either a retry or a degradation fallback returning a structurally valid `DigestResult`.

---

## Architecture

```
Pipeline Orchestration (PL)
        │
        │ synthesize(query, contents[], focus?)        ← web_search flow
        │ synthesizeSingle(url, title, content, focus?) ← web_fetch flow
        ▼
┌─────────────────────────────────────────────────────────┐
│  synthesizer.ts  (orchestrator — public entry points)   │
│                                                          │
│  1. Build prompts (prompt-builder.ts)                    │
│  2. Estimate tokens (token-estimator.ts)                 │
│  3. Route: single-call OR batch-and-merge               │
│  4. Parse response (response-parser.ts)                  │
│  5. Reconcile sources                                    │
│  6. On failure → degradation-handler.ts                  │
└──┬──────────┬──────────┬──────────┬──────────┬──────────┘
   │          │          │          │          │
   ▼          ▼          ▼          ▼          ▼
┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────────┐
│ llm- │  │prompt│  │token │  │batch │  │degradation│
│client│  │builder│  │estim.│  │merger│  │handler   │
└──────┘  └──────┘  └──────┘  └──┬───┘  └──────────┘
   │                                │
   │ openai v4 SDK                  │ (delegates back to
   │ (custom baseURL)               │  llm-client + prompt-builder
   ▼                                │  + response-parser)
OpenAI-compatible LLM                │
(Azure/Ollama/vLLM/OpenAI)──────────┘
```

**Call flow for `synthesize()` (US-SY-003):**

1. Log synthesis start (US-SY-010).
2. Check for empty `contents` → immediate degradation.
3. Build system prompt + user prompt via `prompt-builder.ts`.
4. Estimate total prompt tokens via `token-estimator.ts`.
5. **If ≤ safe threshold** (≤80% of model context limit): single `callLLMWithRetry()` → parse → return.
6. **If > safe threshold**: delegate to `batch-merger.ts` → split contents into batches → synthesize each batch → merge intermediate digests via a final merge LLM call.
7. Parse LLM response via `response-parser.ts` (multi-strategy).
8. Reconcile sources: append any input source URLs missing from the LLM's Sources section.
9. Log synthesis done (US-SY-010).
10. **On any unrecoverable error**: catch, log, invoke `degradationFallback()`.

**Call flow for `synthesizeSingle()` (US-SY-004):**

1. If `content.length < 200` → return degradation with reason `"content too short for meaningful synthesis"`.
2. Build single-source prompt via `prompt-builder.ts`.
3. Single `callLLMWithRetry()` → parse.
4. Override `sources` to exactly one entry: `{ url, title }`.
5. Return `DigestResult`.
6. **On any unrecoverable error**: catch, log, invoke degradation.

### Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| All LLM I/O centralized in `llm-client.ts` | Single retry-policy enforcement point; easy to mock in tests |
| Token estimation is heuristic (no external tokenizer) | Avoids native-binding dependencies (tiktoken); EN/CJK heuristic is sufficient for routing decisions |
| Batch-and-merge is recursive | If the merge prompt itself overflows, it re-batches the intermediate digests until a merge call fits |
| Source reconciliation always runs | Guarantees all input URLs are represented in `sources` even if the LLM omits some (BG-SY-002) |
| `synthesizeSingle` delegates to `synthesize` with a single-item array internally | DRY: both paths share prompt-building, retry, parsing, and degradation |

---

## Data Models

### SynthesizeConfig

Configuration object created at module initialization from environment variables.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiKey` | `string` | Yes | OpenAI-compatible API key. Must be non-empty. |
| `baseUrl` | `string` | Yes | LLM API base URL (e.g., `https://api.openai.com/v1`, `http://localhost:11434/v1`). |
| `model` | `string` | Yes | Model identifier (e.g., `gpt-4o-mini`, `llama3`, `qwen2:7b`). |
| `timeoutMs` | `number` | Yes | HTTP timeout for LLM calls in milliseconds. |
| `maxContextTokens` | `number` | Yes | Maximum context window for the model in tokens. |
| `safeThresholdRatio` | `number` | Yes | Fraction of `maxContextTokens` considered safe (default: `0.8`). |
| `maxBatchConcurrency` | `number` | Yes | Maximum concurrent LLM requests during batch-and-merge (default: `2`). |

### LLMResponse

Internal representation of a single LLM completion response.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | `string` | Yes | The raw text content from the LLM's `choices[0].message.content`. |
| `promptTokens` | `number` | Yes | Token count reported by the API for the prompt (usage.prompt_tokens). |
| `completionTokens` | `number` | Yes | Token count reported by the API for the completion (usage.completion_tokens). |

### LLMCallOptions

Optional parameters for an LLM call.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `temperature` | `number` | No | Sampling temperature (default: `0.3` for factual synthesis). |
| `maxTokens` | `number` | No | Maximum completion tokens (default: derived from model). |

### RetryConfig

Retry policy parameters for transient LLM failures.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `maxRetries` | `number` | Yes | Maximum retry attempts for 429/5xx errors (default: `3`). |
| `initialDelayMs` | `number` | Yes | Initial retry delay in ms (default: `1000`). |
| `maxDelayMs` | `number` | Yes | Maximum retry delay cap in ms (default: `10000`). |
| `multiplier` | `number` | Yes | Exponential backoff multiplier (default: `2`). |
| `timeoutRetries` | `number` | Yes | Additional retries for timeout errors (default: `2`). |

### DigestResult (shared type — `src/shared/types/digest.ts`)

Consumed from shared types, not redefined here.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `answer` | `string` | Yes | Synthesized answer text. Non-empty in all returns including degradation. |
| `keyPoints` | `string[]` | Yes | Array of key point strings. May be empty. |
| `sources` | `SourceRef[]` | Yes | Array of cited sources. Non-empty in all returns. |

### SourceRef (shared type — `src/shared/types/digest.ts`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | Source URL. |
| `title` | `string` | Yes | Source page title. |

### ContentItem (shared type — `src/shared/types/content.ts`)

Input type received from PL after deduplication. Consumed from shared types.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | Yes | Page title from search/scrape. |
| `url` | `string` | Yes | Original or normalized URL. |
| `snippet` | `string` | Yes | Search-result snippet. |
| `score` | `number` | Yes | Relevance score [0.0–1.0]. |
| `content` | `string` | Yes | Extracted text content from scrape. |
| `normalizedUrl` | `string` | No | Normalized URL after dedup (if present). |
| `mergedSources` | `string[]` | No | URLs merged during dedup (if present). |

---

## API Endpoints

This module is a library consumed by PL; it does not expose HTTP endpoints. The following are the module's public function interfaces.

| Method | Signature | Request Parameters | Response | Maps To | Error Behavior |
|--------|-----------|-------------------|----------|---------|----------------|
| Function | `synthesize(query: string, contents: ContentItem[], focus?: string): Promise<DigestResult>` | `query` — search query; `contents` — deduplicated content items; `focus` — optional focus directive | `Promise<DigestResult>` with `answer`, `keyPoints`, `sources` | US-SY-003, US-SY-005, US-SY-006, US-SY-007, US-SY-008, US-SY-009, US-SY-010 | Never rejects; all errors → degradation fallback |
| Function | `synthesizeSingle(url: string, title: string, content: string, focus?: string): Promise<DigestResult>` | `url` — target URL; `title` — page title; `content` — scraped text; `focus` — optional focus directive | `Promise<DigestResult>` with `sources` containing exactly one entry | US-SY-004 | Never rejects; short content (<200 chars) or LLM failure → degradation fallback |

### Internal Function APIs (not exported to PL, used within module)

| Function | Signature | Maps To |
|----------|-----------|---------|
| `createLLMClient` | `(config: SynthesizeConfig) => OpenAIClient` | US-SY-001 |
| `verifyLLMConnectivity` | `(client: OpenAIClient) => Promise<boolean>` | US-SY-001 |
| `callLLMWithRetry` | `(client: OpenAIClient, systemPrompt: string, userPrompt: string, options?: LLMCallOptions) => Promise<LLMResponse>` | US-SY-006 |
| `buildSystemPrompt` | `() => string` | US-SY-002 |
| `buildUserPrompt` | `(query: string, contents: ContentItem[], focus?: string) => string` | US-SY-002 |
| `buildSingleSourcePrompt` | `(query: string, url: string, title: string, content: string, focus?: string) => string` | US-SY-002, US-SY-004 |
| `buildMergePrompt` | `(query: string, digests: DigestResult[], focus?: string) => { systemPrompt: string; userPrompt: string }` | US-SY-005 |
| `parseDigestResponse` | `(rawResponse: string, knownSources: SourceRef[]) => DigestResult` | US-SY-008 |
| `estimateTokens` | `(text: string) => number` | US-SY-009 |
| `batchAndMerge` | `(query: string, contents: ContentItem[], focus: string \| undefined, client: OpenAIClient, config: SynthesizeConfig) => Promise<DigestResult>` | US-SY-005 |
| `degradationFallback` | `(query: string, contents: ContentItem[], reason: string) => DigestResult` | US-SY-007 |
| `reconcileSources` | `(parsed: DigestResult, knownSources: SourceRef[]) => DigestResult` | US-SY-003 |

---

## Error Handling

### Error Response Philosophy

The SY module **never rejects a Promise** returned to PL. All internal errors are caught and converted to either a retry (for transient failures) or a degradation fallback (for unrecoverable failures). The only exception is `createLLMClient()` during initialization, which throws `LLMConfigError` if `LLM_API_KEY` is missing — but this occurs before any synthesis call and is surfaced at startup by MC.

### Internal Error Types (defined in `types.ts`)

All error classes extend `AppError` from `src/shared/utils/errors.ts`.

| Error Class | Category | Trigger | Retry? | Maps To |
|-------------|----------|---------|--------|---------|
| `LLMConfigError` | `config` | Missing/empty `LLM_API_KEY` | No — thrown at init | US-SY-001 |
| `LLMAuthError` | `http_error` | HTTP 401/403 from LLM API | No — immediate degrade | US-SY-006 |
| `LLMTimeoutError` | `timeout` | Request exceeds `LLM_TIMEOUT_MS` | Yes — up to `timeoutRetries` (2) | US-SY-006 |
| `LLMRateLimitError` | `http_error` | HTTP 429 from LLM API | Yes — exponential backoff | US-SY-006 |
| `LLMServerError` | `http_error` | HTTP 5xx from LLM API | Yes — exponential backoff | US-SY-006 |
| `LLMResponseError` | `parse_error` | Unparseable or empty LLM response | No — immediate degrade | US-SY-008 |
| `LLMNetworkError` | `network` | Connection refused, DNS failure, etc. | Yes — exponential backoff | US-SY-006 |

### Retry Logic (US-SY-006)

```
callLLMWithRetry(client, systemPrompt, userPrompt):
  attempt = 0
  loop:
    try:
      response = await client.chat.completions.create({...}) with AbortController(timeoutMs)
      if response.content is empty → throw LLMResponseError("empty response")
      return { content, promptTokens, completionTokens }
    catch error:
      if error is LLMAuthError (401/403):
        log "[SY] LLM auth failed — check LLM_API_KEY"
        throw error  // propagates to orchestrator → degradation
      
      if error is LLMRateLimitError or LLMServerError or LLMNetworkError:
        if attempt >= maxRetries (3):
          throw error
        delay = min(initialDelayMs * multiplier^attempt, maxDelayMs)
        log "[SY] retry {attempt+1}/{maxRetries}: {reason}"
        sleep(delay + jitter ±20%)
        attempt++
        continue
      
      if error is LLMTimeoutError:
        if attempt >= timeoutRetries (2):
          throw error
        log "[SY] retry {attempt+1}/{timeoutRetries}: timeout"
        sleep(initialDelayMs * multiplier^attempt)
        attempt++
        continue
      
      throw error  // unexpected error → propagates to orchestrator → degradation
```

### Degradation Fallback (US-SY-007)

When triggered, `degradationFallback(query, contents, reason)` constructs a `DigestResult` **without any LLM call**:

- **`answer`**: Truncated concatenation of top-ranked content snippets (sorted by descending `score`), max 2000 characters total, prefixed with `"[Note: LLM synthesis unavailable; showing truncated raw content.]"`.
- **`keyPoints`**: First sentence of each content item (max 10 items). First sentence detected by first `.` followed by whitespace or end-of-string.
- **`sources`**: All input source URLs and titles as `SourceRef[]`.
- Logs `[SY] degradation activated: {reason}`.

### Error Propagation to PL

| Scenario | SY Returns | PL Receives |
|----------|-----------|-------------|
| LLM call succeeds | `DigestResult` (LLM-synthesized) | `DigestResult` |
| All retries exhausted | `DigestResult` (degraded) | `DigestResult` — indistinguishable from success at the type level |
| LLM auth failure (401/403) | `DigestResult` (degraded) | `DigestResult` |
| Response parse failure | `DigestResult` (degraded with reason `"empty answer from LLM"`) | `DigestResult` |
| Empty contents input | `DigestResult` (degraded with reason `"no content to synthesize"`) | `DigestResult` |
| Unexpected internal exception | `DigestResult` (degraded with reason `"unexpected error: {message}"`) | `DigestResult` |

---

## Component Interfaces

### llm-client.ts

```typescript
/** Creates an OpenAI-compatible client instance configured from SynthesizeConfig. */
function createLLMClient(config: SynthesizeConfig): OpenAIClient;

/** Sends a minimal test prompt to verify LLM reachability. Returns true if reachable. */
function verifyLLMConnectivity(client: OpenAIClient, config: SynthesizeConfig): Promise<boolean>;

/**
 * Sends a chat completion request with built-in retry logic.
 * Retries on 429, 5xx, timeout, and network errors per RetryConfig.
 * Does NOT retry on 401/403 — throws LLMAuthError immediately.
 * Throws after all retries exhausted — caller must catch and degrade.
 */
function callLLMWithRetry(
  client: OpenAIClient,
  systemPrompt: string,
  userPrompt: string,
  config: SynthesizeConfig,
  options?: LLMCallOptions,
): Promise<LLMResponse>;
```

The `OpenAIClient` type is a thin wrapper interface around the `openai` SDK's `OpenAI` class to allow mocking:

```typescript
interface OpenAIClient {
  chat: {
    completions: {
      create(params: ChatCompletionCreateParams): Promise<ChatCompletionResponse>;
    };
  };
}
```

### prompt-builder.ts

```typescript
/** Builds the system prompt instructing the LLM to produce structured digests. */
function buildSystemPrompt(): string;

/** Builds the user prompt for multi-source synthesis with interleaved content + source metadata. */
function buildUserPrompt(query: string, contents: ContentItem[], focus?: string): string;

/** Builds the user prompt for single-source synthesis (web_fetch flow). */
function buildSingleSourcePrompt(
  query: string,
  url: string,
  title: string,
  content: string,
  focus?: string,
): string;

/** Builds system + user prompts for the merge step in batch-and-merge. */
function buildMergePrompt(
  query: string,
  digests: DigestResult[],
  focus?: string,
): { systemPrompt: string; userPrompt: string };
```

**System prompt structure:**

The system prompt instructs the LLM to:
1. Produce a `## Answer` section with a direct, concise, factual answer.
2. Produce a `## Key Points` section with bullet items (`-`).
3. Produce a `## Sources` section citing source URLs as markdown links `[title](url)`.
4. NOT hallucinate URLs — only cite URLs present in the provided content.
5. Be concise and factual; avoid repetition.

**User prompt structure (multi-source):**

```
Query: {query}
{Focus: {focus}\n if focus provided}

--- Source 1: {title1} ---
URL: {url1}
{content1}

--- Source 2: {title2} ---
URL: {url2}
{content2}

...

Synthesize the above sources into a structured digest answering the query.
Only cite URLs that appear in the sources above.
```

### response-parser.ts

```typescript
/**
 * Parses LLM free-text response into a structured DigestResult.
 * Multi-strategy: (1) structured markdown headers, (2) heuristic keyword proximity.
 * Reconciles parsed sources against knownSources — appends any missing.
 * If answer is empty after parsing → throws LLMResponseError("empty answer from LLM").
 */
function parseDigestResponse(rawResponse: string, knownSources: SourceRef[]): DigestResult;
```

**Parsing strategy 1 — Structured Markdown Headers:**

- Search for headers `## Answer`, `## Key Points`, `## Sources` (case-insensitive, optional leading `#`).
- Extract text between consecutive headers as section content.
- Parse `Key Points` section: split on lines matching `^\s*[-*]\s+` or `^\s*\d+\.\s+`, trim each item.
- Parse `Sources` section: extract markdown links `[title](url)` and bare URLs `https?://[^\s)]+`.

**Parsing strategy 2 — Heuristic Keyword Proximity (fallback):**

- If no `## Answer` header found, search for keywords: `answer:`, `answer`, `summary:`.
- Detect section boundaries by keyword + colon or keyword + newline.
- If no recognizable structure at all: entire response → `answer`, `keyPoints = []`.

**Source URL extraction regex:**

```
const URL_PATTERN = /(https?:\/\/[^\s\)\]]+)/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\((https?:\/\/[^\s\)]+)\)/g;
```

**Source reconciliation (`reconcileSources`):**

- Compare parsed source URLs against `knownSources` (the input content URLs).
- Append any `knownSources` entry whose URL is not present in the parsed sources.
- Deduplicate by URL string (case-insensitive on hostname+path).

### token-estimator.ts

```typescript
/**
 * Estimates token count for a text string using a heuristic:
 * - Detect CJK characters (Unicode ranges: Hiragana, Katakana, CJK Unified, Hangul).
 * - English/Latin: ~1 token per 4 characters.
 * - CJK: ~1 token per 1.5 characters.
 * - Mixed content: weighted average based on character composition ratio.
 * Returns a non-negative integer.
 */
function estimateTokens(text: string): number;
```

**Implementation detail:**

```typescript
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3040, 0x309F],   // Hiragana
  [0x30A0, 0x30FF],   // Katakana
  [0x3400, 0x4DBF],   // CJK Extension A
  [0x4E00, 0x9FFF],   // CJK Unified Ideographs
  [0xAC00, 0xD7AF],   // Hangul Syllables
  [0xF900, 0xFAFF],   // CJK Compatibility Ideographs
];

function isCJK(codePoint: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}
```

For each character: classify as CJK or non-CJK. Sum: `cjkCount / 1.5 + latinCount / 4`. Round up.

### batch-merger.ts

```typescript
/**
 * Handles token-overflow by splitting content items into batches,
 * synthesizing each batch, then merging intermediate digests.
 * Recursive: if the merge prompt itself overflows, re-batches the digests.
 */
function batchAndMerge(
  query: string,
  contents: ContentItem[],
  focus: string | undefined,
  client: OpenAIClient,
  config: SynthesizeConfig,
): Promise<DigestResult>;
```

**Algorithm:**

1. **`splitIntoBatches(contents, config)`**: Greedy bin-packing. Each `ContentItem` is wrapped with its source metadata. Target budget per batch = `floor(maxContextTokens * safeThresholdRatio) - estimatedSystemPromptTokens - estimatedMergeReserveTokens`. Iterate items in score-descending order, adding to the current batch until the next item would overflow, then start a new batch.
2. **Log**: `[SY] batching: {N} batches for {M} content items`.
3. **Process batches**: Sequential or limited-concurrent (max `maxBatchConcurrency`, default 2). Each batch → `buildUserPrompt()` → `callLLMWithRetry()` → `parseDigestResponse()` → collect `DigestResult[]`.
4. **Merge**: `buildMergePrompt(query, intermediateDigests, focus)` → `estimateTokens(mergePrompt)`.
   - If merge prompt ≤ threshold → single merge LLM call → parse → return.
   - If merge prompt > threshold → recursively split intermediate digests into sub-groups and merge hierarchically.

### degradation-handler.ts

```typescript
/**
 * Constructs a fallback DigestResult from raw input content WITHOUT calling the LLM.
 * answer: top-ranked snippet concatenation, max 2000 chars, prefixed with notice.
 * keyPoints: first sentence of each content item (max 10).
 * sources: all input source URLs and titles.
 */
function degradationFallback(
  query: string,
  contents: ContentItem[],
  reason: string,
): DigestResult;
```

**Content truncation for degradation answer (DC-SY-003):**

- Sort contents by descending `score`.
- Concatenate `content` fields with `\n\n` separator.
- Truncate at 2000 characters (word boundary) — subtracts the prefix length from the budget.
- Prefix: `"[Note: LLM synthesis unavailable; showing truncated raw content.]"`.

### synthesizer.ts

```typescript
/**
 * Multi-source synthesis entry point (web_search flow).
 * Orchestrates: prompt build → token estimate → single/batch routing → parse → source reconciliation.
 * Never rejects — all errors caught and converted to degradation.
 */
async function synthesize(
  query: string,
  contents: ContentItem[],
  focus?: string,
): Promise<DigestResult>;

/**
 * Single-source synthesis entry point (web_fetch flow).
 * If content < 200 chars → degradation. Otherwise → single LLM call with exactly one source.
 * Never rejects.
 */
async function synthesizeSingle(
  url: string,
  title: string,
  content: string,
  focus?: string,
): Promise<DigestResult>;
```

**`synthesize()` internal flow:**

```typescript
async function synthesize(query, contents, focus?): Promise<DigestResult> {
  const startTime = Date.now();
  log.info(`synthesis start: query="${truncate(query, 80)}", sources=${contents.length}, focus="${focus || 'none'}"`);

  try {
    if (contents.length === 0) {
      return degradationFallback(query, contents, "no content to synthesize");
    }

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(query, contents, focus);
    const totalTokens = estimateTokens(systemPrompt + userPrompt);
    const safeLimit = floor(config.maxContextTokens * config.safeThresholdRatio);

    log.info(`estimated tokens: ${totalTokens} (threshold: ${safeLimit})`);

    let result: DigestResult;

    if (totalTokens <= safeLimit) {
      const response = await callLLMWithRetry(client, systemPrompt, userPrompt, config);
      log.info(`synthesis tokens: ${response.promptTokens + response.completionTokens}`);
      result = parseDigestResponse(response.content, toSourceRefs(contents));
    } else {
      result = await batchAndMerge(query, contents, focus, client, config);
    }

    result = reconcileSources(result, toSourceRefs(contents));

    const elapsed = Date.now() - startTime;
    log.info(`synthesis done: duration=${elapsed}ms, batches=${batchesUsed}, degraded=false`);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error(`synthesis error: ${reason}, action=degrade`);
    const degraded = degradationFallback(query, contents, reason);
    const elapsed = Date.now() - startTime;
    log.info(`synthesis done: duration=${elapsed}ms, degraded=true`);
    return degraded;
  }
}
```

---

## Dependencies

### NPM Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `openai` | ^4.40.0 | OpenAI-compatible LLM client (supports custom `baseURL` for Azure/Ollama/vLLM). Listed in index.md under synthesize. |
| `zod` | ^3.22.0 | Runtime validation of LLM API response structure (optional internal use, not exported). Listed in index.md under mcp-server. |

No packages beyond those listed in index.md are required. The module uses only `openai` (for LLM communication) plus shared internal modules (`shared/types`, `shared/utils/logger`, `shared/utils/errors`, `shared/config`).

### Internal Dependencies

| Internal Module | Import Path | Purpose |
|----------------|-------------|---------|
| Shared Types | `../../shared/types/index.ts` | `ContentItem`, `DigestResult`, `SourceRef` |
| Logger | `../../shared/utils/logger.ts` | `log.info()`, `log.warn()`, `log.error()` — stderr-only |
| Errors | `../../shared/utils/errors.ts` | `AppError` base class, `ErrorCategory` type |
| Config | `../../shared/config/index.ts` | `appConfig` singleton with `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TIMEOUT_MS` |

### Environment Variables Consumed

| Variable | Default | Source | Description |
|----------|---------|--------|-------------|
| `LLM_API_KEY` | _(required, no default)_ | `shared/config` | API key for OpenAI-compatible endpoint |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | `shared/config` | LLM API base URL |
| `LLM_MODEL` | `gpt-4o-mini` | `shared/config` | Model identifier |
| `LLM_TIMEOUT_MS` | `60000` | `shared/config` | HTTP timeout per LLM call |
| `LLM_MAX_CONTEXT_TOKENS` | `128000` | Module-local default | Model context window size. Falls back to 128000 if unset. |

---

## File Generation Order

Files are listed in dependency order — each file imports only from files listed above it or from shared modules. All paths are under `src/modules/synthesize/` as defined in the project directory layout.

| # | File Path | Purpose | Depends On |
|---|-----------|---------|------------|
| 1 | `src/modules/synthesize/types.ts` | `SynthesizeConfig`, `LLMResponse`, `LLMCallOptions`, `RetryConfig`, error classes (`LLMConfigError`, `LLMAuthError`, `LLMTimeoutError`, `LLMRateLimitError`, `LLMServerError`, `LLMResponseError`, `LLMNetworkError`), `OpenAIClient` interface | `shared/utils/errors` (`AppError`), `shared/types` |
| 2 | `src/modules/synthesize/token-estimator.ts` | `estimateTokens()` — heuristic token counting with CJK awareness | (none — pure utility) |
| 3 | `src/modules/synthesize/llm-client.ts` | `createLLMClient()`, `verifyLLMConnectivity()`, `callLLMWithRetry()` — OpenAI SDK wrapper with retry logic and AbortController timeout | `types.ts`, `shared/config`, `shared/utils/logger` |
| 4 | `src/modules/synthesize/prompt-builder.ts` | `buildSystemPrompt()`, `buildUserPrompt()`, `buildSingleSourcePrompt()`, `buildMergePrompt()` — prompt construction with anti-hallucination directives | `shared/types` (`ContentItem`, `DigestResult`, `SourceRef`) |
| 5 | `src/modules/synthesize/response-parser.ts` | `parseDigestResponse()` — multi-strategy parser (structured headers → heuristic keyword proximity), URL extraction, bullet splitting, `reconcileSources()` | `shared/types` (`DigestResult`, `SourceRef`) |
| 6 | `src/modules/synthesize/degradation-handler.ts` | `degradationFallback()` — constructs fallback `DigestResult` from raw content without LLM call | `shared/types` (`ContentItem`, `DigestResult`, `SourceRef`), `shared/utils/logger` |
| 7 | `src/modules/synthesize/batch-merger.ts` | `batchAndMerge()`, `splitIntoBatches()` — token-overflow batch-and-merge with recursive merge | `types.ts`, `llm-client.ts`, `prompt-builder.ts`, `response-parser.ts`, `token-estimator.ts`, `shared/utils/logger`, `shared/types` |
| 8 | `src/modules/synthesize/synthesizer.ts` | `synthesize()`, `synthesizeSingle()` — public orchestrator functions tying all components together with degradation safety net | `types.ts`, `llm-client.ts`, `prompt-builder.ts`, `response-parser.ts`, `batch-merger.ts`, `degradation-handler.ts`, `token-estimator.ts`, `shared/config`, `shared/utils/logger`, `shared/types` |
| 9 | `src/modules/synthesize/index.ts` | Public API barrel — re-exports `synthesize`, `synthesizeSingle`, `verifyLLMConnectivity`, and types | `synthesizer.ts`, `llm-client.ts`, `types.ts` |

### User Story → File Mapping

| User Story | Primary Files |
|------------|---------------|
| US-SY-001 (Init & Validate) | `types.ts`, `llm-client.ts` |
| US-SY-002 (Prompt Construction) | `prompt-builder.ts` |
| US-SY-003 (Multi-Source Synthesis) | `synthesizer.ts`, `prompt-builder.ts`, `llm-client.ts`, `response-parser.ts` |
| US-SY-004 (Single-Source Synthesis) | `synthesizer.ts`, `prompt-builder.ts`, `degradation-handler.ts` |
| US-SY-005 (Batch-and-Merge) | `batch-merger.ts`, `token-estimator.ts` |
| US-SY-006 (Retry on Transient) | `llm-client.ts` |
| US-SY-007 (Graceful Degradation) | `degradation-handler.ts`, `synthesizer.ts` |
| US-SY-008 (Parse Structured Output) | `response-parser.ts` |
| US-SY-009 (Token Estimation) | `token-estimator.ts`, `synthesizer.ts` |
| US-SY-010 (Observability Logging) | `synthesizer.ts`, `llm-client.ts`, `batch-merger.ts`, `degradation-handler.ts` |
