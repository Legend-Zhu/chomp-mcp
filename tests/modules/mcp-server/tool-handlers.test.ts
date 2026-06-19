/**
 * Unit tests for MCP server tool dispatch and response formatting (tool-handlers.ts).
 *
 * Tests createToolDispatcher covering:
 * - web_search and web_fetch dispatch routing
 * - Validation failure paths (missing query, invalid URL)
 * - Success response formatting (content array, isError: false)
 * - Error response formatting (isError: true)
 * - Truncation at 25,000 characters
 * - Timeout error handling
 * - Generic error handling (no stack trace leakage)
 * - Unknown tool rejection
 * - Catch-all safety guarantee
 *
 * Uses mock OrchestrationHandlers to avoid real PL dependencies.
 *
 * [Spec: US-MC-006, US-MC-007, US-MC-008, US-MC-009, US-MC-010, US-MC-011,
 *        DC-MC-007, NFR-MC-002, NFR-MC-004]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createToolDispatcher } from '../../../src/modules/mcp-server/tool-handlers.js';
import type { OrchestrationHandlers } from '../../../src/modules/mcp-server/tool-handlers.js';
import { AppError } from '../../../src/shared/utils/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock OrchestrationHandlers object with vi.fn() for each handler.
 */
function makeHandlers(
  overrides?: Partial<OrchestrationHandlers>
): OrchestrationHandlers {
  return {
    runWebSearch: vi.fn().mockResolvedValue('Sample digest from web_search pipeline.'),
    runWebFetch: vi.fn().mockResolvedValue('Sample digest from web_fetch pipeline.'),
    ...overrides,
  };
}

/**
 * Concatenate all stderr spy calls into a single string.
 */
function captureStderr(
  spy: ReturnType<typeof vi.spyOn>
): string {
  return spy.mock.calls.map((c) => String(c[0])).join('');
}

/**
 * Extract the text from the first content item of a CallToolResult.
 * This narrows the union type from the MCP SDK's content array.
 */
function getText(result: { content: Array<Record<string, unknown>> }): string {
  return result.content[0]['text'] as string;
}

// ---------------------------------------------------------------------------
// createToolDispatcher — basic structure
// ---------------------------------------------------------------------------

describe('createToolDispatcher', () => {
  // [Implements: DC-MC-007]
  it('returns a function when called with handlers', () => {
    const dispatch = createToolDispatcher(makeHandlers());
    expect(typeof dispatch).toBe('function');
  });

  // [Implements: DC-MC-007]
  it('the returned dispatcher accepts two arguments (name, args)', () => {
    const dispatch = createToolDispatcher(makeHandlers());
    expect(dispatch.length).toBe(2);
  });

  // [Implements: DC-MC-007]
  it('returns a Promise<CallToolResult> when invoked', async () => {
    const dispatch = createToolDispatcher(makeHandlers());
    const result = dispatch('web_search', { query: 'test' });
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
});

// ---------------------------------------------------------------------------
// web_search dispatch routing
// ---------------------------------------------------------------------------

describe('web_search dispatch', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-006]
  it('dispatches to runWebSearch when name is "web_search"', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'climate change' });

    expect(handlers.runWebSearch).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-MC-006]
  it('passes validated params (camelCase) to runWebSearch', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', {
      query: 'quantum computing',
      max_results: 10,
      focus: 'hardware',
    });

    expect(handlers.runWebSearch).toHaveBeenCalledWith({
      query: 'quantum computing',
      maxResults: 10,
      focus: 'hardware',
    });
  });

  // [Implements: US-MC-006]
  it('does NOT dispatch to runWebFetch for a web_search call', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test' });

    expect(handlers.runWebFetch).not.toHaveBeenCalled();
  });

  // [Implements: US-MC-006]
  it('logs dispatch message to stderr with query', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'climate change' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server] dispatching web_search');
    expect(output).toContain('climate change');
  });

  // [Implements: US-MC-006, NFR-MC-002]
  it('does NOT write to stdout during web_search dispatch', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const handlers = makeHandlers();
      const dispatch = createToolDispatcher(handlers);

      await dispatch('web_search', { query: 'test' });

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // [Implements: US-MC-006, US-MC-008]
  it('returns a success CallToolResult with the digest in content', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue('Synthesized digest answer.'),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Synthesized digest answer.');
  });

  // [Implements: US-MC-008]
  it('sets isError to false on success result', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(false);
  });

  // [Implements: US-MC-008]
  it('wraps the digest in a content array with a single text item', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue('Some digest text.'),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Some digest text.',
    });
  });
});

// ---------------------------------------------------------------------------
// web_search validation failures
// ---------------------------------------------------------------------------

describe('web_search validation failures', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-010]
  it('returns error result when query is missing', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { max_results: 5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Missing required field: query');
  });

  // [Implements: US-MC-010]
  it('returns error result when query is empty string', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: '' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Missing required field: query');
  });

  // [Implements: US-MC-010]
  it('returns error result when args object is empty', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', {});

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('returns error result when max_results is negative', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test', max_results: -1 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('max_results must be a positive integer');
  });

  // [Implements: US-MC-010]
  it('returns error result when max_results is a float', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test', max_results: 3.5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('max_results must be a positive integer');
  });

  // [Implements: US-MC-010]
  it('returns error result when additional unknown properties are provided', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test', extra: 'value' });

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('does NOT dispatch to runWebSearch on validation failure', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', {});

    expect(handlers.runWebSearch).not.toHaveBeenCalled();
  });

  // [Implements: US-MC-010]
  it('does NOT log dispatch message on validation failure', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', {});

    const output = captureStderr(stderrSpy);
    expect(output).not.toContain('dispatching web_search');
  });
});

// ---------------------------------------------------------------------------
// web_fetch dispatch routing
// ---------------------------------------------------------------------------

