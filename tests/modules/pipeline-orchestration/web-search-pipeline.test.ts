/**
 * Integration tests for the web_search pipeline flow.
 *
 * Verifies the full Search → Scrape → Deduplicate → Synthesize flow using
 * mocked SR, SC, DD, SY module functions injected via PipelineDeps.
 * Tests cover: happy path, per-URL failure isolation, all-scrape-failed
 * error, search-stage failure, dedup-filters-all fallback, synthesis-failure
 * graceful degradation, and correct data handoff between stages.
 *
 * [Spec: US-PL-001, US-PL-006, US-PL-008, US-PL-010, US-PL-011,
 *        US-PL-014, US-PL-015,
 *        NFR-PL-004, NFR-PL-007, NFR-PL-008,
 *        DC-PL-003, DC-PL-004]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  PipelineError,
  PipelineTimeoutError,
} from '../../../src/modules/pipeline-orchestration/orchestrator.js';
import type {
  PipelineDeps,
  PipelineConfig,
  SearchResultItem,
  FailedUrl,
} from '../../../src/modules/pipeline-orchestration/orchestrator.js';
import { executeWebSearchPipeline } from '../../../src/modules/pipeline-orchestration/web-search-pipeline.js';

import type { ContentItem } from '../../../src/shared/types/content.js';
import type { DeduplicatedItem } from '../../../src/shared/types/deduplicate.js';
import type { DigestResult } from '../../../src/shared/types/digest.js';
import type { ScrapeResult } from '../../../src/shared/types/scrape.js';
import type { ScrapeOptions } from '../../../src/modules/scrape-extract/types.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Standard test config with large timeout to avoid spurious aborts. */
function makeTestConfig(
  overrides?: Partial<PipelineConfig>
): PipelineConfig {
  return {
    maxConcurrency: 3,
    scrapeTimeoutMs: 15_000,
    maxContentChars: 8_000,
    pipelineTimeoutMs: 30_000,
    ...overrides,
  };
}

/** Build a successful ScrapeResult. */
function makeScrapeSuccess(
  url: string,
  title: string,
  content: string
): ScrapeResult {
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

/** Build a failed ScrapeResult. */
function makeScrapeFailure(url: string, error: string): ScrapeResult {
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

/** Build a SearchResultItem. */
function makeSearchResult(
  title: string,
  url: string,
  snippet: string = 'A snippet.',
  score: number = 0.9
): SearchResultItem {
  return { title, url, snippet, score };
}

/** Build a DeduplicatedItem from a ContentItem-like object. */
function toDeduplicatedItem(item: ContentItem): DeduplicatedItem {
  return {
    ...item,
    normalizedUrl: item.url,
    mergedSources: [],
    fingerprintCount: 10,
  };
}

/** Build a standard DigestResult. */
function makeDigestResult(
  answer: string = 'The answer is 42.',
  keyPoints: string[] = ['Point one.', 'Point two.'],
  sources: Array<{ url: string; title: string }> = []
): DigestResult {
  return { answer, keyPoints, sources };
}

/** The degradation notice prepended when synthesis is unavailable. */
const DEGRADATION_NOTICE =
  '[Note: LLM synthesis was unavailable. The content below is raw concatenated excerpts from scraped pages.]';

// ---------------------------------------------------------------------------
// Happy Path
// ---------------------------------------------------------------------------

describe('web_search pipeline — happy path', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-001] Full sequential flow returns the synthesize digest
  it('returns the structured digest produced by synthesize', async () => {
    const searchResults: SearchResultItem[] = [
      makeSearchResult('Article A', 'https://a.example.com'),
      makeSearchResult('Article B', 'https://b.example.com'),
    ];

    const scrapeResults = new Map<string, ScrapeResult>([
      ['https://a.example.com', makeScrapeSuccess('https://a.example.com', 'Article A', 'Content of article A.')],
      ['https://b.example.com', makeScrapeSuccess('https://b.example.com', 'Article B', 'Content of article B.')],
    ]);

    const expectedDigest = makeDigestResult(
      'Synthesized answer.',
      ['Key point 1.', 'Key point 2.'],
      [
        { url: 'https://a.example.com', title: 'Article A' },
        { url: 'https://b.example.com', title: 'Article B' },
      ]
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue(searchResults),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        return scrapeResults.get(url) ?? makeScrapeFailure(url, 'not found');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(expectedDigest),
    };

    const result = await executeWebSearchPipeline(
      'test query',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(result).toEqual(expectedDigest);
    expect(result.answer).toBe('Synthesized answer.');
    expect(result.keyPoints).toEqual(['Key point 1.', 'Key point 2.']);
    expect(result.sources).toHaveLength(2);
  });

  // [Implements: US-PL-001, DC-PL-004] Sequential stage ordering
  it('calls search → scrape → deduplicate → synthesize in order', async () => {
    const callOrder: string[] = [];

    const deps: PipelineDeps = {
      search: vi.fn().mockImplementation(async () => {
        callOrder.push('search');
        return [
          makeSearchResult('A', 'https://a.example.com'),
        ];
      }),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        callOrder.push(`scrape:${url}`);
        return makeScrapeSuccess(url, 'A', 'Content A.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) => {
        callOrder.push('deduplicate');
        return items.map(toDeduplicatedItem);
      }),
      synthesize: vi.fn().mockImplementation(async () => {
        callOrder.push('synthesize');
        return makeDigestResult('Answer.');
      }),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(callOrder[0]).toBe('search');
    expect(callOrder.some((c) => c.startsWith('scrape:'))).toBe(true);
    const scrapeIdx = callOrder.findIndex((c) => c.startsWith('scrape:'));
    const dedupIdx = callOrder.indexOf('deduplicate');
    const synIdx = callOrder.indexOf('synthesize');
    expect(dedupIdx).toBeGreaterThan(scrapeIdx);
    expect(synIdx).toBeGreaterThan(dedupIdx);
  });

  // [Implements: US-PL-001] search is called with query and maxResults
  it('calls search with the query and maxResults arguments', async () => {
    const searchFn = vi.fn().mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);

    const deps: PipelineDeps = {
      search: searchFn,
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('climate change', 10, undefined, deps, makeTestConfig());

    expect(searchFn).toHaveBeenCalledWith('climate change', 10);
  });

  // [Implements: US-PL-001] synthesize receives query, content items, and focus
  it('passes query, content items, and focus to synthesize', async () => {
    const synthesizeFn = vi.fn().mockResolvedValue(makeDigestResult('Answer.'));

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com', 'Snip.', 0.9),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'Title A', 'Content A.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: synthesizeFn,
    };

    await executeWebSearchPipeline(
      'quantum computing',
      5,
      'focus on applications',
      deps,
      makeTestConfig()
    );

    expect(synthesizeFn).toHaveBeenCalledTimes(1);
    const [query, contents, focus] = synthesizeFn.mock.calls[0]!;
    expect(query).toBe('quantum computing');
    expect(focus).toBe('focus on applications');
    expect(contents).toHaveLength(1);
    expect(contents[0].url).toBe('https://a.example.com');
    expect(contents[0].title).toBe('Title A');
    expect(contents[0].content).toBe('Content A.');
  });

  // [Implements: US-PL-001] pipeline completes successfully with a single result
  it('completes successfully with a single search result', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('Solo', 'https://solo.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://solo.example.com', 'Solo', 'Solo content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(
        makeDigestResult('Single answer.', ['One point.'])
      ),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(result.answer).toBe('Single answer.');
    expect(result.keyPoints).toEqual(['One point.']);
  });
});

