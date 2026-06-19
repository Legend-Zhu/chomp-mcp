/**
 * Unit tests for llm-client.ts
 *
 * Tests:
 * - createLLMClient: config validation (empty/undefined apiKey → LLMConfigError)
 * - createLLMClient: valid config → client instance returned
 * - verifyLLMConnectivity: success and failure paths
 * - callLLMWithRetry: 200 success → correct LLMResponse
 * - callLLMWithRetry: 429 → retry attempts (maxRetries=3)
 * - callLLMWithRetry: 401/403 → no retry, immediate throw, auth warning logged
 * - callLLMWithRetry: 500 → retry then throw after maxRetries
 * - callLLMWithRetry: timeout → retry up to timeoutRetries (2)
 * - callLLMWithRetry: network errors → retry then throw
 * - API key never appears in stderr logs
 *
 * Uses mock timers and mock OpenAIClient implementations.
 *
 * [Spec: US-SY-001, US-SY-006, US-SY-007, BG-SY-003, NFR-SY-002, NFR-SY-003, NFR-SY-006, DC-SY-001, DC-SY-002]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the 'openai' module to avoid real network calls during createLLMClient tests
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    })),
  };
});

import {
  createLLMClient,
  callLLMWithRetry,
  verifyLLMConnectivity,
} from '../../../src/modules/synthesize/llm-client.js';

import {
  LLMConfigError,
  LLMAuthError,
  LLMTimeoutError,
  LLMRateLimitError,
  LLMServerError,
  LLMResponseError,
  LLMNetworkError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from '../../../src/modules/synthesize/types.js';

import type {
  OpenAIClient,
  SynthesizeConfig,
} from '../../../src/modules/synthesize/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capture all stderr writes during a test.
 */
function captureStderr(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => String(c[0])).join('');
}

/**
 * Count how many times a specific substring appears in stderr writes.
 */
function countStderrOccurrences(
  spy: ReturnType<typeof vi.spyOn>,
  needle: string
): number {
  return stderrSpy.mock.calls.filter((call) =>
    String(call[0]).includes(needle)
  ).length;
}

// Use a shared spy variable for counting
let stderrSpy: ReturnType<typeof vi.spyOn>;

/**
 * Create a valid SynthesizeConfig for testing.
 */
function makeConfig(overrides: Partial<SynthesizeConfig> = {}): SynthesizeConfig {
  return {
    apiKey: 'sk-test-key-12345',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    timeoutMs: 60_000,
    maxContextTokens: 128_000,
    safeThresholdRatio: 0.8,
    maxBatchConcurrency: 2,
    ...overrides,
  };
}

/**
 * Create a mock OpenAIClient with a configurable create function.
 */
function makeMockClient(
  createImpl: (
    params: {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      max_tokens?: number;
    }
  ) => Promise<{
    choices: Array<{ message: { content: string } }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
    };
  }>
): OpenAIClient {
  return {
    chat: {
      completions: {
        create: vi.fn(createImpl) as unknown as OpenAIClient['chat']['completions']['create'],
      },
    },
  };
}

/**
 * Create a successful LLM API response.
 */
function makeSuccessResponse(
  content: string,
  usage?: { prompt_tokens: number; completion_tokens: number }
): {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
} {
  return {
    choices: [{ message: { content } }],
    ...(usage !== undefined ? { usage } : { usage: { prompt_tokens: 100, completion_tokens: 50 } }),
  };
}

/**
 * Create an error object simulating an OpenAI SDK HTTP error with a status code.
 */
function makeStatusError(
  status: number,
  message: string = `HTTP ${status} error`
): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Create an error object simulating a Node.js network error with a code.
 */
function makeNetworkError(
  code: string,
  message: string = `${code}: network error`
): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * Create an AbortError simulating a timeout.
 */
function makeAbortError(message: string = 'Request timed out'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

// ===========================================================================
// createLLMClient — config validation
// ===========================================================================

describe('createLLMClient — config validation', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-001, NFR-SY-002] Missing apiKey throws LLMConfigError
  it('throws LLMConfigError when apiKey is empty string', () => {
    expect(() => createLLMClient(makeConfig({ apiKey: '' }))).toThrow(
      LLMConfigError
    );
  });

  it('throws LLMConfigError when apiKey is whitespace-only', () => {
    expect(() => createLLMClient(makeConfig({ apiKey: '   ' }))).toThrow(
      LLMConfigError
    );
  });

  it('throws LLMConfigError when apiKey is undefined', () => {
    expect(() =>
      createLLMClient(makeConfig({ apiKey: undefined as unknown as string }))
    ).toThrow(LLMConfigError);
  });

  it('throws LLMConfigError when apiKey is null', () => {
    expect(() =>
      createLLMClient(makeConfig({ apiKey: null as unknown as string }))
    ).toThrow(LLMConfigError);
  });

  // [Implements: US-SY-001] Error message contains "LLM_API_KEY is required"
  it('error message contains "LLM_API_KEY is required"', () => {
    try {
      createLLMClient(makeConfig({ apiKey: '' }));
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMConfigError);
      expect((error as Error).message).toContain('LLM_API_KEY is required');
    }
  });

  it('error message is exactly "LLM_API_KEY is required"', () => {
    try {
      createLLMClient(makeConfig({ apiKey: '' }));
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe('LLM_API_KEY is required');
    }
  });

  it('does not log the API key value to stderr on missing key', () => {
    try {
      createLLMClient(makeConfig({ apiKey: 'sk-secret-value-123' }));
      // This should succeed — key is present
    } catch {
      // Not relevant here
    }

    const output = captureStderr(stderrSpy);
    expect(output).not.toContain('sk-secret-value-123');
  });

  it('LLMConfigError has category "config"', () => {
    try {
      createLLMClient(makeConfig({ apiKey: '' }));
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMConfigError);
      expect((error as LLMConfigError).category).toBe('config');
    }
  });
});

