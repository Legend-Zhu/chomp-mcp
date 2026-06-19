Now I have the full picture. Let me compare the existing directory tree against all module file lists.

**Source files:** All `src/` files from every module's File Generation Order are already present in the tree. No missing source files, and no directory naming inconsistencies (all modules use the same kebab-case conventions).

**Test files:** The `tests/` section currently only lists empty module directories. I need to expand it with all the explicitly-listed test files from the deduplicate, pipeline-orchestration, scrape-extract, and search-retrieval modules. The mcp-server and synthesize modules did not list any test files, so I will not invent any.

Here is the complete updated index.md:

---

# Design Overview: Web Research MCP Server

## System Architecture

The system is a **single-process MCP (Model Context Protocol) server** that exposes two tools — `web_search` and `web_fetch` — to MCP-compliant clients over stdio JSON-RPC. Internally, it implements a multi-stage research pipeline.

```
┌──────────────────────────────────────────────────────────────┐
│                     MCP Client (scdd-agent)                   │
│                  communicates over stdio JSON-RPC             │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  Module: MCP Server (MC)                                      │
│  - StdioServerTransport, tool registration, request dispatch  │
│  - Validates params, formats MCP content-array responses      │
│  - ALL logging to stderr; stdout = JSON-RPC only              │
└──────────────────────────┬───────────────────────────────────┘
                           │ runWebSearch / runWebFetch
┌──────────────────────────▼───────────────────────────────────┐
│  Module: Pipeline Orchestration (PL)                          │
│  - Coordinates stage ordering, concurrency limits, timeouts   │
│  - Isolates per-URL failures, provides graceful degradation   │
│  - Stateless across invocations                                │
└──┬──────────┬──────────┬──────────┬───────────┬──────────────┘
   │          │          │          │           │
   ▼          ▼          ▼          ▼           ▼
┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────────┐
│  SR  │  │  SC  │  │  DD  │  │  SY  │  │  Shared  │
│Search│→ │Scrape│→ │Dedup │→ │Synth │  │  Types & │
│Retr. │  │Extr. │  │Denoise│  │  LLM │  │  Utils   │
└──────┘  └──────┘  └──────┘  └──────┘  └──────────┘
```

**Pipeline Flows:**
- `web_search`: SR.search → SC.scrape (concurrent, max N) → DD.deduplicate → SY.synthesize → digest
- `web_fetch`: SC.scrape → SY.synthesizeSingle → digest

**Key architectural principles:**
1. **Module boundary discipline** — PL delegates all I/O to SR/SC/DD/SY; MC delegates all business logic to PL. No module reaches across boundaries.
2. **Dependency injection** — MC receives PL functions via factory parameters (not direct import) to enable unit testing.
3. **Fail-safe degradation** — Every stage has a fallback path; the pipeline never returns an empty result if any data was gathered.
4. **stderr-only logging** — stdout is reserved exclusively for MCP JSON-RPC; all diagnostics go to stderr.
5. **Environment-variable-only configuration** — no config files; all tuning via env vars with documented defaults.

## Technology Stack

**Language:** TypeScript (strict mode, ESM)
**Runtime:** Node.js 18 LTS
**Framework:** `@modelcontextprotocol/sdk` (MCP server framework)
**Paradigm:** Async/await, functional-first, no shared mutable state

### Version Pinning (MANDATORY)

- **Language:** TypeScript 5.4.x
- **Runtime:** Node.js 18.19.x (Node.js 18 LTS)
- **Module system:** ESM (`"type": "module"`, `import`/`export` — CommonJS prohibited)
- **Module resolution:** NodeNext
- **TS compilation target:** ES2022
- **MCP SDK:** `@modelcontextprotocol/sdk` 1.0.x
- **HTML/DOM processing:** `cheerio` 1.0.x, `jsdom` 24.x, `@mozilla/readability` 0.5.x
- **Browser automation:** `puppeteer` 22.6.x
- **Encoding:** `iconv-lite` 0.6.x
- **LLM client:** `openai` 4.40.x (configured with custom `baseURL` for OpenAI-compatible endpoints)
- **Schema validation:** `zod` 3.22.x

### Package Dependencies (MANDATORY)