// ---------------------------------------------------------------------------
// Data Handoff Between Stages
// ---------------------------------------------------------------------------

describe('web_search pipeline — data handoff between stages', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-014] scrape is called for each search result URL
  it('scrapes every URL returned by search', async () => {
    const scrapeFn = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(makeScrapeSuccess(url, 'Title', 'Content'))
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
        makeSearchResult('C', 'https://c.example.com'),
      ]),
      scrape: scrapeFn,
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(scrapeFn).toHaveBeenCalledTimes(3);
    const scrapedUrls = scrapeFn.mock.calls.map((c) => c[0]);
    expect(scrapedUrls).toContain('https://a.example.com');
    expect(scrapedUrls).toContain('https://b.example.com');
    expect(scrapedUrls).toContain('https://c.example.com');
  });

  // [Implements: US-PL-014] ContentItem has title from scrape or search fallback
  it('passes scraped content and title in ContentItem to deduplicate', async () => {
    const deduplicateFn = vi.fn().mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('Search Title', 'https://a.example.com', 'Snippet', 0.8),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess(
          'https://a.example.com',
          'Scraped Title',
          'Scraped content here.'
        )
      ),
      deduplicate: deduplicateFn,
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(deduplicateFn).toHaveBeenCalledTimes(1);
    const itemsPassed = deduplicateFn.mock.calls[0]![0] as ContentItem[];
    expect(itemsPassed).toHaveLength(1);
    // Title comes from scrape result
    expect(itemsPassed[0].title).toBe('Scraped Title');
    expect(itemsPassed[0].url).toBe('https://a.example.com');
    expect(itemsPassed[0].snippet).toBe('Snippet');
    expect(itemsPassed[0].score).toBe(0.8);
    expect(itemsPassed[0].content).toBe('Scraped content here.');
  });

  // [Implements: US-PL-014] dedup output is converted to ContentItem for synthesize
  it('passes deduped items content to synthesize as ContentItem[]', async () => {
    const synthesizeFn = vi.fn().mockResolvedValue(makeDigestResult('Answer.'));

    const dedupedItems: DeduplicatedItem[] = [
      {
        title: 'Dedup Title',
        url: 'https://dedup.example.com',
        snippet: 'Dedup snippet',
        score: 0.95,
        content: 'Dedup content.',
        normalizedUrl: 'https://dedup.example.com',
        mergedSources: ['https://orig1.example.com'],
        fingerprintCount: 5,
      },
    ];

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content A.')
      ),
      deduplicate: vi.fn().mockReturnValue(dedupedItems),
      synthesize: synthesizeFn,
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const args = synthesizeFn.mock.calls[0]!;
    const contentItems = args[1] as ContentItem[];
    expect(contentItems).toHaveLength(1);
    expect(contentItems[0].title).toBe('Dedup Title');
    expect(contentItems[0].url).toBe('https://dedup.example.com');
    expect(contentItems[0].content).toBe('Dedup content.');
  });

  // [Implements: US-PL-014] scrape receives ScrapeOptions with config values
  it('passes scrape options with timeout and maxContentChars from config', async () => {
    const scrapeFn = vi.fn().mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: scrapeFn,
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    const config = makeTestConfig({
      scrapeTimeoutMs: 5000,
      maxContentChars: 3000,
    });

    await executeWebSearchPipeline('q', 5, undefined, deps, config);

    const optionsArg = scrapeFn.mock.calls[0]![1] as ScrapeOptions;
    expect(optionsArg.timeoutMs).toBe(5000);
    expect(optionsArg.maxContentChars).toBe(3000);
    expect(optionsArg.signal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Per-URL Scrape Failure Isolation
// ---------------------------------------------------------------------------

describe('web_search pipeline — per-URL scrape failure isolation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-006] Single URL scrape failure is isolated
  it('excludes failed URLs and proceeds with successful ones', async () => {
    const scrapeResults = new Map<string, ScrapeResult>([
      ['https://a.example.com', makeScrapeSuccess('https://a.example.com', 'A', 'Content A.')],
      ['https://b.example.com', makeScrapeFailure('https://b.example.com', 'HTTP 404: Not Found')],
      ['https://c.example.com', makeScrapeSuccess('https://c.example.com', 'C', 'Content C.')],
    ]);

    const deduplicateFn = vi.fn().mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
        makeSearchResult('C', 'https://c.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        return scrapeResults.get(url)!;
      }),
      deduplicate: deduplicateFn,
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Only 2 items should reach dedup (B was excluded)
    const itemsPassed = deduplicateFn.mock.calls[0]![0] as ContentItem[];
    expect(itemsPassed).toHaveLength(2);
    const urls = itemsPassed.map((i) => i.url);
    expect(urls).toContain('https://a.example.com');
    expect(urls).toContain('https://c.example.com');
    expect(urls).not.toContain('https://b.example.com');

    // Pipeline still returns a valid result
    expect(result.answer).toBe('Answer.');
  });

  // [Implements: US-PL-006, US-PL-012] Failed URL is logged to stderr
  it('logs the failed URL and error reason to stderr', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          return makeScrapeFailure(url, 'HTTP 500: Internal Server Error');
        }
        return makeScrapeSuccess(url, 'A', 'Content A.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('scrape-failed')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://b.example.com')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 500')
    );
  });

  // [Implements: US-PL-006] HTTP error category is classified correctly
  it('classifies HTTP errors with the http_error category', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          return makeScrapeFailure(url, 'HTTP 404: Not Found');
        }
        return makeScrapeSuccess(url, 'A', 'Content A.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('category=http_error')
    );
  });

  // [Implements: US-PL-006] Timeout error category is classified correctly
  it('classifies timeout errors with the timeout category', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          return makeScrapeFailure(url, 'Fetch timed out after 15000ms');
        }
        return makeScrapeSuccess(url, 'A', 'Content A.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('category=timeout')
    );
  });

  // [Implements: US-PL-006] Network error category is classified correctly
  it('classifies network errors with the network category', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          return makeScrapeFailure(url, 'ECONNREFUSED: connection refused');
        }
        return makeScrapeSuccess(url, 'A', 'Content A.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('category=network')
    );
  });

  // [Implements: US-PL-006, NFR-PL-004] Uncaught scrape exception is caught
  it('catches uncaught scrape exceptions and treats the URL as failed', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          throw new TypeError('Unexpected internal error');
        }
        return makeScrapeSuccess(url, 'A', 'Content A.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Pipeline should not throw — URL B is isolated
    expect(result.answer).toBe('Answer.');

    // Only URL A should reach dedup
    const itemsPassed = (deps.deduplicate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContentItem[];
    expect(itemsPassed).toHaveLength(1);
    expect(itemsPassed[0].url).toBe('https://a.example.com');

    // The uncaught exception is logged to stderr
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('uncaught scrape exception')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected internal error')
    );
  });

  // [Implements: US-PL-006] Only successful URLs reach deduplicate
  it('proceeds to deduplicate with only successfully scraped results', async () => {
    const scrapeResults = new Map<string, ScrapeResult>([
      ['https://ok1.example.com', makeScrapeSuccess('https://ok1.example.com', 'OK1', 'Content 1.')],
      ['https://fail1.example.com', makeScrapeFailure('https://fail1.example.com', 'HTTP 500')],
      ['https://ok2.example.com', makeScrapeSuccess('https://ok2.example.com', 'OK2', 'Content 2.')],
      ['https://fail2.example.com', makeScrapeFailure('https://fail2.example.com', 'timeout')],
    ]);

    const deduplicateFn = vi.fn().mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('OK1', 'https://ok1.example.com'),
        makeSearchResult('FAIL1', 'https://fail1.example.com'),
        makeSearchResult('OK2', 'https://ok2.example.com'),
        makeSearchResult('FAIL2', 'https://fail2.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => scrapeResults.get(url)!),
      deduplicate: deduplicateFn,
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const itemsPassed = deduplicateFn.mock.calls[0]![0] as ContentItem[];
    expect(itemsPassed).toHaveLength(2);
    expect(itemsPassed.every((i) => i.url.startsWith('https://ok'))).toBe(true);
  });

  // [Implements: US-PL-006] Failed scrape that throws non-Error value
  it('handles non-Error thrown values from scrape', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          throw 'string error'; // eslint-disable-line no-throw-literal
        }
        return makeScrapeSuccess(url, 'A', 'Content A.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(result.answer).toBe('Answer.');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('string error')
    );
  });
});