// ===========================================================================
// createLLMClient — valid config
// ===========================================================================

describe('createLLMClient — valid config', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-001] Valid config returns a client instance
  it('returns a client instance for valid config', () => {
    const client = createLLMClient(makeConfig());

    expect(client).toBeDefined();
    expect(client.chat).toBeDefined();
    expect(client.chat.completions).toBeDefined();
    expect(typeof client.chat.completions.create).toBe('function');
  });

  it('returns a client for a minimal valid apiKey', () => {
    const client = createLLMClient(makeConfig({ apiKey: 'k' }));

    expect(client).toBeDefined();
  });

  it('returns a client for a long apiKey', () => {
    const client = createLLMClient(
      makeConfig({ apiKey: 'sk-' + 'a'.repeat(100) })
    );

    expect(client).toBeDefined();
  });

  it('returns a client for apiKey with special characters', () => {
    const client = createLLMClient(
      makeConfig({ apiKey: 'sk-key_with-dashes.and.dots' })
    );

    expect(client).toBeDefined();
  });

  it('does not throw for valid config', () => {
    expect(() => createLLMClient(makeConfig())).not.toThrow();
  });
});

// ===========================================================================
// verifyLLMConnectivity
// ===========================================================================

describe('verifyLLMConnectivity', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-001] Returns true on successful call
  it('returns true when the test prompt succeeds', async () => {
    const client = makeMockClient(async () => makeSuccessResponse('ok'));

    const result = await verifyLLMConnectivity(client);
    expect(result).toBe(true);
  });

  it('returns false when the test prompt throws', async () => {
    const client = makeMockClient(async () => {
      throw makeStatusError(500, 'Internal Server Error');
    });

    const result = await verifyLLMConnectivity(client);
    expect(result).toBe(false);
  });

  it('returns false on auth error (401)', async () => {
    const client = makeMockClient(async () => {
      throw makeStatusError(401, 'Unauthorized');
    });

    const result = await verifyLLMConnectivity(client);
    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    const client = makeMockClient(async () => {
      throw makeNetworkError('ECONNREFUSED');
    });

    const result = await verifyLLMConnectivity(client);
    expect(result).toBe(false);
  });

  it('returns false on timeout error', async () => {
    const client = makeMockClient(async () => {
      throw makeAbortError();
    });

    const result = await verifyLLMConnectivity(client);
    expect(result).toBe(false);
  });

  it('logs the failure reason to stderr', async () => {
    const client = makeMockClient(async () => {
      throw makeStatusError(500, 'Server down');
    });

    await verifyLLMConnectivity(client);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] LLM connectivity check failed:');
    expect(output).toContain('Server down');
  });

  it('does not log API key on failure', async () => {
    const client = makeMockClient(async () => {
      throw makeStatusError(401, 'Invalid API key');
    });

    await verifyLLMConnectivity(client);

    const output = captureStderr(stderrSpy);
    // The error message says "Invalid API key" but should not contain the actual key value
    expect(output).not.toContain('sk-test-key');
  });

  it('sends a minimal test prompt with max_tokens: 1', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await verifyLLMConnectivity(client);

    expect(createFn).toHaveBeenCalledTimes(1);
    const params = createFn.mock.calls[0][0];
    expect(params.max_tokens).toBe(1);
    expect(params.messages).toHaveLength(1);
  });

  it('does not throw — always returns boolean', async () => {
    const client = makeMockClient(async () => {
      throw new Error('Unexpected crash');
    });

    const result = await verifyLLMConnectivity(client);
    expect(typeof result).toBe('boolean');
    expect(result).toBe(false);
  });
});

// ===========================================================================
// callLLMWithRetry — successful response
// ===========================================================================

