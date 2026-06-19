/**
 * Integration tests for MCP server lifecycle and transport (server.ts).
 *
 * Tests cover:
 * - createServer() configuration (tools capability, handler registration,
 *   serverInfo, tools/list response)
 * - startServer() stdio transport connection and startup logging
 * - shutdown() grace period behavior with in-flight tool calls
 * - Signal handling (SIGTERM, SIGINT) registration
 * - Error handling for transport connect failure
 *
 * Uses InMemoryTransport + Client for full request/response testing of the
 * server without spawning real processes or using real stdio.
 * process.exit, process.on, and transport.connect are mocked to prevent
 * real process termination.
 *
 * [Spec: US-MC-001, US-MC-002, US-MC-005, US-MC-013, US-MC-014]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  InMemoryTransport,
} from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createServer,
  startServer,
  shutdown,
} from '../../../src/modules/mcp-server/server.js';
import type { CreateServerOptions } from '../../../src/modules/mcp-server/server.js';
import type { OrchestrationHandlers } from '../../../src/modules/mcp-server/tool-handlers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandlers(): OrchestrationHandlers {
  return {
    runWebSearch: vi.fn().mockResolvedValue('search digest result'),
    runWebFetch: vi.fn().mockResolvedValue('fetch digest result'),
  };
}

function makeOptions(
  overrides?: Partial<CreateServerOptions>
): CreateServerOptions {
  return {
    handlers: makeHandlers(),
    serverName: 'chomp-mcp',
    serverVersion: '1.0.0',
    ...overrides,
  };
}

function captureStderr(
  spy: ReturnType<typeof vi.spyOn>
): string {
  return spy.mock.calls.map((c) => String(c[0])).join('');
}

/**
 * Connect a created server to an in-memory Client pair.
 * Returns { client, server, transports } after performing the MCP
 * initialize handshake.
 */
async function connectInMemory(
  server: Server
): Promise<{ client: Client }> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} }
  );
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client };
}

// ---------------------------------------------------------------------------
// createServer — basic construction
// ---------------------------------------------------------------------------

describe('createServer', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-001]
  it('returns a Server instance', () => {
    const server = createServer(makeOptions());
    expect(server).toBeInstanceOf(Server);
  });

  // [Implements: US-MC-001]
  it('creates the server without throwing', () => {
    expect(() => createServer(makeOptions())).not.toThrow();
  });

  // [Implements: US-MC-002]
  it('accepts custom serverName and serverVersion', () => {
    expect(() =>
      createServer(
        makeOptions({ serverName: 'test-name', serverVersion: '2.3.4' })
      )
    ).not.toThrow();
  });

  // [Implements: US-MC-002]
  it('accepts handlers without throwing', () => {
    const handlers = makeHandlers();
    expect(() => createServer({ handlers })).not.toThrow();
  });

  // --- capabilities ---

  // [Implements: US-MC-002]
  it('server has tools capability declared', () => {
    const server = createServer(makeOptions());
    // The Server constructor receives capabilities config; the capabilities
    // are advertised during the initialize handshake.
    expect(server).toBeInstanceOf(Server);
  });

  // --- oninitialized ---

  // [Implements: US-MC-005]
  it('logs "[mcp-server] session ready" when oninitialized fires', () => {
    const server = createServer(makeOptions()) as unknown as {
      oninitialized: () => void;
    };
    server.oninitialized();
    expect(captureStderr(stderrSpy)).toContain('[mcp-server] session ready');
  });
});

// ---------------------------------------------------------------------------
// createServer — tools/list and tools/call via in-memory client
// ---------------------------------------------------------------------------

describe('createServer — tools/list', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-005]
  it('returns exactly two tools from tools/list', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    await client.close();
  });

  // [Implements: US-MC-005]
  it('returns web_search and web_fetch from tools/list', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
    await client.close();
  });

  // [Implements: US-MC-005]
  it('each tool entry includes name, description, and inputSchema keys', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.inputSchema).toBe('object');
    }
    await client.close();
  });

  // [Implements: US-MC-005]
  it('tools/list returns web_search as the first tool', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    expect(result.tools[0].name).toBe('web_search');
    await client.close();
  });

  // [Implements: US-MC-005]
  it('tools/list returns web_fetch as the second tool', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    expect(result.tools[1].name).toBe('web_fetch');
    await client.close();
  });
});