// ---------------------------------------------------------------------------
// All Scrapes Failed
// ---------------------------------------------------------------------------

describe('web_search pipeline — all scrapes failed', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-011] All URLs fail → throws PipelineError
  it('throws PipelineError when all candidate URLs fail to scrape', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeFailure(url, 'HTTP 404: Not Found')
      ),
      deduplicate: vi.fn(),
      synthesize: vi.fn(),
    };

    await expect(
      executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig())
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-011] Error message lists failed URLs
  it('includes failed URLs and their reasons in the error message', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeFailure(url, 'HTTP 500: Server Error')
      ),
      deduplicate: vi.fn(),
      synthesize: vi.fn(),
    };

    try {
      await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());
      expect.fail('Should have thrown PipelineError');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      const pipelineError = error as PipelineError;
      expect(pipelineError.message).toContain('failed to scrape');
      expect(pipelineError.message).toContain('https://a.example.com');
      expect(pipelineError.message).toContain('https://b.example.com');
      expect(pipelineError.failedUrls).toHaveLength(2);
      expect(pipelineError.failedUrls[0].url).toBe('https://a.example.com');
      expect(pipelineError.failedUrls[1].url).toBe('https://b.example.com');
    }
  });

  // [Implements: US-PL-011] Deduplicate and synthesize are NOT called
  it('skips deduplicate and synthesize stages', async () => {
    const deduplicateFn = vi.fn();
    const synthesizeFn = vi.fn();

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeFailure('https://a.example.com', 'timeout')
      ),
      deduplicate: deduplicateFn,
      synthesize: synthesizeFn,
    };

    await expect(
      executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig())
    ).rejects.toThrow();

    expect(deduplicateFn).not.toHaveBeenCalled();
    expect(synthesizeFn).not.toHaveBeenCalled();
  });

  // [Implements: US-PL-011] All scrapes fail via exception
  it('throws PipelineError when all scrapes throw exceptions', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockRejectedValue(new Error('catastrophic failure')),
      deduplicate: vi.fn(),
      synthesize: vi.fn(),
    };

    await expect(
      executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig())
    ).rejects.toThrow(PipelineError);
  });
});

// ---------------------------------------------------------------------------
// Search Stage Failure
// ---------------------------------------------------------------------------

describe('web_search pipeline — search stage failure', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-010] SR.search throws → PipelineError
  it('throws PipelineError when search throws', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockRejectedValue(new Error('SearXNG unreachable')),
      scrape: vi.fn(),
      deduplicate: vi.fn(),
      synthesize: vi.fn(),
    };

    await expect(
      executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig())
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-010] Error message includes reason, URL, and suggestion
  it('includes reason, SearXNG URL, and SEARXNG_URL suggestion in the error', async () => {
    process.env['SEARXNG_URL'] = 'http://localhost:8080';
    try {
      const deps: PipelineDeps = {
        search: vi.fn().mockRejectedValue(new Error('Connection refused')),
        scrape: vi.fn(),
        deduplicate: vi.fn(),
        synthesize: vi.fn(),
      };

      try {
        await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PipelineError);
        const msg = (error as PipelineError).message;
        expect(msg).toContain('Search failed');
        expect(msg).toContain('Connection refused');
        expect(msg).toContain('localhost:8080');
        expect(msg).toContain('SEARXNG_URL');
        expect(msg).toContain('self-hosted');
      }
    } finally {
      delete process.env['SEARXNG_URL'];
    }
  });

  // [Implements: US-PL-010] Zero results → PipelineError
  it('throws PipelineError when search returns zero results', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([]),
      scrape: vi.fn(),
      deduplicate: vi.fn(),
      synthesize: vi.fn(),
    };

    await expect(
      executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig())
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-010] Zero results error includes SearXNG suggestion
  it('zero-results error includes SEARXNG_URL suggestion', async () => {
    process.env['SEARXNG_URL'] = 'http://my-searxng:8888';
    try {
      const deps: PipelineDeps = {
        search: vi.fn().mockResolvedValue([]),
        scrape: vi.fn(),
        deduplicate: vi.fn(),
        synthesize: vi.fn(),
      };

      try {
        await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());
        expect.fail('Should have thrown');
      } catch (error) {
        const msg = (error as PipelineError).message;
        expect(msg).toContain('zero results');
        expect(msg).toContain('my-searxng:8888');
        expect(msg).toContain('SEARXNG_URL');
      }
    } finally {
      delete process.env['SEARXNG_URL'];
    }
  });

  // [Implements: US-PL-010] All results with invalid/empty URLs → failure
  it('throws PipelineError when all results have invalid or empty URLs', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', ''),
        makeSearchResult('B', '   '),
      ]),
      scrape: vi.fn(),
      deduplicate: vi.fn(),
      synthesize: vi.fn(),
    };

    await expect(
      executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig())
    ).rejects.toThrow(PipelineError);
  });

  // [Implements: US-PL-010] All-invalid-URLs error message
  it('includes "No usable search results" in the all-invalid-URLs error', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', ''),
        makeSearchResult('B', ''),
      ]),
      scrape: vi.fn(),
      deduplicate: vi.fn(),
      synthesize: vi.fn(),
    };

    try {
      await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      expect((error as PipelineError).message).toContain(
        'No usable search results'
      );
    }
  });

  // [Implements: US-PL-010] Search failure aborts before scrape stage
  it('does NOT call scrape, deduplicate, or synthesize on search failure', async () => {
    const scrapeFn = vi.fn();
    const deduplicateFn = vi.fn();
    const synthesizeFn = vi.fn();

    const deps: PipelineDeps = {
      search: vi.fn().mockRejectedValue(new Error('timeout')),
      scrape: scrapeFn,
      deduplicate: deduplicateFn,
      synthesize: synthesizeFn,
    };

    await expect(
      executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig())
    ).rejects.toThrow();

    expect(scrapeFn).not.toHaveBeenCalled();
    expect(deduplicateFn).not.toHaveBeenCalled();
    expect(synthesizeFn).not.toHaveBeenCalled();
  });

  // [Implements: US-PL-010] Results with some valid and some empty URLs proceed
  it('filters out results with empty URLs and proceeds with valid ones', async () => {
    const scrapeFn = vi.fn().mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', ''),
      ]),
      scrape: scrapeFn,
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Only the valid URL was scraped
    expect(scrapeFn).toHaveBeenCalledTimes(1);
    expect(scrapeFn).toHaveBeenCalledWith('https://a.example.com', expect.any(Object));
    expect(result.answer).toBe('Answer.');
  });
});

