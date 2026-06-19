/**
 * Integration tests for the batch-merger module.
 *
 * Tests batch splitting (splitIntoBatches via batchAndMerge), parallel
 * batch synthesis, the merge call, recursive re-batching when the merge
 * prompt overflows, and the degradation fallback path.
 *
 * [Spec: US-SY-005, US-SY-009, US-SY-010, BG-SY-001]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the llm-client module so we control all LLM call behavior.
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
}));

vi.mock('../../../src/modules/synthesize/llm-client.js', () => ({
  callLLMWithRetry: vi.fn(),
  createLLMClient: vi.fn(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
  verifyLLMConnectivity: vi.fn(async () => true),
}));

import { batchAndMerge } from '../../../src/modules/synthesize/batch-merger.js';
import { callLLMWithRetry } from '../../../src/modules/synthesize/llm-client.js';

import type { ContentItem } from '../../../src/shared/types/content.js';
import type { DigestResult } from '../../../src/shared/types/digest.js';
import type {
  SynthesizeConfig,
  OpenAIClient,
  LLMResponse,
} from '../../../src/modules/synthesize/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCallLLM = vi.mocked(callLLMWithRetry);

const dummyClient: OpenAIClient = {
  chat: {
    completions: {
      create: vi.fn() as unknown as OpenAIClient['chat']['completions']['create'],
    },
  },
};

function makeConfig(
  overrides: Partial<SynthesizeConfig> = {}
): SynthesizeConfig {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://api.test.com/v1',
    model: 'test-model',
    timeoutMs: 60_000,
    maxContextTokens: 128_000,
    safeThresholdRatio: 0.8,
    maxBatchConcurrency: 2,
    ...overrides,
  };
}

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

const BATCH_RESPONSE = [
  '## Answer',
  'This is the synthesized answer for this batch of content.',
  '',
  '## Key Points',
  '- First key point extracted from the batch content',
  '- Second key point extracted from the batch content',
  '',
  '## Sources',
  'https://source-in-response.com',
].join('\n');

const MERGE_RESPONSE = [
  '## Answer',
  'This is the merged answer combining all batch results into one.',
  '',
  '## Key Points',
  '- Merged key point one from multiple batches',
  '- Merged key point two from multiple batches',
  '- Merged key point three from multiple batches',
  '',
  '## Sources',
  'https://source-in-response.com',
].join('\n');

function captureStderr(
  spy: ReturnType<typeof vi.spyOn>
): string {
  return spy.mock.calls.map((c) => String(c[0])).join('');
}

// ---------------------------------------------------------------------------
// batchAndMerge — basic structure
// ---------------------------------------------------------------------------

describe('batchAndMerge — basic structure', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async () =>
      makeLLMResponse(BATCH_RESPONSE)
    );
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-005]
  it('returns a valid DigestResult with answer, keyPoints, and sources', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    const result = await batchAndMerge(
      'test query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result).toHaveProperty('answer');
    expect(result).toHaveProperty('keyPoints');
    expect(result).toHaveProperty('sources');
    expect(typeof result.answer).toBe('string');
    expect(Array.isArray(result.keyPoints)).toBe(true);
    expect(Array.isArray(result.sources)).toBe(true);
  });

  it('answer is non-empty', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    const result = await batchAndMerge(
      'test query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('returns a result that is not a degradation fallback', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    const result = await batchAndMerge(
      'test query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.answer).not.toContain('[Note: LLM synthesis unavailable');
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — batch splitting
// ---------------------------------------------------------------------------

describe('batchAndMerge — batch splitting', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-005] Small content with large threshold → single batch
  it('creates a single batch when content fits within threshold', async () => {
    const config = makeConfig({ maxContextTokens: 128_000 });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'Short content A.' }),
      makeContentItem({ url: 'https://b.com', content: 'Short content B.' }),
    ];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    // 1 batch call + 1 merge call = 2 total
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });

  // [Implements: US-SY-005] Large content with small threshold → multiple batches
  it('splits content into multiple batches when threshold is exceeded', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
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

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    // Each item goes into its own batch (exceeds threshold individually),
    // so 2 batch calls + 1 merge call = 3 total
    expect(mockCallLLM).toHaveBeenCalledTimes(3);
  });

  it('logs the correct batch count to stderr', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'A'.repeat(3000) }),
      makeContentItem({ url: 'https://b.com', content: 'B'.repeat(3000) }),
    ];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] batching: 2 batches for 2 content items');
  });

  it('handles a single item (one batch, one merge)', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    // 1 batch + 1 merge = 2
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });

  it('creates more batches for more items with small threshold', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = Array.from({ length: 5 }, (_, i) =>
      makeContentItem({
        url: `https://item${i}.com`,
        content: 'X'.repeat(3000),
      })
    );

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    // 5 items, each too large to share a batch → 5 batches + 1 merge = 6
    expect(mockCallLLM).toHaveBeenCalledTimes(6);
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — batch synthesis and merge
// ---------------------------------------------------------------------------

describe('batchAndMerge — batch synthesis and merge', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-005] Each batch is synthesized via callLLMWithRetry
  it('makes an LLM call for each batch', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'A'.repeat(3000) }),
      makeContentItem({ url: 'https://b.com', content: 'B'.repeat(3000) }),
    ];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    // 2 batch calls (non-merge) + 1 merge call
    const batchCalls = mockCallLLM.mock.calls.filter(
      (call) => !String(call[1]).toLowerCase().includes('merge')
    );
    expect(batchCalls).toHaveLength(2);
  });

  // [Implements: US-SY-005] Merge call is made after batch processing
  it('makes a merge LLM call after processing all batches', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'A'.repeat(3000) }),
      makeContentItem({ url: 'https://b.com', content: 'B'.repeat(3000) }),
    ];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const mergeCalls = mockCallLLM.mock.calls.filter((call) =>
      String(call[1]).toLowerCase().includes('merge')
    );
    expect(mergeCalls).toHaveLength(1);
  });

  // [Implements: US-SY-005] Final result has merged keyPoints from merge response
  it('returns merged keyPoints from the merge response', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'A'.repeat(3000) }),
      makeContentItem({ url: 'https://b.com', content: 'B'.repeat(3000) }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.keyPoints).toEqual([
      'Merged key point one from multiple batches',
      'Merged key point two from multiple batches',
      'Merged key point three from multiple batches',
    ]);
  });

  // [Implements: US-SY-005] Final result has merged answer from merge response
  it('returns the merged answer from the merge response', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'A'.repeat(3000) }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.answer).toBe(
      'This is the merged answer combining all batch results into one.'
    );
  });

  // [Implements: US-SY-005] Merge call happens after all batch calls
  it('merge call is the last callLLMWithRetry invocation', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'A'.repeat(3000) }),
      makeContentItem({ url: 'https://b.com', content: 'B'.repeat(3000) }),
    ];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const lastCall = mockCallLLM.mock.calls[mockCallLLM.mock.calls.length - 1];
    const lastSystemPrompt = String(lastCall[1]);
    expect(lastSystemPrompt.toLowerCase()).toContain('merge');
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — source reconciliation
// ---------------------------------------------------------------------------

describe('batchAndMerge — source reconciliation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-005] All original input sources are represented
  it('appends missing input sources not present in the merge response', async () => {
    const config = makeConfig();
    const contents = [
      makeContentItem({ url: 'https://input-a.com', title: 'Input A' }),
      makeContentItem({ url: 'https://input-b.com', title: 'Input B' }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://input-a.com');
    expect(urls).toContain('https://input-b.com');
  });

  it('includes source titles from original content items', async () => {
    const config = makeConfig();
    const contents = [
      makeContentItem({
        url: 'https://input-a.com',
        title: 'Alpha Source Title',
      }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    const titles = result.sources.map((s) => s.title);
    expect(titles).toContain('Alpha Source Title');
  });

  it('does not duplicate sources already present in the merge response', async () => {
    const config = makeConfig();
    const contents = [
      makeContentItem({
        url: 'https://source-in-response.com',
        title: 'Already Present',
      }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    const matching = result.sources.filter(
      (s) => s.url === 'https://source-in-response.com'
    );
    expect(matching).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — focus parameter
// ---------------------------------------------------------------------------

describe('batchAndMerge — focus parameter', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('passes focus to batch prompts', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    await batchAndMerge(
      'query',
      contents,
      'installation',
      dummyClient,
      config
    );

    // Check that batch calls received the focus in the user prompt
    const batchCalls = mockCallLLM.mock.calls.filter(
      (call) => !String(call[1]).toLowerCase().includes('merge')
    );
    expect(batchCalls.length).toBeGreaterThan(0);
    const batchUserPrompt = String(batchCalls[0][2]);
    expect(batchUserPrompt).toContain('installation');
  });

  it('passes focus to merge prompt', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    await batchAndMerge(
      'query',
      contents,
      'CHANGELOG',
      dummyClient,
      config
    );

    const mergeCalls = mockCallLLM.mock.calls.filter((call) =>
      String(call[1]).toLowerCase().includes('merge')
    );
    expect(mergeCalls.length).toBeGreaterThan(0);
    const mergeUserPrompt = String(mergeCalls[0][2]);
    expect(mergeUserPrompt).toContain('CHANGELOG');
  });

  it('works without focus (undefined)', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.answer.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — recursive merge
// ---------------------------------------------------------------------------

describe('batchAndMerge — recursive merge', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-005] Recursive re-batching when merge prompt overflows
  it('logs merge re-batching message when merge prompt exceeds threshold', async () => {
    // Use a threshold of 4000 tokens
    const config = makeConfig({ maxContextTokens: 5_000, safeThresholdRatio: 0.8 });

    // Batch responses with large answers to inflate the merge prompt
    const largeBatchResponse = [
      '## Answer',
      'A'.repeat(3000),
      '',
      '## Key Points',
      '- Key point one',
      '',
      '## Sources',
      'https://source.com',
    ].join('\n');

    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(largeBatchResponse);
    });

    // 5 large items → each goes into its own batch → 5 digests
    // Merge of 5 digests with large answers exceeds 4000 → re-batch
    const contents = Array.from({ length: 5 }, (_, i) =>
      makeContentItem({
        url: `https://item${i}.com`,
        content: 'X'.repeat(15000),
      })
    );

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] merge re-batching:');
    expect(output).toContain('merge prompt exceeds threshold');
  });

  it('makes additional batch calls after re-batching', async () => {
    const config = makeConfig({ maxContextTokens: 5_000, safeThresholdRatio: 0.8 });

    const largeBatchResponse = [
      '## Answer',
      'A'.repeat(3000),
      '',
      '## Key Points',
      '- Key point',
      '',
      '## Sources',
      'https://source.com',
    ].join('\n');

    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(largeBatchResponse);
    });

    const contents = Array.from({ length: 5 }, (_, i) =>
      makeContentItem({
        url: `https://item${i}.com`,
        content: 'X'.repeat(15000),
      })
    );

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    // Original: 5 batch calls
    // Re-batch: some sub-batch calls
    // Final: 1 merge call
    // Total > 5 + 1 = 6 (there must be additional calls from re-batching)
    expect(mockCallLLM.mock.calls.length).toBeGreaterThan(6);
  });

  it('eventually terminates and returns a valid result', async () => {
    const config = makeConfig({ maxContextTokens: 5_000, safeThresholdRatio: 0.8 });

    const largeBatchResponse = [
      '## Answer',
      'A'.repeat(3000),
      '',
      '## Key Points',
      '- Key point',
      '',
      '## Sources',
      'https://source.com',
    ].join('\n');

    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(largeBatchResponse);
    });

    const contents = Array.from({ length: 5 }, (_, i) =>
      makeContentItem({
        url: `https://item${i}.com`,
        content: 'X'.repeat(15000),
      })
    );

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result).toHaveProperty('answer');
    expect(result).toHaveProperty('keyPoints');
    expect(result).toHaveProperty('sources');
    expect(result.answer.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — degradation path
// ---------------------------------------------------------------------------

describe('batchAndMerge — degradation path', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-005, US-SY-007] LLM failure → degradation fallback
  it('returns degradation fallback when LLM throws on all calls', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM service unavailable'));

    const config = makeConfig();
    const contents = [makeContentItem()];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(true);
  });

  it('degradation result includes all input sources', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM error'));

    const config = makeConfig();
    const contents = [
      makeContentItem({ url: 'https://a.com', title: 'A' }),
      makeContentItem({ url: 'https://b.com', title: 'B' }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://a.com');
    expect(urls).toContain('https://b.com');
  });

  it('degradation result includes content from input items', async () => {
    mockCallLLM.mockRejectedValue(new Error('LLM error'));

    const config = makeConfig();
    const contents = [
      makeContentItem({ content: 'Raw content from the source page.' }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.answer).toContain('Raw content from the source page.');
  });

  it('logs degradation activation to stderr on failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('Connection refused'));

    const config = makeConfig();
    const contents = [makeContentItem()];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] degradation activated:');
    expect(output).toContain('Connection refused');
  });

  // [Implements: US-SY-005] Empty contents → degradation
  it('returns degradation fallback for empty contents', async () => {
    mockCallLLM.mockImplementation(async () => makeLLMResponse(BATCH_RESPONSE));

    const config = makeConfig();

    const result = await batchAndMerge(
      'query',
      [],
      undefined,
      dummyClient,
      config
    );

    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(true);
    expect(result.answer).toContain('No content available');
  });

  it('does not call LLM for empty contents', async () => {
    mockCallLLM.mockImplementation(async () => makeLLMResponse(BATCH_RESPONSE));

    const config = makeConfig();

    await batchAndMerge('query', [], undefined, dummyClient, config);

    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('Promise resolves (never rejects) on LLM failure', async () => {
    mockCallLLM.mockRejectedValue(new Error('Fatal error'));

    const config = makeConfig();
    const contents = [makeContentItem()];

    await expect(
      batchAndMerge('query', contents, undefined, dummyClient, config)
    ).resolves.toBeDefined();
  });

  it('Promise resolves (never rejects) for empty contents', async () => {
    mockCallLLM.mockImplementation(async () => makeLLMResponse(BATCH_RESPONSE));

    const config = makeConfig();

    await expect(
      batchAndMerge('query', [], undefined, dummyClient, config)
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — logging
// ---------------------------------------------------------------------------

describe('batchAndMerge — logging', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-010, NFR-SY-004] Batching log format
  it('logs "[SY] batching: {N} batches for {M} content items" to stderr', async () => {
    const config = makeConfig();
    const contents = [
      makeContentItem({ url: 'https://a.com' }),
      makeContentItem({ url: 'https://b.com' }),
      makeContentItem({ url: 'https://c.com' }),
    ];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const output = captureStderr(stderrSpy);
    expect(output).toMatch(
      /\[SY\] batching: \d+ batches for 3 content items/
    );
  });

  it('includes [SY] module tag in batching log', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const output = captureStderr(stderrSpy);
    const batchingLines = output
      .split('\n')
      .filter((l) => l.includes('batching'));
    for (const line of batchingLines) {
      expect(line).toContain('[SY]');
    }
  });

  // [Implements: NFR-SY-004] Does not write to stdout
  it('does not write to stdout', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const config = makeConfig();
      const contents = [makeContentItem()];

      await batchAndMerge('query', contents, undefined, dummyClient, config);

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — concurrency
// ---------------------------------------------------------------------------

describe('batchAndMerge — concurrency', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('respects maxBatchConcurrency setting', async () => {
    const config = makeConfig({
      maxContextTokens: 1000,
      maxBatchConcurrency: 1,
    });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'A'.repeat(3000) }),
      makeContentItem({ url: 'https://b.com', content: 'B'.repeat(3000) }),
    ];

    // With maxBatchConcurrency: 1, batches are processed sequentially
    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result).toBeDefined();
    // Still makes 2 batch + 1 merge = 3 calls
    expect(mockCallLLM).toHaveBeenCalledTimes(3);
  });

  it('works with maxBatchConcurrency > number of batches', async () => {
    const config = makeConfig({
      maxContextTokens: 1000,
      maxBatchConcurrency: 10,
    });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'A'.repeat(3000) }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — query parameter
// ---------------------------------------------------------------------------

describe('batchAndMerge — query parameter', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('passes query to batch user prompts', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    await batchAndMerge(
      'What is TypeScript?',
      contents,
      undefined,
      dummyClient,
      config
    );

    const batchCalls = mockCallLLM.mock.calls.filter(
      (call) => !String(call[1]).toLowerCase().includes('merge')
    );
    expect(batchCalls.length).toBeGreaterThan(0);
    expect(String(batchCalls[0][2])).toContain('What is TypeScript?');
  });

  it('passes query to merge user prompts', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    await batchAndMerge(
      'Special query text',
      contents,
      undefined,
      dummyClient,
      config
    );

    const mergeCalls = mockCallLLM.mock.calls.filter((call) =>
      String(call[1]).toLowerCase().includes('merge')
    );
    expect(mergeCalls.length).toBeGreaterThan(0);
    expect(String(mergeCalls[0][2])).toContain('Special query text');
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — batch content isolation
// ---------------------------------------------------------------------------

describe('batchAndMerge — batch content isolation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    // Capture which content URLs are passed to each batch call by
    // returning different responses based on the user prompt content.
    mockCallLLM.mockImplementation(async (_client, systemPrompt, userPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      const promptStr = String(userPrompt);
      const hasUrlA = promptStr.includes('https://batch-a.com');
      const hasUrlB = promptStr.includes('https://batch-b.com');

      if (hasUrlA && !hasUrlB) {
        return makeLLMResponse(
          BATCH_RESPONSE.replace(
            'https://source-in-response.com',
            'https://batch-a.com'
          )
        );
      }
      if (hasUrlB && !hasUrlA) {
        return makeLLMResponse(
          BATCH_RESPONSE.replace(
            'https://source-in-response.com',
            'https://batch-b.com'
          )
        );
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-005] Each batch only receives its assigned content
  it('each batch prompt only contains content from that batch', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ url: 'https://batch-a.com', content: 'A'.repeat(3000) }),
      makeContentItem({ url: 'https://batch-b.com', content: 'B'.repeat(3000) }),
    ];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const batchCalls = mockCallLLM.mock.calls.filter(
      (call) => !String(call[1]).toLowerCase().includes('merge')
    );

    // First batch should only have batch-a URL
    const batch1Prompt = String(batchCalls[0][2]);
    expect(batch1Prompt).toContain('https://batch-a.com');
    expect(batch1Prompt).not.toContain('https://batch-b.com');

    // Second batch should only have batch-b URL
    const batch2Prompt = String(batchCalls[1][2]);
    expect(batch2Prompt).toContain('https://batch-b.com');
    expect(batch2Prompt).not.toContain('https://batch-a.com');
  });

  it('merge prompt contains results from all batches', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ url: 'https://batch-a.com', content: 'A'.repeat(3000) }),
      makeContentItem({ url: 'https://batch-b.com', content: 'B'.repeat(3000) }),
    ];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const mergeCalls = mockCallLLM.mock.calls.filter((call) =>
      String(call[1]).toLowerCase().includes('merge')
    );
    expect(mergeCalls.length).toBe(1);
    const mergePrompt = String(mergeCalls[0][2]);
    // Merge prompt should contain both batch URLs (from intermediate digests)
    expect(mergePrompt).toContain('https://batch-a.com');
    expect(mergePrompt).toContain('https://batch-b.com');
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — multiple items in a single batch
// ---------------------------------------------------------------------------

describe('batchAndMerge — multiple items in single batch', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-005] Items that fit together in one batch are combined
  it('groups small items into a single batch', async () => {
    const config = makeConfig({ maxContextTokens: 50_000 });
    const contents = [
      makeContentItem({ url: 'https://small1.com', content: 'Small 1.' }),
      makeContentItem({ url: 'https://small2.com', content: 'Small 2.' }),
      makeContentItem({ url: 'https://small3.com', content: 'Small 3.' }),
    ];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    // All items fit in 1 batch → 1 batch call + 1 merge call = 2 total
    expect(mockCallLLM).toHaveBeenCalledTimes(2);

    // The single batch call should contain all 3 URLs
    const batchCalls = mockCallLLM.mock.calls.filter(
      (call) => !String(call[1]).toLowerCase().includes('merge')
    );
    expect(batchCalls).toHaveLength(1);
    const batchPrompt = String(batchCalls[0][2]);
    expect(batchPrompt).toContain('https://small1.com');
    expect(batchPrompt).toContain('https://small2.com');
    expect(batchPrompt).toContain('https://small3.com');
  });

  it('logs batching with correct batch and item counts', async () => {
    const config = makeConfig({ maxContextTokens: 50_000 });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'Short.' }),
      makeContentItem({ url: 'https://b.com', content: 'Short.' }),
    ];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] batching: 1 batches for 2 content items');
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — result structure from successful merge
// ---------------------------------------------------------------------------

describe('batchAndMerge — result structure from merge', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-005] Result has merged sources from merge response
  it('result sources include URLs from the merge response', async () => {
    const config = makeConfig();
    const contents = [makeContentItem({ url: 'https://input.com' })];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    const urls = result.sources.map((s) => s.url);
    expect(urls).toContain('https://source-in-response.com');
    expect(urls).toContain('https://input.com');
  });

  // [Implements: US-SY-005] Result answer comes from merge, not batches
  it('result answer comes from the merge response, not individual batches', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ content: 'A'.repeat(3000) }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.answer).toBe(
      'This is the merged answer combining all batch results into one.'
    );
  });

  // [Implements: US-SY-005] Result keyPoints come from merge response
  it('result keyPoints come from the merge response', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ content: 'A'.repeat(3000) }),
      makeContentItem({ content: 'B'.repeat(3000) }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.keyPoints.length).toBe(3);
    for (const kp of result.keyPoints) {
      expect(kp).toContain('Merged');
    }
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — partial batch failure
// ---------------------------------------------------------------------------

describe('batchAndMerge — partial batch failure', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-005] Any batch failure → full degradation
  it('returns degradation when one batch fails but another succeeds', async () => {
    let batchCallIndex = 0;
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      batchCallIndex++;
      if (batchCallIndex === 1) {
        throw new Error('Batch 1 failed');
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });

    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'A'.repeat(3000) }),
      makeContentItem({ url: 'https://b.com', content: 'B'.repeat(3000) }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    // Partial failure causes Promise.all to reject → degradation
    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(
      true
    );
  });

  it('returns degradation when merge call fails', async () => {
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        throw new Error('Merge call failed');
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });

    const config = makeConfig();
    const contents = [makeContentItem()];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.answer.startsWith('[Note: LLM synthesis unavailable')).toBe(
      true
    );
  });

  it('logs degradation reason from the failing call', async () => {
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      throw new Error('Specific batch failure message');
    });

    const config = makeConfig();
    const contents = [makeContentItem()];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] degradation activated:');
    expect(output).toContain('Specific batch failure message');
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — single item optimization
// ---------------------------------------------------------------------------

describe('batchAndMerge — single item optimization', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('handles a single large item that exceeds threshold alone', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({
        url: 'https://huge.com',
        content: 'X'.repeat(10000),
      }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    // Single item goes into its own batch, then merge with 1 digest
    expect(result).toBeDefined();
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('single item produces exactly 1 batch and 1 merge call', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ content: 'X'.repeat(5000) }),
    ];

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — focus in batch vs merge prompts
// ---------------------------------------------------------------------------

describe('batchAndMerge — focus propagation to both batch and merge', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('passes focus to both batch and merge user prompts', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ url: 'https://a.com', content: 'A'.repeat(3000) }),
      makeContentItem({ url: 'https://b.com', content: 'B'.repeat(3000) }),
    ];

    await batchAndMerge(
      'query',
      contents,
      'pricing details',
      dummyClient,
      config
    );

    const batchCalls = mockCallLLM.mock.calls.filter(
      (call) => !String(call[1]).toLowerCase().includes('merge')
    );
    for (const call of batchCalls) {
      expect(String(call[2])).toContain('pricing details');
    }

    const mergeCalls = mockCallLLM.mock.calls.filter((call) =>
      String(call[1]).toLowerCase().includes('merge')
    );
    for (const call of mergeCalls) {
      expect(String(call[2])).toContain('pricing details');
    }
  });

  it('works without focus in multi-batch scenario', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = [
      makeContentItem({ content: 'A'.repeat(3000) }),
      makeContentItem({ content: 'B'.repeat(3000) }),
    ];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.answer.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — large-scale stress test
// ---------------------------------------------------------------------------

describe('batchAndMerge — large-scale stress test', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockImplementation(async (_client, systemPrompt) => {
      if (systemPrompt.toLowerCase().includes('merge')) {
        return makeLLMResponse(MERGE_RESPONSE);
      }
      return makeLLMResponse(BATCH_RESPONSE);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('handles 10 items with small threshold (10 batches + 1 merge)', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = Array.from({ length: 10 }, (_, i) =>
      makeContentItem({
        url: `https://item${i}.com`,
        content: 'X'.repeat(3000),
      })
    );

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result).toBeDefined();
    expect(result.answer.length).toBeGreaterThan(0);
    // 10 batches + 1 merge = 11 total
    expect(mockCallLLM).toHaveBeenCalledTimes(11);
  });

  it('includes all 10 input sources in the result', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = Array.from({ length: 10 }, (_, i) =>
      makeContentItem({
        url: `https://item${i}.com`,
        title: `Item ${i}`,
        content: 'X'.repeat(3000),
      })
    );

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    const urls = result.sources.map((s) => s.url);
    for (let i = 0; i < 10; i++) {
      expect(urls).toContain(`https://item${i}.com`);
    }
  });

  it('logs batching count for 10 items', async () => {
    const config = makeConfig({ maxContextTokens: 1000 });
    const contents = Array.from({ length: 10 }, (_, i) =>
      makeContentItem({
        url: `https://item${i}.com`,
        content: 'X'.repeat(3000),
      })
    );

    await batchAndMerge('query', contents, undefined, dummyClient, config);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] batching: 10 batches for 10 content items');
  });
});

// ---------------------------------------------------------------------------
// batchAndMerge — degradation result structure
// ---------------------------------------------------------------------------

describe('batchAndMerge — degradation result structure', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockCallLLM.mockReset();
    mockCallLLM.mockRejectedValue(new Error('LLM unavailable'));
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-007]
  it('degradation result has valid DigestResult shape', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result).toHaveProperty('answer');
    expect(result).toHaveProperty('keyPoints');
    expect(result).toHaveProperty('sources');
    expect(typeof result.answer).toBe('string');
    expect(Array.isArray(result.keyPoints)).toBe(true);
    expect(Array.isArray(result.sources)).toBe(true);
  });

  it('degradation answer is non-empty', async () => {
    const config = makeConfig();
    const contents = [makeContentItem({ content: 'Some content.' })];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('degradation answer starts with the prefix', async () => {
    const config = makeConfig();
    const contents = [makeContentItem()];

    const result = await batchAndMerge(
      'query',
      contents,
      undefined,
      dummyClient,
      config
    );

    expect(result.answer).toMatch(
      /^\[Note: LLM synthesis unavailable/
    );
  });
});