describe('web_fetch dispatch', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-007]
  it('dispatches to runWebFetch when name is "web_fetch"', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'https://example.com' });

    expect(handlers.runWebFetch).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-MC-007]
  it('passes validated params to runWebFetch', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', {
      url: 'https://example.com/article',
      focus: 'methodology',
    });

    expect(handlers.runWebFetch).toHaveBeenCalledWith({
      url: 'https://example.com/article',
      focus: 'methodology',
    });
  });

  // [Implements: US-MC-007]
  it('does NOT dispatch to runWebSearch for a web_fetch call', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'https://example.com' });

    expect(handlers.runWebSearch).not.toHaveBeenCalled();
  });

  // [Implements: US-MC-007]
  it('logs dispatch message to stderr with URL', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'https://example.com/page' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server] dispatching web_fetch');
    expect(output).toContain('https://example.com/page');
  });

  // [Implements: US-MC-007, US-MC-008]
  it('returns a success CallToolResult with the digest in content', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockResolvedValue('Fetched content digest.'),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Fetched content digest.');
  });

  // [Implements: US-MC-008]
  it('sets isError to false on success result', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// web_fetch validation failures
// ---------------------------------------------------------------------------

describe('web_fetch validation failures', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-010]
  it('returns error result when url is missing', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { focus: 'topic' });

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('returns error result with "Invalid URL format" for malformed URL', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'not-a-url' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Invalid URL format: not-a-url');
  });

  // [Implements: US-MC-010]
  it('returns error result when args object is empty', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', {});

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('does NOT dispatch to runWebFetch on validation failure', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'bad' });

    expect(handlers.runWebFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// unknown tool rejection
// ---------------------------------------------------------------------------

describe('unknown tool rejection', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-009]
  it('returns error result with isError true for unknown tool name', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('unknown_tool', { foo: 'bar' });

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-009]
  it('returns message "Unknown tool: {name}. Available tools: web_search, web_fetch."', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('nonexistent', {});

    expect(result.content[0].text).toBe(
      'Unknown tool: nonexistent. Available tools: web_search, web_fetch.'
    );
  });

  // [Implements: US-MC-009]
  it('includes the unknown tool name in the error message', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('my_custom_tool', {});

    expect(result.content[0].text).toContain('my_custom_tool');
  });

  // [Implements: US-MC-009]
  it('does NOT dispatch to runWebSearch for unknown tool', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('mystery', {});

    expect(handlers.runWebSearch).not.toHaveBeenCalled();
  });

  // [Implements: US-MC-009]
  it('does NOT dispatch to runWebFetch for unknown tool', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('mystery', {});

    expect(handlers.runWebFetch).not.toHaveBeenCalled();
  });

  // [Implements: US-MC-009]
  it('logs unknown tool message to stderr', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    await dispatch('bad_tool', {});

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server] unknown tool requested: bad_tool');
  });

  // [Implements: US-MC-009]
  it('rejects an empty string tool name', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool:');
  });

  // [Implements: US-MC-009]
  it('rejects tool names with uppercase variants (case-sensitive)', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('WEB_SEARCH', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('WEB_SEARCH');
  });

  // [Implements: US-MC-009]
  it('returns a CallToolResult with content array for unknown tool', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('xyz', {});

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });

  // [Implements: US-MC-009]
  it('the unknown-tool error message lists both available tools', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('xyz', {});

    const text = result.content[0].text;
    expect(text).toContain('web_search');
    expect(text).toContain('web_fetch');
  });
});

// ---------------------------------------------------------------------------
// success response formatting — truncation
// ---------------------------------------------------------------------------

describe('success response formatting — truncation at 25,000 chars', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-008]
  it('does not truncate a digest under 25,000 chars', async () => {
    const shortDigest = 'A'.repeat(10000);
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(shortDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe(shortDigest);
    expect(result.content[0].text).not.toContain('[Response truncated');
  });

  // [Implements: US-MC-008]
  it('truncates a digest exceeding 25,000 chars', async () => {
    const longDigest = 'A'.repeat(30000);
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(longDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(false);
    expect(result.content[0].text.length).toBeLessThan(30000);
    expect(result.content[0].text.length).toBeLessThanOrEqual(25000 + 50);
  });

  // [Implements: US-MC-008]
  it('appends the truncation suffix after truncation', async () => {
    const longDigest = 'B'.repeat(30000);
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(longDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toContain('[Response truncated due to length]');
  });

  // [Implements: US-MC-008]
  it('the text content is exactly 25,000 chars plus the truncation suffix', async () => {
    const longDigest = 'C'.repeat(50000);
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(longDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    const suffix = '\n\n[Response truncated due to length]';
    expect(result.content[0].text).toBe('C'.repeat(25000) + suffix);
  });

  // [Implements: US-MC-008]
  it('does not truncate a digest that is exactly 25,000 chars', async () => {
    const exactDigest = 'D'.repeat(25000);
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(exactDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toBe(exactDigest);
    expect(result.content[0].text).not.toContain('[Response truncated');
  });

  // [Implements: US-MC-008]
  it('truncates a digest that is 25,001 chars', async () => {
    const slightlyLongDigest = 'E'.repeat(25001);
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(slightlyLongDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toContain('[Response truncated due to length]');
    expect(result.content[0].text.length).toBeLessThanOrEqual(25000 + 50);
  });

  // [Implements: US-MC-008]
  it('truncation preserves isError: false (treats it as success)', async () => {
    const longDigest = 'F'.repeat(30000);
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(longDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(false);
  });

  // [Implements: US-MC-008]
  it('truncation also applies to web_fetch results', async () => {
    const longDigest = 'G'.repeat(30000);
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockResolvedValue(longDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('[Response truncated due to length]');
  });
});

// ---------------------------------------------------------------------------
// error response formatting — timeout
// ---------------------------------------------------------------------------

describe('error response formatting — timeout errors', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-011]
  it('returns timeout message when runWebSearch throws AppError with category "timeout"', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new AppError('Pipeline timed out after 30000ms', 'timeout')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Research timed out');
  });

  // [Implements: US-MC-011]
  it('timeout message suggests reducing max_results or trying later', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new AppError('Operation timed out', 'timeout')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text.toLowerCase()).toContain('reducing');
    expect(result.content[0].text.toLowerCase()).toContain('max_results');
  });

  // [Implements: US-MC-011]
  it('detects timeout from error name containing "Timeout"', async () => {
    const timeoutError = new Error('operation exceeded limit');
    timeoutError.name = 'PipelineTimeoutError';
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(timeoutError),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Research timed out');
  });

  // [Implements: US-MC-011]
  it('detects timeout from error message containing "timed out"', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new Error('The request timed out after 30 seconds')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toContain('Research timed out');
  });

  // [Implements: US-MC-011]
  it('detects timeout from error message containing "aborted"', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(
        new Error('Request was aborted by timeout guard')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.content[0].text).toContain('Research timed out');
  });

  // [Implements: US-MC-011]
  it('timeout error for web_fetch returns the same timeout message', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(
        new AppError('Pipeline timed out', 'timeout')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Research timed out');
  });
});