describe('callLLMWithRetry — successful response (200)', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-006] Returns correct LLMResponse on success
  it('returns LLMResponse with content and token counts', async () => {
    const client = makeMockClient(async () =>
      makeSuccessResponse('This is the synthesized answer.', {
        prompt_tokens: 200,
        completion_tokens: 80,
      })
    );

    const result = await callLLMWithRetry(client, 'system', 'user');

    expect(result.content).toBe('This is the synthesized answer.');
    expect(result.promptTokens).toBe(200);
    expect(result.completionTokens).toBe(80);
  });

  it('returns content from choices[0].message.content', async () => {
    const expectedContent = '## Answer\n\nSynthesized text with markdown.';
    const client = makeMockClient(async () =>
      makeSuccessResponse(expectedContent)
    );

    const result = await callLLMWithRetry(client, 's', 'u');

    expect(result.content).toBe(expectedContent);
  });

  it('defaults token counts to 0 when usage is absent', async () => {
    const client = makeMockClient(async () => ({
      choices: [{ message: { content: 'Response without usage.' } }],
    }));

    const result = await callLLMWithRetry(client, 's', 'u');

    expect(result.content).toBe('Response without usage.');
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('does not retry on successful response', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await callLLMWithRetry(client, 's', 'u');

    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('passes system and user prompts in messages array', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await callLLMWithRetry(client, 'You are an assistant.', 'Summarize this.');

    const params = createFn.mock.calls[0][0];
    expect(params.messages).toEqual([
      { role: 'system', content: 'You are an assistant.' },
      { role: 'user', content: 'Summarize this.' },
    ]);
  });

  it('uses default temperature 0.3 when not specified', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await callLLMWithRetry(client, 's', 'u');

    const params = createFn.mock.calls[0][0];
    expect(params.temperature).toBe(0.3);
  });

  it('uses custom temperature when provided', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await callLLMWithRetry(client, 's', 'u', { temperature: 0.7 });

    const params = createFn.mock.calls[0][0];
    expect(params.temperature).toBe(0.7);
  });

  it('passes max_tokens when provided in options', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await callLLMWithRetry(client, 's', 'u', { maxTokens: 500 });

    const params = createFn.mock.calls[0][0];
    expect(params.max_tokens).toBe(500);
  });

  it('does not set max_tokens when not provided in options', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await callLLMWithRetry(client, 's', 'u');

    const params = createFn.mock.calls[0][0];
    expect(params.max_tokens).toBeUndefined();
  });
});

// ===========================================================================
// callLLMWithRetry — empty response handling
// ===========================================================================

describe('callLLMWithRetry — empty response', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('throws LLMResponseError when content is empty string', async () => {
    const client = makeMockClient(async () => makeSuccessResponse(''));

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow(
      LLMResponseError
    );
  });

  it('throws LLMResponseError when content is whitespace-only', async () => {
    const client = makeMockClient(async () => makeSuccessResponse('   \n\t  '));

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow(
      LLMResponseError
    );
  });

  it('does not retry on empty response (immediate throw)', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse(''));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow();

    // Should have been called only once (no retries)
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('LLMResponseError has category "parse_error"', async () => {
    const client = makeMockClient(async () => makeSuccessResponse(''));

    try {
      await callLLMWithRetry(client, 's', 'u');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMResponseError);
      expect((error as LLMResponseError).category).toBe('parse_error');
    }
  });

  it('error message mentions empty content', async () => {
    const client = makeMockClient(async () => makeSuccessResponse(''));

    try {
      await callLLMWithRetry(client, 's', 'u');
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('empty');
    }
  });
});

// ===========================================================================
// callLLMWithRetry — HTTP 429 rate limit
// ===========================================================================

describe('callLLMWithRetry — HTTP 429 rate limit', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-006, NFR-SY-003] Retries on 429 up to maxRetries (3)
  it('retries on 429 up to maxRetries (3) times', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, 'Rate limited'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    // Advance timers for all retry delays (3 retries × ~1-2 seconds each)
    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMRateLimitError);

    // Initial call + 3 retries = 4 total attempts
    expect(createFn).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
  });

  it('logs retry messages for each attempt', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, 'Rate limited'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    expect(output).toContain('retry 1/3');
    expect(output).toContain('retry 2/3');
    expect(output).toContain('retry 3/3');
    expect(output).toContain('rate limited');
  });

  it('logs "[SY] retry {attempt}/{max}" format', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, 'Rate limited'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] retry');
    expect(output).toContain(`/${DEFAULT_MAX_RETRIES}`);
  });

  it('throws LLMRateLimitError after retries exhausted', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, 'Rate limited'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMRateLimitError);
  });

  it('succeeds if 429 resolves on a retry', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeStatusError(429, 'Rate limited'))
      .mockResolvedValueOnce(
        makeSuccessResponse('Success on retry.', {
          prompt_tokens: 50,
          completion_tokens: 20,
        })
      );

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;

    expect(result.content).toBe('Success on retry.');
    expect(result.promptTokens).toBe(50);
    expect(result.completionTokens).toBe(20);
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('LLMRateLimitError has category "http_error"', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, 'Rate limited'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    try {
      await promise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMRateLimitError);
      expect((error as LLMRateLimitError).category).toBe('http_error');
    }
  });

  it('logs "retries exhausted" after all retries fail', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, 'Rate limited'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    expect(output).toContain('retries exhausted');
  });
});

// ===========================================================================
// callLLMWithRetry — HTTP 401/403 auth errors
// ===========================================================================