| Package | Version | Module(s) | Purpose |
|---------|---------|-----------|---------|
| `@modelcontextprotocol/sdk` | ^1.0.0 | mcp-server | MCP protocol: Server, StdioServerTransport, type definitions |
| `openai` | ^4.40.0 | synthesize | OpenAI-compatible LLM client (supports custom baseURL for Azure/Ollama/vLLM) |
| `cheerio` | ^1.0.0 | scrape-extract | HTML parsing and DOM manipulation |
| `jsdom` | ^24.0.0 | scrape-extract | DOM construction for `@mozilla/readability` compatibility in Node.js |
| `@mozilla/readability` | ^0.5.0 | scrape-extract | Main-content extraction from HTML (strips boilerplate) |
| `puppeteer` | ^22.6.0 | scrape-extract | Headless-browser fallback for JS-rendered SPA pages |
| `iconv-lite` | ^0.6.3 | scrape-extract | Character-encoding detection and conversion (GBK, Shift-JIS, Big5, etc.) |
| `zod` | ^3.22.0 | mcp-server | Runtime validation of tool-call parameters against JSON Schema |
| `typescript` | ^5.4.0 | (dev — all modules) | TypeScript compiler (`tsc --noEmit` for type-checking) |
| `tsx` | ^4.7.0 | (dev — all modules) | TypeScript execution for development/testing |
| `@types/node` | ^18.19.0 | (dev — all modules) | Node.js type definitions |
| `@types/jsdom` | ^21.1.0 | (dev — scrape-extract) | TypeScript types for jsdom |

**NOT used (explicitly prohibited by requirements):**
- No `axios`, `got`, or other HTTP client libraries — native `fetch` (available in Node.js 18+) is used for all HTTP.
- No config-file libraries (dotenv, convict, etc.) — `process.env` read directly.
- No paid search APIs (Tavily, SerpAPI, Google CSE) — SearXNG only.

## Naming Conventions

### Directories
- **Module directories:** kebab-case (`mcp-server`, `pipeline-orchestration`, `search-retrieval`, `scrape-extract`, `deduplicate`, `synthesize`)
- **Shared directories:** kebab-case (`shared/types`, `shared/utils`, `shared/config`)

### Files
- **All source files:** kebab-case with `.ts` extension (e.g., `url-normalizer.ts`, `llm-client.ts`, `tool-definitions.ts`)
- **Entry point:** `src/index.ts`
- **Module public API barrel:** `index.ts` inside each module directory

### TypeScript Identifiers
- **Interfaces / Types:** PascalCase (e.g., `SearchResult`, `ScrapeResult`, `DigestResult`, `ContentItem`, `SourceRef`, `PipelineConfig`)
- **Functions:** camelCase (e.g., `runWebSearch`, `deduplicate`, `synthesize`, `scrape`, `search`)
- **Constants:** UPPER_SNAKE_CASE (e.g., `DEFAULT_MAX_CONCURRENCY`, `TRACKING_PARAM_BLOCKLIST`)
- **Error classes:** PascalCase suffixed with `Error` (e.g., `SearchTimeoutError`, `ValidationError`)
- **Enums:** PascalCase type name, PascalCase members

### Environment Variables
- UPPER_SNAKE_CASE, prefixed by domain where appropriate (e.g., `SEARXNG_URL`, `LLM_API_KEY`, `SCRAPE_TIMEOUT_MS`, `MAX_CONCURRENCY`, `PIPELINE_TIMEOUT_MS`, `DEDUP_SIMILARITY_THRESHOLD`)

### Import Style
- Named imports only (`import { Server } from '@modelcontextprotocol/sdk/server/...'`)
- No default imports except for CommonJS interop with `cheerio` / `iconv-lite` where required
- Import order: (1) Node built-ins, (2) external packages, (3) internal shared, (4) internal module

## Directory Structure