// ---------------------------------------------------------------------------
// error response formatting — generic errors
// ---------------------------------------------------------------------------

describe('error response formatting — generic errors', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-011, NFR-MC-004]
  it('returns internal error message for a generic Error', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(new Error('Something went wrong')),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
    expect(result.content[0].text).toContain('Something went wrong');
  });

  // [Implements: US-MC-011, NFR-MC-004]
  it('includes "See server logs for details" in the generic error message', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(new Error('database failure')),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toContain('See server logs for details');
  });

  // [Implements: NFR-MC-004]
  it('does NOT leak the stack trace in the error response', async () => {
    const error = new Error('Secret internal failure');
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(error),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).not.toContain(error.stack ?? '');
  });

  // [Implements: NFR-MC-004]
  it('does NOT contain "at " (stack trace lines) in the error response', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(new Error('internal crash')),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    // Stack traces start lines with "    at " — none should appear
    const text = result.content[0].text;
    expect(text).not.toMatch(/\n\s+at\s/);
  });

  // [Implements: US-MC-011, NFR-MC-004]
  it('logs the full stack trace to stderr only', async () => {
    const error = new Error('detailed failure');
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(error),
    });
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server] PL error (web_search)');
    expect(output).toContain('detailed failure');
    // Stack trace is logged to stderr
    if (error.stack) {
      expect(output).toContain('at ');
    }
  });

  // [Implements: US-MC-011]
  it('handles AppError with category "http_error" as generic error', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new AppError('HTTP 500: Server error', 'http_error')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
    expect(result.content[0].text).not.toContain('Research timed out');
  });

  // [Implements: US-MC-011]
  it('handles AppError with category "network" as generic error', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(
        new AppError('Connection refused', 'network')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
    expect(result.content[0].text).toContain('Connection refused');
  });

  // [Implements: US-MC-011]
  it('handles non-Error rejection values (string)', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue('plain string error'),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
    expect(result.content[0].text).toContain('plain string error');
  });

  // [Implements: US-MC-011]
  it('handles non-Error rejection values (number)', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(42),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
  });

  // [Implements: US-MC-011]
  it('handles non-Error rejection values (null)', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(null),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-011]
  it('handles non-Error rejection values (undefined)', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(undefined),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// catch-all safety guarantee
// ---------------------------------------------------------------------------

describe('catch-all safety guarantee', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: NFR-MC-005]
  it('catches synchronous throws from runWebSearch and returns error result', async () => {
    const handlers = makeHandlers({
      runWebSearch: (() => {
        throw new Error('sync throw in handler');
      }) as unknown as OrchestrationHandlers['runWebSearch'],
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
    expect(result.content[0].text).toContain('sync throw in handler');
  });

  // [Implements: NFR-MC-005]
  it('catches synchronous throws from runWebFetch and returns error result', async () => {
    const handlers = makeHandlers({
      runWebFetch: (() => {
        throw new Error('sync throw in fetch handler');
      }) as unknown as OrchestrationHandlers['runWebFetch'],
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('sync throw in fetch handler');
  });

  // [Implements: NFR-MC-005]
  it('catches synchronous throws of non-Error values', async () => {
    const handlers = makeHandlers({
      runWebSearch: (() => {
        throw 'sync string throw';
      }) as unknown as OrchestrationHandlers['runWebSearch'],
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
  });

  // [Implements: NFR-MC-005]
  it('the dispatcher function never throws — always resolves to CallToolResult', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(new Error('fatal')),
    });
    const dispatch = createToolDispatcher(handlers);

    // Should resolve, not reject
    const result = await dispatch('web_search', { query: 'test' });

    expect(result).toBeDefined();
    expect(result.isError).toBe(true);
  });

  // [Implements: NFR-MC-005]
  it('the dispatcher does not reject for any tool name', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    // Unknown tool should not reject
    const result = await dispatch('totally_invalid', {});

    expect(result).toBeDefined();
    expect(result.isError).toBe(true);
  });

  // [Implements: NFR-MC-005]
  it('logs synchronous throw errors to stderr', async () => {
    const handlers = makeHandlers({
      runWebSearch: (() => {
        throw new Error('sync crash');
      }) as unknown as OrchestrationHandlers['runWebSearch'],
    });
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server] PL error (web_search)');
    expect(output).toContain('sync crash');
  });
});

// ---------------------------------------------------------------------------
// CallToolResult shape verification
// ---------------------------------------------------------------------------