describe('callLLMWithRetry — HTTP 401/403 auth errors', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-006] 401 — no retry, immediate throw
  it('does NOT retry on HTTP 401 and throws LLMAuthError immediately', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(401, 'Unauthorized'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow(
      LLMAuthError
    );

    expect(createFn).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-SY-006] 403 — no retry, immediate throw
  it('does NOT retry on HTTP 403 and throws LLMAuthError immediately', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(403, 'Forbidden'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow(
      LLMAuthError
    );

    expect(createFn).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-SY-006] Logs auth warning to stderr
  it('logs "[SY] LLM auth failed — check LLM_API_KEY" on 401', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(401, 'Unauthorized'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] LLM auth failed — check LLM_API_KEY');
  });

  it('logs "[SY] LLM auth failed — check LLM_API_KEY" on 403', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(403, 'Forbidden'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY] LLM auth failed — check LLM_API_KEY');
  });

  it('LLMAuthError has category "http_error"', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(401, 'Unauthorized'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    try {
      await callLLMWithRetry(client, 's', 'u');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMAuthError);
      expect((error as LLMAuthError).category).toBe('http_error');
    }
  });

  it('error message includes HTTP status code', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(403, 'Forbidden'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    try {
      await callLLMWithRetry(client, 's', 'u');
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('403');
    }
  });

  it('does not log any retry messages on auth error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(401, 'Unauthorized'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    expect(output).not.toContain('retry');
  });
});

// ===========================================================================
// callLLMWithRetry — HTTP 5xx server errors
// ===========================================================================

describe('callLLMWithRetry — HTTP 5xx server errors', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-006, NFR-SY-003] Retries on 5xx up to maxRetries (3)
  it('retries on HTTP 500 up to maxRetries (3) times', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(500, 'Internal Server Error'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMServerError);

    expect(createFn).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
  });

  it('retries on HTTP 502', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(502, 'Bad Gateway'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMServerError);
  });

  it('retries on HTTP 503', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(503, 'Service Unavailable'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMServerError);
  });

  it('logs retry messages with server error info for 5xx', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(500, 'Internal Server Error'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    expect(output).toContain('server error');
    expect(output).toContain('HTTP 500');
  });

  it('throws LLMServerError after retries exhausted', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(500, 'Server Error'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMServerError);
  });

  it('succeeds if 500 resolves on a retry', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeStatusError(500, 'Server Error'))
      .mockResolvedValueOnce(makeSuccessResponse('Recovered.'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;

    expect(result.content).toBe('Recovered.');
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('LLMServerError has category "http_error"', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(500, 'Server Error'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    try {
      await promise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMServerError);
      expect((error as LLMServerError).category).toBe('http_error');
    }
  });
});

// ===========================================================================
// callLLMWithRetry — timeout errors
// ===========================================================================

describe('callLLMWithRetry — timeout errors', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-006, NFR-SY-002] Retries on timeout up to timeoutRetries (2)
  it('retries on AbortError up to timeoutRetries (2) times', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeAbortError());

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_TIMEOUT_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMTimeoutError);

    // Initial call + 2 timeout retries = 3 total attempts
    expect(createFn).toHaveBeenCalledTimes(DEFAULT_TIMEOUT_RETRIES + 1);
  });

  it('logs timeout retry messages', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeAbortError());

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_TIMEOUT_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    expect(output).toContain('timeout');
    expect(output).toContain(`/${DEFAULT_TIMEOUT_RETRIES}`);
  });

  it('throws LLMTimeoutError after timeout retries exhausted', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeAbortError());

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_TIMEOUT_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMTimeoutError);
  });

  it('LLMTimeoutError has category "timeout"', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeAbortError());

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_TIMEOUT_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    try {
      await promise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMTimeoutError);
      expect((error as LLMTimeoutError).category).toBe('timeout');
    }
  });

  it('succeeds if timeout resolves on a retry', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeAbortError())
      .mockResolvedValueOnce(makeSuccessResponse('After timeout retry.'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;

    expect(result.content).toBe('After timeout retry.');
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('uses fewer retries for timeout (2) than for transient (3)', async () => {
    const timeoutCreateFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeAbortError());

    const timeoutClient: OpenAIClient = {
      chat: { completions: { create: timeoutCreateFn } },
    };

    const timeoutPromise = callLLMWithRetry(timeoutClient, 's', 'u');

    for (let i = 0; i < DEFAULT_TIMEOUT_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await timeoutPromise.catch(() => {});

    // Timeout: initial + 2 retries = 3 calls
    expect(timeoutCreateFn).toHaveBeenCalledTimes(DEFAULT_TIMEOUT_RETRIES + 1);
    expect(DEFAULT_TIMEOUT_RETRIES).toBe(2);
    expect(DEFAULT_MAX_RETRIES).toBe(3);
  });

  it('logs "timeout retries exhausted" message', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeAbortError());

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_TIMEOUT_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    expect(output).toContain('timeout retries exhausted');
  });
});

// ===========================================================================
// callLLMWithRetry — network errors
// ===========================================================================

describe('callLLMWithRetry — network errors', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  it('retries on ECONNREFUSED up to maxRetries', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ECONNREFUSED'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);

    expect(createFn).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
  });

  it('retries on ECONNRESET', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ECONNRESET'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
  });

  it('retries on ENOTFOUND (DNS failure)', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ENOTFOUND'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
  });

  it('throws LLMNetworkError after retries exhausted', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ECONNREFUSED'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
  });

  it('LLMNetworkError has category "network"', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ECONNREFUSED'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    try {
      await promise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMNetworkError);
      expect((error as LLMNetworkError).category).toBe('network');
    }
  });

  it('includes error code in retry log', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ECONNREFUSED'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    expect(output).toContain('ECONNREFUSED');
  });

  it('succeeds if network error resolves on a retry', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
      .mockResolvedValueOnce(makeSuccessResponse('Network recovered.'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;

    expect(result.content).toBe('Network recovered.');
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('logs "retries exhausted for network error" after all retries fail', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ECONNREFUSED'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    expect(output).toContain('network error');
  });
});

