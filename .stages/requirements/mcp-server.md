# Requirements: MCP Server Entry

## Overview
The MCP Server Entry module is the gateway through which any MCP-compliant client (e.g., scdd-agent) connects to the web-research server. It manages the full server lifecycle over stdio transport, registers `web_search` and `web_fetch` tool definitions with their JSON Schema input contracts, dispatches incoming tool calls to the pipeline orchestration layer (PL), and formats every response according to the MCP standard content-array specification. This module ensures that raw web page content never traverses the stdio boundary—only structured digests do.

---

## User Stories

### US-MC-001: Start MCP Server with Stdio Transport
**As an** MCP client (scdd-agent), **I want** the server to start listening on stdin/stdout using the MCP stdio transport, **so that** I can establish a JSON-RPC communication channel.

**Acceptance Criteria:**
- WHEN the server process starts (`node dist/index.js`) THEN the system SHALL instantiate a `Server` from `@modelcontextprotocol/sdk` and connect it via `StdioServerTransport`
- WHEN the transport is connected THEN the system SHALL emit a startup log line to stderr with the format `[mcp-server] listening on stdio`
- WHEN the transport fails to bind to stdin/stdout THEN the system SHALL log the error to stderr and exit with code 1

---

### US-MC-002: Complete MCP Initialize Handshake
**As an** MCP client, **I want** the server to respond to the JSON-RPC `initialize` request, **so that** the protocol session is established and capabilities are negotiated.

**Acceptance Criteria:**
- WHEN the server receives an `initialize` request THEN the system SHALL respond with `protocolVersion`, server `name` set to `chomp-mcp`, and server `version`
- WHEN the server receives an `initialize` request THEN the system SHALL declare `tools` capability in the server capabilities object
- WHEN the client sends `initialized` notification THEN the system SHALL transition to the ready state and log `[mcp-server] session ready` to stderr

---

### US-MC-003: Register web_search Tool Definition
**As an** MCP client, **I want** the `web_search` tool to be registered with its full input schema, **so that** I can discover the tool's parameters and invoke it correctly.

**Acceptance Criteria:**
- WHEN the server registers tools THEN the system SHALL register a tool named `web_search` with description "Perform a full web research pipeline (search → scrape → deduplicate → synthesize) and return a structured digest"
- WHEN the `web_search` inputSchema is registered THEN the schema SHALL define `query` as a required string property, `max_results` as an optional integer property with default 5, and `focus` as an optional string property
- WHEN the `web_search` inputSchema is registered THEN the schema SHALL be a valid JSON Schema draft 2020-12 object with `type: object` and `additionalProperties: false`

---

### US-MC-004: Register web_fetch Tool Definition
**As an** MCP client, **I want** the `web_fetch` tool to be registered with its full input schema, **so that** I can discover the tool's parameters and invoke it correctly.

**Acceptance Criteria:**
- WHEN the server registers tools THEN the system SHALL register a tool named `web_fetch` with description "Fetch and synthesize a specific URL into a structured digest (scrape → synthesize)"
- WHEN the `web_fetch` inputSchema is registered THEN the schema SHALL define `url` as a required string property (format: uri) and `focus` as an optional string property
- WHEN the `web_fetch` inputSchema is registered THEN the schema SHALL be a valid JSON Schema draft 2020-12 object with `type: object` and `additionalProperties: false`

---

### US-MC-005: List Registered Tools
**As an** MCP client, **I want** to retrieve the list of available tools, **so that** I can programmatically discover `web_search` and `web_fetch` and their parameter schemas.

**Acceptance Criteria:**
- WHEN the server receives a `tools/list` JSON-RPC request THEN the system SHALL return an array containing exactly two tool definitions: `web_search` and `web_fetch`
- WHEN the server returns the tool list THEN each tool entry SHALL include `name`, `description`, and `inputSchema` keys
- WHEN no tools have been registered yet (pre-initialized state) THEN the system SHALL return an empty tools array

---

### US-MC-006: Dispatch web_search Tool Call
**As an** MCP client, **I want** my `web_search` invocation to be routed to the pipeline orchestration layer with all parameters, **so that** the full research pipeline executes and returns a digest.

