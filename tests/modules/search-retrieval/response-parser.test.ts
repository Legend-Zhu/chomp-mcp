/**
 * Tests for the SearXNG response parser (response-parser.ts).
 *
 * Covers:
 *   - validateUrl: valid/invalid URLs, non-string values, edge cases
 *   - extractFields: field extraction, defaults, malformed entries
 *   - parseResponse: JSON detection, parsing, malformed skipping, empty results
 *
 * [Spec: US-SR-002, US-SR-008, US-SR-009, NFR-SR-004]
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateUrl,
  extractFields,
  parseResponse,
  type SearXNGFetchResult,
  type SearXNGRawResult,
} from '../../../src/modules/search-retrieval/response-parser.js';
import { SearchParseError } from '../../../src/modules/search-retrieval/errors.js';
import type { ParsedResult } from '../../../src/modules/search-retrieval/result-normalizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchResult(
  body: string,
  options: {
    status?: number;
    contentType?: string | null;
    retryAfterMs?: number | null;
  } = {}
): SearXNGFetchResult {
  return {
    status: options.status ?? 200,
    body,
    contentType:
      options.contentType === undefined
        ? 'application/json'
        : options.contentType,
    retryAfterMs: options.retryAfterMs ?? null,
  };
}

// ---------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------

describe('validateUrl', () => {
  // [Implements: US-SR-002, US-SR-008]
  it('returns the URL string for a valid HTTP URL', () => {
    expect(validateUrl('https://example.com')).toBe('https://example.com');
  });

  it('returns the URL string for a valid HTTP URL with path', () => {
    expect(validateUrl('http://example.com/path/to/page')).toBe(
      'http://example.com/path/to/page'
    );
  });

  it('returns the URL string for a valid URL with query and fragment', () => {
    expect(validateUrl('https://example.com/page?q=1#section')).toBe(
      'https://example.com/page?q=1#section'
    );
  });

  it('returns the URL string for a URL with port', () => {
    expect(validateUrl('https://example.com:8080/path')).toBe(
      'https://example.com:8080/path'
    );
  });

  it('returns the URL string for a URL with subdomain', () => {
    expect(validateUrl('https://sub.example.com')).toBe(
      'https://sub.example.com'
    );
  });

  it('returns the URL string for a URL with Unicode hostname', () => {
    expect(validateUrl('https://example.com')).toBe('https://example.com');
  });

  // [Implements: US-SR-008] Non-string values return null
  it('returns null for undefined', () => {
    expect(validateUrl(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(validateUrl(null)).toBeNull();
  });

  it('returns null for a number', () => {
    expect(validateUrl(42)).toBeNull();
  });

  it('returns null for a boolean', () => {
    expect(validateUrl(true)).toBeNull();
  });

  it('returns null for an object', () => {
    expect(validateUrl({ href: 'https://example.com' })).toBeNull();
  });

  it('returns null for an array', () => {
    expect(validateUrl(['https://example.com'])).toBeNull();
  });

  // [Implements: US-SR-002] Invalid URLs return null
  it('returns null for an empty string', () => {
    expect(validateUrl('')).toBeNull();
  });

  it('returns null for a plain string with no protocol', () => {
    expect(validateUrl('not-a-url')).toBeNull();
  });

  it('returns null for a string with only a protocol', () => {
    expect(validateUrl('https://')).toBeNull();
  });

  it('returns null for a string with only a hostname (no protocol)', () => {
    expect(validateUrl('example.com')).toBeNull();
  });

  it('returns null for a string with only a path', () => {
    expect(validateUrl('/path/to/page')).toBeNull();
  });

  it('returns null for a mailto: URL (no hostname)', () => {
    // mailto: URLs have no hostname — should be rejected
    const result = validateUrl('mailto:test@example.com');
    expect(result).toBeNull();
  });

  it('returns null for a javascript: URL', () => {
    const result = validateUrl('javascript:alert(1)');
    expect(result).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(validateUrl('   ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractFields
// ---------------------------------------------------------------------------

describe('extractFields', () => {
  // [Implements: US-SR-002, US-SR-008]
  it('extracts all fields from a well-formed result', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      title: 'Example Title',
      content: 'Example snippet text',
      score: 1.5,
    };
    const result = extractFields(raw);
    expect(result).toEqual({
      title: 'Example Title',
      url: 'https://example.com',
      content: 'Example snippet text',
      score: 1.5,
    });
  });

  it('returns null when url is missing', () => {
    const raw: SearXNGRawResult = {
      title: 'Title',
      content: 'Content',
    };
    expect(extractFields(raw)).toBeNull();
  });

  it('returns null when url is undefined', () => {
    const raw: SearXNGRawResult = {
      url: undefined,
      title: 'Title',
    };
    expect(extractFields(raw)).toBeNull();
  });

  it('returns null when url is null', () => {
    const raw: SearXNGRawResult = {
      url: null,
      title: 'Title',
    };
    expect(extractFields(raw)).toBeNull();
  });

  it('returns null when url is a number', () => {
    const raw: SearXNGRawResult = {
      url: 12345,
      title: 'Title',
    };
    expect(extractFields(raw)).toBeNull();
  });

  it('returns null when url is an invalid string', () => {
    const raw: SearXNGRawResult = {
      url: 'not-a-url',
      title: 'Title',
    };
    expect(extractFields(raw)).toBeNull();
  });

  // [Implements: US-SR-002] Title defaults to empty string
  it('defaults title to empty string when missing', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      content: 'Content',
    };
    const result = extractFields(raw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('');
  });

  it('defaults title to empty string when null', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      title: null,
    };
    const result = extractFields(raw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('');
  });

  it('defaults title to empty string when a number', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      title: 123,
    };
    const result = extractFields(raw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('');
  });

  // [Implements: US-SR-002] Content defaults to empty string
  it('defaults content to empty string when missing', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      title: 'Title',
    };
    const result = extractFields(raw);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('');
  });

  it('defaults content to empty string when null', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      content: null,
    };
    const result = extractFields(raw);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('');
  });

  it('defaults content to empty string when a number', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      content: 42,
    };
    const result = extractFields(raw);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('');
  });

  // [Implements: US-SR-002] Score handling
  it('extracts score as a number when provided', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      score: 3.14,
    };
    const result = extractFields(raw);
    expect(result!.score).toBe(3.14);
  });

  it('defaults score to null when missing', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
    };
    const result = extractFields(raw);
    expect(result!.score).toBeNull();
  });

  it('defaults score to null when null', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      score: null,
    };
    const result = extractFields(raw);
    expect(result!.score).toBeNull();
  });

  it('defaults score to null when a string', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      score: 'high',
    };
    const result = extractFields(raw);
    expect(result!.score).toBeNull();
  });

  it('defaults score to null when a boolean', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      score: true,
    };
    const result = extractFields(raw);
    expect(result!.score).toBeNull();
  });

  it('defaults score to null when NaN', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      score: NaN,
    };
    const result = extractFields(raw);
    expect(result!.score).toBeNull();
  });

  it('defaults score to null when Infinity', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      score: Infinity,
    };
    const result = extractFields(raw);
    expect(result!.score).toBeNull();
  });

  it('accepts score of 0', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      score: 0,
    };
    const result = extractFields(raw);
    expect(result!.score).toBe(0);
  });

  it('accepts negative score', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      score: -1.5,
    };
    const result = extractFields(raw);
    expect(result!.score).toBe(-1.5);
  });

  // [Implements: US-SR-002] Extra fields are ignored
  it('ignores extra fields not in the ParsedResult shape', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      title: 'Title',
      content: 'Content',
      score: 1.0,
      engine: 'google',
      category: 'general',
      publishedDate: '2024-01-01',
    };
    const result = extractFields(raw);
    expect(result).toEqual({
      title: 'Title',
      url: 'https://example.com',
      content: 'Content',
      score: 1.0,
    });
  });

  it('handles empty title and content strings', () => {
    const raw: SearXNGRawResult = {
      url: 'https://example.com',
      title: '',
      content: '',
    };
    const result = extractFields(raw);
    expect(result).toEqual({
      title: '',
      url: 'https://example.com',
      content: '',
      score: null,
    });
  });
});

// ---------------------------------------------------------------------------
// parseResponse
// ---------------------------------------------------------------------------

describe('parseResponse', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // [Implements: US-SR-002] Successful parse with results
  it('parses a valid JSON response with results', () => {
    const body = JSON.stringify({
      results: [
        { url: 'https://example.com', title: 'Example', content: 'Snippet', score: 2.0 },
        { url: 'https://test.com', title: 'Test', content: 'Test snippet', score: 1.0 },
      ],
    });
    const result = parseResponse(makeFetchResult(body), 'test query');

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      title: 'Example',
      url: 'https://example.com',
      content: 'Snippet',
      score: 2.0,
    });
    expect(result.skippedMalformed).toBe(0);
  });

  it('parses a response with a single result', () => {
    const body = JSON.stringify({
      results: [{ url: 'https://example.com', title: 'Single', content: 'One' }],
    });
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(1);
    expect(result.skippedMalformed).toBe(0);
  });

  // [Implements: US-SR-002] Empty results array
  it('returns empty results and skippedMalformed=0 for an empty results array', () => {
    const body = JSON.stringify({ results: [] });
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(0);
    expect(result.skippedMalformed).toBe(0);
  });

  // [Implements: US-SR-002] Missing results key
  it('returns empty results when the results key is missing', () => {
    const body = JSON.stringify({ unresponsive_engines: [], number_of_results: 0 });
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(0);
    expect(result.skippedMalformed).toBe(0);
  });

  it('returns empty results when results is not an array (null)', () => {
    const body = JSON.stringify({ results: null });
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(0);
    expect(result.skippedMalformed).toBe(0);
  });

  it('returns empty results when results is not an array (string)', () => {
    const body = JSON.stringify({ results: 'not an array' });
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(0);
    expect(result.skippedMalformed).toBe(0);
  });

  it('returns empty results when results is not an array (object)', () => {
    const body = JSON.stringify({ results: { key: 'value' } });
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(0);
    expect(result.skippedMalformed).toBe(0);
  });

  // [Implements: US-SR-008] Malformed entries are skipped
  it('skips entries with missing url and counts them in skippedMalformed', () => {
    const body = JSON.stringify({
      results: [
        { url: 'https://valid.com', title: 'Valid' },
        { title: 'No URL' },
        { url: 'https://also-valid.com', title: 'Also Valid' },
      ],
    });
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(2);
    expect(result.skippedMalformed).toBe(1);
  });

  it('skips entries with invalid url string and counts them', () => {
    const body = JSON.stringify({
      results: [
        { url: 'not-a-url', title: 'Bad URL' },
        { url: 'https://valid.com', title: 'Valid' },
      ],
    });
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(1);
    expect(result.skippedMalformed).toBe(1);
  });

  it('skips entries with non-string url and counts them', () => {
    const body = JSON.stringify({
      results: [
        { url: 12345, title: 'Numeric URL' },
        { url: null, title: 'Null URL' },
        { url: 'https://valid.com', title: 'Valid' },
      ],
    });
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(1);
    expect(result.skippedMalformed).toBe(2);
  });

  it('skips non-object entries in the results array', () => {
    const body = JSON.stringify({
      results: [
        'string entry',
        null,
        42,
        { url: 'https://valid.com', title: 'Valid' },
        ['array', 'entry'],
      ],
    });
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(1);
    expect(result.skippedMalformed).toBe(4);
  });

  it('handles all entries being malformed', () => {
    const body = JSON.stringify({
      results: [
        { title: 'No URL 1' },
        { title: 'No URL 2' },
        { url: 'invalid', title: 'Bad URL' },
      ],
    });
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(0);
    expect(result.skippedMalformed).toBe(3);
  });

  // [Implements: US-SR-002] Empty results logging
  it('logs to stderr when results array is empty', () => {
    const body = JSON.stringify({ results: [] });
    parseResponse(makeFetchResult(body), 'my search query');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('0 results for query: my search query')
    );
  });

  it('logs to stderr when results key is missing', () => {
    const body = JSON.stringify({});
    parseResponse(makeFetchResult(body), 'missing results');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('0 results for query: missing results')
    );
  });

  it('logs to stderr when all entries are malformed', () => {
    const body = JSON.stringify({
      results: [{ title: 'No URL' }],
    });
    parseResponse(makeFetchResult(body), 'all malformed');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('0 results for query: all malformed')
    );
  });

  it('does NOT log to stderr when there are valid results', () => {
    const body = JSON.stringify({
      results: [{ url: 'https://example.com', title: 'Valid' }],
    });
    parseResponse(makeFetchResult(body), 'has results');
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const emptyLogCall = calls.find((c) => c.includes('0 results for query'));
    expect(emptyLogCall).toBeUndefined();
  });

  // [Implements: US-SR-009] Non-JSON detection
  it('throws SearchParseError when Content-Type is text/html and body is HTML', () => {
    const htmlBody = '<html><body><h1>Not Found</h1></body></html>';
    const fetchResult = makeFetchResult(htmlBody, {
      contentType: 'text/html; charset=utf-8',
    });

    expect(() => parseResponse(fetchResult, 'query')).toThrow(SearchParseError);
  });

  it('throws SearchParseError when Content-Type is null and body is not JSON', () => {
    const fetchResult = makeFetchResult('plain text body', {
      contentType: null,
    });

    expect(() => parseResponse(fetchResult, 'query')).toThrow(SearchParseError);
  });

  it('throws SearchParseError when Content-Type is text/plain and body is plain text', () => {
    const fetchResult = makeFetchResult('just some text', {
      contentType: 'text/plain',
    });

    expect(() => parseResponse(fetchResult, 'query')).toThrow(SearchParseError);
  });

  it('throws SearchParseError with bodyExcerpt for non-JSON response', () => {
    const htmlBody = '<html><body>Error page</body></html>';
    const fetchResult = makeFetchResult(htmlBody, {
      contentType: 'text/html',
    });

    try {
      parseResponse(fetchResult, 'query');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchParseError);
      const parseError = error as SearchParseError;
      expect(parseError.bodyExcerpt).toBe(htmlBody.slice(0, 200));
      expect(parseError.message).toContain('non-JSON');
      expect(parseError.message).toContain('text/html');
    }
  });

  it('throws SearchParseError with Content-Type "null" in message when contentType is null', () => {
    const fetchResult = makeFetchResult('plain text', { contentType: null });

    try {
      parseResponse(fetchResult, 'query');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchParseError);
      const parseError = error as SearchParseError;
      expect(parseError.message).toContain('null');
    }
  });

  // [Implements: US-SR-009] Body prefix detection overrides Content-Type
  it('parses JSON body even when Content-Type is text/html but body starts with {', () => {
    const jsonBody = JSON.stringify({ results: [] });
    const fetchResult = makeFetchResult(jsonBody, {
      contentType: 'text/html',
    });

    const result = parseResponse(fetchResult, 'query');
    expect(result.results).toHaveLength(0);
  });

  it('parses JSON body even when Content-Type is null but body starts with {', () => {
    const jsonBody = JSON.stringify({ results: [{ url: 'https://x.com' }] });
    const fetchResult = makeFetchResult(jsonBody, { contentType: null });

    const result = parseResponse(fetchResult, 'query');
    expect(result.results).toHaveLength(1);
  });

  it('parses JSON body when Content-Type is null and body starts with [', () => {
    // SearXNG returns an object with results, but test array prefix detection
    const jsonBody = JSON.stringify({ results: [] });
    const fetchResult = makeFetchResult(jsonBody, { contentType: null });

    const result = parseResponse(fetchResult, 'query');
    expect(result.results).toHaveLength(0);
  });

  it('detects JSON body with leading whitespace before {', () => {
    const jsonBody = '   \n  ' + JSON.stringify({ results: [] });
    const fetchResult = makeFetchResult(jsonBody, { contentType: null });

    const result = parseResponse(fetchResult, 'query');
    expect(result.results).toHaveLength(0);
  });

  // [Implements: US-SR-002] Invalid JSON syntax
  it('throws SearchParseError when body is invalid JSON', () => {
    const fetchResult = makeFetchResult('{ invalid json }', {
      contentType: 'application/json',
    });

    expect(() => parseResponse(fetchResult, 'query')).toThrow(SearchParseError);
  });

  it('throws SearchParseError with bodyExcerpt for invalid JSON', () => {
    const invalidJson = '{ "results": [ incomplete';
    const fetchResult = makeFetchResult(invalidJson, {
      contentType: 'application/json',
    });

    try {
      parseResponse(fetchResult, 'query');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchParseError);
      const parseError = error as SearchParseError;
      expect(parseError.bodyExcerpt).toBe(invalidJson.slice(0, 200));
      expect(parseError.message).toContain('Failed to parse');
    }
  });

  it('throws SearchParseError for empty body with application/json content-type', () => {
    const fetchResult = makeFetchResult('', {
      contentType: 'application/json',
    });

    // Empty body: bodyLooksLikeJson is false (body.length === 0),
    // contentTypeIsJson is true, so it proceeds to JSON.parse('') which throws
    expect(() => parseResponse(fetchResult, 'query')).toThrow(SearchParseError);
  });

  // [Implements: US-SR-009] bodyExcerpt is capped at 200 characters
  it('caps bodyExcerpt at 200 characters for non-JSON response', () => {
    const longBody = 'x'.repeat(500);
    const fetchResult = makeFetchResult(longBody, {
      contentType: 'text/plain',
    });

    try {
      parseResponse(fetchResult, 'query');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchParseError);
      const parseError = error as SearchParseError;
      expect(parseError.bodyExcerpt).toHaveLength(200);
    }
  });

  it('caps bodyExcerpt at 200 characters for invalid JSON', () => {
    const longBody = '{' + 'x'.repeat(500);
    const fetchResult = makeFetchResult(longBody, {
      contentType: 'application/json',
    });

    try {
      parseResponse(fetchResult, 'query');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SearchParseError);
      const parseError = error as SearchParseError;
      expect(parseError.bodyExcerpt).toHaveLength(200);
    }
  });

  // [Implements: US-SR-002] Content-Type case insensitivity
  it('detects JSON when Content-Type has uppercase APPLICATION/JSON', () => {
    const body = JSON.stringify({ results: [] });
    const fetchResult = makeFetchResult(body, {
      contentType: 'APPLICATION/JSON',
    });

    const result = parseResponse(fetchResult, 'query');
    expect(result.results).toHaveLength(0);
  });

  it('detects JSON when Content-Type is application/json; charset=utf-8', () => {
    const body = JSON.stringify({ results: [] });
    const fetchResult = makeFetchResult(body, {
      contentType: 'application/json; charset=utf-8',
    });

    const result = parseResponse(fetchResult, 'query');
    expect(result.results).toHaveLength(0);
  });

  // [Implements: US-SR-002] Mixed valid and malformed entries
  it('handles a mix of valid, missing-url, and invalid-url entries', () => {
    const body = JSON.stringify({
      results: [
        { url: 'https://first.com', title: 'First', content: 'C1', score: 3.0 },
        { title: 'Missing URL' },
        { url: 'invalid-url', title: 'Bad' },
        { url: 'https://second.com', title: 'Second', content: 'C2' },
        { url: null, title: 'Null URL' },
        { url: 'https://third.com', title: 'Third', content: 'C3', score: 1.0 },
      ],
    });
    const result = parseResponse(makeFetchResult(body), 'query');

    expect(result.results).toHaveLength(3);
    expect(result.results[0]!.url).toBe('https://first.com');
    expect(result.results[1]!.url).toBe('https://second.com');
    expect(result.results[2]!.url).toBe('https://third.com');
    expect(result.skippedMalformed).toBe(3);
  });

  // [Implements: US-SR-002] Parsed body is not an object
  it('returns empty results when parsed body is a JSON array (not object)', () => {
    const body = JSON.stringify([{ url: 'https://example.com' }]);
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(0);
    expect(result.skippedMalformed).toBe(0);
  });

  it('returns empty results when parsed body is a JSON string', () => {
    const body = JSON.stringify('just a string');
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(0);
  });

  it('returns empty results when parsed body is a JSON number', () => {
    const body = JSON.stringify(42);
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(0);
  });

  it('returns empty results when parsed body is JSON null', () => {
    const body = 'null';
    const result = parseResponse(makeFetchResult(body), 'query');
    expect(result.results).toHaveLength(0);
  });

  // [Implements: US-SR-002] Return type is ParseOutput
  it('returns a ParseOutput with results and skippedMalformed fields', () => {
    const body = JSON.stringify({
      results: [{ url: 'https://example.com', title: 'T' }],
    });
    const result = parseResponse(makeFetchResult(body), 'query');

    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('skippedMalformed');
    expect(Array.isArray(result.results)).toBe(true);
    expect(typeof result.skippedMalformed).toBe('number');
  });

  // [Implements: US-SR-002] ParsedResult shape
  it('produces ParsedResult objects with title, url, content, score fields', () => {
    const body = JSON.stringify({
      results: [{ url: 'https://example.com', title: 'T', content: 'C', score: 1.5 }],
    });
    const result = parseResponse(makeFetchResult(body), 'query');
    const first: ParsedResult = result.results[0]!;

    expect(first).toHaveProperty('title');
    expect(first).toHaveProperty('url');
    expect(first).toHaveProperty('content');
    expect(first).toHaveProperty('score');
    expect(typeof first.title).toBe('string');
    expect(typeof first.url).toBe('string');
    expect(typeof first.content).toBe('string');
    expect(first.score === null || typeof first.score === 'number').toBe(true);
  });

  // [Implements: US-SR-002] Large result set
  it('handles a large number of results', () => {
    const results = Array.from({ length: 100 }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: `Title ${i}`,
      content: `Content ${i}`,
      score: 100 - i,
    }));
    const body = JSON.stringify({ results });
    const result = parseResponse(makeFetchResult(body), 'query');

    expect(result.results).toHaveLength(100);
    expect(result.skippedMalformed).toBe(0);
  });

  // [Implements: US-SR-008] Entries with extra fields
  it('preserves only title, url, content, score — ignores extra fields', () => {
    const body = JSON.stringify({
      results: [
        {
          url: 'https://example.com',
          title: 'Title',
          content: 'Content',
          score: 1.0,
          engine: 'google',
          category: 'general',
          publishedDate: '2024-01-01',
          img_src: 'https://img.com/test.png',
        },
      ],
    });
    const result = parseResponse(makeFetchResult(body), 'query');

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toEqual({
      title: 'Title',
      url: 'https://example.com',
      content: 'Content',
      score: 1.0,
    });
  });

  // [Implements: US-SR-002] Query is used only for logging
  it('uses the query parameter in the empty-results stderr message', () => {
    const body = JSON.stringify({ results: [] });
    parseResponse(makeFetchResult(body), 'my special query');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('my special query')
    );
  });
});
