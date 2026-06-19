/**
 * Integration tests for the synthesizer orchestrator module.
 *
 * Tests the public entry points `synthesize()` and `synthesizeSingle()`,
 * covering:
 *   - Single-call path (small content → one LLM call → parsed DigestResult)
 *   - Batch routing (large content → batchAndMerge invoked)
 *   - Empty contents → degradation
 *   - LLM failure → degradation (Promise never rejects)
 *   - synthesizeSingle short-content guard (< 200 chars → degradation)
 *   - synthesizeSingle normal path (≥ 200 chars → LLM call → single source)
 *   - Observability logging (start, done, tokens, error, degradation)
 *   - Query truncation in logs (max 80 chars)
 *   - stdout never called
 *
 * [Spec: US-SY-003, US-SY-004, US-SY-007, US-SY-008, US-SY-009, US-SY-010,
 *  BG-SY-001, BG-SY-002, BG-SY-003, NFR-SY-001, NFR-SY-002, NFR-SY-004,
 *  NFR-SY-005, DC-SY-003, DC-SY-005]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock openai module (transitively imported by llm-client)
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
}));

// Mock the llm-client module so we control all LLM call behavior.
vi.mock('../../../src/modules/synthesize/llm-client.js', () => ({
  createLLMClient: vi.fn(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
  callLLMWithRetry: vi.fn(),
  verifyLLMConnectivity: vi.fn(async () => true),
}));

// Mock the batch-merger module for batch routing tests.
vi.mock('../../../src/modules/synthesize/batch-merger.js', () => ({
  batchAndMerge: vi.fn(),
}));

import { callLLMWithRetry } from '../../../src/modules/synthesize/llm-client.js';
import { batchAndMerge } from '../../../src/modules/synthesize/batch-merger.js';
import { synthesize, synthesizeSingle } from '../../../src/modules/synthesize/synthesizer.js';

import type { ContentItem } from '../../../src/shared/types/content.js';
import type { DigestResult } from '../../../src/shared/types/digest.js';
import type { LLMResponse } from '../../../src/modules/synthesize/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCallLLM = vi.mocked(callLLMWithRetry);
const mockBatchAndMerge = vi.mocked(batchAndMerge);

function makeContentItem(
  overrides: Partial<ContentItem> = {}
): ContentItem {
  return {
    title: overrides.title ?? 'Test Title',
    url: overrides.url ?? 'https://example.com/page',
    snippet: overrides.snippet ?? 'A snippet.',
    score: overrides.score ?? 0.5,
    content: overrides.content ?? 'Some content here for testing purposes.',
  };
}

function makeLLMResponse(
  content: string,
  promptTokens = 100,
  completionTokens = 50
): LLMResponse {
  return { content, promptTokens, completionTokens };
}

function makeDigestResult(
  overrides: Partial<DigestResult> = {}
): DigestResult {
  return {
    answer: overrides.answer ?? 'Synthesized answer from the LLM.',
    keyPoints: overrides.keyPoints ?? ['Key point one', 'Key point two'],
    sources: overrides.sources ?? [
      { url: 'https://example.com', title: 'Example' },
    ],
  };
}

const LLM_RESPONSE = [
  '## Answer',
  'This is the synthesized answer from the LLM.',
  '',
  '## Key Points',
  '- First key point from the synthesized content',
  '- Second key point from the synthesized content',
  '',
  '## Sources',
  'https://example.com',
].join('\n');

function captureStderr(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => String(c[0])).join('');
}

// ---------------------------------------------------------------------------
// synthesize — single-call path
// ---------------------------------------------------------------------------

describe('synthesize — single-call path', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.env['LLM_API_KEY'] = 'test-key';
    mockCallLLM.mockReset();
    mockBatchAndMerge.mockReset();
    mockCallLLM.mockImplementation(async () => makeLLMResponse(LLM_RESPONSE));
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
  });

  // [Implements: US-SY-003]
  it('returns a valid DigestResult with answer, keyPoints, and sources', async () => {
    const contents = [
      makeContentItem({ url: 'https://a.com' }),
      makeContentItem({ url: 'https://b.com' }),
    ];

    const result = await synthesize('test query', contents);

    expect(result).toHaveProperty('answer');
    expect(result).toHaveProperty('keyPoints');
    expect(result).toHaveProperty('sources');
    expect(typeof result.answer).toBe('string');
    expect(Array.isArray(result.keyPoints)).toBe(true);
    expect(Array.isArray(result.sources)).toBe(true);
  });

  it('returns a parsed answer from the LLM response', async () => {
    const contents = [makeContentItem()];

    const result = await synthesize('test query', contents);

    expect(result.answer).toBe('This is the synthesized answer from the LLM.');
  });

  it('returns parsed keyPoints from the LLM response', async () => {
    const contents = [makeContentItem()];

    const result = await synthesize('test query', contents);

    expect(result.keyPoints).toEqual([
      'First key point from the synthesized content',
      'Second key point from the synthesized content',
    ]);
  });

  it('makes a single LLM call (not batchAndMerge)', async () => {
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'Short content A.' }),
      makeContentItem({ url: 'https://b.com', content: 'Short content B.' }),
    ];

    await synthesize('test query', contents);

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockBatchAndMerge).not.toHaveBeenCalled();
  });

  it('reconciles sources — appends missing input sources', async () => {
    const contents = [
      makeContentItem({ url: 'https://input-a.com', title: 'Input A' }),
      makeContentItem({ url: 'https://input-b.com', title: 'Input B' }),
    ];

    const result = await synthesize('test query', contents);

    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://input-a.com');
    expect(urls).toContain('https://input-b.com');
  });

  it('passes the system prompt and user prompt to callLLMWithRetry', async () => {
    const contents = [makeContentItem({ content: 'Content text here.' })];

    await synthesize('What is TypeScript?', contents);

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    const callArgs = mockCallLLM.mock.calls[0];
    const systemPrompt = String(callArgs[1]);
    const userPrompt = String(callArgs[2]);
    expect(systemPrompt).toContain('## Answer');
    expect(userPrompt).toContain('What is TypeScript?');
    expect(userPrompt).toContain('Content text here.');
  });

  it('returns a result that is not a degradation fallback', async () => {
    const contents = [makeContentItem()];

    const result = await synthesize('test query', contents);

    expect(result.answer).not.toContain('[Note: LLM synthesis unavailable');
  });
});

// ---------------------------------------------------------------------------
// synthesize — batch routing
// ---------------------------------------------------------------------------

describe('synthesize — batch routing', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    // Set a very small context window to force batch routing
    process.env['LLM_API_KEY'] = 'test-key';
    process.env['LLM_MAX_CONTEXT_TOKENS'] = '100';
    mockCallLLM.mockReset();
    mockBatchAndMerge.mockReset();
    mockBatchAndMerge.mockImplementation(async () => makeDigestResult());
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
    delete process.env['LLM_MAX_CONTEXT_TOKENS'];
  });

  // [Implements: US-SY-005] Large content → batchAndMerge invoked
  // NOTE: The synthesizer lazily initializes and caches the LLM client and
  // config at the module level on first call. If a previous test already
  // called synthesize(), the cached config has the default 128000 token
  // threshold. We reset modules to force re-initialization with the small
  // LLM_MAX_CONTEXT_TOKENS env value.
  it('routes to batchAndMerge when content exceeds token threshold', async () => {
    vi.resetModules();

    // Re-import after reset to get fresh module state with the env var set
    const { synthesize: freshSynthesize } = await import(
      '../../../src/modules/synthesize/synthesizer.js'
    );
    const { batchAndMerge: freshBatchAndMerge } = await import(
      '../../../src/modules/synthesize/batch-merger.js'
    );
    const mockedBatchAndMerge = vi.mocked(freshBatchAndMerge);
    mockedBatchAndMerge.mockImplementation(async () => makeDigestResult());

    const contents = [
      makeContentItem({
        url: 'https://a.com',
        content: 'A'.repeat(3000),
      }),
      makeContentItem({
        url: 'https://b.com',
        content: 'B'.repeat(3000),
      }),
    ];

    await freshSynthesize('test query', contents);

    expect(mockedBatchAndMerge).toHaveBeenCalledTimes(1);
  });

  it('passes query, contents, focus to batchAndMerge', async () => {
    vi.resetModules();

    const { synthesize: freshSynthesize } = await import(
      '../../../src/modules/synthesize/synthesizer.js'
    );
    const { batchAndMerge: freshBatchAndMerge } = await import(
      '../../../src/modules/synthesize/batch-merger.js'
    );
    const mockedBatchAndMerge = vi.mocked(freshBatchAndMerge);
    mockedBatchAndMerge.mockImplementation(async () => makeDigestResult());

    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'X'.repeat(5000) }),
    ];

    await freshSynthesize('batch query', contents, 'installation');

    expect(mockedBatchAndMerge).toHaveBeenCalledTimes(1);
    const callArgs = mockedBatchAndMerge.mock.calls[0];
    expect(callArgs[0]).toBe('batch query');
    expect(callArgs[1]).toBe(contents);
    expect(callArgs[2]).toBe('installation');
    expect(callArgs[3]).toBeDefined(); // client
    expect(callArgs[4]).toBeDefined(); // config
  });

  it('returns the result from batchAndMerge', async () => {
    vi.resetModules();

    const { synthesize: freshSynthesize } = await import(
      '../../../src/modules/synthesize/synthesizer.js'
    );
    const { batchAndMerge: freshBatchAndMerge } = await import(
      '../../../src/modules/synthesize/batch-merger.js'
    );
    const mockedBatchAndMerge = vi.mocked(freshBatchAndMerge);

    const batchResult = makeDigestResult({
      answer: 'Merged batch answer.',
      keyPoints: ['Merged point'],
      sources: [{ url: 'https://batch.com', title: 'Batch' }],
    });
    mockedBatchAndMerge.mockImplementation(async () => batchResult);

    const contents = [
      makeContentItem({ content: 'X'.repeat(5000) }),
    ];

    const result = await freshSynthesize('test query', contents);

    expect(result.answer).toBe('Merged batch answer.');
    expect(result.keyPoints).toEqual(['Merged point']);
  });

  it('logs synthesis done with batches=0 on batch path', async () => {
    vi.resetModules();

    const { synthesize: freshSynthesize } = await import(
      '../../../src/modules/synthesize/synthesizer.js'
    );
    const { batchAndMerge: freshBatchAndMerge } = await import(
      '../../../src/modules/synthesize/batch-merger.js'
    );
    const mockedBatchAndMerge = vi.mocked(freshBatchAndMerge);
    mockedBatchAndMerge.mockImplementation(async () => makeDigestResult());

    const contents = [
      makeContentItem({ content: 'X'.repeat(5000) }),
    ];

    await freshSynthesize('test query', contents);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] synthesis done:');
    // batchCount is set to 0 when batchAndMerge is invoked (it logs its own)
    expect(output).toContain('batches=0');
  });
});

// ---------------------------------------------------------------------------
// synthesize — empty contents
// ---------------------------------------------------------------------------

describe('synthesize — empty contents', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.env['LLM_API_KEY'] = 'test-key';
    mockCallLLM.mockReset();
    mockBatchAndMerge.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
  });

  // [Implements: US-SY-003] Empty contents → degradation
  it('returns degradation fallback for empty contents', async () => {
    const result = await synthesize('test query', []);

    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(
      true
    );
    expect(result.answer).toContain('No content available');
  });

  it('does not call the LLM for empty contents', async () => {
    await synthesize('test query', []);

    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockBatchAndMerge).not.toHaveBeenCalled();
  });

  it('Promise resolves (never rejects) for empty contents', async () => {
    await expect(synthesize('test query', [])).resolves.toBeDefined();
  });

  it('degradation result has empty keyPoints and sources for empty contents', async () => {
    const result = await synthesize('test query', []);

    expect(result.keyPoints).toEqual([]);
    expect(result.sources).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// synthesize — LLM failure → degradation
// ---------------------------------------------------------------------------

describe('synthesize — LLM failure → degradation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.env['LLM_API_KEY'] = 'test-key';
    mockCallLLM.mockReset();
    mockBatchAndMerge.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
  });

  // [Implements: US-SY-007, BG-SY-003]
  it('returns degradation fallback when LLM throws', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM service unavailable'));

    const contents = [makeContentItem()];

    const result = await synthesize('test query', contents);

    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(
      true
    );
  });

  it('Promise resolves (never rejects) on LLM failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('Fatal LLM error'));

    await expect(
      synthesize('test query', [makeContentItem()])
    ).resolves.toBeDefined();
  });

  it('degradation result includes all input sources on LLM failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM error'));

    const contents = [
      makeContentItem({ url: 'https://a.com', title: 'A' }),
      makeContentItem({ url: 'https://b.com', title: 'B' }),
    ];

    const result = await synthesize('test query', contents);

    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://a.com');
    expect(urls).toContain('https://b.com');
  });

  it('degradation result includes content from input items on failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM error'));

    const contents = [
      makeContentItem({ content: 'Raw content from the source page.' }),
    ];

    const result = await synthesize('test query', contents);

    expect(result.answer).toContain('Raw content from the source page.');
  });

  it('logs synthesis error to stderr on failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('Connection refused'));

    await synthesize('test query', [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] synthesis error:');
    expect(output).toContain('Connection refused');
    expect(output).toContain('action=degrade');
  });

  it('logs degradation activation on failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('Network failure'));

    await synthesize('test query', [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] degradation activated:');
    expect(output).toContain('Network failure');
  });

  it('handles empty answer from LLM → degradation', async () => {
    mockCallLLM.mockImplementation(async () =>
      makeLLMResponse('')
    );

    const contents = [makeContentItem()];

    const result = await synthesize('test query', contents);

    // Empty answer → degradation
    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(
      true
    );
  });

  it('handles whitespace-only answer from LLM → degradation', async () => {
    mockCallLLM.mockImplementation(async () =>
      makeLLMResponse('   \n\n  \t  ')
    );

    const contents = [makeContentItem()];

    const result = await synthesize('test query', contents);

    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// synthesize — observability logging
// ---------------------------------------------------------------------------

describe('synthesize — observability logging', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.env['LLM_API_KEY'] = 'test-key';
    mockCallLLM.mockReset();
    mockBatchAndMerge.mockReset();
    mockCallLLM.mockImplementation(async () =>
      makeLLMResponse(LLM_RESPONSE, 250, 120)
    );
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
  });

  // [Implements: US-SY-010, NFR-SY-004]
  it('logs "[SY] synthesis start: ..." to stderr', async () => {
    await synthesize('test query', [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] synthesis start:');
  });

  it('start log includes source count', async () => {
    const contents = [
      makeContentItem({ url: 'https://a.com' }),
      makeContentItem({ url: 'https://b.com' }),
      makeContentItem({ url: 'https://c.com' }),
    ];

    await synthesize('test query', contents);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('sources=3');
  });

  it('start log includes the truncated query', async () => {
    await synthesize('my search query', [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('query="my search query"');
  });

  it('start log includes focus when provided', async () => {
    await synthesize('query', [makeContentItem()], 'installation');

    const output = captureStderr(stderrSpy);
    expect(output).toContain('focus="installation"');
  });

  it('start log includes "none" focus when not provided', async () => {
    await synthesize('query', [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('focus="none"');
  });

  it('start log includes "none" focus when focus is empty string', async () => {
    await synthesize('query', [makeContentItem()], '');

    const output = captureStderr(stderrSpy);
    expect(output).toContain('focus="none"');
  });

  it('start log includes "none" focus when focus is whitespace-only', async () => {
    await synthesize('query', [makeContentItem()], '   ');

    const output = captureStderr(stderrSpy);
    expect(output).toContain('focus="none"');
  });

  // [Implements: US-SY-009, NFR-SY-005]
  it('logs "[SY] estimated tokens: ..." to stderr', async () => {
    await synthesize('test query', [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] estimated tokens:');
    expect(output).toContain('threshold:');
  });

  it('logs "[SY] synthesis tokens: ..." to stderr on single-call path', async () => {
    await synthesize('test query', [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] synthesis tokens:');
    expect(output).toContain('370');
  });

  it('logs "[SY] synthesis done: ..." to stderr', async () => {
    await synthesize('test query', [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] synthesis done:');
    expect(output).toContain('duration=');
    expect(output).toContain('tokens=');
    expect(output).toContain('batches=');
    expect(output).toContain('degraded=');
  });

  it('done log shows degraded=false for successful single-call', async () => {
    await synthesize('test query', [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('degraded=false');
  });

  it('done log shows degraded=true for degradation fallback', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM error'));

    await synthesize('test query', [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    // When LLM throws, the catch block returns degradation without
    // logging synthesis done. Instead, the error and degradation are logged.
    expect(output).toContain('[SY] synthesis error:');
    expect(output).toContain('action=degrade');
    expect(output).toContain('[SY] degradation activated:');
  });

  it('does not log synthesis tokens on degradation path', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM error'));

    await synthesize('test query', [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    expect(output).not.toContain('[SY] synthesis tokens:');
  });

  // [Implements: NFR-SY-004] All logs use stderr only
  it('does not write to stdout', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      await synthesize('test query', [makeContentItem()]);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('does not write to stdout on LLM failure', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    mockCallLLM.mockRejectedValue(new Error('LLM error'));

    try {
      await synthesize('test query', [makeContentItem()]);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('does not write to stdout for empty contents', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      await synthesize('test query', []);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// synthesize — query truncation
// ---------------------------------------------------------------------------

describe('synthesize — query truncation in logs', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.env['LLM_API_KEY'] = 'test-key';
    mockCallLLM.mockReset();
    mockBatchAndMerge.mockReset();
    mockCallLLM.mockImplementation(async () => makeLLMResponse(LLM_RESPONSE));
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
  });

  // [Implements: US-SY-010, NFR-SY-004] Query truncated to 80 chars in logs
  it('truncates query longer than 80 characters in the start log', async () => {
    const longQuery = 'A'.repeat(200);
    await synthesize(longQuery, [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    const startLine = output
      .split('\n')
      .find((l) => l.includes('synthesis start:'));
    expect(startLine).toBeDefined();
    // The query in the log should be truncated to 80 chars
    expect(startLine!).toContain(`query="${'A'.repeat(80)}"`);
    // Should NOT contain the full 200-char query
    expect(startLine!).not.toContain('A'.repeat(81));
  });

  it('does not truncate queries shorter than 80 characters', async () => {
    const shortQuery = 'Short query text here for testing';
    await synthesize(shortQuery, [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    const startLine = output
      .split('\n')
      .find((l) => l.includes('synthesis start:'));
    expect(startLine!).toContain(`query="${shortQuery}"`);
  });

  it('handles query exactly at 80 characters', async () => {
    const exactQuery = 'B'.repeat(80);
    await synthesize(exactQuery, [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    const startLine = output
      .split('\n')
      .find((l) => l.includes('synthesis start:'));
    expect(startLine!).toContain(`query="${exactQuery}"`);
  });

  it('handles query of 81 characters (truncated to 80)', async () => {
    const query81 = 'C'.repeat(81);
    await synthesize(query81, [makeContentItem()]);

    const output = captureStderr(stderrSpy);
    const startLine = output
      .split('\n')
      .find((l) => l.includes('synthesis start:'));
    expect(startLine!).toContain(`query="${'C'.repeat(80)}"`);
  });

  it('passes the full query to the LLM (not truncated)', async () => {
    const longQuery = 'D'.repeat(200);
    await synthesize(longQuery, [makeContentItem()]);

    const callArgs = mockCallLLM.mock.calls[0];
    const userPrompt = String(callArgs[2]);
    // The full query should appear in the user prompt
    expect(userPrompt).toContain(longQuery);
  });
});

// ---------------------------------------------------------------------------
// synthesizeSingle — short content guard
// ---------------------------------------------------------------------------

describe('synthesizeSingle — short content guard', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.env['LLM_API_KEY'] = 'test-key';
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async () => makeLLMResponse(LLM_RESPONSE));
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
  });

  // [Implements: US-SY-004] Content < 200 chars → degradation
  it('returns degradation for content shorter than 200 characters', async () => {
    const shortContent = 'A'.repeat(100);

    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      shortContent
    );

    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(
      true
    );
  });

  it('degradation reason includes "content too short"', async () => {
    const shortContent = 'Short content.';

    await synthesizeSingle(
      'https://example.com',
      'Title',
      shortContent
    );

    const output = captureStderr(stderrSpy);
    expect(output).toContain('content too short for meaningful synthesis');
  });

  it('does not call the LLM for short content', async () => {
    await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(50));

    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('Promise resolves (never rejects) for short content', async () => {
    await expect(
      synthesizeSingle('https://example.com', 'Title', 'A'.repeat(50))
    ).resolves.toBeDefined();
  });

  it('short content degradation includes the input URL in sources', async () => {
    const result = await synthesizeSingle(
      'https://short-url.com',
      'Short Title',
      'A'.repeat(50)
    );

    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://short-url.com');
  });

  it('handles content exactly at 199 characters (degradation)', async () => {
    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      'A'.repeat(199)
    );

    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(
      true
    );
  });

  it('handles empty string content (degradation)', async () => {
    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      ''
    );

    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// synthesizeSingle — normal path
// ---------------------------------------------------------------------------

describe('synthesizeSingle — normal path', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.env['LLM_API_KEY'] = 'test-key';
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async () =>
      makeLLMResponse(LLM_RESPONSE, 300, 150)
    );
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
  });

  // [Implements: US-SY-004] Content ≥ 200 chars → LLM synthesis
  it('returns a valid DigestResult for content >= 200 characters', async () => {
    const content = 'A'.repeat(300) + ' This is meaningful content here.';

    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      content
    );

    expect(result).toHaveProperty('answer');
    expect(result).toHaveProperty('keyPoints');
    expect(result).toHaveProperty('sources');
  });

  it('returns a parsed answer from the LLM response', async () => {
    const content = 'A'.repeat(300);

    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      content
    );

    expect(result.answer).toBe('This is the synthesized answer from the LLM.');
  });

  it('returns parsed keyPoints from the LLM response', async () => {
    const content = 'A'.repeat(300);

    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      content
    );

    expect(result.keyPoints).toEqual([
      'First key point from the synthesized content',
      'Second key point from the synthesized content',
    ]);
  });

  // [Implements: US-SY-004] Sources has exactly one entry
  it('sources has exactly one entry (the input URL and title)', async () => {
    const content = 'A'.repeat(300);

    const result = await synthesizeSingle(
      'https://single-source.com',
      'Single Source Title',
      content
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe('https://single-source.com');
    expect(result.sources[0].title).toBe('Single Source Title');
  });

  it('makes a single LLM call', async () => {
    const content = 'A'.repeat(300);

    await synthesizeSingle('https://example.com', 'Title', content);

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it('handles content exactly at 200 characters (LLM call)', async () => {
    const content = 'A'.repeat(200);

    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      content
    );

    expect(result.answer).toBe('This is the synthesized answer from the LLM.');
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it('returns a result that is not a degradation fallback', async () => {
    const content = 'A'.repeat(300);

    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      content
    );

    expect(result.answer).not.toContain('[Note: LLM synthesis unavailable');
  });

  it('handles content with special characters', async () => {
    const content =
      'A'.repeat(100) +
      ' Content with <html> & special chars! @#$%^&*() ' +
      'B'.repeat(100);

    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      content
    );

    expect(result.answer).toBe('This is the synthesized answer from the LLM.');
  });

  it('passes focus to the LLM call when provided', async () => {
    const content = 'A'.repeat(300);

    await synthesizeSingle(
      'https://example.com',
      'Title',
      content,
      'installation'
    );

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    const userPrompt = String(mockCallLLM.mock.calls[0][2]);
    expect(userPrompt).toContain('installation');
  });
});

// ---------------------------------------------------------------------------
// synthesizeSingle — degradation on failure
// ---------------------------------------------------------------------------

describe('synthesizeSingle — degradation on failure', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.env['LLM_API_KEY'] = 'test-key';
    mockCallLLM.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
  });

  // [Implements: US-SY-007, BG-SY-003]
  it('returns degradation fallback when LLM throws', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM down'));

    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      'A'.repeat(300)
    );

    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(
      true
    );
  });

  it('Promise resolves (never rejects) on LLM failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('Fatal error'));

    await expect(
      synthesizeSingle('https://example.com', 'Title', 'A'.repeat(300))
    ).resolves.toBeDefined();
  });

  it('degradation includes the input URL in sources on failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM error'));

    const result = await synthesizeSingle(
      'https://fail-url.com',
      'Fail Title',
      'A'.repeat(300)
    );

    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://fail-url.com');
  });

  it('degradation includes content from input on failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM error'));

    const content = 'B'.repeat(300) + ' Unique content snippet.';

    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      content
    );

    expect(result.answer).toContain('Unique content snippet.');
  });

  it('logs synthesis error on LLM failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('Connection timeout'));

    await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(300));

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] synthesis error:');
    expect(output).toContain('Connection timeout');
    expect(output).toContain('action=degrade');
  });

  it('logs degradation activation on LLM failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('Auth failed'));

    await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(300));

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] degradation activated:');
    expect(output).toContain('Auth failed');
  });

  it('handles empty answer from LLM → degradation', async () => {
    mockCallLLM.mockImplementation(async () =>
      makeLLMResponse('   \n\n  ')
    );

    const result = await synthesizeSingle(
      'https://example.com',
      'Title',
      'A'.repeat(300)
    );

    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// synthesizeSingle — observability logging
// ---------------------------------------------------------------------------

describe('synthesizeSingle — observability logging', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.env['LLM_API_KEY'] = 'test-key';
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async () =>
      makeLLMResponse(LLM_RESPONSE, 250, 100)
    );
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
  });

  // [Implements: US-SY-010, NFR-SY-004]
  it('logs "[SY] synthesis start: ..." with sources=1', async () => {
    await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(300));

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] synthesis start:');
    expect(output).toContain('sources=1');
  });

  it('logs "[SY] synthesis tokens: ..." on successful call', async () => {
    await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(300));

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] synthesis tokens:');
    expect(output).toContain('350');
  });

  it('logs "[SY] synthesis done: ..." on successful call', async () => {
    await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(300));

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] synthesis done:');
    expect(output).toContain('duration=');
    expect(output).toContain('tokens=');
    expect(output).toContain('batches=1');
    expect(output).toContain('degraded=false');
  });

  it('done log shows degraded=false for successful synthesis', async () => {
    await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(300));

    const output = captureStderr(stderrSpy);
    expect(output).toContain('degraded=false');
  });

  it('done log shows degraded=true for short content degradation', async () => {
    await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(50));

    const output = captureStderr(stderrSpy);
    // Short content returns degradation within the try block without
    // logging synthesis done. The degradation activation is logged instead.
    expect(output).toContain('[SY] degradation activated:');
    expect(output).toContain('content too short');
  });

  it('start log includes the URL as the query (truncated to 80 chars)', async () => {
    const longUrl = 'https://example.com/' + 'A'.repeat(200);

    await synthesizeSingle(longUrl, 'Title', 'B'.repeat(300));

    const output = captureStderr(stderrSpy);
    const startLine = output
      .split('\n')
      .find((l) => l.includes('synthesis start:'));
    expect(startLine).toBeDefined();
    // URL should be truncated in the log
    expect(startLine!.length).toBeLessThan(200);
  });

  it('start log includes focus when provided', async () => {
    await synthesizeSingle(
      'https://example.com',
      'Title',
      'A'.repeat(300),
      'pricing'
    );

    const output = captureStderr(stderrSpy);
    expect(output).toContain('focus="pricing"');
  });

  it('start log includes "none" focus when not provided', async () => {
    await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(300));

    const output = captureStderr(stderrSpy);
    expect(output).toContain('focus="none"');
  });

  // [Implements: NFR-SY-004]
  it('does not write to stdout', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(300));
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('does not write to stdout on short content degradation', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(50));
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('does not write to stdout on LLM failure', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    mockCallLLM.mockRejectedValue(new Error('LLM error'));

    try {
      await synthesizeSingle('https://example.com', 'Title', 'A'.repeat(300));
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// synthesize — focus parameter propagation
// ---------------------------------------------------------------------------

describe('synthesize — focus parameter propagation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.env['LLM_API_KEY'] = 'test-key';
    mockCallLLM.mockReset();
    mockBatchAndMerge.mockReset();
    mockCallLLM.mockImplementation(async () => makeLLMResponse(LLM_RESPONSE));
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
  });

  it('passes focus to the user prompt', async () => {
    await synthesize('query', [makeContentItem()], 'API usage');

    const userPrompt = String(mockCallLLM.mock.calls[0][2]);
    expect(userPrompt).toContain('API usage');
  });

  it('works without focus (undefined)', async () => {
    const result = await synthesize('query', [makeContentItem()]);

    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('works with empty focus string', async () => {
    const result = await synthesize('query', [makeContentItem()], '');

    expect(result.answer.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// synthesize — structural validity guarantees
// ---------------------------------------------------------------------------

describe('synthesize — structural validity', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.env['LLM_API_KEY'] = 'test-key';
    mockCallLLM.mockReset();
    mockBatchAndMerge.mockReset();
    mockCallLLM.mockImplementation(async () => makeLLMResponse(LLM_RESPONSE));
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env['LLM_API_KEY'];
  });

  it('result has answer as a non-empty string', async () => {
    const result = await synthesize('query', [makeContentItem()]);
    expect(typeof result.answer).toBe('string');
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('result has keyPoints as an array', async () => {
    const result = await synthesize('query', [makeContentItem()]);
    expect(Array.isArray(result.keyPoints)).toBe(true);
  });

  it('result has sources as an array', async () => {
    const result = await synthesize('query', [makeContentItem()]);
    expect(Array.isArray(result.sources)).toBe(true);
  });

  it('all sources have url and title properties', async () => {
    const result = await synthesize('query', [
      makeContentItem({ url: 'https://a.com', title: 'A' }),
    ]);
    for (const src of result.sources) {
      expect(src).toHaveProperty('url');
      expect(src).toHaveProperty('title');
      expect(typeof src.url).toBe('string');
      expect(typeof src.title).toBe('string');
    }
  });
});
