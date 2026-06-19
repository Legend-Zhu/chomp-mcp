# Design: MCP Server

## Overview

The MCP Server (MC) module is the protocol gateway through which any MCP-compliant client (e.g., scdd-agent) communicates with the web-research server. It manages the full server lifecycle over stdio transport using `@modelcontextprotocol/sdk`, registers two tools (`web_search` and `web_fetch`) with their JSON Schema input contracts, dispatches incoming tool calls to the Pipeline Orchestration (PL) layer via dependency injection, and formats every response according to the MCP `CallToolResult` specification. This module enforces strict stdout purity (JSON-RPC only) and routes all diagnostics to stderr.

The module consists of five source files plus the project-level entry point: `validation.ts` (Zod-based parameter validation), `tool-definitions.ts` (JSON Schema tool contracts), `tool-handlers.ts` (tool-call dispatch and response formatting), `server.ts` (Server lifecycle, StdioServerTransport, signal handling), `index.ts` (public barrel), and `src/index.ts` (process bootstrap with env validation and PL injection).

## Architecture

### Position in the System

```
src/index.ts  (process bootstrap: env check → PL construction → createServer → connect)
    │
    ▼
modules/mcp-server/
    ├── index.ts              → exports createServer()
    ├── server.ts             → Server lifecycle + StdioServerTransport
    ├── tool-handlers.ts      → dispatch web_search/web_fetch → PL → format CallToolResult
    ├── tool-definitions.ts   → static JSON Schema objects for both tools
    └── validation.ts         → Zod schemas + ValidationResult type
    │
    ▼ (dependency-injected PL functions)
modules/pipeline-orchestration/  → runWebSearch(params): Promise<string>
                                  → runWebFetch(params): Promise<string>
```

### Dependency Injection Boundary (DC-MC-007)

The MC module does **not** import PL directly. Instead, `src/index.ts` constructs the PL functions and injects them into `createServer({ runWebSearch, runWebFetch })`. The `OrchestrationHandlers` interface defines the contract. This enables unit testing MC with mock orchestration functions and enforces clean module boundaries at the import level.

### Stdout Purity Guarantee (NFR-MC-002, BG-MC-003)

- `stdout` is reserved exclusively for MCP JSON-RPC messages managed by `StdioServerTransport`.
- All logging uses `log.*()` from `shared/utils/logger.ts`, which writes to `process.stderr` only.
- No `console.log()` calls exist anywhere in MC module code.
- The MCP SDK's `StdioServerTransport` owns stdout; MC never writes to it directly.

### MCP Protocol Compliance (NFR-MC-003, DC-MC-001)

The server uses `@modelcontextprotocol/sdk` exclusively for protocol handling:
- `Server` class from `@modelcontextprotocol/sdk/server/index.js` — handles `initialize`, `initialized`, JSON-RPC framing, error codes.
- `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js` — owns stdin/stdout I/O.
- Request schemas (`ListToolsRequestSchema`, `CallToolRequestSchema`) from `@modelcontextprotocol/sdk/types.js` — type-safe handler registration.
- The SDK handles JSON-RPC 2.0 error codes (`-32600` Invalid Request, `-32601` Method not found, `-32603` Internal error) for protocol-level errors (US-MC-013).

### Response Formatting Flow

```
tools/call request
    │
    ▼
dispatchToolCall(name, params, handlers)
    │
    ├─ name unknown? ───────────────────→ formatErrorResponse("Unknown tool: ...")
    │
    ├─ validate params (Zod)
    │   └─ invalid? ───────────────────→ formatErrorResponse(validationMessage)
    │
    ├─ call PL handler (runWebSearch / runWebFetch)
    │   ├─ resolves with digest string ─→ formatSuccessResponse(digest)
    │   ├─ throws timeout error ───────→ formatErrorResponse("Research timed out...")
    │   └─ throws other error ─────────→ formatErrorResponse("Internal error: ...")
    │
    ▼
CallToolResult { content: [{type:"text", text}], isError }
```