// ---------------------------------------------------------------------------
// Dedup Filters All
// ---------------------------------------------------------------------------

describe('web_search pipeline — dedup filters all results', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-011] Dedup returns empty → falls back to pre-dedup items
  it('falls back to pre-dedup items when deduplicate removes all results', async () => {
    const synthesizeFn = vi.fn().mockResolvedValue(makeDigestResult('Answer.'));

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, url.split('//')[1]!, 'Content.')
      ),
      deduplicate: vi.fn().mockReturnValue([]),
      synthesize: synthesizeFn,
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Synthesize is still called with the pre-dedup items
    expect(synthesizeFn).toHaveBeenCalledTimes(1);
    const contents = synthesizeFn.mock.calls[0]![1] as ContentItem[];
    expect(contents).toHaveLength(2);

    expect(result.answer).toBe('Answer.');
  });

  // [Implements: US-PL-011] Logs dedup-removed-all message
  it('logs a message when deduplication removes all results', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockReturnValue([]),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('deduplication removed all')
    );
  });

  // [Implements: US-PL-011] Dedup reduces items but some survive → continues normally
  it('proceeds normally when dedup reduces but does not eliminate all items', async () => {
    const synthesizeFn = vi.fn().mockResolvedValue(makeDigestResult('Reduced answer.'));

    // 3 items in, 1 out (2 removed as near-duplicates)
    const dedupedOutput: DeduplicatedItem[] = [
      {
        title: 'Unique',
        url: 'https://unique.example.com',
        snippet: 'Snippet',
        score: 0.9,
        content: 'Unique content.',
        normalizedUrl: 'https://unique.example.com',
        mergedSources: ['https://dup1.example.com', 'https://dup2.example.com'],
        fingerprintCount: 15,
      },
    ];

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('Unique', 'https://unique.example.com'),
        makeSearchResult('Dup1', 'https://dup1.example.com'),
        makeSearchResult('Dup2', 'https://dup2.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, 'Title', 'Content.')
      ),
      deduplicate: vi.fn().mockReturnValue(dedupedOutput),
      synthesize: synthesizeFn,
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Synthesize receives the 1 deduped item
    const contents = synthesizeFn.mock.calls[0]![1] as ContentItem[];
    expect(contents).toHaveLength(1);
    expect(contents[0].url).toBe('https://unique.example.com');
    expect(result.answer).toBe('Reduced answer.');
  });
});

// ---------------------------------------------------------------------------
// Synthesis Failure — Graceful Degradation
// ---------------------------------------------------------------------------

describe('web_search pipeline — synthesis failure graceful degradation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-008, NFR-PL-008] Synthesis throws → degraded result
  it('constructs a fallback response when synthesize throws', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com', 'Snippet A', 0.9),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'Title A', 'Content of article A.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Should return a DigestResult, not throw
    expect(result).toBeDefined();
    expect(result.answer).toContain(DEGRADATION_NOTICE);
  });

  // [Implements: US-PL-008] Fallback includes the degradation notice
  it('prepends the LLM-unavailable notice to the fallback answer', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com', 'Snippet', 0.9),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'Title A', 'Some content here.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('API timeout')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(result.answer).toContain('LLM synthesis was unavailable');
    expect(result.answer).toContain('raw concatenated excerpts');
  });

  // [Implements: US-PL-008] Fallback includes titles, URLs, and content
  it('includes titles, URLs, and truncated content in the fallback', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com', 'Snippet', 0.95),
        makeSearchResult('B', 'https://b.example.com', 'Snippet', 0.8),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, `Title for ${url}`, `Content for ${url}`)
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('Auth error')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(result.answer).toContain('https://a.example.com');
    expect(result.answer).toContain('https://b.example.com');
    expect(result.answer).toContain('Content for https://a.example.com');
    expect(result.answer).toContain('Content for https://b.example.com');
  });

  // [Implements: US-PL-008] Fallback includes Sources section with all URLs
  it('includes all contributing URLs in the sources', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
        makeSearchResult('C', 'https://c.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, `Title ${url}`, 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('500 error')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(result.sources).toHaveLength(3);
    const sourceUrls = result.sources.map((s) => s.url);
    expect(sourceUrls).toContain('https://a.example.com');
    expect(sourceUrls).toContain('https://b.example.com');
    expect(sourceUrls).toContain('https://c.example.com');
  });

  // [Implements: US-PL-008] Synthesis returns empty answer → degradation
  it('degrades when synthesize returns an empty answer', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'Title A', 'Content A.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue({
        answer: '',
        keyPoints: [],
        sources: [],
      }),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Empty answer triggers degradation
    expect(result.answer).toContain(DEGRADATION_NOTICE);
    expect(result.answer).toContain('Content A.');
  });

  // [Implements: US-PL-008] Synthesis returns whitespace-only answer → degradation
  it('degrades when synthesize returns a whitespace-only answer', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'Title A', 'Content A.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue({
        answer: '   \n\t  ',
        keyPoints: [],
        sources: [],
      }),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(result.answer).toContain(DEGRADATION_NOTICE);
  });

  // [Implements: US-PL-008] Logs degradation activation to stderr
  it('logs degradation activation to stderr', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('rate limited')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('degradation activated')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('synthesize failed')
    );
  });

  // [Implements: NFR-PL-007] Fallback content respects MAX_CONTENT_CHARS
  it('respects maxContentChars in the degraded response', async () => {
    const longContent = 'X'.repeat(10_000);

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'Title A', longContent)
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('fail')),
    };

    const config = makeTestConfig({ maxContentChars: 500 });

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      config
    );

    // Answer should not exceed maxContentChars by much (allowing for notice prefix)
    expect(result.answer.length).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Stage Logging
// ---------------------------------------------------------------------------

describe('web_search pipeline — stage logging', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-012, NFR-PL-006] Logs pipeline start
  it('logs pipeline start with query and parameters', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline(
      'test query',
      5,
      'special focus',
      deps,
      makeTestConfig()
    );

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PL] web_search')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('test query')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('max_results=5')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('special focus')
    );
  });

  // [Implements: US-PL-012] Logs stage completion for each stage
  it('logs stage completions for search, scrape, deduplicate, and synthesize', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, 'Title', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');

    expect(output).toContain('stage=search');
    expect(output).toContain('stage=scrape');
    expect(output).toContain('stage=deduplicate');
    expect(output).toContain('stage=synthesize');
  });

  // [Implements: US-PL-012] Logs final outcome as success
  it('logs outcome=success on a fully successful pipeline', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('outcome=success')
    );
  });

  // [Implements: US-PL-012] Logs outcome=partial when some URLs fail
  it('logs outcome=partial when some URLs fail but others succeed', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          return makeScrapeFailure(url, 'HTTP 404');
        }
        return makeScrapeSuccess(url, 'A', 'Content.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('outcome=partial')
    );
  });

  // [Implements: US-PL-012] Synthesis failure logs degradation and degrading messages
  it('logs degradation activated and synthesize failed when synthesis fails', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('fail')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('synthesize failed')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('degradation activated')
    );
  });
});