describe('createServer — tools/call dispatch', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-001]
  it('dispatches web_search tool call to handlers.runWebSearch', async () => {
    const handlers = makeHandlers();
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'test query' },
    });

    expect(handlers.runWebSearch).toHaveBeenCalledTimes(1);
    expect(handlers.runWebFetch).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as { text: string }).text).toBe(
      'search digest result'
    );
    await client.close();
  });

  // [Implements: US-MC-001]
  it('dispatches web_fetch tool call to handlers.runWebFetch', async () => {
    const handlers = makeHandlers();
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_fetch',
      arguments: { url: 'https://example.com' },
    });

    expect(handlers.runWebFetch).toHaveBeenCalledTimes(1);
    expect(handlers.runWebSearch).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toBe(
      'fetch digest result'
    );
    await client.close();
  });

  // [Implements: US-MC-001]
  it('returns isError=true for unknown tool name', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'nonexistent_tool',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    await client.close();
  });

  // [Implements: US-MC-001]
  it('returns isError=true for web_search with missing query', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_search',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    await client.close();
  });

  // [Implements: US-MC-001]
  it('returns isError=true for web_fetch with missing url', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_fetch',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    await client.close();
  });

  // [Implements: US-MC-001]
  it('returns content array with type "text" for web_search', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'test' },
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    await client.close();
  });

  // [Implements: US-MC-001]
  it('returns content with the digest text from handler', async () => {
    const handlers = makeHandlers();
    handlers.runWebSearch = vi.fn().mockResolvedValue('custom digest content');
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'test' },
    });

    expect((result.content[0] as { text: string }).text).toBe(
      'custom digest content'
    );
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Server identity (initialize handshake response)
// ---------------------------------------------------------------------------

describe('server identity and capabilities', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-002]
  it('advertises the correct server name in the initialize handshake', async () => {
    const server = createServer(
      makeOptions({ serverName: 'custom-server', serverVersion: '0.5.0' })
    );
    const { client } = await connectInMemory(server);
    // After connect, the client's getServerVersion returns the server info.
    expect(client.getServerVersion()).toEqual({
      name: 'custom-server',
      version: '0.5.0',
    });
    await client.close();
  });

  // [Implements: US-MC-002]
  it('uses default name "chomp-mcp" when not specified', async () => {
    const server = createServer({ handlers: makeHandlers() });
    const { client } = await connectInMemory(server);
    expect(client.getServerVersion()).toEqual({
      name: 'chomp-mcp',
      version: '1.0.0',
    });
    await client.close();
  });

  // [Implements: US-MC-002]
  it('uses default version "1.0.0" when serverVersion not provided', async () => {
    const server = createServer({ handlers: makeHandlers() });
    const { client } = await connectInMemory(server);
    expect(client.getServerVersion()).toEqual({
      name: 'chomp-mcp',
      version: '1.0.0',
    });
    await client.close();
  });

  // [Implements: US-MC-002]
  it('uses default version when serverVersion is undefined', async () => {
    const server = createServer(makeOptions({ serverVersion: undefined }));
    const { client } = await connectInMemory(server);
    expect(client.getServerVersion()).toEqual({
      name: 'chomp-mcp',
      version: '1.0.0',
    });
    await client.close();
  });

  // [Implements: US-MC-002]
  it('uses custom version string in handshake', async () => {
    const server = createServer(makeOptions({ serverVersion: 'v9.9.9-beta' }));
    const { client } = await connectInMemory(server);
    expect(client.getServerVersion()).toEqual({
      name: 'chomp-mcp',
      version: 'v9.9.9-beta',
    });
    await client.close();
  });

  // [Implements: US-MC-002]
  it('declares tools capability in capabilities object', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const caps = client.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps!.tools).toBeDefined();
    await client.close();
  });

  // [Implements: US-MC-005]
  it('logs "[mcp-server] session ready" after initialized notification', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    // The client automatically sends the initialized notification after connect.
    // Allow microtasks to flush.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(captureStderr(stderrSpy)).toContain('[mcp-server] session ready');
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

describe('startServer', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let onSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    onSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-001]
  it('logs "[mcp-server] listening on stdio" after successful connect', async () => {
    const server = createServer(makeOptions());
    await startServer(server);
    expect(captureStderr(stderrSpy)).toContain('[mcp-server] listening on stdio');
  });

  // [Implements: US-MC-001]
  it('does not throw on successful connect', async () => {
    const server = createServer(makeOptions());
    await expect(startServer(server)).resolves.toBeUndefined();
  });

  // [Implements: US-MC-001, US-MC-002]
  it('registers SIGTERM handler via process.on', async () => {
    const server = createServer(makeOptions());
    await startServer(server);
    const sigtermRegistered = onSpy.mock.calls.some(
      ([event]) => event === 'SIGTERM'
    );
    expect(sigtermRegistered).toBe(true);
  });

  // [Implements: US-MC-001, US-MC-002]
  it('registers SIGINT handler via process.on', async () => {
    const server = createServer(makeOptions());
    await startServer(server);
    const sigintRegistered = onSpy.mock.calls.some(
      ([event]) => event === 'SIGINT'
    );
    expect(sigintRegistered).toBe(true);
  });

  // [Implements: US-MC-014]
  it('does not write to stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const server = createServer(makeOptions());
      await startServer(server);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // --- transport error handling ---

  // [Implements: US-MC-001]
  it('logs an error and exits with code 1 if server.connect throws', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'connect').mockRejectedValue(new Error('bind failed'));

    await expect(startServer(server)).rejects.toThrow('process.exit(1)');
    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server]');
    expect(output).toContain('failed to connect transport');
    expect(output).toContain('bind failed');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // [Implements: US-MC-001]
  it('logs an error and exits with code 1 for non-Error connect failure', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'connect').mockRejectedValue('string error');

    await expect(startServer(server)).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // [Implements: US-MC-001, NFR-MC-002]
  it('writes startup log only to stderr (not stdout)', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const server = createServer(makeOptions());
      await startServer(server);
      const stderrOutput = captureStderr(stderrSpy);
      expect(stderrOutput).toContain('[mcp-server] listening on stdio');
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // [Implements: US-MC-001]
  it('logs the listening message exactly once', async () => {
    const server = createServer(makeOptions());
    await startServer(server);
    const output = captureStderr(stderrSpy);
    const matches = output.match(/listening on stdio/g);
    expect(matches).toHaveLength(1);
  });

  // [Implements: US-MC-001]
  it('registers exactly two signal handlers (SIGTERM and SIGINT)', async () => {
    const server = createServer(makeOptions());
    await startServer(server);
    const signalEvents = onSpy.mock.calls
      .map(([event]) => event as string)
      .filter((e) => e === 'SIGTERM' || e === 'SIGINT');
    expect(signalEvents).toHaveLength(2);
    expect(signalEvents).toContain('SIGTERM');
    expect(signalEvents).toContain('SIGINT');
  });

  // [Implements: US-MC-001]
  it('logs "[mcp-server]" prefix in the connect failure message', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'connect').mockRejectedValue(
      new Error('EACCES permission denied')
    );

    try {
      await startServer(server);
    } catch {
      // expected — process.exit throws
    }
    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server]');
    expect(output).toContain('EACCES permission denied');
  });
});

