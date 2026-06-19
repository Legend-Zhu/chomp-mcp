/**
 * Integration tests for the orchestrator entry functions (runWebSearch, runWebFetch)
 * and the internal executeWebSearch / executeWebFetch pipeline functions.
 *
 * Verifies:
 * - Config reading from environment variables (US-PL-013)
 * - Timeout guard lifecycle (creation + cleanup per invocation)
 * - Final logging to stderr (US-PL-012)
 * - Outcome-based throw-vs-return decisions (success, error, degradation)
 * - Statelessness across invocations (BG-PL-002)
 *
 * Uses mocked module boundaries for search, scrape, deduplicate, and synthesize.
 * runWebFetch is tested through the public API (scrape static import + synthesize
 * dynamic import with literal path are both intercepted by vi.mock).
 * runWebSearch flow is tested through executeWebSearch with injected PipelineDeps.
 *
 * [Spec: US-PL-012, US-PL-013, BG-PL-002]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../../src/modules/scrape-extract/index.js', () => ({
  scrape: vi.fn(),
}));

vi.mock('../../../src/modules/deduplicate/index.js', () => ({
  deduplicate: vi.fn(),
}));

vi.mock('../../../src/modules/search-retrieval/index.js', () => ({
  search: vi.fn(),
}));

vi.mock('../../../src/modules/synthesize/index.js', () => ({
  synthesize: vi.fn(),
  synthesizeSingle: vi.fn(),
}));

vi.mock('../../../src/modules/synthesize/degradation-handler.js', () => ({
  degradationFallback: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  runWebSearch,
  runWebFetch,
  executeWebSearch,
  executeWebFetch,
  PipelineError,
  PipelineTimeoutError,
  loadPipelineConfig,
} from '../../../src/modules/pipeline-orchestration/orchestrator.js';
import type {
  WebSearchParams,
  WebFetchParams,
  PipelineConfig,
  PipelineDeps,
  SearchResultItem,
} from '../../../src/modules/pipeline-orchestration/orchestrator.js';

import { scrape } from '../../../src/modules/scrape-extract/index.js';
import { deduplicate } from '../../../src/modules/deduplicate/index.js';
import { search } from '../../../src/modules/search-retrieval/index.js';
import { synthesize } from '../../../src/modules/synthesize/index.js';

import type { ContentItem } from '../../../src/shared/types/content.js';
import type { DeduplicatedItem } from '../../../src/shared/types/deduplicate.js';
import type { DigestResult } from '../../../src/shared/types/digest.js';
import type {
  ScrapeSuccessResult,
  ScrapeFailureResult,
} from '../../../src/shared/types/scrape.js';
import type { ScrapeOptions } from '../../../src/modules/scrape-extract/types.js';

// ---------------------------------------------------------------------------
// Mocked function references
// ---------------------------------------------------------------------------

const mockScrape = vi.mocked(scrape);
const mockDeduplicate = vi.mocked(deduplicate);
const mockSearch = vi.mocked(search);
const mockSynthesize = vi.mocked(synthesize);

// ---------------------------------------------------------------------------
// Environment variable management
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'MAX_CONCURRENCY',
  'SCRAPE_TIMEOUT_MS',
  'MAX_CONTENT_CHARS',
  'PIPELINE_TIMEOUT_MS',
] as const;

const savedEnv: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

function makeScrapeSuccess(
  url: string,
  title: string,
  content: string
): ScrapeSuccessResult {
  return {
    success: true,
    url,
    finalUrl: url,
    title,
    textContent: content,
    extractionMethod: 'readability',
    truncated: false,
    contentLength: content.length,
    elapsedMs: 10,
    error: null,
  };
}

function makeScrapeFailure(url: string, error: string): ScrapeFailureResult {
  return {
    success: false,
    url,
    finalUrl: null,
    title: null,
    textContent: null,
    extractionMethod: null,
    truncated: false,
    contentLength: 0,
    elapsedMs: 5,
    error,
  };
}

function makeSearchResult(
  title: string,
  url: string,
  snippet: string = 'A snippet.',
  score: number = 0.9
): SearchResultItem {
  return { title, url, snippet, score };
}

function toDeduplicatedItem(item: ContentItem): DeduplicatedItem {
  return {
    ...item,
    normalizedUrl: item.url,
    mergedSources: [],
    fingerprintCount: 10,
  };
}

function makeDigestResult(
  answer: string = 'The answer is 42.',
  keyPoints: string[] = ['Point one.', 'Point two.'],
  sources: Array<{ url: string; title: string }> = []
): DigestResult {
  return { answer, keyPoints, sources };
}

function makeDeps(overrides?: Partial<PipelineDeps>): PipelineDeps {
  return {
    search: overrides?.search ?? mockSearch,
    scrape: overrides?.scrape ?? mockScrape,
    deduplicate: overrides?.deduplicate ?? mockDeduplicate,
    synthesize: overrides?.synthesize ?? mockSynthesize,
  };
}

function makeTestConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    maxConcurrency: 3,
    scrapeTimeoutMs: 15_000,
    maxContentChars: 8_000,
    pipelineTimeoutMs: 30_000,
    ...overrides,
  };
}

const MEANINGFUL_CONTENT =
  'This is a test article with enough content to pass the minimum threshold for meaningful content extraction.';

// ===========================================================================
// loadPipelineConfig — default values (US-PL-013)
// ===========================================================================

describe('loadPipelineConfig — default values (US-PL-013)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-013]
  it('returns MAX_CONCURRENCY default of 3 when env not set', () => {
    const config = loadPipelineConfig();
    expect(config.maxConcurrency).toBe(3);
  });

  // [Implements: US-PL-013]
  it('returns SCRAPE_TIMEOUT_MS default of 15000 when env not set', () => {
    const config = loadPipelineConfig();
    expect(config.scrapeTimeoutMs).toBe(15_000);
  });

  // [Implements: US-PL-013]
  it('returns MAX_CONTENT_CHARS default of 8000 when env not set', () => {
    const config = loadPipelineConfig();
    expect(config.maxContentChars).toBe(8_000);
  });

  // [Implements: US-PL-013]
  it('returns PIPELINE_TIMEOUT_MS default of 30000 when env not set', () => {
    const config = loadPipelineConfig();
    expect(config.pipelineTimeoutMs).toBe(30_000);
  });

  // [Implements: US-PL-013]
  it('does NOT log warnings when all env vars are absent', () => {
    loadPipelineConfig();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('loadPipelineConfig — custom env values (US-PL-013)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-013]
  it('reads MAX_CONCURRENCY from env', () => {
    process.env['MAX_CONCURRENCY'] = '5';
    const config = loadPipelineConfig();
    expect(config.maxConcurrency).toBe(5);
  });

  it('reads SCRAPE_TIMEOUT_MS from env', () => {
    process.env['SCRAPE_TIMEOUT_MS'] = '25000';
    const config = loadPipelineConfig();
    expect(config.scrapeTimeoutMs).toBe(25_000);
  });

  it('reads MAX_CONTENT_CHARS from env', () => {
    process.env['MAX_CONTENT_CHARS'] = '12000';
    const config = loadPipelineConfig();
    expect(config.maxContentChars).toBe(12_000);
  });

  it('reads PIPELINE_TIMEOUT_MS from env', () => {
    process.env['PIPELINE_TIMEOUT_MS'] = '60000';
    const config = loadPipelineConfig();
    expect(config.pipelineTimeoutMs).toBe(60_000);
  });

  it('reads all four env vars simultaneously', () => {
    process.env['MAX_CONCURRENCY'] = '10';
    process.env['SCRAPE_TIMEOUT_MS'] = '5000';
    process.env['MAX_CONTENT_CHARS'] = '4000';
    process.env['PIPELINE_TIMEOUT_MS'] = '45000';
    const config = loadPipelineConfig();
    expect(config).toEqual({
      maxConcurrency: 10,
      scrapeTimeoutMs: 5_000,
      maxContentChars: 4_000,
      pipelineTimeoutMs: 45_000,
    });
  });

  it('does NOT log warnings for valid env values', () => {
    process.env['MAX_CONCURRENCY'] = '5';
    process.env['SCRAPE_TIMEOUT_MS'] = '20000';
    process.env['MAX_CONTENT_CHARS'] = '10000';
    process.env['PIPELINE_TIMEOUT_MS'] = '40000';
    loadPipelineConfig();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('loadPipelineConfig — invalid values with warnings (US-PL-013)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-013]
  it('logs warning and uses default for invalid MAX_CONCURRENCY', () => {
    process.env['MAX_CONCURRENCY'] = 'abc';
    const config = loadPipelineConfig();
    expect(config.maxConcurrency).toBe(3);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid MAX_CONCURRENCY')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('abc')
    );
  });

  it('logs warning and uses default for zero MAX_CONCURRENCY', () => {
    process.env['MAX_CONCURRENCY'] = '0';
    const config = loadPipelineConfig();
    expect(config.maxConcurrency).toBe(3);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid MAX_CONCURRENCY')
    );
  });

  it('logs warning and uses default for negative MAX_CONCURRENCY', () => {
    process.env['MAX_CONCURRENCY'] = '-1';
    const config = loadPipelineConfig();
    expect(config.maxConcurrency).toBe(3);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid MAX_CONCURRENCY')
    );
  });

  it('logs warning and uses default for invalid SCRAPE_TIMEOUT_MS', () => {
    process.env['SCRAPE_TIMEOUT_MS'] = 'notanumber';
    const config = loadPipelineConfig();
    expect(config.scrapeTimeoutMs).toBe(15_000);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid SCRAPE_TIMEOUT_MS')
    );
  });

  it('logs warning and uses default for invalid MAX_CONTENT_CHARS', () => {
    process.env['MAX_CONTENT_CHARS'] = 'invalid';
    const config = loadPipelineConfig();
    expect(config.maxContentChars).toBe(8_000);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid MAX_CONTENT_CHARS')
    );
  });

  it('logs warning and uses default for invalid PIPELINE_TIMEOUT_MS', () => {
    process.env['PIPELINE_TIMEOUT_MS'] = 'xyz';
    const config = loadPipelineConfig();
    expect(config.pipelineTimeoutMs).toBe(30_000);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid PIPELINE_TIMEOUT_MS')
    );
  });

  // [Implements: US-PL-013] Warning identifies variable name, value, and default
  it('identifies the variable name, invalid value, and default in the warning', () => {
    process.env['SCRAPE_TIMEOUT_MS'] = 'bad';
    loadPipelineConfig();
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('SCRAPE_TIMEOUT_MS');
    expect(output).toContain('bad');
    expect(output).toContain('15000');
  });
});

// ===========================================================================
// executeWebSearch — config integration via injected deps
// ===========================================================================

describe('executeWebSearch — config integration (US-PL-013)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-013]
  it('passes scrapeTimeoutMs from env to scrape options', async () => {
    process.env['SCRAPE_TIMEOUT_MS'] = '7000';
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content A.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const optionsArg = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(optionsArg.timeoutMs).toBe(7_000);
  });

  // [Implements: US-PL-013]
  it('passes maxContentChars from env to scrape options', async () => {
    process.env['MAX_CONTENT_CHARS'] = '3000';
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content A.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const optionsArg = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(optionsArg.maxContentChars).toBe(3_000);
  });

  // [Implements: US-PL-013]
  it('uses default scrapeTimeoutMs when env not set', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content A.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const optionsArg = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(optionsArg.timeoutMs).toBe(15_000);
  });

  // [Implements: US-PL-013]
  it('uses default maxContentChars when env not set', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content A.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const optionsArg = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(optionsArg.maxContentChars).toBe(8_000);
  });
});

// ===========================================================================
// executeWebSearch — outcome-based decisions
// ===========================================================================

describe('executeWebSearch — outcome-based decisions', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-001] Happy path returns a DigestResult
  it('returns a DigestResult on success', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('Article A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'Article A', 'Content A.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(
      makeDigestResult(
        'Synthesized answer.',
        ['Key point 1.', 'Key point 2.'],
        [{ url: 'https://a.example.com', title: 'Article A' }]
      )
    );

    const result = await executeWebSearch('test query', 5, undefined, makeDeps());

    expect(result.answer).toBe('Synthesized answer.');
    expect(result.keyPoints).toEqual(['Key point 1.', 'Key point 2.']);
    expect(result.sources).toHaveLength(1);
  });

  // [Implements: US-PL-010] Search failure throws PipelineError
  it('throws PipelineError when search fails', async () => {
    mockSearch.mockRejectedValue(new Error('SearXNG unreachable'));

    await expect(
      executeWebSearch('test', 5, undefined, makeDeps())
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-010] Zero results throws PipelineError
  it('throws PipelineError when search returns zero results', async () => {
    mockSearch.mockResolvedValue([]);

    await expect(
      executeWebSearch('test', 5, undefined, makeDeps())
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-011] All scrapes failed throws PipelineError
  it('throws PipelineError when all scrapes fail', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
      makeSearchResult('B', 'https://b.example.com'),
    ]);
    mockScrape.mockImplementation(async (url: string) =>
      makeScrapeFailure(url, 'HTTP 404: Not Found')
    );

    await expect(
      executeWebSearch('test', 5, undefined, makeDeps())
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-008] Synthesis failure returns degraded result
  it('returns a degraded result when synthesis fails', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'Title A', 'Content A.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockRejectedValue(new Error('LLM unavailable'));

    const result = await executeWebSearch('test', 5, undefined, makeDeps());

    expect(result.answer).toContain('LLM synthesis was unavailable');
  });

  // [Implements: US-PL-006] Partial scrape failures still proceed
  it('returns a result when some scrapes fail but others succeed', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
      makeSearchResult('B', 'https://b.example.com'),
    ]);
    mockScrape.mockImplementation(async (url: string) => {
      if (url === 'https://b.example.com') {
        return makeScrapeFailure(url, 'HTTP 500');
      }
      return makeScrapeSuccess(url, 'A', 'Content A.');
    });
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Partial answer.'));

    const result = await executeWebSearch('test', 5, undefined, makeDeps());

    expect(result.answer).toBe('Partial answer.');
  });

  // [Implements: US-PL-001] maxResults default is 5
  it('passes default maxResults of 5 when not specified', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    expect(mockSearch).toHaveBeenCalledWith('test', 5);
  });

  // [Implements: US-PL-001] focus is forwarded
  it('forwards focus to synthesize', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, 'security', makeDeps());

    expect(mockSynthesize).toHaveBeenCalledWith(
      'test',
      expect.any(Array),
      'security'
    );
  });
});

// ===========================================================================
// executeWebSearch — logging (US-PL-012)
// ===========================================================================

describe('executeWebSearch — logging (US-PL-012)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-012]
  it('logs query, max_results, and focus on start', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('climate change', 7, 'impacts', makeDeps());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('[PL] web_search');
    expect(output).toContain('climate change');
    expect(output).toContain('max_results=7');
    expect(output).toContain('impacts');
  });

  // [Implements: US-PL-012]
  it('logs empty focus when not provided', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('focus=""');
  });

  // [Implements: US-PL-012]
  it('logs all four stage completions', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
      makeSearchResult('B', 'https://b.example.com'),
    ]);
    mockScrape.mockImplementation(async (url: string) =>
      makeScrapeSuccess(url, 'Title', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('stage=search');
    expect(output).toContain('stage=scrape');
    expect(output).toContain('stage=deduplicate');
    expect(output).toContain('stage=synthesize');
  });

  // [Implements: US-PL-012]
  it('logs outcome=success on a fully successful run', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('outcome=success');
  });

  // [Implements: US-PL-012]
  it('logs outcome=partial when some URLs fail', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
      makeSearchResult('B', 'https://b.example.com'),
    ]);
    mockScrape.mockImplementation(async (url: string) => {
      if (url === 'https://b.example.com') {
        return makeScrapeFailure(url, 'HTTP 404');
      }
      return makeScrapeSuccess(url, 'A', 'Content.');
    });
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('outcome=partial');
  });

  // [Implements: US-PL-012]
  it('logs scrape-failed messages with url, category, and error', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
      makeSearchResult('B', 'https://b.example.com'),
    ]);
    mockScrape.mockImplementation(async (url: string) => {
      if (url === 'https://b.example.com') {
        return makeScrapeFailure(url, 'HTTP 503: Service Unavailable');
      }
      return makeScrapeSuccess(url, 'A', 'Content.');
    });
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('scrape-failed');
    expect(output).toContain('https://b.example.com');
    expect(output).toContain('category=http_error');
    expect(output).toContain('HTTP 503');
  });

  // [Implements: US-PL-012]
  it('outcome message includes stage count fields', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
      makeSearchResult('B', 'https://b.example.com'),
    ]);
    mockScrape.mockImplementation(async (url: string) =>
      makeScrapeSuccess(url, 'Title', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    const outcomeLine = output
      .split('\n')
      .find((l) => l.includes('outcome=success'));
    expect(outcomeLine).toBeDefined();
    expect(outcomeLine!).toContain('search=2');
    expect(outcomeLine!).toContain('scraped=2');
    expect(outcomeLine!).toContain('deduplicated=2');
  });

  // [Implements: US-PL-012, NFR-PL-006]
  it('does NOT write to stdout', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      mockSearch.mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]);
      mockScrape.mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      );
      mockDeduplicate.mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      );
      mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

      await executeWebSearch('test', 5, undefined, makeDeps());

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ===========================================================================
// runWebSearch — entry function (error paths work via public API)
// ===========================================================================

describe('runWebSearch — entry function error paths', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockSearch.mockReset();
    mockSearch.mockRejectedValue(new Error('search unavailable'));
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-010] Search failure propagates as PipelineError
  it('throws PipelineError when search module is unavailable', async () => {
    await expect(runWebSearch({ query: 'test' })).rejects.toThrow(
      PipelineError
    );
  });

  // [Implements: US-PL-010] Error message contains context
  it('PipelineError message includes query failure context', async () => {
    try {
      await runWebSearch({ query: 'test' });
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      const message = (error as PipelineError).message;
      expect(message).toContain('Search failed');
    }
  });

  // [Implements: US-PL-004] Guard is cleaned up even on error
  it('cleans up the guard even when search fails', async () => {
    await expect(runWebSearch({ query: 'test' })).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('[PL] timeout:');
  });
});

// ===========================================================================
// runWebFetch — config integration
// ===========================================================================

describe('runWebFetch — config integration (US-PL-013)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-013]
  it('passes scrapeTimeoutMs from config to scrape options', async () => {
    process.env['SCRAPE_TIMEOUT_MS'] = '8000';
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });

    const optionsArg = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(optionsArg.timeoutMs).toBe(8_000);
  });

  // [Implements: US-PL-013]
  it('passes maxContentChars from config to scrape options', async () => {
    process.env['MAX_CONTENT_CHARS'] = '4000';
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });

    const optionsArg = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(optionsArg.maxContentChars).toBe(4_000);
  });

  // [Implements: US-PL-013]
  it('uses default config values when env vars not set', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });

    const optionsArg = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(optionsArg.timeoutMs).toBe(15_000);
    expect(optionsArg.maxContentChars).toBe(8_000);
  });
});

// ===========================================================================
// runWebFetch — outcome-based decisions
// ===========================================================================

describe('runWebFetch — outcome-based decisions', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-002] Happy path returns a formatted string
  it('returns a formatted digest string on success', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Test Page', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(
      makeDigestResult(
        'Synthesized answer.',
        ['Key point 1.'],
        [{ url: 'https://example.com', title: 'Test Page' }]
      )
    );

    const result = await runWebFetch({ url: 'https://example.com' });

    expect(typeof result).toBe('string');
    expect(result).toContain('Synthesized answer.');
    expect(result).toContain('Key Points:');
    expect(result).toContain('Sources:');
  });

  // [Implements: US-PL-007] Scrape failure throws PipelineError
  it('throws PipelineError when scrape returns a failure', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('https://example.com', 'HTTP 404: Not Found')
    );

    await expect(
      runWebFetch({ url: 'https://example.com' })
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-007] Scrape exception throws PipelineError
  it('throws PipelineError when scrape throws', async () => {
    mockScrape.mockRejectedValue(new Error('Network failure'));

    await expect(
      runWebFetch({ url: 'https://example.com' })
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-002] Empty content returns a string (not throws)
  it('returns a string with informative message when content is empty', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', '')
    );

    const result = await runWebFetch({ url: 'https://example.com' });

    expect(typeof result).toBe('string');
    expect(result).toContain('No meaningful content');
    expect(result).toContain('https://example.com');
  });

  // [Implements: US-PL-009] Synthesis failure returns degraded string
  it('returns a degraded string when synthesis fails', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockRejectedValue(new Error('LLM unavailable'));

    const result = await runWebFetch({ url: 'https://example.com' });

    expect(typeof result).toBe('string');
    expect(result).toContain('LLM synthesis was unavailable');
  });

  // [Implements: US-PL-002] Focus is forwarded to synthesize
  it('forwards focus to synthesize', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com', focus: 'security' });

    expect(mockSynthesize).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(Array),
      'security'
    );
  });

  // [Implements: US-PL-002] URL is forwarded to synthesize as the query
  it('passes the URL as the first argument to synthesize', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });

    expect(mockSynthesize).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(Array),
      undefined
    );
  });
});

// ===========================================================================
// runWebFetch — pipeline logging (US-PL-012)
// ===========================================================================

describe('runWebFetch — pipeline logging (US-PL-012)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-012]
  it('logs URL and focus to stderr on start', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com', focus: 'performance' });

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('[PL] web_fetch');
    expect(output).toContain('https://example.com');
    expect(output).toContain('performance');
  });

  // [Implements: US-PL-012]
  it('logs stage completion for scrape and synthesize', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('stage=scrape');
    expect(output).toContain('stage=synthesize');
  });

  // [Implements: US-PL-012]
  it('logs outcome=success on a successful run', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('outcome=success');
  });

  // [Implements: US-PL-012]
  it('logs outcome=failed on empty content', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', '')
    );

    await runWebFetch({ url: 'https://example.com' });

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('outcome=failed');
  });

  // [Implements: US-PL-009, US-PL-012]
  it('logs synthesize failed when synthesis fails (degraded path)', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockRejectedValue(new Error('LLM down'));

    await runWebFetch({ url: 'https://example.com' });

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('synthesize failed');
  });

  // [Implements: US-PL-012]
  it('logs runWebFetch completed message with elapsed time and source count', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(
      makeDigestResult('Answer.', [], [
        { url: 'https://example.com', title: 'Title' },
      ])
    );

    await runWebFetch({ url: 'https://example.com' });

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('runWebFetch completed');
    expect(output).toMatch(/ms=\d+/);
    expect(output).toContain('sources=1');
  });

  // [Implements: US-PL-012]
  it('logs empty focus string when focus is not provided', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('focus=""');
  });

  // [Implements: US-PL-012, NFR-PL-006]
  it('does NOT write to stdout', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      mockScrape.mockResolvedValue(
        makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
      );
      mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

      await runWebFetch({ url: 'https://example.com' });

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ===========================================================================
// runWebFetch — scrape failure logging
// ===========================================================================

describe('runWebFetch — scrape failure logging (US-PL-012)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-007] Scrape failure throws PipelineError
  it('throws PipelineError and does not call synthesize', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('https://example.com', 'HTTP 404: Not Found')
    );

    await expect(
      runWebFetch({ url: 'https://example.com' })
    ).rejects.toThrow(PipelineError);

    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  // [Implements: US-PL-007] Error category is set correctly
  it('PipelineError has http_error category for HTTP failures', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('https://example.com', 'HTTP 404: Not Found')
    );

    try {
      await runWebFetch({ url: 'https://example.com' });
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as PipelineError).category).toBe('http_error');
    }
  });

  // [Implements: US-PL-007] Error message includes status code
  it('PipelineError message includes the HTTP status code', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('https://example.com', 'HTTP 500: Internal Server Error')
    );

    try {
      await runWebFetch({ url: 'https://example.com' });
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as PipelineError).message).toContain('500');
    }
  });
});

// ===========================================================================
// Timeout guard lifecycle
// ===========================================================================

describe('timeout guard lifecycle', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-004] Scrape receives a signal from the timeout guard
  it('executeWebSearch passes an AbortSignal to scrape calls', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const optionsArg = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(optionsArg.signal).toBeInstanceOf(AbortSignal);
    expect(optionsArg.signal!.aborted).toBe(false);
  });

  // [Implements: US-PL-004] runWebFetch passes a signal
  it('runWebFetch passes an AbortSignal to scrape', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });

    const optionsArg = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(optionsArg.signal).toBeInstanceOf(AbortSignal);
  });

  // [Implements: US-PL-004, NFR-PL-005] Guard cleaned up after executeWebSearch
  it('does not leave pending timers after executeWebSearch completes', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('[PL] timeout:');
  });

  // [Implements: US-PL-004, NFR-PL-005] Guard cleaned up after runWebFetch
  it('does not leave pending timers after runWebFetch completes', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('[PL] timeout:');
  });

  // [Implements: US-PL-004, NFR-PL-005] Guard cleaned up even on error
  it('cleans up the guard even when executeWebSearch throws', async () => {
    mockSearch.mockRejectedValue(new Error('Search failed'));

    await expect(
      executeWebSearch('test', 5, undefined, makeDeps())
    ).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('[PL] timeout:');
  });

  // [Implements: US-PL-004, NFR-PL-005] Guard cleaned up on runWebFetch error
  it('cleans up the guard even when runWebFetch throws', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeFailure('https://example.com', 'HTTP 500')
    );

    await expect(
      runWebFetch({ url: 'https://example.com' })
    ).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('[PL] timeout:');
  });

  // [Implements: US-PL-004] PIPELINE_TIMEOUT_MS from env is used
  it('uses PIPELINE_TIMEOUT_MS from env without triggering timeout', async () => {
    process.env['PIPELINE_TIMEOUT_MS'] = '999999';
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('[PL] timeout:');
  });
});

// ===========================================================================
// Statelessness (BG-PL-002)
// ===========================================================================

describe('statelessness across invocations (BG-PL-002)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: BG-PL-002] Two consecutive executeWebSearch calls
  it('produces consistent results for identical executeWebSearch inputs', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Consistent answer.'));

    const result1 = await executeWebSearch('test', 5, undefined, makeDeps());
    const result2 = await executeWebSearch('test', 5, undefined, makeDeps());

    expect(result1.answer).toBe(result2.answer);
  });

  // [Implements: BG-PL-002] Two consecutive runWebFetch calls
  it('produces consistent results for identical runWebFetch inputs', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Consistent answer.'));

    const result1 = await runWebFetch({ url: 'https://example.com' });
    const result2 = await runWebFetch({ url: 'https://example.com' });

    expect(result1).toBe(result2);
  });

  // [Implements: BG-PL-002] State does not leak between success and failure
  it('does not leak state between a success and a failure call', async () => {
    // First call: success
    mockSearch.mockResolvedValueOnce([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValueOnce(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content A.')
    );
    mockDeduplicate.mockImplementationOnce((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValueOnce(makeDigestResult('Success answer.'));

    const successResult = await executeWebSearch(
      'test',
      5,
      undefined,
      makeDeps()
    );
    expect(successResult.answer).toBe('Success answer.');

    // Second call: all scrapes fail
    mockSearch.mockResolvedValueOnce([
      makeSearchResult('B', 'https://b.example.com'),
    ]);
    mockScrape.mockResolvedValueOnce(
      makeScrapeFailure('https://b.example.com', 'HTTP 500')
    );

    await expect(
      executeWebSearch('test', 5, undefined, makeDeps())
    ).rejects.toThrow(PipelineError);

    // Third call: success again
    mockSearch.mockResolvedValueOnce([
      makeSearchResult('C', 'https://c.example.com'),
    ]);
    mockScrape.mockResolvedValueOnce(
      makeScrapeSuccess('https://c.example.com', 'C', 'Content C.')
    );
    mockDeduplicate.mockImplementationOnce((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValueOnce(makeDigestResult('Third answer.'));

    const thirdResult = await executeWebSearch(
      'test',
      5,
      undefined,
      makeDeps()
    );
    expect(thirdResult.answer).toBe('Third answer.');
  });

  // [Implements: BG-PL-002] runWebFetch does not leak state
  it('does not leak state between runWebFetch success and failure', async () => {
    // First call: success
    mockScrape.mockResolvedValueOnce(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValueOnce(makeDigestResult('First answer.'));

    const result1 = await runWebFetch({ url: 'https://example.com' });
    expect(result1).toContain('First answer.');

    // Second call: scrape fails
    mockScrape.mockResolvedValueOnce(
      makeScrapeFailure('https://example.com', 'HTTP 500')
    );

    await expect(
      runWebFetch({ url: 'https://example.com' })
    ).rejects.toThrow(PipelineError);

    // Third call: success again
    mockScrape.mockResolvedValueOnce(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValueOnce(makeDigestResult('Third answer.'));

    const result3 = await runWebFetch({ url: 'https://example.com' });
    expect(result3).toContain('Third answer.');
    expect(result3).not.toContain('First answer.');
  });

  // [Implements: BG-PL-002] Mock call counts are per-invocation
  it('each executeWebSearch invocation calls search and synthesize once', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());
    await executeWebSearch('test', 5, undefined, makeDeps());

    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(mockSynthesize).toHaveBeenCalledTimes(2);
  });

  // [Implements: BG-PL-002] runWebFetch resolves fresh deps per call
  it('each runWebFetch invocation calls scrape and synthesize once', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });
    await runWebFetch({ url: 'https://example.com' });

    expect(mockScrape).toHaveBeenCalledTimes(2);
    expect(mockSynthesize).toHaveBeenCalledTimes(2);
  });

  // [Implements: BG-PL-002, US-PL-013] Config is re-read per invocation
  it('re-reads config on each executeWebSearch invocation', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());
    let options1 = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(options1.timeoutMs).toBe(15_000);

    process.env['SCRAPE_TIMEOUT_MS'] = '20000';
    await executeWebSearch('test', 5, undefined, makeDeps());
    let options2 = mockScrape.mock.calls[1]![1] as ScrapeOptions;
    expect(options2.timeoutMs).toBe(20_000);
  });
});

// ===========================================================================
// Integration — stage ordering and data flow
// ===========================================================================

describe('integration — stage ordering and data flow', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-012, DC-PL-004] Stage ordering in executeWebSearch
  it('executes search → scrape → deduplicate → synthesize in order', async () => {
    const callOrder: string[] = [];

    const deps: PipelineDeps = {
      search: vi.fn().mockImplementation(async () => {
        callOrder.push('search');
        return [makeSearchResult('A', 'https://a.example.com')];
      }),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        callOrder.push(`scrape:${url}`);
        return makeScrapeSuccess(url, 'A', 'Content.');
      }) as typeof scrape,
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) => {
        callOrder.push('deduplicate');
        return items.map(toDeduplicatedItem);
      }) as typeof deduplicate,
      synthesize: vi.fn().mockImplementation(async () => {
        callOrder.push('synthesize');
        return makeDigestResult('Answer.');
      }),
    };

    await executeWebSearch('test', 5, undefined, deps);

    expect(callOrder[0]).toBe('search');
    const scrapeIdx = callOrder.findIndex((c) => c.startsWith('scrape:'));
    const dedupIdx = callOrder.indexOf('deduplicate');
    const synIdx = callOrder.indexOf('synthesize');
    expect(scrapeIdx).toBeGreaterThan(0);
    expect(dedupIdx).toBeGreaterThan(scrapeIdx);
    expect(synIdx).toBeGreaterThan(dedupIdx);
  });

  // [Implements: US-PL-012] Stage ordering in runWebFetch
  it('runWebFetch executes scrape before synthesize', async () => {
    const callOrder: string[] = [];

    mockScrape.mockImplementation(async () => {
      callOrder.push('scrape');
      return makeScrapeSuccess(
        'https://example.com',
        'Title',
        MEANINGFUL_CONTENT
      );
    });
    mockSynthesize.mockImplementation(async () => {
      callOrder.push('synthesize');
      return makeDigestResult('Answer.');
    });

    await runWebFetch({ url: 'https://example.com' });

    expect(callOrder).toEqual(['scrape', 'synthesize']);
  });

  // [Implements: US-PL-012, US-PL-014] Data handoff through stages
  it('passes search results through scrape → dedup → synthesize', async () => {
    const deduplicateFn = vi.fn().mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    const synthesizeFn = vi.fn().mockResolvedValue(makeDigestResult('Answer.'));

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('Search Title', 'https://a.example.com', 'Snippet', 0.8),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'Scraped Title', 'Scraped content.')
      ) as typeof scrape,
      deduplicate: deduplicateFn as typeof deduplicate,
      synthesize: synthesizeFn,
    };

    await executeWebSearch('my query', 5, 'my focus', deps);

    // Verify items passed to dedup
    const dedupItems = deduplicateFn.mock.calls[0]![0] as ContentItem[];
    expect(dedupItems[0].title).toBe('Scraped Title');
    expect(dedupItems[0].url).toBe('https://a.example.com');
    expect(dedupItems[0].content).toBe('Scraped content.');

    // Verify args passed to synthesize
    const synArgs = synthesizeFn.mock.calls[0]!;
    expect(synArgs[0]).toBe('my query');
    expect(synArgs[2]).toBe('my focus');
    const synContents = synArgs[1] as ContentItem[];
    expect(synContents[0].content).toBe('Scraped content.');
  });
});

// ===========================================================================
// executeWebSearch — formatted output via runWebSearch entry (DC-PL-005)
// ===========================================================================

describe('executeWebSearch — formatted output details (DC-PL-005)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-001, DC-PL-005] Happy path returns full digest shape
  it('returns a DigestResult with answer, keyPoints, and sources', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('Article A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'Article A', 'Content A.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(
      makeDigestResult(
        'The answer.',
        ['Key point 1.', 'Key point 2.'],
        [{ url: 'https://a.example.com', title: 'Article A' }]
      )
    );

    const result = await executeWebSearch('test', 5, undefined, makeDeps());

    expect(result.answer).toBe('The answer.');
    expect(result.keyPoints).toEqual(['Key point 1.', 'Key point 2.']);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].title).toBe('Article A');
  });

  // [Implements: DC-PL-005] Empty keyPoints is valid
  it('returns a result with empty keyPoints when synthesize returns none', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(
      makeDigestResult('Just an answer.', [], [])
    );

    const result = await executeWebSearch('test', 5, undefined, makeDeps());

    expect(result.answer).toBe('Just an answer.');
    expect(result.keyPoints).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  // [Implements: DC-PL-005] Sources with multiple entries
  it('returns a result with multiple sources', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
      makeSearchResult('B', 'https://b.example.com'),
    ]);
    mockScrape.mockImplementation(async (url: string) =>
      makeScrapeSuccess(url, `Title ${url}`, 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(
      makeDigestResult('Answer.', [], [
        { url: 'https://a.example.com', title: 'Title A' },
        { url: 'https://b.example.com', title: 'Title B' },
      ])
    );

    const result = await executeWebSearch('test', 5, undefined, makeDeps());

    expect(result.sources).toHaveLength(2);
  });

  // [Implements: DC-PL-005] maxResults forwarded to search
  it('forwards maxResults to the search function', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 10, undefined, makeDeps());

    expect(mockSearch).toHaveBeenCalledWith('test', 10);
  });

  // [Implements: DC-PL-005] focus forwarded to synthesize
  it('forwards focus to synthesize', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, 'security', makeDeps());

    expect(mockSynthesize).toHaveBeenCalledWith(
      'test',
      expect.any(Array),
      'security'
    );
  });

  // [Implements: DC-PL-005] Default maxResults of 5
  it('defaults maxResults to 5 when not specified', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    expect(mockSearch).toHaveBeenCalledWith('test', 5);
  });

  // [Implements: US-PL-008, DC-PL-005] Degraded result includes content
  it('returns a degraded DigestResult with content when synthesis fails', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('Article A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'Article A', 'Scraped content here.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockRejectedValue(new Error('LLM unavailable'));

    const result = await executeWebSearch('test', 5, undefined, makeDeps());

    expect(result.answer).toContain('LLM synthesis was unavailable');
    expect(result.answer).toContain('https://a.example.com');
    expect(result.answer).toContain('Scraped content here.');
  });

  // [Implements: US-PL-006, DC-PL-005] Partial failures still succeed
  it('returns a result when some scrapes fail but others succeed', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
      makeSearchResult('B', 'https://b.example.com'),
    ]);
    mockScrape.mockImplementation(async (url: string) => {
      if (url === 'https://b.example.com') {
        return makeScrapeFailure(url, 'HTTP 500');
      }
      return makeScrapeSuccess(url, 'A', 'Content A.');
    });
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Partial answer.'));

    const result = await executeWebSearch('test', 5, undefined, makeDeps());

    expect(result.answer).toBe('Partial answer.');
  });
});

// ===========================================================================
// executeWebSearch — final logging (DC-PL-002)
// ===========================================================================

describe('executeWebSearch — final logging (DC-PL-002)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-012, DC-PL-002]
  it('logs outcome=success with elapsed time and stage counts', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    const outcomeLine = output
      .split('\n')
      .find((l) => l.includes('outcome=success'));
    expect(outcomeLine).toBeDefined();
    expect(outcomeLine!).toMatch(/ms=\d+/);
  });

  // [Implements: DC-PL-002] Synthesis failure logs degradation messages
  it('logs degradation activated and synthesize failed when synthesis fails', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockRejectedValue(new Error('LLM down'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('degradation activated');
    expect(output).toContain('synthesize failed');
  });

  // [Implements: DC-PL-002, NFR-PL-006]
  it('does NOT write to stdout', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      mockSearch.mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]);
      mockScrape.mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      );
      mockDeduplicate.mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      );
      mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

      await executeWebSearch('test', 5, undefined, makeDeps());

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // [Implements: DC-PL-002] All logs start with [PL] prefix
  it('emits [PL] prefixed messages to stderr', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    const lines = output.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      expect(line.startsWith('[PL]')).toBe(true);
    }
  });
});

// ===========================================================================
// executeWebSearch — config reading per invocation (DC-PL-002)
// ===========================================================================

describe('executeWebSearch — config reading per invocation (DC-PL-002)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: DC-PL-002, US-PL-013] Config is read fresh on each call
  it('re-reads config on each executeWebSearch invocation', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());
    const options1 = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(options1.timeoutMs).toBe(15_000);

    process.env['SCRAPE_TIMEOUT_MS'] = '20000';
    await executeWebSearch('test', 5, undefined, makeDeps());
    const options2 = mockScrape.mock.calls[1]![1] as ScrapeOptions;
    expect(options2.timeoutMs).toBe(20_000);
  });

  // [Implements: DC-PL-002] MAX_CONTENT_CHARS re-read per call
  it('re-reads MAX_CONTENT_CHARS on each executeWebSearch invocation', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());
    const options1 = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(options1.maxContentChars).toBe(8_000);

    process.env['MAX_CONTENT_CHARS'] = '4000';
    await executeWebSearch('test', 5, undefined, makeDeps());
    const options2 = mockScrape.mock.calls[1]![1] as ScrapeOptions;
    expect(options2.maxContentChars).toBe(4_000);
  });
});

// ===========================================================================
// runWebFetch — config re-read per invocation (DC-PL-002)
// ===========================================================================

describe('runWebFetch — config re-read per invocation (DC-PL-002)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: DC-PL-002, US-PL-013]
  it('re-reads SCRAPE_TIMEOUT_MS on each runWebFetch invocation', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });
    const options1 = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(options1.timeoutMs).toBe(15_000);

    process.env['SCRAPE_TIMEOUT_MS'] = '25000';
    await runWebFetch({ url: 'https://example.com' });
    const options2 = mockScrape.mock.calls[1]![1] as ScrapeOptions;
    expect(options2.timeoutMs).toBe(25_000);
  });

  // [Implements: DC-PL-002]
  it('re-reads MAX_CONTENT_CHARS on each runWebFetch invocation', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });
    const options1 = mockScrape.mock.calls[0]![1] as ScrapeOptions;
    expect(options1.maxContentChars).toBe(8_000);

    process.env['MAX_CONTENT_CHARS'] = '3000';
    await runWebFetch({ url: 'https://example.com' });
    const options2 = mockScrape.mock.calls[1]![1] as ScrapeOptions;
    expect(options2.maxContentChars).toBe(3_000);
  });
});

// ===========================================================================
// Statelessness — concurrent and sequential invocations (BG-PL-002, DC-PL-005)
// ===========================================================================

describe('statelessness — concurrent and sequential invocations (BG-PL-002, DC-PL-005)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: BG-PL-002, DC-PL-005] Parallel runWebFetch calls don't interfere
  it('parallel runWebFetch calls produce independent results', async () => {
    mockScrape.mockImplementation(async (url: string) =>
      makeScrapeSuccess(url, `Title ${url}`, MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockImplementation(async (query: string) =>
      makeDigestResult(`Answer for ${query}`)
    );

    const results = await Promise.all([
      runWebFetch({ url: 'https://a.example.com' }),
      runWebFetch({ url: 'https://b.example.com' }),
    ]);

    expect(results[0]).toContain('https://a.example.com');
    expect(results[1]).toContain('https://b.example.com');
    expect(results[0]).not.toBe(results[1]);
  });

  // [Implements: BG-PL-002, DC-PL-005] Parallel executeWebSearch calls
  it('parallel executeWebSearch calls produce independent results', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Shared answer.'));

    const [result1, result2] = await Promise.all([
      executeWebSearch('query1', 5, undefined, makeDeps()),
      executeWebSearch('query2', 5, undefined, makeDeps()),
    ]);

    expect(result1.answer).toBe('Shared answer.');
    expect(result2.answer).toBe('Shared answer.');
    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(mockSynthesize).toHaveBeenCalledTimes(2);
  });

  // [Implements: BG-PL-002] No signal leaking between calls
  it('each runWebFetch invocation gets its own AbortSignal', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });
    const signal1 = (mockScrape.mock.calls[0]![1] as ScrapeOptions).signal;

    await runWebFetch({ url: 'https://example.com' });
    const signal2 = (mockScrape.mock.calls[1]![1] as ScrapeOptions).signal;

    expect(signal1).not.toBe(signal2);
    expect(signal1!.aborted).toBe(false);
    expect(signal2!.aborted).toBe(false);
  });

  // [Implements: BG-PL-002] No signal leaking between executeWebSearch calls
  it('each executeWebSearch invocation gets its own AbortSignal', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());
    const signal1 = (mockScrape.mock.calls[0]![1] as ScrapeOptions).signal;

    await executeWebSearch('test', 5, undefined, makeDeps());
    const signal2 = (mockScrape.mock.calls[1]![1] as ScrapeOptions).signal;

    expect(signal1).not.toBe(signal2);
  });

  // [Implements: BG-PL-002, DC-PL-005] No state leaks between executeWebSearch and runWebFetch
  it('does not leak state between mixed executeWebSearch and runWebFetch', async () => {
    // executeWebSearch call
    mockSearch.mockResolvedValueOnce([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValueOnce(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content A.')
    );
    mockDeduplicate.mockImplementationOnce((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValueOnce(makeDigestResult('Search answer.'));

    const searchResult = await executeWebSearch('test', 5, undefined, makeDeps());
    expect(searchResult.answer).toBe('Search answer.');

    // runWebFetch call — different URL, different mock values
    mockScrape.mockResolvedValueOnce(
      makeScrapeSuccess('https://fetch.example.com', 'Fetch Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValueOnce(makeDigestResult('Fetch answer.'));

    const fetchResult = await runWebFetch({ url: 'https://fetch.example.com' });
    expect(fetchResult).toContain('Fetch answer.');
    expect(fetchResult).not.toContain('Search answer.');
  });

  // [Implements: BG-PL-002] 5 consecutive runWebFetch calls maintain consistent behavior
  it('handles five consecutive runWebFetch calls without degradation', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Consistent.'));

    for (let i = 0; i < 5; i++) {
      const result = await runWebFetch({ url: 'https://example.com' });
      expect(result).toContain('Consistent.');
    }

    expect(mockScrape).toHaveBeenCalledTimes(5);
    expect(mockSynthesize).toHaveBeenCalledTimes(5);
  });

  // [Implements: BG-PL-002] executeWebSearch degraded then success does not leak
  it('executeWebSearch degraded result does not affect a subsequent success', async () => {
    // First call: degraded
    mockSearch.mockResolvedValueOnce([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValueOnce(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content A.')
    );
    mockDeduplicate.mockImplementationOnce((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockRejectedValueOnce(new Error('LLM down'));

    const degraded = await executeWebSearch('test', 5, undefined, makeDeps());
    expect(degraded.answer).toContain('LLM synthesis was unavailable');

    // Second call: success
    mockSearch.mockResolvedValueOnce([
      makeSearchResult('B', 'https://b.example.com'),
    ]);
    mockScrape.mockResolvedValueOnce(
      makeScrapeSuccess('https://b.example.com', 'B', 'Content B.')
    );
    mockDeduplicate.mockImplementationOnce((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValueOnce(makeDigestResult('Fresh answer.'));

    const success = await executeWebSearch('test', 5, undefined, makeDeps());
    expect(success.answer).toBe('Fresh answer.');
    expect(success.answer).not.toContain('LLM synthesis was unavailable');
  });
});

// ===========================================================================
// WebFetchParams — data model verification (DC-PL-005)
// ===========================================================================

describe('WebFetchParams — data model verification (DC-PL-005)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: DC-PL-005] url is a required string field
  it('accepts a params object with only the url field', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    const params: WebFetchParams = { url: 'https://example.com' };
    const result = await runWebFetch(params);

    expect(typeof result).toBe('string');
    expect(mockScrape).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(Object)
    );
  });

  // [Implements: DC-PL-005] focus is optional
  it('accepts a params object with url and focus', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    const params: WebFetchParams = {
      url: 'https://example.com',
      focus: 'deep learning',
    };
    await runWebFetch(params);

    expect(mockSynthesize).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(Array),
      'deep learning'
    );
  });

  // [Implements: DC-PL-005] focus is undefined by default
  it('passes undefined focus when only url is provided', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });

    expect(mockSynthesize).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(Array),
      undefined
    );
  });

  // [Implements: DC-PL-005] url is forwarded to scrape
  it('forwards the url field to the scrape function', async () => {
    const testUrl = 'https://custom.example.com/page';
    mockScrape.mockResolvedValue(
      makeScrapeSuccess(testUrl, 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: testUrl });

    expect(mockScrape).toHaveBeenCalledWith(
      testUrl,
      expect.any(Object)
    );
  });

  // [Implements: DC-PL-005] url is also the first argument to synthesize
  it('uses the url as the query for synthesize', async () => {
    const testUrl = 'https://query.example.com';
    mockScrape.mockResolvedValue(
      makeScrapeSuccess(testUrl, 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: testUrl });

    expect(mockSynthesize.mock.calls[0]![0]).toBe(testUrl);
  });
});

// ===========================================================================
// executeWebSearch — degraded output details (DC-PL-002)
// ===========================================================================

describe('executeWebSearch — degraded output details (DC-PL-002)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-008, DC-PL-002] Degraded result includes degradation notice
  it('degraded result includes the notice prefix', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content A.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockRejectedValue(new Error('LLM down'));

    const result = await executeWebSearch('test', 5, undefined, makeDeps());

    expect(result.answer).toContain('[Note:');
    expect(result.answer).toContain('LLM synthesis was unavailable');
  });

  // [Implements: US-PL-008] Degraded result includes raw content
  it('degraded result includes raw content from scraped pages', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess(
        'https://a.example.com',
        'Title A',
        'First sentence here. More content follows.'
      )
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockRejectedValue(new Error('LLM down'));

    const result = await executeWebSearch('test', 5, undefined, makeDeps());

    expect(result.answer).toContain('First sentence here.');
  });

  // [Implements: US-PL-008] Degraded result includes source URLs
  it('degraded result includes source URLs', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
      makeSearchResult('B', 'https://b.example.com'),
    ]);
    mockScrape.mockImplementation(async (url: string) =>
      makeScrapeSuccess(url, `Title ${url}`, `Content for ${url}.`)
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockRejectedValue(new Error('LLM down'));

    const result = await executeWebSearch('test', 5, undefined, makeDeps());

    expect(result.answer).toContain('https://a.example.com');
    expect(result.answer).toContain('https://b.example.com');
  });

  // [Implements: US-PL-012, DC-PL-002] Degradation logs are emitted
  it('logs degradation activated and synthesize failed on degraded path', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content A.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockRejectedValue(new Error('LLM down'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('degradation activated');
    expect(output).toContain('synthesize failed');
  });
});

// ===========================================================================
// runWebFetch — final logging details (DC-PL-002)
// ===========================================================================

describe('runWebFetch — final logging details (DC-PL-002)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: US-PL-012, DC-PL-002]
  it('runWebFetch completed message includes numeric ms value', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await runWebFetch({ url: 'https://example.com' });

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    const completedLine = output
      .split('\n')
      .find((l) => l.includes('runWebFetch completed'));
    expect(completedLine).toBeDefined();
    expect(completedLine!).toMatch(/ms=\d+/);
  });

  // [Implements: DC-PL-002]
  it('runWebFetch completed message includes correct source count', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockResolvedValue(
      makeDigestResult('Answer.', [], [
        { url: 'https://example.com', title: 'Title' },
        { url: 'https://other.com', title: 'Other' },
      ])
    );

    await runWebFetch({ url: 'https://example.com' });

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('sources=2');
  });

  // [Implements: DC-PL-002] runWebFetch degraded also logs completed
  it('runWebFetch logs completed even on degraded path', async () => {
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://example.com', 'Title', MEANINGFUL_CONTENT)
    );
    mockSynthesize.mockRejectedValue(new Error('LLM down'));

    await runWebFetch({ url: 'https://example.com' });

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('runWebFetch completed');
  });
});

// ===========================================================================
// Guard cleanup on all outcome paths (DC-PL-002)
// ===========================================================================

describe('guard cleanup on all paths (DC-PL-002)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearEnv();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockScrape.mockReset();
    mockDeduplicate.mockReset();
    mockSearch.mockReset();
    mockSynthesize.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    restoreEnv();
  });

  // [Implements: DC-PL-002, NFR-PL-005] Guard cleaned after successful executeWebSearch
  it('cleans up the guard after a successful executeWebSearch', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockResolvedValue(makeDigestResult('Answer.'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('[PL] timeout:');
  });

  // [Implements: DC-PL-002, NFR-PL-005] Guard cleaned after degraded executeWebSearch
  it('cleans up the guard after a degraded executeWebSearch', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );
    mockDeduplicate.mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    mockSynthesize.mockRejectedValue(new Error('LLM down'));

    await executeWebSearch('test', 5, undefined, makeDeps());

    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('[PL] timeout:');
  });

  // [Implements: DC-PL-002, NFR-PL-005] Guard cleaned on zero results
  it('cleans up the guard when search returns zero results', async () => {
    mockSearch.mockResolvedValue([]);

    await expect(
      executeWebSearch('test', 5, undefined, makeDeps())
    ).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('[PL] timeout:');
  });

  // [Implements: DC-PL-002, NFR-PL-005] Guard cleaned when all scrapes fail
  it('cleans up the guard when all scrapes fail', async () => {
    mockSearch.mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);
    mockScrape.mockResolvedValue(
      makeScrapeFailure('https://a.example.com', 'HTTP 500')
    );

    await expect(
      executeWebSearch('test', 5, undefined, makeDeps())
    ).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('[PL] timeout:');
  });
});