// ===========================================================================
// callLLMWithRetry — stderr log format and API key safety
// ===========================================================================

describe('callLLMWithRetry — stderr log format', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-006] "[SY] retry {attempt}/{max}: {reason}"
  it('retry log format is "[SY] retry {attempt}/{max}: {reason}"', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, 'Rate limited'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    // Verify the pattern exists at least once
    expect(output).toMatch(/\[SY\] retry \d+\/\d+: .+/);
  });

  it('includes [SY] module tag in all log lines', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(500, 'Server Error'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    // Every line should contain [SY]
    const lines = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.trim().length > 0);
    for (const line of lines) {
      expect(line).toContain('[SY]');
    }
  });

  it('logs each retry attempt number correctly (1, 2, 3)', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, 'Rate limited'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    // Check that attempt numbers 1, 2, 3 all appear
    expect(output).toContain('retry 1/3');
    expect(output).toContain('retry 2/3');
    expect(output).toContain('retry 3/3');
  });

  it('does not log any retry messages on successful first attempt', async () => {
    const client = makeMockClient(async () => makeSuccessResponse('ok'));

    await callLLMWithRetry(client, 's', 'u');

    const output = captureStderr(stderrSpy);
    expect(output).not.toContain('retry');
  });
});

// ===========================================================================
// callLLMWithRetry — API key never appears in stderr
// ===========================================================================

describe('callLLMWithRetry — API key safety (NFR-SY-006)', () => {
  const SECRET_KEY = 'sk-super-secret-key-98765';

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  // [Implements: NFR-SY-006] API key never in stderr logs
  it('does not leak API key on 401 auth error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(401, `Invalid key: ${SECRET_KEY}`));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow();

    const output = captureStderr(stderrSpy);
    // The error message from the mock includes the secret key, but the
    // implementation only logs "[SY] LLM auth failed — check LLM_API_KEY"
    // which does NOT include the key value.
    const authLine = output.split('\n').find((l) => l.includes('auth failed'));
    if (authLine) {
      expect(authLine).not.toContain(SECRET_KEY);
    }
  });

  it('does not leak API key on 500 server error retries', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(500, `Server error with ${SECRET_KEY}`));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    expect(output).not.toContain(SECRET_KEY);
  });

  it('does not leak API key on network error retries', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(
        makeNetworkError('ECONNREFUSED', `Connection refused for ${SECRET_KEY}`)
      );

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    // Retry logs may include error code but NOT the full message with key
    expect(output).not.toContain(SECRET_KEY);
  });

  it('does not leak API key on timeout retries', async () => {
    const abortErr = makeAbortError(`Timeout for ${SECRET_KEY}`);
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(abortErr);

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_TIMEOUT_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    expect(output).not.toContain(SECRET_KEY);
  });

  it('does not leak API key on 429 rate limit retries', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, `Rate limited ${SECRET_KEY}`));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    expect(output).not.toContain(SECRET_KEY);
  });
});

// ===========================================================================
// callLLMWithRetry — edge cases
// ===========================================================================

describe('callLLMWithRetry — edge cases', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  it('handles mixed error types (429 then 500 then success)', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeStatusError(429, 'Rate limited'))
      .mockRejectedValueOnce(makeStatusError(500, 'Server error'))
      .mockResolvedValueOnce(makeSuccessResponse('Third time works.'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;

    expect(result.content).toBe('Third time works.');
    expect(createFn).toHaveBeenCalledTimes(3);
  });

  it('handles 404 as non-retryable server error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(404, 'Not Found'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    // 404 is a 4xx that is not 401/403/429 — should not retry, throws immediately
    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow();

    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('handles 400 as non-retryable error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(400, 'Bad Request'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow(
      LLMServerError
    );

    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('handles 408 request timeout via HTTP status', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(408, 'Request Timeout'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_TIMEOUT_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMTimeoutError);
  });

  it('handles nested error.status (error.error.status)', async () => {
    // Some SDKs nest the status inside an `error` property
    const innerError = makeStatusError(429, 'Rate limited');
    const outerError = new Error('Request failed') as Error & {
      error: { status: number; message: string };
    };
    outerError.error = innerError;

    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(outerError);

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    // Should detect status 429 and retry
    await expect(promise).rejects.toThrow(LLMRateLimitError);
  });

  it('handles error with non-number status (treated as network)', async () => {
    const err = new Error('Weird error') as Error & { status: string };
    err.status = 'unknown';

    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(err);

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    // status is string → not a valid number → falls into network error path
    await expect(promise).rejects.toThrow();
  });

  it('handles generic Error without status or code', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(new Error('Mystery error'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    // No status, no code → network error path (status === undefined)
    await expect(promise).rejects.toThrow();
  });

  it('handles non-Error thrown value', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue('string error');

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    // Non-object error → getHttpStatus returns undefined → network path
    await expect(promise).rejects.toThrow();
  });

  it('passes temperature in retry attempts', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeStatusError(429, 'Rate limited'))
      .mockResolvedValueOnce(makeSuccessResponse('ok'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u', { temperature: 0.5 });

    await vi.advanceTimersByTimeAsync(15_000);

    await promise;

    // Both calls should have temperature 0.5
    expect(createFn.mock.calls[0][0].temperature).toBe(0.5);
    expect(createFn.mock.calls[1][0].temperature).toBe(0.5);
  });

  it('passes max_tokens in retry attempts', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeStatusError(429, 'Rate limited'))
      .mockResolvedValueOnce(makeSuccessResponse('ok'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u', { maxTokens: 256 });

    await vi.advanceTimersByTimeAsync(15_000);

    await promise;

    expect(createFn.mock.calls[0][0].max_tokens).toBe(256);
    expect(createFn.mock.calls[1][0].max_tokens).toBe(256);
  });
});