// ---------------------------------------------------------------------------
// At Least One Result Survives → Always Proceed to Synthesize
// ---------------------------------------------------------------------------

describe('web_search pipeline — always proceeds to synthesize with ≥1 result', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-011] Single surviving result proceeds to synthesize
  it('proceeds to synthesize with a single surviving deduped result', async () => {
    const synthesizeFn = vi.fn().mockResolvedValue(makeDigestResult('Single.'));

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockReturnValue([
        {
          title: 'A',
          url: 'https://a.example.com',
          snippet: 'Snip',
          score: 1.0,
          content: 'Content.',
          normalizedUrl: 'https://a.example.com',
          mergedSources: [],
          fingerprintCount: 1,
        },
      ]),
      synthesize: synthesizeFn,
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(synthesizeFn).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('Single.');
  });

  // [Implements: US-PL-011] Dedup reduces to 1 from many → still synthesizes
  it('synthesizes when dedup reduces many items to one', async () => {
    const synthesizeFn = vi.fn().mockResolvedValue(makeDigestResult('Merged.'));

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
        makeSearchResult('C', 'https://c.example.com'),
        makeSearchResult('D', 'https://d.example.com'),
        makeSearchResult('E', 'https://e.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, 'Title', 'Content.')
      ),
      deduplicate: vi.fn().mockReturnValue([
        {
          title: 'Representative',
          url: 'https://a.example.com',
          snippet: 'Snip',
          score: 0.95,
          content: 'Best content.',
          normalizedUrl: 'https://a.example.com',
          mergedSources: [
            'https://b.example.com',
            'https://c.example.com',
            'https://d.example.com',
            'https://e.example.com',
          ],
          fingerprintCount: 20,
        },
      ]),
      synthesize: synthesizeFn,
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(synthesizeFn).toHaveBeenCalledTimes(1);
    const contents = synthesizeFn.mock.calls[0]![1] as ContentItem[];
    expect(contents).toHaveLength(1);
    expect(contents[0].url).toBe('https://a.example.com');
    expect(result.answer).toBe('Merged.');
  });
});

// ---------------------------------------------------------------------------
// Concurrency — Multiple URLs
// ---------------------------------------------------------------------------

describe('web_search pipeline — concurrent scraping', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-003] Scrapes multiple URLs
  it('scrapes all URLs concurrently within the pipeline', async () => {
    const urls = Array.from(
      { length: 5 },
      (_, i) => `https://example.com/${i}`
    );

    const scrapeFn = vi.fn().mockImplementation(async (url: string) =>
      makeScrapeSuccess(url, `Title ${url}`, `Content ${url}`)
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue(
        urls.map((url, i) => makeSearchResult(`Title ${i}`, url))
      ),
      scrape: scrapeFn,
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(scrapeFn).toHaveBeenCalledTimes(5);
  });

  // [Implements: US-PL-003] Respects maxConcurrency configuration
  it('processes all URLs even with low maxConcurrency', async () => {
    const urls = Array.from(
      { length: 6 },
      (_, i) => `https://example.com/${i}`
    );

    const scrapedUrls: string[] = [];
    const scrapeFn = vi.fn().mockImplementation(async (url: string) => {
      scrapedUrls.push(url);
      // Small delay to simulate I/O
      await new Promise((resolve) => setTimeout(resolve, 10));
      return makeScrapeSuccess(url, 'Title', 'Content.');
    });

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue(
        urls.map((url) => makeSearchResult('Title', url))
      ),
      scrape: scrapeFn,
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    const config = makeTestConfig({ maxConcurrency: 2 });

    await executeWebSearchPipeline('q', 5, undefined, deps, config);

    expect(scrapeFn).toHaveBeenCalledTimes(6);
    expect(scrapedUrls.sort()).toEqual([...urls].sort());
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe('web_search pipeline — edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-006] Scrape returns success but with empty content
  it('includes URLs with empty content in the pipeline', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', '')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Even with empty content, the pipeline proceeds
    expect(result.answer).toBe('Answer.');
  });

  // [Implements: US-PL-001] maxResults of 1 works
  it('works with maxResults of 1', async () => {
    const searchFn = vi.fn().mockResolvedValue([
      makeSearchResult('A', 'https://a.example.com'),
    ]);

    const deps: PipelineDeps = {
      search: searchFn,
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('One.')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      1,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(searchFn).toHaveBeenCalledWith('q', 1);
    expect(result.answer).toBe('One.');
  });

  // [Implements: US-PL-006] Mixed failures: some ScrapeResult failure, some exception
  it('handles a mix of ScrapeResult failures and thrown exceptions', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('OK', 'https://ok.example.com'),
        makeSearchResult('FAIL_RESULT', 'https://fail-result.example.com'),
        makeSearchResult('FAIL_THROW', 'https://fail-throw.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://fail-result.example.com') {
          return makeScrapeFailure(url, 'HTTP 503: Service Unavailable');
        }
        if (url === 'https://fail-throw.example.com') {
          throw new Error('Unexpected crash');
        }
        return makeScrapeSuccess(url, 'OK', 'OK content.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Partial.')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Only the OK URL should reach dedup
    const itemsPassed = (deps.deduplicate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContentItem[];
    expect(itemsPassed).toHaveLength(1);
    expect(itemsPassed[0].url).toBe('https://ok.example.com');

    expect(result.answer).toBe('Partial.');

    // Both failures logged
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://fail-result.example.com')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://fail-throw.example.com')
    );
  });

  // [Implements: US-PL-008] Degraded result still has valid DigestResult shape
  it('degraded result has a valid DigestResult shape with answer, keyPoints, and sources', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess(
          'https://a.example.com',
          'Title A',
          'This is a sentence. More content follows.'
        )
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('fail')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(typeof result.answer).toBe('string');
    expect(result.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(result.keyPoints)).toBe(true);
    expect(Array.isArray(result.sources)).toBe(true);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0].url).toBe('https://a.example.com');
  });

  // [Implements: US-PL-014] Title fallback: uses search title when scrape title is empty
  it('uses search result title when scrape returns empty title', async () => {
    const deduplicateFn = vi.fn().mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('Search Title', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', '', 'Content.')
      ),
      deduplicate: deduplicateFn,
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const itemsPassed = deduplicateFn.mock.calls[0]![0] as ContentItem[];
    // Empty scrape title falls back to search title
    expect(itemsPassed[0].title).toBe('Search Title');
  });
});

// ---------------------------------------------------------------------------
// Error Classification Completeness
// ---------------------------------------------------------------------------

describe('web_search pipeline — error classification completeness', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-006] Parse error category is classified correctly
  it('classifies parse errors with the parse_error category', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          return makeScrapeFailure(url, 'Failed to extract content: parse error in HTML');
        }
        return makeScrapeSuccess(url, 'A', 'Content A.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('category=parse_error')
    );
  });

  // [Implements: US-PL-006] Validation error category is classified correctly
  it('classifies validation errors with the validation category', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          return makeScrapeFailure(url, 'Invalid URL: URL is required');
        }
        return makeScrapeSuccess(url, 'A', 'Content A.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('category=validation')
    );
  });

  // [Implements: US-PL-006] SSRF violation is classified as validation
  it('classifies SSRF violations with the validation category', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          return makeScrapeFailure(url, 'URL resolves to a private or loopback address; blocked for security');
        }
        return makeScrapeSuccess(url, 'A', 'Content A.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('category=validation')
    );
  });

  // [Implements: US-PL-006] Unknown error falls to unknown category
  it('classifies unrecognized errors with the unknown category', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          return makeScrapeFailure(url, 'Some completely mysterious error occurred');
        }
        return makeScrapeSuccess(url, 'A', 'Content A.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('category=unknown')
    );
  });
});

