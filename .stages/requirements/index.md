# Requirements Overview: chomp-mcp

## Project Summary

chomp-mcp is a Model Context Protocol (MCP) server that provides "out-of-the-box, digest-built-in" web research capabilities for LLM agents and any MCP-compliant client. It implements a four-stage pipeline (Search → Scrape → Deduplicate → LLM-Synthesize) that takes a user query or URL and returns a structured, refined summary — never raw page content — preventing context pollution. The server exposes two tools (`web_search` and `web_fetch`) and relies on zero-cost, zero-API-key infrastructure (SearXNG meta-search, cheerio/Readability extraction, Puppeteer fallback) with the only paid dependency being the caller-configured LLM for final synthesis.

## Module Map

| Module | Description | Key User Stories |
|--------|-------------|------------------|
| **SR** (search-retrieval) | Calls SearXNG meta-search engine, parses JSON responses, normalizes results into unified candidate structure (title/url/snippet/score). Handles timeout, retry, and failover for public or self-hosted instances. | US-SR-001, US-SR-002, US-SR-003, US-SR-004 |
| **SC** (scrape-extract) | Converts URLs to clean text via cheerio + Readability primary path with Puppeteer fallback for JS-rendered pages. Handles HTTP errors, encoding detection, content truncation, and non-HTML resources. | US-SC-001, US-SC-002, US-SC-003, US-SC-004, US-SC-005 |
| **DD** (deduplicate) | Performs URL normalization (strip tracking params, unify scheme/case, remove fragments) and content-level deduplication via paragraph fingerprinting and similarity-threshold merging. | US-DD-001, US-DD-002, US-DD-003 |
| **SY** (synthesize) | Interacts with an OpenAI-compatible LLM to produce structured digests (Answer / Key Points / Sources). Manages prompts, token limits via batch-and-merge, failure handling, and graceful degradation. | US-SY-001, US-SY-002, US-SY-003, US-SY-004 |
| **PL** (pipeline-orchestration) | Orchestrates the full Search→Scrape→Deduplicate→Synthesize flow for `web_search` and the Scrape→Synthesize sub-flow for `web_fetch`. Manages concurrency limits, overall timeouts, and per-URL error isolation. | US-PL-001, US-PL-002, US-PL-003, US-PL-004 |
| **MC** (mcp-server) | Manages MCP server lifecycle over stdio transport: JSON-RPC message handling, tool definition registration (`web_search` / `web_fetch` input schemas), call dispatch, and MCP-standard content-array response formatting. | US-MC-001, US-MC-002, US-MC-003, US-MC-004 |

## Cross-Cutting Concerns

- **Configuration via Environment Variables Only** — No config files; all settings (`SEARXNG_URL`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `SCRAPE_TIMEOUT_MS`, `MAX_CONTENT_CHARS`, `MAX_CONCURRENCY`) are injected through environment variables.
- **Zero API-Key External Dependencies** — No paid third-party APIs beyond the caller-configured LLM. SearXNG public instances work out of the box with a self-hosting upgrade path.
- **Graceful Error Isolation** — Every external call (SearXNG, page scrape, LLM) must have timeout, retry, and failure isolation. A single point failure never breaks the entire pipeline. LLM synthesis failure degrades to structured concatenation of truncated scraped content rather than total failure.
- **Stderr-Only Logging** — All diagnostic logs (result counts, page counts, dedup counts, token usage) are written to stderr exclusively, never to stdout, to preserve the integrity of stdio JSON-RPC communication.
- **MCP Content-Array Response Contract** — All tool responses must use the MCP-standard `content` array format (`type: "text"`), with every response appending a Sources section containing source URLs for traceability.
- **Content Truncation Discipline** — Raw page content is never passed through to the caller; all output is LLM-synthesized. Individual page content is truncated at `MAX_CONTENT_CHARS` (default 8000) to control pipeline cost.
- **TypeScript Strict Mode Compliance** — The entire codebase must compile under `tsc --noEmit` with strict mode enabled, producing zero errors.

## API Standards

- **Response Envelope:** MCP-standard content array — `{ content: [{ type: "text", text: "<structured summary>" }] }`
- **Error Format:** MCP-standard error response — `{ content: [{ type: "text", text: "<friendly message with cause and suggestion>" }], isError: true }`
- **Pagination Format:** Not applicable — both tools return single-shot digest responses, no paginated collections.
- **Validation:** Runtime parameter validation via Zod schemas registered as MCP tool `inputSchema` (JSON Schema-compatible), enforced before pipeline dispatch.

## Technology Stack

- **Language:** TypeScript (strict mode, ESM modules)
- **Framework:** @modelcontextprotocol/sdk (MCP SDK, stdio transport)
- **Runtime:** Node.js 18+
- **Build Tool:** tsc (TypeScript compiler) → `dist/` output
- **Key Libraries:** @modelcontextprotocol/sdk, cheerio, @mozilla/readability, puppeteer (lazy-loaded fallback), openai (or fetch-based OpenAI-compatible client)
- **Entry Point:** `dist/index.js` (source: `src/index.ts`)
- **File Extensions:** `.ts` (source), `.js` (compiled output)
- **Conventions:** ESM `import/export`; stdio JSON-RPC over stdin/stdout; environment-variable-only configuration; modular pipeline stages with independent testability; `bin` field in package.json for `npx chomp-mcp` support