## Data Models

### WebSearchParams

Validated parameter object for the `web_search` tool, mapped from MCP snake_case input to TypeScript camelCase fields.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | `string` | Yes | The search query. Must be non-empty. |
| `maxResults` | `number` | No | Maximum number of results to process. Integer ≥ 1. Default: `5`. Mapped from MCP param `max_results`. |
| `focus` | `string` | No | Optional focus area to emphasize in synthesis. |

### WebFetchParams

Validated parameter object for the `web_fetch` tool.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | The URL to fetch and synthesize. Must be a valid URI. |
| `focus` | `string` | No | Optional focus area to emphasize in synthesis. |

### OrchestrationHandlers

Dependency-injection contract for PL functions. Passed to `createServer()`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runWebSearch` | `(params: WebSearchParams) => Promise<string>` | Yes | Executes the full web_search pipeline. Returns a formatted digest string. May throw on fatal error. |
| `runWebFetch` | `(params: WebFetchParams) => Promise<string>` | Yes | Executes the web_fetch sub-flow. Returns a formatted digest string. May throw on fatal error. |

### CreateServerOptions

Options object for the `createServer` factory function.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `handlers` | `OrchestrationHandlers` | Yes | Injected PL orchestration functions. |
| `serverName` | `string` | No | Server name for MCP handshake. Default: `"chomp-mcp"`. |
| `serverVersion` | `string` | No | Server version for MCP handshake. Default: `"1.0.0"`. |

### ValidationResult\<T\>

Discriminated union returned by validation functions.

| Variant | Fields | Description |
|---------|--------|-------------|
| Success | `{ success: true; data: T }` | Validation passed; `data` contains the typed, validated params. |
| Failure | `{ success: false; message: string }` | Validation failed; `message` is a human-readable error string for the MCP response. |

### ToolName

String literal union type.

```typescript
type ToolName = "web_search" | "web_fetch";
```

## API Endpoints

This module does not expose HTTP endpoints. It registers MCP JSON-RPC tool handlers. The "endpoints" below are the MCP protocol methods served by this module.

| Method | Path (JSON-RPC method) | Request Body | Response | Status Codes | User Story |
|--------|----------------------|-------------|----------|--------------|------------|
| MCP | `initialize` | `{ protocolVersion, capabilities, clientInfo }` | `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version } }` | JSON-RPC success | US-MC-002 |
| MCP | `tools/list` | _(none)_ | `{ tools: [webSearchTool, webFetchTool] }` — each with `name`, `description`, `inputSchema` | JSON-RPC success | US-MC-005 |
| MCP | `tools/call` (`web_search`) | `{ name: "web_search", arguments: { query, max_results?, focus? } }` | `CallToolResult { content: [{type:"text", text: digest}], isError: false }` | Success: `isError: false`; Validation error: `isError: true`; PL failure: `isError: true` | US-MC-006, US-MC-008, US-MC-010, US-MC-011 |
| MCP | `tools/call` (`web_fetch`) | `{ name: "web_fetch", arguments: { url, focus? } }` | `CallToolResult { content: [{type:"text", text: digest}], isError: false }` | Success: `isError: false`; Validation error: `isError: true`; PL failure: `isError: true` | US-MC-007, US-MC-008, US-MC-010, US-MC-011 |
| MCP | `tools/call` (unknown) | `{ name: "<unknown>", arguments: {...} }` | `CallToolResult { content: [{type:"text", text: "Unknown tool: ..."}], isError: true }` | `isError: true` | US-MC-009 |

### Tool Input Schemas (JSON Schema Draft 2020-12)

**`web_search` inputSchema:**
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "The search query to research"
    },
    "max_results": {
      "type": "integer",
      "default": 5,
      "description": "Maximum number of search results to process (default: 5)"
    },
    "focus": {
      "type": "string",
      "description": "Optional aspect to emphasize in the synthesized digest"
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

**`web_fetch` inputSchema:**
```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "format": "uri",
      "description": "The URL to fetch, extract, and synthesize"
    },
    "focus": {
      "type": "string",
      "description": "Optional aspect to emphasize in the synthesized digest"
    }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

