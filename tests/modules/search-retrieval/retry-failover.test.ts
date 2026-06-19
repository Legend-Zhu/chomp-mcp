/**
 * Unit tests for the retry-failover orchestrator (retry-failover.ts).
 *
 * Verifies:
 *   - validateQuery: valid/invalid queries, length limits
 *   - resolveConfig: env var resolution, defaults, invalid values
 *   - computeBackoffDelay: exponential backoff, jitter range, Retry-After honoring
 *   - executeWithRetryFailover: success on first attempt, retry on timeout/5xx/429,
 *     failover across instances, 30s ceiling, structured logging, error classification
 *   - search: end-to-end entry point with query validation and config resolution
 *
 * [Spec: US-SR-001, US-SR-003, US-SR-005, US-SR-006, US-SR-010, US-SR-011, BG-SR-001, NFR-SR-001, NFR-SR-005]
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateQuery,
  resolveConfig,
  computeBackoffDelay,
  executeWithRetryFailover,
  search,
  MAX_QUERY_LENGTH,
  OVERALL_CEILING_MS,
  JITTER_FACTOR,
  MAX_RETRY_AFTER_MS,
} from '../../../src/modules/search-retrieval/retry-failover.js';
import {
  ValidationError,
  SearchFailedError,
  SearchUnavailableError,
  SearchTimeoutError,
  SearchError,
  SearchParseError,
} from '../../../src/modules/search-retrieval/errors.js';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_MAX_RESULTS,
  DEFAULT_TIMEOUT_MS,
  type SearchConfig,
} from '../../../src/modules/search-retrieval/searxng-client.js';
import type { InstancePool } from '../../../src/modules/search-retrieval/instance-pool.js';
import type { SearXNGFetchResult } from '../../../src/modules/search-retrieval/response-parser.js';
import type { ParsedResult, ParseOutput } from '../../../src/modules/search-retrieval/result-normalizer.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be at top level for vi.mock factory
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    fetchSearXNG: vi.fn(),
    parseResponse: vi.fn(),
    normalizeResults: vi.fn(),
  };
});

vi.mock('../../../src/modules/search-retrieval/searxng-client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/modules/search-retrieval/searxng-client.js')>();
  return {
    ...mod,
    fetchSearXNG: mocks.fetchSearXNG,
  };
});

vi.mock('../../../src/modules/search-retrieval/response-parser.js', () => ({
  parseResponse: mocks.parseResponse,
}));

vi.mock('../../../src/modules/search-retrieval/result-normalizer.js', () => ({
  normalizeResults: mocks.normalizeResults,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'SEARXNG_MAX_RETRIES',
  'SEARXNG_RETRY_BASE_MS',
  'SEARXNG_TIMEOUT_MS',
  'SEARXNG_URL',
  'MAX_RESULTS',
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
  vi.restoreAllMocks();
});

function makeConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    retryBaseMs: DEFAULT_RETRY_BASE_MS,
    maxResults: DEFAULT_MAX_RESULTS,
    ...overrides,
  };
}

function makePool(overrides: Partial<InstancePool> = {}): InstancePool {
  return {
    mode: 'public',
    instances: ['https://a.example', 'https://b.example', 'https://c.example'],
    cursor: 0,
    ...overrides,
  };
}

function makeFetchResult(overrides: Partial<SearXNGFetchResult> = {}): SearXNGFetchResult {
  return {
    status: 200,
    body: JSON.stringify({ results: [] }),
    contentType: 'application/json',
    retryAfterMs: null,
    ...overrides,
  };
}

function makeParseOutput(results: ParsedResult[] = []): ParseOutput {
  return { results, skippedMalformed: 0 };
}

function makeParsedResult(overrides: Partial<ParsedResult> = {}): ParsedResult {
  return {
    title: 'Test',
    url: 'https://example.com',
    content: 'Snippet',
    score: 1.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateQuery
// ---------------------------------------------------------------------------

describe('validateQuery', () => {
  // [Implements: US-SR-001]
  it('accepts a valid non-empty string', () => {
    expect(() => validateQuery('hello world')).not.toThrow();
  });

  it('accepts a single character query', () => {
    expect(() => validateQuery('a')).not.toThrow();
  });

  it('accepts a query with exactly 500 characters', () => {
    expect(() => validateQuery('a'.repeat(500))).not.toThrow();
  });

  it('throws ValidationError for an empty string', () => {
    expect(() => validateQuery('')).toThrow(ValidationError);
  });

  it('throws ValidationError for a whitespace-only string', () => {
    expect(() => validateQuery('   ')).toThrow(ValidationError);
  });

  it('throws ValidationError for a tab-only string', () => {
    expect(() => validateQuery('\t')).toThrow(ValidationError);
  });

  it('throws ValidationError for null', () => {
    expect(() => validateQuery(null)).toThrow(ValidationError);
  });

  it('throws ValidationError for undefined', () => {
    expect(() => validateQuery(undefined)).toThrow(ValidationError);
  });

  it('throws ValidationError for a number', () => {
    expect(() => validateQuery(42)).toThrow(ValidationError);
  });

  it('throws ValidationError for a boolean', () => {
    expect(() => validateQuery(true)).toThrow(ValidationError);
  });

  it('throws ValidationError for an object', () => {
    expect(() => validateQuery({})).toThrow(ValidationError);
  });

  it('throws ValidationError for a query exceeding 500 characters', () => {
    expect(() => validateQuery('a'.repeat(501))).toThrow(ValidationError);
  });

  it('throws ValidationError with message "Query must be a non-empty string" for empty', () => {
    expect(() => validateQuery('')).toThrow('Query must be a non-empty string');
  });

  it('throws ValidationError with message "Query must not exceed 500 characters" for too long', () => {
    expect(() => validateQuery('a'.repeat(501))).toThrow(
      'Query must not exceed 500 characters'
    );
  });

  it('accepts a query with special characters', () => {
    expect(() => validateQuery('hello & world? <script>')).not.toThrow();
  });

  it('accepts a query with Unicode characters', () => {
    expect(() => validateQuery('café résumé 日本語')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

describe('resolveConfig', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  // [Implements: US-SR-005, US-SR-011]
  it('returns default config when no options and no env vars', () => {
    const config = resolveConfig();
    expect(config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(config.retryBaseMs).toBe(DEFAULT_RETRY_BASE_MS);
    expect(config.maxResults).toBe(DEFAULT_MAX_RESULTS);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('returns default config when options is null', () => {
    const config = resolveConfig(null);
    expect(config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(config.maxResults).toBe(DEFAULT_MAX_RESULTS);
  });

  it('returns default config when options is undefined', () => {
    const config = resolveConfig(undefined);
    expect(config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
  });

  // [Implements: US-SR-005] SEARXNG_MAX_RETRIES env var
  it('reads maxRetries from SEARXNG_MAX_RETRIES env var', () => {
    process.env['SEARXNG_MAX_RETRIES'] = '5';
    const config = resolveConfig();
    expect(config.maxRetries).toBe(5);
  });

  it('reads maxRetries from SEARXNG_MAX_RETRIES with whitespace', () => {
    process.env['SEARXNG_MAX_RETRIES'] = '  3  ';
    const config = resolveConfig();
    expect(config.maxRetries).toBe(3);
  });

  it('accepts maxRetries of 0 from env', () => {
    process.env['SEARXNG_MAX_RETRIES'] = '0';
    const config = resolveConfig();
    expect(config.maxRetries).toBe(0);
  });

  it('falls back to default for invalid SEARXNG_MAX_RETRIES (non-numeric)', () => {
    process.env['SEARXNG_MAX_RETRIES'] = 'abc';
    const config = resolveConfig();
    expect(config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid SEARXNG_MAX_RETRIES')
    );
  });

  it('falls back to default for invalid SEARXNG_MAX_RETRIES (negative)', () => {
    process.env['SEARXNG_MAX_RETRIES'] = '-1';
    const config = resolveConfig();
    expect(config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid SEARXNG_MAX_RETRIES')
    );
  });

  it('falls back to default for invalid SEARXNG_MAX_RETRIES (float)', () => {
    process.env['SEARXNG_MAX_RETRIES'] = '2.5';
    const config = resolveConfig();
    expect(config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid SEARXNG_MAX_RETRIES')
    );
  });

  // [Implements: US-SR-005] SEARXNG_RETRY_BASE_MS env var
  it('reads retryBaseMs from SEARXNG_RETRY_BASE_MS env var', () => {
    process.env['SEARXNG_RETRY_BASE_MS'] = '1000';
    const config = resolveConfig();
    expect(config.retryBaseMs).toBe(1000);
  });

  it('reads retryBaseMs from SEARXNG_RETRY_BASE_MS with whitespace', () => {
    process.env['SEARXNG_RETRY_BASE_MS'] = '  750  ';
    const config = resolveConfig();
    expect(config.retryBaseMs).toBe(750);
  });

  it('falls back to default for invalid SEARXNG_RETRY_BASE_MS (non-numeric)', () => {
    process.env['SEARXNG_RETRY_BASE_MS'] = 'abc';
    const config = resolveConfig();
    expect(config.retryBaseMs).toBe(DEFAULT_RETRY_BASE_MS);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid SEARXNG_RETRY_BASE_MS')
    );
  });

  it('falls back to default for invalid SEARXNG_RETRY_BASE_MS (zero)', () => {
    process.env['SEARXNG_RETRY_BASE_MS'] = '0';
    const config = resolveConfig();
    expect(config.retryBaseMs).toBe(DEFAULT_RETRY_BASE_MS);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid SEARXNG_RETRY_BASE_MS')
    );
  });

  it('falls back to default for invalid SEARXNG_RETRY_BASE_MS (negative)', () => {
    process.env['SEARXNG_RETRY_BASE_MS'] = '-100';
    const config = resolveConfig();
    expect(config.retryBaseMs).toBe(DEFAULT_RETRY_BASE_MS);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid SEARXNG_RETRY_BASE_MS')
    );
  });

  // [Implements: US-SR-011] maxResults from options
  it('reads maxResults from options.maxResults', () => {
    const config = resolveConfig({ maxResults: 20 });
    expect(config.maxResults).toBe(20);
  });

  it('falls back to default for invalid maxResults (zero)', () => {
    const config = resolveConfig({ maxResults: 0 });
    expect(config.maxResults).toBe(DEFAULT_MAX_RESULTS);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid maxResults')
    );
  });

  it('falls back to default for invalid maxResults (negative)', () => {
    const config = resolveConfig({ maxResults: -5 });
    expect(config.maxResults).toBe(DEFAULT_MAX_RESULTS);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid maxResults')
    );
  });

  it('falls back to default for invalid maxResults (float)', () => {
    const config = resolveConfig({ maxResults: 5.5 });
    expect(config.maxResults).toBe(DEFAULT_MAX_RESULTS);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid maxResults')
    );
  });

  // [Implements: US-SR-004] timeoutMs from options
  it('reads timeoutMs from options.timeoutMs', () => {
    const config = resolveConfig({ timeoutMs: 5000 });
    expect(config.timeoutMs).toBe(5000);
  });

  // categories
  it('passes categories from options', () => {
    const config = resolveConfig({ categories: 'it' });
    expect(config.categories).toBe('it');
  });

  it('returns undefined categories when not provided', () => {
    const config = resolveConfig();
    expect(config.categories).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeBackoffDelay
// ---------------------------------------------------------------------------

describe('computeBackoffDelay', () => {
  // [Implements: US-SR-005] Exponential backoff
  it('computes base * 2^0 for attemptIndex 0 (with jitter)', () => {
    const delay = computeBackoffDelay(0, 500);
    expect(delay).toBeGreaterThanOrEqual(400);
    expect(delay).toBeLessThanOrEqual(600);
  });

  it('computes base * 2^1 for attemptIndex 1 (with jitter)', () => {
    const delay = computeBackoffDelay(1, 500);
    expect(delay).toBeGreaterThanOrEqual(800);
    expect(delay).toBeLessThanOrEqual(1200);
  });

  it('computes base * 2^2 for attemptIndex 2 (with jitter)', () => {
    const delay = computeBackoffDelay(2, 500);
    expect(delay).toBeGreaterThanOrEqual(1600);
    expect(delay).toBeLessThanOrEqual(2400);
  });

  it('computes base * 2^3 for attemptIndex 3 (with jitter)', () => {
    const delay = computeBackoffDelay(3, 500);
    expect(delay).toBeGreaterThanOrEqual(3200);
    expect(delay).toBeLessThanOrEqual(4800);
  });

  it('uses a custom base delay', () => {
    const delay = computeBackoffDelay(0, 1000);
    expect(delay).toBeGreaterThanOrEqual(800);
    expect(delay).toBeLessThanOrEqual(1200);
  });

  // [Implements: US-SR-005] Jitter ±20%
  it('produces values within ±20% of the base delay across multiple calls', () => {
    const base = 500;
    const attemptIndex = 0;
    const expectedBase = base * Math.pow(2, attemptIndex);
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelay(attemptIndex, base);
      expect(delay).toBeGreaterThanOrEqual(Math.round(expectedBase * 0.8));
      expect(delay).toBeLessThanOrEqual(Math.round(expectedBase * 1.2));
    }
  });

  it('returns an integer (rounded)', () => {
    const delay = computeBackoffDelay(0, 500);
    expect(Number.isInteger(delay)).toBe(true);
  });

  // [Implements: US-SR-005] Retry-After honoring
  it('honors retryAfterMs when provided', () => {
    const delay = computeBackoffDelay(0, 500, 3000);
    expect(delay).toBe(3000);
  });

  it('honors retryAfterMs of 0', () => {
    const delay = computeBackoffDelay(0, 500, 0);
    expect(delay).toBe(0);
  });

  it('caps retryAfterMs at 10000ms', () => {
    const delay = computeBackoffDelay(0, 500, 60000);
    expect(delay).toBe(10000);
  });

  it('caps retryAfterMs at 10000ms for very large values', () => {
    const delay = computeBackoffDelay(0, 500, 999999);
    expect(delay).toBe(10000);
  });

  it('honors retryAfterMs instead of computing exponential backoff', () => {
    const delay = computeBackoffDelay(5, 500, 2000);
    expect(delay).toBe(2000);
  });

  it('treats null retryAfterMs as not provided (uses exponential backoff)', () => {
    const delay = computeBackoffDelay(0, 500, null);
    expect(delay).toBeGreaterThanOrEqual(400);
    expect(delay).toBeLessThanOrEqual(600);
  });

  it('treats undefined retryAfterMs as not provided (uses exponential backoff)', () => {
    const delay = computeBackoffDelay(0, 500, undefined);
    expect(delay).toBeGreaterThanOrEqual(400);
    expect(delay).toBeLessThanOrEqual(600);
  });

  it('returns non-negative delay for attemptIndex 0', () => {
    const delay = computeBackoffDelay(0, 1);
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it('handles large attemptIndex values', () => {
    const delay = computeBackoffDelay(10, 500);
    expect(delay).toBeGreaterThanOrEqual(409600);
    expect(delay).toBeLessThanOrEqual(614400);
  });
});

// ---------------------------------------------------------------------------
// executeWithRetryFailover — success scenarios
// ---------------------------------------------------------------------------

describe('executeWithRetryFailover — success scenarios', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.fetchSearXNG.mockReset();
    mocks.parseResponse.mockReset();
    mocks.normalizeResults.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  // [Implements: US-SR-005] Success on first attempt
  it('returns results on the first successful attempt', async () => {
    const pool = makePool();
    const config = makeConfig();
    const mockResults = [
      { title: 'A', url: 'https://a.com', snippet: 'SA', score: 1.0 },
    ];

    mocks.fetchSearXNG.mockResolvedValue(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput([makeParsedResult()]));
    mocks.normalizeResults.mockReturnValue(mockResults);

    const results = await executeWithRetryFailover('test query', config, pool);

    expect(results).toBe(mockResults);
    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSearXNG).toHaveBeenCalledWith(
      'https://a.example',
      'test query',
      config
    );
  });

  // [Implements: US-SR-005] SEARCH START log
  it('logs SEARCH START to stderr with query, instance, and attempt', async () => {
    const pool = makePool();
    const config = makeConfig();

    mocks.fetchSearXNG.mockResolvedValue(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('my query', config, pool);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('SEARCH START')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('query: my query')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('instance: https://a.example')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('attempt: 1')
    );
  });

  // [Implements: US-SR-005] SEARCH OK log
  it('logs SEARCH OK to stderr with results count, duration, and instance', async () => {
    const pool = makePool();
    const config = makeConfig();
    const mockResults = [
      { title: 'A', url: 'https://a.com', snippet: 'SA', score: 1.0 },
      { title: 'B', url: 'https://b.com', snippet: 'SB', score: 0.5 },
    ];

    mocks.fetchSearXNG.mockResolvedValue(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue(mockResults);

    await executeWithRetryFailover('test', config, pool);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('SEARCH OK')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('results: 2')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('instance: https://a.example')
    );
  });

  // [Implements: NFR-SR-005] Logs to stderr only, never stdout
  it('never writes log content to stdout', async () => {
    const pool = makePool();
    const config = makeConfig();

    mocks.fetchSearXNG.mockResolvedValue(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  // [Implements: US-SR-005] Does not log retry success on first attempt
  it('does not log "succeeded on attempt" when first attempt succeeds', async () => {
    const pool = makePool();
    const config = makeConfig();

    mocks.fetchSearXNG.mockResolvedValue(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const retrySuccessCall = calls.find((c) =>
      c.includes('succeeded on attempt')
    );
    expect(retrySuccessCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// executeWithRetryFailover — retry scenarios
// ---------------------------------------------------------------------------

describe('executeWithRetryFailover — retry scenarios', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.fetchSearXNG.mockReset();
    mocks.parseResponse.mockReset();
    mocks.normalizeResults.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-005] Retry on timeout
  it('retries on SearchTimeoutError and succeeds on second attempt', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1 });
    const mockResults = [
      { title: 'A', url: 'https://a.com', snippet: 'SA', score: 1.0 },
    ];

    mocks.fetchSearXNG
      .mockRejectedValueOnce(new SearchTimeoutError('timed out'))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue(mockResults);

    const results = await executeWithRetryFailover('test', config, pool);

    expect(results).toBe(mockResults);
    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(2);
  });

  // [Implements: US-SR-005] Logs "succeeded on attempt N after retry"
  it('logs "Search succeeded on attempt {N} after retry" when retry succeeds', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockRejectedValueOnce(new SearchTimeoutError('timed out'))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Search succeeded on attempt 2 after retry')
    );
  });

  // [Implements: US-SR-005] SEARCH RETRY log
  it('logs SEARCH RETRY to stderr with reason and delay', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockRejectedValueOnce(new SearchTimeoutError('timed out'))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('SEARCH RETRY')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason: timeout')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('nextAttemptIn:')
    );
  });

  // [Implements: US-SR-005] Retry on HTTP 500
  it('retries on HTTP 500 status and succeeds on second attempt', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1 });
    const mockResults = [
      { title: 'A', url: 'https://a.com', snippet: 'SA', score: 1.0 },
    ];

    mocks.fetchSearXNG
      .mockResolvedValueOnce(makeFetchResult({ status: 500, body: 'Server Error' }))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue(mockResults);

    const results = await executeWithRetryFailover('test', config, pool);

    expect(results).toBe(mockResults);
    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(2);
  });

  // [Implements: US-SR-005] Retry on HTTP 503
  it('retries on HTTP 503 status', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockResolvedValueOnce(makeFetchResult({ status: 503, body: 'Unavailable' }))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(2);
  });

  // [Implements: US-SR-005] Retry on HTTP 429 with Retry-After
  it('retries on HTTP 429 and honors Retry-After header', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockResolvedValueOnce(
        makeFetchResult({ status: 429, body: 'Rate limited', retryAfterMs: 5 })
      )
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(2);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason: rate_limited')
    );
  });

  it('logs SEARCH RETRY with reason "rate_limited" for HTTP 429', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockResolvedValueOnce(
        makeFetchResult({ status: 429, body: 'Rate limited', retryAfterMs: 1 })
      )
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('rate_limited')
    );
  });

  it('logs SEARCH RETRY with reason "http_500" for HTTP 500', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockResolvedValueOnce(makeFetchResult({ status: 500, body: 'Error' }))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('http_500')
    );
  });

  // [Implements: US-SR-005] Retry on network error
  it('retries on network error (SearchError with network category)', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockRejectedValueOnce(new SearchError('ECONNREFUSED', 'network'))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(2);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason: network')
    );
  });

  // [Implements: US-SR-005] Retry on parse error
  it('retries on SearchParseError', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockRejectedValueOnce(new SearchParseError('parse failed'))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(2);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason: parse_error')
    );
  });

  // [Implements: US-SR-005] Non-retryable error is rethrown immediately
  it('rethrows non-retryable errors immediately (ValidationError)', async () => {
    const pool = makePool();
    const config = makeConfig();

    mocks.fetchSearXNG.mockRejectedValueOnce(new ValidationError('bad input'));

    await expect(
      executeWithRetryFailover('test', config, pool)
    ).rejects.toThrow(ValidationError);

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-SR-005] Multiple retries before success
  it('retries multiple times before succeeding on third attempt', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 3, retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockRejectedValueOnce(new SearchTimeoutError('timeout 1'))
      .mockRejectedValueOnce(new SearchTimeoutError('timeout 2'))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(3);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Search succeeded on attempt 3 after retry')
    );
  });
});

// ---------------------------------------------------------------------------
// executeWithRetryFailover — failover scenarios
// ---------------------------------------------------------------------------

describe('executeWithRetryFailover — failover scenarios', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.fetchSearXNG.mockReset();
    mocks.parseResponse.mockReset();
    mocks.normalizeResults.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-006] Failover to next instance
  it('fails over to the next instance when all retries are exhausted', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 1, retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockRejectedValueOnce(new SearchTimeoutError('timeout'))
      .mockRejectedValueOnce(new SearchTimeoutError('timeout'))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(3);
    expect(mocks.fetchSearXNG.mock.calls[0]![0]).toBe('https://a.example');
    expect(mocks.fetchSearXNG.mock.calls[1]![0]).toBe('https://a.example');
    expect(mocks.fetchSearXNG.mock.calls[2]![0]).toBe('https://b.example');
  });

  // [Implements: US-SR-006] Cursor advancement on failover (before promotion)
  it('advances cursor when failing over (before promotion resets it)', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 0, retryBaseMs: 1 });

    // Track cursor state during execution
    let cursorDuringFailover = -1;
    mocks.fetchSearXNG.mockImplementation((instanceUrl: string) => {
      if (instanceUrl === 'https://a.example') {
        return Promise.resolve(makeFetchResult({ status: 500, body: 'Error' }));
      }
      cursorDuringFailover = pool.cursor;
      return Promise.resolve(makeFetchResult());
    });
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    // During the second instance call, cursor should have been 1
    expect(cursorDuringFailover).toBe(1);
    // After promotion, cursor is reset to 0
    expect(pool.cursor).toBe(0);
  });

  // [Implements: US-SR-006] Promote instance on failover success
  it('promotes the successful instance after failover', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 0, retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockResolvedValueOnce(makeFetchResult({ status: 500, body: 'Error' }))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    // After promotion, the successful instance should be at front
    expect(pool.instances[0]).toBe('https://b.example');
    expect(pool.cursor).toBe(0);
  });

  // [Implements: US-SR-006] Does not promote when first instance succeeds
  it('does not promote when the first instance succeeds', async () => {
    const pool = makePool();
    const config = makeConfig();

    mocks.fetchSearXNG.mockResolvedValue(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(pool.instances[0]).toBe('https://a.example');
    expect(pool.cursor).toBe(0);
  });

  // [Implements: US-SR-006] All instances exhausted in public mode → SearchUnavailableError
  it('throws SearchUnavailableError when all instances are exhausted in public mode', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 0, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 500, body: 'Error' })
    );

    await expect(
      executeWithRetryFailover('test', config, pool)
    ).rejects.toThrow(SearchUnavailableError);
  });

  // [Implements: US-SR-006] SearchUnavailableError message
  it('throws SearchUnavailableError with the correct message', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 0, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 500, body: 'Error' })
    );

    try {
      await executeWithRetryFailover('test', config, pool);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchUnavailableError);
      expect((error as SearchUnavailableError).message).toContain(
        'All SearXNG instances unavailable'
      );
    }
  });

  // [Implements: US-SR-005] All instances exhausted in self-hosted mode → SearchFailedError
  it('throws SearchFailedError when all retries exhausted in self-hosted mode', async () => {
    const pool = makePool({ mode: 'self-hosted', instances: ['https://searx.local'] });
    const config = makeConfig({ maxRetries: 1, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockRejectedValue(new SearchTimeoutError('timeout'));

    await expect(
      executeWithRetryFailover('test', config, pool)
    ).rejects.toThrow(SearchFailedError);
  });

  it('throws SearchFailedError with instance URL in message for self-hosted mode', async () => {
    const pool = makePool({ mode: 'self-hosted', instances: ['https://searx.local'] });
    const config = makeConfig({ maxRetries: 0, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 500, body: 'Error' })
    );

    try {
      await executeWithRetryFailover('test', config, pool);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchFailedError);
      expect((error as SearchFailedError).message).toContain('https://searx.local');
    }
  });

  // [Implements: US-SR-005] SEARCH FAILED log
  it('logs SEARCH FAILED when all attempts fail', async () => {
    const pool = makePool({ mode: 'self-hosted', instances: ['https://searx.local'] });
    const config = makeConfig({ maxRetries: 0, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 500, body: 'Error' })
    );

    try {
      await executeWithRetryFailover('test', config, pool);
    } catch {
      // expected
    }

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('SEARCH FAILED')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('query: test')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('errors:')
    );
  });

  // [Implements: US-SR-006] Failover across all three instances
  it('tries all three instances before giving up in public mode', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 0, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 500, body: 'Error' })
    );

    try {
      await executeWithRetryFailover('test', config, pool);
      expect.fail('Should have thrown');
    } catch {
      // expected
    }

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(3);
    expect(mocks.fetchSearXNG.mock.calls[0]![0]).toBe('https://a.example');
    expect(mocks.fetchSearXNG.mock.calls[1]![0]).toBe('https://b.example');
    expect(mocks.fetchSearXNG.mock.calls[2]![0]).toBe('https://c.example');
  });

  // [Implements: US-SR-006] Failover with retry on each instance
  it('retries on each instance before failing over', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 1, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 500, body: 'Error' })
    );

    try {
      await executeWithRetryFailover('test', config, pool);
      expect.fail('Should have thrown');
    } catch {
      // expected
    }

    // 2 attempts per instance × 3 instances = 6 total
    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(6);
  });
});

// ---------------------------------------------------------------------------
// executeWithRetryFailover — 30s ceiling
// ---------------------------------------------------------------------------

describe('executeWithRetryFailover — 30s ceiling', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.fetchSearXNG.mockReset();
    mocks.parseResponse.mockReset();
    mocks.normalizeResults.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (dateNowSpy) {
      dateNowSpy.mockRestore();
    }
  });

  // [Implements: NFR-SR-001] 30s ceiling exceeded → SearchFailedError
  it('throws SearchFailedError when the 30s ceiling is exceeded', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 5, retryBaseMs: 1 });

    let callCount = 0;
    dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return 0;
      }
      return 31000;
    });

    mocks.fetchSearXNG.mockRejectedValue(new SearchTimeoutError('timeout'));

    await expect(
      executeWithRetryFailover('test', config, pool)
    ).rejects.toThrow(SearchFailedError);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('SEARCH FAILED')
    );
  });

  it('throws SearchFailedError with ceiling message', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 5, retryBaseMs: 1 });

    let callCount = 0;
    dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return 0;
      }
      return 31000;
    });

    mocks.fetchSearXNG.mockRejectedValue(new SearchTimeoutError('timeout'));

    try {
      await executeWithRetryFailover('test', config, pool);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchFailedError);
      expect((error as SearchFailedError).message).toContain('30000ms');
    }
  });

  it('does not throw ceiling error when within the time limit', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1 });

    let callCount = 0;
    dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      return callCount * 100;
    });

    mocks.fetchSearXNG.mockResolvedValue(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    const results = await executeWithRetryFailover('test', config, pool);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// executeWithRetryFailover — HTTP 429 Retry-After
// ---------------------------------------------------------------------------

describe('executeWithRetryFailover — HTTP 429 Retry-After', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.fetchSearXNG.mockReset();
    mocks.parseResponse.mockReset();
    mocks.normalizeResults.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-005] Retry-After honored (capped at 10s)
  it('uses Retry-After value for backoff delay', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1000 });

    mocks.fetchSearXNG
      .mockResolvedValueOnce(
        makeFetchResult({ status: 429, body: 'Rate limited', retryAfterMs: 5 })
      )
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('nextAttemptIn: 5ms')
    );
  });

  // [Implements: US-SR-005] Retry-After capped at 10s — use small value to avoid timeout
  it('uses capped Retry-After value (10s) for backoff delay', async () => {
    const pool = makePool();
    const config = makeConfig({ retryBaseMs: 1000 });

    // Use retryAfterMs of 10 (not 10000) to avoid test timeout
    // The cap is tested in computeBackoffDelay unit tests
    mocks.fetchSearXNG
      .mockResolvedValueOnce(
        makeFetchResult({ status: 429, body: 'Rate limited', retryAfterMs: 10 })
      )
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('nextAttemptIn: 10ms')
    );
  });
});

// ---------------------------------------------------------------------------
// search — public entry point
// ---------------------------------------------------------------------------

describe('search — public entry point', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.fetchSearXNG.mockReset();
    mocks.parseResponse.mockReset();
    mocks.normalizeResults.mockReset();
    // Set SEARXNG_URL for self-hosted mode to avoid instance pool logging noise
    process.env['SEARXNG_URL'] = 'https://searx.example.com';
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-001] Query validation
  it('throws ValidationError for an empty query', async () => {
    await expect(search('')).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for a whitespace-only query', async () => {
    await expect(search('   ')).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for a query exceeding 500 characters', async () => {
    await expect(search('a'.repeat(501))).rejects.toThrow(ValidationError);
  });

  // [Implements: US-SR-001, US-SR-005] Valid query → executes search
  it('executes search for a valid query', async () => {
    const mockResults = [
      { title: 'A', url: 'https://a.com', snippet: 'SA', score: 1.0 },
    ];

    mocks.fetchSearXNG.mockResolvedValue(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput([makeParsedResult()]));
    mocks.normalizeResults.mockReturnValue(mockResults);

    const results = await search('test query');

    expect(results).toBe(mockResults);
    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-SR-011] maxResults option
  it('passes maxResults from options to config', async () => {
    mocks.fetchSearXNG.mockResolvedValue(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await search('test', { maxResults: 5 });

    const config = mocks.fetchSearXNG.mock.calls[0]![2] as SearchConfig;
    expect(config.maxResults).toBe(5);
  });

  // [Implements: US-SR-004] timeoutMs option
  it('passes timeoutMs from options to config', async () => {
    mocks.fetchSearXNG.mockResolvedValue(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await search('test', { timeoutMs: 5000 });

    const config = mocks.fetchSearXNG.mock.calls[0]![2] as SearchConfig;
    expect(config.timeoutMs).toBe(5000);
  });

  // categories option
  it('passes categories from options to config', async () => {
    mocks.fetchSearXNG.mockResolvedValue(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await search('test', { categories: 'it' });

    const config = mocks.fetchSearXNG.mock.calls[0]![2] as SearchConfig;
    expect(config.categories).toBe('it');
  });

  // [Implements: US-SR-005] Propagates SearchFailedError
  it('propagates SearchFailedError when all retries are exhausted', async () => {
    mocks.fetchSearXNG.mockRejectedValue(new SearchTimeoutError('timeout'));

    await expect(search('test')).rejects.toThrow(SearchFailedError);
  });

  // [Implements: US-SR-005] Propagates ValidationError
  it('propagates ValidationError without calling fetchSearXNG', async () => {
    await expect(search('')).rejects.toThrow(ValidationError);
    expect(mocks.fetchSearXNG).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error classification — comprehensive
// ---------------------------------------------------------------------------

describe('executeWithRetryFailover — error classification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.fetchSearXNG.mockReset();
    mocks.parseResponse.mockReset();
    mocks.normalizeResults.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-005] Non-retryable HTTP status (404) → failover, not retry
  it('does not retry on HTTP 404 (non-retryable status)', async () => {
    const pool = makePool({ mode: 'self-hosted', instances: ['https://searx.local'] });
    const config = makeConfig({ maxRetries: 2, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 404, body: 'Not Found' })
    );

    await expect(
      executeWithRetryFailover('test', config, pool)
    ).rejects.toThrow(SearchFailedError);

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-SR-005] Non-retryable HTTP status (403) → failover, not retry
  it('does not retry on HTTP 403 (non-retryable status)', async () => {
    const pool = makePool({ mode: 'self-hosted', instances: ['https://searx.local'] });
    const config = makeConfig({ maxRetries: 2, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 403, body: 'Forbidden' })
    );

    await expect(
      executeWithRetryFailover('test', config, pool)
    ).rejects.toThrow(SearchFailedError);

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-SR-005] HTTP 502 is retryable
  it('retries on HTTP 502 status', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 1, retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockResolvedValueOnce(makeFetchResult({ status: 502, body: 'Bad Gateway' }))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(2);
  });

  // [Implements: US-SR-005] HTTP 504 is retryable
  it('retries on HTTP 504 status', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 1, retryBaseMs: 1 });

    mocks.fetchSearXNG
      .mockResolvedValueOnce(makeFetchResult({ status: 504, body: 'Gateway Timeout' }))
      .mockResolvedValueOnce(makeFetchResult());
    mocks.parseResponse.mockReturnValue(makeParseOutput());
    mocks.normalizeResults.mockReturnValue([]);

    await executeWithRetryFailover('test', config, pool);

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(2);
  });

  // [Implements: US-SR-005] maxRetries=0 means no retries (1 attempt per instance)
  it('makes exactly 1 attempt per instance when maxRetries is 0', async () => {
    const pool = makePool();
    const config = makeConfig({ maxRetries: 0, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 500, body: 'Error' })
    );

    try {
      await executeWithRetryFailover('test', config, pool);
    } catch {
      // expected
    }

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(3);
  });

  // [Implements: US-SR-005] maxRetries=2 means 3 attempts per instance
  it('makes 3 attempts per instance when maxRetries is 2', async () => {
    const pool = makePool({ mode: 'self-hosted', instances: ['https://searx.local'] });
    const config = makeConfig({ maxRetries: 2, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 500, body: 'Error' })
    );

    try {
      await executeWithRetryFailover('test', config, pool);
    } catch {
      // expected
    }

    expect(mocks.fetchSearXNG).toHaveBeenCalledTimes(3);
  });

  // [Implements: US-SR-005] Error summary in SEARCH FAILED log
  it('includes error summary in SEARCH FAILED log', async () => {
    const pool = makePool({ mode: 'self-hosted', instances: ['https://searx.local'] });
    const config = makeConfig({ maxRetries: 0, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 500, body: 'Error' })
    );

    try {
      await executeWithRetryFailover('test', config, pool);
    } catch {
      // expected
    }

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const failedCall = calls.find((c) => c.includes('SEARCH FAILED'));
    expect(failedCall).toBeDefined();
    expect(failedCall).toContain('errors:');
  });

  // [Implements: US-SR-005] Multiple errors in summary
  it('accumulates errors from multiple attempts in the summary', async () => {
    const pool = makePool({ mode: 'self-hosted', instances: ['https://searx.local'] });
    const config = makeConfig({ maxRetries: 1, retryBaseMs: 1 });

    mocks.fetchSearXNG.mockResolvedValue(
      makeFetchResult({ status: 500, body: 'Error' })
    );

    try {
      await executeWithRetryFailover('test', config, pool);
    } catch {
      // expected
    }

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const failedCall = calls.find((c) => c.includes('SEARCH FAILED'));
    expect(failedCall).toBeDefined();
    expect(failedCall).toContain('HTTP 500');
  });
});
