# Requirements: LLM Synthesize

## Overview
The LLM Synthesize (SY) module is the "soul" of the research pipeline—it transforms deduplicated, multi-source web content into structured digests (Answer / Key Points / Sources) by interacting with an OpenAI-compatible LLM. It encapsulates all LLM communication concerns: prompt construction, response parsing, token-limit handling via batch-and-merge, retry logic, and graceful degradation. The module guarantees that callers always receive a structured digest—never raw web content—thereby protecting the agent's context window.

## User Stories

### US-SY-001: Initialize and Validate LLM Client
**As a** pipeline orchestrator, **I want** to initialize an OpenAI-compatible LLM client from environment variables, **so that** subsequent synthesis calls have a ready, validated connection.

**Acceptance Criteria:**
- WHEN the module is loaded THEN the system SHALL read `LLM_API_KEY`, `LLM_BASE_URL` (default: `https://api.openai.com/v1`), and `LLM_MODEL` (default: `gpt-4o-mini`) from environment variables
- WHEN `LLM_API_KEY` is missing or empty THEN the system SHALL throw a descriptive error containing the message `"LLM_API_KEY is required"` and NOT attempt any LLM calls
- WHEN all required environment variables are present THEN the system SHALL instantiate an OpenAI-compatible client with a configurable HTTP timeout (default: 60 seconds)
- WHEN the client is initialized THEN the system SHALL expose a health-check function `verifyLLMConnectivity()` that sends a minimal test prompt and returns a boolean indicating reachability

---

### US-SY-002: Construct Synthesis Prompts
**As a** pipeline orchestrator, **I want** the module to build well-structured system and user prompts, **so that** the LLM consistently produces structured digests with Answer, Key Points, and Sources.

**Acceptance Criteria:**
- WHEN a synthesis request is received THEN the system SHALL construct a system prompt that instructs the LLM to: (a) produce a direct "Answer" section, (b) list "Key Points" as bullet items, (c) include a "Sources" section citing source URLs, and (d) be concise and factual
- WHEN a `focus` parameter is provided THEN the system SHALL append a focus directive to the user prompt guiding the LLM to emphasize the specified aspect (e.g., "installation steps", "API usage", "version compatibility")
- WHEN constructing the user prompt THEN the system SHALL interleave each content block with its source URL and title so the LLM can cite sources accurately
- WHEN the prompt is assembled THEN the system SHALL include an explicit instruction to NOT hallucinate URLs and to only cite URLs present in the provided content

---

### US-SY-003: Synthesize Digest from Multiple Sources
**As a** pipeline orchestrator (web_search flow), **I want** to pass deduplicated content from multiple URLs along with a query, **so that** I receive a unified structured digest that synthesizes all sources.

**Acceptance Criteria:**
- WHEN `synthesize(query, contents[], focus?)` is called with 1–N content items THEN the system SHALL send a single LLM request containing the query, focus (if provided), and all content items with their source metadata
- WHEN the LLM returns a successful response THEN the system SHALL extract and return a `DigestResult` object containing `answer` (string), `keyPoints` (string array), and `sources` (array of `{url, title}`)
- WHEN the LLM response is received THEN the system SHALL log to stderr the total token usage (prompt tokens + completion tokens) in the format `[SY] synthesis tokens: {N}`
- IF any source URL from the input content is missing from the LLM's Sources section THEN the system SHALL append the missing sources to the `sources` array to ensure all referenced URLs are represented

**Interface:**
```
synthesize(query: string, contents: ContentItem[], focus?: string): Promise<DigestResult>
```

---

### US-SY-004: Synthesize Digest from Single Source
**As a** pipeline orchestrator (web_fetch flow), **I want** to synthesize a digest for a single known URL, **so that** the caller gets a focused summary of that specific page.

**Acceptance Criteria:**
- WHEN `synthesizeSingle(url, title, content, focus?)` is called THEN the system SHALL construct a prompt that asks the LLM to summarize the single page's key information
- WHEN the focus parameter is provided (e.g., "installation", "CHANGELOG") THEN the system SHALL instruct the LLM to prioritize extracting information relevant to that focus
- WHEN the LLM returns a successful response THEN the system SHALL return a `DigestResult` with the `sources` array containing exactly one entry: the input URL and its title
- IF the single content item is shorter than 200 characters THEN the system SHALL skip the LLM call and return a degradation result indicating "content too short for meaningful synthesis"

**Interface:**
```
synthesizeSingle(url: string, title: string, content: string, focus?: string): Promise<DigestResult>
```

---

### US-SY-005: Batch-and-Merge for Token Overflow
**As a** pipeline orchestrator, **I want** the module to automatically handle token-limit overflow by splitting content into batches, **so that** synthesis succeeds even when total content exceeds the model's context window.