## Error Handling

### MCP Error Response Format

All tool-call errors are returned as MCP `CallToolResult` objects with `isError: true` (not JSON-RPC error responses). This follows MCP convention for tool execution errors:

```typescript
{
  content: [{ type: "text", text: "<human-readable error message>" }],
  isError: true
}
```

Stack traces are **never** included in MCP responses. They are logged to stderr only (NFR-MC-004).

### Error Categories and Messages

| Error Scenario | User-Facing Message | isError | Logged to stderr | User Story |
|---------------|---------------------|---------|-------------------|------------|
| Unknown tool name | `"Unknown tool: {name}. Available tools: web_search, web_fetch."` | `true` | `[mcp-server] unknown tool requested: {name}` | US-MC-009 |
| Missing `query` param | `"Missing required field: query"` | `true` | Validation failure details | US-MC-010 |
| Invalid `url` format | `"Invalid URL format: {provided value}"` | `true` | Validation failure details | US-MC-010 |
| `max_results` non-integer or negative | `"max_results must be a positive integer"` | `true` | Validation failure details | US-MC-010 |
| PL timeout error | `"Research timed out. Please try reducing max_results or try again later."` | `true` | Full error + stack trace | US-MC-011 |
| PL unexpected error | `"Internal error: {message}. See server logs for details."` | `true` | Full error + stack trace | US-MC-011 |
| PL partial/degraded result | _(treated as success — `isError: false`)_ | `false` | Degradation notice | US-MC-011 |
| Missing `LLM_API_KEY` at startup | _(process exit code 1)_ | N/A | `[mcp-server] FATAL: LLM_API_KEY environment variable is required` | US-MC-012 |

### Timeout Detection

The MC module detects PL timeout errors by checking the `AppError.category` field from `shared/utils/errors.ts`:

```typescript
import { AppError } from '../../shared/utils/errors.js';

function isTimeoutError(error: unknown): boolean {
  return error instanceof AppError && error.category === 'timeout';
}
```

This avoids importing PL-specific error types while still enabling category-based dispatch.

### Response Truncation (US-MC-008)

When a digest string exceeds `MAX_RESPONSE_CHARS` (25,000 characters), the response is truncated at the character boundary and the marker `"\n\n[Response truncated due to length]"` is appended before wrapping in the content array. This protects MCP clients from oversized payloads.

### JSON-RPC Protocol Errors (US-MC-013)

The MCP SDK's `Server` class handles protocol-level JSON-RPC errors internally:
- Malformed JSON → logged to stderr by SDK, message skipped, server continues.
- Unrecognized method → JSON-RPC error code `-32601` (Method not found).
- Missing `jsonrpc: "2.0"` → JSON-RPC error code `-32600` (Invalid Request).
- Uncaught handler exception → JSON-RPC error code `-32603` (Internal error) if request had an `id`.

MC does not override these SDK behaviors. It only adds application-level error handling for tool dispatch.

### Server Process Stability (NFR-MC-005)

The MC module wraps all tool dispatch handlers in try/catch at the outermost level. No exception from PL, validation, or formatting propagates to the SDK's request handler boundary as an unhandled rejection. The `dispatchToolCall` function is fully enclosed:

```typescript
async function dispatchToolCall(
  name: string,
  params: unknown,
  handlers: OrchestrationHandlers
): Promise<CallToolResult> {
  try {
    // ... dispatch logic ...
  } catch (error) {
    // Catch-all: never let an exception escape to crash the server
    log.error('Unhandled error in tool dispatch', error);
    return formatErrorResponse(`Internal error: ${getErrorMessage(error)}. See server logs for details.`);
  }
}
```

## Component Interfaces

### validation.ts — Parameter Validation

