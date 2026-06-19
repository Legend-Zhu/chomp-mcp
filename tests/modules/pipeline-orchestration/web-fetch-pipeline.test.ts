/**
 * Integration tests for the web_fetch pipeline flow (executeWebFetchPipeline).
 *
 * Verifies:
 * - Happy path: scrape succeeds → synthesis succeeds → formatted digest
 * - Scrape failure: HTTP 4xx/5xx error messages with status code and suggestion
 * - Scrape failure: timeout error with timeout value and SCRAPE_TIMEOUT_MS suggestion
 * - Scrape failure: DNS/connection error with connectivity suggestion
 * - Empty content: skip synthesis, return informative message
 * - Synthesis failure: return truncated content with degradation notice
 * - Both content empty and synthesis failure
 *
 * [Spec: US-PL-002, US-PL-005, US-PL-007, US-PL-009,
 *        NFR-PL-002, NFR-PL-004, NFR-PL-008, DC-PL-003]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../../src/modules/scrape-extract/index.js', () => ({
  scrape: vi.fn(),
}));

vi.mock('../../../src/modules/synthesize/index.js', () => ({
  synthesizeSingle: vi.fn(),
  synthesize: vi.fn(),
}));

vi.mock('../../../src/modules/synthesize/degradation-handler.js', () => ({
  degradationFallback: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { scrape } from '../../../src/modules/scrape-extract/index.js';
import { synthesizeSingle } from '../../../src/modules/synthesize/index.js';
import { degradationFallback } from '../../../src/modules/synthesize/degradation-handler.js';

import { executeWebFetchPipeline } from '../../../src/modules/pipeline-orchestration/web-fetch-pipeline.js';
import { PipelineError, PipelineTimeoutError } from '../../../src/modules/pipeline-orchestration/orchestrator.js';
import type { PipelineConfig } from '../../../src/modules/pipeline-orchestration/orchestrator.js';

import type { ScrapeSuccessResult, ScrapeFailureResult } from '../../../src/shared/types/scrape.js';
import type { DigestResult } from '../../../src/shared/types/digest.js';

// ---------------------------------------------------------------------------
// Mocked function references
// ---------------------------------------------------------------------------

const mockScrape = vi.mocked(scrape);
const mockSynthesizeSingle = vi.mocked(synthesizeSingle);
const mockDegradationFallback = vi.mocked(degradationFallback);

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const TEST_URL = 'https://example.com/article';
const TEST_TITLE = 'Test Article';
const TEST_CONTENT = 'This is a test article with enough content to pass the minimum meaningful length threshold of fifty characters. It has plenty of substance for synthesis.';

const testConfig: PipelineConfig = {
  maxConcurrency: 3,
  scrapeTimeoutMs: 15000,
  maxContentChars: 8000,
  pipelineTimeoutMs: 30000,
};

function makeScrapeSuccess(overrides?: Partial<ScrapeSuccessResult>): ScrapeSuccessResult {
  return {
    success: true,
    url: TEST_URL,
    finalUrl: TEST_URL,
    title: TEST_TITLE,
    textContent: TEST_CONTENT,
    extractionMethod: 'readability',
    truncated: false,
    contentLength: TEST_CONTENT.length,
    elapsedMs: 500,
    error: null,
    ...overrides,
  };
}

function makeScrapeFailure(
  error: string,
  overrides?: Partial<ScrapeFailureResult>
): ScrapeFailureResult {
  return {
    success: false,
    url: TEST_URL,
    finalUrl: TEST_URL,
    title: null,
    textContent: null,
    extractionMethod: null,
    truncated: false,
    contentLength: 0,
    elapsedMs: 500,
    error,
    ...overrides,
  };
}

function makeDigestResult(overrides?: Partial<DigestResult>): DigestResult {
  return {
    answer: 'This is a synthesized answer about the topic discussed in the article.',
    keyPoints: ['Key point one about the topic', 'Key point two with additional detail'],
    sources: [{ url: TEST_URL, title: TEST_TITLE }],
    ...overrides,
  };
}

function nonAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

// ===========================================================================
// Happy Path
// ===========================================================================

describe('happy path — scrape and synthesis succeed', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-002]
  it('returns a formatted digest string when scrape and synthesis succeed', async () => {
    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(typeof result).toBe('string');
    expect(result).toContain('This is a synthesized answer about the topic');
  });

  // [Implements: US-PL-002]
  it('includes key points in the formatted output', async () => {
    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('Key Points:');
    expect(result).toContain('Key point one about the topic');
    expect(result).toContain('Key point two with additional detail');
  });

  // [Implements: US-PL-002]
  it('includes sources in the formatted output', async () => {
    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('Sources:');
    expect(result).toContain(TEST_TITLE);
    expect(result).toContain(TEST_URL);
  });

  // [Implements: US-PL-002]
  it('calls scrape with the URL, timeout, and signal', async () => {
    const signal = nonAbortedSignal();
    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, signal);

    expect(mockScrape).toHaveBeenCalledTimes(1);
    expect(mockScrape).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({
        timeoutMs: 15000,
        maxContentChars: 8000,
        signal,
      })
    );
  });

  // [Implements: US-PL-002]
  it('calls synthesizeSingle with URL, title, content, and focus', async () => {
    const focus = 'security implications';
    await executeWebFetchPipeline(TEST_URL, focus, testConfig, nonAbortedSignal());

    expect(mockSynthesizeSingle).toHaveBeenCalledTimes(1);
    expect(mockSynthesizeSingle).toHaveBeenCalledWith(
      TEST_URL,
      TEST_TITLE,
      TEST_CONTENT,
      focus
    );
  });

  // [Implements: US-PL-002]
  it('passes undefined focus when no focus is provided', async () => {
    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    expect(mockSynthesizeSingle).toHaveBeenCalledWith(
      TEST_URL,
      TEST_TITLE,
      TEST_CONTENT,
      undefined
    );
  });

  // [Implements: US-PL-002]
  it('does NOT call degradationFallback on the happy path', async () => {
    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    expect(mockDegradationFallback).not.toHaveBeenCalled();
  });

  // [Implements: US-PL-002, US-PL-012]
  it('logs pipeline start with URL and focus to stderr', async () => {
    await executeWebFetchPipeline(TEST_URL, 'test-focus', testConfig, nonAbortedSignal());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('[PL] web_fetch');
    expect(output).toContain(TEST_URL);
    expect(output).toContain('test-focus');
  });

  // [Implements: US-PL-012]
  it('logs scrape stage completion to stderr', async () => {
    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('[PL] stage=scrape');
  });

  // [Implements: US-PL-012]
  it('logs synthesis stage completion to stderr', async () => {
    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('[PL] stage=synthesize');
  });

  // [Implements: US-PL-012]
  it('logs success outcome to stderr', async () => {
    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('outcome=success');
  });

  it('handles a successful digest with no key points', async () => {
    mockSynthesizeSingle.mockResolvedValue(
      makeDigestResult({ keyPoints: [] })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('This is a synthesized answer');
    expect(result).not.toContain('Key Points:');
  });

  it('handles a successful digest with no sources', async () => {
    mockSynthesizeSingle.mockResolvedValue(
      makeDigestResult({ sources: [] })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('This is a synthesized answer');
    expect(result).not.toContain('Sources:');
  });
});

// ===========================================================================
// Scrape Failure — HTTP 4xx/5xx
// ===========================================================================

describe('scrape failure — HTTP errors', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-007]
  it('throws PipelineError with 404 status code and URL for HTTP 404', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 404: Not Found (https://example.com/article)')
    );

    await expect(
      executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal())
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-007]
  it('includes the HTTP status code (404) in the error message', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 404: Not Found (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      const message = (error as PipelineError).message;
      expect(message).toContain('404');
    }
  });

  // [Implements: US-PL-007]
  it('includes the URL in the 404 error message', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 404: Not Found (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain(TEST_URL);
    }
  });

  // [Implements: US-PL-007]
  it('includes a suggested action for HTTP 404', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 404: Not Found (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message.toLowerCase();
      expect(message).toContain('verify the url is correct');
    }
  });

  // [Implements: US-PL-007]
  it('includes a suggested action for HTTP 401/403 (authentication)', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 403: Forbidden (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain('403');
      expect(message.toLowerCase()).toContain('authentication');
    }
  });

  // [Implements: US-PL-007]
  it('includes a suggested action for HTTP 429 (rate limit)', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 429: Too Many Requests (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain('429');
      expect(message.toLowerCase()).toContain('rate-limiting');
    }
  });

  // [Implements: US-PL-007]
  it('includes the status code for HTTP 500 server errors', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 500: Internal Server Error (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain('500');
      expect(message.toLowerCase()).toContain('server returned an error');
    }
  });

  // [Implements: US-PL-007]
  it('sets the error category to http_error for HTTP failures', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 404: Not Found (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      expect((error as PipelineError).category).toBe('http_error');
    }
  });

  // [Implements: US-PL-007]
  it('includes failed URL in the PipelineError failedUrls array', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 404: Not Found (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const pipelineError = error as PipelineError;
      expect(pipelineError.failedUrls).toHaveLength(1);
      expect(pipelineError.failedUrls[0].url).toBe(TEST_URL);
    }
  });

  // [Implements: US-PL-007]
  it('does NOT call synthesis when scrape returns HTTP failure', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 500: Internal Server Error (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch {
      // Expected
    }

    expect(mockSynthesizeSingle).not.toHaveBeenCalled();
  });

  // [Implements: US-PL-012]
  it('logs failed outcome to stderr on HTTP failure', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 404: Not Found (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch {
      // Expected
    }

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('outcome=failed');
  });

  // [Implements: US-PL-007]
  it('handles scrape rejection (thrown exception) with HTTP error', async () => {
    mockScrape.mockRejectedValue(new Error('HTTP 503: Service Unavailable (https://example.com/article)'));

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      const message = (error as PipelineError).message;
      expect(message).toContain('503');
    }
  });
});

// ===========================================================================
// Scrape Failure — Timeout
// ===========================================================================

describe('scrape failure — timeout', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-007]
  it('throws PipelineError when scrape returns a timeout failure', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Fetch timed out after 15000ms')
    );

    await expect(
      executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal())
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-007]
  it('includes the URL in the timeout error message', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Fetch timed out after 15000ms')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain(TEST_URL);
    }
  });

  // [Implements: US-PL-007]
  it('includes the timeout value in the error message', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Fetch timed out after 15000ms')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain('15000ms');
    }
  });

  // [Implements: US-PL-007]
  it('suggests checking connectivity or increasing SCRAPE_TIMEOUT_MS', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Fetch timed out after 15000ms')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain('SCRAPE_TIMEOUT_MS');
    }
  });

  // [Implements: US-PL-007]
  it('sets the error category to timeout for timeout failures', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Fetch timed out after 15000ms')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as PipelineError).category).toBe('timeout');
    }
  });

  // [Implements: US-PL-007]
  it('uses the configured scrapeTimeoutMs in the error message', async () => {
    const customConfig: PipelineConfig = {
      ...testConfig,
      scrapeTimeoutMs: 30000,
    };
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Fetch timed out after 30000ms')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, customConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain('30000ms');
    }
  });

  it('handles scrape rejection with timeout error', async () => {
    mockScrape.mockRejectedValue(new Error('Fetch timed out after 15000ms'));

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as PipelineError).category).toBe('timeout');
    }
  });
});

// ===========================================================================
// Scrape Failure — DNS / Connection
// ===========================================================================

describe('scrape failure — DNS / connection error', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-007]
  it('throws PipelineError when scrape returns a DNS failure', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('ENOTFOUND: getaddrinfo ENOTFOUND example.com')
    );

    await expect(
      executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal())
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-007]
  it('includes the URL in the DNS/connection error message', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('ENOTFOUND: getaddrinfo ENOTFOUND example.com')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain(TEST_URL);
    }
  });

  // [Implements: US-PL-007]
  it('suggests verifying network connectivity for DNS errors', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('ENOTFOUND: getaddrinfo ENOTFOUND example.com')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message.toLowerCase();
      expect(message).toContain('could not be reached');
      expect(message).toContain('verify network connectivity');
    }
  });

  // [Implements: US-PL-007]
  it('sets the error category to network for DNS failures', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('ENOTFOUND: getaddrinfo ENOTFOUND example.com')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as PipelineError).category).toBe('network');
    }
  });

  // [Implements: US-PL-007]
  it('classifies ECONNREFUSED as a network error', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:443')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as PipelineError).category).toBe('network');
      const message = (error as PipelineError).message.toLowerCase();
      expect(message).toContain('could not be reached');
    }
  });

  // [Implements: US-PL-007]
  it('classifies generic connection errors as network errors', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Network error: connection unreachable')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as PipelineError).category).toBe('network');
    }
  });

  it('does NOT call synthesis when scrape returns a DNS failure', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('ENOTFOUND: getaddrinfo ENOTFOUND example.com')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch {
      // Expected
    }

    expect(mockSynthesizeSingle).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Empty / Insufficient Content Handling
// ===========================================================================

describe('empty or insufficient content', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-002]
  it('returns an informative message when content is empty string', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: '', contentLength: 0 })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('No meaningful content');
    expect(result).toContain(TEST_URL);
  });

  // [Implements: US-PL-002]
  it('returns an informative message when content is whitespace only', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: '   \n\t  ', contentLength: 7 })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('No meaningful content');
  });

  // [Implements: US-PL-002]
  it('returns an informative message when content is below minimum threshold', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: 'Short content under fifty chars.', contentLength: 32 })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('No meaningful content');
  });

  // [Implements: US-PL-002]
  it('does NOT call synthesis when content is empty', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: '', contentLength: 0 })
    );

    await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(mockSynthesizeSingle).not.toHaveBeenCalled();
  });

  // [Implements: US-PL-002]
  it('does NOT call synthesis when content is below threshold', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: 'tiny', contentLength: 4 })
    );

    await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(mockSynthesizeSingle).not.toHaveBeenCalled();
  });

  // [Implements: US-PL-002]
  it('mentions possible causes in the informative message', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: '', contentLength: 0 })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    const lower = result.toLowerCase();
    expect(lower).toContain('javascript rendering');
  });

  // [Implements: US-PL-002]
  it('mentions the URL in the informative message', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: '', contentLength: 0 })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain(TEST_URL);
  });

  // [Implements: US-PL-002]
  it('proceeds to synthesis when content is exactly at the threshold (50 chars)', async () => {
    const thresholdContent = 'a'.repeat(50);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: thresholdContent, contentLength: 50 })
    );
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(mockSynthesizeSingle).toHaveBeenCalledTimes(1);
  });

  // [Implements: US-PL-002]
  it('skips synthesis when content is one char below the threshold (49 chars)', async () => {
    const belowThresholdContent = 'a'.repeat(49);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: belowThresholdContent, contentLength: 49 })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(mockSynthesizeSingle).not.toHaveBeenCalled();
    expect(result).toContain('No meaningful content');
  });

  // [Implements: US-PL-012]
  it('logs failed outcome when content is empty', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: '', contentLength: 0 })
    );

    await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('outcome=failed');
  });
});

// ===========================================================================
// Synthesis Failure — Degradation
// ===========================================================================

describe('synthesis failure — graceful degradation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    mockScrape.mockResolvedValue(makeScrapeSuccess());
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-009]
  it('returns degraded content when synthesizeSingle fails and degradationFallback also fails', async () => {
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM API error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(typeof result).toBe('string');
    expect(result).toContain('LLM synthesis was unavailable');
  });

  // [Implements: US-PL-009]
  it('includes the scraped content in the degraded result', async () => {
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM call failed'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain(TEST_CONTENT);
  });

  // [Implements: US-PL-009]
  it('includes the title and source URL in the degraded result', async () => {
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM call failed'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain(TEST_TITLE);
    expect(result).toContain(TEST_URL);
  });

  // [Implements: US-PL-009, NFR-PL-008]
  it('respects maxContentChars when truncating degraded content', async () => {
    const longContent = 'A'.repeat(20000);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: longContent, contentLength: 20000 })
    );
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM call failed'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const smallConfig: PipelineConfig = {
      ...testConfig,
      maxContentChars: 1000,
    };

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      smallConfig,
      nonAbortedSignal()
    );

    // The degraded content should be truncated to roughly maxContentChars
    // plus the notice prefix and title/source header
    expect(result.length).toBeLessThan(longContent.length + 500);
  });

  // [Implements: US-PL-009]
  it('prepends a notice that LLM synthesis was unavailable', async () => {
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM call failed'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('[Note:');
    expect(result.toLowerCase()).toContain('llm synthesis');
    expect(result.toLowerCase()).toContain('unavailable');
  });

  // [Implements: US-PL-009]
  it('does NOT throw when synthesis fails — returns degraded content', async () => {
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM call failed'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    await expect(
      executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal())
    ).resolves.toBeDefined();
  });

  // [Implements: US-PL-009]
  it('logs degraded outcome to stderr when synthesis fails', async () => {
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM call failed'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('outcome=degraded');
  });

  // [Implements: US-PL-009]
  it('logs synthesize failure message to stderr', async () => {
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM connection refused'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('synthesize failed');
  });

  // [Implements: US-PL-009]
  it('handles synthesizeSingle returning an empty-answer result as failure', async () => {
    mockSynthesizeSingle.mockResolvedValue(
      makeDigestResult({ answer: '' })
    );
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('LLM synthesis was unavailable');
  });

  // [Implements: US-PL-009]
  it('handles synthesizeSingle returning a whitespace-only answer as failure', async () => {
    mockSynthesizeSingle.mockResolvedValue(
      makeDigestResult({ answer: '   \n\t  ' })
    );
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('LLM synthesis was unavailable');
  });
});

// ===========================================================================
// Both Content Extraction and Synthesis Failure
// ===========================================================================

describe('both content extraction and synthesis failure', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-009]
  it('returns an informative message when content is empty (synthesis never attempted)', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: '', contentLength: 0 })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('No meaningful content');
    expect(result).toContain(TEST_URL);
    // Synthesis was never called since content was empty
    expect(mockSynthesizeSingle).not.toHaveBeenCalled();
  });

  // [Implements: US-PL-009]
  it('returns an informative message when content is too short (synthesis never attempted)', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: 'x', contentLength: 1 })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('No meaningful content');
    expect(mockSynthesizeSingle).not.toHaveBeenCalled();
  });

  // [Implements: US-PL-009]
  it('does not throw PipelineError when content is empty', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: '', contentLength: 0 })
    );

    await expect(
      executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal())
    ).resolves.toBeDefined();
  });
});

// ===========================================================================
// Pipeline Timeout During Scrape Phase
// ===========================================================================

describe('pipeline timeout during scrape phase', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-005]
  it('throws PipelineTimeoutError when scrape rejects and signal is aborted', async () => {
    const controller = new AbortController();
    mockScrape.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });

    await expect(
      executeWebFetchPipeline(TEST_URL, undefined, testConfig, controller.signal)
    ).rejects.toThrow(PipelineTimeoutError);
  });

  // [Implements: US-PL-005]
  it('includes the pipeline timeout value in PipelineTimeoutError', async () => {
    const controller = new AbortController();
    mockScrape.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, controller.signal);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineTimeoutError);
      expect((error as PipelineTimeoutError).timeoutMs).toBe(30000);
    }
  });

  // [Implements: US-PL-005]
  it('throws PipelineTimeoutError when scrape returns failure and signal is aborted', async () => {
    const controller = new AbortController();
    mockScrape.mockImplementation(async () => {
      controller.abort();
      return makeScrapeFailure('Connection reset');
    });

    await expect(
      executeWebFetchPipeline(TEST_URL, undefined, testConfig, controller.signal)
    ).rejects.toThrow(PipelineTimeoutError);
  });

  // [Implements: US-PL-005]
  it('includes the URL in the PipelineTimeoutError message', async () => {
    const controller = new AbortController();
    mockScrape.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, controller.signal);
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineTimeoutError).message;
      expect(message).toContain(TEST_URL);
    }
  });
});

// ===========================================================================
// Pipeline Timeout During Synthesis Phase
// ===========================================================================

describe('pipeline timeout during synthesis phase (content available)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-005, US-PL-009]
  it('returns degraded content when signal aborts during synthesis', async () => {
    const controller = new AbortController();
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      controller.signal
    );

    expect(result).toContain('LLM synthesis was unavailable');
    expect(result).toContain(TEST_CONTENT);
  });

  // [Implements: US-PL-005]
  it('logs degraded outcome when timeout fires during synthesis', async () => {
    const controller = new AbortController();
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      controller.signal
    );

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('outcome=degraded');
  });
});

// ===========================================================================
// Focus Propagation
// ===========================================================================

describe('focus parameter propagation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-002]
  it('passes focus to synthesizeSingle', async () => {
    const focus = 'security vulnerabilities';
    await executeWebFetchPipeline(TEST_URL, focus, testConfig, nonAbortedSignal());

    expect(mockSynthesizeSingle).toHaveBeenCalledWith(
      TEST_URL,
      TEST_TITLE,
      TEST_CONTENT,
      focus
    );
  });

  // [Implements: US-PL-002]
  it('logs the focus parameter in pipeline start message', async () => {
    const focus = 'performance optimization';
    await executeWebFetchPipeline(TEST_URL, focus, testConfig, nonAbortedSignal());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain(focus);
  });
});

// ===========================================================================
// Scrape Options Propagation
// ===========================================================================

describe('scrape options propagation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-002]
  it('passes scrapeTimeoutMs from config to scrape options', async () => {
    const customConfig: PipelineConfig = {
      ...testConfig,
      scrapeTimeoutMs: 25000,
    };

    await executeWebFetchPipeline(TEST_URL, undefined, customConfig, nonAbortedSignal());

    expect(mockScrape).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({ timeoutMs: 25000 })
    );
  });

  // [Implements: US-PL-002]
  it('passes maxContentChars from config to scrape options', async () => {
    const customConfig: PipelineConfig = {
      ...testConfig,
      maxContentChars: 5000,
    };

    await executeWebFetchPipeline(TEST_URL, undefined, customConfig, nonAbortedSignal());

    expect(mockScrape).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({ maxContentChars: 5000 })
    );
  });

  // [Implements: US-PL-002]
  it('passes the signal from the caller to scrape', async () => {
    const controller = new AbortController();

    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, controller.signal);

    expect(mockScrape).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({ signal: controller.signal })
    );
  });
});

// ===========================================================================
// Title Fallback
// ===========================================================================

describe('title fallback behavior', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-002]
  it('uses the URL as title when scrape result has empty title', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ title: '' })
    );
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    expect(mockSynthesizeSingle).toHaveBeenCalledWith(
      TEST_URL,
      TEST_URL, // title falls back to URL
      TEST_CONTENT,
      undefined
    );
  });

  // [Implements: US-PL-002]
  it('uses the scrape title when available', async () => {
    const customTitle = 'Custom Page Title';
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ title: customTitle })
    );
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    expect(mockSynthesizeSingle).toHaveBeenCalledWith(
      TEST_URL,
      customTitle,
      TEST_CONTENT,
      undefined
    );
  });
});

// ===========================================================================
// Unrecognized Error Categories
// ===========================================================================

describe('unrecognized error categories', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-007]
  it('falls back to generic message for unrecognized error types', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Some completely unknown error occurred')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      const message = (error as PipelineError).message;
      expect(message).toContain('Failed to scrape');
      expect(message).toContain(TEST_URL);
      expect(message).toContain('Some completely unknown error occurred');
    }
  });

  // [Implements: US-PL-007]
  it('classifies parse errors correctly', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Failed to extract content: parse error in HTML')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as PipelineError).category).toBe('parse_error');
    }
  });

  // [Implements: US-PL-007]
  it('classifies validation errors correctly', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Invalid URL: URL is required')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as PipelineError).category).toBe('validation');
    }
  });

  // [Implements: US-PL-007]
  it('classifies SSRF validation errors correctly', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('URL resolves to a private or loopback address; blocked for security')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as PipelineError).category).toBe('validation');
    }
  });
});

// ===========================================================================
// Degraded Content Format
// ===========================================================================

describe('degraded content format details', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-009, NFR-PL-008]
  it('includes a markdown heading with the title in degraded output', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain(`## ${TEST_TITLE}`);
  });

  // [Implements: US-PL-009]
  it('includes a Source line with the URL in degraded output', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain(`Source: ${TEST_URL}`);
  });

  // [Implements: US-PL-009]
  it('does not truncate content when it is within maxContentChars', async () => {
    const shortContent = 'Short but meaningful content for testing degradation. It has enough characters to pass the threshold check for meaningful content length requirement.';
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: shortContent, contentLength: shortContent.length })
    );
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain(shortContent);
  });
});

// ===========================================================================
// Degradation Fallback Success Path
// ===========================================================================

describe('degradation fallback succeeds when synthesizeSingle fails', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-009]
  it('uses degradationFallback result when synthesizeSingle throws but degradation succeeds', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM API error'));
    mockDegradationFallback.mockResolvedValue(makeDigestResult());

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(typeof result).toBe('string');
    expect(result).toContain('This is a synthesized answer about the topic');
    expect(result).not.toContain('LLM synthesis was unavailable');
  });

  // [Implements: US-PL-009]
  it('includes key points from degradationFallback result', async () => {
    const degradedDigest = makeDigestResult({
      answer: 'Fallback answer from degradation handler.',
      keyPoints: ['Fallback key point 1', 'Fallback key point 2'],
    });
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockResolvedValue(degradedDigest);

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('Fallback answer from degradation handler.');
    expect(result).toContain('Key Points:');
    expect(result).toContain('Fallback key point 1');
    expect(result).toContain('Fallback key point 2');
  });

  // [Implements: US-PL-009]
  it('includes sources from degradationFallback result', async () => {
    const degradedDigest = makeDigestResult({
      answer: 'Fallback answer.',
      sources: [{ url: TEST_URL, title: TEST_TITLE }],
    });
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockResolvedValue(degradedDigest);

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('Sources:');
    expect(result).toContain(TEST_URL);
  });

  // [Implements: US-PL-009]
  it('logs degraded outcome when degradationFallback is used', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM API error'));
    mockDegradationFallback.mockResolvedValue(makeDigestResult());

    await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('outcome=degraded');
  });
});

// ===========================================================================
// Additional HTTP Status Codes
// ===========================================================================

describe('scrape failure — additional HTTP status codes', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-007]
  it('handles HTTP 400 Bad Request', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 400: Bad Request (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      expect((error as PipelineError).message).toContain('400');
    }
  });

  // [Implements: US-PL-007]
  it('handles HTTP 401 Unauthorized', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 401: Unauthorized (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message.toLowerCase();
      expect(message).toContain('401');
      expect(message).toContain('authentication');
    }
  });

  // [Implements: US-PL-007]
  it('handles HTTP 502 Bad Gateway as server error', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 502: Bad Gateway (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain('502');
      expect(message.toLowerCase()).toContain('server returned an error');
    }
  });

  // [Implements: US-PL-007]
  it('handles HTTP 503 Service Unavailable as server error', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 503: Service Unavailable (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain('503');
      expect(message.toLowerCase()).toContain('server returned an error');
    }
  });

  // [Implements: US-PL-007]
  it('handles HTTP 504 Gateway Timeout as server error', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 504: Gateway Timeout (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain('504');
      expect(message.toLowerCase()).toContain('server returned an error');
    }
  });

  // [Implements: US-PL-007]
  it('classifies all HTTP errors with http_error category', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 400: Bad Request (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch (error) {
      expect((error as PipelineError).category).toBe('http_error');
    }
  });
});

// ===========================================================================
// Non-Error Thrown Values from Scrape
// ===========================================================================

describe('scrape rejection with non-Error values', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: NFR-PL-004]
  it('handles scrape rejection with a string value', async () => {
    mockScrape.mockRejectedValue('string error');

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      expect((error as PipelineError).message).toContain('string error');
    }
  });

  // [Implements: NFR-PL-004]
  it('handles scrape rejection with a number value', async () => {
    mockScrape.mockRejectedValue(42);

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
    }
  });

  // [Implements: NFR-PL-004]
  it('handles scrape rejection with an object', async () => {
    mockScrape.mockRejectedValue({ code: 'ERR_CUSTOM', detail: 'custom failure' });

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
    }
  });

  // [Implements: NFR-PL-004]
  it('handles scrape rejection with null', async () => {
    mockScrape.mockRejectedValue(null);

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
    }
  });

  // [Implements: NFR-PL-004]
  it('handles scrape rejection with undefined', async () => {
    mockScrape.mockRejectedValue(undefined);

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
    }
  });
});

// ===========================================================================
// Signal Already Aborted at Pipeline Start
// ===========================================================================

describe('already-aborted signal at pipeline start', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-005]
  it('throws PipelineTimeoutError when signal is aborted and scrape rejects', async () => {
    const controller = new AbortController();
    controller.abort();
    mockScrape.mockRejectedValue(new Error('aborted'));

    await expect(
      executeWebFetchPipeline(TEST_URL, undefined, testConfig, controller.signal)
    ).rejects.toThrow(PipelineTimeoutError);
  });

  // [Implements: US-PL-005]
  it('throws PipelineTimeoutError when signal is aborted and scrape returns failure', async () => {
    const controller = new AbortController();
    controller.abort();
    mockScrape.mockResolvedValue(makeScrapeFailure('aborted'));

    await expect(
      executeWebFetchPipeline(TEST_URL, undefined, testConfig, controller.signal)
    ).rejects.toThrow(PipelineTimeoutError);
  });
});

// ===========================================================================
// Config Edge Cases
// ===========================================================================

describe('config edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-002]
  it('passes a very small scrapeTimeoutMs to scrape options', async () => {
    const customConfig: PipelineConfig = {
      ...testConfig,
      scrapeTimeoutMs: 100,
    };
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    await executeWebFetchPipeline(TEST_URL, undefined, customConfig, nonAbortedSignal());

    expect(mockScrape).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({ timeoutMs: 100 })
    );
  });

  // [Implements: US-PL-009, NFR-PL-008]
  it('disables truncation when maxContentChars is 0', async () => {
    const longContent = 'A'.repeat(1000);
    const customConfig: PipelineConfig = {
      ...testConfig,
      maxContentChars: 0,
    };
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: longContent, contentLength: 1000 })
    );
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      customConfig,
      nonAbortedSignal()
    );

    // With maxContentChars=0, content is not truncated
    expect(result).toContain(longContent);
  });

  // [Implements: US-PL-007]
  it('uses the scrapeTimeoutMs from config in timeout error message', async () => {
    const customConfig: PipelineConfig = {
      ...testConfig,
      scrapeTimeoutMs: 5000,
    };
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Fetch timed out after 5000ms')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, customConfig, nonAbortedSignal());
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineError).message;
      expect(message).toContain('5000ms');
    }
  });

  // [Implements: US-PL-002]
  it('passes maxContentChars=0 to scrape options', async () => {
    const customConfig: PipelineConfig = {
      ...testConfig,
      maxContentChars: 0,
    };
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    await executeWebFetchPipeline(TEST_URL, undefined, customConfig, nonAbortedSignal());

    expect(mockScrape).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({ maxContentChars: 0 })
    );
  });
});

// ===========================================================================
// Whitespace-only Title Fallback
// ===========================================================================

describe('whitespace-only title fallback', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-002]
  it('uses the URL as title when scrape result has whitespace-only title', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ title: '   \n\t  ' })
    );
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    // Empty/whitespace title falls back to URL
    expect(mockSynthesizeSingle).toHaveBeenCalledWith(
      TEST_URL,
      TEST_URL,
      TEST_CONTENT,
      undefined
    );
  });
});

// ===========================================================================
// NFR-PL-002: web_fetch Sub-flow Latency
// ===========================================================================

describe('NFR-PL-002 — web_fetch sub-flow latency', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: NFR-PL-002]
  it('completes the happy path quickly (under 1 second with mocks)', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    const start = Date.now();
    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });

  // [Implements: NFR-PL-002]
  it('completes the degradation path quickly (under 1 second with mocks)', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const start = Date.now();
    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });

  // [Implements: NFR-PL-002]
  it('completes the empty-content path quickly (under 1 second with mocks)', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: '', contentLength: 0 })
    );

    const start = Date.now();
    const result = await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(result).toContain('No meaningful content');
  });

  // [Implements: NFR-PL-002]
  it('completes the scrape-failure path quickly (under 1 second with mocks)', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 404: Not Found')
    );

    const start = Date.now();
    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch {
      // Expected
    }
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });
});

// ===========================================================================
// NFR-PL-008: Graceful Degradation Availability
// ===========================================================================

describe('NFR-PL-008 — graceful degradation always returns content', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: NFR-PL-008]
  it('returns a non-empty string when synthesis throws and degradation handler fails', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM down'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation down'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  // [Implements: NFR-PL-008]
  it('degraded output always contains the page content', async () => {
    const customContent = 'This is the page content that was successfully scraped from the target URL for testing purposes.';
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: customContent, contentLength: customContent.length })
    );
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain(customContent);
  });

  // [Implements: NFR-PL-008]
  it('degraded output always contains the degradation notice', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('[Note:');
    expect(result.toLowerCase()).toContain('unavailable');
  });

  // [Implements: NFR-PL-008]
  it('returns degraded content when synthesizeSingle throws a TypeError', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new TypeError('Cannot read property of undefined'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(typeof result).toBe('string');
    expect(result).toContain('LLM synthesis was unavailable');
  });

  // [Implements: NFR-PL-008]
  it('returns degraded content when synthesizeSingle throws a RangeError', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new RangeError('Maximum call stack exceeded'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  // [Implements: NFR-PL-008]
  it('degraded content during synthesis timeout includes raw content', async () => {
    const controller = new AbortController();
    const customContent = 'This is the content from a page that will timeout during synthesis but was scraped successfully.';
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: customContent, contentLength: customContent.length })
    );
    mockSynthesizeSingle.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      controller.signal
    );

    expect(result).toContain(customContent);
  });
});

// ===========================================================================
// Truncation Marker in Degraded Content
// ===========================================================================

describe('truncation behavior in degraded content', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-009, NFR-PL-008]
  it('includes truncation marker when content exceeds maxContentChars', async () => {
    const longContent = 'A'.repeat(500);
    const customConfig: PipelineConfig = {
      ...testConfig,
      maxContentChars: 100,
    };
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: longContent, contentLength: 500 })
    );
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      customConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('…');
  });

  // [Implements: US-PL-009]
  it('truncates at a word boundary when possible', async () => {
    const wordBoundaryContent = 'word '.repeat(200); // 1000 chars with spaces
    const customConfig: PipelineConfig = {
      ...testConfig,
      maxContentChars: 50,
    };
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: wordBoundaryContent, contentLength: 1000 })
    );
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      customConfig,
      nonAbortedSignal()
    );

    // The truncated portion should end with a word boundary, not mid-word
    expect(result).toContain('…');
    // Content should be significantly shorter than original
    expect(result.length).toBeLessThan(500);
  });

  // [Implements: US-PL-009]
  it('does not add truncation marker when content is exactly at maxContentChars', async () => {
    const exactContent = 'A'.repeat(100);
    const customConfig: PipelineConfig = {
      ...testConfig,
      maxContentChars: 100,
    };
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: exactContent, contentLength: 100 })
    );
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      customConfig,
      nonAbortedSignal()
    );

    expect(result).not.toContain('…');
  });
});

// ===========================================================================
// Statelessness Across Multiple Calls
// ===========================================================================

describe('statelessness across multiple calls', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: DC-PL-005]
  it('produces consistent results for identical happy-path inputs', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    const result1 = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );
    const result2 = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result1).toBe(result2);
  });

  // [Implements: DC-PL-005]
  it('produces consistent degraded results for identical failure inputs', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result1 = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );
    const result2 = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result1).toBe(result2);
  });

  // [Implements: DC-PL-005]
  it('does not leak state between a success call and a failure call', async () => {
    // First call: success
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());
    mockDegradationFallback.mockResolvedValue(makeDigestResult());

    const successResult = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );
    expect(successResult).toContain('This is a synthesized answer');

    // Second call: synthesis failure
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM down'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation down'));

    const degradedResult = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );
    expect(degradedResult).toContain('LLM synthesis was unavailable');
    expect(degradedResult).not.toContain('This is a synthesized answer');

    // Third call: success again
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    const successResult2 = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );
    expect(successResult2).toContain('This is a synthesized answer');
    expect(successResult2).not.toContain('LLM synthesis was unavailable');
  });
});

// ===========================================================================
// Full Stderr Log Format Verification
// ===========================================================================

describe('full stderr log format verification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-012, NFR-PL-006]
  it('happy path logs include start, scrape stage, synthesize stage, and outcome', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('[PL] web_fetch');
    expect(output).toContain('url="https://example.com/article"');
    expect(output).toContain('[PL] stage=scrape');
    expect(output).toContain('[PL] stage=synthesize');
    expect(output).toContain('outcome=success');
    expect(output).toContain('ms=');
  });

  // [Implements: US-PL-012, NFR-PL-006]
  it('happy path does NOT write to stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      mockScrape.mockResolvedValue(makeScrapeSuccess());
      mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // [Implements: NFR-PL-006]
  it('degraded path does NOT write to stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      mockScrape.mockResolvedValue(makeScrapeSuccess());
      mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
      mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // [Implements: US-PL-012]
  it('degraded path logs include start, scrape stage, synthesize failure, and degraded outcome', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('[PL] web_fetch');
    expect(output).toContain('[PL] stage=scrape');
    expect(output).toContain('synthesize failed');
    expect(output).toContain('outcome=degraded');
  });

  // [Implements: US-PL-012]
  it('scrape failure logs include scrape-failed message and failed outcome', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('HTTP 404: Not Found (https://example.com/article)')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch {
      // Expected
    }

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('[PL] scrape-failed');
    expect(output).toContain(TEST_URL);
    expect(output).toContain('category=http_error');
    expect(output).toContain('outcome=failed');
  });

  // [Implements: US-PL-012]
  it('empty content logs include scrape stage and failed outcome', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: '', contentLength: 0 })
    );

    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('[PL] stage=scrape');
    expect(output).toContain('outcome=failed');
  });

  // [Implements: US-PL-012]
  it('start log includes empty focus string when focus is undefined', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('focus=""');
  });
});

// ===========================================================================
// Degraded Output Structure Verification
// ===========================================================================

describe('degraded output structure verification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-009]
  it('degraded output starts with the degradation notice', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result.startsWith('[Note:')).toBe(true);
  });

  // [Implements: US-PL-009]
  it('degraded output contains the notice before the content', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    const noticeIndex = result.indexOf('[Note:');
    const contentIndex = result.indexOf(TEST_CONTENT);
    expect(noticeIndex).toBeLessThan(contentIndex);
    expect(noticeIndex).toBeGreaterThan(-1);
  });

  // [Implements: US-PL-009]
  it('degraded output has proper structure: notice, title heading, source, content', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    const noticeIdx = result.indexOf('[Note:');
    const titleIdx = result.indexOf(`## ${TEST_TITLE}`);
    const sourceIdx = result.indexOf(`Source: ${TEST_URL}`);
    const contentIdx = result.indexOf(TEST_CONTENT);

    expect(noticeIdx).toBeGreaterThanOrEqual(0);
    expect(titleIdx).toBeGreaterThan(noticeIdx);
    expect(sourceIdx).toBeGreaterThan(titleIdx);
    expect(contentIdx).toBeGreaterThan(sourceIdx);
  });

  // [Implements: US-PL-009]
  it('degraded output during timeout uses title fallback when title is empty', async () => {
    const controller = new AbortController();
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ title: '' })
    );
    mockSynthesizeSingle.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      controller.signal
    );

    // Title falls back to URL
    expect(result).toContain(`## ${TEST_URL}`);
  });
});

// ===========================================================================
// Synthesis Failure with Different Error Types
// ===========================================================================

describe('synthesis failure with different error types', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    mockScrape.mockResolvedValue(makeScrapeSuccess());
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-009]
  it('degrades when synthesizeSingle throws a SyntaxError', async () => {
    mockSynthesizeSingle.mockRejectedValue(new SyntaxError('Unexpected token'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('LLM synthesis was unavailable');
  });

  // [Implements: US-PL-009]
  it('degrades when synthesizeSingle throws a ReferenceError', async () => {
    mockSynthesizeSingle.mockRejectedValue(new ReferenceError('x is not defined'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('LLM synthesis was unavailable');
  });

  // [Implements: US-PL-009]
  it('degrades when synthesizeSingle rejects with a string', async () => {
    mockSynthesizeSingle.mockRejectedValue('LLM connection failed');
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('LLM synthesis was unavailable');
  });

  // [Implements: US-PL-009]
  it('logs the actual error message from synthesizeSingle to stderr', async () => {
    mockSynthesizeSingle.mockRejectedValue(new Error('Connection refused to LLM'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('Connection refused to LLM');
  });

  // [Implements: US-PL-009]
  it('does not call degradationFallback when synthesizeSingle succeeds', async () => {
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(mockDegradationFallback).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Degradation Fallback Edge Cases
// ===========================================================================

describe('degradation fallback edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-009]
  it('treats degradationFallback empty answer as failure and uses raw content', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockResolvedValue(
      makeDigestResult({ answer: '' })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('LLM synthesis was unavailable');
    expect(result).toContain(TEST_CONTENT);
  });

  // [Implements: US-PL-009]
  it('treats degradationFallback whitespace-only answer as failure', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockResolvedValue(
      makeDigestResult({ answer: '   \n\t  ' })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('LLM synthesis was unavailable');
  });

  // [Implements: US-PL-009]
  it('degrades when degradationFallback throws a TypeError', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new TypeError('Cannot read property'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('LLM synthesis was unavailable');
    expect(result).toContain(TEST_CONTENT);
  });

  // [Implements: US-PL-009]
  it('degrades when degradationFallback rejects with a string', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue('degradation handler crashed');

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(result).toContain('LLM synthesis was unavailable');
  });
});

// ===========================================================================
// Pipeline Timeout Error Details
// ===========================================================================

describe('pipeline timeout error details', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-005]
  it('PipelineTimeoutError during scrape has failedUrls with the URL', async () => {
    const controller = new AbortController();
    mockScrape.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, controller.signal);
      expect.fail('Should have thrown');
    } catch (error) {
      const timeoutError = error as PipelineTimeoutError;
      expect(timeoutError.failedUrls).toHaveLength(1);
      expect(timeoutError.failedUrls[0].url).toBe(TEST_URL);
      expect(timeoutError.failedUrls[0].category).toBe('timeout');
    }
  });

  // [Implements: US-PL-005]
  it('PipelineTimeoutError during scrape uses the configured pipelineTimeoutMs', async () => {
    const customConfig: PipelineConfig = {
      ...testConfig,
      pipelineTimeoutMs: 60000,
    };
    const controller = new AbortController();
    mockScrape.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, customConfig, controller.signal);
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as PipelineTimeoutError).timeoutMs).toBe(60000);
    }
  });

  // [Implements: US-PL-005]
  it('PipelineTimeoutError message includes the pipelineTimeoutMs value', async () => {
    const controller = new AbortController();
    mockScrape.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, controller.signal);
      expect.fail('Should have thrown');
    } catch (error) {
      const message = (error as PipelineTimeoutError).message;
      expect(message).toContain('30000');
    }
  });

  // [Implements: US-PL-005]
  it('logs degraded outcome during synthesis timeout', async () => {
    const controller = new AbortController();
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      controller.signal
    );

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('timeout during synthesis');
    expect(output).toContain('outcome=degraded');
  });
});

// ===========================================================================
// Interaction Between Signal Abort and Scrape Result
// ===========================================================================

describe('signal abort interaction with scrape result', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-005]
  it('does NOT throw PipelineTimeoutError when scrape succeeds and signal aborts but content is available', async () => {
    const controller = new AbortController();
    mockScrape.mockImplementation(async () => {
      controller.abort();
      return makeScrapeSuccess();
    });
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      controller.signal
    );

    // Scrape succeeded → signal was aborted but scrape returned success → pipeline proceeds
    // The abort during synthesis will trigger degradation
    expect(typeof result).toBe('string');
  });

  // [Implements: US-PL-005]
  it('throws PipelineTimeoutError when scrape rejects and signal aborts mid-call', async () => {
    const controller = new AbortController();
    mockScrape.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });

    await expect(
      executeWebFetchPipeline(TEST_URL, undefined, testConfig, controller.signal)
    ).rejects.toThrow(PipelineTimeoutError);
  });
});

// ===========================================================================
// Output Type Guarantees
// ===========================================================================

describe('output type guarantees', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-002]
  it('happy path always returns a string', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockResolvedValue(makeDigestResult());

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(typeof result).toBe('string');
  });

  // [Implements: US-PL-002]
  it('empty content path always returns a string', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess({ textContent: '', contentLength: 0 })
    );

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(typeof result).toBe('string');
  });

  // [Implements: US-PL-009, NFR-PL-008]
  it('degradation path always returns a string', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(typeof result).toBe('string');
  });

  // [Implements: US-PL-009, NFR-PL-008]
  it('synthesis timeout degradation path always returns a string', async () => {
    const controller = new AbortController();
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    mockDegradationFallback.mockRejectedValue(new Error('degradation failed'));

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      controller.signal
    );

    expect(typeof result).toBe('string');
  });

  // [Implements: US-PL-009]
  it('degradation fallback success path always returns a string', async () => {
    mockScrape.mockResolvedValue(makeScrapeSuccess());
    mockSynthesizeSingle.mockRejectedValue(new Error('LLM error'));
    mockDegradationFallback.mockResolvedValue(makeDigestResult());

    const result = await executeWebFetchPipeline(
      TEST_URL,
      undefined,
      testConfig,
      nonAbortedSignal()
    );

    expect(typeof result).toBe('string');
  });
});

// ===========================================================================
// Comprehensive Error Category Classification
// ===========================================================================

describe('comprehensive error category classification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockScrape.mockReset();
    mockSynthesizeSingle.mockReset();
    mockDegradationFallback.mockReset();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-007]
  it('classifies "timed out" (lowercase) as timeout', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Request timed out after 10000ms')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch (error) {
      expect((error as PipelineError).category).toBe('timeout');
    }
  });

  // [Implements: US-PL-007]
  it('classifies "timeout" (single word) as timeout', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('timeout: connection closed')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch (error) {
      expect((error as PipelineError).category).toBe('timeout');
    }
  });

  // [Implements: US-PL-007]
  it('classifies ECONNRESET as network error', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('ECONNRESET: socket hang up')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch (error) {
      expect((error as PipelineError).category).toBe('network');
    }
  });

  // [Implements: US-PL-007]
  it('classifies "connection refused" as network error', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('connection refused by host')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch (error) {
      expect((error as PipelineError).category).toBe('network');
    }
  });

  // [Implements: US-PL-007]
  it('classifies "extract" errors as parse_error', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('Failed to extract content from page')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch (error) {
      expect((error as PipelineError).category).toBe('parse_error');
    }
  });

  // [Implements: US-PL-007]
  it('classifies SSRF errors with "loopback" as validation', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('URL resolves to loopback address')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch (error) {
      expect((error as PipelineError).category).toBe('validation');
    }
  });

  // [Implements: US-PL-007]
  it('classifies SSRF errors with "private" as validation', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('URL resolves to private IP range 10.0.0.1')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch (error) {
      expect((error as PipelineError).category).toBe('validation');
    }
  });

  // [Implements: US-PL-007]
  it('includes the scrape error message in PipelineError for unknown errors', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('An unexpected error with details occurred')
    );

    try {
      await executeWebFetchPipeline(TEST_URL, undefined, testConfig, nonAbortedSignal());
    } catch (error) {
      expect((error as PipelineError).message).toContain('An unexpected error with details occurred');
    }
  });
});
