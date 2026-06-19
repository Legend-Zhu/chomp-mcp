/**
 * MCP Server lifecycle and Stdio transport setup.
 *
 * Creates and configures the @modelcontextprotocol/sdk Server with the tools
 * capability, registers tools/list and tools/call handlers, connects via
 * StdioServerTransport, and manages graceful shutdown with signal handlers
 * (SIGTERM, SIGINT) and stdin-close detection.
 *
 * All diagnostics are written to stderr — stdout is reserved exclusively for
 * StdioServerTransport JSON-RPC traffic (NFR-MC-002).
 *
 * [Spec: US-MC-001, US-MC-002, US-MC-005, US-MC-013, US-MC-014,
 *        BG-MC-001, BG-MC-002, BG-MC-003,
 *        NFR-MC-001, NFR-MC-002, NFR-MC-003, NFR-MC-005, NFR-MC-006,
 *        DC-MC-001, DC-MC-002, DC-MC-004, DC-MC-007]
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { TOOL_DEFINITIONS } from './tool-definitions.js';
import type { OrchestrationHandlers } from './tool-handlers.js';
import { createToolDispatcher } from './tool-handlers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// [Constraint: DC-MC-007] Grace period for in-flight tool calls during shutdown.
const SHUTDOWN_GRACE_PERIOD_MS = 5_000;

// [Constraint: NFR-MC-003] Polling interval for in-flight call counting.
const SHUTDOWN_POLL_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// [Spec: US-MC-014] Counter tracking the number of in-flight tool dispatches.
let activeToolCalls = 0;

// Track the currently-connected transport for shutdown.
let activeTransport: StdioServerTransport | null = null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// [Spec: US-MC-001, DC-MC-001]
// Options for the createServer factory function.
export interface CreateServerOptions {
  /** Injected PL orchestration functions (DC-MC-007). */
  handlers: OrchestrationHandlers;
  /** Server name for MCP handshake. Default: "chomp-mcp". */
  serverName?: string;
  /** Server version for MCP handshake. Default: "1.0.0". */
  serverVersion?: string;
}

// [Spec: US-MC-001, DC-MC-001]
// Server identity metadata returned to MCP clients during initialization.
export interface ServerInfo {
  /** Server name for MCP handshake. */
  name: string;
  /** Server version for MCP handshake. */
  version: string;
}

// ---------------------------------------------------------------------------
// Server creation
// ---------------------------------------------------------------------------

/**
 * Create and configure an MCP Server with tools capability.
 *
 * The server advertises the `tools` capability in the initialize handshake,
 * registers a tools/list handler returning exactly [web_search, web_fetch],
 * and registers a tools/call handler that dispatches to the injected PL
 * functions via createToolDispatcher.
 *
 * The tools/call handler increments the activeToolCalls counter before
 * dispatch and decrements it in a finally block, enabling the shutdown
 * logic to wait for in-flight calls to complete.
 *
 * @param options Server configuration and injected handlers.
 * @returns Configured MCP Server instance (not yet connected to a transport).
 *
 * [Implements: US-MC-001, US-MC-002, US-MC-005, BG-MC-001, BG-MC-002,
 *               DC-MC-001, DC-MC-002, DC-MC-004, DC-MC-007]
 */