```typescript
/**
 * Validates raw MCP tool-call arguments for web_search.
 * Maps snake_case MCP params to camelCase WebSearchParams.
 * Returns ValidationResult with specific error messages per US-MC-010.
 */
function validateWebSearchParams(params: unknown): ValidationResult<WebSearchParams>;

/**
 * Validates raw MCP tool-call arguments for web_fetch.
 * Returns ValidationResult with specific error messages per US-MC-010.
 */
function validateWebFetchParams(params: unknown): ValidationResult<WebFetchParams>;
```

**Zod schemas (internal):**

```typescript
const webSearchSchema = z.object({
  query: z.string().min(1, 'Missing required field: query'),
  max_results: z.number().int().positive('max_results must be a positive integer').default(5),
  focus: z.string().optional(),
}).strict();

const webFetchSchema = z.object({
  url: z.string().url('Invalid URL format'),
  focus: z.string().optional(),
}).strict();
```

Validation maps `max_results` → `maxResults` in the output `WebSearchParams` object.

### tool-definitions.ts — Tool Schema Constants

```typescript
/** MCP Tool definition for web_search (US-MC-003). */
const WEB_SEARCH_TOOL: Tool;

/** MCP Tool definition for web_fetch (US-MC-004). */
const WEB_FETCH_TOOL: Tool;

/** Array of all registered tool definitions, returned by tools/list handler. */
const TOOL_DEFINITIONS: Tool[];
```

Each `Tool` object conforms to the MCP SDK's `Tool` type with `name`, `description`, and `inputSchema` (JSON Schema draft 2020-12, `type: "object"`, `additionalProperties: false`).

### tool-handlers.ts — Tool Dispatch and Response Formatting

```typescript
/**
 * Main tool-call dispatcher. Called by the MCP SDK's CallToolRequest handler.
 * Routes to the appropriate tool handler or returns an unknown-tool error.
 * Fully enclosed in try/catch — never throws.
 *
 * @param name - Tool name from the MCP request params
 * @param params - Raw arguments object from the MCP request
 * @param handlers - Injected PL orchestration functions
 * @returns MCP CallToolResult (success or error)
 */
async function dispatchToolCall(
  name: string,
  params: unknown,
  handlers: OrchestrationHandlers
): Promise<CallToolResult>;

/**
 * Handles web_search tool calls: validate → dispatch → format.
 */
async function handleWebSearch(
  params: unknown,
  handlers: OrchestrationHandlers
): Promise<CallToolResult>;

/**
 * Handles web_fetch tool calls: validate → dispatch → format.
 */
async function handleWebFetch(
  params: unknown,
  handlers: OrchestrationHandlers
): Promise<CallToolResult>;

/**
 * Formats a successful digest string into an MCP CallToolResult.
 * Truncates at MAX_RESPONSE_CHARS if necessary (US-MC-008).
 *
 * @param digest - The formatted digest string from PL
 * @returns CallToolResult with isError: false
 */
function formatSuccessResponse(digest: string): CallToolResult;

/**
 * Formats an error message into an MCP CallToolResult.
 *
 * @param message - Human-readable error message (no stack traces)
 * @returns CallToolResult with isError: true
 */
function formatErrorResponse(message: string): CallToolResult;
```

### server.ts — Server Lifecycle

```typescript
/**
 * Creates and configures an MCP Server instance with tools registered
 * and request handlers wired. Does NOT connect the transport.
 *
 * @param options - Server configuration with injected PL handlers
 * @returns Configured Server instance (not yet connected)
 *
 * User stories: US-MC-001, US-MC-002, US-MC-003, US-MC-004, US-MC-005
 */
function createServer(options: CreateServerOptions): Server;

/**
 * Starts the MCP server by creating a StdioServerTransport,
 * connecting it to the Server, and registering signal/shutdown handlers.
 * Resolves when the transport is connected.
 *
 * @param server - A configured Server instance from createServer()
 *
 * User stories: US-MC-001, US-MC-002, US-MC-014
 */
async function startServer(server: Server): Promise<void>;

/**
 * Gracefully shuts down the server: stops accepting new requests,
 * waits up to SHUTDOWN_GRACE_PERIOD_MS for in-flight tool calls,
 * closes the transport, and exits.
 *
 * User stories: US-MC-014
 */
async function shutdown(server: Server): Promise<void>;
```