// ---------------------------------------------------------------------------
// Dedup Error Handling
// ---------------------------------------------------------------------------

describe('web_search pipeline — dedup error handling', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: NFR-PL-004] DD throws → pipeline falls back to scraped items
  it('falls back to scraped items when deduplicate throws', async () => {
    const synthesizeFn = vi.fn().mockResolvedValue(makeDigestResult('Fallback answer.'));

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, `Title ${url}`, `Content ${url}`)
      ),
      deduplicate: vi.fn().mockImplementation(() => {
        throw new Error('DD internal failure');
      }),
      synthesize: synthesizeFn,
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Synthesize is still called with the scraped items (fallback)
    expect(synthesizeFn).toHaveBeenCalledTimes(1);
    const contents = synthesizeFn.mock.calls[0]![1] as ContentItem[];
    expect(contents).toHaveLength(2);

    expect(result.answer).toBe('Fallback answer.');
  });

  // [Implements: NFR-PL-004] DD error is logged to stderr
  it('logs the deduplicate error to stderr', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation(() => {
        throw new Error('DD internal failure');
      }),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('deduplicate error')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('DD internal failure')
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-Stage Failure Integration
// ---------------------------------------------------------------------------

describe('web_search pipeline — multi-stage failure integration', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-006, US-PL-011, US-PL-008] Partial scrape fail + dedup reduction + synthesis degrade
  it('handles partial scrape failure, dedup reduction, and synthesis degradation in one run', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com', 'Snip', 0.95),
        makeSearchResult('B', 'https://b.example.com', 'Snip', 0.85),
        makeSearchResult('C', 'https://c.example.com', 'Snip', 0.70),
        makeSearchResult('D', 'https://d.example.com', 'Snip', 0.50),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://c.example.com') {
          return makeScrapeFailure(url, 'HTTP 503: Service Unavailable');
        }
        return makeScrapeSuccess(url, `Title ${url}`, `Content for ${url}.`);
      }),
      // DD reduces 3 items to 1
      deduplicate: vi.fn().mockReturnValue([
        {
          title: 'Representative',
          url: 'https://a.example.com',
          snippet: 'Snip',
          score: 0.95,
          content: 'Best representative content.',
          normalizedUrl: 'https://a.example.com',
          mergedSources: [
            'https://b.example.com',
            'https://d.example.com',
          ],
          fingerprintCount: 10,
        },
      ]),
      // Synthesis fails
      synthesize: vi.fn().mockRejectedValue(new Error('LLM down')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Degraded result from the 1 surviving deduped item
    expect(result.answer).toContain(DEGRADATION_NOTICE);
    expect(result.answer).toContain('Best representative content.');
    expect(result.answer).toContain('https://a.example.com');

    // Sources from the surviving item
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe('https://a.example.com');

    // C was excluded (scrape failure), only 3 reached dedup
    const itemsPassedToDedup = (deps.deduplicate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContentItem[];
    expect(itemsPassedToDedup).toHaveLength(3);
    expect(itemsPassedToDedup.map((i) => i.url)).not.toContain('https://c.example.com');
  });

  // [Implements: US-PL-006, US-PL-008] All but one scrape fail, then synthesis degrades
  it('handles one surviving scrape result with synthesis degradation', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
        makeSearchResult('C', 'https://c.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url !== 'https://a.example.com') {
          return makeScrapeFailure(url, 'HTTP 500');
        }
        return makeScrapeSuccess(url, 'Survivor', 'The only surviving content.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('API failure')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(result.answer).toContain(DEGRADATION_NOTICE);
    expect(result.answer).toContain('The only surviving content.');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe('https://a.example.com');
  });

  // [Implements: US-PL-008] Dedup filters all + synthesis failure
  it('handles dedup-filters-all fallback then synthesis failure', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, `Title ${url}`, `Content for ${url}.`)
      ),
      deduplicate: vi.fn().mockReturnValue([]),
      synthesize: vi.fn().mockRejectedValue(new Error('LLM error')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // Dedup-removes-all falls back to pre-dedup, then synthesis fails → degraded
    expect(result.answer).toContain(DEGRADATION_NOTICE);
    expect(result.answer).toContain('https://a.example.com');
    expect(result.answer).toContain('https://b.example.com');
    expect(result.sources).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Content Integrity Through Full Pipeline
// ---------------------------------------------------------------------------

describe('web_search pipeline — content integrity through full pipeline', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-014] All ContentItem fields are correctly propagated
  it('preserves all fields through search → scrape → dedup → synthesize', async () => {
    const deduplicateFn = vi.fn().mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );
    const synthesizeFn = vi.fn().mockResolvedValue(makeDigestResult('Answer.'));

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('Search Title', 'https://a.example.com', 'Search Snippet', 0.77),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'Scraped Title', 'Scraped content body.')
      ),
      deduplicate: deduplicateFn,
      synthesize: synthesizeFn,
    };

    await executeWebSearchPipeline('my query', 5, 'my focus', deps, makeTestConfig());

    // Verify fields passed to dedup
    const dedupItems = deduplicateFn.mock.calls[0]![0] as ContentItem[];
    expect(dedupItems[0].url).toBe('https://a.example.com');
    expect(dedupItems[0].snippet).toBe('Search Snippet');
    expect(dedupItems[0].score).toBe(0.77);
    expect(dedupItems[0].title).toBe('Scraped Title');
    expect(dedupItems[0].content).toBe('Scraped content body.');

    // Verify fields passed to synthesize
    const synArgs = synthesizeFn.mock.calls[0]!;
    expect(synArgs[0]).toBe('my query');
    expect(synArgs[2]).toBe('my focus');
    const synContents = synArgs[1] as ContentItem[];
    expect(synContents[0].title).toBe('Scraped Title');
    expect(synContents[0].url).toBe('https://a.example.com');
    expect(synContents[0].snippet).toBe('Search Snippet');
    expect(synContents[0].score).toBe(0.77);
    expect(synContents[0].content).toBe('Scraped content body.');
  });

  // [Implements: US-PL-014] Multiple items preserve their distinct identities
  it('preserves distinct fields for multiple items through the pipeline', async () => {
    const deduplicateFn = vi.fn().mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('Alpha', 'https://alpha.example.com', 'Alpha snippet', 0.9),
        makeSearchResult('Beta', 'https://beta.example.com', 'Beta snippet', 0.7),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        const titles: Record<string, string> = {
          'https://alpha.example.com': 'Alpha Page',
          'https://beta.example.com': 'Beta Page',
        };
        const contents: Record<string, string> = {
          'https://alpha.example.com': 'Alpha content body.',
          'https://beta.example.com': 'Beta content body.',
        };
        return makeScrapeSuccess(url, titles[url]!, contents[url]!);
      }),
      deduplicate: deduplicateFn,
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const items = deduplicateFn.mock.calls[0]![0] as ContentItem[];
    expect(items).toHaveLength(2);

    const alpha = items.find((i) => i.url === 'https://alpha.example.com')!;
    const beta = items.find((i) => i.url === 'https://beta.example.com')!;

    expect(alpha.title).toBe('Alpha Page');
    expect(alpha.content).toBe('Alpha content body.');
    expect(alpha.snippet).toBe('Alpha snippet');
    expect(alpha.score).toBe(0.9);

    expect(beta.title).toBe('Beta Page');
    expect(beta.content).toBe('Beta content body.');
    expect(beta.snippet).toBe('Beta snippet');
    expect(beta.score).toBe(0.7);
  });

  // [Implements: US-PL-014] Score from search is preserved in ContentItem
  it('preserves the search relevance score in ContentItem', async () => {
    const deduplicateFn = vi.fn().mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('Low', 'https://low.example.com', 'Snip', 0.1),
        makeSearchResult('Mid', 'https://mid.example.com', 'Snip', 0.5),
        makeSearchResult('High', 'https://high.example.com', 'Snip', 1.0),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://placeholder.example.com', 'T', 'C.')
      ),
      deduplicate: deduplicateFn,
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const items = deduplicateFn.mock.calls[0]![0] as ContentItem[];
    const scores = items.map((i) => i.score);
    expect(scores).toContain(0.1);
    expect(scores).toContain(0.5);
    expect(scores).toContain(1.0);
  });
});