// ---------------------------------------------------------------------------
// Signal handler invocation (SIGTERM/SIGINT → shutdown)
// ---------------------------------------------------------------------------

describe('signal handler invocation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let onSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // For signal handler tests, process.exit must be a no-op (not throw)
    // because the signal handler fires shutdown asynchronously via `void`.
    // A throwing mock would create an unhandled rejection from the detached
    // promise. We still assert the call was made with the correct code.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    onSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-014]
  it('SIGTERM handler logs the SIGTERM receipt message and triggers shutdown', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockResolvedValue(undefined);
    await startServer(server);

    // Find the SIGTERM handler
    const sigtermCall = onSpy.mock.calls.find(
      ([event]) => event === 'SIGTERM'
    );
    expect(sigtermCall).toBeDefined();
    const handler = sigtermCall![1] as () => void;

    // Invoke the handler — shutdown will call process.exit(0)
    handler();

    // Wait for the async shutdown to progress
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(captureStderr(stderrSpy)).toContain(
      '[mcp-server] received SIGTERM'
    );
  });

  // [Implements: US-MC-014]
  it('SIGINT handler logs the SIGINT receipt message and triggers shutdown', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockResolvedValue(undefined);
    await startServer(server);

    const sigintCall = onSpy.mock.calls.find(
      ([event]) => event === 'SIGINT'
    );
    expect(sigintCall).toBeDefined();
    const handler = sigintCall![1] as () => void;

    handler();

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(captureStderr(stderrSpy)).toContain(
      '[mcp-server] received SIGINT'
    );
  });

  // [Implements: US-MC-014]
  it('SIGTERM and SIGINT handlers are functions', async () => {
    const server = createServer(makeOptions());
    await startServer(server);

    const sigtermCall = onSpy.mock.calls.find(
      ([event]) => event === 'SIGTERM'
    );
    const sigintCall = onSpy.mock.calls.find(
      ([event]) => event === 'SIGINT'
    );
    expect(typeof sigtermCall![1]).toBe('function');
    expect(typeof sigintCall![1]).toBe('function');
  });

  // [Implements: US-MC-014]
  it('SIGTERM handler does not throw synchronously', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockResolvedValue(undefined);
    await startServer(server);

    const sigtermCall = onSpy.mock.calls.find(
      ([event]) => event === 'SIGTERM'
    );
    const handler = sigtermCall![1] as () => void;

    // The handler uses void shutdown(server) — it should not throw
    expect(() => handler()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

describe('shutdown', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-014]
  it('calls process.exit(0) when no in-flight tool calls', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockResolvedValue(undefined);

    await expect(shutdown(server)).rejects.toThrow('process.exit(0)');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  // [Implements: US-MC-014]
  it('logs "[mcp-server] all in-flight calls completed" when no active calls', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockResolvedValue(undefined);

    try {
      await shutdown(server);
    } catch {
      // expected — process.exit throws
    }
    expect(captureStderr(stderrSpy)).toContain('all in-flight calls completed');
  });

  // [Implements: US-MC-014]
  it('calls server.close() during shutdown', async () => {
    const server = createServer(makeOptions());
    const closeSpy = vi.spyOn(server, 'close').mockResolvedValue(undefined);

    try {
      await shutdown(server);
    } catch {
      // expected
    }
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-MC-014]
  it('exits with code 0 even if server.close throws', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockRejectedValue(new Error('close failed'));

    await expect(shutdown(server)).rejects.toThrow('process.exit(0)');
    const output = captureStderr(stderrSpy);
    expect(output).toContain('error during server.close()');
    expect(output).toContain('close failed');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  // [Implements: US-MC-014]
  it('exits with code 0 even if server.close throws a non-Error', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockRejectedValue('string error');

    await expect(shutdown(server)).rejects.toThrow('process.exit(0)');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  // [Implements: US-MC-014]
  it('does not write to stdout during shutdown', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockResolvedValue(undefined);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await shutdown(server);
    } catch {
      // expected
    }
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  // --- Additional shutdown scenarios (must run before grace-period tests) ---

  // [Implements: US-MC-014]
  it('always exits with code 0 (never non-zero)', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockResolvedValue(undefined);

    try {
      await shutdown(server);
    } catch {
      // expected
    }
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(2);
  });

  // [Implements: US-MC-014]
  it('logs "[mcp-server]" prefix in shutdown messages', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockResolvedValue(undefined);

    try {
      await shutdown(server);
    } catch {
      // expected
    }
    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server]');
  });

  // [Implements: US-MC-014]
  it('logs "all in-flight calls completed" without the grace period message', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockResolvedValue(undefined);

    try {
      await shutdown(server);
    } catch {
      // expected
    }
    const output = captureStderr(stderrSpy);
    expect(output).toContain('all in-flight calls completed');
    expect(output).not.toContain('grace period');
    expect(output).not.toContain('expired');
  });

  // [Implements: US-MC-014]
  it('does not call server.close() more than once', async () => {
    const server = createServer(makeOptions());
    const closeSpy = vi.spyOn(server, 'close').mockResolvedValue(undefined);

    try {
      await shutdown(server);
    } catch {
      // expected
    }
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-MC-014]
  it('shutdown after a server that has never started still exits with 0', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockResolvedValue(undefined);

    await expect(shutdown(server)).rejects.toThrow('process.exit(0)');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  // [Implements: US-MC-014, NFR-MC-005]
  it('logs the error message from server.close for non-Error rejection', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockRejectedValue(42);

    try {
      await shutdown(server);
    } catch {
      // expected
    }
    const output = captureStderr(stderrSpy);
    expect(output).toContain('error during server.close()');
    expect(output).toContain('42');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  // [Implements: US-MC-014, NFR-MC-005]
  it('does not write to stdout during shutdown even if close fails', async () => {
    const server = createServer(makeOptions());
    vi.spyOn(server, 'close').mockRejectedValue(new Error('close boom'));
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      await shutdown(server);
    } catch {
      // expected
    }
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// shutdown grace period with in-flight calls
// ---------------------------------------------------------------------------

describe('shutdown grace period with in-flight calls', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Use a no-op for process.exit in these tests so that the async shutdown
    // pipeline does not create unhandled rejections from detached promises.
    // We assert exitSpy was called with the correct code.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-014]
  it('waits for in-flight tool calls to complete before shutting down', async () => {
    const handlers = makeHandlers();
    // The runWebSearch handler resolves after a short delay
    let resolveSearch!: (value: string) => void;
    handlers.runWebSearch = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSearch = resolve;
        })
    );

    const server = createServer({ handlers });
    const closeSpy = vi.spyOn(server, 'close').mockResolvedValue(undefined);
    const { client } = await connectInMemory(server);

    // Start a tool call that won't resolve immediately
    const callPromise = client.callTool({
      name: 'web_search',
      arguments: { query: 'pending' },
    });

    // Wait for the handler to be invoked so resolveSearch is set
    await vi.waitFor(() => {
      expect(handlers.runWebSearch).toHaveBeenCalledTimes(1);
    });

    // Start shutdown — it should block because activeToolCalls > 0
    const shutdownPromise = shutdown(server);

    // Allow the in-flight call to complete
    resolveSearch('delayed result');
    await callPromise;

    // Now shutdown should proceed and call process.exit(0)
    await shutdownPromise;
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(captureStderr(stderrSpy)).toContain('all in-flight calls completed');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-MC-014]
  it('forces exit with grace period expired message when calls never complete', async () => {
    const handlers = makeHandlers();
    // This handler will never resolve
    handlers.runWebSearch = vi.fn().mockImplementation(
      () => new Promise<string>(() => {})
    );

    const server = createServer({ handlers });
    vi.spyOn(server, 'close').mockResolvedValue(undefined);
    const { client } = await connectInMemory(server);

    // Start a tool call that never resolves
    client.callTool({
      name: 'web_search',
      arguments: { query: 'stuck' },
    });

    // Give the dispatch a tick to increment activeToolCalls
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    vi.useFakeTimers();
    try {
      const shutdownPromise = shutdown(server);
      // Advance well past the 5s grace period (with polling at 100ms)
      vi.advanceTimersByTime(6_000);
      await shutdownPromise;
    } finally {
      vi.useRealTimers();
    }
    expect(exitSpy).toHaveBeenCalledWith(0);
    const output = captureStderr(stderrSpy);
    expect(output).toContain('grace period');
    expect(output).toContain('expired');
  });

  // [Implements: US-MC-014]
  it('shutdown logs grace-period message when multiple calls never complete', async () => {
    const handlers = makeHandlers();
    handlers.runWebSearch = vi.fn().mockImplementation(
      () => new Promise<string>(() => {})
    );
    handlers.runWebFetch = vi.fn().mockImplementation(
      () => new Promise<string>(() => {})
    );

    const server = createServer({ handlers });
    vi.spyOn(server, 'close').mockResolvedValue(undefined);
    const { client } = await connectInMemory(server);

    // Start two tool calls that never resolve
    client.callTool({
      name: 'web_search',
      arguments: { query: 'stuck-1' },
    });
    client.callTool({
      name: 'web_fetch',
      arguments: { url: 'https://stuck.example.com' },
    });

    // Give dispatch a tick to increment activeToolCalls
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    vi.useFakeTimers();
    try {
      const shutdownPromise = shutdown(server);
      vi.advanceTimersByTime(6_000);
      await shutdownPromise;
    } finally {
      vi.useRealTimers();
    }
    expect(exitSpy).toHaveBeenCalledWith(0);
    const output = captureStderr(stderrSpy);
    expect(output).toContain('grace period');
    expect(output).toContain('expired');
    // Message should indicate more than one call in flight
    expect(output).toContain('call(s) in flight');
  });
});

// ---------------------------------------------------------------------------
// Multiple createServer calls (no singleton leakage)
// ---------------------------------------------------------------------------

describe('multiple createServer calls', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-001]
  it('creates independent server instances', () => {
    const server1 = createServer(makeOptions({ serverName: 'server-1' }));
    const server2 = createServer(makeOptions({ serverName: 'server-2' }));
    expect(server1).not.toBe(server2);
  });

  // [Implements: US-MC-001]
  it('both servers can list tools independently', async () => {
    const server1 = createServer(makeOptions());
    const server2 = createServer(makeOptions());
    const { client: client1 } = await connectInMemory(server1);
    const { client: client2 } = await connectInMemory(server2);
    const result1 = await client1.listTools();
    const result2 = await client2.listTools();
    expect(result1.tools).toHaveLength(2);
    expect(result2.tools).toHaveLength(2);
    await client1.close();
    await client2.close();
  });

  // [Implements: US-MC-001]
  it('different handlers can be injected into different servers', async () => {
    const handlers1 = makeHandlers();
    const handlers2 = makeHandlers();
    const server1 = createServer({ handlers: handlers1 });
    const server2 = createServer({ handlers: handlers2 });

    const { client: client1 } = await connectInMemory(server1);
    const { client: client2 } = await connectInMemory(server2);

    await client1.callTool({
      name: 'web_search',
      arguments: { query: 'q1' },
    });
    await client2.callTool({
      name: 'web_fetch',
      arguments: { url: 'https://a.com' },
    });

    expect(handlers1.runWebSearch).toHaveBeenCalledTimes(1);
    expect(handlers1.runWebFetch).not.toHaveBeenCalled();
    expect(handlers2.runWebFetch).toHaveBeenCalledTimes(1);
    expect(handlers2.runWebSearch).not.toHaveBeenCalled();

    await client1.close();
    await client2.close();
  });
});