// [Implements: US-MC-001, US-MC-002, US-MC-005, DC-MC-001, DC-MC-002]
export function createServer(options: CreateServerOptions): Server {
  const serverName = options.serverName ?? 'chomp-mcp';
  const serverVersion = options.serverVersion ?? '1.0.0';

  // [Implements: US-MC-002, BG-MC-001, DC-MC-002] Create Server with tools capability
  const server = new Server(
    { name: serverName, version: serverVersion },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // [Implements: BG-MC-002] Log ready state when initialized notification arrives
  server.oninitialized = () => {
    process.stderr.write('[mcp-server] session ready\n');
  };

  // [Implements: US-MC-005, DC-MC-004] Register tools/list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // [Implements: US-MC-005] Return exactly two tool definitions
    return {
      tools: TOOL_DEFINITIONS,
    };
  });

  // [Implements: US-MC-001, DC-MC-007] Register tools/call handler
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      const toolName = request.params.name;
      const toolArguments = request.params.arguments ?? {};

      // [Implements: US-MC-014] Track in-flight calls for graceful shutdown
      activeToolCalls++;

      // Create the dispatcher from the injected handlers
      const dispatcher = createToolDispatcher(options.handlers);

      try {
        return await dispatcher(toolName, toolArguments);
      } finally {
        // [Implements: US-MC-014] Always decrement, even on error/throw
        activeToolCalls--;
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

/**
 * Start the MCP server by connecting it to a StdioServerTransport.
 *
 * Creates a new StdioServerTransport, sets up the onclose callback to exit
 * cleanly when stdin is closed (client disconnect), registers SIGTERM and
 * SIGINT handlers for graceful shutdown, then connects the server to the
 * transport.
 *
 * After a successful connection, logs `[mcp-server] listening on stdio` to
 * stderr.
 *
 * @param server The MCP Server instance to connect.
 *
 * [Implements: US-MC-001, US-MC-013, US-MC-014, BG-MC-003,
 *               NFR-MC-001, NFR-MC-002, DC-MC-001]
 */
// [Implements: US-MC-001, BG-MC-003, NFR-MC-001, NFR-MC-002]
export async function startServer(server: Server): Promise<void> {
  // [Implements: US-MC-001, NFR-MC-001] Create StdioServerTransport
  const transport = new StdioServerTransport();
  activeTransport = transport;

  // [Implements: US-MC-013, NFR-MC-005] When stdin closes (client disconnects),
  // release resources and exit cleanly with code 0.
  transport.onclose = () => {
    process.stderr.write(
      '[mcp-server] stdin closed — transport disconnected\n'
    );
    process.exit(0);
  };

  // [Implements: BG-MC-003, NFR-MC-003] Transport error handler
  transport.onerror = (error: Error) => {
    process.stderr.write(
      `[mcp-server] transport error: ${error.message}\n`
    );
  };

  // [Implements: US-MC-014, BG-MC-003] SIGTERM handler — graceful shutdown
  process.on('SIGTERM', () => {
    process.stderr.write('[mcp-server] received SIGTERM, shutting down\n');
    void shutdown(server);
  });

  // [Implements: US-MC-014, BG-MC-003] SIGINT handler — same as SIGTERM
  process.on('SIGINT', () => {
    process.stderr.write('[mcp-server] received SIGINT, shutting down\n');
    void shutdown(server);
  });

  try {
    // [Implements: US-MC-001, BG-MC-001] Connect server to the transport
    await server.connect(transport);
  } catch (error) {
    // [Implements: NFR-MC-006] Transport bind failure — log and exit code 1
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[mcp-server] FATAL: failed to connect transport: ${message}\n`
    );
    process.exit(1);
  }

  // [Implements: NFR-MC-002] Startup log to stderr (stdout reserved for JSON-RPC)
  process.stderr.write('[mcp-server] listening on stdio\n');
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Gracefully shut down the MCP server.
 *
 * Polls the activeToolCalls counter every SHUTDOWN_POLL_INTERVAL_MS until it
 * reaches zero or the SHUTDOWN_GRACE_PERIOD_MS timeout expires. Then closes
 * the server transport and exits with code 0.
 *
 * In-flight tool calls are given up to 5 seconds to complete before forcing
 * exit.
 *
 * @param server The MCP Server instance to shut down.
 *
 * [Implements: US-MC-014, NFR-MC-005]
 */
// [Implements: US-MC-014, NFR-MC-005]
export async function shutdown(server: Server): Promise<void> {
  const deadline = Date.now() + SHUTDOWN_GRACE_PERIOD_MS;

  // [Implements: US-MC-014] Wait for in-flight calls to complete (up to 5s)
  while (activeToolCalls > 0 && Date.now() < deadline) {
    await sleep(SHUTDOWN_POLL_INTERVAL_MS);
  }

  if (activeToolCalls > 0) {
    // [Implements: US-MC-014, NFR-MC-005] Grace period expired — force shutdown
    process.stderr.write(
      `[mcp-server] shutdown grace period (${SHUTDOWN_GRACE_PERIOD_MS}ms) expired with ${activeToolCalls} call(s) in flight\n`
    );
  } else {
    process.stderr.write(
      '[mcp-server] all in-flight calls completed\n'
    );
  }

  // Close the server (which closes the underlying transport)
  try {
    await server.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[mcp-server] error during server.close(): ${message}\n`
    );
  }

  // Also explicitly close the transport if still held
  if (activeTransport !== null) {
    try {
      await activeTransport.close();
    } catch {
      // Transport already closed — ignore
    }
    activeTransport = null;
  }

  // [Implements: US-MC-014, BG-MC-003] Exit cleanly
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Promise-based sleep that resolves after the given milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