**Acceptance Criteria:**
- WHEN the estimated token count of the assembled prompt exceeds the model's context limit (default threshold: 80% of model max tokens) THEN the system SHALL split content items into batches whose combined size fits within the threshold
- WHEN batching is triggered THEN the system SHALL log to stderr `[SY] batching: {N} batches for {M} content items`
- WHEN multiple batches are processed THEN the system SHALL send parallel or sequential LLM requests (configurable, default: sequential with max 2 concurrent) for each batch and collect intermediate digests
- WHEN all batch digests are collected THEN the system SHALL send a final "merge" LLM call that combines the intermediate digests into a single unified `DigestResult`, de-duplicating key points and merging source lists
- IF the merge call itself exceeds token limits THEN the system SHALL recursively batch-and-merge the intermediate digests until the result fits

---

### US-SY-006: Retry on Transient LLM Failures
**As a** pipeline orchestrator, **I want** the module to automatically retry transient LLM failures, **so that** momentary network blips or rate limits don't cause total synthesis failure.

**Acceptance Criteria:**
- WHEN the LLM call returns an HTTP 429 (rate limit) or HTTP 5xx error THEN the system SHALL retry the request with exponential backoff (initial delay: 1 second, multiplier: 2, max delay: 10 seconds, max retries: 3)
- WHEN the LLM call times out (exceeds the configured HTTP timeout) THEN the system SHALL retry up to 2 additional times
- WHEN all retry attempts are exhausted THEN the system SHALL invoke the graceful degradation fallback (US-SY-007) and NOT propagate the error to the caller
- WHEN a retry is attempted THEN the system SHALL log to stderr `[SY] retry {attempt}/{max}: {reason}`
- IF the LLM returns an HTTP 401 or HTTP 403 (authentication/authorization error) THEN the system SHALL NOT retry and SHALL immediately invoke degradation with a logged warning `[SY] LLM auth failed — check LLM_API_KEY`

---

### US-SY-007: Graceful Degradation Fallback
**As a** pipeline orchestrator, **I want** the module to provide a structured fallback when the LLM is completely unavailable, **so that** the pipeline always returns a usable result rather than failing entirely.

**Acceptance Criteria:**
- WHEN the degradation fallback is triggered THEN the system SHALL construct a `DigestResult` from the raw input content WITHOUT calling the LLM
- WHEN constructing the degradation result THEN the system SHALL populate `answer` with a truncated concatenation of the top-ranked content snippets (max 2000 characters total), prefixed with `"[Note: LLM synthesis unavailable; showing truncated raw content.]"`
- WHEN constructing the degradation result THEN the system SHALL populate `keyPoints` with the first sentence of each content item (max 10 items), and `sources` with all input source URLs and titles
- WHEN degradation is activated THEN the system SHALL log to stderr `[SY] degradation activated: {reason}`
- WHILE in degradation mode THEN the system SHALL ensure the returned `DigestResult` is structurally valid (non-empty answer, at least one source) so downstream consumers need no special handling

**Interface:**
```
degradationFallback(query: string, contents: ContentItem[], reason: string): DigestResult
```

---

### US-SY-008: Parse and Validate Structured LLM Output
**As a** pipeline orchestrator, **I want** the module to robustly parse the LLM's free-text response into a structured `DigestResult`, **so that** downstream consumers receive consistent, programmatically accessible data regardless of minor LLM formatting variations.

**Acceptance Criteria:**
- WHEN the LLM response is received THEN the system SHALL parse it using a multi-strategy parser: (1) attempt structured format (markdown headers `## Answer`, `## Key Points`, `## Sources`), (2) fallback to heuristic section detection by keyword proximity
- WHEN parsing the "Key Points" section THEN the system SHALL split bullet items (lines starting with `-`, `*`, or numbered) into an array of individual point strings, trimming whitespace
- WHEN parsing the "Sources" section THEN the system SHALL extract URLs using a URL regex pattern and pair each with the nearest preceding title text
- IF the LLM response does not contain a recognizable "Answer" section THEN the system SHALL treat the entire response as the answer and set `keyPoints` to an empty array
- IF the parsed result has an empty `answer` field THEN the system SHALL invoke the degradation fallback (US-SY-007) with reason `"empty answer from LLM"`

**Interface:**
```
parseDigestResponse(rawResponse: string, knownSources: SourceRef[]): DigestResult
```

---

### US-SY-009: Estimate Token Count and Manage Context Budget
**As a** pipeline orchestrator, **I want** the module to estimate token counts before sending requests, **so that** it can proactively decide between single-call and batch-and-merge strategies.

**Acceptance Criteria:**
- WHEN a prompt is assembled THEN the system SHALL estimate the token count using a heuristic (approximately 1 token per 4 characters for English, 1 token per 1.5 characters for CJK content) or an installed tokenizer if available
- WHEN the estimated token count is within the safe threshold (≤80% of model context limit) THEN the system SHALL proceed with a single LLM call (US-SY-003)
- WHEN the estimated token count exceeds the safe threshold THEN the system SHALL route to the batch-and-merge flow (US-SY-005)
- WHEN a token estimate is computed THEN the system SHALL log to stderr `[SY] estimated tokens: {N} (threshold: {M})`

**Interface:**
```
estimateTokens(text: string): number
```

---

### US-SY-010: Log Synthesis Observability Metrics
**As a** a developer/operator, **I want** the module to emit structured logs for every synthesis operation, **so that** I can monitor performance, debug failures, and track token costs.