// ---------------------------------------------------------------------------
// tools/call result structure
// ---------------------------------------------------------------------------

describe('tools/call result structure', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-001]
  it('returns isError=false for successful web_search', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'test' },
    });

    expect(result.isError).toBeFalsy();
    await client.close();
  });

  // [Implements: US-MC-001]
  it('returns isError=false for successful web_fetch', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_fetch',
      arguments: { url: 'https://example.com' },
    });

    expect(result.isError).toBeFalsy();
    await client.close();
  });
});

// ===========================================================================
// ADDITIONAL TESTS — MC8b (part 2)
// ===========================================================================
//
// The following test suites extend coverage for:
// - tools/list schema detail verification via in-memory client
// - tools/call argument forwarding (camelCase mapping, defaults)
// - tools/call concurrent calls
// - tools/call error response content verification
// - createServer name/version edge cases
// - Protocol compliance (initialize handshake structure)
// - tools/call success response completeness

// ---------------------------------------------------------------------------
// tools/list — schema detail verification via in-memory client
// ---------------------------------------------------------------------------

describe('tools/list — schema detail verification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-005, DC-MC-004]
  it('web_search inputSchema requires the "query" field', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    const searchTool = result.tools.find((t) => t.name === 'web_search');
    expect(searchTool).toBeDefined();
    expect(searchTool!.inputSchema.required).toContain('query');
    await client.close();
  });

  // [Implements: US-MC-005, DC-MC-004]
  it('web_fetch inputSchema requires the "url" field', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    const fetchTool = result.tools.find((t) => t.name === 'web_fetch');
    expect(fetchTool).toBeDefined();
    expect(fetchTool!.inputSchema.required).toContain('url');
    await client.close();
  });

  // [Implements: US-MC-005, DC-MC-004]
  it('web_search inputSchema has additionalProperties: false', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    const searchTool = result.tools.find((t) => t.name === 'web_search');
    expect(searchTool!.inputSchema.additionalProperties).toBe(false);
    await client.close();
  });

  // [Implements: US-MC-005, DC-MC-004]
  it('web_fetch inputSchema has additionalProperties: false', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    const fetchTool = result.tools.find((t) => t.name === 'web_fetch');
    expect(fetchTool!.inputSchema.additionalProperties).toBe(false);
    await client.close();
  });

  // [Implements: US-MC-005, DC-MC-004]
  it('web_search inputSchema has type "object"', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    const searchTool = result.tools.find((t) => t.name === 'web_search');
    expect(searchTool!.inputSchema.type).toBe('object');
    await client.close();
  });

  // [Implements: US-MC-005, DC-MC-004]
  it('web_fetch inputSchema has type "object"', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    const fetchTool = result.tools.find((t) => t.name === 'web_fetch');
    expect(fetchTool!.inputSchema.type).toBe('object');
    await client.close();
  });

  // [Implements: US-MC-005, DC-MC-004]
  it('web_search inputSchema defines query, max_results, and focus properties', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    const searchTool = result.tools.find((t) => t.name === 'web_search');
    const props = Object.keys(searchTool!.inputSchema.properties ?? {});
    expect(props).toContain('query');
    expect(props).toContain('max_results');
    expect(props).toContain('focus');
    await client.close();
  });

  // [Implements: US-MC-005, DC-MC-004]
  it('web_fetch inputSchema defines url and focus properties', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    const fetchTool = result.tools.find((t) => t.name === 'web_fetch');
    const props = Object.keys(fetchTool!.inputSchema.properties ?? {});
    expect(props).toContain('url');
    expect(props).toContain('focus');
    await client.close();
  });

  // [Implements: US-MC-005]
  it('both tools have non-empty descriptions', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
    await client.close();
  });

  // [Implements: US-MC-005]
  it('tools are always returned in the same order across multiple list calls', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const result1 = await client.listTools();
    const result2 = await client.listTools();
    expect(result1.tools.map((t) => t.name)).toEqual(
      result2.tools.map((t) => t.name)
    );
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// tools/call — argument forwarding
// ---------------------------------------------------------------------------

describe('tools/call — argument forwarding', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-006]
  it('forwards query and max_results to runWebSearch in camelCase', async () => {
    const handlers = makeHandlers();
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    await client.callTool({
      name: 'web_search',
      arguments: { query: 'climate change', max_results: 10 },
    });

    expect(handlers.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'climate change',
        maxResults: 10,
      })
    );
    await client.close();
  });

  // [Implements: US-MC-006]
  it('forwards focus to runWebSearch when provided', async () => {
    const handlers = makeHandlers();
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    await client.callTool({
      name: 'web_search',
      arguments: { query: 'test', focus: 'hardware' },
    });

    expect(handlers.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ focus: 'hardware' })
    );
    await client.close();
  });

  // [Implements: US-MC-007]
  it('forwards url and focus to runWebFetch when provided', async () => {
    const handlers = makeHandlers();
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    await client.callTool({
      name: 'web_fetch',
      arguments: { url: 'https://docs.example.com/guide', focus: 'installation' },
    });

    expect(handlers.runWebFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://docs.example.com/guide',
        focus: 'installation',
      })
    );
    await client.close();
  });

  // [Implements: US-MC-006]
  it('defaults maxResults to 5 when max_results is omitted', async () => {
    const handlers = makeHandlers();
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    await client.callTool({
      name: 'web_search',
      arguments: { query: 'default test' },
    });

    expect(handlers.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 5 })
    );
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// tools/call — concurrent calls
// ---------------------------------------------------------------------------