// ---------------------------------------------------------------------------
// Stderr Message Format Verification
// ---------------------------------------------------------------------------

describe('web_search pipeline — stderr message format verification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-012, NFR-PL-006] Pipeline start message format
  it('start message contains [PL] prefix and web_search tag with query and max_results', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('my query', 7, 'my focus', deps, makeTestConfig());

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const startCall = calls.find(
      (c) => c.includes('[PL]') && c.includes('web_search') && c.includes('query=')
    );
    expect(startCall).toBeDefined();
    expect(startCall!.includes('[PL]')).toBe(true);
    expect(startCall!).toContain('max_results=7');
    expect(startCall!).toContain('my query');
    expect(startCall!.endsWith('\n')).toBe(true);
  });

  // [Implements: US-PL-012] Stage complete messages contain all required fields
  it('stage complete messages contain stage name, in, out, and ms', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, 'Title', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');

    // Search stage should log in=2 out=2
    expect(output).toMatch(/stage=search\s+in=2\s+out=2\s+ms=\d+/);
    // Scrape stage should log in=2 out=2
    expect(output).toMatch(/stage=scrape\s+in=2\s+out=2\s+ms=\d+/);
    // Synthesize stage should log in=2 (deduped count)
    expect(output).toMatch(/stage=synthesize\s+in=2\s+out=\d+\s+ms=\d+/);
  });

  // [Implements: US-PL-012] Scrape failure message format
  it('scrape failure messages contain url, category, and error fields', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://b.example.com') {
          return makeScrapeFailure(url, 'HTTP 503');
        }
        return makeScrapeSuccess(url, 'A', 'Content.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    const failLine = output
      .split('\n')
      .find((l) => l.includes('scrape-failed'));

    expect(failLine).toBeDefined();
    expect(failLine!).toContain('url=https://b.example.com');
    expect(failLine!).toContain('category=http_error');
    expect(failLine!).toContain('error=HTTP 503');
  });

  // [Implements: US-PL-012] Outcome message contains elapsed time
  it('outcome message contains ms= with a numeric value', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    const outcomeLine = output
      .split('\n')
      .find((l) => l.includes('outcome='));

    expect(outcomeLine).toBeDefined();
    expect(outcomeLine!).toMatch(/ms=\d+/);
  });

  // [Implements: US-PL-012, NFR-PL-006] All PL messages go to stderr, not stdout
  it('does NOT write any pipeline messages to stdout', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const deps: PipelineDeps = {
        search: vi.fn().mockResolvedValue([
          makeSearchResult('A', 'https://a.example.com'),
        ]),
        scrape: vi.fn().mockResolvedValue(
          makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
        ),
        deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
          items.map(toDeduplicatedItem)
        ),
        synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
      };

      await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Abort Signal Propagation to Scrape
// ---------------------------------------------------------------------------

describe('web_search pipeline — abort signal propagation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-015] Scrape receives a defined AbortSignal
  it('passes an AbortSignal to each scrape call', async () => {
    const scrapeFn = vi.fn().mockResolvedValue(
      makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: scrapeFn,
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const optionsArg = scrapeFn.mock.calls[0]![1] as ScrapeOptions;
    expect(optionsArg.signal).toBeInstanceOf(AbortSignal);
  });

  // [Implements: US-PL-015] Multiple scrape calls receive the same signal
  it('passes a consistent signal to multiple scrape calls', async () => {
    const scrapeFn = vi.fn().mockImplementation(async (url: string) =>
      makeScrapeSuccess(url, 'Title', 'Content.')
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
        makeSearchResult('C', 'https://c.example.com'),
      ]),
      scrape: scrapeFn,
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const signals = scrapeFn.mock.calls.map(
      (c) => (c[1] as ScrapeOptions).signal
    );
    // All calls should receive the same signal instance
    expect(signals[0]).toBe(signals[1]);
    expect(signals[1]).toBe(signals[2]);
  });
});

// ---------------------------------------------------------------------------
// Degraded Result Content Details
// ---------------------------------------------------------------------------

describe('web_search pipeline — degraded result content details', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-008] Degraded result includes key points from content
  it('includes key points derived from content first sentences', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com', 'Snip', 0.9),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess(
          'https://a.example.com',
          'Title A',
          'First sentence here. Second sentence follows.'
        )
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('fail')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(result.keyPoints.length).toBeGreaterThan(0);
    expect(result.keyPoints[0]).toContain('First sentence here.');
  });

  // [Implements: US-PL-008] Degraded result sorts sources by score
  it('sorts degraded content by descending score', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('Low', 'https://low.example.com', 'Snip', 0.1),
        makeSearchResult('High', 'https://high.example.com', 'Snip', 1.0),
        makeSearchResult('Mid', 'https://mid.example.com', 'Snip', 0.5),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, `Title ${url}`, `Content for ${url}.`)
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('fail')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    // The high-score URL should appear before the low-score URL in the answer
    const highIdx = result.answer.indexOf('https://high.example.com');
    const midIdx = result.answer.indexOf('https://mid.example.com');
    const lowIdx = result.answer.indexOf('https://low.example.com');

    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  // [Implements: US-PL-008] Degraded result keyPoints are capped at 10
  it('limits key points to at most 10 items', async () => {
    const urls = Array.from(
      { length: 15 },
      (_, i) => `https://item${i}.example.com`
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue(
        urls.map((url, i) => makeSearchResult(`Title ${i}`, url, 'Snip', 0.9 - i * 0.01))
      ),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, `Title ${url}`, 'A sentence. More text.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('fail')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(result.keyPoints.length).toBeLessThanOrEqual(10);
  });

  // [Implements: US-PL-008, NFR-PL-008] Degraded result includes all source URLs
  it('includes all contributing URLs in degraded sources', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com', 'Snip', 0.9),
        makeSearchResult('B', 'https://b.example.com', 'Snip', 0.8),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, `Title for ${url}`, `Content for ${url}.`)
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('fail')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    const sourceUrls = result.sources.map((s) => s.url);
    expect(sourceUrls).toContain('https://a.example.com');
    expect(sourceUrls).toContain('https://b.example.com');

    const sourceTitles = result.sources.map((s) => s.title);
    expect(sourceTitles).toContain('Title for https://a.example.com');
    expect(sourceTitles).toContain('Title for https://b.example.com');
  });
});