**Acceptance Criteria:**
- WHEN the server receives a `tools/call` request with `name: "web_search"` THEN the system SHALL validate parameters against the `web_search` inputSchema and, on success, invoke the PL module's `runWebSearch(params)` function
- WHEN the PL module returns a digest string THEN the system SHALL format the result as an MCP content array (see US-MC-008)
- WHEN the PL module throws an error or rejects THEN the system SHALL format an MCP error response (see US-MC-011)
- WHEN the dispatch occurs THEN the system SHALL log `[mcp-server] dispatching web_search: {query}` to stderr

---

### US-MC-007: Dispatch web_fetch Tool Call
**As an** MCP client, **I want** my `web_fetch` invocation to be routed to the pipeline orchestration layer with the target URL and optional focus, **so that** the fetch-and-synthesize sub-flow executes and returns a digest.

**Acceptance Criteria:**
- WHEN the server receives a `tools/call` request with `name: "web_fetch"` THEN the system SHALL validate parameters against the `web_fetch` inputSchema and, on success, invoke the PL module's `runWebFetch(params)` function
- WHEN the PL module returns a digest string THEN the system SHALL format the result as an MCP content array (see US-MC-008)
- WHEN the PL module throws an error or rejects THEN the system SHALL format an MCP error response (see US-MC-011)
- WHEN the dispatch occurs THEN the system SHALL log `[mcp-server] dispatching web_fetch: {url}` to stderr

---

### US-MC-008: Format Successful Tool Response
**As an** MCP client, **I want** tool call results formatted as a standard MCP content array, **so that** my client library can reliably parse the structured digest text.

**Acceptance Criteria:**
- WHEN the orchestration layer returns a successful digest string THEN the system SHALL return a `CallToolResult` object with `content` array containing a single object `{ "type": "text", "text": <digest> }`
- WHEN the digest is formatted THEN the system SHALL set `isError: false` on the result object
- WHEN the digest string exceeds 25,000 characters THEN the system SHALL truncate it to 25,000 characters and append `\n\n[Response truncated due to length]` before wrapping in the content array

---

### US-MC-009: Return Error for Unknown Tool
**As an** MCP client, **I want** a clear error response when I call a tool name the server does not recognize, **so that** I can handle the mistake programmatically.

**Acceptance Criteria:**
- WHEN the server receives a `tools/call` request with a `name` that is neither `web_search` nor `web_fetch` THEN the system SHALL return a `CallToolResult` with `isError: true` and content text `"Unknown tool: {name}. Available tools: web_search, web_fetch."`
- WHEN returning the unknown-tool error THEN the system SHALL NOT propagate the request to the orchestration layer
- WHEN the unknown-tool error is returned THEN the system SHALL log `[mcp-server] unknown tool requested: {name}` to stderr

---

### US-MC-010: Return Error for Invalid Tool Parameters
**As an** MCP client, **I want** a clear validation error when my tool call parameters do not match the registered inputSchema, **so that** I can correct the request before resubmitting.

**Acceptance Criteria:**
- WHEN a `tools/call` request for `web_search` is missing the `query` parameter THEN the system SHALL return `isError: true` with content text describing the missing required field
- WHEN a `tools/call` request for `web_fetch` provides a `url` that is not a valid URI THEN the system SHALL return `isError: true` with content text `"Invalid URL format: {provided value}"`
- WHEN a `tools/call` request for `web_search` provides `max_results` as a non-integer or negative value THEN the system SHALL return `isError: true` with content text `"max_results must be a positive integer"`
- WHEN parameter validation fails THEN the system SHALL NOT forward the call to the orchestration layer

---

### US-MC-011: Return Error for Orchestration Layer Failure
**As an** MCP client, **I want** a readable error response when the pipeline fails entirely, **so that** the calling agent can inform the user and suggest remediation.

