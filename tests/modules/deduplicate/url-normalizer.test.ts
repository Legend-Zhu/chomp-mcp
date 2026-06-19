/**
 * Tests for URL normalizer — covers all normalization rules:
 * tracking-param removal, scheme conversion, hostname lowercasing,
 * fragment removal, default port removal, trailing-slash removal,
 * query-param sorting, percent-encoding preservation, extra param
 * extensibility, and malformed URL error handling.
 *
 * [Spec: US-DD-001, US-DD-002]
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  TRACKING_PARAM_BLOCKLIST,
} from '../../../src/modules/deduplicate/url-normalizer.js';

// ---------------------------------------------------------------------------
// TRACKING_PARAM_BLOCKLIST constant
// ---------------------------------------------------------------------------

describe('TRACKING_PARAM_BLOCKLIST', () => {
  // [Implements: US-DD-001, DC-DD-006]
  it('contains all expected tracking param names', () => {
    expect(TRACKING_PARAM_BLOCKLIST).toContain('utm_source');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('utm_medium');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('utm_campaign');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('utm_content');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('utm_term');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('gclid');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('fbclid');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('mc_cid');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('mc_eid');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('ref');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('_hsenc');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('_hsmi');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('igshid');
    expect(TRACKING_PARAM_BLOCKLIST).toContain('si');
  });

  it('contains exactly 14 entries', () => {
    expect(TRACKING_PARAM_BLOCKLIST.length).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Tracking parameter removal
// ---------------------------------------------------------------------------

describe('tracking parameter removal', () => {
  // [Implements: US-DD-001] Each tracking param is removed
  it('removes utm_source', () => {
    expect(
      normalizeUrl('https://example.com?utm_source=google')
    ).toBe('https://example.com/');
  });

  it('removes utm_medium', () => {
    expect(
      normalizeUrl('https://example.com?utm_medium=cpc')
    ).toBe('https://example.com/');
  });

  it('removes utm_campaign', () => {
    expect(
      normalizeUrl('https://example.com?utm_campaign=spring')
    ).toBe('https://example.com/');
  });

  it('removes utm_content', () => {
    expect(
      normalizeUrl('https://example.com?utm_content=banner')
    ).toBe('https://example.com/');
  });

  it('removes utm_term', () => {
    expect(
      normalizeUrl('https://example.com?utm_term=shoes')
    ).toBe('https://example.com/');
  });

  it('removes gclid', () => {
    expect(
      normalizeUrl('https://example.com?gclid=abc123')
    ).toBe('https://example.com/');
  });

  it('removes fbclid', () => {
    expect(
      normalizeUrl('https://example.com?fbclid=xyz789')
    ).toBe('https://example.com/');
  });

  it('removes mc_cid', () => {
    expect(
      normalizeUrl('https://example.com?mc_cid=newsletter1')
    ).toBe('https://example.com/');
  });

  it('removes mc_eid', () => {
    expect(
      normalizeUrl('https://example.com?mc_eid=user42')
    ).toBe('https://example.com/');
  });

  it('removes ref', () => {
    expect(
      normalizeUrl('https://example.com?ref=homepage')
    ).toBe('https://example.com/');
  });

  it('removes _hsenc', () => {
    expect(
      normalizeUrl('https://example.com?_hsenc=encoded1')
    ).toBe('https://example.com/');
  });

  it('removes _hsmi', () => {
    expect(
      normalizeUrl('https://example.com?_hsmi=message2')
    ).toBe('https://example.com/');
  });

  it('removes igshid', () => {
    expect(
      normalizeUrl('https://example.com?igshid=post123')
    ).toBe('https://example.com/');
  });

  it('removes si', () => {
    expect(
      normalizeUrl('https://example.com?si=token456')
    ).toBe('https://example.com/');
  });

  // [Implements: US-DD-001] Multiple tracking params removed at once
  it('removes multiple tracking params', () => {
    expect(
      normalizeUrl(
        'https://example.com?utm_source=google&utm_medium=cpc&fbclid=abc&gclid=xyz'
      )
    ).toBe('https://example.com/');
  });

  // [Implements: US-DD-001] Case-insensitive matching
  it('removes tracking params case-insensitively (uppercase)', () => {
    expect(
      normalizeUrl('https://example.com?UTM_SOURCE=google')
    ).toBe('https://example.com/');
  });

  it('removes tracking params case-insensitively (mixed case)', () => {
    expect(
      normalizeUrl('https://example.com?Utm_Source=google')
    ).toBe('https://example.com/');
  });

  it('removes tracking params case-insensitively (UTM_Medium)', () => {
    expect(
      normalizeUrl('https://example.com?UTM_Medium=cpc')
    ).toBe('https://example.com/');
  });

  it('removes FBCLID regardless of case', () => {
    expect(
      normalizeUrl('https://example.com?FBCLID=abc')
    ).toBe('https://example.com/');
  });

  it('removes REF regardless of case', () => {
    expect(
      normalizeUrl('https://example.com?REF=homepage')
    ).toBe('https://example.com/');
  });

  it('removes SI regardless of case', () => {
    expect(
      normalizeUrl('https://example.com?SI=token')
    ).toBe('https://example.com/');
  });

  // [Implements: US-DD-001] Tracking params removed, non-tracking preserved
  it('removes tracking param while preserving non-tracking param', () => {
    expect(
      normalizeUrl('https://example.com?utm_source=google&q=test')
    ).toBe('https://example.com/?q=test');
  });

  it('removes tracking param with path', () => {
    expect(
      normalizeUrl('https://example.com/page?utm_source=google')
    ).toBe('https://example.com/page');
  });
});

// ---------------------------------------------------------------------------
// Non-tracking parameter preservation
// ---------------------------------------------------------------------------

describe('non-tracking parameter preservation', () => {
  // [Implements: US-DD-001] Non-tracking params are preserved
  it('preserves a non-tracking parameter', () => {
    expect(
      normalizeUrl('https://example.com?q=test')
    ).toBe('https://example.com/?q=test');
  });

  it('preserves multiple non-tracking parameters', () => {
    expect(
      normalizeUrl('https://example.com?a=1&b=2')
    ).toBe('https://example.com/?a=1&b=2');
  });

  it('preserves non-tracking param when mixed with tracking params', () => {
    expect(
      normalizeUrl(
        'https://example.com?utm_source=google&page=3&q=hello'
      )
    ).toBe('https://example.com/?page=3&q=hello');
  });

  it('preserves param with empty value', () => {
    expect(
      normalizeUrl('https://example.com?empty=')
    ).toBe('https://example.com/?empty=');
  });

  it('preserves param name that is a substring of a tracking param', () => {
    // 'ref' is a tracking param, but 'refresh' should be preserved
    expect(
      normalizeUrl('https://example.com?refresh=true')
    ).toBe('https://example.com/?refresh=true');
  });

  it('preserves param name that starts with tracking prefix', () => {
    // 'utm_source' is tracking, but 'utm_custom' is not
    expect(
      normalizeUrl('https://example.com?utm_custom=value')
    ).toBe('https://example.com/?utm_custom=value');
  });

  it('preserves numeric param values', () => {
    expect(
      normalizeUrl('https://example.com?page=42')
    ).toBe('https://example.com/?page=42');
  });

  it('preserves special chars in param values', () => {
    expect(
      normalizeUrl('https://example.com?q=hello-world_test')
    ).toBe('https://example.com/?q=hello-world_test');
  });

  it('preserves non-tracking params on non-root path', () => {
    expect(
      normalizeUrl('https://example.com/api/data?id=123')
    ).toBe('https://example.com/api/data?id=123');
  });
});

// ---------------------------------------------------------------------------
// All params removed → no trailing ?
// ---------------------------------------------------------------------------

describe('all params removed produces no trailing ?', () => {
  // [Implements: US-DD-001] No trailing ? when all params are tracking
  it('produces no trailing ? when all params are tracking', () => {
    const result = normalizeUrl(
      'https://example.com?utm_source=google&utm_medium=cpc'
    );
    expect(result).toBe('https://example.com/');
    expect(result).not.toMatch(/\?$/);
  });

  it('produces no trailing ? when single tracking param removed', () => {
    const result = normalizeUrl('https://example.com?gclid=abc');
    expect(result).toBe('https://example.com/');
    expect(result).not.toMatch(/\?$/);
  });

  it('produces no trailing ? on non-root path', () => {
    const result = normalizeUrl(
      'https://example.com/page?utm_source=x&utm_medium=y'
    );
    expect(result).toBe('https://example.com/page');
    expect(result).not.toMatch(/\?$/);
  });

  it('produces no trailing ? with extra tracking params', () => {
    const result = normalizeUrl(
      'https://example.com?custom_track=1&other_track=2',
      ['custom_track', 'other_track']
    );
    expect(result).toBe('https://example.com/');
    expect(result).not.toMatch(/\?$/);
  });
});

// ---------------------------------------------------------------------------
// HTTP → HTTPS scheme conversion
// ---------------------------------------------------------------------------

describe('HTTP to HTTPS scheme conversion', () => {
  // [Implements: US-DD-002] http → https
  it('converts http to https', () => {
    expect(
      normalizeUrl('http://example.com/path')
    ).toBe('https://example.com/path');
  });

  it('converts http root to https root', () => {
    expect(
      normalizeUrl('http://example.com')
    ).toBe('https://example.com/');
  });

  it('converts http with query params to https', () => {
    expect(
      normalizeUrl('http://example.com/page?q=test')
    ).toBe('https://example.com/page?q=test');
  });

  it('keeps https as https', () => {
    expect(
      normalizeUrl('https://example.com/path')
    ).toBe('https://example.com/path');
  });

  it('converts http with subdomain', () => {
    expect(
      normalizeUrl('http://blog.example.com/post')
    ).toBe('https://blog.example.com/post');
  });

  it('converts http with port', () => {
    expect(
      normalizeUrl('http://example.com:8080/path')
    ).toBe('https://example.com:8080/path');
  });

  it('converts http with tracking params', () => {
    expect(
      normalizeUrl('http://example.com?utm_source=x&q=test')
    ).toBe('https://example.com/?q=test');
  });
});

// ---------------------------------------------------------------------------
// Hostname lowercasing
// ---------------------------------------------------------------------------

describe('hostname lowercasing', () => {
  // [Implements: US-DD-002] Lowercase hostname
  it('lowercases uppercase hostname', () => {
    expect(
      normalizeUrl('http://EXAMPLE.COM/path')
    ).toBe('https://example.com/path');
  });

  it('lowercases mixed-case hostname', () => {
    expect(
      normalizeUrl('https://Example.Com/page')
    ).toBe('https://example.com/page');
  });

  it('lowercases hostname with subdomain', () => {
    expect(
      normalizeUrl('https://WWW.Example.COM/page')
    ).toBe('https://www.example.com/page');
  });

  it('preserves already-lowercase hostname', () => {
    expect(
      normalizeUrl('https://example.com/page')
    ).toBe('https://example.com/page');
  });

  it('lowercases hostname with path and query', () => {
    expect(
      normalizeUrl('http://API.Website.IO/endpoint?id=5')
    ).toBe('https://api.website.io/endpoint?id=5');
  });
});

// ---------------------------------------------------------------------------
// Fragment removal
// ---------------------------------------------------------------------------

describe('fragment removal', () => {
  // [Implements: US-DD-002] Remove fragment identifier
  it('removes fragment from URL', () => {
    expect(
      normalizeUrl('https://example.com/page#section')
    ).toBe('https://example.com/page');
  });

  it('removes fragment from root path', () => {
    expect(
      normalizeUrl('https://example.com#top')
    ).toBe('https://example.com/');
  });

  it('removes empty fragment', () => {
    expect(
      normalizeUrl('https://example.com/page#')
    ).toBe('https://example.com/page');
  });

  it('removes fragment with query params', () => {
    expect(
      normalizeUrl('https://example.com/page?q=test#section')
    ).toBe('https://example.com/page?q=test');
  });

  it('removes fragment from http URL', () => {
    expect(
      normalizeUrl('http://example.com/page#section')
    ).toBe('https://example.com/page');
  });

  it('removes long fragment', () => {
    expect(
      normalizeUrl('https://example.com/page#/some/deep/nested/route')
    ).toBe('https://example.com/page');
  });

  it('preserves URL without fragment', () => {
    expect(
      normalizeUrl('https://example.com/page')
    ).toBe('https://example.com/page');
  });
});

// ---------------------------------------------------------------------------
// Default port removal
// ---------------------------------------------------------------------------

describe('default port removal', () => {
  // [Implements: US-DD-002] Remove default port 80 for http
  it('removes default port 80 from http URL', () => {
    expect(
      normalizeUrl('http://example.com:80/path')
    ).toBe('https://example.com/path');
  });

  // [Implements: US-DD-002] Remove default port 443 for https
  it('removes default port 443 from https URL', () => {
    expect(
      normalizeUrl('https://example.com:443/path')
    ).toBe('https://example.com/path');
  });

  it('removes default port 80 from http root', () => {
    expect(
      normalizeUrl('http://example.com:80')
    ).toBe('https://example.com/');
  });

  it('removes default port 443 from https root', () => {
    expect(
      normalizeUrl('https://example.com:443')
    ).toBe('https://example.com/');
  });

  // Edge case: http with port 443 (default for https but not http)
  // After protocol conversion to https, port 443 becomes default
  it('removes port 443 from http URL after converting to https', () => {
    expect(
      normalizeUrl('http://example.com:443/path')
    ).toBe('https://example.com/path');
  });

  it('preserves non-default port 8080 from http URL', () => {
    expect(
      normalizeUrl('http://example.com:8080/path')
    ).toBe('https://example.com:8080/path');
  });

  it('preserves non-default port 8443 from https URL', () => {
    expect(
      normalizeUrl('https://example.com:8443/path')
    ).toBe('https://example.com:8443/path');
  });

  it('preserves non-default port 3000', () => {
    expect(
      normalizeUrl('http://localhost:3000/api')
    ).toBe('https://localhost:3000/api');
  });

  it('removes default port with tracking params', () => {
    expect(
      normalizeUrl('https://example.com:443/page?q=test&utm_source=x')
    ).toBe('https://example.com/page?q=test');
  });

  it('removes default port from URL with fragment', () => {
    expect(
      normalizeUrl('https://example.com:443/page#section')
    ).toBe('https://example.com/page');
  });

  it('removes default port with uppercase hostname', () => {
    expect(
      normalizeUrl('http://EXAMPLE.COM:80/page')
    ).toBe('https://example.com/page');
  });
});

// ---------------------------------------------------------------------------
// Trailing slash removal
// ---------------------------------------------------------------------------

describe('trailing slash removal', () => {
  // [Implements: US-DD-002] Remove trailing slash when path length > 1
  it('removes trailing slash from path', () => {
    expect(
      normalizeUrl('https://example.com/path/')
    ).toBe('https://example.com/path');
  });

  it('removes trailing slash from nested path', () => {
    expect(
      normalizeUrl('https://example.com/path/to/page/')
    ).toBe('https://example.com/path/to/page');
  });

  it('removes trailing slash from deep path', () => {
    expect(
      normalizeUrl('https://example.com/a/b/c/d/')
    ).toBe('https://example.com/a/b/c/d');
  });

  // [Implements: US-DD-002] Root path "/" (length 1) keeps its slash
  it('preserves trailing slash on root path', () => {
    expect(
      normalizeUrl('https://example.com/')
    ).toBe('https://example.com/');
  });

  it('preserves single slash for URL without path', () => {
    expect(
      normalizeUrl('https://example.com')
    ).toBe('https://example.com/');
  });

  it('removes trailing slash with query params', () => {
    expect(
      normalizeUrl('https://example.com/page/?q=test')
    ).toBe('https://example.com/page?q=test');
  });

  it('removes trailing slash with fragment', () => {
    expect(
      normalizeUrl('https://example.com/page/#section')
    ).toBe('https://example.com/page');
  });

  it('does not add trailing slash when path has none', () => {
    expect(
      normalizeUrl('https://example.com/path')
    ).toBe('https://example.com/path');
  });

  it('removes only one trailing slash', () => {
    // Double trailing slash: path is "//" → length > 1 → remove one → "/"
    expect(
      normalizeUrl('https://example.com//')
    ).toBe('https://example.com/');
  });

  it('removes trailing slash from http URL', () => {
    expect(
      normalizeUrl('http://example.com/page/')
    ).toBe('https://example.com/page');
  });
});

// ---------------------------------------------------------------------------
// Query parameter sorting
// ---------------------------------------------------------------------------

describe('query parameter sorting', () => {
  // [Implements: US-DD-001] Sort remaining params alphabetically by key
  it('sorts query params alphabetically', () => {
    expect(
      normalizeUrl('https://example.com?z=3&a=1&m=2')
    ).toBe('https://example.com/?a=1&m=2&z=3');
  });

  it('sorts params in reverse order', () => {
    expect(
      normalizeUrl('https://example.com?c=3&b=2&a=1')
    ).toBe('https://example.com/?a=1&b=2&c=3');
  });

  it('sorts params with tracking params removed first', () => {
    expect(
      normalizeUrl('https://example.com?z=3&utm_source=x&a=1')
    ).toBe('https://example.com/?a=1&z=3');
  });

  it('sorts params after removing multiple tracking params', () => {
    expect(
      normalizeUrl(
        'https://example.com?utm_source=x&page=5&fbclid=y&category=news'
      )
    ).toBe('https://example.com/?category=news&page=5');
  });

  it('preserves relative order of duplicate keys after sort', () => {
    expect(
      normalizeUrl('https://example.com?z=3&a=1&a=2&m=4')
    ).toBe('https://example.com/?a=1&a=2&m=4&z=3');
  });

  it('sorts params with numeric string keys', () => {
    expect(
      normalizeUrl('https://example.com?3=c&1=a&2=b')
    ).toBe('https://example.com/?1=a&2=b&3=c');
  });

  it('sorts params with underscore keys', () => {
    expect(
      normalizeUrl('https://example.com?_b=2&_a=1')
    ).toBe('https://example.com/?_a=1&_b=2');
  });

  it('sorts params after tracking param removal with path', () => {
    expect(
      normalizeUrl('https://example.com/page?z=3&utm_source=x&a=1')
    ).toBe('https://example.com/page?a=1&z=3');
  });

  it('sorts already-sorted params (no change)', () => {
    expect(
      normalizeUrl('https://example.com?a=1&b=2&c=3')
    ).toBe('https://example.com/?a=1&b=2&c=3');
  });

  it('sorts single param (no change)', () => {
    expect(
      normalizeUrl('https://example.com?q=test')
    ).toBe('https://example.com/?q=test');
  });
});

// ---------------------------------------------------------------------------
// Percent-encoding preservation
// ---------------------------------------------------------------------------

describe('percent-encoding preservation', () => {
  // [Implements: US-DD-002] Preserve percent-encoding in path
  it('preserves percent-encoded spaces in path', () => {
    expect(
      normalizeUrl('https://example.com/path%20with%20spaces')
    ).toBe('https://example.com/path%20with%20spaces');
  });

  it('preserves percent-encoded spaces with trailing slash', () => {
    expect(
      normalizeUrl('https://example.com/path%20with%20spaces/')
    ).toBe('https://example.com/path%20with%20spaces');
  });

  it('preserves percent-encoded special characters in path', () => {
    expect(
      normalizeUrl('https://example.com/file%2Bname')
    ).toBe('https://example.com/file%2Bname');
  });

  it('preserves percent-encoded question mark in path', () => {
    expect(
      normalizeUrl('https://example.com/path%3Fquery')
    ).toBe('https://example.com/path%3Fquery');
  });

  it('preserves percent-encoded hash in path', () => {
    expect(
      normalizeUrl('https://example.com/path%23anchor')
    ).toBe('https://example.com/path%23anchor');
  });

  it('does not double-decode already encoded sequences', () => {
    // %2520 should stay as %2520 (not decoded to %20 or space)
    expect(
      normalizeUrl('https://example.com/path%2520encoded')
    ).toBe('https://example.com/path%2520encoded');
  });

  it('preserves percent-encoding with query params', () => {
    expect(
      normalizeUrl('https://example.com/path%20here?q=test')
    ).toBe('https://example.com/path%20here?q=test');
  });

  it('preserves percent-encoding in nested path segments', () => {
    expect(
      normalizeUrl('https://example.com/a%20b/c%20d/e%20f')
    ).toBe('https://example.com/a%20b/c%20d/e%20f');
  });

  it('preserves percent-encoding after trailing slash removal', () => {
    expect(
      normalizeUrl('https://example.com/encoded%20path/')
    ).toBe('https://example.com/encoded%20path');
  });

  it('preserves percent-encoding with http scheme conversion', () => {
    expect(
      normalizeUrl('http://example.com/path%20here')
    ).toBe('https://example.com/path%20here');
  });

  it('preserves Unicode percent-encoding in path', () => {
    expect(
      normalizeUrl('https://example.com/path/Caf%C3%A9')
    ).toBe('https://example.com/path/Caf%C3%A9');
  });
});

// ---------------------------------------------------------------------------
// Mixed tracking and non-tracking params
// ---------------------------------------------------------------------------

describe('mixed tracking and non-tracking params', () => {
  // [Implements: US-DD-001] Mixed scenario
  it('removes tracking params and sorts non-tracking params', () => {
    expect(
      normalizeUrl(
        'https://example.com?utm_source=google&page=2&fbclid=abc&q=test&gclid=xyz'
      )
    ).toBe('https://example.com/?page=2&q=test');
  });

  it('removes all UTM params, preserves others', () => {
    expect(
      normalizeUrl(
        'https://example.com?utm_source=a&utm_medium=b&utm_campaign=c&utm_content=d&utm_term=e&keep=1'
      )
    ).toBe('https://example.com/?keep=1');
  });

  it('removes tracking params with non-tracking params interspersed', () => {
    expect(
      normalizeUrl(
        'https://example.com?keep1=a&utm_source=b&keep2=c&fbclid=d&keep3=e'
      )
    ).toBe('https://example.com/?keep1=a&keep2=c&keep3=e');
  });

  it('removes all tracking params, no non-tracking left', () => {
    expect(
      normalizeUrl(
        'https://example.com?utm_source=a&fbclid=b&gclid=c&mc_cid=d&mc_eid=e'
      )
    ).toBe('https://example.com/');
  });

  it('removes tracking params with path and fragment', () => {
    expect(
      normalizeUrl(
        'https://example.com/page?q=test&utm_source=x#section'
      )
    ).toBe('https://example.com/page?q=test');
  });

  it('removes tracking params with uppercase hostname and http scheme', () => {
    expect(
      normalizeUrl(
        'http://SITE.COM/page?utm_source=x&keep=1'
      )
    ).toBe('https://site.com/page?keep=1');
  });

  it('removes mixed-case tracking params', () => {
    expect(
      normalizeUrl(
        'https://example.com?UTM_SOURCE=x&FBCLID=y&keep=z'
      )
    ).toBe('https://example.com/?keep=z');
  });

  it('removes tracking params preserving duplicate non-tracking keys', () => {
    expect(
      normalizeUrl(
        'https://example.com?utm_source=x&tag=a&tag=b'
      )
    ).toBe('https://example.com/?tag=a&tag=b');
  });
});

// ---------------------------------------------------------------------------
// Extra tracking params extensibility
// ---------------------------------------------------------------------------

describe('extra tracking params extensibility', () => {
  // [Implements: US-DD-001, DC-DD-006] Extra params are stripped
  it('removes extra tracking param not in built-in blocklist', () => {
    expect(
      normalizeUrl('https://example.com?custom_track=abc&keep=1', [
        'custom_track',
      ])
    ).toBe('https://example.com/?keep=1');
  });

  it('removes multiple extra tracking params', () => {
    expect(
      normalizeUrl('https://example.com?extra1=a&extra2=b&keep=1', [
        'extra1',
        'extra2',
      ])
    ).toBe('https://example.com/?keep=1');
  });

  it('merges extra tracking params with built-in blocklist', () => {
    expect(
      normalizeUrl(
        'https://example.com?utm_source=x&custom=y&keep=1',
        ['custom']
      )
    ).toBe('https://example.com/?keep=1');
  });

  it('removes extra tracking param case-insensitively', () => {
    expect(
      normalizeUrl('https://example.com?Custom_Track=abc&keep=1', [
        'custom_track',
      ])
    ).toBe('https://example.com/?keep=1');
  });

  it('removes extra tracking param when param is uppercase and extra is lowercase', () => {
    expect(
      normalizeUrl('https://example.com?MY_PARAM=abc&keep=1', [
        'my_param',
      ])
    ).toBe('https://example.com/?keep=1');
  });

  it('does not remove non-listed extra params', () => {
    expect(
      normalizeUrl('https://example.com?param1=a&param2=b', [
        'param1',
      ])
    ).toBe('https://example.com/?param2=b');
  });

  it('removes all params when extras cover everything', () => {
    expect(
      normalizeUrl('https://example.com?a=1&b=2', ['a', 'b'])
    ).toBe('https://example.com/');
  });

  it('handles empty extra tracking params array', () => {
    expect(
      normalizeUrl('https://example.com?q=test&keep=1', [])
    ).toBe('https://example.com/?keep=1&q=test');
  });

  it('handles undefined extra tracking params', () => {
    expect(
      normalizeUrl('https://example.com?q=test&keep=1', undefined)
    ).toBe('https://example.com/?keep=1&q=test');
  });

  it('removes extra param with same name as a non-tracking param pattern', () => {
    // 'yclid' is not in the built-in blocklist but is added as extra
    expect(
      normalizeUrl('https://example.com?yclid=abc&keep=1', ['yclid'])
    ).toBe('https://example.com/?keep=1');
  });

  it('combines built-in and extra blocklists without removing legitimate params', () => {
    expect(
      normalizeUrl(
        'https://example.com?utm_source=x&ref=y&tracking=z&id=123',
        ['tracking']
      )
    ).toBe('https://example.com/?id=123');
  });
});

// ---------------------------------------------------------------------------
// Malformed URL error handling
// ---------------------------------------------------------------------------

describe('malformed URL error handling', () => {
  // [Implements: US-DD-002] Malformed URLs throw TypeError
  it('throws TypeError for empty string', () => {
    expect(() => normalizeUrl('')).toThrow(TypeError);
  });

  it('throws TypeError for plain text without scheme', () => {
    expect(() => normalizeUrl('not a url')).toThrow(TypeError);
  });

  it('throws TypeError for domain without scheme', () => {
    expect(() => normalizeUrl('example.com/path')).toThrow(TypeError);
  });

  it('throws TypeError for scheme without host', () => {
    expect(() => normalizeUrl('https://')).toThrow(TypeError);
  });

  it('throws TypeError for missing scheme separator', () => {
    expect(() => normalizeUrl('http//example.com')).toThrow(TypeError);
  });

  it('throws TypeError for whitespace-only string', () => {
    expect(() => normalizeUrl('   ')).toThrow(TypeError);
  });

  it('throws TypeError for malformed port', () => {
    expect(() =>
      normalizeUrl('https://example.com:abc/path')
    ).toThrow(TypeError);
  });

  it('throws TypeError for spaces in URL', () => {
    expect(() =>
      normalizeUrl('https://example.com /path')
    ).toThrow(TypeError);
  });

  it('throws TypeError for protocol-relative URL without base', () => {
    expect(() => normalizeUrl('//example.com/path')).toThrow(TypeError);
  });

  it('throws TypeError for null-like values coerced to string', () => {
    // @ts-expect-error — testing invalid input type
    expect(() => normalizeUrl(null)).toThrow();
  });

  it('throws TypeError for undefined coerced to string', () => {
    // @ts-expect-error — testing invalid input type
    expect(() => normalizeUrl(undefined)).toThrow(TypeError);
  });

  it('throws for number input', () => {
    // @ts-expect-error — testing invalid input type
    expect(() => normalizeUrl(12345)).toThrow(TypeError);
  });

  it('throws TypeError for scheme-only string', () => {
    expect(() => normalizeUrl('https:')).toThrow(TypeError);
  });

  it('throws TypeError for colon-only string', () => {
    expect(() => normalizeUrl(':')).toThrow(TypeError);
  });

  it('throws TypeError for unclosed brackets in hostname', () => {
    expect(() =>
      normalizeUrl('https://[::1/path')
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Combined transformations
// ---------------------------------------------------------------------------

describe('combined transformations', () => {
  // [Implements: US-DD-001, US-DD-002] All rules applied simultaneously
  it('applies scheme, hostname, port, fragment, trailing slash, tracking, sorting', () => {
    expect(
      normalizeUrl(
        'http://EXAMPLE.COM:80/path/?utm_source=google&z=3&a=1&fbclid=abc#section'
      )
    ).toBe('https://example.com/path?a=1&z=3');
  });

  it('normalizes complex URL with all transformations', () => {
    expect(
      normalizeUrl(
        'HTTP://API.Site.org:443/search?query=test&utm_campaign=spring&page=2&sort=desc&ref=nav#results'
      )
    ).toBe('https://api.site.org/search?page=2&query=test&sort=desc');
  });

  it('normalizes URL with https default port, fragment, and trailing slash', () => {
    expect(
      normalizeUrl('https://example.com:443/page/?id=42#top')
    ).toBe('https://example.com/page?id=42');
  });

  it('normalizes URL with http port 443, tracking params, and uppercase host', () => {
    expect(
      normalizeUrl(
        'http://SITE.com:443/article?utm_medium=cpc&title=hello&fbclid=xyz'
      )
    ).toBe('https://site.com/article?title=hello');
  });

  it('normalizes URL with all tracking params removed and no path', () => {
    expect(
      normalizeUrl(
        'http://EXAMPLE.NET:80?utm_source=a&utm_medium=b#gclid=not-a-real-param'
      )
    ).toBe('https://example.net/');
  });

  it('preserves non-default port through all transformations', () => {
    expect(
      normalizeUrl(
        'http://Example.COM:3000/api/data?utm_source=x&id=99#anchor'
      )
    ).toBe('https://example.com:3000/api/data?id=99');
  });

  it('applies extra tracking params alongside built-in blocklist', () => {
    expect(
      normalizeUrl(
        'http://Test.IO:80/page?utm_source=a&custom=b&keep=1&zzz=2#frag',
        ['custom']
      )
    ).toBe('https://test.io/page?keep=1&zzz=2');
  });

  it('normalizes already-clean URL without changes', () => {
    expect(
      normalizeUrl('https://example.com/page?a=1&b=2')
    ).toBe('https://example.com/page?a=1&b=2');
  });

  it('normalizes root URL with only tracking params', () => {
    expect(
      normalizeUrl('http://example.com:80/?utm_source=all')
    ).toBe('https://example.com/');
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  // [Implements: US-DD-002] Normalizing an already-normalized URL yields the same result
  it('is idempotent for simple URL', () => {
    const input = 'https://example.com/page';
    const once = normalizeUrl(input);
    const twice = normalizeUrl(once);
    expect(twice).toBe(once);
  });

  it('is idempotent for URL with sorted query params', () => {
    const input = 'https://example.com/page?a=1&b=2&c=3';
    const once = normalizeUrl(input);
    const twice = normalizeUrl(once);
    expect(twice).toBe(once);
  });

  it('is idempotent for URL with percent-encoded path', () => {
    const input = 'https://example.com/path%20here?q=test';
    const once = normalizeUrl(input);
    const twice = normalizeUrl(once);
    expect(twice).toBe(once);
  });

  it('is idempotent for URL with non-default port', () => {
    const input = 'https://example.com:8080/api?id=1';
    const once = normalizeUrl(input);
    const twice = normalizeUrl(once);
    expect(twice).toBe(once);
  });

  it('is idempotent for complex normalized URL', () => {
    const input =
      'https://example.com/path?a=1&z=3';
    const once = normalizeUrl(input);
    const twice = normalizeUrl(once);
    expect(twice).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// Query parameter value encoding (URLSearchParams re-encoding)
// ---------------------------------------------------------------------------

describe('query parameter value encoding', () => {
  // [Implements: US-DD-002] Path encoding is preserved, query values are
  // re-encoded by URLSearchParams — %20 (encoded space) becomes +
  it('normalizes %20 (encoded space) to + in query param values', () => {
    expect(
      normalizeUrl('https://example.com?q=hello%20world')
    ).toBe('https://example.com/?q=hello+world');
  });

  it('preserves + as space encoding in query param values', () => {
    expect(
      normalizeUrl('https://example.com?q=hello+world')
    ).toBe('https://example.com/?q=hello+world');
  });

  it('is idempotent for space encoding in query values', () => {
    const once = normalizeUrl('https://example.com?q=hello%20world');
    const twice = normalizeUrl(once);
    expect(twice).toBe(once);
  });

  it('preserves encoded ampersand in query param values', () => {
    expect(
      normalizeUrl('https://example.com?q=a%26b')
    ).toBe('https://example.com/?q=a%26b');
  });

  it('preserves encoded equals sign in query param values', () => {
    expect(
      normalizeUrl('https://example.com?q=a%3Db')
    ).toBe('https://example.com/?q=a%3Db');
  });

  it('preserves encoded plus sign in query param values', () => {
    // %2B is an encoded + — round-trips as %2B (not decoded to space)
    expect(
      normalizeUrl('https://example.com?q=a%2Bb')
    ).toBe('https://example.com/?q=a%2Bb');
  });

  it('re-encodes = sign in multi-equals param value', () => {
    // a=b=c → key=a, value=b=c → re-encoded as a=b%3Dc
    expect(
      normalizeUrl('https://example.com?a=b=c')
    ).toBe('https://example.com/?a=b%3Dc');
  });

  it('preserves encoded query values through tracking param removal', () => {
    expect(
      normalizeUrl('https://example.com?utm_source=x&q=hello%20world')
    ).toBe('https://example.com/?q=hello+world');
  });

  it('re-encodes query values through sorting', () => {
    expect(
      normalizeUrl('https://example.com?b=hello%20world&a=test')
    ).toBe('https://example.com/?a=test&b=hello+world');
  });
});

// ---------------------------------------------------------------------------
// Valueless parameters
// ---------------------------------------------------------------------------

describe('valueless parameters', () => {
  // [Implements: US-DD-001] Param without = is treated as empty value
  it('treats param without = as empty value', () => {
    expect(
      normalizeUrl('https://example.com?flag')
    ).toBe('https://example.com/?flag=');
  });

  it('sorts valueless param alongside valued params', () => {
    expect(
      normalizeUrl('https://example.com?z=1&flag&a=2')
    ).toBe('https://example.com/?a=2&flag=&z=1');
  });

  it('preserves valueless param when removing tracking params', () => {
    expect(
      normalizeUrl('https://example.com?utm_source=x&flag')
    ).toBe('https://example.com/?flag=');
  });

  it('removes valueless tracking param', () => {
    expect(
      normalizeUrl('https://example.com?utm_source&keep=1')
    ).toBe('https://example.com/?keep=1');
  });

  it('removes valueless extra tracking param', () => {
    expect(
      normalizeUrl('https://example.com?custom&keep=1', ['custom'])
    ).toBe('https://example.com/?keep=1');
  });

  it('handles multiple valueless params with sorting', () => {
    expect(
      normalizeUrl('https://example.com?zebra&apple&mango')
    ).toBe('https://example.com/?apple=&mango=&zebra=');
  });
});

// ---------------------------------------------------------------------------
// Mixed-case key sorting (ASCII lexicographic order)
// ---------------------------------------------------------------------------

describe('mixed-case key sorting (ASCII order)', () => {
  // [Implements: US-DD-001] ASCII: uppercase (65-90) sorts before lowercase (97-122)
  it('sorts uppercase keys before lowercase keys', () => {
    expect(
      normalizeUrl('https://example.com?banana=2&Apple=1')
    ).toBe('https://example.com/?Apple=1&banana=2');
  });

  it('sorts multiple mixed-case keys', () => {
    expect(
      normalizeUrl('https://example.com?banana=2&Apple=1&cherry=3')
    ).toBe('https://example.com/?Apple=1&banana=2&cherry=3');
  });

  it('sorts uppercase Z before lowercase a', () => {
    expect(
      normalizeUrl('https://example.com?apple=2&Zebra=1')
    ).toBe('https://example.com/?Zebra=1&apple=2');
  });

  it('sorts all-uppercase keys alphabetically', () => {
    expect(
      normalizeUrl('https://example.com?C=3&A=1&B=2')
    ).toBe('https://example.com/?A=1&B=2&C=3');
  });

  it('sorts uppercase group before lowercase group', () => {
    expect(
      normalizeUrl('https://example.com?c=3&a=1&B=2&A=0&b=0')
    ).toBe('https://example.com/?A=0&B=2&a=1&b=0&c=3');
  });

  it('is idempotent for mixed-case key sorting', () => {
    const once = normalizeUrl('https://example.com?banana=2&Apple=1');
    const twice = normalizeUrl(once);
    expect(twice).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// URL with credentials
// ---------------------------------------------------------------------------

describe('URL with credentials', () => {
  it('preserves username and password', () => {
    expect(
      normalizeUrl('https://user:pass@example.com/path')
    ).toBe('https://user:pass@example.com/path');
  });

  it('preserves username only (no password)', () => {
    expect(
      normalizeUrl('https://user@example.com/path')
    ).toBe('https://user@example.com/path');
  });

  it('preserves credentials with query params', () => {
    expect(
      normalizeUrl('https://user:pass@example.com/path?q=test')
    ).toBe('https://user:pass@example.com/path?q=test');
  });

  it('strips tracking params while preserving credentials', () => {
    expect(
      normalizeUrl('https://user:pass@example.com/path?utm_source=x&keep=1')
    ).toBe('https://user:pass@example.com/path?keep=1');
  });

  it('converts http credentials URL to https', () => {
    expect(
      normalizeUrl('http://user:pass@example.com/path')
    ).toBe('https://user:pass@example.com/path');
  });

  it('preserves credentials through all transformations', () => {
    expect(
      normalizeUrl(
        'http://USER:PASS@EXAMPLE.COM:80/path/?utm_source=x&q=1#a'
      )
    ).toBe('https://USER:PASS@example.com/path?q=1');
  });

  it('preserves credentials with sorted query params', () => {
    expect(
      normalizeUrl('https://user:pass@example.com/path?z=1&a=2')
    ).toBe('https://user:pass@example.com/path?a=2&z=1');
  });
});

// ---------------------------------------------------------------------------
// IP address hostnames
// ---------------------------------------------------------------------------

describe('IP address hostnames', () => {
  it('preserves IPv4 hostname', () => {
    expect(
      normalizeUrl('https://192.168.1.1/api')
    ).toBe('https://192.168.1.1/api');
  });

  it('preserves IPv4 hostname with non-default port', () => {
    expect(
      normalizeUrl('https://192.168.1.1:8080/api')
    ).toBe('https://192.168.1.1:8080/api');
  });

  it('removes default port 80 from http IPv4 URL', () => {
    expect(
      normalizeUrl('http://192.168.1.1:80/api')
    ).toBe('https://192.168.1.1/api');
  });

  it('removes default port 443 from https IPv4 URL', () => {
    expect(
      normalizeUrl('https://10.0.0.1:443/api')
    ).toBe('https://10.0.0.1/api');
  });

  it('preserves IPv6 hostname', () => {
    expect(
      normalizeUrl('https://[::1]/api')
    ).toBe('https://[::1]/api');
  });

  it('lowercases IPv6 hostname hex digits', () => {
    expect(
      normalizeUrl('https://[2001:DB8::1]/api')
    ).toBe('https://[2001:db8::1]/api');
  });

  it('preserves IPv6 hostname with non-default port', () => {
    expect(
      normalizeUrl('https://[::1]:8080/api')
    ).toBe('https://[::1]:8080/api');
  });

  it('removes default port from http IPv6 URL', () => {
    expect(
      normalizeUrl('http://[::1]:80/api')
    ).toBe('https://[::1]/api');
  });

  it('preserves IPv4 hostname through tracking param removal', () => {
    expect(
      normalizeUrl('https://192.168.1.1/api?utm_source=x&keep=1')
    ).toBe('https://192.168.1.1/api?keep=1');
  });
});

// ---------------------------------------------------------------------------
// Extra tracking params edge cases
// ---------------------------------------------------------------------------

describe('extra tracking params edge cases', () => {
  it('handles duplicate entries in extra params array', () => {
    expect(
      normalizeUrl('https://example.com?custom=a&keep=1', ['custom', 'custom'])
    ).toBe('https://example.com/?keep=1');
  });

  it('handles extra param that duplicates a built-in blocklist entry', () => {
    expect(
      normalizeUrl('https://example.com?utm_source=x&keep=1', ['utm_source'])
    ).toBe('https://example.com/?keep=1');
  });

  it('handles empty string in extra params array (no effect)', () => {
    expect(
      normalizeUrl('https://example.com?q=test', [''])
    ).toBe('https://example.com/?q=test');
  });

  it('does not match whitespace-padded extra param (no trimming)', () => {
    // ' custom ' (with spaces) does not match 'custom'
    expect(
      normalizeUrl('https://example.com?custom=1', [' custom '])
    ).toBe('https://example.com/?custom=1');
  });

  it('removes param with case-mismatched extra array entry', () => {
    expect(
      normalizeUrl('https://example.com?MyParam=1&keep=2', ['MYparam'])
    ).toBe('https://example.com/?keep=2');
  });

  it('handles large extra params array', () => {
    const extras = Array.from({ length: 20 }, (_, i) => `track${i}`);
    const query = extras.map((e) => `${e}=1`).join('&') + '&keep=1';
    expect(
      normalizeUrl(`https://example.com?${query}`, extras)
    ).toBe('https://example.com/?keep=1');
  });

  it('removes extra params that are substrings of preserved params', () => {
    // 'track' is extra, 'tracker' is not
    expect(
      normalizeUrl('https://example.com?track=1&tracker=2&keep=3', ['track'])
    ).toBe('https://example.com/?keep=3&tracker=2');
  });
});

// ---------------------------------------------------------------------------
// Large-scale parameter sorting
// ---------------------------------------------------------------------------

describe('large-scale parameter sorting', () => {
  it('sorts 10 parameters in reverse order', () => {
    const keys = Array.from({ length: 10 }, (_, i) =>
      String.fromCharCode(106 - i) // 'j' down to 'a'
    );
    const query = keys.map((k, i) => `${k}=${i}`).join('&');
    const sortedKeys = keys.slice().reverse();
    const expected = sortedKeys
      .map((k, i) => `${k}=${9 - i}`)
      .join('&');
    expect(
      normalizeUrl(`https://example.com?${query}`)
    ).toBe(`https://example.com/?${expected}`);
  });

  it('sorts 26 alphabetical parameters', () => {
    const keys = 'zyxwvutsrqponmlkjihgfedcba'.split('');
    const query = keys.map((k, i) => `${k}=${i}`).join('&');
    const sortedKeys = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const expected = sortedKeys
      .map((k, i) => `${k}=${25 - i}`)
      .join('&');
    expect(
      normalizeUrl(`https://example.com?${query}`)
    ).toBe(`https://example.com/?${expected}`);
  });

  it('sorts many params with tracking params removed', () => {
    expect(
      normalizeUrl(
        'https://example.com?z=1&utm_source=x&m=2&fbclid=y&a=3&p=4'
      )
    ).toBe('https://example.com/?a=3&m=2&p=4&z=1');
  });

  it('sorts many params with http scheme conversion', () => {
    expect(
      normalizeUrl('http://example.com?z=1&a=2&m=3&b=4')
    ).toBe('https://example.com/?a=2&b=4&m=3&z=1');
  });

  it('sorts many params on non-root path with trailing slash', () => {
    expect(
      normalizeUrl('https://example.com/api/?z=1&a=2&m=3&b=4')
    ).toBe('https://example.com/api?a=2&b=4&m=3&z=1');
  });
});

// ---------------------------------------------------------------------------
// Parameter keys with dots and hyphens
// ---------------------------------------------------------------------------

describe('parameter keys with dots and hyphens', () => {
  it('sorts params with dots in keys', () => {
    // ASCII: '.'(46) < 'k'(107) < 'v'(118)
    expect(
      normalizeUrl('https://example.com?api.version=1&api.key=abc')
    ).toBe('https://example.com/?api.key=abc&api.version=1');
  });

  it('sorts params with hyphens in keys', () => {
    expect(
      normalizeUrl('https://example.com?b-c=1&a-d=2&b-a=3')
    ).toBe('https://example.com/?a-d=2&b-a=3&b-c=1');
  });

  it('sorts params with mixed dots and hyphens', () => {
    // ASCII: '-'(45) < '.'(46) < '_'(95)
    expect(
      normalizeUrl('https://example.com?x_z=3&x.y=2&x-y=1')
    ).toBe('https://example.com/?x-y=1&x.y=2&x_z=3');
  });

  it('preserves param with dot in key when removing tracking params', () => {
    expect(
      normalizeUrl('https://example.com?utm.source=x&keep=1')
    ).toBe('https://example.com/?keep=1&utm.source=x');
  });
});

// ---------------------------------------------------------------------------
// Combined encoding and normalization
// ---------------------------------------------------------------------------

describe('combined encoding and normalization', () => {
  it('preserves path encoding while re-encoding query values', () => {
    // Path %20 is preserved, query %20 becomes +
    expect(
      normalizeUrl('https://example.com/path%20name?q=hello%20world')
    ).toBe('https://example.com/path%20name?q=hello+world');
  });

  it('normalizes http URL with encoded path and query', () => {
    expect(
      normalizeUrl('http://example.com/caf%C3%A9?name=hello%20world')
    ).toBe('https://example.com/caf%C3%A9?name=hello+world');
  });

  it('normalizes URL with encoded path, tracking, and uppercase host', () => {
    expect(
      normalizeUrl(
        'http://SITE.com/path%20here?utm_source=x&q=hello%20world&a=1'
      )
    ).toBe('https://site.com/path%20here?a=1&q=hello+world');
  });

  it('normalizes URL with credentials, port, fragment, and encoding', () => {
    expect(
      normalizeUrl(
        'http://user:pass@EXAMPLE.COM:80/caf%C3%A9/?q=hello%20world#top'
      )
    ).toBe('https://user:pass@example.com/caf%C3%A9?q=hello+world');
  });

  it('preserves encoded path through trailing slash removal and sorting', () => {
    expect(
      normalizeUrl(
        'https://example.com/encoded%20path/?z=2&a=hello%20world'
      )
    ).toBe('https://example.com/encoded%20path?a=hello+world&z=2');
  });

  it('is idempotent for combined encoding normalization', () => {
    const once = normalizeUrl(
      'http://SITE.com/path%20here?utm_source=x&q=hello%20world&a=1'
    );
    const twice = normalizeUrl(once);
    expect(twice).toBe(once);
  });
});