```
chomp-mcp/
├── package.json
├── tsconfig.json
├── README.md
├── .gitignore
├── src/
│   ├── index.ts                               # Main entry point — bootstraps MCP server
│   │
│   ├── shared/                                # Cross-module shared code
│   │   ├── types/
│   │   │   ├── index.ts                       # Re-exports all shared types
│   │   │   ├── search.ts                      # SearchResult, SearchOptions
│   │   │   ├── scrape.ts                      # ScrapeResult, ExtractionMethod
│   │   │   ├── content.ts                     # ContentItem (enriched search result with content)
│   │   │   ├── deduplicate.ts                 # DeduplicatedItem, DDConfig
│   │   │   ├── digest.ts                      # DigestResult, SourceRef
│   │   │   └── pipeline.ts                    # PipelineConfig, PipelineResult, StageLog
│   │   ├── utils/
│   │   │   ├── logger.ts                      # stderr-only structured logger
│   │   │   ├── env.ts                         # Env var parsing with defaults + validation
│   │   │   ├── semaphore.ts                   # Async concurrency limiter
│   │   │   ├── errors.ts                      # Base AppError class + error category types
│   │   │   └── url-utils.ts                   # URL validation, SSRF check helpers
│   │   └── config/
│   │       └── index.ts                       # Centralized config from env vars, exported singleton
│   │
│   └── modules/
│       ├── mcp-server/                        # MC — MCP protocol entry point
│       │   ├── index.ts                       # Public exports: createServer()
│       │   ├── server.ts                      # Server lifecycle, StdioServerTransport setup
│       │   ├── tool-definitions.ts            # web_search + web_fetch tool schemas
│       │   ├── tool-handlers.ts               # Tool-call dispatch to PL functions
│       │   └── validation.ts                  # Zod-based parameter validation
│       │
│       ├── pipeline-orchestration/            # PL — end-to-end pipeline coordinator
│       │   ├── index.ts                       # Public exports: runWebSearch(), runWebFetch()
│       │   ├── orchestrator.ts                # Top-level pipeline entry functions
│       │   ├── web-search-pipeline.ts         # Search → Scrape → Dedup → Synthesize flow
│       │   ├── web-fetch-pipeline.ts          # Scrape → Synthesize flow
│       │   ├── concurrency-limiter.ts         # Semaphore-based MAX_CONCURRENCY enforcement
│       │   └── timeout-guard.ts               # Overall pipeline timeout with AbortController
│       │
│       ├── search-retrieval/                  # SR — SearXNG meta-search client
│       │   ├── index.ts                       # Public exports: search(), SearchResult, errors
│       │   ├── searxng-client.ts              # HTTP GET to SearXNG /search endpoint
│       │   ├── response-parser.ts             # JSON response → normalized results
│       │   ├── result-normalizer.ts           # Score normalization, dedup, truncation
│       │   ├── retry-failover.ts              # Exponential backoff + multi-instance failover
│       │   ├── instance-pool.ts               # Built-in public instance list + rotation
│       │   └── errors.ts                      # SearchError, SearchTimeoutError, etc.
│       │
│       ├── scrape-extract/                    # SC — URL → clean text content
│       │   ├── index.ts                       # Public exports: scrape(), ScrapeResult
│       │   ├── scraper.ts                     # Main scrape orchestrator (primary → fallback)
│       │   ├── http-fetcher.ts                # Native fetch with redirect following, timeout
│       │   ├── content-extractor.ts           # jsdom + Readability extraction pipeline
│       │   ├── puppeteer-renderer.ts          # Headless-browser fallback for JS pages
│       │   ├── encoding-detector.ts           # Charset detection + iconv-lite conversion
│       │   ├── content-type-router.ts         # Route by Content-Type (HTML/JSON/XML/text/binary)
│       │   ├── truncator.ts                   # Word-boundary truncation at MAX_CONTENT_CHARS
│       │   ├── url-validator.ts               # URL format + SSRF private-IP validation
│       │   └── types.ts                       # ScrapeOptions, ScrapeConfig
│       │
│       ├── deduplicate/                       # DD — Pure dedup/denoise transformation
│       │   ├── index.ts                       # Public exports: deduplicate(), DeduplicatedItem
│       │   ├── deduplicator.ts                # Full pipeline entry (URL dedup → content dedup)
│       │   ├── url-normalizer.ts              # Tracking-param strip, scheme/port/fragment unify
│       │   ├── paragraph-segmenter.ts         # Split text → paragraph segments
│       │   ├── fingerprinter.ts               # FNV-1a 32-bit hash → fingerprint sets
│       │   ├── similarity-computer.ts         # Jaccard similarity on fingerprint sets
│       │   ├── content-merger.ts              # Group + merge near-duplicates, retain best
│       │   ├── stats.ts                       # DedupStats accumulator + stderr summary
│       │   └── types.ts                       # DDConfig, DedupStats
│       │
│       └── synthesize/                        # SY — LLM synthesis → structured digest
│           ├── index.ts                       # Public exports: synthesize(), synthesizeSingle()
│           ├── synthesizer.ts                 # Main synthesis orchestrator
│           ├── llm-client.ts                  # OpenAI-compatible client init + health check
│           ├── prompt-builder.ts              # System + user prompt construction
│           ├── response-parser.ts             # Multi-strategy digest parsing from LLM text
│           ├── batch-merger.ts                # Token-overflow batch-and-merge logic
│           ├── degradation-handler.ts         # Fallback DigestResult from raw content
│           ├── token-estimator.ts             # Heuristic token counting (EN/CJK aware)
│           └── types.ts                       # SynthesizeConfig, LLMResponse
│
└── tests/                                     # Test files (mirror src/ structure)
    ├── shared/
    └── modules/
        ├── mcp-server/
        ├── pipeline-orchestration/
        │   ├── timeout-guard.test.ts
        │   ├── concurrency-limiter.test.ts
        │   ├── web-search-pipeline.test.ts
        │   ├── web-fetch-pipeline.test.ts
        │   └── orchestrator.test.ts
        ├── search-retrieval/
        │   ├── errors.test.ts
        │   ├── instance-pool.test.ts
        │   ├── searxng-client.test.ts
        │   ├── response-parser.test.ts
        │   ├── result-normalizer.test.ts
        │   └── retry-failover.test.ts
        ├── scrape-extract/
        │   ├── url-validator.test.ts
        │   ├── encoding-detector.test.ts
        │   ├── truncator.test.ts
        │   ├── content-type-router.test.ts
        │   ├── content-extractor.test.ts
        │   ├── http-fetcher.test.ts
        │   └── scraper.test.ts
        ├── deduplicate/
        │   ├── url-normalizer.test.ts
        │   ├── paragraph-segmenter.test.ts
        │   ├── fingerprinter.test.ts
        │   ├── similarity-computer.test.ts
        │   ├── content-merger.test.ts
        │   └── deduplicator.test.ts
        └── synthesize/
```