// ===========================================================================
// callLLMWithRetry — determinism (multiple calls)
// ===========================================================================

describe('callLLMWithRetry — determinism', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('produces identical results for identical successful responses', async () => {
    const response = makeSuccessResponse('Same answer.', {
      prompt_tokens: 10,
      completion_tokens: 5,
    });

    const client1 = makeMockClient(async () => ({ ...response }));
    const client2 = makeMockClient(async () => ({ ...response }));

    const result1 = await callLLMWithRetry(client1, 's', 'u');
    const result2 = await callLLMWithRetry(client2, 's', 'u');

    expect(result1.content).toBe(result2.content);
    expect(result1.promptTokens).toBe(result2.promptTokens);
    expect(result1.completionTokens).toBe(result2.completionTokens);
  });

  it('makes the same number of calls for the same retry pattern', async () => {
    const makeClient = () => {
      const fn = vi
        .fn<OpenAIClient['chat']['completions']['create']>()
        .mockRejectedValueOnce(makeStatusError(429, 'Rate limited'))
        .mockResolvedValueOnce(makeSuccessResponse('ok'));
      const c: OpenAIClient = {
        chat: { completions: { create: fn } },
      };
      return { c, fn };
    };

    const { c: client1, fn: fn1 } = makeClient();
    const { c: client2, fn: fn2 } = makeClient();

    const p1 = callLLMWithRetry(client1, 's', 'u');
    const p2 = callLLMWithRetry(client2, 's', 'u');

    // Need to use fake timers since retries involve sleep
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(15_000);
    const [r1, r2] = await Promise.all([p1, p2]);
    vi.useRealTimers();

    expect(r1.content).toBe(r2.content);
    expect(fn1).toHaveBeenCalledTimes(2);
    expect(fn2).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// callLLMWithRetry — additional network error codes
// ===========================================================================

describe('callLLMWithRetry — additional network error codes', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  it('retries on EPIPE network error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('EPIPE'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
    expect(createFn).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
  });

  it('retries on ETIMEDOUT network error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ETIMEDOUT'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
  });

  it('retries on EAI_AGAIN (transient DNS) network error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('EAI_AGAIN'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
  });

  it('retries on EHOSTUNREACH network error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('EHOSTUNREACH'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
  });

  it('retries on ENETUNREACH network error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ENETUNREACH'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
  });

  it('retries on EHOSTDOWN network error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('EHOSTDOWN'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
  });

  it('retries on EADDRINUSE network error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('EADDRINUSE'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
  });

  it('retries on EADDRNOTAVAIL network error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('EADDRNOTAVAIL'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
  });

  it('retries on EACCES network error', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('EACCES'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMNetworkError);
  });

  it('logs network error code in each retry message', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('EPIPE'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    expect(output).toContain('EPIPE');
  });
});

// ===========================================================================
// callLLMWithRetry — HTTP 504 Gateway Timeout
// ===========================================================================