// ---------------------------------------------------------------------------
// Large-Scale Flow Integration
// ---------------------------------------------------------------------------

describe('web_search pipeline — large-scale flow integration', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-001, US-PL-014, US-PL-006] 10 results with 2 failures
  it('handles 10 search results with 2 scrape failures successfully', async () => {
    const urls = Array.from(
      { length: 10 },
      (_, i) => `https://example.com/${i}`
    );
    const failingUrls = new Set(['https://example.com/3', 'https://example.com/7']);

    const scrapeFn = vi.fn().mockImplementation(async (url: string) => {
      if (failingUrls.has(url)) {
        return makeScrapeFailure(url, 'HTTP 503');
      }
      return makeScrapeSuccess(url, `Title ${url}`, `Content ${url}`);
    });

    const deduplicateFn = vi.fn().mockImplementation((items: ContentItem[]) =>
      items.map(toDeduplicatedItem)
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue(
        urls.map((url, i) => makeSearchResult(`Result ${i}`, url))
      ),
      scrape: scrapeFn,
      deduplicate: deduplicateFn,
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Large-scale answer.')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      10,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(scrapeFn).toHaveBeenCalledTimes(10);
    const dedupItems = deduplicateFn.mock.calls[0]![0] as ContentItem[];
    expect(dedupItems).toHaveLength(8);
    expect(dedupItems.every((i) => !failingUrls.has(i.url))).toBe(true);
    expect(result.answer).toBe('Large-scale answer.');
  });

  // [Implements: US-PL-014] Multiple items with distinct content reach synthesize
  it('passes all surviving items with distinct content to synthesize', async () => {
    const synthesizeFn = vi.fn().mockResolvedValue(makeDigestResult('Answer.'));

    const urls = Array.from(
      { length: 5 },
      (_, i) => `https://example.com/${i}`
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue(
        urls.map((url, i) => makeSearchResult(`Title ${i}`, url, `Snippet ${i}`, 0.9 - i * 0.1))
      ),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, `Page ${url}`, `Unique content for ${url}.`)
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: synthesizeFn,
    };

    await executeWebSearchPipeline('q', 10, undefined, deps, makeTestConfig());

    const contents = synthesizeFn.mock.calls[0]![1] as ContentItem[];
    expect(contents).toHaveLength(5);

    // Each item has distinct content
    const contentValues = contents.map((c) => c.content);
    const uniqueContent = new Set(contentValues);
    expect(uniqueContent.size).toBe(5);

    // Each item has its original score
    const scores = contents.map((c) => c.score).sort((a, b) => b - a);
    expect(scores).toEqual([0.9, 0.8, 0.7, 0.6, 0.5]);
  });

  // [Implements: US-PL-001, US-PL-006] Flow completes within reasonable time
  it('completes a 10-URL pipeline within 5 seconds', async () => {
    const urls = Array.from(
      { length: 10 },
      (_, i) => `https://example.com/${i}`
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue(
        urls.map((url) => makeSearchResult('Title', url))
      ),
      scrape: vi.fn().mockImplementation(async (url: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return makeScrapeSuccess(url, 'Title', 'Content.');
      }),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    const start = Date.now();
    await executeWebSearchPipeline('q', 10, undefined, deps, makeTestConfig());
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Search Result Filtering Before Scrape
// ---------------------------------------------------------------------------

describe('web_search pipeline — search result filtering before scrape', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-010] Whitespace-only URLs are filtered out
  it('filters out results with whitespace-only URLs', async () => {
    const scrapeFn = vi.fn().mockResolvedValue(
      makeScrapeSuccess('https://valid.example.com', 'Valid', 'Content.')
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('Valid', 'https://valid.example.com'),
        makeSearchResult('WS', '\t\n  '),
      ]),
      scrape: scrapeFn,
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    const result = await executeWebSearchPipeline(
      'q',
      5,
      undefined,
      deps,
      makeTestConfig()
    );

    expect(scrapeFn).toHaveBeenCalledTimes(1);
    expect(scrapeFn).toHaveBeenCalledWith(
      'https://valid.example.com',
      expect.any(Object)
    );
    expect(result.answer).toBe('Answer.');
  });

  // [Implements: US-PL-010] Mix of valid, empty, and whitespace-only URLs
  it('keeps only valid URLs when mixing valid, empty, and whitespace-only', async () => {
    const scrapeFn = vi.fn().mockImplementation(async (url: string) =>
      makeScrapeSuccess(url, 'Title', 'Content.')
    );

    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('Valid1', 'https://valid1.example.com'),
        makeSearchResult('Empty', ''),
        makeSearchResult('Valid2', 'https://valid2.example.com'),
        makeSearchResult('WS', '   '),
        makeSearchResult('Valid3', 'https://valid3.example.com'),
      ]),
      scrape: scrapeFn,
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    expect(scrapeFn).toHaveBeenCalledTimes(3);
    const scrapedUrls = scrapeFn.mock.calls.map((c) => c[0]);
    expect(scrapedUrls).toContain('https://valid1.example.com');
    expect(scrapedUrls).toContain('https://valid2.example.com');
    expect(scrapedUrls).toContain('https://valid3.example.com');
  });
});

// ---------------------------------------------------------------------------
// Outcome Logging Consistency
// ---------------------------------------------------------------------------

describe('web_search pipeline — outcome logging consistency', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-012] Synthesis failure still logs degradation messages
  it('logs synthesize failed and degradation activated when synthesis fails', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockRejectedValue(new Error('fail')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('synthesize failed');
    expect(output).toContain('degradation activated');
  });

  // [Implements: US-PL-012] Outcome=success when all stages pass
  it('logs exactly one outcome= line on a successful run', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
      ]),
      scrape: vi.fn().mockResolvedValue(
        makeScrapeSuccess('https://a.example.com', 'A', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    const outcomeLines = output
      .split('\n')
      .filter((l) => l.includes('outcome='));
    expect(outcomeLines.length).toBe(1);
  });

  // [Implements: US-PL-012] Outcome message includes stage counts
  it('outcome message includes stage count fields', async () => {
    const deps: PipelineDeps = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('A', 'https://a.example.com'),
        makeSearchResult('B', 'https://b.example.com'),
      ]),
      scrape: vi.fn().mockImplementation(async (url: string) =>
        makeScrapeSuccess(url, 'Title', 'Content.')
      ),
      deduplicate: vi.fn().mockImplementation((items: ContentItem[]) =>
        items.map(toDeduplicatedItem)
      ),
      synthesize: vi.fn().mockResolvedValue(makeDigestResult('Answer.')),
    };

    await executeWebSearchPipeline('q', 5, undefined, deps, makeTestConfig());

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    const outcomeLine = output
      .split('\n')
      .find((l) => l.includes('outcome='))!;

    expect(outcomeLine).toContain('search=2');
    expect(outcomeLine).toContain('scraped=2');
    expect(outcomeLine).toContain('deduplicated=2');
    expect(outcomeLine).toContain('synthesized=');
  });
});