## Shared Components

### Shared Types (`src/shared/types/`)

All inter-module data contracts are defined here. Every module imports these types — no module defines its own version of a shared type.

| Type | Defined In | Used By | Shape |
|------|-----------|---------|-------|
| `SearchResult` | `search.ts` | SR → PL | `{ title: string; url: string; snippet: string; score: number }` |
| `SearchOptions` | `search.ts` | PL → SR | `{ maxResults?: number; timeoutMs?: number; categories?: string }` |
| `ScrapeResult` | `scrape.ts` | SC → PL | `{ success, url, finalUrl, title, textContent, extractionMethod, truncated, contentLength, elapsedMs, error }` |
| `ContentItem` | `content.ts` | PL internal, DD, SY | `{ title, url, snippet, score, content }` — enriched result after scrape |
| `DeduplicatedItem` | `deduplicate.ts` | DD → PL → SY | `{ normalizedUrl, content, score, mergedSources, fingerprintCount }` |
| `DigestResult` | `digest.ts` | SY → PL → MC | `{ answer: string; keyPoints: string[]; sources: SourceRef[] }` |
| `SourceRef` | `digest.ts` | SY, PL | `{ url: string; title: string }` |
| `PipelineConfig` | `pipeline.ts` | PL, MC | `{ maxConcurrency, scrapeTimeoutMs, maxContentChars, pipelineTimeoutMs }` |
| `DDConfig` | `deduplicate.ts` | DD | `{ similarityThreshold, minParagraphChars, extraTrackingParams }` |

### Shared Utilities (`src/shared/utils/`)

| Utility | File | Description |
|---------|------|-------------|
| `logger` | `logger.ts` | Structured stderr logger. Provides `log.info()`, `log.warn()`, `log.error()` with module prefix. **Never writes to stdout.** |
| `env` | `env.ts` | Functions to parse env vars: `envInt(key, default)`, `envFloat(key, default)`, `envString(key, default)`, `envList(key, default)`. All validate and warn on invalid values. |
| `semaphore` | `semaphore.ts` | `Semaphore` class implementing `acquire(): Promise<ReleaseFunction>` for concurrency limiting. |
| `errors` | `errors.ts` | Base `AppError` abstract class with `category` field (`http_error`, `timeout`, `network`, `parse_error`, `validation`, `config`). All custom errors extend this. |
| `url-utils` | `url-utils.ts` | `isPrivateIP(hostname)`, `validateHttpUrl(url)` — shared SSRF protection and URL validation used by SC and SR. |

### Shared Config (`src/shared/config/`)

| Config | File | Description |
|--------|------|-------------|
| `appConfig` | `index.ts` | Centralized singleton that reads all environment variables at startup. Exposes a frozen `AppConfig` object consumed by PL, MC, and individual modules. Contains all defaults. |

**Environment variables resolved in shared config:**

