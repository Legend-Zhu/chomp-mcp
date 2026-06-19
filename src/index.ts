#!/usr/bin/env node
/**
 * Main entry point — bootstraps the MCP server with stdio transport.
 *
 * Responsibilities:
 *   - Validate that LLM_API_KEY is set and non-empty at startup (US-MC-012)
 *   - Import the pipeline-orchestration functions (runWebSearch, runWebFetch)
 *     and inject them into the MCP server as OrchestrationHandlers (DC-MC-006)
 *   - Create and start the MCP server via StdioServerTransport (US-MC-001)
 *   - Catch any fatal startup error, log to stderr, and exit with code 1
 *     (NFR-MC-006)
 *
 * The MCP server reads its environment configuration (SEARXNG_URL,
 * LLM_BASE_URL, LLM_MODEL, SCRAPE_TIMEOUT_MS, MAX_CONTENT_CHARS,
 * MAX_CONCURRENCY) directly from process.env via the pipeline-orchestration
 * module's loadPipelineConfig().
 *
 * [Spec: US-MC-001, US-MC-012, DC-MC-005, DC-MC-006, DC-MC-007,
 *        NFR-MC-005, NFR-MC-006]
 */

import { createServer, startServer } from './modules/mcp-server/index.js';
import { runWebSearch, runWebFetch } from './modules/pipeline-orchestration/index.js';

/**
 * Validate that LLM_API_KEY is set and non-empty.
 *
 * [Implements: US-MC-012, DC-MC-005]
 */
// [Implements: US-MC-012, DC-MC-005]
function validateApiKey(): void {
  const apiKey = process.env['LLM_API_KEY'];
  if (!apiKey || apiKey.trim() === '') {
    process.stderr.write(
      '[mcp-server] FATAL: LLM_API_KEY environment variable is required\n'
    );
    process.exit(1);
  }
}

/**
 * Bootstrap the MCP server process.
 *
 * 1. Validates LLM_API_KEY is present and non-empty.
 * 2. Constructs OrchestrationHandlers from the pipeline-orchestration module.
 * 3. Creates a configured MCP Server with tools capability.
 * 4. Starts the server via StdioServerTransport (emits
 *    "[mcp-server] listening on stdio" to stderr on success).
 *
 * [Implements: US-MC-001, US-MC-012, DC-MC-005, DC-MC-006, DC-MC-007]
 */
// [Implements: US-MC-001, US-MC-012, DC-MC-005, DC-MC-006, DC-MC-007]
async function main(): Promise<void> {
  // [Implements: US-MC-012] Validate LLM_API_KEY before anything else
  validateApiKey();

  // [Implements: DC-MC-006, DC-MC-007] Inject pipeline-orchestration functions
  // into the MCP server as OrchestrationHandlers (dependency injection).
  // runWebSearch and runWebFetch internally read env config (SEARXNG_URL,
  // LLM_BASE_URL, LLM_MODEL, SCRAPE_TIMEOUT_MS, MAX_CONTENT_CHARS,
  // MAX_CONCURRENCY) via loadPipelineConfig() with documented defaults.
  const handlers = { runWebSearch, runWebFetch };

  // [Implements: US-MC-001, DC-MC-005] Create the MCP server
  const server = createServer({ handlers });

  // [Implements: US-MC-001, DC-MC-006] Start the server on stdio transport.
  // startServer() connects the server to a StdioServerTransport and logs
  // "[mcp-server] listening on stdio" to stderr on success.
  // On transport bind failure, it logs the error to stderr and exits(1).
  await startServer(server);
}

// [Implements: NFR-MC-006] Catch any unhandled error during startup and exit(1)
void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[mcp-server] FATAL: ${message}\n`);
  process.exit(1);
});