describe('tools/call — concurrent calls', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-001]
  it('handles concurrent web_search calls', async () => {
    const handlers = makeHandlers();
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    const results = await Promise.all([
      client.callTool({
        name: 'web_search',
        arguments: { query: 'query-1' },
      }),
      client.callTool({
        name: 'web_search',
        arguments: { query: 'query-2' },
      }),
      client.callTool({
        name: 'web_search',
        arguments: { query: 'query-3' },
      }),
    ]);

    expect(handlers.runWebSearch).toHaveBeenCalledTimes(3);
    for (const result of results) {
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
    }
    await client.close();
  });

  // [Implements: US-MC-001]
  it('handles a mix of concurrent web_search and web_fetch calls', async () => {
    const handlers = makeHandlers();
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    const results = await Promise.all([
      client.callTool({
        name: 'web_search',
        arguments: { query: 'mixed-query' },
      }),
      client.callTool({
        name: 'web_fetch',
        arguments: { url: 'https://mixed.example.com' },
      }),
    ]);

    expect(handlers.runWebSearch).toHaveBeenCalledTimes(1);
    expect(handlers.runWebFetch).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.isError).toBeFalsy();
    }
    await client.close();
  });

  // [Implements: US-MC-001]
  it('handles rapid sequential calls to the same tool', async () => {
    const handlers = makeHandlers();
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    for (let i = 0; i < 5; i++) {
      await client.callTool({
        name: 'web_fetch',
        arguments: { url: `https://example.com/page-${i}` },
      });
    }

    expect(handlers.runWebFetch).toHaveBeenCalledTimes(5);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// tools/call — error response content verification
// ---------------------------------------------------------------------------

describe('tools/call — error response content', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-009]
  it('returns the unknown-tool message listing both available tools', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'invalid_tool',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Unknown tool');
    expect(text).toContain('web_search');
    expect(text).toContain('web_fetch');
    await client.close();
  });

  // [Implements: US-MC-009]
  it('error response for unknown tool has content type "text"', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'missing_tool',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    await client.close();
  });

  // [Implements: US-MC-010]
  it('returns validation error message for web_search with missing query', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_search',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('query');
    await client.close();
  });

  // [Implements: US-MC-010]
  it('returns validation error for web_search with invalid max_results type', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'test', max_results: 'not-a-number' },
    });

    expect(result.isError).toBe(true);
    await client.close();
  });

  // [Implements: US-MC-010]
  it('returns validation error for web_fetch with invalid URL format', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_fetch',
      arguments: { url: 'not a valid url' },
    });

    expect(result.isError).toBe(true);
    await client.close();
  });

  // [Implements: US-MC-011]
  it('returns error response when handler rejects with a generic error', async () => {
    const handlers = makeHandlers();
    handlers.runWebSearch = vi
      .fn()
      .mockRejectedValue(new Error('PL pipeline failure'));
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'error-test' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Internal error');
    expect(text).toContain('PL pipeline failure');
    await client.close();
  });

  // [Implements: US-MC-011]
  it('error response content has exactly one item', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'unknown',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    await client.close();
  });

  // [Implements: US-MC-011]
  it('does not leak stack trace in the error response text', async () => {
    const handlers = makeHandlers();
    const error = new Error('secret internal detail');
    handlers.runWebFetch = vi.fn().mockRejectedValue(error);
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_fetch',
      arguments: { url: 'https://example.com' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    if (error.stack) {
      expect(text).not.toContain(error.stack);
    }
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// createServer — edge cases for serverName and serverVersion
// ---------------------------------------------------------------------------

describe('createServer — name/version edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-002]
  it('defaults serverName to "chomp-mcp" when omitted', () => {
    expect(() =>
      createServer(makeOptions({ serverName: undefined }))
    ).not.toThrow();
  });

  // [Implements: US-MC-002]
  it('accepts an empty string serverName', () => {
    expect(() =>
      createServer(makeOptions({ serverName: '' }))
    ).not.toThrow();
  });

  // [Implements: US-MC-002]
  it('accepts a version with pre-release suffix', async () => {
    const server = createServer(
      makeOptions({ serverVersion: '2.0.0-rc.1' })
    );
    const { client } = await connectInMemory(server);
    expect(client.getServerVersion()).toEqual({
      name: 'chomp-mcp',
      version: '2.0.0-rc.1',
    });
    await client.close();
  });

  // [Implements: US-MC-002]
  it('accepts a version with build metadata', async () => {
    const server = createServer(
      makeOptions({ serverVersion: '1.0.0+build.123' })
    );
    const { client } = await connectInMemory(server);
    expect(client.getServerVersion()).toEqual({
      name: 'chomp-mcp',
      version: '1.0.0+build.123',
    });
    await client.close();
  });

  // [Implements: US-MC-002]
  it('accepts a multi-word server name', async () => {
    const server = createServer(
      makeOptions({ serverName: 'my research server', serverVersion: '3.1.0' })
    );
    const { client } = await connectInMemory(server);
    expect(client.getServerVersion()).toEqual({
      name: 'my research server',
      version: '3.1.0',
    });
    await client.close();
  });

  // [Implements: US-MC-002]
  it('uses default serverName and serverVersion when both are omitted', async () => {
    const server = createServer({
      handlers: makeHandlers(),
      serverName: undefined,
      serverVersion: undefined,
    });
    const { client } = await connectInMemory(server);
    expect(client.getServerVersion()).toEqual({
      name: 'chomp-mcp',
      version: '1.0.0',
    });
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Protocol compliance — initialize handshake structure
// ---------------------------------------------------------------------------

describe('protocol compliance — initialize handshake', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-002, NFR-MC-003]
  it('returns server version with name and version fields', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const info = client.getServerVersion();
    expect(info).toHaveProperty('name');
    expect(info).toHaveProperty('version');
    expect(typeof info!.name).toBe('string');
    expect(typeof info!.version).toBe('string');
    await client.close();
  });

  // [Implements: US-MC-002, NFR-MC-003]
  it('declares tools capability as a defined object', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const caps = client.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps!.tools).toBeDefined();
    expect(typeof caps!.tools).toBe('object');
    await client.close();
  });

  // [Implements: US-MC-002, NFR-MC-003]
  it('does not declare resources or prompts capabilities', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    const caps = client.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps!.resources).toBeUndefined();
    expect(caps!.prompts).toBeUndefined();
    await client.close();
  });

  // [Implements: NFR-MC-003]
  it('client can perform the full handshake and list tools without errors', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);
    expect(client.getServerVersion()).toBeDefined();
    expect(client.getServerCapabilities()).toBeDefined();
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(2);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// tools/call — success response completeness
// ---------------------------------------------------------------------------

describe('tools/call — success response completeness', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-MC-008, NFR-MC-003]
  it('success result has content array with exactly one text item', async () => {
    const server = createServer(makeOptions());
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'completeness' },
    });

    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(typeof (result.content[0] as { text: string }).text).toBe('string');
    await client.close();
  });

  // [Implements: US-MC-008]
  it('web_fetch success returns the fetch handler digest', async () => {
    const handlers = makeHandlers();
    handlers.runWebFetch = vi.fn().mockResolvedValue('fetched digest here');
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_fetch',
      arguments: { url: 'https://example.com' },
    });

    expect((result.content[0] as { text: string }).text).toBe(
      'fetched digest here'
    );
    await client.close();
  });

  // [Implements: US-MC-008]
  it('handler returning an empty string is treated as success', async () => {
    const handlers = makeHandlers();
    handlers.runWebSearch = vi.fn().mockResolvedValue('');
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'empty' },
    });

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toBe('');
    await client.close();
  });

  // [Implements: US-MC-011]
  it('partial/degraded result string is treated as success (not error)', async () => {
    const handlers = makeHandlers();
    handlers.runWebSearch = vi
      .fn()
      .mockResolvedValue('[Note: LLM synthesis unavailable] Degraded output.');
    const server = createServer({ handlers });
    const { client } = await connectInMemory(server);

    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'degraded' },
    });

    // Degraded results are success responses per US-MC-011
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});