**Acceptance Criteria:**
- WHEN any synthesis operation starts THEN the system SHALL log to stderr `[SY] synthesis start: query="{truncated_query}", sources={N}, focus="{focus||'none'}"`
- WHEN a synthesis operation completes successfully THEN the system SHALL log to stderr `[SY] synthesis done: duration={ms}ms, tokens={prompt+completion}, batches={N}, degraded={true|false}`
- WHEN an error occurs during synthesis THEN the system SHALL log to stderr `[SY] synthesis error: {error_message}, action={retry|degrade}`
- WHILE logging THEN the system SHALL write exclusively to stderr and SHALL NOT write to stdout (which is reserved for MCP JSON-RPC communication)
- WHEN logging query text THEN the system SHALL truncate the query to 80 characters to avoid log noise

## Business Goals

### BG-SY-001: Synthesis Latency Efficiency
- Description: The synthesis step should complete quickly enough to keep the overall web_search pipeline under the 30-second end-to-end target
- Metric: Time from `synthesize()` call to `DigestResult` return, measured in milliseconds, averaged across 100 real-world queries
- Target: P50 ≤ 8 seconds, P95 ≤ 15 seconds (excluding batch-and-merge scenarios)

### BG-SY-002: Synthesis Output Quality
- Description: Digests should be structured, accurate, and cite real sources—never hallucinated
- Metric: Percentage of digests where: (a) answer is non-empty, (b) ≥1 key point present, (c) all cited URLs exist in the input source set
- Target: ≥ 95% of non-degraded digests pass all three quality checks

### BG-SY-003: Degradation Resilience
- Description: The module should never cause a total pipeline failure due to LLM unavailability; degradation should always produce a usable fallback
- Metric: Percentage of synthesis calls that return a valid `DigestResult` (non-null, structurally complete) regardless of LLM availability
- Target: 100% — zero unhandled exceptions propagated to the caller

## Non-Functional Requirements

### NFR-SY-001: Synthesis Response Time
- Category: performance
- Description: Single-call synthesis (no batching) SHALL complete within 20 seconds including network latency; batch-and-merge SHALL complete within 45 seconds for up to 8 content items
- Priority: critical

### NFR-SY-002: Error Isolation Completeness
- Category: reliability
- Description: The module SHALL catch all exceptions from LLM calls, prompt construction, and response parsing, converting every error path into either a retry or a degradation result—no exception shall propagate to the pipeline orchestrator
- Priority: critical

### NFR-SY-003: API Key Protection
- Category: security
- Description: The `LLM_API_KEY` SHALL never appear in any log output (stderr), error message, or returned `DigestResult`. The key SHALL be passed only to the OpenAI-compatible client's authorization header
- Priority: critical

### NFR-SY-004: Output Format Consistency
- Category: usability
- Description: Every `DigestResult` returned (including degradation results) SHALL conform to the same TypeScript interface with non-empty `answer` (string), `keyPoints` (string array, possibly empty), and `sources` (non-empty array of `{url, title}`)
- Priority: important

### NFR-SY-005: Token Budget Awareness
- Category: performance
- Description: The module SHALL proactively estimate token counts before LLM calls and SHALL NOT send requests that knowingly exceed the model's context window, preventing wasted API calls and hard failures
- Priority: important

### NFR-SY-006: Configurable Timeouts
- Category: reliability
- Description: The LLM HTTP timeout SHALL be configurable via an environment variable `LLM_TIMEOUT_MS` (default: 60000), and the module SHALL enforce this timeout strictly using AbortController or equivalent
- Priority: important

## Design Constraints

### DC-SY-001: OpenAI-Compatible API Only
- Description: The module SHALL interact with the LLM exclusively through the OpenAI Chat Completions API format (`POST /v1/chat/completions` with `messages` array). No vendor-specific SDKs beyond an OpenAI-compatible client. Must work with any OpenAI-compatible endpoint (OpenAI, Azure OpenAI, Ollama, vLLM, LM Studio, etc.)
- Severity: critical

### DC-SY-002: Environment Variable Configuration
- Description: All LLM configuration (`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TIMEOUT_MS`) SHALL be sourced exclusively from environment variables. No config files, no hardcoded values beyond documented defaults
- Severity: critical

### DC-SY-003: No Raw Content in Module Output
- Description: The `DigestResult` returned by this module SHALL contain only synthesized/summarized text—never the full raw web content from input. In degradation mode, content SHALL be truncated to ≤2000 characters total to enforce this constraint
- Severity: critical

### DC-SY-004: TypeScript Strict Mode
- Description: All module code SHALL compile under TypeScript strict mode (`tsc --noEmit`) with zero errors. The `DigestResult`, `ContentItem`, and `SourceRef` interfaces SHALL be explicitly typed and exported
- Severity: important

### DC-SY-005: Zero stdout Pollution
- Description: The module SHALL NOT write anything to stdout. All diagnostic logging SHALL go to stderr, because stdout is reserved for MCP JSON-RPC transport
- Severity: critical