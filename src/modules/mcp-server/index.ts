/**
 * MCP Server (MC) Module — Public barrel exports.
 *
 * Re-exports the server lifecycle functions (createServer, startServer,
 * shutdown) and the configuration types (CreateServerOptions,
 * OrchestrationHandlers) for consumption by the process entry point
 * (src/index.ts) and external callers.
 *
 * [Spec: US-MC-001, US-MC-012, DC-MC-005, DC-MC-006, DC-MC-007]
 */

// [Implements: US-MC-001, DC-MC-005] Server lifecycle functions
export { createServer, startServer, shutdown } from './server.js';

// [Implements: DC-MC-005, DC-MC-007] Configuration type interfaces
export type { CreateServerOptions } from './server.js';
export type { OrchestrationHandlers } from './tool-handlers.js';
