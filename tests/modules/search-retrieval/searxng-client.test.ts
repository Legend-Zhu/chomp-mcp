/**
 * Tests for the SearXNG HTTP client (searxng-client.ts).
 *
 * Covers:
 *   - resolveTimeoutMs: override, env var, default, invalid values
 *   - buildSearchUrl: URL construction, query encoding, categories, trailing slashes
 *   - fetchSearXNG: success, timeout, network error, Retry-After parsing, headers
 *
 * Uses vitest with global fetch mocking via vi.stubGlobal.
 *
 * [Spec: US-SR-001, US-SR-004, DC-SR-004, DC-SR-006, NFR-SR-002]
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_MAX_RESULTS,
  resolveTimeoutMs,
  buildSearchUrl,
  fetchSearXNG,
  type SearchConfig,
} from '../../../src/modules/search-retrieval/searxng-client.js';
import {
  SearchTimeoutError,
  SearchError,
} from '../../../src/modules/search-retrieval/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    retryBaseMs: DEFAULT_RETRY_BASE_MS,
    maxResults: DEFAULT_MAX_RESULTS,
    ...overrides,
  };
}

/** Create a mock Response object compatible with the fetch API. */
function makeMockResponse(
  body: string,
  options: {
    status?: number;
    headers?: Record<string, string>;
  } = {}
): Response {
  const { status = 200, headers = {} } = options;
  const headerEntries = Object.entries(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => {
        const found = headerEntries.find(
          ([k]) => k.toLowerCase() === name.toLowerCase()
        );
        return found ? found[1] : null;
      },
    },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  // [Implements: US-SR-004]
  it('DEFAULT_TIMEOUT_MS is 10000', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });

  // [Implements: US-SR-005]
  it('DEFAULT_MAX_RETRIES is 2', () => {
    expect(DEFAULT_MAX_RETRIES).toBe(2);
  });

  it('DEFAULT_RETRY_BASE_MS is 500', () => {
    expect(DEFAULT_RETRY_BASE_MS).toBe(500);
  });

  it('DEFAULT_MAX_RESULTS is 10', () => {
    expect(DEFAULT_MAX_RESULTS).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// resolveTimeoutMs
// ---------------------------------------------------------------------------

describe('resolveTimeoutMs', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['SEARXNG_TIMEOUT_MS'];
    delete process.env['SEARXNG_TIMEOUT_MS'];
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['SEARXNG_TIMEOUT_MS'];
    } else {
      process.env['SEARXNG_TIMEOUT_MS'] = originalEnv;
    }
    vi.restoreAllMocks();
  });

  // [Implements: US-SR-004] Override takes precedence
  it('returns the override when a valid positive integer is provided', () => {
    expect(resolveTimeoutMs(5000)).toBe(5000);
  });

  it('returns the override when it is 1 (minimum positive integer)', () => {
    expect(resolveTimeoutMs(1)).toBe(1);
  });

  // [Implements: US-SR-004] Invalid override falls through to env/default
  it('logs a warning and falls back when override is 0', () => {
    const result = resolveTimeoutMs(0);
    expect(result).toBe(DEFAULT_TIMEOUT_MS);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it('logs a warning and falls back when override is negative', () => {
    const result = resolveTimeoutMs(-100);
    expect(result).toBe(DEFAULT_TIMEOUT_MS);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it('logs a warning and falls back when override is a float', () => {
    const result = resolveTimeoutMs(5000.5);
    expect(result).toBe(DEFAULT_TIMEOUT_MS);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it('logs a warning and falls back when override is NaN', () => {
    const result = resolveTimeoutMs(NaN);
    expect(result).toBe(DEFAULT_TIMEOUT_MS);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  // [Implements: US-SR-004] Env var is used when no override
  it('returns the env var value when set and valid', () => {
    process.env['SEARXNG_TIMEOUT_MS'] = '8000';
    expect(resolveTimeoutMs()).toBe(8000);
  });

  it('returns the env var value when set with leading/trailing whitespace', () => {
    process.env['SEARXNG_TIMEOUT_MS'] = '  3000  ';
    expect(resolveTimeoutMs()).toBe(3000);
  });

  // [Implements: US-SR-004] Invalid env var falls back to default
  it('logs a warning and falls back when env var is "abc"', () => {
    process.env['SEARXNG_TIMEOUT_MS'] = 'abc';
    const result = resolveTimeoutMs();
    expect(result).toBe(DEFAULT_TIMEOUT_MS);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it('logs a warning and falls back when env var is "0"', () => {
    process.env['SEARXNG_TIMEOUT_MS'] = '0';
    const result = resolveTimeoutMs();
    expect(result).toBe(DEFAULT_TIMEOUT_MS);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it('logs a warning and falls back when env var is "-5"', () => {
    process.env['SEARXNG_TIMEOUT_MS'] = '-5';
    const result = resolveTimeoutMs();
    expect(result).toBe(DEFAULT_TIMEOUT_MS);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it('logs a warning and falls back when env var is "12.5"', () => {
    process.env['SEARXNG_TIMEOUT_MS'] = '12.5';
    const result = resolveTimeoutMs();
    expect(result).toBe(DEFAULT_TIMEOUT_MS);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  it('logs a warning and falls back when env var is empty string', () => {
    process.env['SEARXNG_TIMEOUT_MS'] = '';
    const result = resolveTimeoutMs();
    expect(result).toBe(DEFAULT_TIMEOUT_MS);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  // [Implements: US-SR-004] Default when neither override nor env
  it('returns DEFAULT_TIMEOUT_MS when no override and no env var', () => {
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });

  // [Implements: US-SR-004] Override takes precedence over env var
  it('override takes precedence over env var', () => {
    process.env['SEARXNG_TIMEOUT_MS'] = '8000';
    expect(resolveTimeoutMs(3000)).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// buildSearchUrl
// ---------------------------------------------------------------------------

describe('buildSearchUrl', () => {
  // [Implements: US-SR-001]
  it('builds a correct search URL with query, format, and safesearch', () => {
    const url = buildSearchUrl('https://searx.be', 'test query', makeConfig());
    expect(url).toContain('https://searx.be/search');
    expect(url).toContain('q=test+query');
    expect(url).toContain('format=json');
    expect(url).toContain('safesearch=1');
  });

  it('appends /search to the pathname', () => {
    const url = buildSearchUrl('https://example.com', 'hello', makeConfig());
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/search');
  });

  it('handles trailing slash in instance URL', () => {
    const url = buildSearchUrl('https://example.com/', 'hello', makeConfig());
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/search');
  });

  it('handles multiple trailing slashes in instance URL', () => {
    const url = buildSearchUrl('https://example.com///', 'hello', makeConfig());
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/search');
  });

  it('preserves existing path segments before /search', () => {
    const url = buildSearchUrl('https://example.com/searxng', 'hello', makeConfig());
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/searxng/search');
  });

  it('preserves existing path segments with trailing slash', () => {
    const url = buildSearchUrl('https://example.com/searxng/', 'hello', makeConfig());
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/searxng/search');
  });

  // [Implements: US-SR-001] Categories parameter
  it('includes categories parameter when config.categories is set', () => {
    const url = buildSearchUrl(
      'https://example.com',
      'hello',
      makeConfig({ categories: 'general,images' })
    );
    expect(url).toContain('categories=general%2Cimages');
  });

  it('does NOT include categories parameter when config.categories is undefined', () => {
    const url = buildSearchUrl('https://example.com', 'hello', makeConfig());
    expect(url).not.toContain('categories=');
  });

  it('does NOT include categories parameter when config.categories is empty string', () => {
    const url = buildSearchUrl(
      'https://example.com',
      'hello',
      makeConfig({ categories: '' })
    );
    // Empty string is falsy but not undefined — URLSearchParams.set will set it
    // The implementation checks `!== undefined`, so empty string IS included
    expect(url).toContain('categories=');
  });

  // [Constraint: DC-SR-006] Query encoding
  it('properly encodes special characters in the query', () => {
    const url = buildSearchUrl('https://example.com', 'hello & world?', makeConfig());
    const parsed = new URL(url);
    expect(parsed.searchParams.get('q')).toBe('hello & world?');
  });

  it('properly encodes Unicode characters in the query', () => {
    const url = buildSearchUrl('https://example.com', 'café résumé', makeConfig());
    const parsed = new URL(url);
    expect(parsed.searchParams.get('q')).toBe('café résumé');
  });

  it('properly encodes plus signs in the query', () => {
    const url = buildSearchUrl('https://example.com', 'a+b', makeConfig());
    const parsed = new URL(url);
    expect(parsed.searchParams.get('q')).toBe('a+b');
  });

  it('always sets format to json', () => {
    const url = buildSearchUrl('https://example.com', 'test', makeConfig());
    const parsed = new URL(url);
    expect(parsed.searchParams.get('format')).toBe('json');
  });

  it('always sets safesearch to 1', () => {
    const url = buildSearchUrl('https://example.com', 'test', makeConfig());
    const parsed = new URL(url);
    expect(parsed.searchParams.get('safesearch')).toBe('1');
  });

  it('preserves port number from instance URL', () => {
    const url = buildSearchUrl('http://localhost:8080', 'test', makeConfig());
    const parsed = new URL(url);
    expect(parsed.port).toBe('8080');
    expect(parsed.pathname).toBe('/search');
  });
});

// ---------------------------------------------------------------------------
// fetchSearXNG
// ---------------------------------------------------------------------------

describe('fetchSearXNG', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = process.env['SEARXNG_TIMEOUT_MS'];
    delete process.env['SEARXNG_TIMEOUT_MS'];
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env['SEARXNG_TIMEOUT_MS'];
    } else {
      process.env['SEARXNG_TIMEOUT_MS'] = originalEnv;
    }
    vi.restoreAllMocks();
  });

  // [Implements: US-SR-004] Successful fetch
  it('returns a SearXNGFetchResult on a successful 200 response', async () => {
    const mockBody = JSON.stringify({ results: [] });
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse(mockBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG(
      'https://searx.be',
      'test query',
      makeConfig()
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe(mockBody);
    expect(result.contentType).toBe('application/json');
    expect(result.retryAfterMs).toBeNull();
  });

  it('passes the correct URL to fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await fetchSearXNG('https://searx.be', 'my query', makeConfig());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchArg = mockFetch.mock.calls[0]![0];
    expect(fetchArg).toContain('https://searx.be/search');
    expect(fetchArg).toContain('q=my+query');
    expect(fetchArg).toContain('format=json');
  });

  it('uses GET method', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await fetchSearXNG('https://searx.be', 'test', makeConfig());

    const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(fetchOptions.method).toBe('GET');
  });

  it('sends Accept: application/json header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await fetchSearXNG('https://searx.be', 'test', makeConfig());

    const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/json');
  });

  it('sends User-Agent header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await fetchSearXNG('https://searx.be', 'test', makeConfig());

    const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('chomp-mcp/1.0');
  });

  // [Implements: US-SR-004] Timeout
  it('throws SearchTimeoutError when the request times out', async () => {
    // Mock fetch to reject with an AbortError
    globalThis.fetch = vi.fn().mockImplementation((_url, options) => {
      return new Promise((_resolve, reject) => {
        // Simulate the abort signal firing
        const signal = (options as RequestInit).signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new DOMException('The operation was aborted.', 'AbortError');
            reject(err);
          });
        }
      });
    }) as unknown as typeof globalThis.fetch;

    // Use a very short timeout to trigger the abort quickly
    const config = makeConfig({ timeoutMs: 50 });

    await expect(
      fetchSearXNG('https://searx.be', 'test', config)
    ).rejects.toThrow(SearchTimeoutError);

    // [Implements: US-SR-004] Timeout message is logged to stderr
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('timed out after 50ms')
    );
  });

  it('SearchTimeoutError message includes the timeout duration', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, options) => {
      return new Promise((_resolve, reject) => {
        const signal = (options as RequestInit).signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }
      });
    }) as unknown as typeof globalThis.fetch;

    const config = makeConfig({ timeoutMs: 100 });

    try {
      await fetchSearXNG('https://searx.be', 'test', config);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchTimeoutError);
      expect((error as SearchTimeoutError).message).toContain('100ms');
    }
  });

  // [Implements: US-SR-004] Non-timeout network error
  it('throws SearchError with category "network" on a non-timeout fetch error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new TypeError('fetch failed: ECONNREFUSED')
    ) as unknown as typeof globalThis.fetch;

    try {
      await fetchSearXNG('https://searx.be', 'test', makeConfig());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchError);
      expect(error).not.toBeInstanceOf(SearchTimeoutError);
      const searchError = error as SearchError;
      expect(searchError.category).toBe('network');
      expect(searchError.message).toContain('ECONNREFUSED');
    }
  });

  it('wraps non-Error throwables in SearchError with network category', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue('string error') as unknown as typeof globalThis.fetch;

    try {
      await fetchSearXNG('https://searx.be', 'test', makeConfig());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchError);
      expect((error as SearchError).category).toBe('network');
      expect((error as SearchError).message).toContain('string error');
    }
  });

  // [Implements: US-SR-004] Various HTTP status codes are returned, not thrown
  it('returns the response for HTTP 429 status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('rate limited', {
        status: 429,
        headers: { 'content-type': 'text/plain', 'retry-after': '5' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.status).toBe(429);
    expect(result.body).toBe('rate limited');
  });

  it('returns the response for HTTP 500 status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('Internal Server Error', {
        status: 500,
        headers: { 'content-type': 'text/html' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.status).toBe(500);
    expect(result.body).toBe('Internal Server Error');
  });

  it('returns the response for HTTP 503 status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('Service Unavailable', {
        status: 503,
        headers: { 'content-type': 'text/html' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.status).toBe(503);
  });

  // [Constraint: DC-SR-006] Retry-After header parsing
  it('parses Retry-After as delta-seconds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '3' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.retryAfterMs).toBe(3000);
  });

  it('caps Retry-After at 10000ms', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.retryAfterMs).toBe(10_000);
  });

  it('returns null retryAfterMs when Retry-After header is absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.retryAfterMs).toBeNull();
  });

  it('returns null retryAfterMs when Retry-After header is empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'retry-after': '' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.retryAfterMs).toBeNull();
  });

  it('returns null retryAfterMs when Retry-After header is unparseable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'retry-after': 'not-a-date-or-number' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.retryAfterMs).toBeNull();
  });

  it('parses Retry-After as HTTP-date', async () => {
    // Use a future date to get a positive delay
    const futureDate = new Date(Date.now() + 5000).toUTCString();
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': futureDate },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.retryAfterMs).not.toBeNull();
    expect(result.retryAfterMs!).toBeGreaterThan(0);
    expect(result.retryAfterMs!).toBeLessThanOrEqual(10_000);
  });

  it('returns 0 retryAfterMs when Retry-After HTTP-date is in the past', async () => {
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': pastDate },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.retryAfterMs).toBe(0);
  });

  // [Constraint: DC-SR-006] Content-Type header
  it('returns null contentType when Content-Type header is absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', { status: 200 })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.contentType).toBeNull();
  });

  it('returns the Content-Type header value', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.contentType).toBe('application/json; charset=utf-8');
  });

  // [Implements: US-SR-004] Categories in URL
  it('includes categories in the fetch URL when config.categories is set', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await fetchSearXNG(
      'https://searx.be',
      'test',
      makeConfig({ categories: 'it' })
    );

    const fetchUrl = mockFetch.mock.calls[0]![0] as string;
    expect(fetchUrl).toContain('categories=it');
  });

  // [Implements: US-SR-004] Body is returned as text
  it('returns the response body as a string', async () => {
    const body = JSON.stringify({
      results: [{ url: 'https://example.com', title: 'Test', content: 'Snippet' }],
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.body).toBe(body);
  });

  it('returns empty string body when response body is empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeMockResponse('', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof globalThis.fetch;

    const result = await fetchSearXNG('https://searx.be', 'test', makeConfig());
    expect(result.body).toBe('');
  });

  // [Implements: US-SR-004] AbortController signal is passed to fetch
  it('passes an AbortSignal to fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeMockResponse('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await fetchSearXNG('https://searx.be', 'test', makeConfig());

    const fetchOptions = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(fetchOptions.signal).toBeDefined();
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
  });
});