describe('CallToolResult shape verification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-008]
  it('success result has content array and isError: false', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search', { query: 'test' });

    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('isError', false);
    expect(Array.isArray(result.content)).toBe(true);
  });

  // [Implements: US-MC-008, US-MC-009]
  it('error result has content array and isError: true', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('unknown', {});

    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('isError', true);
    expect(Array.isArray(result.content)).toBe(true);
  });

  // [Implements: US-MC-008]
  it('each content item has type: "text" and text: string', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search', { query: 'test' });

    const item = result.content[0];
    expect(item).toHaveProperty('type', 'text');
    expect(item).toHaveProperty('text');
    expect(typeof item.text).toBe('string');
  });

  // [Implements: US-MC-008]
  it('error result content item has type: "text"', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('unknown', {});

    expect(result.content[0].type).toBe('text');
  });

  // [Implements: US-MC-008]
  it('success result content has exactly one item', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.content).toHaveLength(1);
  });

  // [Implements: US-MC-009]
  it('error result content has exactly one item', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('unknown', {});

    expect(result.content).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// routing isolation
// ---------------------------------------------------------------------------

describe('routing isolation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-006, US-MC-007]
  it('web_search and web_fetch use their respective handlers', async () => {
    const searchDigest = 'search result';
    const fetchDigest = 'fetch result';
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(searchDigest),
      runWebFetch: vi.fn().mockResolvedValue(fetchDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const searchResult = await dispatch('web_search', { query: 'q' });
    const fetchResult = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(searchResult.content[0].text).toBe(searchDigest);
    expect(fetchResult.content[0].text).toBe(fetchDigest);
  });

  // [Implements: US-MC-006]
  it('successive web_search calls dispatch to the same handler each time', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'first' });
    await dispatch('web_search', { query: 'second' });

    expect(handlers.runWebSearch).toHaveBeenCalledTimes(2);
  });

  // [Implements: US-MC-007]
  it('successive web_fetch calls dispatch to the same handler each time', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'https://a.com' });
    await dispatch('web_fetch', { url: 'https://b.com' });

    expect(handlers.runWebFetch).toHaveBeenCalledTimes(2);
  });

  // [Implements: US-MC-006]
  it('passes the correct query for each web_search dispatch', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'alpha' });
    await dispatch('web_search', { query: 'beta' });

    expect(handlers.runWebSearch).toHaveBeenNthCalledWith(1, expect.objectContaining({ query: 'alpha' }));
    expect(handlers.runWebSearch).toHaveBeenNthCalledWith(2, expect.objectContaining({ query: 'beta' }));
  });
});

// ---------------------------------------------------------------------------
// stderr logging verification
// ---------------------------------------------------------------------------

describe('stderr logging verification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-006, NFR-MC-002]
  it('web_search dispatch log format: "[mcp-server] dispatching web_search: {query}"', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    await dispatch('web_search', { query: 'my search query' });

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const dispatchCall = calls.find((c) => c.includes('dispatching web_search'));
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall).toContain('my search query');
  });

  // [Implements: US-MC-007, NFR-MC-002]
  it('web_fetch dispatch log format: "[mcp-server] dispatching web_fetch: {url}"', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    await dispatch('web_fetch', { url: 'https://example.org/page' });

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const dispatchCall = calls.find((c) => c.includes('dispatching web_fetch'));
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall).toContain('https://example.org/page');
  });

  // [Implements: US-MC-009]
  it('unknown tool log format: "[mcp-server] unknown tool requested: {name}"', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    await dispatch('fictitious_tool', {});

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const unknownCall = calls.find((c) => c.includes('unknown tool requested'));
    expect(unknownCall).toBeDefined();
    expect(unknownCall).toContain('fictitious_tool');
  });

  // [Implements: US-MC-011, NFR-MC-004]
  it('PL error for web_search is logged with the web_search tag', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(new Error('PL failure')),
    });
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server] PL error (web_search)');
    expect(output).toContain('PL failure');
  });

  // [Implements: US-MC-011, NFR-MC-004]
  it('PL error for web_fetch is logged with the web_fetch tag', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(new Error('fetch PL failure')),
    });
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'https://example.com' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server] PL error (web_fetch)');
    expect(output).toContain('fetch PL failure');
  });

  // [Implements: NFR-MC-004]
  it('PL error log includes the stack trace when available', async () => {
    const error = new Error('with stack');
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(error),
    });
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test' });

    const output = captureStderr(stderrSpy);
    if (error.stack) {
      // Stack trace is logged to stderr but NOT included in the response
      expect(output).toContain('at ');
    }
  });

  // [Implements: NFR-MC-004]
  it('PL error log handles non-Error rejections (no stack)', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(12345),
    });
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server] PL error (web_search)');
    expect(output).toContain('12345');
  });
});

// ---------------------------------------------------------------------------
// default values and optional fields
// ---------------------------------------------------------------------------

