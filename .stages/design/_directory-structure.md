# Project Directory Layout (BINDING)

This file is auto-extracted from index.md. It is the CANONICAL directory tree — every module design and every generated file MUST place its paths under one of the directories listed here. Naming conventions are uniform across all modules.

IMPORTANT: The output directory itself IS the project root. Do NOT nest files under an extra project-name folder. All paths below are relative to the output directory.

## Directory Structure

```
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