| Variable | Default | Consumer Module(s) |
|----------|---------|-------------------|
| `LLM_API_KEY` | _(required, no default)_ | MC (startup check), SY |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | SY |
| `LLM_MODEL` | `gpt-4o-mini` | SY |
| `LLM_TIMEOUT_MS` | `60000` | SY |
| `SEARXNG_URL` | _(unset → public instances)_ | SR |
| `SEARXNG_TIMEOUT_MS` | `10000` | SR |
| `SEARXNG_MAX_RETRIES` | `2` | SR |
| `SEARXNG_RETRY_BASE_MS` | `500` | SR |
| `SCRAPE_TIMEOUT_MS` | `15000` | SC, PL |
| `MAX_CONTENT_CHARS` | `8000` | SC, PL |
| `MAX_CONCURRENCY` | `3` | PL |
| `PIPELINE_TIMEOUT_MS` | `30000` | PL |
| `DEDUP_SIMILARITY_THRESHOLD` | `0.85` | DD |
| `MIN_PARAGRAPH_CHARS` | `20` | DD |
| `DEDUP_EXTRA_TRACKING_PARAMS` | _(empty)_ | DD |

## Cross-Module Dependencies

### Dependency Graph (compile-time imports)

```
index.ts
  └→ modules/mcp-server
       └→ modules/pipeline-orchestration
            ├→ modules/search-retrieval
            ├→ modules/scrape-extract
            ├→ modules/deduplicate
            └→ modules/synthesize
  All modules → shared/types, shared/utils, shared/config
```

### Data Flow Contracts

The PL module is the sole integrator. Each processing module exposes a minimal public API; PL calls them in strict sequential order. No processing module imports another processing module.

**1. SR → PL:**
- PL calls: `search(query: string, options?: SearchOptions): Promise<SearchResult[]>`
- SR returns: `SearchResult[]` — `{ title, url, snippet, score }[]`, sorted by descending score, max `maxResults` items.

**2. PL → SC (per URL, concurrent):**
- PL calls: `scrape(url: string): Promise<ScrapeResult>` for each URL from SR results
- SC returns: `ScrapeResult` — always resolves (never rejects for expected failures); `{ success, url, finalUrl, title, textContent, extractionMethod, truncated, contentLength, elapsedMs, error }`
- PL filters: only items where `success === true` proceed.

**3. PL enriches → DD:**
- PL constructs `ContentItem[]` from successful scrape results: maps `ScrapeResult` fields + original `SearchResult` metadata.
- PL calls: `deduplicate(items: ContentItem[], config?: DDConfig): ContentItem[]`
- DD returns: filtered `ContentItem[]` with `normalizedUrl`, `mergedSources`, `fingerprintCount` populated. Pure function, no side effects except stderr logging.

**4. DD → PL → SY:**
- PL calls: `synthesize(query: string, contents: ContentItem[], focus?: string): Promise<DigestResult>` (web_search)
- PL calls: `synthesizeSingle(url: string, title: string, content: string, focus?: string): Promise<DigestResult>` (web_fetch)
- SY returns: `DigestResult` — `{ answer, keyPoints, sources }`. Always resolves (never rejects — internal errors trigger degradation fallback).

**5. PL → MC:**
- PL returns: `string` — the formatted digest (rendered from `DigestResult` into a text string with Answer / Key Points / Sources sections).
- MC wraps: in MCP `CallToolResult` content array `{ type: "text", text: digest }`.

### Dependency Injection Boundary

The MC module does **not** import PL directly. Instead, `src/index.ts` constructs the PL functions and injects them into `createServer({ runWebSearch, runWebFetch })`. This enables:
- Unit testing MC with mock orchestration functions.
- Clean module boundaries enforced at the import level.

### Error Propagation Rules

| Layer | Error Handling |
|-------|---------------|
| SR | Throws typed errors (`SearchTimeoutError`, `SearchUnavailableError`, etc.). PL catches and may abort pipeline with user-facing error. |
| SC | **Never throws** for expected failures — returns `ScrapeResult` with `success: false`. PL isolates per-URL. |
| DD | **Never throws** — catches per-item errors, logs to stderr, skips bad items. |
| SY | **Never throws** — all errors trigger degradation fallback returning a valid `DigestResult`. |
| PL | Catches all errors from SR/SC/DD/SY. Constructs fallback responses. The only module that can decide to return a partial/degraded result vs. propagate an error to MC. |
| MC | Catches PL errors, formats as MCP `isError: true` responses. Never crashes the server process. |