describe('default values and optional fields', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-006]
  it('defaults maxResults to 5 when max_results is omitted', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test' });

    expect(handlers.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 5 })
    );
  });

  // [Implements: US-MC-007]
  it('passes focus as undefined when not provided for web_search', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test' });

    expect(handlers.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ focus: undefined })
    );
  });

  // [Implements: US-MC-007]
  it('passes focus as undefined when not provided for web_fetch', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'https://example.com' });

    expect(handlers.runWebFetch).toHaveBeenCalledWith(
      expect.objectContaining({ focus: undefined })
    );
  });

  // [Implements: US-MC-006]
  it('passes focus when provided for web_search', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test', focus: 'deep learning' });

    expect(handlers.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ focus: 'deep learning' })
    );
  });

  // [Implements: US-MC-007]
  it('passes focus when provided for web_fetch', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'https://example.com', focus: 'summary' });

    expect(handlers.runWebFetch).toHaveBeenCalledWith(
      expect.objectContaining({ focus: 'summary' })
    );
  });
});

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-008]
  it('handles an empty digest string (zero chars) without truncation', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(''),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('');
  });

  // [Implements: US-MC-008]
  it('handles a single-character digest', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue('X'),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toBe('X');
  });

  // [Implements: US-MC-009]
  it('unknown tool with null args does not crash', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('unknown', null);

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('web_search with null args returns validation error', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search', null);

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('web_fetch with null args returns validation error', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_fetch', null);

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-008]
  it('a very large digest (100k chars) is truncated to 25k + suffix', async () => {
    const hugeDigest = 'Z'.repeat(100000);
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockResolvedValue(hugeDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    const suffix = '\n\n[Response truncated due to length]';
    expect(result.content[0].text).toBe('Z'.repeat(25000) + suffix);
    expect(result.content[0].text.length).toBe(25000 + suffix.length);
  });

  // [Implements: US-MC-011]
  it('handles a TypeError thrown by runWebSearch', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new TypeError('Cannot read properties of undefined')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
  });

  // [Implements: US-MC-011]
  it('handles a RangeError thrown by runWebFetch', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(
        new RangeError('Maximum call stack exceeded')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
  });

  // [Implements: US-MC-008]
  it('truncated digest contains only the first 25,000 chars of the original', async () => {
    const original = '0123456789'.repeat(5000); // 50,000 chars
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(original),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    const text = result.content[0].text;
    // The truncated text should start with the first 25,000 chars of original
    expect(text.startsWith(original.slice(0, 25000))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// timeout detection — additional patterns
// ---------------------------------------------------------------------------

describe('timeout detection — additional patterns', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-011]
  it('detects timeout from error name containing "timedout" (no space)', async () => {
    const err = new Error('operation exceeded limit');
    err.name = 'RequestTimedoutError';
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(err),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toContain('Research timed out');
  });

  // [Implements: US-MC-011]
  it('detects timeout from error name containing "timed_out" (underscore)', async () => {
    const err = new Error('operation exceeded limit');
    err.name = 'Timed_Out_Error';
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(err),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toContain('Research timed out');
  });

  // [Implements: US-MC-011]
  it('detects timeout from error message containing "timeout" (single word)', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new Error('A timeout occurred during processing')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toContain('Research timed out');
  });

  // [Implements: US-MC-011]
  it('detects timeout from error message containing "timedout" (no space)', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(
        new Error('The connection timedout unexpectedly')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.content[0].text).toContain('Research timed out');
  });

  // [Implements: US-MC-011]
  it('detects timeout from error message containing "aborted"', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new Error('The fetch was aborted')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toContain('Research timed out');
  });

  // [Implements: US-MC-011]
  it('does NOT classify an error with "time" (not "timeout") as a timeout', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new Error('Waiting for the right time to process')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).not.toContain('Research timed out');
    expect(result.content[0].text).toContain('Internal error');
  });

  // [Implements: US-MC-011]
  it('does NOT classify an error with "abort" (not "aborted") as a timeout', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(
        new Error('The abortion of the task was requested')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.content[0].text).not.toContain('Research timed out');
  });

  // [Implements: US-MC-011] Documents actual behavior: AppError.category is NOT
  // inspected — only error.name and error.message patterns are checked.
  it('AppError with category "timeout" but no keyword in name/message → generic error', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new AppError('Something unexpected happened', 'timeout')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).not.toContain('Research timed out');
    expect(result.content[0].text).toContain('Internal error');
    expect(result.content[0].text).toContain('Something unexpected happened');
  });

  // [Implements: US-MC-011]
  it('timeout error for web_fetch uses the same timeout message format', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(
        new Error('Fetch timed out after 15000ms')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('Research timed out');
    expect(text.toLowerCase()).toContain('reducing');
    expect(text.toLowerCase()).toContain('max_results');
  });

  // [Implements: US-MC-011]
  it('timeout detection does not match an error name of just "Error"', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new Error('Connection refused')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).not.toContain('Research timed out');
  });
});

// ---------------------------------------------------------------------------
// AppError category handling
// ---------------------------------------------------------------------------

describe('AppError category handling', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-011]
  it('handles AppError with category "parse_error" as generic error', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new AppError('Failed to parse response', 'parse_error')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
    expect(result.content[0].text).toContain('Failed to parse response');
  });

  // [Implements: US-MC-011]
  it('handles AppError with category "validation" as generic error', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(
        new AppError('Invalid input data', 'validation')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
    expect(result.content[0].text).toContain('Invalid input data');
  });

  // [Implements: US-MC-011]
  it('handles AppError with category "config" as generic error', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new AppError('Missing configuration key', 'config')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
    expect(result.content[0].text).toContain('Missing configuration key');
  });

  // [Implements: US-MC-011]
  it('handles AppError with default category "unknown" as generic error', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new AppError('Unknown failure mode')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Internal error');
    expect(result.content[0].text).toContain('Unknown failure mode');
  });

  // [Implements: US-MC-011]
  it('handles AppError with category "timeout" and timeout keyword in message → timeout message', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(
        new AppError('The operation timed out', 'timeout')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.content[0].text).toContain('Research timed out');
  });
});

// ---------------------------------------------------------------------------
// concurrent dispatch safety
// ---------------------------------------------------------------------------

