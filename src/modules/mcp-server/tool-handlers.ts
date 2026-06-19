/**
 * Tool dispatch handlers for the MCP server module.
 *
 * Receives validated tool-call requests from the MCP SDK, dispatches them to
 * the injected pipeline-orchestration functions, and formats responses
 * (success or error) as MCP-standard CallToolResult objects.
 *
 * [Spec: US-MC-006, US-MC-007, US-MC-008, US-MC-009, US-MC-010, US-MC-011,
 *        DC-MC-003, DC-MC-004, DC-MC-007]
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  validateWebSearchParams,
  validateWebFetchParams,
} from './validation.js';
import type { WebSearchParams, WebFetchParams } from './validation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// [Spec: US-MC-006, US-MC-007, DC-MC-007]
// Orchestration handler functions injected into the MCP server (dependency
// injection per DC-MC-007 to keep the module boundary clean and testable).
export interface OrchestrationHandlers {
  /** Executes the full web_search pipeline. Returns a formatted digest string. */
  runWebSearch: (params: WebSearchParams) => Promise<string>;
  /** Executes the web_fetch sub-flow. Returns a formatted digest string. */
  runWebFetch: (params: WebFetchParams) => Promise<string>;
}

// [Spec: US-MC-008]
// Maximum character length for a digest string before truncation.
const MAX_RESPONSE_CHARS = 25_000;

// [Spec: US-MC-008]
// Suffix appended when a digest is truncated.
const TRUNCATION_SUFFIX = '\n\n[Response truncated due to length]';

// [Constraint: ErrorCategory]
// Known tool names for the unknown-tool error message.
const AVAILABLE_TOOL_NAMES = 'web_search, web_fetch';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a success CallToolResult from a digest string.
 *
 * Truncates the digest to MAX_RESPONSE_CHARS (25 000) characters and appends
 * a truncation suffix if it exceeds the limit.
 *
 * [Implements: US-MC-008]
 */