**Server constructor configuration (US-MC-002):**

```typescript
const server = new Server(
  { name: options.serverName ?? SERVER_NAME, version: options.serverVersion ?? SERVER_VERSION },
  { capabilities: { tools: {} } }
);
```

**Request handler registration inside `createServer`:**

```typescript
// tools/list handler (US-MC-005)
server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
  return { tools: TOOL_DEFINITIONS };
});

// tools/call handler (US-MC-006, US-MC-007, US-MC-009)
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;
  return dispatchToolCall(name, args ?? {}, options.handlers);
});
```

**Shutdown handler registration inside `startServer`:**

```typescript
// SIGTERM / SIGINT (US-MC-014)
process.on('SIGTERM', () => {
  log.info('received SIGTERM, shutting down');
  shutdown(server);
});
process.on('SIGINT', () => {
  log.info('received SIGINT, shutting down');
  shutdown(server);
});

// stdin close = client disconnect (US-MC-014)
transport.onclose = async () => {
  log.info('transport closed');
  process.exit(0);
};
```

**In-flight call tracking for graceful shutdown:**

The module maintains a module-private counter `activeToolCalls: number` incremented at dispatch entry and decremented at dispatch exit (in a `finally` block). The `shutdown` function polls this counter every 100ms up to `SHUTDOWN_GRACE_PERIOD_MS` (5 seconds), then forces exit.

### index.ts — Public API Barrel

```typescript
export { createServer, startServer, shutdown } from './server.js';
export type {
  OrchestrationHandlers,
  CreateServerOptions,
  WebSearchParams,
  WebFetchParams,
  ValidationResult,
  ToolName,
} from './server.js';
```

### src/index.ts — Process Entry Point

This is the project-level entry point (not inside the module directory). It is included in this design because it is the direct responsibility of the MC module — it bootstraps the server.

```typescript
#!/usr/bin/env node

/**
 * Validates required environment variables, constructs PL orchestration
 * functions, injects them into createServer, and starts the server.
 *
 * User stories: US-MC-001, US-MC-012
 */
async function main(): Promise<void>;

// Execute
main().catch((error) => {
  process.stderr.write(`[mcp-server] FATAL: ${error.message}\n`);
  process.exit(1);
});
```

**Startup sequence in `main()`:**

1. Check `process.env.LLM_API_KEY` — if missing/empty, log FATAL and `process.exit(1)` (US-MC-012).
2. Import shared config singleton `appConfig` from `shared/config/index.js` — this triggers env var parsing with defaults (US-MC-012).
3. Import and construct PL orchestration functions from `modules/pipeline-orchestration/index.js` — `runWebSearch` and `runWebFetch`.
4. Call `createServer({ handlers: { runWebSearch, runWebFetch } })`.
5. Call `startServer(server)` — creates `StdioServerTransport`, connects, logs `[mcp-server] listening on stdio`.
6. The SDK emits a log on `initialized` notification — MC logs `[mcp-server] session ready`.

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.0.0 | MCP protocol: `Server`, `StdioServerTransport`, `ListToolsRequestSchema`, `CallToolRequestSchema`, `Tool`, `CallToolResult`, `ListToolsResult` type definitions |
| `zod` | ^3.22.0 | Runtime validation of tool-call parameters (`webSearchSchema`, `webFetchSchema`) with custom error messages |
| `typescript` | ^5.4.0 | TypeScript compiler (dev dependency — `tsc --noEmit` for type-checking) |
| `tsx` | ^4.7.0 | TypeScript execution for development/testing (dev dependency) |
| `@types/node` | ^18.19.0 | Node.js type definitions for `process`, signals, stdio (dev dependency) |

