/**
 * Unit tests for MCP server parameter validation (validation.ts).
 *
 * Tests validateWebSearchParams and validateWebFetchParams against:
 * - Valid inputs
 * - Missing required fields
 * - Invalid types
 * - Default values
 * - snake_case → camelCase mapping
 * - additionalProperties rejection
 *
 * [Spec: US-MC-003, US-MC-004, US-MC-005, US-MC-010, DC-MC-003, DC-MC-004]
 */

import { describe, it, expect } from 'vitest';
import {
  validateWebSearchParams,
  validateWebFetchParams,
} from '../../../src/modules/mcp-server/validation.js';

// ---------------------------------------------------------------------------
// validateWebSearchParams
// ---------------------------------------------------------------------------

describe('validateWebSearchParams', () => {
  // --- Valid inputs ---

  // [Implements: US-MC-010, DC-MC-003]
  it('accepts a valid query with no optional params', () => {
    const result = validateWebSearchParams({ query: 'climate change' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe('climate change');
    }
  });

  it('accepts a valid query with max_results and focus', () => {
    const result = validateWebSearchParams({
      query: 'quantum computing',
      max_results: 10,
      focus: 'hardware',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe('quantum computing');
      expect(result.data.maxResults).toBe(10);
      expect(result.data.focus).toBe('hardware');
    }
  });

  it('accepts a query with only focus (no max_results)', () => {
    const result = validateWebSearchParams({
      query: 'renewable energy',
      focus: 'solar',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe('renewable energy');
      expect(result.data.focus).toBe('solar');
    }
  });

  it('accepts a single-character query', () => {
    const result = validateWebSearchParams({ query: 'x' });
    expect(result.success).toBe(true);
  });

  it('accepts a query with special characters', () => {
    const result = validateWebSearchParams({
      query: 'What is 2+2? & why does it matter?',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe('What is 2+2? & why does it matter?');
    }
  });

  // --- Default values ---

  // [Implements: US-MC-010, DC-MC-003] Default maxResults is 5
  it('defaults maxResults to 5 when max_results is omitted', () => {
    const result = validateWebSearchParams({ query: 'test query' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResults).toBe(5);
    }
  });

  it('defaults maxResults to 5 when only query and focus are provided', () => {
    const result = validateWebSearchParams({
      query: 'test',
      focus: 'ai',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResults).toBe(5);
    }
  });

  // --- snake_case → camelCase mapping ---

  // [Implements: US-MC-010, DC-MC-003] max_results → maxResults
  it('maps snake_case max_results to camelCase maxResults', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: 15,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResults).toBe(15);
      expect(result.data).not.toHaveProperty('max_results');
    }
  });

  it('preserves focus field as-is (no case change needed)', () => {
    const result = validateWebSearchParams({
      query: 'test',
      focus: 'deep learning',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBe('deep learning');
    }
  });

  it('maps all fields correctly from snake_case input', () => {
    const result = validateWebSearchParams({
      query: 'machine learning',
      max_results: 8,
      focus: 'transformers',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        query: 'machine learning',
        maxResults: 8,
        focus: 'transformers',
      });
    }
  });

  // --- Missing required fields ---

  // [Implements: US-MC-010] Missing query
  it('fails with "Missing required field: query" when query is absent', () => {
    const result = validateWebSearchParams({ max_results: 5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('Missing required field: query');
    }
  });

  it('fails when params object is empty', () => {
    const result = validateWebSearchParams({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('Missing required field: query');
    }
  });

  // --- Empty query ---

  // [Implements: US-MC-010] Empty string query
  it('fails with "Missing required field: query" for empty string query', () => {
    const result = validateWebSearchParams({ query: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('Missing required field: query');
    }
  });

  // --- Invalid types ---

  // [Implements: US-MC-010, DC-MC-003] Non-integer max_results
  it('fails when max_results is a float (non-integer)', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: 3.5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('max_results must be a positive integer');
    }
  });

  it('fails when max_results is a string', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: 'five',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('max_results must be a positive integer');
    }
  });

  it('fails when max_results is a boolean', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: true,
    });
    expect(result.success).toBe(false);
  });

  it('fails when max_results is an array', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: [5],
    });
    expect(result.success).toBe(false);
  });

  it('fails when max_results is null', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: null,
    });
    expect(result.success).toBe(false);
  });

  // --- Negative max_results ---

  // [Implements: US-MC-010, DC-MC-003] Negative max_results
  it('fails when max_results is negative', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: -1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('max_results must be a positive integer');
    }
  });

  it('fails when max_results is zero (not positive)', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('max_results must be a positive integer');
    }
  });

  it('fails when max_results is a negative float', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: -3.5,
    });
    expect(result.success).toBe(false);
  });

  // --- Query type validation ---

  it('fails when query is a number', () => {
    const result = validateWebSearchParams({ query: 123 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('Missing required field: query');
    }
  });

  it('fails when query is null', () => {
    const result = validateWebSearchParams({ query: null });
    expect(result.success).toBe(false);
  });

  it('fails when query is a boolean', () => {
    const result = validateWebSearchParams({ query: true });
    expect(result.success).toBe(false);
  });

  it('fails when query is an array', () => {
    const result = validateWebSearchParams({ query: ['test'] });
    expect(result.success).toBe(false);
  });

  // --- additionalProperties rejection ---

  // [Implements: US-MC-010, DC-MC-004] additionalProperties: false
  it('rejects additional properties not in the schema', () => {
    const result = validateWebSearchParams({
      query: 'test',
      extra: 'value',
    });
    expect(result.success).toBe(false);
  });

  it('rejects additional property alongside valid params', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: 5,
      unknown_field: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects multiple additional properties', () => {
    const result = validateWebSearchParams({
      query: 'test',
      a: 1,
      b: 2,
    });
    expect(result.success).toBe(false);
  });

  it('rejects camelCase maxResults (schema expects snake_case max_results)', () => {
    const result = validateWebSearchParams({
      query: 'test',
      maxResults: 5,
    });
    expect(result.success).toBe(false);
  });

  // --- Non-object input ---

  it('fails when params is null', () => {
    const result = validateWebSearchParams(null);
    expect(result.success).toBe(false);
  });

  it('fails when params is undefined', () => {
    const result = validateWebSearchParams(undefined);
    expect(result.success).toBe(false);
  });

  it('fails when params is a string', () => {
    const result = validateWebSearchParams('not an object');
    expect(result.success).toBe(false);
  });

  it('fails when params is a number', () => {
    const result = validateWebSearchParams(42);
    expect(result.success).toBe(false);
  });

  it('fails when params is an array', () => {
    const result = validateWebSearchParams(['query']);
    expect(result.success).toBe(false);
  });

  // --- Result shape ---

  it('returns success result with data property on valid input', () => {
    const result = validateWebSearchParams({ query: 'test' });
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('data');
  });

  it('returns failure result with message property on invalid input', () => {
    const result = validateWebSearchParams({});
    expect(result).toHaveProperty('success', false);
    expect(result).toHaveProperty('message');
    expect(typeof (result as { message: string }).message).toBe('string');
  });

  // --- Boundary values ---

  it('accepts max_results of 1 (minimum positive integer)', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResults).toBe(1);
    }
  });

  it('accepts a very large max_results', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: 1000000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResults).toBe(1000000);
    }
  });

  it('accepts empty string focus', () => {
    const result = validateWebSearchParams({
      query: 'test',
      focus: '',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBe('');
    }
  });

  // --- focus is always included in output (even when undefined) ---

  it('includes focus as undefined in data when not provided', () => {
    const result = validateWebSearchParams({ query: 'test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBeUndefined();
    }
  });

  // --- Whitespace-only query ---

  // [Implements: US-MC-010] Whitespace-only query is non-empty string, so Zod .min(1) passes
  it('accepts whitespace-only query (non-empty string passes schema)', () => {
    const result = validateWebSearchParams({ query: '   ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe('   ');
    }
  });

  it('accepts query with only newlines', () => {
    const result = validateWebSearchParams({ query: '\n\n\n' });
    expect(result.success).toBe(true);
  });

  it('accepts query with only tabs', () => {
    const result = validateWebSearchParams({ query: '\t\t\t' });
    expect(result.success).toBe(true);
  });

  // --- Focus edge cases ---

  it('accepts whitespace-only focus', () => {
    const result = validateWebSearchParams({
      query: 'test',
      focus: '   ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBe('   ');
    }
  });

  it('accepts a very long focus string', () => {
    const longFocus = 'a'.repeat(10000);
    const result = validateWebSearchParams({
      query: 'test',
      focus: longFocus,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBe(longFocus);
    }
  });

  it('accepts focus with special characters', () => {
    const result = validateWebSearchParams({
      query: 'test',
      focus: '!@#$%^&*()_+-={}[]|\\:";\'<>?,./',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBe('!@#$%^&*()_+-={}[]|\\:";\'<>?,./');
    }
  });

  it('accepts focus with Unicode characters', () => {
    const result = validateWebSearchParams({
      query: 'test',
      focus: '日本語のフォーカス 🔬 العربية',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBe('日本語のフォーカス 🔬 العربية');
    }
  });

  it('accepts focus with emojis', () => {
    const result = validateWebSearchParams({
      query: 'test',
      focus: '🚀💡🔍',
    });
    expect(result.success).toBe(true);
  });

  // --- Query edge cases ---

  it('accepts a very long query string', () => {
    const longQuery = 'a'.repeat(10000);
    const result = validateWebSearchParams({ query: longQuery });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe(longQuery);
    }
  });

  it('accepts a multiline query', () => {
    const result = validateWebSearchParams({
      query: 'line one\nline two\nline three',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe('line one\nline two\nline three');
    }
  });

  it('accepts a query with Unicode characters', () => {
    const result = validateWebSearchParams({
      query: '日本語のクエリ 🔬 한국어 العربية',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe('日本語のクエリ 🔬 한국어 العربية');
    }
  });

  it('accepts a query with emojis', () => {
    const result = validateWebSearchParams({ query: '🚀 search 🔍' });
    expect(result.success).toBe(true);
  });

  // --- max_results edge cases ---

  it('accepts max_results as Number.MAX_SAFE_INTEGER', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: Number.MAX_SAFE_INTEGER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResults).toBe(Number.MAX_SAFE_INTEGER);
    }
  });

  it('rejects max_results as NaN', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: NaN,
    });
    expect(result.success).toBe(false);
  });

  it('rejects max_results as Infinity', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: Infinity,
    });
    expect(result.success).toBe(false);
  });

  // --- Determinism and idempotency ---

  it('produces identical results for the same valid input on repeated calls', () => {
    const params = { query: 'reproducible', max_results: 7, focus: 'topic' };
    const r1 = validateWebSearchParams(params);
    const r2 = validateWebSearchParams(params);
    const r3 = validateWebSearchParams(params);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });

  it('produces identical failure results for the same invalid input on repeated calls', () => {
    const params = {};
    const r1 = validateWebSearchParams(params);
    const r2 = validateWebSearchParams(params);
    expect(r1).toEqual(r2);
  });

  it('does not mutate the input params object', () => {
    const params = { query: 'immutability', max_results: 3 };
    const snapshot = { ...params };
    validateWebSearchParams(params);
    expect(params).toEqual(snapshot);
  });

  it('returns a new object (not the same reference as input)', () => {
    const params = { query: 'reference', max_results: 5 };
    const result = validateWebSearchParams(params);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toBe(params);
    }
  });

  // --- First error only returned ---

  it('returns only the first error when multiple fields are invalid', () => {
    const result = validateWebSearchParams({
      query: '',
      max_results: -1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // query error takes priority
      expect(result.message).toBe('Missing required field: query');
    }
  });

  it('returns max_results error when query is valid but max_results is invalid', () => {
    const result = validateWebSearchParams({
      query: 'valid',
      max_results: -5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('max_results must be a positive integer');
    }
  });

  // --- Explicit undefined for optional fields ---

  it('accepts explicit undefined for max_results', () => {
    const result = validateWebSearchParams({
      query: 'test',
      max_results: undefined,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResults).toBe(5);
    }
  });

  it('accepts explicit undefined for focus', () => {
    const result = validateWebSearchParams({
      query: 'test',
      focus: undefined,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBeUndefined();
    }
  });

  // --- Output type integrity ---

  it('output data has exactly query, maxResults, and focus keys', () => {
    const result = validateWebSearchParams({ query: 'test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(['focus', 'maxResults', 'query']);
    }
  });

  it('maxResults is always a number in output', () => {
    const result = validateWebSearchParams({ query: 'test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.maxResults).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// validateWebFetchParams
// ---------------------------------------------------------------------------

describe('validateWebFetchParams', () => {
  // --- Valid inputs ---

  // [Implements: US-MC-010, DC-MC-003]
  it('accepts a valid URL with no focus', () => {
    const result = validateWebFetchParams({ url: 'https://example.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe('https://example.com');
    }
  });

  it('accepts a valid URL with focus', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com/article',
      focus: 'methodology',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe('https://example.com/article');
      expect(result.data.focus).toBe('methodology');
    }
  });

  it('accepts an HTTP URL', () => {
    const result = validateWebFetchParams({ url: 'http://example.com' });
    expect(result.success).toBe(true);
  });

  it('accepts a URL with path and query string', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com/path/to/page?q=test&sort=asc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a URL with fragment', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com/page#section',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a URL with port', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com:8080/path',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a URL with subdomain', () => {
    const result = validateWebFetchParams({
      url: 'https://blog.example.com/post/123',
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty string focus', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com',
      focus: '',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBe('');
    }
  });

  // --- Invalid URL format ---

  // [Implements: US-MC-010, DC-MC-003] Invalid URL format
  it('fails with "Invalid URL format: {value}" for a malformed URL', () => {
    const result = validateWebFetchParams({ url: 'not-a-url' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('Invalid URL format: not-a-url');
    }
  });

  it('fails for URL without protocol', () => {
    const result = validateWebFetchParams({ url: 'example.com/path' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('Invalid URL format: example.com/path');
    }
  });

  it('fails for URL with spaces', () => {
    const result = validateWebFetchParams({ url: 'https://example .com' });
    expect(result.success).toBe(false);
  });

  it('fails for plain text string', () => {
    const result = validateWebFetchParams({ url: 'hello world' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('Invalid URL format: hello world');
    }
  });

  it('fails for URL with only protocol', () => {
    const result = validateWebFetchParams({ url: 'https://' });
    expect(result.success).toBe(false);
  });

  it('includes the provided URL value in the error message', () => {
    const badUrl = 'ht!tp://not valid';
    const result = validateWebFetchParams({ url: badUrl });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain(badUrl);
    }
  });

  // --- Missing url ---

  // [Implements: US-MC-010, DC-MC-003] Missing url
  it('fails when url is absent', () => {
    const result = validateWebFetchParams({ focus: 'topic' });
    expect(result.success).toBe(false);
  });

  it('fails when params object is empty', () => {
    const result = validateWebFetchParams({});
    expect(result.success).toBe(false);
  });

  // --- Invalid types for url ---

  it('fails when url is a number', () => {
    const result = validateWebFetchParams({ url: 42 });
    expect(result.success).toBe(false);
  });

  it('fails when url is null', () => {
    const result = validateWebFetchParams({ url: null });
    expect(result.success).toBe(false);
  });

  it('fails when url is a boolean', () => {
    const result = validateWebFetchParams({ url: true });
    expect(result.success).toBe(false);
  });

  it('fails when url is an array', () => {
    const result = validateWebFetchParams({ url: ['https://example.com'] });
    expect(result.success).toBe(false);
  });

  it('fails when url is an object', () => {
    const result = validateWebFetchParams({ url: { href: 'https://example.com' } });
    expect(result.success).toBe(false);
  });

  // --- additionalProperties rejection ---

  // [Implements: US-MC-010, DC-MC-004] additionalProperties: false
  it('rejects additional properties not in the schema', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com',
      extra: 'value',
    });
    expect(result.success).toBe(false);
  });

  it('rejects additional property alongside valid url and focus', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com',
      focus: 'topic',
      unknown_field: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects multiple additional properties', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com',
      a: 1,
      b: 2,
    });
    expect(result.success).toBe(false);
  });

  // --- Non-object input ---

  it('fails when params is null', () => {
    const result = validateWebFetchParams(null);
    expect(result.success).toBe(false);
  });

  it('fails when params is undefined', () => {
    const result = validateWebFetchParams(undefined);
    expect(result.success).toBe(false);
  });

  it('fails when params is a string', () => {
    const result = validateWebFetchParams('not an object');
    expect(result.success).toBe(false);
  });

  it('fails when params is a number', () => {
    const result = validateWebFetchParams(42);
    expect(result.success).toBe(false);
  });

  it('fails when params is an array', () => {
    const result = validateWebFetchParams(['https://example.com']);
    expect(result.success).toBe(false);
  });

  // --- Result shape ---

  it('returns success result with data property on valid input', () => {
    const result = validateWebFetchParams({ url: 'https://example.com' });
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('data');
  });

  it('returns failure result with message property on invalid input', () => {
    const result = validateWebFetchParams({});
    expect(result).toHaveProperty('success', false);
    expect(result).toHaveProperty('message');
    expect(typeof (result as { message: string }).message).toBe('string');
  });

  // --- focus is always included in output (even when undefined) ---

  it('includes focus as undefined in data when not provided', () => {
    const result = validateWebFetchParams({ url: 'https://example.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBeUndefined();
    }
  });

  // --- URL format edge cases ---

  it('accepts a localhost URL', () => {
    const result = validateWebFetchParams({ url: 'http://localhost:3000/page' });
    expect(result.success).toBe(true);
  });

  it('accepts a 127.0.0.1 URL', () => {
    const result = validateWebFetchParams({ url: 'http://127.0.0.1:8080' });
    expect(result.success).toBe(true);
  });

  it('accepts a URL with credentials', () => {
    const result = validateWebFetchParams({
      url: 'https://user:pass@example.com/page',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a URL with IPv6 address', () => {
    const result = validateWebFetchParams({
      url: 'http://[::1]:8080/path',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a URL with encoded characters', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com/path%20with%20spaces',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a URL with Unicode characters in the path', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com/路径/記事',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a mailto URL', () => {
    const result = validateWebFetchParams({ url: 'mailto:test@example.com' });
    expect(result.success).toBe(true);
  });

  it('accepts an FTP URL', () => {
    const result = validateWebFetchParams({ url: 'ftp://ftp.example.com/file' });
    expect(result.success).toBe(true);
  });

  it('accepts a very long URL', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2000);
    const result = validateWebFetchParams({ url: longUrl });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe(longUrl);
    }
  });

  it('accepts a URL with multiple query parameters', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com/path?a=1&b=2&c=3&d=4',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a URL with a deep path', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com/a/b/c/d/e/f/g/h/i/j',
    });
    expect(result.success).toBe(true);
  });

  // --- Focus edge cases ---

  it('accepts whitespace-only focus', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com',
      focus: '   ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBe('   ');
    }
  });

  it('accepts a very long focus string', () => {
    const longFocus = 'a'.repeat(10000);
    const result = validateWebFetchParams({
      url: 'https://example.com',
      focus: longFocus,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBe(longFocus);
    }
  });

  it('accepts focus with special characters', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com',
      focus: '!@#$%^&*()_+-={}[]|\\:";\'<>?,./',
    });
    expect(result.success).toBe(true);
  });

  it('accepts focus with Unicode characters', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com',
      focus: '日本語のフォーカス 🔬 العربية',
    });
    expect(result.success).toBe(true);
  });

  // --- Empty string url ---

  it('fails with "Invalid URL format:" for empty string url', () => {
    const result = validateWebFetchParams({ url: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe('Invalid URL format: ');
    }
  });

  it('fails for whitespace-only url', () => {
    const result = validateWebFetchParams({ url: '   ' });
    expect(result.success).toBe(false);
  });

  // --- Determinism and idempotency ---

  it('produces identical results for the same valid input on repeated calls', () => {
    const params = { url: 'https://example.com/page', focus: 'topic' };
    const r1 = validateWebFetchParams(params);
    const r2 = validateWebFetchParams(params);
    const r3 = validateWebFetchParams(params);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });

  it('produces identical failure results for the same invalid input on repeated calls', () => {
    const params = { url: 'bad' };
    const r1 = validateWebFetchParams(params);
    const r2 = validateWebFetchParams(params);
    expect(r1).toEqual(r2);
  });

  it('does not mutate the input params object', () => {
    const params = { url: 'https://example.com', focus: 'topic' };
    const snapshot = { ...params };
    validateWebFetchParams(params);
    expect(params).toEqual(snapshot);
  });

  it('returns a new object (not the same reference as input)', () => {
    const params = { url: 'https://example.com' };
    const result = validateWebFetchParams(params);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toBe(params);
    }
  });

  // --- Explicit undefined for optional fields ---

  it('accepts explicit undefined for focus', () => {
    const result = validateWebFetchParams({
      url: 'https://example.com',
      focus: undefined,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.focus).toBeUndefined();
    }
  });

  // --- Output type integrity ---

  it('output data has exactly url and focus keys', () => {
    const result = validateWebFetchParams({ url: 'https://example.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(['focus', 'url']);
    }
  });

  it('output url is always a string in valid result', () => {
    const result = validateWebFetchParams({ url: 'https://example.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.url).toBe('string');
    }
  });

  // --- First error priority ---

  it('returns url error when url is invalid even if focus is also invalid', () => {
    const result = validateWebFetchParams({
      url: 'bad-url',
      focus: 123 as unknown as string,
    });
    expect(result.success).toBe(false);
  });
});