function createSuccessResult(digest: string): CallToolResult {
  // [Implements: US-MC-008] Truncate at 25 000 chars with suffix
  const text =
    digest.length > MAX_RESPONSE_CHARS
      ? digest.slice(0, MAX_RESPONSE_CHARS) + TRUNCATION_SUFFIX
      : digest;

  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

/**
 * Create an error CallToolResult from a message string.
 *
 * [Implements: US-MC-009, US-MC-010, US-MC-011]
 */
function createErrorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/**
 * Determine whether an error is a timeout-related error.
 *
 * Checks for common timeout error class names and the `name` property.
 *
 * [Implements: US-MC-011]
 */
function isTimeoutError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  const name = (error as { name?: string }).name;
  if (typeof name === 'string') {
    const lower = name.toLowerCase();
    if (
      lower.includes('timeout') ||
      lower.includes('timedout') ||
      lower.includes('timed_out')
    ) {
      return true;
    }
  }

  const message = (error as { message?: string }).message;
  if (typeof message === 'string') {
    const lower = message.toLowerCase();
    if (
      lower.includes('timeout') ||
      lower.includes('timed out') ||
      lower.includes('timedout') ||
      lower.includes('aborted')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Map a pipeline-orchestration error to a human-readable error message.
 *
 * - Timeout errors: returns a user-friendly timeout message.
 * - All other errors: returns an internal-error message without leaking the
 *   stack trace (the full stack is logged to stderr by the caller).
 *
 * [Implements: US-MC-011, NFR-MC-004]
 */
function mapOrchestrationError(error: unknown): string {
  // [Implements: US-MC-011] Timeout-specific message
  if (isTimeoutError(error)) {
    return (
      'Research timed out. Please try reducing max_results or try again later.'
    );
  }

  // [Implements: US-MC-011] Generic internal-error message
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error';

  return `Internal error: ${message}. See server logs for details.`;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

/**
 * Handle a `web_search` tool call.
 *
 * Validates parameters, invokes the PL `runWebSearch` handler, and formats
 * the result as a CallToolResult. On validation failure or PL error, returns
 * an appropriate error CallToolResult instead of throwing.
 *
 * [Implements: US-MC-006, US-MC-008, US-MC-010, US-MC-011]
 */
// [Route: tools/call web_search] [Implements: US-MC-006]
async function handleWebSearch(
  args: unknown,
  handlers: OrchestrationHandlers
): Promise<CallToolResult> {
  // [Implements: US-MC-010] Validate parameters before dispatching
  const validation = validateWebSearchParams(args);
  if (!validation.success) {
    return createErrorResult(validation.message);
  }

  const params = validation.data;

  // [Implements: US-MC-006] Log dispatch to stderr (NFR-MC-002: no stdout pollution)
  process.stderr.write(
    `[mcp-server] dispatching web_search: ${params.query}\n`
  );

  try {
    // [Implements: US-MC-006] Invoke the PL orchestration function
    const digest = await handlers.runWebSearch(params);
    // [Implements: US-MC-008] Format as success result
    return createSuccessResult(digest);
  } catch (error) {
    // [Implements: US-MC-011] Log full stack trace to stderr only (NFR-MC-004)
    if (error instanceof Error && error.stack) {
      process.stderr.write(`[mcp-server] PL error (web_search): ${error.stack}\n`);
    } else {
      process.stderr.write(`[mcp-server] PL error (web_search): ${String(error)}\n`);
    }
    return createErrorResult(mapOrchestrationError(error));
  }
}

/**
 * Handle a `web_fetch` tool call.
 *
 * Validates parameters, invokes the PL `runWebFetch` handler, and formats
 * the result as a CallToolResult. On validation failure or PL error, returns
 * an appropriate error CallToolResult instead of throwing.
 *
 * [Implements: US-MC-007, US-MC-008, US-MC-010, US-MC-011]
 */
// [Route: tools/call web_fetch] [Implements: US-MC-007]
async function handleWebFetch(
  args: unknown,
  handlers: OrchestrationHandlers
): Promise<CallToolResult> {
  // [Implements: US-MC-010] Validate parameters before dispatching
  const validation = validateWebFetchParams(args);
  if (!validation.success) {
    return createErrorResult(validation.message);
  }

  const params = validation.data;

  // [Implements: US-MC-007] Log dispatch to stderr (NFR-MC-002: no stdout pollution)
  process.stderr.write(
    `[mcp-server] dispatching web_fetch: ${params.url}\n`
  );

  try {
    // [Implements: US-MC-007] Invoke the PL orchestration function
    const digest = await handlers.runWebFetch(params);
    // [Implements: US-MC-008] Format as success result
    return createSuccessResult(digest);
  } catch (error) {
    // [Implements: US-MC-011] Log full stack trace to stderr only (NFR-MC-004)
    if (error instanceof Error && error.stack) {
      process.stderr.write(`[mcp-server] PL error (web_fetch): ${error.stack}\n`);
    } else {
      process.stderr.write(`[mcp-server] PL error (web_fetch): ${String(error)}\n`);
    }
    return createErrorResult(mapOrchestrationError(error));
  }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/**
 * Create a tool-call dispatcher function for the MCP server.
 *
 * The returned function accepts a tool name and raw arguments object and
 * returns a Promise resolving to a CallToolResult. It handles:
 *   - `web_search`  → validate + runWebSearch (US-MC-006)
 *   - `web_fetch`   → validate + runWebFetch  (US-MC-007)
 *   - unknown tool  → error result            (US-MC-009)
 *
 * This function never throws — all errors are caught and formatted as
 * error CallToolResult objects.
 *
 * @param handlers Injected PL orchestration functions (DC-MC-007).
 * @returns A dispatcher function `(name, args) => Promise<CallToolResult>`.
 *
 * [Implements: US-MC-006, US-MC-007, US-MC-008, US-MC-009, US-MC-010, US-MC-011, DC-MC-007]
 */
export function createToolDispatcher(
  handlers: OrchestrationHandlers
): (name: string, args: unknown) => Promise<CallToolResult> {
  // [Implements: US-MC-006, US-MC-007, US-MC-009, US-MC-010, US-MC-011]
  return async function dispatch(
    name: string,
    args: unknown
  ): Promise<CallToolResult> {
    switch (name) {
      case 'web_search':
        return handleWebSearch(args, handlers);

      case 'web_fetch':
        return handleWebFetch(args, handlers);

      default:
        // [Implements: US-MC-009] Unknown tool — log and return error
        process.stderr.write(
          `[mcp-server] unknown tool requested: ${name}\n`
        );
        return createErrorResult(
          `Unknown tool: ${name}. Available tools: ${AVAILABLE_TOOL_NAMES}.`
        );
    }
  };
}