**Acceptance Criteria:**
- WHEN the PL module throws an error during dispatch THEN the system SHALL catch the error and return `isError: true` with content text including the failure reason
- WHEN the PL module returns a partial/degraded result (per cross-module degradation rules) THEN the system SHALL treat it as a successful response, NOT an error
- WHEN the PL module throws a timeout error THEN the system SHALL return `isError: true` with content text `"Research timed out. Please try reducing max_results or try again later."`
- WHEN the PL module throws an unexpected error THEN the system SHALL return `isError: true` with content text `"Internal error: {message}. See server logs for details."` and log the full stack trace to stderr

---

### US-MC-012: Validate Environment Variables at Startup
**As a** server operator, **I want** the server to validate required environment variables before accepting any requests, **so that** I get immediate feedback on missing configuration instead of cryptic runtime failures.

**Acceptance Criteria:**
- WHEN the server process starts THEN the system SHALL check that `LLM_API_KEY` is set and non-empty
- WHEN `LLM_API_KEY` is missing or empty THEN the system SHALL log `[mcp-server] FATAL: LLM_API_KEY environment variable is required` to stderr and exit with code 1
- WHEN optional environment variables (`SEARXNG_URL`, `LLM_BASE_URL`, `LLM_MODEL`, `SCRAPE_TIMEOUT_MS`, `MAX_CONTENT_CHARS`, `MAX_CONCURRENCY`) are set THEN the system SHALL parse them and pass normalized values to the PL module
- WHEN optional environment variables are unset THEN the system SHALL apply defaults: `SEARXNG_URL=<public instance>`, `LLM_BASE_URL=https://api.openai.com/v1`, `LLM_MODEL=gpt-4o-mini`, `SCRAPE_TIMEOUT_MS=15000`, `MAX_CONTENT_CHARS=8000`, `MAX_CONCURRENCY=3`

---

### US-MC-013: Handle Malformed JSON-RPC Messages
**As an** MCP client, **I want** the server to gracefully handle malformed or unexpected JSON-RPC messages, **so that** a single bad message does not crash the server.

**Acceptance Criteria:**
- WHEN the server receives a message that is not valid JSON THEN the system SHALL log `[mcp-server] malformed JSON received` to stderr and continue listening
- WHEN the server receives a JSON-RPC request with an unrecognized method THEN the system SHALL return a JSON-RPC error response with code `-32601` (Method not found)
- WHEN the server receives a JSON-RPC request missing the `jsonrpc: "2.0"` field THEN the system SHALL return a JSON-RPC error response with code `-32600` (Invalid Request)
- WHEN any message handler throws an uncaught exception THEN the system SHALL log the error to stderr, return a `-32603` (Internal error) response if the request had an `id`, and continue listening

---

### US-MC-014: Graceful Shutdown
**As a** server operator, **I want** the server to shut down cleanly on stdin close or termination signals, **so that** no orphaned processes or dangling connections remain.

**Acceptance Criteria:**
- WHEN stdin is closed (client disconnects) THEN the system SHALL close the MCP transport, release all held resources, and exit with code 0
- WHEN the process receives `SIGTERM` THEN the system SHALL log `[mcp-server] received SIGTERM, shutting down` to stderr, close the transport, and exit with code 0
- WHEN the process receives `SIGINT` (Ctrl+C) THEN the system SHALL behave identically to SIGTERM handling
- WHEN the server is shutting down and has pending tool calls in flight THEN the system SHALL allow up to 5 seconds for in-flight orchestration to complete before forcing exit

---

## Business Goals

### BG-MC-001: Fast Cold-Start
- Description: The MCP server should start and be ready to accept JSON-RPC connections quickly so that scdd-agent experiences minimal latency when spawning the server.
- Metric: Time from process spawn to `[mcp-server] session ready` log on stderr.
- Target: < 1 second on a standard development machine (8-core CPU, 16 GB RAM).

### BG-MC-002: Tool Discovery Reliability
- Description: Every successful `initialize` + `tools/list` exchange must return both tools with complete, valid inputSchemas so that MCP clients can correctly invoke them without trial and error.
- Metric: Percentage of `tools/list` responses that contain exactly 2 tools with schema-valid `inputSchema` objects.
- Target: 100%.

