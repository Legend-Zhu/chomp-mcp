/**
 * Integration tests for scraper.ts — the full scrape() orchestrator.
 *
 * Tests the end-to-end pipeline: URL validation rejection, successful
 * readability path, Puppeteer fallback trigger (mocked), non-HTML content
 * types (JSON/XML/text), binary rejection, timeout handling, error
 * isolation (never throws), ScrapeResult field correctness, and stderr
 * logging verification.
 *
 * [Spec: US-SC-001, US-SC-002, US-SC-004, US-SC-005, US-SC-008,
 *        US-SC-009, US-SC-011, US-SC-012, NFR-SC-005, NFR-SC-006]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock all internal component modules
// ---------------------------------------------------------------------------

vi.mock('../../../src/modules/scrape-extract/url-validator.js', () => ({
  validateUrl: vi.fn(),
}));

vi.mock('../../../src/modules/scrape-extract/http-fetcher.js', () => ({
  fetchUrl: vi.fn(),
}));

vi.mock('../../../src/modules/scrape-extract/encoding-detector.js', () => ({
  detectCharset: vi.fn(),
  decodeToUtf8: vi.fn(),
}));

vi.mock('../../../src/modules/scrape-extract/content-type-router.js', () => ({
  routeContent: vi.fn(),
}));

vi.mock('../../../src/modules/scrape-extract/content-extractor.js', () => ({
  extractWithReadability: vi.fn(),
}));

vi.mock('../../../src/modules/scrape-extract/puppeteer-renderer.js', () => ({
  renderPage: vi.fn(),
}));

vi.mock('../../../src/modules/scrape-extract/truncator.js', () => ({
  truncate: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import mocked functions for control
// ---------------------------------------------------------------------------

import { validateUrl } from '../../../src/modules/scrape-extract/url-validator.js';
import { fetchUrl } from '../../../src/modules/scrape-extract/http-fetcher.js';
import {
  detectCharset,
  decodeToUtf8,
} from '../../../src/modules/scrape-extract/encoding-detector.js';
import { routeContent } from '../../../src/modules/scrape-extract/content-type-router.js';
import { extractWithReadability } from '../../../src/modules/scrape-extract/content-extractor.js';
import { renderPage } from '../../../src/modules/scrape-extract/puppeteer-renderer.js';
import { truncate } from '../../../src/modules/scrape-extract/truncator.js';

// Import the function under test
import { scrape } from '../../../src/modules/scrape-extract/scraper.js';

// Import types
import type { ScrapeResult } from '../../../src/shared/types/scrape.js';
import type {
  FetchResult,
  ContentTypeResult,
  ExtractionOutput,
  RenderResult,
  TruncationResult,
  ValidationResult,
} from '../../../src/modules/scrape-extract/types.js';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockValidateUrl = vi.mocked(validateUrl);
const mockFetchUrl = vi.mocked(fetchUrl);
const mockDetectCharset = vi.mocked(detectCharset);
const mockDecodeToUtf8 = vi.mocked(decodeToUtf8);
const mockRouteContent = vi.mocked(routeContent);
const mockExtractWithReadability = vi.mocked(extractWithReadability);
const mockRenderPage = vi.mocked(renderPage);
const mockTruncate = vi.mocked(truncate);

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const TEST_URL = 'https://example.com/article';

function makeSuccessFetchResult(overrides?: Partial<FetchResult>): FetchResult {
  return {
    success: true,
    statusCode: 200,
    statusText: 'OK',
    contentType: 'text/html; charset=utf-8',
    bodyBytes: new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]),
    finalUrl: TEST_URL,
    redirectCount: 0,
    error: null,
    retryAfterMs: null,
    ...overrides,
  };
}

function makeErrorFetchResult(
  statusCode: number,
  statusText: string,
  overrides?: Partial<FetchResult>
): FetchResult {
  return {
    success: false,
    statusCode,
    statusText,
    contentType: null,
    bodyBytes: null,
    finalUrl: TEST_URL,
    redirectCount: 0,
    error: null,
    retryAfterMs: null,
    ...overrides,
  };
}

function makeHtmlRouteResult(
  overrides?: Partial<ContentTypeResult>
): ContentTypeResult {
  return {
    kind: 'html',
    textContent: null,
    extractionMethod: null,
    error: null,
    ...overrides,
  };
}

function makeReadabilitySuccess(
  overrides?: Partial<ExtractionOutput>
): ExtractionOutput {
  return {
    title: 'Test Article Title',
    textContent: 'A'.repeat(250),
    extractionMethod: 'readability',
    charCount: 250,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('scrape() — full pipeline orchestrator', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset all module mocks
    mockValidateUrl.mockReset();
    mockFetchUrl.mockReset();
    mockDetectCharset.mockReset();
    mockDecodeToUtf8.mockReset();
    mockRouteContent.mockReset();
    mockExtractWithReadability.mockReset();
    mockRenderPage.mockReset();
    mockTruncate.mockReset();

    // Set up spies for stderr/stdout
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    // --- Default mock implementations: successful HTML readability path ---

    mockValidateUrl.mockResolvedValue({ valid: true, error: null });

    mockFetchUrl.mockResolvedValue(makeSuccessFetchResult());

    mockDetectCharset.mockReturnValue('utf-8');

    mockDecodeToUtf8.mockReturnValue(
      '<html><body><p>Test content for extraction</p></body></html>'
    );

    mockRouteContent.mockReturnValue(makeHtmlRouteResult());

    mockExtractWithReadability.mockReturnValue(makeReadabilitySuccess());

    mockTruncate.mockImplementation(
      (text: string): TruncationResult => ({ text, truncated: false })
    );

    mockRenderPage.mockResolvedValue({
      success: false,
      html: null,
      error: 'Puppeteer not needed for default test',
    } satisfies RenderResult);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper: collect all stderr output
  function getStderrOutput(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  // Helper: collect all stdout output
  function getStdoutOutput(): string {
    return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  // =========================================================================
  // URL VALIDATION REJECTION
  // =========================================================================

  describe('URL validation rejection', () => {
    // [Implements: US-SC-001, US-SC-013, NFR-SC-005]
    it('returns failure for empty URL string', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'URL is required',
      });

      const result = await scrape('');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('URL is required');
        expect(result.url).toBe('');
        expect(result.finalUrl).toBeNull();
        expect(result.title).toBeNull();
        expect(result.textContent).toBeNull();
        expect(result.extractionMethod).toBeNull();
        expect(result.truncated).toBe(false);
        expect(result.contentLength).toBe(0);
      }
      // Fetcher should NOT be called when validation fails
      expect(mockFetchUrl).not.toHaveBeenCalled();
    });

    it('returns failure for malformed URL', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Invalid URL: not a url',
      });

      const result = await scrape('not a url');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid URL');
      }
      expect(mockFetchUrl).not.toHaveBeenCalled();
    });

    it('returns failure for non-HTTP scheme (ftp)', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Only HTTP(S) URLs are supported',
      });

      const result = await scrape('ftp://example.com/file');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Only HTTP(S) URLs are supported');
      }
    });

    it('returns failure for SSRF-blocked URL', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error:
          'URL resolves to a private or loopback address; blocked for security',
      });

      const result = await scrape('http://127.0.0.1/');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('private or loopback');
      }
    });

    it('uses validation error message when error is null', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('URL validation failed');
      }
    });
  });

  // =========================================================================
  // SUCCESSFUL READABILITY PATH
  // =========================================================================

  describe('successful Readability path', () => {
    // [Implements: US-SC-001, US-SC-002, US-SC-012]
    it('returns success with extractionMethod "readability"', async () => {
      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.extractionMethod).toBe('readability');
        expect(result.url).toBe(TEST_URL);
        expect(result.finalUrl).toBe(TEST_URL);
        expect(result.title).toBe('Test Article Title');
        expect(result.textContent).toBe('A'.repeat(250));
        expect(result.error).toBeNull();
      }
    });

    it('calls validateUrl before fetchUrl', async () => {
      await scrape(TEST_URL);

      expect(mockValidateUrl).toHaveBeenCalledTimes(1);
      expect(mockValidateUrl).toHaveBeenCalledWith(TEST_URL);
      expect(mockFetchUrl).toHaveBeenCalledTimes(1);
    });

    it('does NOT invoke Puppeteer fallback when Readability succeeds', async () => {
      await scrape(TEST_URL);

      expect(mockRenderPage).not.toHaveBeenCalled();
    });

    it('passes finalUrl to extractWithReadability', async () => {
      await scrape(TEST_URL);

      expect(mockExtractWithReadability).toHaveBeenCalledWith(
        expect.any(String),
        TEST_URL,
        expect.any(Number)
      );
    });

    it('passes correct minContentChars threshold (200) to Readability', async () => {
      await scrape(TEST_URL);

      expect(mockExtractWithReadability).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        200
      );
    });
  });

  // =========================================================================
  // PUPPETEER FALLBACK
  // =========================================================================

  describe('Puppeteer fallback', () => {
    // [Implements: US-SC-004, US-SC-012]
    it('triggers Puppeteer when Readability yields < 200 chars', async () => {
      // First call: Readability fails (too short)
      mockExtractWithReadability.mockReturnValueOnce({
        title: '',
        textContent: 'short',
        extractionMethod: 'readability-failed',
        charCount: 5,
      });
      // Second call: Readability on rendered HTML succeeds
      mockExtractWithReadability.mockReturnValueOnce({
        title: 'Rendered Title',
        textContent: 'B'.repeat(250),
        extractionMethod: 'readability',
        charCount: 250,
      });

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body><p>Rendered content here</p></body></html>',
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.extractionMethod).toBe('puppeteer');
        expect(result.title).toBe('Rendered Title');
        expect(result.textContent).toBe('B'.repeat(250));
      }
      // Verify Puppeteer was called
      expect(mockRenderPage).toHaveBeenCalledTimes(1);
      expect(mockRenderPage).toHaveBeenCalledWith(TEST_URL, expect.any(Number));
    });

    it('logs FALLBACK message when Puppeteer is triggered', async () => {
      mockExtractWithReadability
        .mockReturnValueOnce({
          title: '',
          textContent: 'short',
          extractionMethod: 'readability-failed',
          charCount: 5,
        })
        .mockReturnValueOnce(makeReadabilitySuccess());

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });

      await scrape(TEST_URL);

      expect(getStderrOutput()).toContain('[scrape] FALLBACK');
      expect(getStderrOutput()).toContain('puppeteer');
    });

    it('returns failure when Puppeteer render fails', async () => {
      mockExtractWithReadability.mockReturnValue({
        title: '',
        textContent: 'short',
        extractionMethod: 'readability-failed',
        charCount: 5,
      });

      mockRenderPage.mockResolvedValue({
        success: false,
        html: null,
        error: 'Puppeteer rendering failed: No browser found',
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Failed to extract meaningful content');
      }
    });

    it('returns failure when Puppeteer renders but extraction still < 200 chars', async () => {
      mockExtractWithReadability
        .mockReturnValueOnce({
          title: '',
          textContent: 'short1',
          extractionMethod: 'readability-failed',
          charCount: 6,
        })
        .mockReturnValueOnce({
          title: '',
          textContent: 'short2',
          extractionMethod: 'readability-failed',
          charCount: 6,
        });

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Short</body></html>',
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Failed to extract meaningful content');
      }
    });

    it('returns failure when Puppeteer render succeeds but html is null', async () => {
      mockExtractWithReadability.mockReturnValue({
        title: '',
        textContent: 'short',
        extractionMethod: 'readability-failed',
        charCount: 5,
      });

      mockRenderPage.mockResolvedValue({
        success: true,
        html: null,
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // NON-HTML CONTENT TYPES
  // =========================================================================

  describe('non-HTML content types', () => {
    // [Implements: US-SC-009, US-SC-012]
    it('returns success with extractionMethod "json" for application/json', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'json',
        textContent: '{\n  "key": "value"\n}',
        extractionMethod: 'json',
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.extractionMethod).toBe('json');
        expect(result.textContent).toBe('{\n  "key": "value"\n}');
        expect(result.title).toBe('');
      }
    });

    it('returns success with extractionMethod "xml" for application/xml', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'xml',
        textContent: 'Hello World',
        extractionMethod: 'xml',
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.extractionMethod).toBe('xml');
        expect(result.textContent).toBe('Hello World');
      }
    });

    it('returns success with extractionMethod "raw-text" for text/plain', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'text',
        textContent: 'This is plain text content.',
        extractionMethod: 'raw-text',
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.extractionMethod).toBe('raw-text');
        expect(result.textContent).toBe('This is plain text content.');
      }
    });

    it('does NOT invoke Readability or Puppeteer for non-HTML types', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'json',
        textContent: '{"key": "value"}',
        extractionMethod: 'json',
        error: null,
      });

      await scrape(TEST_URL);

      expect(mockExtractWithReadability).not.toHaveBeenCalled();
      expect(mockRenderPage).not.toHaveBeenCalled();
    });

    it('returns failure when non-HTML textContent is empty', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'text',
        textContent: '',
        extractionMethod: 'raw-text',
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Failed to extract meaningful content');
      }
    });

    it('applies truncation to non-HTML content', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'json',
        textContent: 'X'.repeat(10000),
        extractionMethod: 'json',
        error: null,
      });

      mockTruncate.mockReturnValue({
        text: 'Y'.repeat(8000),
        truncated: true,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.truncated).toBe(true);
        expect(result.contentLength).toBe(8000);
      }
    });
  });

  // =========================================================================
  // BINARY REJECTION
  // =========================================================================

  describe('binary content rejection', () => {
    // [Implements: US-SC-009, US-SC-012, NFR-SC-005]
    it('returns failure for application/pdf', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'binary',
        textContent: null,
        extractionMethod: null,
        error: 'Unsupported content type: application/pdf',
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Unsupported content type: application/pdf');
      }
    });

    it('returns failure for image/png', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'binary',
        textContent: null,
        extractionMethod: null,
        error: 'Unsupported content type: image/png',
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unsupported content type');
      }
    });

    it('returns failure for application/octet-stream', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'binary',
        textContent: null,
        extractionMethod: null,
        error: 'Unsupported content type: application/octet-stream',
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
    });

    it('does NOT attempt Readability or Puppeteer for binary content', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'binary',
        textContent: null,
        extractionMethod: null,
        error: 'Unsupported content type: application/pdf',
      });

      await scrape(TEST_URL);

      expect(mockExtractWithReadability).not.toHaveBeenCalled();
      expect(mockRenderPage).not.toHaveBeenCalled();
    });

    it('uses fallback error when routed error is null for binary', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'unsupported',
        textContent: null,
        extractionMethod: null,
        error: null,
      });

      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ contentType: 'application/unknown' })
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unsupported content type');
      }
    });
  });

  // =========================================================================
  // HTTP ERROR HANDLING
  // =========================================================================

  describe('HTTP error handling', () => {
    // [Implements: US-SC-005, US-SC-012, NFR-SC-005]
    it('returns failure with "Page not found" for HTTP 404', async () => {
      mockFetchUrl.mockResolvedValue(
        makeErrorFetchResult(404, 'Not Found')
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('HTTP 404');
        expect(result.error).toContain('Page not found');
        expect(result.error).toContain(TEST_URL);
      }
    });

    it('returns failure with auth suggestion for HTTP 401', async () => {
      mockFetchUrl.mockResolvedValue(
        makeErrorFetchResult(401, 'Unauthorized')
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('HTTP 401');
        expect(result.error).toContain(
          'Page requires authentication or blocks bots'
        );
      }
    });

    it('returns failure with auth suggestion for HTTP 403', async () => {
      mockFetchUrl.mockResolvedValue(makeErrorFetchResult(403, 'Forbidden'));

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('HTTP 403');
        expect(result.error).toContain(
          'Page requires authentication or blocks bots'
        );
      }
    });

    it('returns failure with "Too Many Requests" for HTTP 429', async () => {
      mockFetchUrl.mockResolvedValue(
        makeErrorFetchResult(429, 'Too Many Requests')
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('HTTP 429');
        expect(result.error).toContain('Too Many Requests');
      }
    });

    it('returns failure with status text for HTTP 500', async () => {
      mockFetchUrl.mockResolvedValue(
        makeErrorFetchResult(500, 'Internal Server Error')
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('HTTP 500');
        expect(result.error).toContain('Internal Server Error');
      }
    });

    it('includes finalUrl in HTTP error message', async () => {
      mockFetchUrl.mockResolvedValue(
        makeErrorFetchResult(404, 'Not Found', {
          finalUrl: 'https://example.com/redirected',
        })
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('https://example.com/redirected');
      }
    });

    it('preserves finalUrl from fetch result in failure ScrapeResult', async () => {
      mockFetchUrl.mockResolvedValue(
        makeErrorFetchResult(403, 'Forbidden', {
          finalUrl: 'https://example.com/forbidden',
        })
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.finalUrl).toBe('https://example.com/forbidden');
      }
    });

    it('does NOT attempt content extraction on HTTP error', async () => {
      mockFetchUrl.mockResolvedValue(
        makeErrorFetchResult(404, 'Not Found')
      );

      await scrape(TEST_URL);

      expect(mockDetectCharset).not.toHaveBeenCalled();
      expect(mockDecodeToUtf8).not.toHaveBeenCalled();
      expect(mockRouteContent).not.toHaveBeenCalled();
      expect(mockExtractWithReadability).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TIMEOUT AND NETWORK ERROR HANDLING
  // =========================================================================

  describe('timeout and network error handling', () => {
    // [Implements: US-SC-005, US-SC-006, US-SC-012, NFR-SC-005]
    it('returns failure for fetch timeout (statusCode 0)', async () => {
      mockFetchUrl.mockResolvedValue({
        success: false,
        statusCode: 0,
        statusText: '',
        contentType: null,
        bodyBytes: null,
        finalUrl: null,
        redirectCount: 0,
        error: 'Fetch timed out after 15000ms',
        retryAfterMs: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Fetch timed out');
        expect(result.finalUrl).toBeNull();
      }
    });

    it('returns failure for network error (ECONNRESET)', async () => {
      mockFetchUrl.mockResolvedValue({
        success: false,
        statusCode: 0,
        statusText: '',
        contentType: null,
        bodyBytes: null,
        finalUrl: null,
        redirectCount: 0,
        error: 'ECONNRESET: socket hang up',
        retryAfterMs: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('ECONNRESET');
      }
    });

    it('uses "Unknown fetch error" when error is null and statusCode is 0', async () => {
      mockFetchUrl.mockResolvedValue({
        success: false,
        statusCode: 0,
        statusText: '',
        contentType: null,
        bodyBytes: null,
        finalUrl: null,
        redirectCount: 0,
        error: null,
        retryAfterMs: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Unknown fetch error');
      }
    });

    it('returns failure when bodyBytes is null', async () => {
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ bodyBytes: null })
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Failed to extract meaningful content');
      }
    });

    it('returns failure when bodyBytes is empty (length 0)', async () => {
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ bodyBytes: new Uint8Array(0) })
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Failed to extract meaningful content');
      }
    });
  });

  // =========================================================================
  // ERROR ISOLATION — scrape() never throws
  // =========================================================================

  describe('error isolation (never throws)', () => {
    // [Implements: NFR-SC-005]
    it('catches error from validateUrl and returns failure result', async () => {
      mockValidateUrl.mockRejectedValue(new Error('DNS explosion'));

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('DNS explosion');
      }
    });

    it('catches error from fetchUrl and returns failure result', async () => {
      mockFetchUrl.mockRejectedValue(new Error('Network catastrophe'));

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Network catastrophe');
      }
    });

    it('catches error from routeContent and returns failure result', async () => {
      mockRouteContent.mockImplementation(() => {
        throw new Error('Routing failure');
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Routing failure');
      }
    });

    it('catches error from extractWithReadability and returns failure result', async () => {
      mockExtractWithReadability.mockImplementation(() => {
        throw new Error('JSDOM crash');
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('JSDOM crash');
      }
    });

    it('catches error from renderPage and returns failure result', async () => {
      mockExtractWithReadability.mockReturnValue({
        title: '',
        textContent: 'short',
        extractionMethod: 'readability-failed',
        charCount: 5,
      });

      mockRenderPage.mockRejectedValue(new Error('Browser launch failed'));

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
    });

    it('catches non-Error thrown values and converts to string', async () => {
      mockValidateUrl.mockRejectedValue('string error');

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('string error');
      }
    });

    it('catches non-Error thrown numbers', async () => {
      mockValidateUrl.mockRejectedValue(42);

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('42');
      }
    });
  });

  // =========================================================================
  // ScrapeResult FIELD CORRECTNESS
  // =========================================================================

  describe('ScrapeResult field correctness', () => {
    // [Implements: US-SC-012, DC-SC-001]
    it('success result has all required fields with correct types', async () => {
      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.url).toBe('string');
        expect(typeof result.finalUrl).toBe('string');
        expect(typeof result.title).toBe('string');
        expect(typeof result.textContent).toBe('string');
        expect(typeof result.extractionMethod).toBe('string');
        expect(typeof result.truncated).toBe('boolean');
        expect(typeof result.contentLength).toBe('number');
        expect(typeof result.elapsedMs).toBe('number');
        expect(result.error).toBeNull();
      }
    });

    it('failure result has all required fields with correct types', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Invalid URL',
      });

      const result = await scrape('bad-url');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(typeof result.url).toBe('string');
        expect(result.finalUrl).toBeNull();
        expect(result.title).toBeNull();
        expect(result.textContent).toBeNull();
        expect(result.extractionMethod).toBeNull();
        expect(result.truncated).toBe(false);
        expect(typeof result.contentLength).toBe('number');
        expect(result.contentLength).toBe(0);
        expect(typeof result.elapsedMs).toBe('number');
        expect(typeof result.error).toBe('string');
      }
    });

    it('elapsedMs is non-negative on success', async () => {
      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('elapsedMs is non-negative on failure', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Invalid URL',
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('contentLength equals textContent.length on success', async () => {
      const text = 'A'.repeat(250);
      mockExtractWithReadability.mockReturnValue({
        title: 'Title',
        textContent: text,
        extractionMethod: 'readability',
        charCount: text.length,
      });
      mockTruncate.mockReturnValue({ text, truncated: false });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.contentLength).toBe(result.textContent.length);
      }
    });

    it('truncated is true when truncate returns truncated: true', async () => {
      mockTruncate.mockReturnValue({
        text: 'truncated text…[truncated]',
        truncated: true,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.truncated).toBe(true);
        expect(result.textContent).toBe('truncated text…[truncated]');
        expect(result.contentLength).toBe('truncated text…[truncated]'.length);
      }
    });

    it('truncated is false when truncate returns truncated: false', async () => {
      const text = 'A'.repeat(100);
      mockTruncate.mockReturnValue({ text, truncated: false });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.truncated).toBe(false);
      }
    });

    it('url field always matches the input URL', async () => {
      const customUrl = 'https://custom.example.com/page';
      const result = await scrape(customUrl);

      expect(result.url).toBe(customUrl);
    });

    it('url field matches input even on failure', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Bad URL',
      });

      const result = await scrape('https://fail.example.com/');

      expect(result.url).toBe('https://fail.example.com/');
    });
  });

  // =========================================================================
  // STDERR LOGGING VERIFICATION
  // =========================================================================

  describe('stderr logging', () => {
    // [Implements: US-SC-011, NFR-SC-006]
    it('logs START message at the beginning of every scrape', async () => {
      await scrape(TEST_URL);

      const output = getStderrOutput();
      expect(output).toContain('[scrape] START');
      expect(output).toContain(TEST_URL);
    });

    it('logs OK message on successful Readability extraction', async () => {
      await scrape(TEST_URL);

      const output = getStderrOutput();
      expect(output).toContain('[scrape] OK');
      expect(output).toContain('method=readability');
      expect(output).toContain('chars=');
      expect(output).toContain('truncated=false');
      expect(output).toContain('ms=');
    });

    it('logs OK message with method=puppeteer on Puppeteer success', async () => {
      mockExtractWithReadability
        .mockReturnValueOnce({
          title: '',
          textContent: 'short',
          extractionMethod: 'readability-failed',
          charCount: 5,
        })
        .mockReturnValueOnce(makeReadabilitySuccess({ title: 'Puppet Title' }));

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });

      await scrape(TEST_URL);

      const output = getStderrOutput();
      expect(output).toContain('[scrape] OK');
      expect(output).toContain('method=puppeteer');
    });

    it('logs FAIL message on URL validation failure', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Invalid URL',
      });

      await scrape('bad-url');

      const output = getStderrOutput();
      expect(output).toContain('[scrape] FAIL');
      expect(output).toContain('bad-url');
    });

    it('logs FAIL message on HTTP error', async () => {
      mockFetchUrl.mockResolvedValue(makeErrorFetchResult(404, 'Not Found'));

      await scrape(TEST_URL);

      const output = getStderrOutput();
      expect(output).toContain('[scrape] FAIL');
      expect(output).toContain('HTTP 404');
    });

    it('logs FAIL message on fetch timeout', async () => {
      mockFetchUrl.mockResolvedValue({
        success: false,
        statusCode: 0,
        statusText: '',
        contentType: null,
        bodyBytes: null,
        finalUrl: null,
        redirectCount: 0,
        error: 'Fetch timed out after 15000ms',
        retryAfterMs: null,
      });

      await scrape(TEST_URL);

      const output = getStderrOutput();
      expect(output).toContain('[scrape] FAIL');
      expect(output).toContain('Fetch timed out');
    });

    it('logs FAIL message on binary content', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'binary',
        textContent: null,
        extractionMethod: null,
        error: 'Unsupported content type: application/pdf',
      });

      await scrape(TEST_URL);

      const output = getStderrOutput();
      expect(output).toContain('[scrape] FAIL');
      expect(output).toContain('Unsupported content type');
    });

    it('never writes to stdout', async () => {
      await scrape(TEST_URL);

      const stdout = getStdoutOutput();
      expect(stdout).not.toContain('[scrape]');
    });

    it('never writes to stdout on failure', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Invalid URL',
      });

      await scrape('bad-url');

      const stdout = getStdoutOutput();
      expect(stdout).not.toContain('[scrape]');
    });

    it('never writes to stdout on Puppeteer fallback', async () => {
      mockExtractWithReadability
        .mockReturnValueOnce({
          title: '',
          textContent: 'short',
          extractionMethod: 'readability-failed',
          charCount: 5,
        })
        .mockReturnValueOnce(makeReadabilitySuccess());

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });

      await scrape(TEST_URL);

      const stdout = getStdoutOutput();
      expect(stdout).not.toContain('[scrape]');
    });

    it('START is always logged regardless of outcome', async () => {
      mockFetchUrl.mockResolvedValue(makeErrorFetchResult(500, 'Server Error'));

      await scrape(TEST_URL);

      const output = getStderrOutput();
      expect(output).toContain('[scrape] START');
      expect(output).toContain('[scrape] FAIL');
    });
  });

  // =========================================================================
  // PIPELINE FLOW VERIFICATION
  // =========================================================================

  describe('pipeline flow verification', () => {
    // [Implements: US-SC-001, US-SC-002, US-SC-007]
    it('calls detectCharset with contentType and bodyBytes from fetch', async () => {
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({
          contentType: 'text/html; charset=utf-8',
          bodyBytes: new Uint8Array([1, 2, 3]),
        })
      );

      await scrape(TEST_URL);

      expect(mockDetectCharset).toHaveBeenCalledWith(
        'text/html; charset=utf-8',
        expect.any(Uint8Array)
      );
    });

    it('calls decodeToUtf8 with bodyBytes, charset, and url', async () => {
      mockDetectCharset.mockReturnValue('iso-8859-1');

      await scrape(TEST_URL);

      expect(mockDecodeToUtf8).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        'iso-8859-1',
        TEST_URL
      );
    });

    it('calls routeContent with contentType and decoded bodyText', async () => {
      const decodedBody = '<html><body>Decoded</body></html>';
      mockDecodeToUtf8.mockReturnValue(decodedBody);
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ contentType: 'text/html' })
      );

      await scrape(TEST_URL);

      expect(mockRouteContent).toHaveBeenCalledWith('text/html', decodedBody);
    });

    it('calls truncate with extracted text and maxContentChars', async () => {
      mockExtractWithReadability.mockReturnValue({
        title: 'Title',
        textContent: 'content to truncate',
        extractionMethod: 'readability',
        charCount: 20,
      });

      await scrape(TEST_URL);

      expect(mockTruncate).toHaveBeenCalledWith(
        'content to truncate',
        expect.any(Number)
      );
    });

    it('passes ScrapeOptions.maxContentChars to truncate', async () => {
      await scrape(TEST_URL, { maxContentChars: 5000 });

      expect(mockTruncate).toHaveBeenCalledWith(
        expect.any(String),
        5000
      );
    });

    it('passes ScrapeOptions.timeoutMs to renderPage', async () => {
      mockExtractWithReadability.mockReturnValue({
        title: '',
        textContent: 'short',
        extractionMethod: 'readability-failed',
        charCount: 5,
      });
      mockExtractWithReadability.mockReturnValueOnce({
        title: '',
        textContent: 'short',
        extractionMethod: 'readability-failed',
        charCount: 5,
      });
      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });
      mockExtractWithReadability.mockReturnValue({
        title: 'Title',
        textContent: 'B'.repeat(250),
        extractionMethod: 'readability',
        charCount: 250,
      });

      await scrape(TEST_URL, { timeoutMs: 5000 });

      expect(mockRenderPage).toHaveBeenCalledWith(TEST_URL, 5000);
    });

    it('passes signal option to fetchUrl', async () => {
      const controller = new AbortController();

      await scrape(TEST_URL, { signal: controller.signal });

      expect(mockFetchUrl).toHaveBeenCalledWith(
        TEST_URL,
        expect.any(Object),
        controller.signal
      );
    });
  });

  // =========================================================================
  // ADDITIONAL EDGE CASES
  // =========================================================================

  describe('additional edge cases', () => {
    // [Implements: US-SC-012, NFR-SC-005]
    it('handles finalUrl different from input URL after redirect', async () => {
      const redirectedUrl = 'https://example.com/final-destination';
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ finalUrl: redirectedUrl })
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.url).toBe(TEST_URL);
        expect(result.finalUrl).toBe(redirectedUrl);
      }
    });

    it('uses finalUrl for extractWithReadability (not input URL)', async () => {
      const redirectedUrl = 'https://example.com/redirected';
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ finalUrl: redirectedUrl })
      );

      await scrape(TEST_URL);

      expect(mockExtractWithReadability).toHaveBeenCalledWith(
        expect.any(String),
        redirectedUrl,
        expect.any(Number)
      );
    });

    it('non-HTML success result has empty string title', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'json',
        textContent: '{"data": "value"}',
        extractionMethod: 'json',
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.title).toBe('');
      }
    });

    it('OK log includes correct chars count matching contentLength', async () => {
      const text = 'X'.repeat(300);
      mockExtractWithReadability.mockReturnValue({
        title: 'Title',
        textContent: text,
        extractionMethod: 'readability',
        charCount: 300,
      });
      mockTruncate.mockReturnValue({ text, truncated: false });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        const output = getStderrOutput();
        expect(output).toContain(`chars=${result.contentLength}`);
      }
    });

    it('OK log includes truncated=true when content is truncated', async () => {
      mockTruncate.mockReturnValue({
        text: 'truncated',
        truncated: true,
      });

      await scrape(TEST_URL);

      const output = getStderrOutput();
      expect(output).toContain('truncated=true');
    });

    it('OK log includes elapsedMs as a number', async () => {
      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        const output = getStderrOutput();
        expect(output).toContain(`ms=${result.elapsedMs}`);
      }
    });

    it('FAIL log includes elapsedMs on HTTP error', async () => {
      mockFetchUrl.mockResolvedValue(makeErrorFetchResult(500, 'Server Error'));

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        const output = getStderrOutput();
        expect(output).toContain(`ms=${result.elapsedMs}`);
      }
    });

    it('does not call truncate on URL validation failure', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Invalid URL',
      });

      await scrape('bad-url');

      expect(mockTruncate).not.toHaveBeenCalled();
    });

    it('does not call truncate on HTTP error', async () => {
      mockFetchUrl.mockResolvedValue(makeErrorFetchResult(404, 'Not Found'));

      await scrape(TEST_URL);

      expect(mockTruncate).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // CONFIG RESOLUTION (BG-SC-004)
  // =========================================================================

  describe('config resolution (BG-SC-004)', () => {
    // [Implements: BG-SC-004, DC-SC-005]
    it('uses default timeoutMs when no env or options provided', async () => {
      delete process.env['SCRAPE_TIMEOUT_MS'];

      await scrape(TEST_URL);

      expect(mockFetchUrl).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({ timeoutMs: 15_000 }),
        undefined
      );
    });

    it('uses default maxContentChars when no env or options provided', async () => {
      delete process.env['MAX_CONTENT_CHARS'];

      await scrape(TEST_URL);

      expect(mockTruncate).toHaveBeenCalledWith(
        expect.any(String),
        8_000
      );
    });

    it('resolves timeoutMs from SCRAPE_TIMEOUT_MS env var', async () => {
      process.env['SCRAPE_TIMEOUT_MS'] = '12000';
      try {
        await scrape(TEST_URL);

        expect(mockFetchUrl).toHaveBeenCalledWith(
          TEST_URL,
          expect.objectContaining({ timeoutMs: 12_000 }),
          undefined
        );
      } finally {
        delete process.env['SCRAPE_TIMEOUT_MS'];
      }
    });

    it('resolves maxContentChars from MAX_CONTENT_CHARS env var', async () => {
      process.env['MAX_CONTENT_CHARS'] = '4000';
      try {
        await scrape(TEST_URL);

        expect(mockTruncate).toHaveBeenCalledWith(
          expect.any(String),
          4_000
        );
      } finally {
        delete process.env['MAX_CONTENT_CHARS'];
      }
    });

    it('ScrapeOptions.timeoutMs overrides env var', async () => {
      process.env['SCRAPE_TIMEOUT_MS'] = '12000';
      try {
        await scrape(TEST_URL, { timeoutMs: 7000 });

        expect(mockFetchUrl).toHaveBeenCalledWith(
          TEST_URL,
          expect.objectContaining({ timeoutMs: 7_000 }),
          undefined
        );
      } finally {
        delete process.env['SCRAPE_TIMEOUT_MS'];
      }
    });

    it('ScrapeOptions.maxContentChars overrides env var', async () => {
      process.env['MAX_CONTENT_CHARS'] = '4000';
      try {
        await scrape(TEST_URL, { maxContentChars: 2000 });

        expect(mockTruncate).toHaveBeenCalledWith(
          expect.any(String),
          2_000
        );
      } finally {
        delete process.env['MAX_CONTENT_CHARS'];
      }
    });

    it('falls back to default timeout when SCRAPE_TIMEOUT_MS is invalid', async () => {
      process.env['SCRAPE_TIMEOUT_MS'] = 'not-a-number';
      try {
        await scrape(TEST_URL);

        expect(mockFetchUrl).toHaveBeenCalledWith(
          TEST_URL,
          expect.objectContaining({ timeoutMs: 15_000 }),
          undefined
        );
      } finally {
        delete process.env['SCRAPE_TIMEOUT_MS'];
      }
    });

    it('falls back to default timeout when SCRAPE_TIMEOUT_MS is zero', async () => {
      process.env['SCRAPE_TIMEOUT_MS'] = '0';
      try {
        await scrape(TEST_URL);

        expect(mockFetchUrl).toHaveBeenCalledWith(
          TEST_URL,
          expect.objectContaining({ timeoutMs: 15_000 }),
          undefined
        );
      } finally {
        delete process.env['SCRAPE_TIMEOUT_MS'];
      }
    });

    it('falls back to default timeout when SCRAPE_TIMEOUT_MS is negative', async () => {
      process.env['SCRAPE_TIMEOUT_MS'] = '-5000';
      try {
        await scrape(TEST_URL);

        expect(mockFetchUrl).toHaveBeenCalledWith(
          TEST_URL,
          expect.objectContaining({ timeoutMs: 15_000 }),
          undefined
        );
      } finally {
        delete process.env['SCRAPE_TIMEOUT_MS'];
      }
    });

    it('computes maxTotalTimeoutMs as 2x timeoutMs', async () => {
      // We verify indirectly: if maxTotalTimeoutMs is 2*timeoutMs,
      // then a Readability failure + Puppeteer with a custom timeout should
      // trigger the timeout check. Use a very large timeout so it won't trigger.
      await scrape(TEST_URL, { timeoutMs: 15_000 });

      // The config passed to fetchUrl should contain maxTotalTimeoutMs = 30000
      expect(mockFetchUrl).toHaveBeenCalledWith(
        TEST_URL,
        expect.objectContaining({ maxTotalTimeoutMs: 30_000 }),
        undefined
      );
    });

    it('passes resolved config to fetchUrl', async () => {
      await scrape(TEST_URL);

      const configArg = mockFetchUrl.mock.calls[0]?.[1];
      expect(configArg).toEqual(
        expect.objectContaining({
          timeoutMs: expect.any(Number),
          maxContentChars: expect.any(Number),
          maxRedirects: 5,
          minContentChars: 200,
          maxTotalTimeoutMs: expect.any(Number),
        })
      );
    });

    it('config has minContentChars constant value of 200', async () => {
      await scrape(TEST_URL);

      expect(mockExtractWithReadability).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        200
      );
    });

    it('config has maxRedirects constant value of 5', async () => {
      await scrape(TEST_URL);

      const configArg = mockFetchUrl.mock.calls[0]?.[1];
      expect(configArg).toEqual(
        expect.objectContaining({ maxRedirects: 5 })
      );
    });
  });

  // =========================================================================
  // PUPPETEER TIMEOUT BEFORE FALLBACK
  // =========================================================================

  describe('Puppeteer total timeout before fallback', () => {
    // [Implements: US-SC-006, NFR-SC-005]
    it('returns failure when total timeout exceeded before Puppeteer', async () => {
      // Force Readability to fail so we enter the fallback path
      mockExtractWithReadability.mockReturnValue({
        title: '',
        textContent: 'short',
        extractionMethod: 'readability-failed',
        charCount: 5,
      });

      // Use vi.useFakeTimers to make Date.now() advance beyond maxTotalTimeoutMs
      vi.useFakeTimers();
      try {
        // Start with real timers for async setup
        const scrapePromise = scrape(TEST_URL);

        // Advance fake timer past the maxTotalTimeoutMs (30000ms by default)
        // After validation + fetch (which are already resolved mocks), the
        // elapsedBeforeFallback check should fail
        vi.advanceTimersByTime(31_000);

        const result = await scrapePromise;

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('timeout');
        }
        // Puppeteer should NOT have been called because timeout was exceeded
        expect(mockRenderPage).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('logs timeout message when total timeout exceeded before Puppeteer', async () => {
      mockExtractWithReadability.mockReturnValue({
        title: '',
        textContent: 'short',
        extractionMethod: 'readability-failed',
        charCount: 5,
      });

      vi.useFakeTimers();
      try {
        const scrapePromise = scrape(TEST_URL);

        vi.advanceTimersByTime(31_000);

        await scrapePromise;

        const output = getStderrOutput();
        expect(output).toContain('[scrape] timeout:');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // PUPPETEER SUCCESS WITH TRUNCATED CONTENT
  // =========================================================================

  describe('Puppeteer success with truncation', () => {
    // [Implements: US-SC-004, US-SC-008, US-SC-012]
    it('truncates Puppeteer-extracted content when it exceeds maxContentChars', async () => {
      mockExtractWithReadability
        .mockReturnValueOnce({
          title: '',
          textContent: 'short',
          extractionMethod: 'readability-failed',
          charCount: 5,
        })
        .mockReturnValueOnce({
          title: 'Puppet Title',
          textContent: 'Z'.repeat(250),
          extractionMethod: 'readability',
          charCount: 250,
        });

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });

      const truncatedText = 'W'.repeat(5000);
      mockTruncate.mockReturnValue({
        text: truncatedText,
        truncated: true,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.extractionMethod).toBe('puppeteer');
        expect(result.truncated).toBe(true);
        expect(result.textContent).toBe(truncatedText);
        expect(result.contentLength).toBe(truncatedText.length);
      }
    });

    it('logs OK with method=puppeteer and truncated=true on truncated Puppeteer content', async () => {
      mockExtractWithReadability
        .mockReturnValueOnce({
          title: '',
          textContent: 'short',
          extractionMethod: 'readability-failed',
          charCount: 5,
        })
        .mockReturnValueOnce({
          title: 'Title',
          textContent: 'Z'.repeat(250),
          extractionMethod: 'readability',
          charCount: 250,
        });

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });

      mockTruncate.mockReturnValue({
        text: 'truncated puppet',
        truncated: true,
      });

      await scrape(TEST_URL);

      const output = getStderrOutput();
      expect(output).toContain('[scrape] OK');
      expect(output).toContain('method=puppeteer');
      expect(output).toContain('truncated=true');
    });

    it('passes maxContentChars to truncate for Puppeteer path', async () => {
      mockExtractWithReadability
        .mockReturnValueOnce({
          title: '',
          textContent: 'short',
          extractionMethod: 'readability-failed',
          charCount: 5,
        })
        .mockReturnValueOnce({
          title: 'Title',
          textContent: 'Z'.repeat(250),
          extractionMethod: 'readability',
          charCount: 250,
        });

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });

      await scrape(TEST_URL, { maxContentChars: 3000 });

      expect(mockTruncate).toHaveBeenCalledWith(
        expect.any(String),
        3_000
      );
    });

    it('truncation is called with puppeteer content text', async () => {
      const puppetText = 'P'.repeat(300);
      mockExtractWithReadability
        .mockReturnValueOnce({
          title: '',
          textContent: 'short',
          extractionMethod: 'readability-failed',
          charCount: 5,
        })
        .mockReturnValueOnce({
          title: 'Title',
          textContent: puppetText,
          extractionMethod: 'readability',
          charCount: puppetText.length,
        });

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });

      mockTruncate.mockReturnValue({ text: puppetText, truncated: false });

      await scrape(TEST_URL);

      // The second truncate call (first is for Readability path — no, wait:
      // Readability fails, so the first truncate is for Puppeteer content)
      expect(mockTruncate).toHaveBeenCalledWith(
        puppetText,
        expect.any(Number)
      );
    });
  });

  // =========================================================================
  // NON-HTML CONTENT — TRUNCATION VERIFICATION
  // =========================================================================

  describe('non-HTML content truncation', () => {
    // [Implements: US-SC-008, US-SC-009]
    it('truncates XML content when it exceeds maxContentChars', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'xml',
        textContent: 'X'.repeat(15000),
        extractionMethod: 'xml',
        error: null,
      });

      mockTruncate.mockReturnValue({
        text: 'truncated xml',
        truncated: true,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.truncated).toBe(true);
        expect(result.textContent).toBe('truncated xml');
      }
      expect(mockTruncate).toHaveBeenCalledWith(
        'X'.repeat(15000),
        expect.any(Number)
      );
    });

    it('truncates text/plain content when it exceeds maxContentChars', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'text',
        textContent: 'T'.repeat(15000),
        extractionMethod: 'raw-text',
        error: null,
      });

      mockTruncate.mockReturnValue({
        text: 'truncated text',
        truncated: true,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.truncated).toBe(true);
      }
    });

    it('non-HTML content does not invoke Readability or Puppeteer', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'xml',
        textContent: '<root>XML content here</root>',
        extractionMethod: 'xml',
        error: null,
      });

      await scrape(TEST_URL);

      expect(mockExtractWithReadability).not.toHaveBeenCalled();
      expect(mockRenderPage).not.toHaveBeenCalled();
    });

    it('non-HTML content invokes truncate exactly once', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'json',
        textContent: '{"data": "value"}',
        extractionMethod: 'json',
        error: null,
      });

      await scrape(TEST_URL);

      expect(mockTruncate).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // ENCODING LOGGING INTEGRATION
  // =========================================================================

  describe('encoding logging integration', () => {
    // [Implements: US-SC-007, US-SC-011]
    it('passes bodyBytes to detectCharset during HTML path', async () => {
      const customBytes = new Uint8Array([10, 20, 30, 40]);
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ bodyBytes: customBytes })
      );

      await scrape(TEST_URL);

      expect(mockDetectCharset).toHaveBeenCalledWith(
        'text/html; charset=utf-8',
        customBytes
      );
    });

    it('passes detected charset to decodeToUtf8', async () => {
      mockDetectCharset.mockReturnValue('shift-jis');

      await scrape(TEST_URL);

      expect(mockDecodeToUtf8).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        'shift-jis',
        TEST_URL
      );
    });

    it('uses decoded text from decodeToUtf8 for routeContent input', async () => {
      const decodedBody = '<html><body>Custom decoded body</body></html>';
      mockDecodeToUtf8.mockReturnValue(decodedBody);

      await scrape(TEST_URL);

      expect(mockRouteContent).toHaveBeenCalledWith(
        'text/html; charset=utf-8',
        decodedBody
      );
    });

    it('does not call detectCharset or decodeToUtf8 on fetch failure', async () => {
      mockFetchUrl.mockResolvedValue(makeErrorFetchResult(500, 'Error'));

      await scrape(TEST_URL);

      expect(mockDetectCharset).not.toHaveBeenCalled();
      expect(mockDecodeToUtf8).not.toHaveBeenCalled();
    });

    it('does not call detectCharset when bodyBytes is null', async () => {
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ bodyBytes: null })
      );

      await scrape(TEST_URL);

      expect(mockDetectCharset).not.toHaveBeenCalled();
      expect(mockDecodeToUtf8).not.toHaveBeenCalled();
    });

    it('does not call detectCharset when bodyBytes is empty', async () => {
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ bodyBytes: new Uint8Array(0) })
      );

      await scrape(TEST_URL);

      expect(mockDetectCharset).not.toHaveBeenCalled();
      expect(mockDecodeToUtf8).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // COMPREHENSIVE STDOUT ISOLATION
  // =========================================================================

  describe('stdout isolation (comprehensive)', () => {
    // [Implements: NFR-SC-006]
    it('never writes to stdout on JSON content type', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'json',
        textContent: '{"key": "value"}',
        extractionMethod: 'json',
        error: null,
      });

      await scrape(TEST_URL);

      expect(getStdoutOutput()).not.toContain('[scrape]');
    });

    it('never writes to stdout on XML content type', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'xml',
        textContent: 'XML text',
        extractionMethod: 'xml',
        error: null,
      });

      await scrape(TEST_URL);

      expect(getStdoutOutput()).not.toContain('[scrape]');
    });

    it('never writes to stdout on text/plain content type', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'text',
        textContent: 'Plain text here.',
        extractionMethod: 'raw-text',
        error: null,
      });

      await scrape(TEST_URL);

      expect(getStdoutOutput()).not.toContain('[scrape]');
    });

    it('never writes to stdout on binary content', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'binary',
        textContent: null,
        extractionMethod: null,
        error: 'Unsupported content type: application/pdf',
      });

      await scrape(TEST_URL);

      expect(getStdoutOutput()).not.toContain('[scrape]');
    });

    it('never writes to stdout on network error', async () => {
      mockFetchUrl.mockResolvedValue({
        success: false,
        statusCode: 0,
        statusText: '',
        contentType: null,
        bodyBytes: null,
        finalUrl: null,
        redirectCount: 0,
        error: 'ECONNRESET',
        retryAfterMs: null,
      });

      await scrape(TEST_URL);

      expect(getStdoutOutput()).not.toContain('[scrape]');
    });

    it('never writes to stdout on empty body', async () => {
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ bodyBytes: new Uint8Array(0) })
      );

      await scrape(TEST_URL);

      expect(getStdoutOutput()).not.toContain('[scrape]');
    });

    it('never writes to stdout on thrown error', async () => {
      mockValidateUrl.mockRejectedValue(new Error('Unexpected'));

      await scrape(TEST_URL);

      expect(getStdoutOutput()).not.toContain('[scrape]');
    });

    it('stderr always contains START on every code path', async () => {
      // Test multiple outcomes — all should have START
      // 1. Success
      await scrape(TEST_URL);
      expect(getStderrOutput()).toContain('[scrape] START');

      // Reset stderr capture
      stderrSpy.mockClear();

      // 2. Validation failure
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Invalid URL',
      });
      await scrape('bad');
      expect(getStderrOutput()).toContain('[scrape] START');

      stderrSpy.mockClear();

      // 3. HTTP error
      mockValidateUrl.mockResolvedValue({ valid: true, error: null });
      mockFetchUrl.mockResolvedValue(makeErrorFetchResult(404, 'Not Found'));
      await scrape(TEST_URL);
      expect(getStderrOutput()).toContain('[scrape] START');
    });
  });

  // =========================================================================
  // REDIRECT HANDLING
  // =========================================================================

  describe('redirect handling', () => {
    // [Implements: US-SC-003]
    it('uses finalUrl for Readability extraction after redirect', async () => {
      const finalUrl = 'https://example.com/redirected-final';
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({
          finalUrl,
          redirectCount: 2,
        })
      );

      await scrape(TEST_URL);

      expect(mockExtractWithReadability).toHaveBeenCalledWith(
        expect.any(String),
        finalUrl,
        expect.any(Number)
      );
    });

    it('uses finalUrl for Puppeteer renderPage after redirect', async () => {
      const finalUrl = 'https://example.com/puppet-redirected';
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ finalUrl, redirectCount: 1 })
      );

      mockExtractWithReadability.mockReturnValue({
        title: '',
        textContent: 'short',
        extractionMethod: 'readability-failed',
        charCount: 5,
      });
      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });
      mockExtractWithReadability.mockReturnValueOnce({
        title: '',
        textContent: 'short',
        extractionMethod: 'readability-failed',
        charCount: 5,
      });
      mockExtractWithReadability.mockReturnValue({
        title: 'Title',
        textContent: 'Z'.repeat(250),
        extractionMethod: 'readability',
        charCount: 250,
      });

      await scrape(TEST_URL);

      expect(mockRenderPage).toHaveBeenCalledWith(
        finalUrl,
        expect.any(Number)
      );
    });

    it('preserves redirectCount from fetch in successful result path', async () => {
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ redirectCount: 3 })
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      // The result doesn't expose redirectCount, but the pipeline should not crash
      expect(mockExtractWithReadability).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // CONTENT-TYPE ROUTER NULL CONTENT-TYPE
  // =========================================================================

  describe('null content-type handling', () => {
    // [Implements: US-SC-009]
    it('passes null contentType from fetch to routeContent', async () => {
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ contentType: null })
      );
      mockRouteContent.mockReturnValue(makeHtmlRouteResult());

      await scrape(TEST_URL);

      expect(mockRouteContent).toHaveBeenCalledWith(
        null,
        expect.any(String)
      );
    });

    it('handles null contentType with HTML sniffing success', async () => {
      mockFetchUrl.mockResolvedValue(
        makeSuccessFetchResult({ contentType: null })
      );

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      expect(mockRouteContent).toHaveBeenCalledWith(null, expect.any(String));
    });
  });

  // =========================================================================
  // COMPREHENSIVE ERROR ISOLATION
  // =========================================================================

  describe('comprehensive error isolation', () => {
    // [Implements: NFR-SC-005]
    it('catches error from decodeToUtf8 and returns failure result', async () => {
      mockDecodeToUtf8.mockImplementation(() => {
        throw new Error('Decode failure');
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Decode failure');
      }
    });

    it('catches error from truncate and returns failure result', async () => {
      mockTruncate.mockImplementation(() => {
        throw new Error('Truncation error');
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Truncation error');
      }
    });

    it('catches error from detectCharset and returns failure result', async () => {
      mockDetectCharset.mockImplementation(() => {
        throw new Error('Charset detection crashed');
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Charset detection crashed');
      }
    });

    it('catches null thrown from validateUrl', async () => {
      mockValidateUrl.mockRejectedValue(null);

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('null');
      }
    });

    it('catches undefined thrown from fetchUrl', async () => {
      mockFetchUrl.mockRejectedValue(undefined);

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('undefined');
      }
    });

    it('catches plain object thrown from routeContent', async () => {
      mockRouteContent.mockImplementation(() => {
        // eslint-disable-next-line no-throw-literal
        throw { custom: 'error object' };
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        // String({ custom: 'error object' }) → '[object Object]'
        expect(result.error).toBe('[object Object]');
      }
    });

    it('catches error during Puppeteer extraction on second Readability call', async () => {
      mockExtractWithReadability
        .mockReturnValueOnce({
          title: '',
          textContent: 'short',
          extractionMethod: 'readability-failed',
          charCount: 5,
        })
        .mockImplementationOnce(() => {
          throw new Error('Second Readability crash');
        });

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Second Readability crash');
      }
    });

    it('returns failure with finalUrl null on caught error from validateUrl', async () => {
      mockValidateUrl.mockRejectedValue(new Error('Crash'));

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.finalUrl).toBeNull();
      }
    });

    it('logs FAIL message on caught error', async () => {
      mockFetchUrl.mockRejectedValue(new Error('Network boom'));

      await scrape(TEST_URL);

      expect(getStderrOutput()).toContain('[scrape] FAIL');
      expect(getStderrOutput()).toContain('Network boom');
    });
  });

  // =========================================================================
  // CALL ORDER AND PIPELINE INVOCATION
  // =========================================================================

  describe('pipeline call order and invocation', () => {
    // [Implements: US-SC-001, US-SC-002, US-SC-007]
    it('invokes pipeline components in correct order for HTML path', async () => {
      await scrape(TEST_URL);

      // Verify all expected components were called
      expect(mockValidateUrl).toHaveBeenCalledTimes(1);
      expect(mockFetchUrl).toHaveBeenCalledTimes(1);
      expect(mockDetectCharset).toHaveBeenCalledTimes(1);
      expect(mockDecodeToUtf8).toHaveBeenCalledTimes(1);
      expect(mockRouteContent).toHaveBeenCalledTimes(1);
      expect(mockExtractWithReadability).toHaveBeenCalledTimes(1);
      expect(mockTruncate).toHaveBeenCalledTimes(1);
      // Puppeteer should NOT be called when Readability succeeds
      expect(mockRenderPage).not.toHaveBeenCalled();
    });

    it('invokes all components including Puppeteer on fallback path', async () => {
      mockExtractWithReadability
        .mockReturnValueOnce({
          title: '',
          textContent: 'short',
          extractionMethod: 'readability-failed',
          charCount: 5,
        })
        .mockReturnValueOnce({
          title: 'Title',
          textContent: 'Z'.repeat(250),
          extractionMethod: 'readability',
          charCount: 250,
        });

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });

      await scrape(TEST_URL);

      expect(mockValidateUrl).toHaveBeenCalledTimes(1);
      expect(mockFetchUrl).toHaveBeenCalledTimes(1);
      expect(mockDetectCharset).toHaveBeenCalledTimes(1);
      expect(mockDecodeToUtf8).toHaveBeenCalledTimes(1);
      expect(mockRouteContent).toHaveBeenCalledTimes(1);
      expect(mockExtractWithReadability).toHaveBeenCalledTimes(2);
      expect(mockRenderPage).toHaveBeenCalledTimes(1);
      expect(mockTruncate).toHaveBeenCalledTimes(1);
    });

    it('does not call Readability or Puppeteer when routeContent is binary', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'binary',
        textContent: null,
        extractionMethod: null,
        error: 'Unsupported content type: application/pdf',
      });

      await scrape(TEST_URL);

      expect(mockExtractWithReadability).not.toHaveBeenCalled();
      expect(mockRenderPage).not.toHaveBeenCalled();
      expect(mockTruncate).not.toHaveBeenCalled();
    });

    it('calls truncate once for non-HTML success path', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'json',
        textContent: '{"data": 1}',
        extractionMethod: 'json',
        error: null,
      });

      await scrape(TEST_URL);

      expect(mockTruncate).toHaveBeenCalledTimes(1);
    });

    it('does not invoke routeContent on URL validation failure', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Invalid URL',
      });

      await scrape('bad');

      expect(mockRouteContent).not.toHaveBeenCalled();
    });

    it('validateUrl receives the raw input URL', async () => {
      const inputUrl = 'https://special.example.com/path?query=1';
      await scrape(inputUrl);

      expect(mockValidateUrl).toHaveBeenCalledWith(inputUrl);
    });

    it('fetchUrl receives the raw input URL', async () => {
      const inputUrl = 'https://fetch.example.com/page';
      await scrape(inputUrl);

      expect(mockFetchUrl).toHaveBeenCalledWith(
        inputUrl,
        expect.any(Object),
        undefined
      );
    });

    it('calls extractWithReadability with decoded HTML body text', async () => {
      const decodedHtml = '<html><head><title>Test</title></head><body>Content</body></html>';
      mockDecodeToUtf8.mockReturnValue(decodedHtml);

      await scrape(TEST_URL);

      expect(mockExtractWithReadability).toHaveBeenCalledWith(
        decodedHtml,
        TEST_URL,
        expect.any(Number)
      );
    });
  });

  // =========================================================================
  // RESULT INVARIANT ENFORCEMENT
  // =========================================================================

  describe('result invariant enforcement', () => {
    // [Implements: US-SC-012, DC-SC-001, NFR-SC-005]
    it('success result textContent is always non-empty', async () => {
      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.textContent.length).toBeGreaterThan(0);
      }
    });

    it('failure result error is always non-empty string', async () => {
      mockFetchUrl.mockResolvedValue(makeErrorFetchResult(404, 'Not Found'));

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.length).toBeGreaterThan(0);
        expect(typeof result.error).toBe('string');
      }
    });

    it('success result has error null', async () => {
      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.error).toBeNull();
      }
    });

    it('failure result has title null and textContent null', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Bad URL',
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.title).toBeNull();
        expect(result.textContent).toBeNull();
      }
    });

    it('non-HTML success result has title as empty string', async () => {
      mockRouteContent.mockReturnValue({
        kind: 'text',
        textContent: 'Some text content',
        extractionMethod: 'raw-text',
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.title).toBe('');
      }
    });

    it('Puppeteer success result has non-empty title from extraction', async () => {
      mockExtractWithReadability
        .mockReturnValueOnce({
          title: '',
          textContent: 'short',
          extractionMethod: 'readability-failed',
          charCount: 5,
        })
        .mockReturnValueOnce({
          title: 'Puppeteer Page Title',
          textContent: 'Z'.repeat(250),
          extractionMethod: 'readability',
          charCount: 250,
        });

      mockRenderPage.mockResolvedValue({
        success: true,
        html: '<html><body>Rendered</body></html>',
        error: null,
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.title).toBe('Puppeteer Page Title');
      }
    });

    it('contentLength is 0 on failure', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Invalid',
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.contentLength).toBe(0);
      }
    });

    it('truncated is false on failure', async () => {
      mockFetchUrl.mockResolvedValue(makeErrorFetchResult(500, 'Error'));

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.truncated).toBe(false);
      }
    });

    it('elapsedMs is a finite number on success', async () => {
      const result = await scrape(TEST_URL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(Number.isFinite(result.elapsedMs)).toBe(true);
      }
    });

    it('elapsedMs is a finite number on failure', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Invalid',
      });

      const result = await scrape(TEST_URL);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(Number.isFinite(result.elapsedMs)).toBe(true);
      }
    });

    it('url in result always equals the input argument', async () => {
      const urls = [
        'https://a.example.com/',
        'https://b.example.com/page',
        'https://c.example.com/deep/path?q=1',
      ];

      for (const inputUrl of urls) {
        const result = await scrape(inputUrl);
        expect(result.url).toBe(inputUrl);
      }
    });

    it('returns a Promise that resolves (never rejects) on validation error', async () => {
      mockValidateUrl.mockResolvedValue({
        valid: false,
        error: 'Invalid',
      });

      // scrape should resolve, not reject
      const result = await scrape(TEST_URL);
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('returns a Promise that resolves (never rejects) on fetch error', async () => {
      mockFetchUrl.mockResolvedValue(makeErrorFetchResult(500, 'Error'));

      const result = await scrape(TEST_URL);
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('returns a Promise that resolves (never rejects) on thrown error', async () => {
      mockFetchUrl.mockRejectedValue(new Error('Thrown'));

      const result = await scrape(TEST_URL);
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });
  });
});