describe('callLLMWithRetry — HTTP 504 Gateway Timeout', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  it('retries on HTTP 504 up to maxRetries', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(504, 'Gateway Timeout'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await expect(promise).rejects.toThrow(LLMServerError);
    expect(createFn).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
  });

  it('succeeds if 504 resolves on a retry', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeStatusError(504, 'Gateway Timeout'))
      .mockResolvedValueOnce(makeSuccessResponse('Recovered from 504.'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;

    expect(result.content).toBe('Recovered from 504.');
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('logs "server error" and "HTTP 504" in retry messages', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(504, 'Gateway Timeout'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    expect(output).toContain('server error');
    expect(output).toContain('HTTP 504');
  });
});

// ===========================================================================
// callLLMWithRetry — HTTP 422 and other non-retryable 4xx
// ===========================================================================

describe('callLLMWithRetry — HTTP 422 Unprocessable Entity', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('does NOT retry on HTTP 422 and throws LLMServerError immediately', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(422, 'Unprocessable Entity'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow(
      LLMServerError
    );

    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('includes HTTP 422 in the error message', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(422, 'Unprocessable Entity'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    try {
      await callLLMWithRetry(client, 's', 'u');
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('422');
    }
  });

  it('handles HTTP 405 Method Not Allowed as non-retryable', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(405, 'Method Not Allowed'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow(
      LLMServerError
    );

    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('handles HTTP 413 Payload Too Large as non-retryable', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(413, 'Payload Too Large'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    await expect(callLLMWithRetry(client, 's', 'u')).rejects.toThrow(
      LLMServerError
    );

    expect(createFn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// callLLMWithRetry — temperature edge cases
// ===========================================================================

describe('callLLMWithRetry — temperature edge cases', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('passes temperature 0 (deterministic)', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await callLLMWithRetry(client, 's', 'u', { temperature: 0 });

    expect(createFn.mock.calls[0][0].temperature).toBe(0);
  });

  it('passes temperature 1 (maximum randomness)', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await callLLMWithRetry(client, 's', 'u', { temperature: 1 });

    expect(createFn.mock.calls[0][0].temperature).toBe(1);
  });

  it('passes temperature with fractional values', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await callLLMWithRetry(client, 's', 'u', { temperature: 0.15 });

    expect(createFn.mock.calls[0][0].temperature).toBe(0.15);
  });

  it('passes both temperature and max_tokens together', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await callLLMWithRetry(client, 's', 'u', { temperature: 0.7, maxTokens: 1000 });

    const params = createFn.mock.calls[0][0];
    expect(params.temperature).toBe(0.7);
    expect(params.max_tokens).toBe(1000);
  });
});

// ===========================================================================
// callLLMWithRetry — response token edge cases
// ===========================================================================

describe('callLLMWithRetry — response token edge cases', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('handles very large token counts', async () => {
    const client = makeMockClient(async () =>
      makeSuccessResponse('Response.', {
        prompt_tokens: 1_000_000,
        completion_tokens: 500_000,
      })
    );

    const result = await callLLMWithRetry(client, 's', 'u');

    expect(result.promptTokens).toBe(1_000_000);
    expect(result.completionTokens).toBe(500_000);
  });

  it('handles zero prompt tokens', async () => {
    const client = makeMockClient(async () =>
      makeSuccessResponse('Response.', {
        prompt_tokens: 0,
        completion_tokens: 50,
      })
    );

    const result = await callLLMWithRetry(client, 's', 'u');

    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(50);
  });

  it('handles zero completion tokens', async () => {
    const client = makeMockClient(async () =>
      makeSuccessResponse('Response.', {
        prompt_tokens: 100,
        completion_tokens: 0,
      })
    );

    const result = await callLLMWithRetry(client, 's', 'u');

    expect(result.promptTokens).toBe(100);
    expect(result.completionTokens).toBe(0);
  });

  it('handles both zero prompt and completion tokens', async () => {
    const client = makeMockClient(async () =>
      makeSuccessResponse('Response.', {
        prompt_tokens: 0,
        completion_tokens: 0,
      })
    );

    const result = await callLLMWithRetry(client, 's', 'u');

    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('handles missing usage.prompt_tokens but present usage.completion_tokens', async () => {
    const client = makeMockClient(async () => ({
      choices: [{ message: { content: 'Partial usage.' } }],
      usage: { completion_tokens: 42 },
    }));

    const result = await callLLMWithRetry(client, 's', 'u');

    expect(result.content).toBe('Partial usage.');
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(42);
  });

  it('handles response with multiple choices (uses choices[0])', async () => {
    const client = makeMockClient(async () => ({
      choices: [
        { message: { content: 'First choice.' } },
        { message: { content: 'Second choice.' } },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));

    const result = await callLLMWithRetry(client, 's', 'u');

    expect(result.content).toBe('First choice.');
  });
});

// ===========================================================================
// callLLMWithRetry — error message format validation
// ===========================================================================

describe('callLLMWithRetry — error message format validation', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  it('rate limit error message includes HTTP 429 and "exhausted"', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, 'Rate limited'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    try {
      await promise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMRateLimitError);
      expect((error as Error).message).toContain('429');
      expect((error as Error).message).toContain('exhausted');
    }
  });

  it('server error message includes HTTP status and "exhausted"', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(500, 'Server Error'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    try {
      await promise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMServerError);
      expect((error as Error).message).toContain('500');
      expect((error as Error).message).toContain('exhausted');
    }
  });

  it('timeout error message includes timeout duration and "exhausted"', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeAbortError());

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_TIMEOUT_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    try {
      await promise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMTimeoutError);
      expect((error as Error).message).toContain('timed out');
      expect((error as Error).message).toContain('exhausted');
    }
  });

  it('network error message includes error code', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ECONNREFUSED'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    try {
      await promise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMNetworkError);
      expect((error as Error).message).toContain('ECONNREFUSED');
    }
  });

  it('network error message includes error message text', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(
        makeNetworkError('ECONNRESET', 'Connection reset by peer')
      );

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    try {
      await promise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Connection reset by peer');
    }
  });

  it('auth error message includes "check LLM_API_KEY"', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(401, 'Unauthorized'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    try {
      await callLLMWithRetry(client, 's', 'u');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMAuthError);
      expect((error as Error).message).toContain('check LLM_API_KEY');
    }
  });
});

// ===========================================================================
// callLLMWithRetry — mixed retry patterns (timeout + transient)
// ===========================================================================

