/**
 * Unit tests for http-fetcher.ts — redirect following, retry logic,
 * timeout handling, HTTP status classification, and compressed response
 * decompression.
 *
 * All network calls are mocked via globalThis.fetch stubs.
 *
 * [Spec: US-SC-001, US-SC-002, US-SC-003]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';

import { fetchUrl } from '../../../src/modules/scrape-extract/http-fetcher.js';
import type { FetchResult, ScrapeConfig } from '../../../src/modules/scrape-extract/types.js';

// ---------------------------------------------------------------------------
// Mock response helper
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

interface MockResponseInit {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

function makeResponse(init: MockResponseInit): Response {
  const headerMap = new Map<string, string>();
  if (init.headers) {
    for (const [k, v] of Object.entries(init.headers)) {
      headerMap.set(k.toLowerCase(), v);
    }
  }

  let bodyAb: ArrayBuffer;
  if (init.body === undefined || init.body === null || init.body === '') {
    bodyAb = new ArrayBuffer(0);
  } else if (typeof init.body === 'string') {
    const encoded = textEncoder.encode(init.body);
    bodyAb = new ArrayBuffer(encoded.byteLength);
    new Uint8Array(bodyAb).set(encoded);
  } else {
    bodyAb = new ArrayBuffer(init.body.byteLength);
    new Uint8Array(bodyAb).set(init.body);
  }

  return {
    status: init.status,
    statusText: init.statusText ?? '',
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
    arrayBuffer: () => Promise.resolve(bodyAb),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const testConfig: ScrapeConfig = {
  timeoutMs: 15000,
  maxContentChars: 8000,
  maxRedirects: 5,
  minContentChars: 200,
  maxTotalTimeoutMs: 30000,
};

const TEST_URL = 'https://example.com/page';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('fetchUrl', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    stderrSpy.mockRestore();
    vi.useRealTimers();
  });

  // Helper to decode bodyBytes for assertions
  function decodeBody(bytes: Uint8Array | null): string {
    if (!bytes) return '';
    return new TextDecoder().decode(bytes);
  }

  // Helper to collect stderr output
  function getStderr(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  // =========================================================================
  // SUCCESSFUL FETCH (200 OK)
  // =========================================================================

  describe('successful 200 fetch', () => {
    // [Implements: US-SC-001]
    it('returns success=true for HTTP 200', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: '<html><body>Hello</body></html>',
        })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    // [Implements: US-SC-001]
    it('stores the response body bytes', async () => {
      const body = '<html><body>Content here</body></html>';
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, body, headers: { 'content-type': 'text/html' } })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.bodyBytes).not.toBeNull();
      expect(decodeBody(result.bodyBytes)).toBe(body);
    });

    // [Implements: US-SC-001]
    it('preserves the Content-Type header', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: '{"key":"value"}',
        })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.contentType).toBe('application/json; charset=utf-8');
    });

    // [Implements: US-SC-001]
    it('sets finalUrl to the input URL when no redirects', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, body: 'data' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.finalUrl).toBe(TEST_URL);
    });

    // [Implements: US-SC-001]
    it('sets redirectCount to 0 when no redirects', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, body: 'data' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.redirectCount).toBe(0);
    });

    // [Implements: US-SC-001]
    it('sets error to null on success', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, body: 'data' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.error).toBeNull();
    });

    // [Implements: US-SC-001]
    it('sets retryAfterMs to null on success', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, body: 'data' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.retryAfterMs).toBeNull();
    });

    // [Implements: US-SC-001]
    it('stores the HTTP status code', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, statusText: 'OK', body: 'data' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.statusCode).toBe(200);
      expect(result.statusText).toBe('OK');
    });

    // [Implements: US-SC-001]
    it('handles empty response body', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, body: '' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.bodyBytes).not.toBeNull();
      expect(result.bodyBytes!.byteLength).toBe(0);
    });

    // [Implements: US-SC-001]
    it('passes User-Agent header in fetch request', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, body: 'data' })
      );

      await fetchUrl(TEST_URL, testConfig);

      const callArgs = mockFetch.mock.calls[0];
      const opts = callArgs?.[1] as Record<string, unknown> | undefined;
      expect(opts).toBeDefined();
      const headers = opts?.headers as Record<string, string>;
      expect(headers['User-Agent']).toContain('web-research');
    });

    // [Implements: US-SC-001]
    it('uses redirect: manual in fetch options', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, body: 'data' })
      );

      await fetchUrl(TEST_URL, testConfig);

      const callArgs = mockFetch.mock.calls[0];
      const opts = callArgs?.[1] as Record<string, unknown> | undefined;
      expect(opts?.redirect).toBe('manual');
    });

    // [Implements: US-SC-001]
    it('handles 201 Created status as success', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 201, body: 'created' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(201);
    });

    // [Implements: US-SC-001]
    it('handles 204 No Content status as success', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 204, body: '' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(204);
    });
  });

  // =========================================================================
  // REDIRECT FOLLOWING
  // =========================================================================

  describe('redirect following', () => {
    // [Implements: US-SC-003]
    it('follows a single 302 redirect to 200', async () => {
      const finalUrl = 'https://example.com/final';
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({ status: 302, headers: { location: finalUrl } })
        )
        .mockResolvedValueOnce(
          makeResponse({ status: 200, body: 'final content' })
        );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.finalUrl).toBe(finalUrl);
      expect(result.redirectCount).toBe(1);
    });

    // [Implements: US-SC-003]
    it('follows a 301 redirect', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({ status: 301, headers: { location: 'https://example.com/perm' } })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.redirectCount).toBe(1);
      expect(result.finalUrl).toBe('https://example.com/perm');
    });

    // [Implements: US-SC-003]
    it('follows a 307 redirect', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({ status: 307, headers: { location: 'https://example.com/temp' } })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.redirectCount).toBe(1);
    });

    // [Implements: US-SC-003]
    it('follows a 308 redirect', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({ status: 308, headers: { location: 'https://example.com/permanent' } })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.redirectCount).toBe(1);
    });

    // [Implements: US-SC-003]
    it('follows multiple redirects in sequence', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({ status: 302, headers: { location: 'https://example.com/r1' } })
        )
        .mockResolvedValueOnce(
          makeResponse({ status: 301, headers: { location: 'https://example.com/r2' } })
        )
        .mockResolvedValueOnce(
          makeResponse({ status: 307, headers: { location: 'https://example.com/final' } })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'done' }));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.redirectCount).toBe(3);
      expect(result.finalUrl).toBe('https://example.com/final');
    });

    // [Implements: US-SC-003]
    it('updates finalUrl to the redirect target URL', async () => {
      const target = 'https://other.example.com/destination';
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({ status: 302, headers: { location: target } })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.finalUrl).toBe(target);
    });

    // [Implements: US-SC-003]
    it('resolves relative redirect Location URLs', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({ status: 302, headers: { location: '/relative/path' } })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      const result = await fetchUrl('https://example.com/start', testConfig);

      expect(result.success).toBe(true);
      expect(result.finalUrl).toBe('https://example.com/relative/path');
    });

    // [Implements: US-SC-003]
    it('handles relative redirect with query string', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({ status: 302, headers: { location: '/path?q=1' } })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      const result = await fetchUrl('https://example.com/start', testConfig);

      expect(result.finalUrl).toBe('https://example.com/path?q=1');
    });

    // [Implements: US-SC-003]
    it('preserves body bytes from the final 200 response after redirects', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({ status: 302, headers: { location: 'https://example.com/final' } })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'final body text' }));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(decodeBody(result.bodyBytes)).toBe('final body text');
    });

    // [Implements: US-SC-003]
    it('returns error when redirect has no Location header', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 302, statusText: 'Found', headers: {} })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('redirect without Location');
      expect(result.statusCode).toBe(302);
    });
  });

  // =========================================================================
  // MAX REDIRECTS ENFORCEMENT
  // =========================================================================

  describe('max redirects enforcement', () => {
    // [Implements: US-SC-003]
    it('allows exactly 5 redirects before succeeding', async () => {
      const redirect = makeResponse({
        status: 302,
        headers: { location: 'https://example.com/dest' },
      });
      mockFetch
        .mockResolvedValueOnce(redirect)
        .mockResolvedValueOnce(redirect)
        .mockResolvedValueOnce(redirect)
        .mockResolvedValueOnce(redirect)
        .mockResolvedValueOnce(redirect)
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'success' }));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.redirectCount).toBe(5);
    });

    // [Implements: US-SC-003]
    it('returns error when redirect chain exceeds 5 hops', async () => {
      const redirect = makeResponse({
        status: 302,
        statusText: 'Found',
        headers: { location: 'https://example.com/dest' },
      });
      mockFetch.mockResolvedValue(redirect); // Always returns redirect

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Redirect loop or too many redirects');
    });

    // [Implements: US-SC-003]
    it('makes 6 fetch calls when redirect chain exceeds max', async () => {
      const redirect = makeResponse({
        status: 302,
        headers: { location: 'https://example.com/dest' },
      });
      mockFetch.mockResolvedValue(redirect);

      await fetchUrl(TEST_URL, testConfig);

      // 5 redirects followed + 1 that triggers the max check
      expect(mockFetch).toHaveBeenCalledTimes(6);
    });
  });

  // =========================================================================
  // HTTP ERROR STATUS CLASSIFICATION
  // =========================================================================

  describe('HTTP error status classification', () => {
    // [Implements: US-SC-001]
    it('returns failure for HTTP 404 with error message', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 404, statusText: 'Not Found' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
      expect(result.error).toContain('HTTP 404');
      expect(result.error).toContain('Not Found');
    });

    // [Implements: US-SC-001]
    it('returns failure for HTTP 401', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 401, statusText: 'Unauthorized' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(401);
    });

    // [Implements: US-SC-001]
    it('returns failure for HTTP 403', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 403, statusText: 'Forbidden' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(403);
    });

    // [Implements: US-SC-001]
    it('includes the URL in the 4xx error message', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 404, statusText: 'Not Found' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.error).toContain(TEST_URL);
    });

    // [Implements: US-SC-001]
    it('sets bodyBytes to null on 4xx error', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 404, statusText: 'Not Found' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.bodyBytes).toBeNull();
    });

    // [Implements: US-SC-001]
    it('sets contentType to null on 4xx error', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 404, statusText: 'Not Found' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.contentType).toBeNull();
    });

    // [Implements: US-SC-001]
    it('does NOT retry on 4xx error (non-429)', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 404, statusText: 'Not Found' })
      );

      await fetchUrl(TEST_URL, testConfig);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // [Implements: US-SC-001]
    it('returns failure for HTTP 400 Bad Request', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 400, statusText: 'Bad Request' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(400);
    });

    // [Implements: US-SC-001]
    it('returns failure for HTTP 410 Gone', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 410, statusText: 'Gone' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(410);
    });

    // [Implements: US-SC-001]
    it('returns failure for HTTP 451 Unavailable For Legal Reasons', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 451, statusText: 'Unavailable For Legal Reasons' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(451);
    });
  });

  // =========================================================================
  // HTTP 429 RATE LIMITING WITH RETRY
  // =========================================================================

  describe('HTTP 429 rate limiting retry', () => {
    // [Implements: US-SC-001]
    it('retries once on 429 then succeeds', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({
              status: 429,
              statusText: 'Too Many Requests',
              headers: { 'retry-after': '2' },
            })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'success' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('returns failure when 429 persists after retry', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValue(
          makeResponse({
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'retry-after': '1' },
          })
        );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.statusCode).toBe(429);
        expect(result.error).toContain('Too Many Requests');
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('parses Retry-After delta-seconds header', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({
              status: 429,
              headers: { 'retry-after': '5' },
            })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(5000);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('uses default retry delay when Retry-After is missing', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({ status: 429, headers: {} })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        // Default retry-after is 3000ms
        await vi.advanceTimersByTimeAsync(3000);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('includes retryAfterMs in the error result when 429 persists', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValue(
          makeResponse({
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'retry-after': '5' },
          })
        );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(10000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.retryAfterMs).toBe(5000);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('includes default retryAfterMs (3000) when header is missing on 429', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValue(
          makeResponse({
            status: 429,
            statusText: 'Too Many Requests',
          })
        );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(6000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.retryAfterMs).toBe(3000);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('logs retry succeeded message after successful 429 retry', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({ status: 429, headers: { 'retry-after': '1' } })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        await promise;

        expect(getStderr()).toContain('retry succeeded');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // HTTP 5xx SERVER ERROR RETRY
  // =========================================================================

  describe('HTTP 5xx server error retry', () => {
    // [Implements: US-SC-001]
    it('retries once on 500 then succeeds', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({ status: 500, statusText: 'Internal Server Error' })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'recovered' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('returns failure when 500 persists after retry', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValue(
          makeResponse({ status: 500, statusText: 'Internal Server Error' })
        );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.statusCode).toBe(500);
        expect(result.error).toContain('HTTP 500');
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('retries on 503 Service Unavailable', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({ status: 503, statusText: 'Service Unavailable' })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('retries on 502 Bad Gateway', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({ status: 502, statusText: 'Bad Gateway' })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('retries on 504 Gateway Timeout', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({ status: 504, statusText: 'Gateway Timeout' })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // TRANSIENT NETWORK ERROR RETRY
  // =========================================================================

  describe('transient network error retry', () => {
    function makeNetworkError(code: string): Error {
      const err = new TypeError('fetch failed');
      (err as unknown as { cause: { code: string; message: string } }).cause = {
        code,
        message: `${code}: network error`,
      };
      return err;
    }

    // [Implements: US-SC-001]
    it('retries on ECONNRESET then succeeds', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('retries on ETIMEDOUT then succeeds', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockRejectedValueOnce(makeNetworkError('ETIMEDOUT'))
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('retries on ECONNREFUSED then succeeds', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockRejectedValueOnce(makeNetworkError('ECONNREFUSED'))
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('retries on EAI_AGAIN then succeeds', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockRejectedValueOnce(makeNetworkError('EAI_AGAIN'))
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('retries twice with exponential backoff then succeeds', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
          .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'third time lucky' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        // First backoff: 1000ms
        await vi.advanceTimersByTimeAsync(1000);
        // Second backoff: 3000ms
        await vi.advanceTimersByTimeAsync(3000);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('returns failure when all transient retries are exhausted', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockRejectedValue(makeNetworkError('ECONNRESET'));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(3000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.statusCode).toBe(0);
        expect(result.error).toContain('ECONNRESET');
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // NON-TRANSIENT NETWORK ERRORS (NO RETRY)
  // =========================================================================

  describe('non-transient network errors', () => {
    function makeNetworkError(code: string, message: string): Error {
      const err = new TypeError('fetch failed');
      (err as unknown as { cause: { code: string; message: string } }).cause = {
        code,
        message,
      };
      return err;
    }

    // [Implements: US-SC-001]
    it('does NOT retry on ENOTFOUND (DNS failure)', async () => {
      mockFetch.mockRejectedValueOnce(
        makeNetworkError('ENOTFOUND', 'getaddrinfo ENOTFOUND example.com')
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOTFOUND');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // [Implements: US-SC-001]
    it('includes error code in the error message', async () => {
      mockFetch.mockRejectedValueOnce(
        makeNetworkError('ENOTFOUND', 'getaddrinfo ENOTFOUND example.com')
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.error).toContain('ENOTFOUND');
    });

    // [Implements: US-SC-001]
    it('sets statusCode to 0 on network error', async () => {
      mockFetch.mockRejectedValueOnce(
        makeNetworkError('ENOTFOUND', 'dns failure')
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.statusCode).toBe(0);
    });

    // [Implements: US-SC-001]
    it('sets finalUrl to null on network error', async () => {
      mockFetch.mockRejectedValueOnce(
        makeNetworkError('ENOTFOUND', 'dns failure')
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.finalUrl).toBeNull();
    });

    // [Implements: US-SC-001]
    it('sets bodyBytes to null on network error', async () => {
      mockFetch.mockRejectedValueOnce(
        makeNetworkError('ENOTFOUND', 'dns failure')
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.bodyBytes).toBeNull();
    });

    // [Implements: US-SC-001]
    it('sets retryAfterMs to null on network error', async () => {
      mockFetch.mockRejectedValueOnce(
        makeNetworkError('ENOTFOUND', 'dns failure')
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.retryAfterMs).toBeNull();
    });

    // [Implements: US-SC-001]
    it('handles UNKNOWN error code', async () => {
      mockFetch.mockRejectedValueOnce(new Error('something weird happened'));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('UNKNOWN');
    });

    // [Implements: US-SC-001]
    it('handles error with code property directly on the error', async () => {
      const err = new Error('connection reset');
      (err as unknown as { code: string }).code = 'ECONNRESET';
      mockFetch.mockRejectedValueOnce(err);

      // ECONNRESET is transient so fetchUrl will retry after a delay
      // Without advancing timers, only the first call has been made
      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // TIMEOUT HANDLING
  // =========================================================================

  describe('timeout handling', () => {
    function makePendingFetch(): ReturnType<typeof vi.fn> {
      return vi.fn().mockImplementation(
        (url: string, init?: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              if (signal.aborted) {
                reject(new Error('The operation was aborted'));
              } else {
                signal.addEventListener('abort', () => {
                  reject(new Error('The operation was aborted'));
                });
              }
            }
          });
        }
      ) as ReturnType<typeof vi.fn>;
    }

    // [Implements: US-SC-001]
    it('returns timeout error when fetch exceeds timeoutMs', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', makePendingFetch());

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.error).toContain('timed out');
        expect(result.error).toContain('100ms');
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('sets statusCode to 0 on timeout', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', makePendingFetch());

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 200 });
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;

        expect(result.statusCode).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('sets bodyBytes to null on timeout', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', makePendingFetch());

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        const result = await promise;

        expect(result.bodyBytes).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('includes the timeout value in the error message', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', makePendingFetch());

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 5000 });
        await vi.advanceTimersByTimeAsync(5000);
        const result = await promise;

        expect(result.error).toContain('5000ms');
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('logs timeout message to stderr', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', makePendingFetch());

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        await promise;

        expect(getStderr()).toContain('[scrape] timeout:');
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('sets finalUrl to the input URL on timeout (no redirects)', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', makePendingFetch());

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        const result = await promise;

        expect(result.finalUrl).toBe(TEST_URL);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // EXTERNAL SIGNAL ABORT
  // =========================================================================

  describe('external signal abort', () => {
    // [Implements: US-SC-001]
    it('returns timeout error when external signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await fetchUrl(TEST_URL, testConfig, controller.signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });

    // [Implements: US-SC-001]
    it('aborts when external signal fires during fetch', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation(
            (url: string, init?: { signal?: AbortSignal }) => {
              return new Promise((_resolve, reject) => {
                const signal = init?.signal;
                if (signal) {
                  signal.addEventListener('abort', () => {
                    reject(new Error('aborted'));
                  });
                }
              });
            }
          )
        );

        const controller = new AbortController();
        const promise = fetchUrl(
          TEST_URL,
          { ...testConfig, timeoutMs: 60000 },
          controller.signal
        );

        // Abort the external signal
        controller.abort();
        // Advance timers to let the abort propagate
        await vi.advanceTimersByTimeAsync(0);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.error).toContain('timed out');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // COMPRESSED RESPONSE DECOMPRESSION
  // =========================================================================

  describe('compressed response decompression', () => {
    // [Implements: US-SC-001]
    it('decompresses gzip-encoded response', async () => {
      const originalText = '<html><body>Gzip compressed content for testing</body></html>';
      const compressed = gzipSync(Buffer.from(originalText));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: {
              'content-type': 'text/html',
              'content-encoding': 'gzip',
            },
            body: compressed,
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe(originalText);
    });

    // [Implements: US-SC-001]
    it('decompresses deflate-encoded response', async () => {
      const originalText = '<html><body>Deflate compressed content here</body></html>';
      const compressed = deflateSync(Buffer.from(originalText));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: {
              'content-type': 'text/html',
              'content-encoding': 'deflate',
            },
            body: compressed,
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe(originalText);
    });

    // [Implements: US-SC-001]
    it('decompresses brotli-encoded response', async () => {
      const originalText = '<html><body>Brotli compressed content for testing decompression</body></html>';
      const compressed = brotliCompressSync(Buffer.from(originalText));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: {
              'content-type': 'text/html',
              'content-encoding': 'br',
            },
            body: compressed,
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe(originalText);
    });

    // [Implements: US-SC-001]
    it('returns original bytes when content-encoding is not present', async () => {
      const body = '<html><body>Plain uncompressed content</body></html>';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({ status: 200, headers: { 'content-type': 'text/html' }, body })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe(body);
    });

    // [Implements: US-SC-001]
    it('returns original bytes when decompression fails (already decompressed)', async () => {
      const body = 'not actually gzipped data';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: { 'content-encoding': 'gzip' },
            body,
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe(body);
    });

    // [Implements: US-SC-001]
    it('handles gzip with uppercase Content-Encoding header', async () => {
      const originalText = 'UpperCase gzip test content';
      const compressed = gzipSync(Buffer.from(originalText));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: {
              'Content-Encoding': 'GZIP',
            },
            body: compressed,
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe(originalText);
    });

    // [Implements: US-SC-001]
    it('handles gzip with whitespace in Content-Encoding', async () => {
      const originalText = 'Whitespace gzip test';
      const compressed = gzipSync(Buffer.from(originalText));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: { 'content-encoding': ' gzip ' },
            body: compressed,
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe(originalText);
    });

    // [Implements: US-SC-001]
    it('does not attempt decompression on empty body', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: { 'content-encoding': 'gzip' },
            body: '',
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.bodyBytes!.byteLength).toBe(0);
    });
  });

  // =========================================================================
  // CONTENT-TYPE HEADER PRESERVATION
  // =========================================================================

  describe('Content-Type header preservation', () => {
    // [Implements: US-SC-001]
    it('preserves text/html content-type', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: '<html></html>',
        })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.contentType).toBe('text/html; charset=utf-8');
    });

    // [Implements: US-SC-001]
    it('preserves application/json content-type', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"a":1}',
        })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.contentType).toBe('application/json');
    });

    // [Implements: US-SC-001]
    it('returns null contentType when header is missing', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, headers: {}, body: 'data' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.contentType).toBeNull();
    });
  });

  // =========================================================================
  // FETCHRESULT SHAPE INVARIANTS
  // =========================================================================

  describe('FetchResult shape invariants', () => {
    // [Implements: US-SC-001]
    it('success result has all required fields with correct types', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, body: 'data', headers: { 'content-type': 'text/plain' } })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(typeof result.success).toBe('boolean');
      expect(typeof result.statusCode).toBe('number');
      expect(typeof result.statusText).toBe('string');
      expect(typeof result.contentType).toBe('string');
      expect(result.bodyBytes).toBeInstanceOf(Uint8Array);
      expect(typeof result.finalUrl).toBe('string');
      expect(typeof result.redirectCount).toBe('number');
      expect(result.error).toBeNull();
      expect(result.retryAfterMs).toBeNull();
    });

    // [Implements: US-SC-001]
    it('failure result has all required fields with correct types', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 404, statusText: 'Not Found' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(typeof result.statusCode).toBe('number');
      expect(typeof result.statusText).toBe('string');
      expect(result.contentType).toBeNull();
      expect(result.bodyBytes).toBeNull();
      expect(typeof result.finalUrl).toBe('string');
      expect(typeof result.redirectCount).toBe('number');
      expect(typeof result.error).toBe('string');
      expect(result.retryAfterMs).toBeNull();
    });

    // [Implements: US-SC-001]
    it('network error result has null finalUrl', async () => {
      const err = new TypeError('fetch failed');
      (err as unknown as { cause: { code: string } }).cause = {
        code: 'ENOTFOUND',
      };
      mockFetch.mockRejectedValueOnce(err);

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.finalUrl).toBeNull();
    });
  });

  // =========================================================================
  // ADDITIONAL EDGE CASES
  // =========================================================================

  describe('additional edge cases', () => {
    // [Implements: US-SC-001]
    it('handles binary content-type response', async () => {
      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          status: 200,
          headers: { 'content-type': 'image/png' },
          body: binaryData,
        })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.bodyBytes).toEqual(binaryData);
    });

    // [Implements: US-SC-001]
    it('handles large response body', async () => {
      const largeBody = 'A'.repeat(100000);
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, body: largeBody })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.bodyBytes!.byteLength).toBe(100000);
    });

    // [Implements: US-SC-001]
    it('handles redirect to a different domain', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: 'https://other-domain.com/page' },
          })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'cross-domain' }));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.finalUrl).toBe('https://other-domain.com/page');
    });

    // [Implements: US-SC-001]
    it('preserves contentType after redirect chain', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: 'https://example.com/final' },
          })
        )
        .mockResolvedValueOnce(
          makeResponse({
            status: 200,
            headers: { 'content-type': 'application/xml' },
            body: '<root/>',
          })
        );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.contentType).toBe('application/xml');
    });

    // [Implements: US-SC-001]
    it('redirect preserves error status from redirect itself', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 302, statusText: 'Found', headers: {} })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.statusCode).toBe(302);
      expect(result.statusText).toBe('Found');
    });

    // [Implements: US-SC-001]
    it('handles 200 with content-encoding identity (no encoding)', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          status: 200,
          headers: { 'content-encoding': 'identity' },
          body: 'identity encoded',
        })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe('identity encoded');
    });

    // [Implements: US-SC-001]
    it('handles unknown content-encoding without crash', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          status: 200,
          headers: { 'content-encoding': 'custom-encoding' },
          body: 'custom data',
        })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      // Unknown encoding → return original bytes
      expect(decodeBody(result.bodyBytes)).toBe('custom data');
    });

    // [Implements: US-SC-001]
    it('handles redirect with fragment in Location', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: 'https://example.com/page#section' },
          })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.finalUrl).toBe('https://example.com/page#section');
    });

    // [Implements: US-SC-001]
    it('handles multiple redirects to the same URL', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: 'https://example.com/loop' },
          })
        )
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: 'https://example.com/loop' },
          })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.redirectCount).toBe(2);
    });

    // [Implements: US-SC-001]
    it('passes the URL as first argument to fetch', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      await fetchUrl(TEST_URL, testConfig);

      expect(mockFetch.mock.calls[0]?.[0]).toBe(TEST_URL);
    });

    // [Implements: US-SC-001]
    it('updates the URL argument on each redirect hop', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: 'https://example.com/step1' },
          })
        )
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: 'https://example.com/step2' },
          })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      await fetchUrl(TEST_URL, testConfig);

      expect(mockFetch.mock.calls[0]?.[0]).toBe(TEST_URL);
      expect(mockFetch.mock.calls[1]?.[0]).toBe('https://example.com/step1');
      expect(mockFetch.mock.calls[2]?.[0]).toBe('https://example.com/step2');
    });

    // [Implements: US-SC-001]
    it('handles Unicode content in response body', async () => {
      const unicodeBody = 'Hello 世界! 🌍 Café naïve';
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 200, body: unicodeBody })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe(unicodeBody);
    });

    // [Implements: US-SC-001]
    it('does not log retry succeeded on first-attempt success', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      await fetchUrl(TEST_URL, testConfig);

      expect(getStderr()).not.toContain('retry succeeded');
    });

    // [Implements: US-SC-001]
    it('handles error thrown as non-Error object', async () => {
      mockFetch.mockRejectedValueOnce('string error' as unknown as Error);

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
    });

    // [Implements: US-SC-001]
    it('handles error with cause message but no code', async () => {
      const err = new TypeError('fetch failed');
      (err as unknown as { cause: Error }).cause = new Error('connection refused');
      mockFetch.mockRejectedValueOnce(err);

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('connection refused');
    });

    // [Implements: US-SC-001]
    it('handles Retry-After as HTTP-date format', async () => {
      vi.useFakeTimers();
      try {
        // Use a date 10 seconds in the future
        const futureDate = new Date(Date.now() + 10000).toUTCString();
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({
              status: 429,
              headers: { 'retry-after': futureDate },
            })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        // Advance past the 10 second wait
        await vi.advanceTimersByTimeAsync(10000);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('handles Retry-After with invalid format (falls back to default)', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({
              status: 429,
              headers: { 'retry-after': 'invalid-format' },
            })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        // Default is 3000ms
        await vi.advanceTimersByTimeAsync(3000);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('does not retry on HTTP 422 Unprocessable Entity', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 422, statusText: 'Unprocessable Entity' })
      );

      await fetchUrl(TEST_URL, testConfig);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // [Implements: US-SC-001]
    it('does not retry on HTTP 405 Method Not Allowed', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 405, statusText: 'Method Not Allowed' })
      );

      await fetchUrl(TEST_URL, testConfig);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // [Implements: US-SC-001]
    it('handles HTTP 429 with Retry-After: 0', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({
              status: 429,
              headers: { 'retry-after': '0' },
            })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(0);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('Accept header includes multiple content types', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      await fetchUrl(TEST_URL, testConfig);

      const callArgs = mockFetch.mock.calls[0];
      const opts = callArgs?.[1] as Record<string, unknown> | undefined;
      const headers = opts?.headers as Record<string, string>;
      expect(headers['Accept']).toContain('text/html');
      expect(headers['Accept']).toContain('application/xml');
      expect(headers['Accept']).toContain('text/plain');
    });
  });

  // =========================================================================
  // RETRY BACKOFF TIMING PRECISION
  // =========================================================================

  describe('retry backoff timing precision', () => {
    function makeNetworkError(code: string): Error {
      const err = new TypeError('fetch failed');
      (err as unknown as { cause: { code: string; message: string } }).cause = {
        code,
        message: `${code}: network error`,
      };
      return err;
    }

    // [Implements: US-SC-010]
    it('waits exactly 1000ms before first transient retry', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });

        // At 999ms, the retry should not have happened yet
        await vi.advanceTimersByTimeAsync(999);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // At 1000ms, the retry fires
        await vi.advanceTimersByTimeAsync(1);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-010]
    it('waits exactly 3000ms before second transient retry', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
          .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });

        // First retry at 1000ms
        await vi.advanceTimersByTimeAsync(1000);
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // At 3999ms total (2999ms into second wait), no third call yet
        await vi.advanceTimersByTimeAsync(2999);
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // At 4000ms total, the third call fires
        await vi.advanceTimersByTimeAsync(1);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-010]
    it('logs retry succeeded message after transient retry', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        await promise;

        expect(getStderr()).toContain('retry succeeded');
        expect(getStderr()).toContain('attempt 2');
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-010]
    it('logs retry succeeded on attempt 3 after two transient retries', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockRejectedValueOnce(makeNetworkError('ETIMEDOUT'))
          .mockRejectedValueOnce(makeNetworkError('ETIMEDOUT'))
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(3000);
        await promise;

        expect(getStderr()).toContain('attempt 3');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // COMBINED RETRY SCENARIOS
  // =========================================================================

  describe('combined retry scenarios', () => {
    function makeNetworkError(code: string): Error {
      const err = new TypeError('fetch failed');
      (err as unknown as { cause: { code: string; message: string } }).cause = {
        code,
        message: `${code}: network error`,
      };
      return err;
    }

    // [Implements: US-SC-010]
    it('does not retry transient errors after exceeding max backoff slots', async () => {
      vi.useFakeTimers();
      try {
        // Three transient errors — the third retry slot doesn't exist (only 2 slots)
        mockFetch.mockRejectedValue(makeNetworkError('ECONNRESET'));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(3000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.statusCode).toBe(0);
        // 1 initial + 2 retries = 3 total calls
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-010]
    it('retries different transient error codes in sequence', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
          .mockRejectedValueOnce(makeNetworkError('ETIMEDOUT'))
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(3000);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-010]
    it('does NOT retry after a non-transient error following a transient error', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
          .mockRejectedValueOnce(
            (() => {
              const err = new TypeError('fetch failed');
              (err as unknown as { cause: { code: string; message: string } }).cause = {
                code: 'ENOTFOUND',
                message: 'getaddrinfo ENOTFOUND',
              };
              return err;
            })()
          );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.error).toContain('ENOTFOUND');
        // 1 initial + 1 transient retry = 2 total calls (ENOTFOUND is non-transient)
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // 5xx SERVER ERROR EDGE CASES
  // =========================================================================

  describe('5xx server error edge cases', () => {
    // [Implements: US-SC-001]
    it('retries on 500 Internal Server Error and succeeds on second attempt', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({ status: 500, statusText: 'Internal Server Error' })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'recovered' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(result.statusCode).toBe(200);
        expect(decodeBody(result.bodyBytes)).toBe('recovered');
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('includes URL in 500 error message after retries exhausted', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValue(
          makeResponse({ status: 500, statusText: 'Internal Server Error' })
        );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.error).toContain(TEST_URL);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('sets finalUrl to current URL on 5xx error', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValue(
          makeResponse({ status: 503, statusText: 'Service Unavailable' })
        );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.finalUrl).toBe(TEST_URL);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('retries once on 501 Not Implemented (5xx)', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({ status: 501, statusText: 'Not Implemented' })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('retries 5xx error once then succeeds', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({ status: 503, statusText: 'Service Unavailable' })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // 429 RATE LIMIT EDGE CASES
  // =========================================================================

  describe('429 rate limit edge cases', () => {
    // [Implements: US-SC-001]
    it('includes URL in 429 error message after retry exhausted', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValue(
          makeResponse({
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'retry-after': '1' },
          })
        );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.error).toContain(TEST_URL);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('sets finalUrl to current URL on 429 error', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValue(
          makeResponse({
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'retry-after': '1' },
          })
        );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.finalUrl).toBe(TEST_URL);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('parses large Retry-After delta-seconds value', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({
              status: 429,
              headers: { 'retry-after': '5' },
            })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(5000);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('handles 429 Retry-After as past HTTP-date (immediate retry)', async () => {
      vi.useFakeTimers();
      try {
        const pastDate = new Date(Date.now() - 10000).toUTCString();
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({
              status: 429,
              headers: { 'retry-after': pastDate },
            })
          )
          .mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }));

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(0);
        const result = await promise;

        expect(result.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('preserves body on successful 429 retry', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(
            makeResponse({
              status: 429,
              headers: { 'retry-after': '1' },
            })
          )
          .mockResolvedValueOnce(
            makeResponse({
              status: 200,
              headers: { 'content-type': 'text/html' },
              body: '<html>after retry</html>',
            })
          );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(decodeBody(result.bodyBytes)).toBe('<html>after retry</html>');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // TIMEOUT EDGE CASES
  // =========================================================================

  describe('timeout edge cases', () => {
    function makePendingFetch(): ReturnType<typeof vi.fn> {
      return vi.fn().mockImplementation(
        (url: string, init?: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              if (signal.aborted) {
                reject(new Error('The operation was aborted'));
              } else {
                signal.addEventListener('abort', () => {
                  reject(new Error('The operation was aborted'));
                });
              }
            }
          });
        }
      ) as ReturnType<typeof vi.fn>;
    }

    // [Implements: US-SC-006]
    it('sets redirectCount to 0 on timeout when no redirects occurred', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', makePendingFetch());

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.redirectCount).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-006]
    it('sets retryAfterMs to null on timeout', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', makePendingFetch());

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.retryAfterMs).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-006]
    it('sets contentType to null on timeout', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', makePendingFetch());

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.contentType).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-006]
    it('includes URL in the timeout stderr log', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', makePendingFetch());

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        await promise;

        expect(getStderr()).toContain(TEST_URL);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // REDIRECT WITH ERROR EDGE CASES
  // =========================================================================

  describe('redirect with error edge cases', () => {
    // [Implements: US-SC-003]
    it('returns error after redirect to 4xx page', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: 'https://example.com/redirected' },
          })
        )
        .mockResolvedValueOnce(
          makeResponse({ status: 404, statusText: 'Not Found' })
        );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
      expect(result.redirectCount).toBe(1);
      expect(result.finalUrl).toBe('https://example.com/redirected');
    });

    // [Implements: US-SC-003]
    it('preserves redirect count after redirect to error page', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({
            status: 301,
            headers: { location: 'https://example.com/r1' },
          })
        )
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: 'https://example.com/r2' },
          })
        )
        .mockResolvedValueOnce(
          makeResponse({ status: 403, statusText: 'Forbidden' })
        );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.redirectCount).toBe(2);
      expect(result.finalUrl).toBe('https://example.com/r2');
    });

    // [Implements: US-SC-003]
    it('redirect with relative path containing ../', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: '../sibling/page' },
          })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      const result = await fetchUrl('https://example.com/sub/current', testConfig);

      expect(result.success).toBe(true);
      expect(result.finalUrl).toBe('https://example.com/sibling/page');
    });

    // [Implements: US-SC-003]
    it('redirect with absolute path from subpath', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: '/absolute/path' },
          })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      const result = await fetchUrl('https://example.com/sub/deep/page', testConfig);

      expect(result.success).toBe(true);
      expect(result.finalUrl).toBe('https://example.com/absolute/path');
    });

    // [Implements: US-SC-003]
    it('redirect from HTTP to HTTPS', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({
            status: 301,
            headers: { location: 'https://example.com/secure' },
          })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'secure data' }));

      const result = await fetchUrl('http://example.com/page', testConfig);

      expect(result.success).toBe(true);
      expect(result.finalUrl).toBe('https://example.com/secure');
    });

    // [Implements: US-SC-003]
    it('redirect with port in Location header', async () => {
      mockFetch
        .mockResolvedValueOnce(
          makeResponse({
            status: 302,
            headers: { location: 'https://example.com:8443/page' },
          })
        )
        .mockResolvedValueOnce(makeResponse({ status: 200, body: 'data' }));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.finalUrl).toBe('https://example.com:8443/page');
    });

    // [Implements: US-SC-003]
    it('sets bodyBytes to null on redirect-without-Location error', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 302, statusText: 'Found', headers: {} })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.bodyBytes).toBeNull();
    });

    // [Implements: US-SC-003]
    it('sets contentType to null on redirect-without-Location error', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 302, statusText: 'Found', headers: {} })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(false);
      expect(result.contentType).toBeNull();
    });

    // [Implements: US-SC-003]
    it('redirect with empty Location header returns error', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 302, statusText: 'Found', headers: { location: '' } })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      // An empty Location header should not be treated as a valid redirect target
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(302);
    });
  });

  // =========================================================================
  // ERROR MESSAGE FORMAT VERIFICATION
  // =========================================================================

  describe('error message format verification', () => {
    // [Implements: US-SC-001]
    it('4xx error message follows "HTTP {code}: {statusText} ({url})" format', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 404, statusText: 'Not Found' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.error).toMatch(/HTTP 404: Not Found \(https:\/\/example\.com\/page\)/);
    });

    // [Implements: US-SC-001]
    it('5xx error message includes status code, text, and URL', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValue(
          makeResponse({ status: 502, statusText: 'Bad Gateway' })
        );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(result.error).toMatch(/HTTP 502: Bad Gateway/);
        expect(result.error).toContain(TEST_URL);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('429 error message includes status code and "Too Many Requests"', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValue(
          makeResponse({
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'retry-after': '1' },
          })
        );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 60000 });
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(result.error).toContain('HTTP 429');
        expect(result.error).toContain('Too Many Requests');
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-001]
    it('network error message includes error code and message', async () => {
      const err = new TypeError('fetch failed');
      const cause = new Error('getaddrinfo ENOTFOUND example.com');
      (cause as unknown as { code: string }).code = 'ENOTFOUND';
      (err as unknown as { cause: unknown }).cause = cause;
      mockFetch.mockRejectedValueOnce(err);

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.error).toContain('ENOTFOUND');
      expect(result.error).toContain('getaddrinfo');
    });

    // [Implements: US-SC-006]
    it('timeout error message follows "Fetch timed out after {N}ms" format', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation(
            (url: string, init?: { signal?: AbortSignal }) => {
              return new Promise((_resolve, reject) => {
                const signal = init?.signal;
                if (signal) {
                  signal.addEventListener('abort', () => {
                    reject(new Error('The operation was aborted'));
                  });
                }
              });
            }
          )
        );

        const promise = fetchUrl(TEST_URL, { ...testConfig, timeoutMs: 8000 });
        await vi.advanceTimersByTimeAsync(8000);
        const result = await promise;

        expect(result.error).toMatch(/^Fetch timed out after 8000ms$/);
      } finally {
        vi.useRealTimers();
      }
    });

    // [Implements: US-SC-010]
    it('error message uses UNKNOWN code for unclassified errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('weird'));

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.error).toMatch(/^UNKNOWN:/);
    });
  });

  // =========================================================================
  // 2xx STATUS CODE VARIATIONS
  // =========================================================================

  describe('2xx status code variations', () => {
    // [Implements: US-SC-001]
    it('handles 202 Accepted as success', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 202, body: 'accepted' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(202);
    });

    // [Implements: US-SC-001]
    it('handles 203 Non-Authoritative Information as success', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 203, body: 'data' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(203);
    });

    // [Implements: US-SC-001]
    it('handles 205 Reset Content as success', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 205, body: '' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(205);
    });

    // [Implements: US-SC-001]
    it('handles 206 Partial Content as success', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({
          status: 206,
          statusText: 'Partial Content',
          headers: { 'content-range': 'bytes 0-100/200' },
          body: 'partial data',
        })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(206);
    });

    // [Implements: US-SC-001]
    it('handles 226 IM Used as success', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse({ status: 226, body: 'im used data' })
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(226);
    });
  });

  // =========================================================================
  // DECOMPRESSION EDGE CASES
  // =========================================================================

  describe('decompression edge cases', () => {
    // [Implements: US-SC-001]
    it('decompresses gzip with mixed-case Content-Encoding "Gzip"', async () => {
      const originalText = 'Mixed case gzip test data';
      const compressed = gzipSync(Buffer.from(originalText));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: { 'content-encoding': 'Gzip' },
            body: compressed,
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe(originalText);
    });

    // [Implements: US-SC-001]
    it('decompresses deflate with uppercase "DEFLATE"', async () => {
      const originalText = 'Uppercase deflate test content';
      const compressed = deflateSync(Buffer.from(originalText));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: { 'content-encoding': 'DEFLATE' },
            body: compressed,
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe(originalText);
    });

    // [Implements: US-SC-001]
    it('decompresses brotli with uppercase "BR"', async () => {
      const originalText = 'Uppercase brotli test content for decompression';
      const compressed = brotliCompressSync(Buffer.from(originalText));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: { 'content-encoding': 'BR' },
            body: compressed,
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(decodeBody(result.bodyBytes)).toBe(originalText);
    });

    // [Implements: US-SC-001]
    it('does not decompress when Content-Encoding is "x-gzip" (unknown)', async () => {
      const body = 'plain text with x-gzip header';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: { 'content-encoding': 'x-gzip' },
            body,
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      // 'x-gzip' does not match 'gzip' substring check — returns original bytes
      expect(decodeBody(result.bodyBytes)).toBe(body);
    });

    // [Implements: US-SC-001]
    it('preserves binary data after successful decompression', async () => {
      const originalText = '<html>Binary-safe decompression test content here</html>';
      const compressed = gzipSync(Buffer.from(originalText));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeResponse({
            status: 200,
            headers: {
              'content-type': 'text/html',
              'content-encoding': 'gzip',
            },
            body: compressed,
          })
        )
      );

      const result = await fetchUrl(TEST_URL, testConfig);

      expect(result.success).toBe(true);
      expect(result.bodyBytes).toBeInstanceOf(Uint8Array);
      expect(result.bodyBytes!.byteLength).toBe(originalText.length);
    });
  });

  // =========================================================================
  // EXTERNAL SIGNAL CANCELLATION EDGE CASES
  // =========================================================================

  describe('external signal cancellation edge cases', () => {
    // [Implements: US-SC-001]
    it('handles multiple external abort controllers gracefully', async () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      controller1.abort();

      // Only the first controller's signal is passed — should abort
      const result = await fetchUrl(TEST_URL, testConfig, controller1.signal);

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
      // Second controller is unused — no crash
      expect(controller2.signal.aborted).toBe(false);
    });

    // [Implements: US-SC-001]
    it('external signal does not affect a separate fetchUrl call', async () => {
      const controller = new AbortController();

      // First call with the external signal (not aborted)
      mockFetch.mockResolvedValueOnce(makeResponse({ status: 200, body: 'first' }));
      const result1 = await fetchUrl(TEST_URL, testConfig, controller.signal);
      expect(result1.success).toBe(true);

      // Abort the signal after first call completes
      controller.abort();

      // Second call without the signal should be fine
      mockFetch.mockResolvedValueOnce(makeResponse({ status: 200, body: 'second' }));
      const result2 = await fetchUrl(TEST_URL, testConfig);
      expect(result2.success).toBe(true);
    });
  });
});