describe('concurrent dispatch safety', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-006, US-MC-007, NFR-MC-005]
  it('handles multiple concurrent web_search dispatches without interference', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const results = await Promise.all([
      dispatch('web_search', { query: 'alpha' }),
      dispatch('web_search', { query: 'beta' }),
      dispatch('web_search', { query: 'gamma' }),
    ]);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.isError).toBe(false);
    }
    expect(handlers.runWebSearch).toHaveBeenCalledTimes(3);
  });

  // [Implements: US-MC-006, US-MC-007]
  it('handles interleaved web_search and web_fetch dispatches concurrently', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const results = await Promise.all([
      dispatch('web_search', { query: 'q1' }),
      dispatch('web_fetch', { url: 'https://a.com' }),
      dispatch('web_search', { query: 'q2' }),
      dispatch('web_fetch', { url: 'https://b.com' }),
    ]);

    expect(results).toHaveLength(4);
    expect(handlers.runWebSearch).toHaveBeenCalledTimes(2);
    expect(handlers.runWebFetch).toHaveBeenCalledTimes(2);
    for (const result of results) {
      expect(result.isError).toBe(false);
    }
  });

  // [Implements: NFR-MC-005]
  it('one failing concurrent dispatch does not affect another succeeding', async () => {
    let callCount = 0;
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('first call fails'));
        }
        return Promise.resolve('success digest');
      }),
    });
    const dispatch = createToolDispatcher(handlers);

    const [failResult, successResult] = await Promise.all([
      dispatch('web_search', { query: 'failing' }),
      dispatch('web_search', { query: 'succeeding' }),
    ]);

    expect(failResult.isError).toBe(true);
    expect(successResult.isError).toBe(false);
    expect(successResult.content[0].text).toBe('success digest');
  });

  // [Implements: NFR-MC-005]
  it('a concurrent mix of success, error, and unknown tool all resolve independently', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue('search ok'),
      runWebFetch: vi.fn().mockRejectedValue(new Error('fetch failed')),
    });
    const dispatch = createToolDispatcher(handlers);

    const [searchResult, fetchResult, unknownResult] = await Promise.all([
      dispatch('web_search', { query: 'test' }),
      dispatch('web_fetch', { url: 'https://example.com' }),
      dispatch('unknown_tool', {}),
    ]);

    expect(searchResult.isError).toBe(false);
    expect(fetchResult.isError).toBe(true);
    expect(unknownResult.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dispatch isolation between dispatcher instances
// ---------------------------------------------------------------------------

describe('dispatch isolation between dispatcher instances', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: DC-MC-007]
  it('two dispatchers with different handlers route to their respective handlers', async () => {
    const handlersA = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue('dispatcher A result'),
    });
    const handlersB = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue('dispatcher B result'),
    });
    const dispatchA = createToolDispatcher(handlersA);
    const dispatchB = createToolDispatcher(handlersB);

    const resultA = await dispatchA('web_search', { query: 'test' });
    const resultB = await dispatchB('web_search', { query: 'test' });

    expect(resultA.content[0].text).toBe('dispatcher A result');
    expect(resultB.content[0].text).toBe('dispatcher B result');
    expect(handlersA.runWebSearch).toHaveBeenCalledTimes(1);
    expect(handlersB.runWebSearch).toHaveBeenCalledTimes(1);
  });

  // [Implements: DC-MC-007]
  it('a dispatcher does not invoke handlers from another dispatcher', async () => {
    const handlersA = makeHandlers();
    const handlersB = makeHandlers();
    const dispatchA = createToolDispatcher(handlersA);
    const dispatchB = createToolDispatcher(handlersB);

    await dispatchA('web_search', { query: 'test' });

    expect(handlersA.runWebSearch).toHaveBeenCalledTimes(1);
    expect(handlersB.runWebSearch).not.toHaveBeenCalled();
  });

  // [Implements: DC-MC-007]
  it('a dispatcher with failing handlers does not affect another dispatcher', async () => {
    const handlersA = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(new Error('A fails')),
    });
    const handlersB = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue('B succeeds'),
    });
    const dispatchA = createToolDispatcher(handlersA);
    const dispatchB = createToolDispatcher(handlersB);

    const resultA = await dispatchA('web_search', { query: 'test' });
    const resultB = await dispatchB('web_search', { query: 'test' });

    expect(resultA.isError).toBe(true);
    expect(resultB.isError).toBe(false);
    expect(resultB.content[0].text).toBe('B succeeds');
  });
});

// ---------------------------------------------------------------------------
// special characters in digest
// ---------------------------------------------------------------------------

describe('special characters in digest', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-008]
  it('preserves newlines in digest content', async () => {
    const digest = 'Line 1\nLine 2\nLine 3';
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(digest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toBe(digest);
  });

  // [Implements: US-MC-008]
  it('preserves tabs and carriage returns in digest content', async () => {
    const digest = 'Col1\tCol2\r\nValue1\tValue2';
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockResolvedValue(digest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.content[0].text).toBe(digest);
  });

  // [Implements: US-MC-008]
  it('preserves Unicode characters (CJK, emoji, accented)', async () => {
    const digest = '日本語のテスト 🚀 café résumé naïve';
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(digest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toBe(digest);
  });

  // [Implements: US-MC-008]
  it('preserves markdown formatting in digest content', async () => {
    const digest = [
      '## Answer',
      '',
      'This is **bold** and *italic*.',
      '',
      '- Item 1',
      '- Item 2',
      '',
      '```code```',
      '[link](https://example.com)',
    ].join('\n');
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(digest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toBe(digest);
  });

  // [Implements: US-MC-008]
  it('preserves HTML entities in digest content', async () => {
    const digest = '&lt;script&gt;alert(1)&lt;/script&gt;';
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockResolvedValue(digest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.content[0].text).toBe(digest);
  });

  // [Implements: US-MC-008]
  it('preserves JSON-like content in digest', async () => {
    const digest = '{"key": "value", "nested": {"a": 1}}';
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(digest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toBe(digest);
  });
});

// ---------------------------------------------------------------------------
// web_search boundary values for max_results
// ---------------------------------------------------------------------------

describe('web_search boundary values for max_results', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-006]
  it('accepts max_results of 1 and passes maxResults: 1 to handler', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test', max_results: 1 });

    expect(handlers.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 1 })
    );
  });

  // [Implements: US-MC-006]
  it('accepts a very large max_results and passes it through', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test', max_results: 1000000 });

    expect(handlers.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 1000000 })
    );
  });

  // [Implements: US-MC-006]
  it('passes max_results: 0 as a validation error (not positive)', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test', max_results: 0 });

    expect(result.isError).toBe(true);
    expect(handlers.runWebSearch).not.toHaveBeenCalled();
  });

  // [Implements: US-MC-006]
  it('passes all three params together: query, max_results, focus', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', {
      query: 'complex query',
      max_results: 15,
      focus: 'machine learning',
    });

    expect(handlers.runWebSearch).toHaveBeenCalledWith({
      query: 'complex query',
      maxResults: 15,
      focus: 'machine learning',
    });
  });
});

// ---------------------------------------------------------------------------
// web_fetch with complex URLs
// ---------------------------------------------------------------------------