All packages are listed in the project-level Package Dependencies table in `index.md`. No additional packages are required.

**Internal module dependencies (import paths):**

| Import | Path | Purpose |
|--------|------|---------|
| `AppError` | `../shared/utils/errors.js` | Base error class for `isTimeoutError()` category check |
| `log` | `../shared/utils/logger.js` | stderr-only structured logger (`log.info`, `log.warn`, `log.error`) |
| `appConfig` | `../shared/config/index.js` | Centralized env var config singleton (consumed in `src/index.ts`) |
| `runWebSearch`, `runWebFetch` | `../pipeline-orchestration/index.js` | PL orchestration functions (imported in `src/index.ts`, injected into `createServer`) |

## File Generation Order

Files are listed in dependency order — each file may only import from files listed above it or from `shared/`.

| # | File Path | Description | Key Dependencies |
|---|-----------|-------------|------------------|
| 1 | `src/modules/mcp-server/validation.ts` | Zod schemas (`webSearchSchema`, `webFetchSchema`), `ValidationResult<T>` type, `validateWebSearchParams()`, `validateWebFetchParams()`. Produces specific error messages per US-MC-010. Maps `max_results` → `maxResults`. | `zod` |
| 2 | `src/modules/mcp-server/tool-definitions.ts` | Static `Tool` objects: `WEB_SEARCH_TOOL`, `WEB_FETCH_TOOL`, `TOOL_DEFINITIONS` array. JSON Schema draft 2020-12 with `additionalProperties: false`. Per US-MC-003, US-MC-004. | `@modelcontextprotocol/sdk` (types) |
| 3 | `src/modules/mcp-server/tool-handlers.ts` | `OrchestrationHandlers`, `WebSearchParams`, `WebFetchParams`, `ToolName`, `CreateServerOptions` interfaces. `dispatchToolCall()`, `handleWebSearch()`, `handleWebFetch()`, `formatSuccessResponse()`, `formatErrorResponse()`. `MAX_RESPONSE_CHARS`, `TRUNCATION_NOTICE` constants. Timeout detection via `AppError.category`. Per US-MC-006 through US-MC-011. | validation.ts, tool-definitions.ts, `shared/utils/errors.js`, `shared/utils/logger.js` |
| 4 | `src/modules/mcp-server/server.ts` | `createServer()`, `startServer()`, `shutdown()`. Server constructor with `tools` capability. `ListToolsRequestSchema` and `CallToolRequestSchema` handler registration. `StdioServerTransport` setup. SIGTERM/SIGINT/stdin-close handlers. In-flight call tracking. `SERVER_NAME`, `SERVER_VERSION`, `SHUTDOWN_GRACE_PERIOD_MS` constants. Per US-MC-001, US-MC-002, US-MC-005, US-MC-014. | tool-handlers.ts, tool-definitions.ts, `shared/utils/logger.js`, `@modelcontextprotocol/sdk` |
| 5 | `src/modules/mcp-server/index.ts` | Public API barrel. Re-exports `createServer`, `startServer`, `shutdown` from server.ts. Re-exports all public types. | server.ts |
| 6 | `src/index.ts` | Process entry point with `#!/usr/bin/env node` shebang. `main()` function: validates `LLM_API_KEY` (exit 1 if missing), imports `appConfig`, constructs PL handlers from pipeline-orchestration module, calls `createServer()` + `startServer()`. Per US-MC-001, US-MC-012, DC-MC-006, DC-MC-007. | mcp-server/index.ts, pipeline-orchestration/index.ts, shared/config/index.js |

**Rationale for `src/index.ts` inclusion:** The project directory layout in `index.md` explicitly defines `src/index.ts` as "Main entry point — bootstraps MCP server." This file is the direct responsibility of the MC module since it constructs the DI boundary, validates startup env vars, and calls `createServer()`. It is the only file outside `src/modules/mcp-server/` in this design, and it follows the project layout exactly.