### BG-MC-003: Zero Stdout Pollution
- Description: Only valid JSON-RPC messages should appear on stdout; all logging, diagnostics, and error output must go to stderr, so that MCP clients never fail to parse a log line as JSON-RPC.
- Metric: Number of non-JSON-RPC lines written to stdout during a full session (initialize → 5 tool calls → shutdown).
- Target: 0.

---

## Non-Functional Requirements

### NFR-MC-001: Startup Latency
- Category: performance
- Description: The server shall complete the `initialize` handshake response within 500 ms of receiving the request, including transport and SDK overhead.
- Priority: important

### NFR-MC-002: Stdout Channel Integrity
- Category: reliability
- Description: The server shall never write anything other than valid JSON-RPC 2.0 messages (newline-delimited JSON) to stdout. All logs, warnings, and diagnostics shall be written exclusively to stderr.
- Priority: critical

### NFR-MC-003: MCP Protocol Compliance
- Category: reliability
- Description: The server shall conform to the Model Context Protocol specification for stdio transport, including correct `Content-Length` framing (if applicable per SDK version), proper JSON-RPC 2.0 error codes, and standard `CallToolResult` shape with `content` array and `isError` flag.
- Priority: critical

### NFR-MC-004: Error Message Readability
- Category: usability
- Description: All error responses returned to the client shall include a human-readable failure reason and, where applicable, a remediation suggestion (e.g., "Please check SEARXNG_URL or try a self-hosted instance"). Error messages shall not leak internal stack traces to the client; stack traces shall be logged to stderr only.
- Priority: important

### NFR-MC-005: Process Stability Under Unexpected Input
- Category: reliability
- Description: The server shall not crash or hang when receiving malformed JSON, oversized payloads (> 1 MB on a single line), empty lines, or binary data on stdin. Each malformed input shall be logged to stderr and skipped without affecting subsequent valid messages.
- Priority: critical

### NFR-MC-006: Memory Footprint
- Category: performance
- Description: The server process shall maintain a resident memory footprint below 150 MB during idle (no active tool calls) and below 500 MB during peak (concurrent tool call dispatch with 3 parallel scrapes in the PL layer).
- Priority: nice-to-have

---

## Design Constraints

### DC-MC-001: Use Official MCP SDK
- Description: The server shall be implemented using `@modelcontextprotocol/sdk` for both the `Server` and `StdioServerTransport` classes. Custom protocol implementations or third-party JSON-RPC libraries for the transport layer are prohibited.
- Severity: critical

### DC-MC-002: Stdio Transport Only
- Description: The server shall communicate exclusively over stdio (stdin for incoming JSON-RPC, stdout for outgoing JSON-RPC, stderr for logs). HTTP, WebSocket, and SSE transports are out of scope for this module.
- Severity: critical

### DC-MC-003: ESM Module Format
- Description: The server source code shall use ES Modules (import/export) with `"type": "module"` in `package.json`. CommonJS (`require`) is prohibited.
- Severity: critical

### DC-MC-004: TypeScript Strict Mode
- Description: The server source shall compile with `tsc --noEmit` under `"strict": true` in `tsconfig.json` with zero errors. All function parameters, return types, and tool schemas shall be fully typed.
- Severity: critical

### DC-MC-005: Node.js 18+ Runtime
- Description: The server shall target Node.js 18 LTS or higher. Use of APIs available only in Node.js 20+ shall be guarded with feature detection or documented as requiring Node.js 20+.
- Severity: important

### DC-MC-006: npx Entry Point
- Description: `package.json` shall declare a `bin` field mapping to `dist/index.js` with a proper `#!/usr/bin/env node` shebang, enabling `npx chomp-mcp` execution.
- Severity: important

### DC-MC-007: Dependency Injection of Orchestration Layer
- Description: The MCP server module shall receive the PL orchestration functions (`runWebSearch`, `runWebFetch`) via constructor injection or factory function parameters, not via direct import, to enable unit testing with mock orchestration and to maintain module boundary discipline.
- Severity: important