describe('web_fetch with complex URLs', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-007]
  it('accepts a URL with port number', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'https://example.com:8080/path' });

    expect(handlers.runWebFetch).toHaveBeenCalledTimes(1);
    expect(handlers.runWebFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com:8080/path' })
    );
  });

  // [Implements: US-MC-007]
  it('accepts a URL with query parameters', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'https://example.com/page?q=test&sort=asc' });

    expect(handlers.runWebFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/page?q=test&sort=asc' })
    );
  });

  // [Implements: US-MC-007]
  it('accepts a URL with fragment', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'https://example.com/page#section' });

    expect(handlers.runWebFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/page#section' })
    );
  });

  // [Implements: US-MC-007]
  it('accepts an HTTP URL', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'http://example.com' });

    expect(handlers.runWebFetch).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-MC-007]
  it('accepts a localhost URL', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'http://localhost:3000/api/data' });

    expect(handlers.runWebFetch).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-MC-007]
  it('rejects a URL that is a plain number', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_fetch', { url: 42 as unknown as string });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// error response content verification
// ---------------------------------------------------------------------------

describe('error response content verification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-011]
  it('timeout error message is exactly the expected text', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(
        new Error('The request timed out')
      ),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toBe(
      'Research timed out. Please try reducing max_results or try again later.'
    );
  });

  // [Implements: US-MC-011]
  it('generic error message follows the "Internal error: {msg}. See server logs for details." format', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toBe(
      'Internal error: DB connection lost. See server logs for details.'
    );
  });

  // [Implements: US-MC-011]
  it('generic error for a string rejection uses the string as the message', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue('custom failure message'),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toBe(
      'Internal error: custom failure message. See server logs for details.'
    );
  });

  // [Implements: US-MC-011]
  it('generic error for a null rejection uses "Unknown error"', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(null),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toContain('Unknown error');
  });

  // [Implements: US-MC-011]
  it('generic error for an undefined rejection uses "Unknown error"', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(undefined),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toContain('Unknown error');
  });

  // [Implements: US-MC-011]
  it('generic error for a number rejection uses "Unknown error" (number is not Error/string)', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(404),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    expect(result.content[0].text).toContain('Unknown error');
  });

  // [Implements: US-MC-011]
  it('generic error for an object rejection uses "Unknown error"', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue({ custom: 'data' }),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toContain('Unknown error');
  });

  // [Implements: US-MC-011]
  it('does not include the error constructor name in the response', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(new TypeError('bad type')),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).not.toContain('TypeError');
  });
});

// ---------------------------------------------------------------------------
// truncation edge cases
// ---------------------------------------------------------------------------

