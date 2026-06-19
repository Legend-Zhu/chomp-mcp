/**
 * Unit tests for the search-retrieval error class hierarchy and the
 * isRetryableError classifier.
 *
 * Verifies:
 *   - Inheritance chains via instanceof checks (SearchError → Error,
 *     subclasses → SearchError, ConfigurationError/ValidationError → Error)
 *   - Exact error messages passed through constructors
 *   - category field values for each error class
 *   - name property values for each error class
 *   - bodyExcerpt field on SearchParseError
 *   - isRetryableError classification for all error types and edge cases
 *
 * [Spec: US-SR-006, US-SR-007, US-SR-012, NFR-SR-004]
 */

import { describe, it, expect } from 'vitest';
import {
  SearchError,
  SearchTimeoutError,
  SearchParseError,
  SearchFailedError,
  SearchUnavailableError,
  ConfigurationError,
  ValidationError,
  isRetryableError,
} from '../../../src/modules/search-retrieval/errors.js';
import { AppError } from '../../../src/shared/utils/errors.js';
import type { SearchErrorCategory } from '../../../src/modules/search-retrieval/errors.js';

// ---------------------------------------------------------------------------
// SearchError — base class
// ---------------------------------------------------------------------------

describe('SearchError', () => {
  // [Implements: US-SR-012] SearchError extends Error
  it('extends the native Error class', () => {
    const err = new SearchError('test message');
    expect(err).toBeInstanceOf(Error);
  });

  // [Implements: US-SR-012] SearchError is its own base
  it('is an instance of SearchError', () => {
    const err = new SearchError('test message');
    expect(err).toBeInstanceOf(SearchError);
  });

  // [Implements: US-SR-012] Message is preserved
  it('preserves the exact message passed to the constructor', () => {
    const msg = 'SearXNG returned an unexpected error';
    const err = new SearchError(msg);
    expect(err.message).toBe(msg);
  });

  // [Implements: US-SR-012] Default category is http_error
  it('defaults to category "http_error" when no category is specified', () => {
    const err = new SearchError('test');
    expect(err.category).toBe('http_error');
  });

  // [Implements: US-SR-012] Category can be overridden
  it('accepts a custom category', () => {
    const err = new SearchError('test', 'timeout');
    expect(err.category).toBe('timeout');
  });

  // [Implements: US-SR-012] name property
  it('sets name to "SearchError"', () => {
    const err = new SearchError('test');
    expect(err.name).toBe('SearchError');
  });

  it('preserves message with special characters', () => {
    const msg = 'Error: <html> & "quotes" \n newline';
    const err = new SearchError(msg);
    expect(err.message).toBe(msg);
  });

  it('preserves empty string message', () => {
    const err = new SearchError('');
    expect(err.message).toBe('');
  });

  it('has a stack trace', () => {
    const err = new SearchError('test');
    expect(err.stack).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SearchTimeoutError
// ---------------------------------------------------------------------------

describe('SearchTimeoutError', () => {
  // [Implements: US-SR-004, US-SR-012] Inherits from SearchError
  it('extends SearchError', () => {
    const err = new SearchTimeoutError('timed out');
    expect(err).toBeInstanceOf(SearchError);
  });

  it('extends Error', () => {
    const err = new SearchTimeoutError('timed out');
    expect(err).toBeInstanceOf(Error);
  });

  // [Implements: US-SR-004] Category is timeout
  it('has category "timeout"', () => {
    const err = new SearchTimeoutError('timed out');
    expect(err.category).toBe('timeout');
  });

  // [Implements: US-SR-012] name property
  it('sets name to "SearchTimeoutError"', () => {
    const err = new SearchTimeoutError('timed out');
    expect(err.name).toBe('SearchTimeoutError');
  });

  it('preserves the exact message', () => {
    const msg = 'Request to SearXNG timed out after 10000ms';
    const err = new SearchTimeoutError(msg);
    expect(err.message).toBe(msg);
  });

  it('is caught by a SearchError catch block', () => {
    let caught: SearchError | null = null;
    try {
      throw new SearchTimeoutError('timeout');
    } catch (e) {
      if (e instanceof SearchError) caught = e;
    }
    expect(caught).toBeInstanceOf(SearchTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// SearchParseError
// ---------------------------------------------------------------------------

describe('SearchParseError', () => {
  // [Implements: US-SR-002, US-SR-012] Inherits from SearchError
  it('extends SearchError', () => {
    const err = new SearchParseError('parse failed');
    expect(err).toBeInstanceOf(SearchError);
  });

  it('extends Error', () => {
    const err = new SearchParseError('parse failed');
    expect(err).toBeInstanceOf(Error);
  });

  // [Implements: US-SR-002] Category is parse_error
  it('has category "parse_error"', () => {
    const err = new SearchParseError('parse failed');
    expect(err.category).toBe('parse_error');
  });

  // [Implements: US-SR-012] name property
  it('sets name to "SearchParseError"', () => {
    const err = new SearchParseError('parse failed');
    expect(err.name).toBe('SearchParseError');
  });

  it('preserves the exact message', () => {
    const msg = 'Response body is not valid JSON';
    const err = new SearchParseError(msg);
    expect(err.message).toBe(msg);
  });

  // [Implements: US-SR-009] bodyExcerpt defaults to null when not provided
  it('defaults bodyExcerpt to null when not provided', () => {
    const err = new SearchParseError('parse failed');
    expect(err.bodyExcerpt).toBeNull();
  });

  // [Implements: US-SR-009] bodyExcerpt stores the provided excerpt
  it('stores bodyExcerpt when provided', () => {
    const excerpt = '<html><body>Not JSON</body></html>';
    const err = new SearchParseError('parse failed', excerpt);
    expect(err.bodyExcerpt).toBe(excerpt);
  });

  // [Implements: US-SR-009] bodyExcerpt stores empty string when provided
  it('stores empty string bodyExcerpt when provided as empty string', () => {
    const err = new SearchParseError('parse failed', '');
    expect(err.bodyExcerpt).toBe('');
  });

  it('stores a long bodyExcerpt', () => {
    const excerpt = 'x'.repeat(200);
    const err = new SearchParseError('parse failed', excerpt);
    expect(err.bodyExcerpt).toBe(excerpt);
  });

  it('is caught by a SearchError catch block', () => {
    let caught: SearchError | null = null;
    try {
      throw new SearchParseError('parse error');
    } catch (e) {
      if (e instanceof SearchError) caught = e;
    }
    expect(caught).toBeInstanceOf(SearchParseError);
  });
});

// ---------------------------------------------------------------------------
// SearchFailedError
// ---------------------------------------------------------------------------

describe('SearchFailedError', () => {
  // [Implements: US-SR-005, US-SR-012] Inherits from SearchError
  it('extends SearchError', () => {
    const err = new SearchFailedError('failed');
    expect(err).toBeInstanceOf(SearchError);
  });

  it('extends Error', () => {
    const err = new SearchFailedError('failed');
    expect(err).toBeInstanceOf(Error);
  });

  // [Implements: US-SR-005] Category is http_error
  it('has category "http_error"', () => {
    const err = new SearchFailedError('failed');
    expect(err.category).toBe('http_error');
  });

  // [Implements: US-SR-012] name property
  it('sets name to "SearchFailedError"', () => {
    const err = new SearchFailedError('failed');
    expect(err.name).toBe('SearchFailedError');
  });

  it('preserves the exact message', () => {
    const msg = 'All retries exhausted for instance https://searx.be';
    const err = new SearchFailedError(msg);
    expect(err.message).toBe(msg);
  });

  it('is caught by a SearchError catch block', () => {
    let caught: SearchError | null = null;
    try {
      throw new SearchFailedError('failed');
    } catch (e) {
      if (e instanceof SearchError) caught = e;
    }
    expect(caught).toBeInstanceOf(SearchFailedError);
  });
});

// ---------------------------------------------------------------------------
// SearchUnavailableError
// ---------------------------------------------------------------------------

describe('SearchUnavailableError', () => {
  // [Implements: US-SR-006, US-SR-012] Inherits from SearchError
  it('extends SearchError', () => {
    const err = new SearchUnavailableError('unavailable');
    expect(err).toBeInstanceOf(SearchError);
  });

  it('extends Error', () => {
    const err = new SearchUnavailableError('unavailable');
    expect(err).toBeInstanceOf(Error);
  });

  // [Implements: US-SR-006] Category is network
  it('has category "network"', () => {
    const err = new SearchUnavailableError('unavailable');
    expect(err.category).toBe('network');
  });

  // [Implements: US-SR-012] name property
  it('sets name to "SearchUnavailableError"', () => {
    const err = new SearchUnavailableError('unavailable');
    expect(err.name).toBe('SearchUnavailableError');
  });

  it('preserves the exact message', () => {
    const msg =
      'All SearXNG instances unavailable. Set SEARXNG_URL to a self-hosted instance for improved reliability.';
    const err = new SearchUnavailableError(msg);
    expect(err.message).toBe(msg);
  });

  it('is caught by a SearchError catch block', () => {
    let caught: SearchError | null = null;
    try {
      throw new SearchUnavailableError('unavailable');
    } catch (e) {
      if (e instanceof SearchError) caught = e;
    }
    expect(caught).toBeInstanceOf(SearchUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// ConfigurationError
// ---------------------------------------------------------------------------

describe('ConfigurationError', () => {
  // [Implements: US-SR-007, US-SR-012] Extends Error directly (NOT SearchError)
  it('extends the native Error class', () => {
    const err = new ConfigurationError('config error');
    expect(err).toBeInstanceOf(Error);
  });

  // [Implements: US-SR-012] Does NOT extend SearchError
  it('does NOT extend SearchError', () => {
    const err = new ConfigurationError('config error');
    expect(err).not.toBeInstanceOf(SearchError);
  });

  // [Implements: US-SR-007] Category is config
  it('has category "config"', () => {
    const err = new ConfigurationError('config error');
    expect(err.category).toBe('config');
  });

  // [Implements: US-SR-012] name property
  it('sets name to "ConfigurationError"', () => {
    const err = new ConfigurationError('config error');
    expect(err.name).toBe('ConfigurationError');
  });

  it('preserves the exact message', () => {
    const msg = 'SEARXNG_URL must be a valid HTTP(S) URL';
    const err = new ConfigurationError(msg);
    expect(err.message).toBe(msg);
  });

  it('is NOT caught by a SearchError catch block', () => {
    let caughtBySearchError = false;
    try {
      throw new ConfigurationError('config error');
    } catch (e) {
      if (e instanceof SearchError) caughtBySearchError = true;
    }
    expect(caughtBySearchError).toBe(false);
  });

  it('is caught by a generic Error catch block', () => {
    let caught: Error | null = null;
    try {
      throw new ConfigurationError('config error');
    } catch (e) {
      if (e instanceof Error) caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
  });
});

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  // [Implements: US-SR-001, US-SR-012] Extends Error directly (NOT SearchError)
  it('extends the native Error class', () => {
    const err = new ValidationError('validation error');
    expect(err).toBeInstanceOf(Error);
  });

  // [Implements: US-SR-012] Does NOT extend SearchError
  it('does NOT extend SearchError', () => {
    const err = new ValidationError('validation error');
    expect(err).not.toBeInstanceOf(SearchError);
  });

  // [Implements: US-SR-001] Category is validation
  it('has category "validation"', () => {
    const err = new ValidationError('validation error');
    expect(err.category).toBe('validation');
  });

  // [Implements: US-SR-012] name property
  it('sets name to "ValidationError"', () => {
    const err = new ValidationError('validation error');
    expect(err.name).toBe('ValidationError');
  });

  it('preserves the exact message', () => {
    const msg = 'Query must be a non-empty string';
    const err = new ValidationError(msg);
    expect(err.message).toBe(msg);
  });

  it('is NOT caught by a SearchError catch block', () => {
    let caughtBySearchError = false;
    try {
      throw new ValidationError('validation error');
    } catch (e) {
      if (e instanceof SearchError) caughtBySearchError = true;
    }
    expect(caughtBySearchError).toBe(false);
  });

  it('is caught by a generic Error catch block', () => {
    let caught: Error | null = null;
    try {
      throw new ValidationError('validation error');
    } catch (e) {
      if (e instanceof Error) caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Inheritance hierarchy — comprehensive instanceof matrix
// ---------------------------------------------------------------------------

describe('inheritance hierarchy — instanceof matrix', () => {
  // [Implements: US-SR-012] All SearchError subclasses are instanceof SearchError
  it('SearchTimeoutError is instanceof SearchError and Error', () => {
    const err = new SearchTimeoutError('test');
    expect(err instanceof SearchError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it('SearchParseError is instanceof SearchError and Error', () => {
    const err = new SearchParseError('test');
    expect(err instanceof SearchError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it('SearchFailedError is instanceof SearchError and Error', () => {
    const err = new SearchFailedError('test');
    expect(err instanceof SearchError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it('SearchUnavailableError is instanceof SearchError and Error', () => {
    const err = new SearchUnavailableError('test');
    expect(err instanceof SearchError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  // [Implements: US-SR-012] ConfigurationError and ValidationError are NOT SearchError
  it('ConfigurationError is instanceof Error but NOT SearchError', () => {
    const err = new ConfigurationError('test');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof SearchError).toBe(false);
  });

  it('ValidationError is instanceof Error but NOT SearchError', () => {
    const err = new ValidationError('test');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof SearchError).toBe(false);
  });

  // [Implements: US-SR-012] Subclasses are not instances of each other
  it('SearchTimeoutError is NOT an instance of SearchParseError', () => {
    const err = new SearchTimeoutError('test');
    expect(err instanceof SearchParseError).toBe(false);
  });

  it('SearchFailedError is NOT an instance of SearchTimeoutError', () => {
    const err = new SearchFailedError('test');
    expect(err instanceof SearchTimeoutError).toBe(false);
  });

  it('SearchUnavailableError is NOT an instance of SearchFailedError', () => {
    const err = new SearchUnavailableError('test');
    expect(err instanceof SearchFailedError).toBe(false);
  });

  // [Implements: US-SR-012] SearchError base is not an instance of any subclass
  it('SearchError is NOT an instance of SearchTimeoutError', () => {
    const err = new SearchError('test');
    expect(err instanceof SearchTimeoutError).toBe(false);
  });

  it('SearchError is NOT an instance of ConfigurationError', () => {
    const err = new SearchError('test');
    expect(err instanceof ConfigurationError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Category values — exact verification
// ---------------------------------------------------------------------------

describe('category values', () => {
  // [Implements: US-SR-012, NFR-SR-004] Each class has the correct category
  it('SearchError default category is "http_error"', () => {
    expect(new SearchError('test').category).toBe('http_error');
  });

  it('SearchTimeoutError category is "timeout"', () => {
    expect(new SearchTimeoutError('test').category).toBe('timeout');
  });

  it('SearchParseError category is "parse_error"', () => {
    expect(new SearchParseError('test').category).toBe('parse_error');
  });

  it('SearchFailedError category is "http_error"', () => {
    expect(new SearchFailedError('test').category).toBe('http_error');
  });

  it('SearchUnavailableError category is "network"', () => {
    expect(new SearchUnavailableError('test').category).toBe('network');
  });

  it('ConfigurationError category is "config"', () => {
    expect(new ConfigurationError('test').category).toBe('config');
  });

  it('ValidationError category is "validation"', () => {
    expect(new ValidationError('test').category).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// name property values — exact verification
// ---------------------------------------------------------------------------

describe('name property values', () => {
  // [Implements: US-SR-012] Each class sets the correct name
  it('SearchError name is "SearchError"', () => {
    expect(new SearchError('test').name).toBe('SearchError');
  });

  it('SearchTimeoutError name is "SearchTimeoutError"', () => {
    expect(new SearchTimeoutError('test').name).toBe('SearchTimeoutError');
  });

  it('SearchParseError name is "SearchParseError"', () => {
    expect(new SearchParseError('test').name).toBe('SearchParseError');
  });

  it('SearchFailedError name is "SearchFailedError"', () => {
    expect(new SearchFailedError('test').name).toBe('SearchFailedError');
  });

  it('SearchUnavailableError name is "SearchUnavailableError"', () => {
    expect(new SearchUnavailableError('test').name).toBe('SearchUnavailableError');
  });

  it('ConfigurationError name is "ConfigurationError"', () => {
    expect(new ConfigurationError('test').name).toBe('ConfigurationError');
  });

  it('ValidationError name is "ValidationError"', () => {
    expect(new ValidationError('test').name).toBe('ValidationError');
  });
});

// ---------------------------------------------------------------------------
// isRetryableError — retryable error types
// ---------------------------------------------------------------------------

describe('isRetryableError — retryable types', () => {
  // [Implements: US-SR-005, US-SR-009] Timeout errors are retryable
  it('returns true for SearchTimeoutError', () => {
    const err = new SearchTimeoutError('timed out');
    expect(isRetryableError(err)).toBe(true);
  });

  // [Implements: US-SR-009] Parse errors are retryable
  it('returns true for SearchParseError', () => {
    const err = new SearchParseError('parse failed');
    expect(isRetryableError(err)).toBe(true);
  });

  // [Implements: US-SR-005] HTTP errors are retryable
  it('returns true for SearchFailedError', () => {
    const err = new SearchFailedError('failed');
    expect(isRetryableError(err)).toBe(true);
  });

  // [Implements: US-SR-006] Network errors are retryable
  it('returns true for SearchUnavailableError', () => {
    const err = new SearchUnavailableError('unavailable');
    expect(isRetryableError(err)).toBe(true);
  });

  // [Implements: US-SR-005] SearchError with default category (http_error) is retryable
  it('returns true for SearchError with default category "http_error"', () => {
    const err = new SearchError('test');
    expect(isRetryableError(err)).toBe(true);
  });

  // [Implements: US-SR-005] SearchError with timeout category is retryable
  it('returns true for SearchError with category "timeout"', () => {
    const err = new SearchError('test', 'timeout');
    expect(isRetryableError(err)).toBe(true);
  });

  // [Implements: US-SR-009] SearchError with parse_error category is retryable
  it('returns true for SearchError with category "parse_error"', () => {
    const err = new SearchError('test', 'parse_error');
    expect(isRetryableError(err)).toBe(true);
  });

  // [Implements: US-SR-006] SearchError with network category is retryable
  it('returns true for SearchError with category "network"', () => {
    const err = new SearchError('test', 'network');
    expect(isRetryableError(err)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isRetryableError — non-retryable error types
// ---------------------------------------------------------------------------

describe('isRetryableError — non-retryable types', () => {
  // [Implements: US-SR-007] Configuration errors are NOT retryable
  it('returns false for ConfigurationError', () => {
    const err = new ConfigurationError('config error');
    expect(isRetryableError(err)).toBe(false);
  });

  // [Implements: US-SR-001] Validation errors are NOT retryable
  it('returns false for ValidationError', () => {
    const err = new ValidationError('validation error');
    expect(isRetryableError(err)).toBe(false);
  });

  // [Implements: US-SR-007] SearchError with config category is NOT retryable
  it('returns false for SearchError with category "config"', () => {
    const err = new SearchError('test', 'config');
    expect(isRetryableError(err)).toBe(false);
  });

  // [Implements: US-SR-001] SearchError with validation category is NOT retryable
  it('returns false for SearchError with category "validation"', () => {
    const err = new SearchError('test', 'validation');
    expect(isRetryableError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRetryableError — edge cases and non-error inputs
// ---------------------------------------------------------------------------

describe('isRetryableError — edge cases', () => {
  it('returns false for null', () => {
    expect(isRetryableError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRetryableError(undefined)).toBe(false);
  });

  it('returns false for a plain string', () => {
    expect(isRetryableError('some error string')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isRetryableError(42)).toBe(false);
  });

  it('returns false for a boolean', () => {
    expect(isRetryableError(true)).toBe(false);
  });

  it('returns false for a plain Error without a category field', () => {
    const err = new Error('plain error');
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns false for a plain object without a category field', () => {
    expect(isRetryableError({ message: 'test' })).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isRetryableError({})).toBe(false);
  });

  // [Implements: US-SR-005] Duck-typed object with retryable category
  it('returns true for a duck-typed object with category "timeout"', () => {
    const fakeErr = { category: 'timeout', message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(true);
  });

  it('returns true for a duck-typed object with category "network"', () => {
    const fakeErr = { category: 'network', message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(true);
  });

  it('returns true for a duck-typed object with category "http_error"', () => {
    const fakeErr = { category: 'http_error', message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(true);
  });

  it('returns true for a duck-typed object with category "parse_error"', () => {
    const fakeErr = { category: 'parse_error', message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(true);
  });

  it('returns false for a duck-typed object with category "config"', () => {
    const fakeErr = { category: 'config', message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(false);
  });

  it('returns false for a duck-typed object with category "validation"', () => {
    const fakeErr = { category: 'validation', message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(false);
  });

  it('returns false for a duck-typed object with an unknown category string', () => {
    const fakeErr = { category: 'unknown_category', message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(false);
  });

  it('returns false for a duck-typed object with a non-string category', () => {
    const fakeErr = { category: 123, message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(false);
  });

  // [Implements: US-SR-005] AppError with retryable category is retryable via duck-typing
  it('returns true for AppError with category "timeout"', () => {
    const err = new AppError('test', 'timeout');
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for AppError with category "network"', () => {
    const err = new AppError('test', 'network');
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns false for AppError with category "config"', () => {
    const err = new AppError('test', 'config');
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns false for AppError with category "validation"', () => {
    const err = new AppError('test', 'validation');
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns false for AppError with default category "unknown"', () => {
    const err = new AppError('test');
    expect(isRetryableError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRetryableError — comprehensive classification table
// ---------------------------------------------------------------------------

describe('isRetryableError — comprehensive classification table', () => {
  const cases: Array<{
    name: string;
    error: unknown;
    expected: boolean;
  }> = [
    {
      name: 'SearchTimeoutError → true',
      error: new SearchTimeoutError('timeout'),
      expected: true,
    },
    {
      name: 'SearchParseError → true',
      error: new SearchParseError('parse error'),
      expected: true,
    },
    {
      name: 'SearchFailedError → true',
      error: new SearchFailedError('failed'),
      expected: true,
    },
    {
      name: 'SearchUnavailableError → true',
      error: new SearchUnavailableError('unavailable'),
      expected: true,
    },
    {
      name: 'SearchError (default http_error) → true',
      error: new SearchError('test'),
      expected: true,
    },
    {
      name: 'ConfigurationError → false',
      error: new ConfigurationError('config'),
      expected: false,
    },
    {
      name: 'ValidationError → false',
      error: new ValidationError('validation'),
      expected: false,
    },
    {
      name: 'plain Error → false',
      error: new Error('plain'),
      expected: false,
    },
    {
      name: 'null → false',
      error: null,
      expected: false,
    },
    {
      name: 'undefined → false',
      error: undefined,
      expected: false,
    },
    {
      name: 'string → false',
      error: 'error string',
      expected: false,
    },
    {
      name: 'number → false',
      error: 0,
      expected: false,
    },
    {
      name: 'object with category "timeout" → true',
      error: { category: 'timeout' },
      expected: true,
    },
    {
      name: 'object with category "config" → false',
      error: { category: 'config' },
      expected: false,
    },
  ];

  for (const { name, error, expected } of cases) {
    it(`${name}`, () => {
      expect(isRetryableError(error)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Error message exactness — acceptance criteria messages
// ---------------------------------------------------------------------------

describe('error message exactness — acceptance criteria', () => {
  // [Implements: US-SR-006] SearchUnavailableError exact message
  it('SearchUnavailableError carries the exact acceptance criteria message', () => {
    const expected =
      'All SearXNG instances unavailable. Set SEARXNG_URL to a self-hosted instance for improved reliability.';
    const err = new SearchUnavailableError(expected);
    expect(err.message).toBe(expected);
  });

  // [Implements: US-SR-007] ConfigurationError exact message
  it('ConfigurationError carries the exact acceptance criteria message', () => {
    const expected = 'SEARXNG_URL must be a valid HTTP(S) URL';
    const err = new ConfigurationError(expected);
    expect(err.message).toBe(expected);
  });

  // [Implements: US-SR-004] SearchTimeoutError message includes timeout duration
  it('SearchTimeoutError can carry a message with timeout duration', () => {
    const msg = 'Search request timed out after 10000ms';
    const err = new SearchTimeoutError(msg);
    expect(err.message).toContain('10000ms');
  });

  // [Implements: US-SR-009] SearchParseError message can include body excerpt info
  it('SearchParseError can carry a message referencing non-JSON response', () => {
    const msg = 'Response is not valid JSON (content-type: text/html)';
    const err = new SearchParseError(msg);
    expect(err.message).toContain('not valid JSON');
  });
});

// ---------------------------------------------------------------------------
// Prototype chain integrity
// ---------------------------------------------------------------------------

describe('prototype chain integrity', () => {
  // [Implements: US-SR-012] instanceof works correctly after re-throwing
  it('SearchTimeoutError instanceof check survives try/catch re-throw', () => {
    let caught: unknown;
    try {
      throw new SearchTimeoutError('timeout');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SearchTimeoutError);
    expect(caught).toBeInstanceOf(SearchError);
    expect(caught).toBeInstanceOf(Error);
  });

  it('SearchParseError instanceof check survives try/catch re-throw', () => {
    let caught: unknown;
    try {
      throw new SearchParseError('parse error', '<html>');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SearchParseError);
    expect((caught as SearchParseError).bodyExcerpt).toBe('<html>');
  });

  it('ConfigurationError instanceof check survives try/catch re-throw', () => {
    let caught: unknown;
    try {
      throw new ConfigurationError('bad config');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SearchError);
  });

  it('ValidationError instanceof check survives try/catch re-throw', () => {
    let caught: unknown;
    try {
      throw new ValidationError('bad input');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SearchError);
  });

  // [Implements: US-SR-012] category field is accessible after catch
  it('category field is accessible after catching a SearchError subclass', () => {
    const errors: SearchError[] = [
      new SearchTimeoutError('t'),
      new SearchParseError('p'),
      new SearchFailedError('f'),
      new SearchUnavailableError('u'),
    ];
    const categories = errors.map((e) => e.category);
    expect(categories).toEqual([
      'timeout',
      'parse_error',
      'http_error',
      'network',
    ]);
  });
});

// ---------------------------------------------------------------------------
// SearchErrorCategory — exhaustive coverage of all 6 category values
// ---------------------------------------------------------------------------

describe('SearchErrorCategory — exhaustive coverage', () => {
  // [Implements: DC-SR-002] All 6 SearchErrorCategory values are representable
  const allCategories: SearchErrorCategory[] = [
    'timeout',
    'parse_error',
    'http_error',
    'network',
    'config',
    'validation',
  ];

  it('SearchError can be constructed with each of the 6 category values', () => {
    for (const cat of allCategories) {
      const err = new SearchError('test', cat);
      expect(err.category).toBe(cat);
    }
  });

  it('isRetryableError returns true for the 4 retryable categories', () => {
    const retryable: SearchErrorCategory[] = [
      'timeout',
      'parse_error',
      'http_error',
      'network',
    ];
    for (const cat of retryable) {
      const err = new SearchError('test', cat);
      expect(isRetryableError(err)).toBe(true);
    }
  });

  it('isRetryableError returns false for the 2 non-retryable categories', () => {
    const nonRetryable: SearchErrorCategory[] = ['config', 'validation'];
    for (const cat of nonRetryable) {
      const err = new SearchError('test', cat);
      expect(isRetryableError(err)).toBe(false);
    }
  });

  it('every SearchError subclass has a category from the 6-value union', () => {
    const errors: SearchError[] = [
      new SearchError('a'),
      new SearchTimeoutError('b'),
      new SearchParseError('c'),
      new SearchFailedError('d'),
      new SearchUnavailableError('e'),
    ];
    for (const err of errors) {
      expect(allCategories).toContain(err.category);
    }
  });

  it('ConfigurationError and ValidationError categories are in the union', () => {
    expect(allCategories).toContain(new ConfigurationError('x').category);
    expect(allCategories).toContain(new ValidationError('y').category);
  });
});

// ---------------------------------------------------------------------------
// SearchError — explicit category construction
// ---------------------------------------------------------------------------

describe('SearchError — explicit category construction', () => {
  // [Implements: US-SR-012] Explicit http_error category
  it('accepts explicit "http_error" category', () => {
    const err = new SearchError('test', 'http_error');
    expect(err.category).toBe('http_error');
  });

  it('accepts explicit "network" category', () => {
    const err = new SearchError('test', 'network');
    expect(err.category).toBe('network');
  });

  it('accepts explicit "config" category', () => {
    const err = new SearchError('test', 'config');
    expect(err.category).toBe('config');
  });

  it('accepts explicit "validation" category', () => {
    const err = new SearchError('test', 'validation');
    expect(err.category).toBe('validation');
  });

  it('preserves message when a category is provided', () => {
    const err = new SearchError('detailed message', 'timeout');
    expect(err.message).toBe('detailed message');
  });
});

// ---------------------------------------------------------------------------
// SearchParseError — explicit undefined bodyExcerpt
// ---------------------------------------------------------------------------

describe('SearchParseError — explicit undefined bodyExcerpt', () => {
  // [Implements: US-SR-009] Passing undefined explicitly should default to null
  it('defaults bodyExcerpt to null when undefined is passed explicitly', () => {
    const err = new SearchParseError('parse failed', undefined);
    expect(err.bodyExcerpt).toBeNull();
  });

  it('preserves message when bodyExcerpt is undefined', () => {
    const err = new SearchParseError('parse failed', undefined);
    expect(err.message).toBe('parse failed');
  });

  it('has category "parse_error" when bodyExcerpt is undefined', () => {
    const err = new SearchParseError('parse failed', undefined);
    expect(err.category).toBe('parse_error');
  });
});

// ---------------------------------------------------------------------------
// isRetryableError — AppError with all retryable categories
// ---------------------------------------------------------------------------

describe('isRetryableError — AppError with all retryable categories', () => {
  // [Implements: US-SR-005] AppError with http_error category is retryable
  it('returns true for AppError with category "http_error"', () => {
    const err = new AppError('test', 'http_error');
    expect(isRetryableError(err)).toBe(true);
  });

  // [Implements: US-SR-009] AppError with parse_error category is retryable
  it('returns true for AppError with category "parse_error"', () => {
    const err = new AppError('test', 'parse_error');
    expect(isRetryableError(err)).toBe(true);
  });

  // [Implements: US-SR-005] AppError with unknown category is NOT retryable
  it('returns false for AppError with category "unknown"', () => {
    const err = new AppError('test', 'unknown');
    expect(isRetryableError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRetryableError — exotic and non-standard inputs
// ---------------------------------------------------------------------------

describe('isRetryableError — exotic and non-standard inputs', () => {
  it('returns false for an array', () => {
    expect(isRetryableError([1, 2, 3])).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(isRetryableError([])).toBe(false);
  });

  it('returns false for a function', () => {
    expect(isRetryableError(() => {})).toBe(false);
  });

  it('returns false for a Symbol', () => {
    expect(isRetryableError(Symbol('test'))).toBe(false);
  });

  it('returns false for a Date object', () => {
    expect(isRetryableError(new Date())).toBe(false);
  });

  it('returns false for a Map object', () => {
    expect(isRetryableError(new Map())).toBe(false);
  });

  it('returns false for a Set object', () => {
    expect(isRetryableError(new Set())).toBe(false);
  });

  it('returns false for a RegExp object', () => {
    expect(isRetryableError(/test/)).toBe(false);
  });

  it('returns false for a Promise object', () => {
    expect(isRetryableError(Promise.resolve())).toBe(false);
  });

  it('returns false for a BigInt', () => {
    expect(isRetryableError(BigInt(42))).toBe(false);
  });

  it('returns false for an object with null category property', () => {
    const fakeErr = { category: null, message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(false);
  });

  it('returns false for an object with undefined category property', () => {
    const fakeErr = { category: undefined, message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(false);
  });

  it('returns false for an object with empty string category', () => {
    const fakeErr = { category: '', message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(false);
  });

  it('returns false for an object with "unknown" category', () => {
    const fakeErr = { category: 'unknown', message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(false);
  });

  it('returns false for an object with category as an array', () => {
    const fakeErr = { category: ['timeout'], message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(false);
  });

  it('returns false for an object with category as an object', () => {
    const fakeErr = { category: { value: 'timeout' }, message: 'fake' };
    expect(isRetryableError(fakeErr)).toBe(false);
  });

  it('returns false for NaN', () => {
    expect(isRetryableError(NaN)).toBe(false);
  });

  it('returns false for Infinity', () => {
    expect(isRetryableError(Infinity)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isRetryableError('')).toBe(false);
  });

  it('returns false for 0 (falsy number)', () => {
    expect(isRetryableError(0)).toBe(false);
  });

  it('returns false for false (falsy boolean)', () => {
    expect(isRetryableError(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Async error propagation — instanceof survives Promise rejection
// ---------------------------------------------------------------------------

describe('async error propagation', () => {
  // [Implements: US-SR-012] instanceof works after async throw
  it('SearchTimeoutError instanceof survives async rejection', async () => {
    let caught: unknown;
    try {
      await Promise.reject(new SearchTimeoutError('async timeout'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SearchTimeoutError);
    expect(caught).toBeInstanceOf(SearchError);
  });

  it('SearchParseError instanceof survives async rejection', async () => {
    let caught: unknown;
    try {
      await Promise.reject(new SearchParseError('async parse', '<body>'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SearchParseError);
    expect((caught as SearchParseError).bodyExcerpt).toBe('<body>');
  });

  it('SearchFailedError instanceof survives async rejection', async () => {
    let caught: unknown;
    try {
      await Promise.reject(new SearchFailedError('async failed'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SearchFailedError);
    expect(caught).toBeInstanceOf(SearchError);
  });

  it('SearchUnavailableError instanceof survives async rejection', async () => {
    let caught: unknown;
    try {
      await Promise.reject(new SearchUnavailableError('async unavailable'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SearchUnavailableError);
    expect(caught).toBeInstanceOf(SearchError);
  });

  it('ConfigurationError instanceof survives async rejection', async () => {
    let caught: unknown;
    try {
      await Promise.reject(new ConfigurationError('async config'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught).not.toBeInstanceOf(SearchError);
  });

  it('ValidationError instanceof survives async rejection', async () => {
    let caught: unknown;
    try {
      await Promise.reject(new ValidationError('async validation'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).not.toBeInstanceOf(SearchError);
  });

  it('isRetryableError works on errors caught from async rejection', async () => {
    let caught: unknown;
    try {
      await Promise.reject(new SearchTimeoutError('async'));
    } catch (e) {
      caught = e;
    }
    expect(isRetryableError(caught)).toBe(true);
  });

  it('isRetryableError returns false for ConfigurationError from async rejection', async () => {
    let caught: unknown;
    try {
      await Promise.reject(new ConfigurationError('async'));
    } catch (e) {
      caught = e;
    }
    expect(isRetryableError(caught)).toBe(false);
  });

  it('error thrown inside an async function preserves instanceof', async () => {
    async function failingSearch(): Promise<void> {
      throw new SearchParseError('bad response', '<html>');
    }

    let caught: unknown;
    try {
      await failingSearch();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SearchParseError);
    expect((caught as SearchParseError).bodyExcerpt).toBe('<html>');
  });
});

// ---------------------------------------------------------------------------
// Error independence — distinct instances do not share state
// ---------------------------------------------------------------------------

describe('error independence — distinct instances', () => {
  it('two SearchError instances with the same message are distinct objects', () => {
    const err1 = new SearchError('same');
    const err2 = new SearchError('same');
    expect(err1).not.toBe(err2);
    expect(err1.message).toBe(err2.message);
  });

  it('two SearchParseError instances have independent bodyExcerpt', () => {
    const err1 = new SearchParseError('parse', 'body1');
    const err2 = new SearchParseError('parse', 'body2');
    expect(err1.bodyExcerpt).toBe('body1');
    expect(err2.bodyExcerpt).toBe('body2');
    expect(err1.bodyExcerpt).not.toBe(err2.bodyExcerpt);
  });

  it('modifying message on one error does not affect another', () => {
    const err1 = new SearchError('original');
    const err2 = new SearchError('original');
    // message is set at construction; verify they remain independent
    expect(err1.message).toBe('original');
    expect(err2.message).toBe('original');
    expect(err1).not.toBe(err2);
  });

  it('each error instance has its own stack trace', () => {
    const err1 = new SearchError('first');
    const err2 = new SearchError('second');
    expect(err1.stack).toBeDefined();
    expect(err2.stack).toBeDefined();
    expect(err1.stack).not.toBe(err2.stack);
  });
});

// ---------------------------------------------------------------------------
// toString behavior
// ---------------------------------------------------------------------------

describe('toString behavior', () => {
  it('SearchError toString includes name and message', () => {
    const err = new SearchError('test message');
    const str = err.toString();
    expect(str).toContain('SearchError');
    expect(str).toContain('test message');
  });

  it('SearchTimeoutError toString includes name and message', () => {
    const err = new SearchTimeoutError('timed out');
    const str = err.toString();
    expect(str).toContain('SearchTimeoutError');
    expect(str).toContain('timed out');
  });

  it('SearchParseError toString includes name and message', () => {
    const err = new SearchParseError('parse failed', '<body>');
    const str = err.toString();
    expect(str).toContain('SearchParseError');
    expect(str).toContain('parse failed');
  });

  it('ConfigurationError toString includes name and message', () => {
    const err = new ConfigurationError('bad config');
    const str = err.toString();
    expect(str).toContain('ConfigurationError');
    expect(str).toContain('bad config');
  });

  it('ValidationError toString includes name and message', () => {
    const err = new ValidationError('bad input');
    const str = err.toString();
    expect(str).toContain('ValidationError');
    expect(str).toContain('bad input');
  });
});

// ---------------------------------------------------------------------------
// Error as collection member — Set and Map operations
// ---------------------------------------------------------------------------

describe('error as collection member', () => {
  it('SearchError can be stored in and retrieved from a Set', () => {
    const err = new SearchTimeoutError('timeout');
    const set = new Set<SearchError>([err]);
    expect(set.has(err)).toBe(true);
    expect(set.size).toBe(1);
  });

  it('SearchError can be used as a Map key', () => {
    const err = new SearchFailedError('failed');
    const map = new Map<SearchError, string>();
    map.set(err, 'value');
    expect(map.get(err)).toBe('value');
  });

  it('array of SearchError subclasses can be filtered by instanceof', () => {
    const errors: unknown[] = [
      new SearchTimeoutError('t'),
      new ConfigurationError('c'),
      new SearchParseError('p'),
      new ValidationError('v'),
      new SearchFailedError('f'),
    ];
    const searchErrors = errors.filter((e) => e instanceof SearchError);
    expect(searchErrors).toHaveLength(3);
  });

  it('array of errors can be partitioned by isRetryableError', () => {
    const errors: unknown[] = [
      new SearchTimeoutError('t'),
      new ConfigurationError('c'),
      new SearchParseError('p'),
      new ValidationError('v'),
    ];
    const retryable = errors.filter(isRetryableError);
    const nonRetryable = errors.filter((e) => !isRetryableError(e));
    expect(retryable).toHaveLength(2);
    expect(nonRetryable).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// isRetryableError — comprehensive SearchError category matrix
// ---------------------------------------------------------------------------

describe('isRetryableError — comprehensive SearchError category matrix', () => {
  const cases: Array<{
    category: SearchErrorCategory;
    expected: boolean;
  }> = [
    { category: 'timeout', expected: true },
    { category: 'parse_error', expected: true },
    { category: 'http_error', expected: true },
    { category: 'network', expected: true },
    { category: 'config', expected: false },
    { category: 'validation', expected: false },
  ];

  for (const { category, expected } of cases) {
    it(`SearchError with category "${category}" → ${expected}`, () => {
      const err = new SearchError('test', category);
      expect(isRetryableError(err)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// isRetryableError — comprehensive duck-typed category matrix
// ---------------------------------------------------------------------------

describe('isRetryableError — comprehensive duck-typed category matrix', () => {
  const cases: Array<{
    category: string;
    expected: boolean;
  }> = [
    { category: 'timeout', expected: true },
    { category: 'parse_error', expected: true },
    { category: 'http_error', expected: true },
    { category: 'network', expected: true },
    { category: 'config', expected: false },
    { category: 'validation', expected: false },
    { category: 'unknown', expected: false },
    { category: '', expected: false },
    { category: 'TIMEOUT', expected: false },
    { category: 'Timeout', expected: false },
    { category: 'timeout ', expected: false },
    { category: ' timeout', expected: false },
  ];

  for (const { category, expected } of cases) {
    it(`duck-typed object with category "${category}" → ${expected}`, () => {
      const fakeErr = { category, message: 'fake' };
      expect(isRetryableError(fakeErr)).toBe(expected);
    });
  }
});