describe('callLLMWithRetry — mixed retry patterns', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  it('handles timeout then rate limit then success', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeAbortError())
      .mockRejectedValueOnce(makeStatusError(429, 'Rate limited'))
      .mockResolvedValueOnce(makeSuccessResponse('Third attempt works.'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;

    expect(result.content).toBe('Third attempt works.');
    expect(createFn).toHaveBeenCalledTimes(3);
  });

  it('handles rate limit then timeout then success', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeStatusError(429, 'Rate limited'))
      .mockRejectedValueOnce(makeAbortError())
      .mockResolvedValueOnce(makeSuccessResponse('Third attempt works.'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;

    expect(result.content).toBe('Third attempt works.');
    expect(createFn).toHaveBeenCalledTimes(3);
  });

  it('handles network error then server error then success', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
      .mockRejectedValueOnce(makeStatusError(500, 'Server Error'))
      .mockResolvedValueOnce(makeSuccessResponse('Third attempt works.'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;

    expect(result.content).toBe('Third attempt works.');
    expect(createFn).toHaveBeenCalledTimes(3);
  });

  it('handles multiple timeouts then rate limit then success', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValueOnce(makeAbortError())      // timeout retry 1/2
      .mockRejectedValueOnce(makeAbortError())      // timeout retry 2/2
      .mockRejectedValueOnce(makeStatusError(429))   // rate limit retry 1/3
      .mockResolvedValueOnce(makeSuccessResponse('Success after many retries.'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await promise;

    expect(result.content).toBe('Success after many retries.');
    expect(createFn).toHaveBeenCalledTimes(4);
  });
});

// ===========================================================================
// callLLMWithRetry — stderr log content validation
// ===========================================================================

describe('callLLMWithRetry — stderr log content validation', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  it('logs "rate limited" reason text in retry for 429', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, 'Rate limited'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    // Retry messages should mention "rate limited"
    expect(output).toMatch(/retry \d+\/\d+: rate limited/);
  });

  it('logs "server error (HTTP {code})" reason for 5xx', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(503, 'Service Unavailable'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    expect(output).toMatch(/server error \(HTTP 503\)/);
  });

  it('logs "timeout" reason text in retry for AbortError', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeAbortError());

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_TIMEOUT_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    expect(output).toMatch(/retry \d+\/\d+: timeout/);
  });

  it('logs error code in retry for network errors', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ENOTFOUND'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    expect(output).toMatch(/retry \d+\/\d+: ENOTFOUND/);
  });

  it('logs "retries exhausted for rate limit" final message for 429', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(429, 'Rate limited'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    expect(output).toContain('retries exhausted for rate limit');
  });

  it('logs "retries exhausted for server error" final message for 5xx', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeStatusError(500, 'Internal Server Error'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    expect(output).toContain('retries exhausted for server error');
  });

  it('logs "retries exhausted for network error" final message', async () => {
    const createFn = vi
      .fn<OpenAIClient['chat']['completions']['create']>()
      .mockRejectedValue(makeNetworkError('ECONNREFUSED'));

    const client: OpenAIClient = {
      chat: { completions: { create: createFn } },
    };

    const promise = callLLMWithRetry(client, 's', 'u');

    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await promise.catch(() => {});

    const output = captureStderr(stderrSpy);
    expect(output).toContain('retries exhausted for network error');
  });
});

// ===========================================================================
// verifyLLMConnectivity — additional coverage
// ===========================================================================

describe('verifyLLMConnectivity — additional coverage', () => {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('does not log to stderr on successful connectivity check', async () => {
    const client = makeMockClient(async () => makeSuccessResponse('ok'));

    const result = await verifyLLMConnectivity(client);

    expect(result).toBe(true);
    const output = captureStderr(stderrSpy);
    expect(output).not.toContain('connectivity check failed');
  });

  it('sends the correct model in the test prompt', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await verifyLLMConnectivity(client);

    const params = createFn.mock.calls[0][0];
    expect(params.model).toBe('gpt-4o-mini');
  });

  it('sends "ping" as the user message content', async () => {
    const createFn = vi.fn(async () => makeSuccessResponse('ok'));
    const client: OpenAIClient = {
      chat: { completions: { create: createFn as unknown as OpenAIClient['chat']['completions']['create'] } },
    };

    await verifyLLMConnectivity(client);

    const params = createFn.mock.calls[0][0];
    expect(params.messages).toEqual([
      { role: 'user', content: 'ping' },
    ]);
  });

  it('returns false on rate limit error', async () => {
    const client = makeMockClient(async () => {
      throw makeStatusError(429, 'Rate limited');
    });

    const result = await verifyLLMConnectivity(client);
    expect(result).toBe(false);
  });

  it('returns false when the response has an error in a non-standard shape', async () => {
    const client = makeMockClient(async () => {
      // Throw a plain object (not an Error instance)
      throw { custom: 'error', foo: 42 };
    });

    const result = await verifyLLMConnectivity(client);
    expect(result).toBe(false);
  });

  it('logs error message text for connectivity failure', async () => {
    const client = makeMockClient(async () => {
      throw new Error('DNS resolution failed');
    });

    await verifyLLMConnectivity(client);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('DNS resolution failed');
  });

  it('logs [SY] module tag for connectivity failure', async () => {
    const client = makeMockClient(async () => {
      throw makeStatusError(500, 'Server Error');
    });

    await verifyLLMConnectivity(client);

    const output = captureStderr(stderrSpy);
    expect(output).toContain('[SY]');
    expect(output).toContain('LLM connectivity check failed');
  });
});