describe('truncation edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-008]
  it('truncation preserves the beginning of the digest (first 100 chars)', async () => {
    const longDigest = 'START_MARKER_' + 'X'.repeat(30000) + '_END_MARKER';
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(longDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text.startsWith('START_MARKER_')).toBe(true);
  });

  // [Implements: US-MC-008]
  it('truncation removes content beyond 25,000 chars from the original', async () => {
    const longDigest = 'A'.repeat(24999) + 'B'.repeat(5000);
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(longDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    // The truncated text should contain only 'A's (24999) + 1 'B' = 25000 chars
    const text = result.content[0].text;
    expect(text.slice(0, 24999)).toBe('A'.repeat(24999));
    expect(text.slice(24999, 25000)).toBe('B');
  });

  // [Implements: US-MC-008]
  it('truncation suffix length is exactly 36 chars', async () => {
    const longDigest = 'X'.repeat(30000);
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockResolvedValue(longDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    const suffix = '\n\n[Response truncated due to length]';
    expect(result.content[0].text).toBe('X'.repeat(25000) + suffix);
    expect(suffix.length).toBe(36);
  });

  // [Implements: US-MC-008]
  it('truncation with CJK characters (multi-byte) truncates at char boundary', async () => {
    const longDigest = '日'.repeat(30000);
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(longDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    const text = result.content[0].text;
    expect(text).toContain('[Response truncated due to length]');
    // The truncation is at character count, not byte count
    const truncatedPart = text.split('\n\n[Response')[0];
    expect(truncatedPart.length).toBe(25000);
  });

  // [Implements: US-MC-008]
  it('a digest of exactly 25,000 chars is returned unchanged (no suffix)', async () => {
    const exactDigest = 'Q'.repeat(25000);
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockResolvedValue(exactDigest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_search', { query: 'test' });

    expect(result.content[0].text).toBe(exactDigest);
    expect(result.content[0].text.length).toBe(25000);
  });

  // [Implements: US-MC-008]
  it('a digest of 25,001 chars is truncated to 25,000 + suffix', async () => {
    const digest = 'R'.repeat(25001);
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockResolvedValue(digest),
    });
    const dispatch = createToolDispatcher(handlers);

    const result = await dispatch('web_fetch', { url: 'https://example.com' });

    const suffix = '\n\n[Response truncated due to length]';
    expect(result.content[0].text).toBe('R'.repeat(25000) + suffix);
    expect(result.content[0].text.length).toBe(25000 + suffix.length);
  });
});

// ---------------------------------------------------------------------------
// stderr logging — additional verification
// ---------------------------------------------------------------------------

describe('stderr logging — additional verification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-006, NFR-MC-002]
  it('web_search log includes the [mcp-server] tag', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    await dispatch('web_search', { query: 'test' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server]');
  });

  // [Implements: US-MC-007, NFR-MC-002]
  it('web_fetch log includes the [mcp-server] tag', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    await dispatch('web_fetch', { url: 'https://example.com' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[mcp-server]');
  });

  // [Implements: US-MC-011]
  it('error log for web_search includes the tool name in parentheses', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(new Error('err')),
    });
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'test' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('PL error (web_search)');
  });

  // [Implements: US-MC-011]
  it('error log for web_fetch includes the tool name in parentheses', async () => {
    const handlers = makeHandlers({
      runWebFetch: vi.fn().mockRejectedValue(new Error('err')),
    });
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_fetch', { url: 'https://example.com' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('PL error (web_fetch)');
  });

  // [Implements: NFR-MC-002]
  it('web_search dispatch does not write to stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const dispatch = createToolDispatcher(makeHandlers());
      await dispatch('web_search', { query: 'test' });
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // [Implements: NFR-MC-002]
  it('web_fetch dispatch does not write to stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const dispatch = createToolDispatcher(makeHandlers());
      await dispatch('web_fetch', { url: 'https://example.com' });
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // [Implements: NFR-MC-002]
  it('error dispatch does not write to stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const handlers = makeHandlers({
        runWebSearch: vi.fn().mockRejectedValue(new Error('fail')),
      });
      const dispatch = createToolDispatcher(handlers);
      await dispatch('web_search', { query: 'test' });
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // [Implements: NFR-MC-002]
  it('unknown tool dispatch does not write to stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const dispatch = createToolDispatcher(makeHandlers());
      await dispatch('bad_tool', {});
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// unknown tool — additional edge cases
// ---------------------------------------------------------------------------

describe('unknown tool — additional edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-009]
  it('rejects "web_search " (with trailing space) as unknown', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search ', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool:');
  });

  // [Implements: US-MC-009]
  it('rejects " web_search" (with leading space) as unknown', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch(' web_search', {});

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-009]
  it('rejects "web_search\\n" (with newline) as unknown', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search\n', {});

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-009]
  it('rejects "web-fetch" (hyphen instead of underscore) as unknown', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web-fetch', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('web-fetch');
  });

  // [Implements: US-MC-009]
  it('rejects "Web_Search" (mixed case) as unknown', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('Web_Search', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Web_Search');
  });

  // [Implements: US-MC-009]
  it('rejects "websearch" (missing underscore) as unknown', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('websearch', {});

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-009]
  it('rejects a very long tool name', async () => {
    const dispatch = createToolDispatcher(makeHandlers());
    const longName = 'a'.repeat(1000);

    const result = await dispatch(longName, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(longName);
  });

  // [Implements: US-MC-009]
  it('rejects a tool name with special characters', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search<script>', {});

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validation — additional param types
// ---------------------------------------------------------------------------

describe('validation — additional param types', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-010]
  it('web_search with undefined args returns validation error', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search', undefined);

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('web_fetch with undefined args returns validation error', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_fetch', undefined);

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('web_search with string args returns validation error', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search', 'not an object');

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('web_fetch with array args returns validation error', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_fetch', ['https://example.com']);

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('web_search with number args returns validation error', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search', 42);

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('web_search with boolean args returns validation error', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search', true);

    expect(result.isError).toBe(true);
  });

  // [Implements: US-MC-010]
  it('web_search with a query number returns validation error', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search', { query: 123 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Missing required field: query');
  });

  // [Implements: US-MC-010]
  it('web_search with max_results as string returns validation error', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search', { query: 'test', max_results: 'five' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('max_results must be a positive integer');
  });

  // [Implements: US-MC-010]
  it('web_search with max_results as boolean returns validation error', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    const result = await dispatch('web_search', { query: 'test', max_results: true });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dispatcher never rejects
// ---------------------------------------------------------------------------

describe('dispatcher never rejects', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: NFR-MC-005]
  it('does not reject when runWebSearch throws synchronously', async () => {
    const handlers = makeHandlers({
      runWebSearch: (() => {
        throw new Error('sync throw');
      }) as unknown as OrchestrationHandlers['runWebSearch'],
    });
    const dispatch = createToolDispatcher(handlers);

    await expect(dispatch('web_search', { query: 'test' })).resolves.toBeDefined();
  });

  // [Implements: NFR-MC-005]
  it('does not reject when runWebFetch throws synchronously', async () => {
    const handlers = makeHandlers({
      runWebFetch: (() => {
        throw new Error('sync throw');
      }) as unknown as OrchestrationHandlers['runWebFetch'],
    });
    const dispatch = createToolDispatcher(handlers);

    await expect(dispatch('web_fetch', { url: 'https://example.com' })).resolves.toBeDefined();
  });

  // [Implements: NFR-MC-005]
  it('does not reject when runWebSearch rejects with a Promise', async () => {
    const handlers = makeHandlers({
      runWebSearch: vi.fn().mockRejectedValue(new Error('async error')),
    });
    const dispatch = createToolDispatcher(handlers);

    await expect(dispatch('web_search', { query: 'test' })).resolves.toBeDefined();
  });

  // [Implements: NFR-MC-005]
  it('does not reject for unknown tool name', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    await expect(dispatch('nonexistent', {})).resolves.toBeDefined();
  });

  // [Implements: NFR-MC-005]
  it('does not reject for validation failure', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    await expect(dispatch('web_search', {})).resolves.toBeDefined();
  });

  // [Implements: NFR-MC-005]
  it('does not reject when handler throws a non-Error value synchronously', async () => {
    const handlers = makeHandlers({
      runWebSearch: (() => {
        throw { code: 500, msg: 'weird' };
      }) as unknown as OrchestrationHandlers['runWebSearch'],
    });
    const dispatch = createToolDispatcher(handlers);

    await expect(dispatch('web_search', { query: 'test' })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// dispatch with special characters in query
// ---------------------------------------------------------------------------

describe('dispatch with special characters in query and URL', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-MC-006]
  it('passes a query with special characters to the handler', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: 'C++ templates & generics <2024>' });

    expect(handlers.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'C++ templates & generics <2024>' })
    );
  });

  // [Implements: US-MC-006]
  it('passes a query with Unicode characters to the handler', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: '日本語検索 🔬' });

    expect(handlers.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: '日本語検索 🔬' })
    );
  });

  // [Implements: US-MC-006]
  it('logs a query with special characters to stderr', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    await dispatch('web_search', { query: 'test "quoted" & [bracketed]' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('test "quoted" & [bracketed]');
  });

  // [Implements: US-MC-007]
  it('logs a URL with special characters to stderr', async () => {
    const dispatch = createToolDispatcher(makeHandlers());

    await dispatch('web_fetch', { url: 'https://example.com/path?q=a&b=c#frag' });

    const output = captureStderr(stderrSpy);
    expect(output).toContain('https://example.com/path?q=a&b=c#frag');
  });

  // [Implements: US-MC-006]
  it('passes a whitespace-only query to the handler (schema allows it)', async () => {
    const handlers = makeHandlers();
    const dispatch = createToolDispatcher(handlers);

    await dispatch('web_search', { query: '   ' });

    expect(handlers.runWebSearch).toHaveBeenCalledTimes(1);
    expect(handlers.runWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: '   ' })
    );
  });
});
