/**
 * Unit tests for the SearXNG instance pool — environment-based mode selection,
 * cursor advancement, instance promotion, cursor reset, and stderr logging.
 *
 * Verifies:
 *   - SEARXNG_URL validation (valid HTTP/HTTPS, invalid URL, wrong protocol)
 *   - Mode selection (self-hosted vs public)
 *   - Built-in public instance list has at least 3 entries
 *   - Cursor advancement returns correct booleans at boundaries
 *   - promoteInstance moves URL to front and resets cursor
 *   - resetCursor sets cursor to 0
 *   - hasMoreInstances returns correct boolean at each cursor position
 *   - getCurrentInstance returns the URL at the current cursor
 *   - Volatile in-memory state behavior (mutations do not persist across pools)
 *   - stderr logging for mode selection, endpoint config, failover, and reordering
 *
 * [Spec: US-SR-006, US-SR-007, US-SR-012, NFR-SR-004]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PUBLIC_SEARXNG_INSTANCES,
  createInstancePool,
  getCurrentInstance,
  advanceToNextInstance,
  promoteInstance,
  resetCursor,
  hasMoreInstances,
} from '../../../src/modules/search-retrieval/instance-pool.js';
import { ConfigurationError } from '../../../src/modules/search-retrieval/errors.js';
import type { InstancePool } from '../../../src/modules/search-retrieval/instance-pool.js';

// ---------------------------------------------------------------------------
// Helper: save and restore SEARXNG_URL env var
// ---------------------------------------------------------------------------

const ENV_KEY = 'SEARXNG_URL';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv !== undefined) {
    process.env[ENV_KEY] = savedEnv;
  } else {
    delete process.env[ENV_KEY];
  }
});

// ---------------------------------------------------------------------------
// PUBLIC_SEARXNG_INSTANCES constant
// ---------------------------------------------------------------------------

describe('PUBLIC_SEARXNG_INSTANCES', () => {
  // [Implements: US-SR-006] At least 3 public instances
  it('contains at least 3 instance URLs', () => {
    expect(PUBLIC_SEARXNG_INSTANCES.length).toBeGreaterThanOrEqual(3);
  });

  it('all entries are valid HTTP(S) URLs', () => {
    for (const url of PUBLIC_SEARXNG_INSTANCES) {
      expect(url).toMatch(/^https?:\/\//);
    }
  });

  it('all entries are unique', () => {
    const unique = new Set(PUBLIC_SEARXNG_INSTANCES);
    expect(unique.size).toBe(PUBLIC_SEARXNG_INSTANCES.length);
  });

  it('is a readonly array (frozen or readonly typed)', () => {
    // The type is readonly string[], so we just verify it's iterable
    expect(Array.isArray(PUBLIC_SEARXNG_INSTANCES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createInstancePool — self-hosted mode (SEARXNG_URL set and valid)
// ---------------------------------------------------------------------------

describe('createInstancePool — self-hosted mode', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-007] Valid HTTP URL → self-hosted mode
  it('configures self-hosted mode when SEARXNG_URL is a valid http:// URL', () => {
    process.env[ENV_KEY] = 'http://localhost:8080';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
  });

  it('configures self-hosted mode when SEARXNG_URL is a valid https:// URL', () => {
    process.env[ENV_KEY] = 'https://searx.example.com';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
  });

  // [Implements: US-SR-007] Single instance in self-hosted mode
  it('has exactly one instance in self-hosted mode', () => {
    process.env[ENV_KEY] = 'https://searx.example.com';
    const pool = createInstancePool();
    expect(pool.instances).toHaveLength(1);
  });

  it('stores the exact SEARXNG_URL value as the sole instance', () => {
    process.env[ENV_KEY] = 'https://my-searx.local:8888';
    const pool = createInstancePool();
    expect(pool.instances[0]).toBe('https://my-searx.local:8888');
  });

  // [Implements: US-SR-007] Cursor starts at 0
  it('initializes cursor to 0 in self-hosted mode', () => {
    process.env[ENV_KEY] = 'https://searx.example.com';
    const pool = createInstancePool();
    expect(pool.cursor).toBe(0);
  });

  // [Implements: US-SR-007] Logs endpoint configuration to stderr
  it('logs the endpoint configuration to stderr', () => {
    process.env[ENV_KEY] = 'https://searx.example.com';
    createInstancePool();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('SearXNG endpoint configured')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://searx.example.com')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('mode: self-hosted')
    );
  });

  it('logs to stderr only (never stdout)', () => {
    process.env[ENV_KEY] = 'https://searx.example.com';
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      createInstancePool();
      expect(stderrSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('accepts URL with path component', () => {
    process.env[ENV_KEY] = 'https://example.com/searxng';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
    expect(pool.instances[0]).toBe('https://example.com/searxng');
  });

  it('accepts URL with port number', () => {
    process.env[ENV_KEY] = 'http://localhost:9090';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
    expect(pool.instances[0]).toBe('http://localhost:9090');
  });

  it('accepts URL with query string', () => {
    process.env[ENV_KEY] = 'https://searx.example.com?format=json';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
  });
});

// ---------------------------------------------------------------------------
// createInstancePool — invalid SEARXNG_URL
// ---------------------------------------------------------------------------

describe('createInstancePool — invalid SEARXNG_URL', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-007] Missing protocol → ConfigurationError
  it('throws ConfigurationError when SEARXNG_URL has no protocol', () => {
    process.env[ENV_KEY] = 'localhost:8080';
    expect(() => createInstancePool()).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError with exact message for missing protocol', () => {
    process.env[ENV_KEY] = 'localhost:8080';
    expect(() => createInstancePool()).toThrow(
      'SEARXNG_URL must be a valid HTTP(S) URL'
    );
  });

  // [Implements: US-SR-007] Malformed syntax → ConfigurationError
  it('throws ConfigurationError for malformed URL syntax', () => {
    process.env[ENV_KEY] = 'not a url at all';
    expect(() => createInstancePool()).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError for URL with spaces', () => {
    process.env[ENV_KEY] = 'https://exa mple.com';
    expect(() => createInstancePool()).toThrow(ConfigurationError);
  });

  // [Implements: US-SR-007] Wrong protocol → ConfigurationError
  it('throws ConfigurationError when SEARXNG_URL uses ftp:// protocol', () => {
    process.env[ENV_KEY] = 'ftp://example.com';
    expect(() => createInstancePool()).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError when SEARXNG_URL uses file:// protocol', () => {
    process.env[ENV_KEY] = 'file:///etc/passwd';
    expect(() => createInstancePool()).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError when SEARXNG_URL uses ws:// protocol', () => {
    process.env[ENV_KEY] = 'ws://example.com';
    expect(() => createInstancePool()).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError with exact message for wrong protocol', () => {
    process.env[ENV_KEY] = 'ftp://example.com';
    expect(() => createInstancePool()).toThrow(
      'SEARXNG_URL must be a valid HTTP(S) URL'
    );
  });

  it('does not log endpoint configuration when URL is invalid', () => {
    process.env[ENV_KEY] = 'ftp://example.com';
    try {
      createInstancePool();
    } catch {
      // expected
    }
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('SearXNG endpoint configured')
    );
  });
});

// ---------------------------------------------------------------------------
// createInstancePool — public mode (SEARXNG_URL absent)
// ---------------------------------------------------------------------------

describe('createInstancePool — public mode', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-006] SEARXNG_URL absent → public mode
  it('configures public mode when SEARXNG_URL is not set', () => {
    delete process.env[ENV_KEY];
    const pool = createInstancePool();
    expect(pool.mode).toBe('public');
  });

  // [Implements: US-SR-006] At least 3 instances in public mode
  it('has at least 3 instances in public mode', () => {
    delete process.env[ENV_KEY];
    const pool = createInstancePool();
    expect(pool.instances.length).toBeGreaterThanOrEqual(3);
  });

  // [Implements: US-SR-006] Instances match built-in list
  it('instances match the PUBLIC_SEARXNG_INSTANCES list', () => {
    delete process.env[ENV_KEY];
    const pool = createInstancePool();
    expect(pool.instances).toEqual([...PUBLIC_SEARXNG_INSTANCES]);
  });

  // [Implements: US-SR-006] Cursor starts at 0
  it('initializes cursor to 0 in public mode', () => {
    delete process.env[ENV_KEY];
    const pool = createInstancePool();
    expect(pool.cursor).toBe(0);
  });

  // [Implements: US-SR-006] Logs public mode message to stderr
  it('logs "SearXNG mode: public instances with failover" to stderr', () => {
    delete process.env[ENV_KEY];
    createInstancePool();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('SearXNG mode: public instances with failover')
    );
  });

  // [Implements: US-SR-006] Logs endpoint configuration to stderr
  it('logs the endpoint configuration with mode: public to stderr', () => {
    delete process.env[ENV_KEY];
    createInstancePool();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('SearXNG endpoint configured')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('mode: public')
    );
  });

  it('logs the first instance URL in the endpoint configuration', () => {
    delete process.env[ENV_KEY];
    createInstancePool();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(PUBLIC_SEARXNG_INSTANCES[0]!)
    );
  });

  it('logs to stderr only (never stdout)', () => {
    delete process.env[ENV_KEY];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      createInstancePool();
      expect(stderrSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // [Implements: US-SR-006] Empty string SEARXNG_URL → public mode
  it('configures public mode when SEARXNG_URL is an empty string', () => {
    process.env[ENV_KEY] = '';
    const pool = createInstancePool();
    expect(pool.mode).toBe('public');
  });
});

// ---------------------------------------------------------------------------
// getCurrentInstance
// ---------------------------------------------------------------------------

describe('getCurrentInstance', () => {
  // [Implements: US-SR-006] Returns the URL at the current cursor position
  it('returns the first instance when cursor is 0', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 0,
    };
    expect(getCurrentInstance(pool)).toBe('https://a.example');
  });

  it('returns the second instance when cursor is 1', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 1,
    };
    expect(getCurrentInstance(pool)).toBe('https://b.example');
  });

  it('returns the last instance when cursor is at the end', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    expect(getCurrentInstance(pool)).toBe('https://c.example');
  });

  it('returns the sole instance in self-hosted mode', () => {
    const pool: InstancePool = {
      mode: 'self-hosted',
      instances: ['https://searx.local'],
      cursor: 0,
    };
    expect(getCurrentInstance(pool)).toBe('https://searx.local');
  });
});

// ---------------------------------------------------------------------------
// advanceToNextInstance — boundary behavior
// ---------------------------------------------------------------------------

describe('advanceToNextInstance — boundary behavior', () => {
  // [Implements: US-SR-006] First instance → can advance
  it('returns true and advances cursor from first to second instance', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 0,
    };
    const result = advanceToNextInstance(pool);
    expect(result).toBe(true);
    expect(pool.cursor).toBe(1);
  });

  // [Implements: US-SR-006] Middle instance → can advance
  it('returns true and advances cursor from second to third instance', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 1,
    };
    const result = advanceToNextInstance(pool);
    expect(result).toBe(true);
    expect(pool.cursor).toBe(2);
  });

  // [Implements: US-SR-006] Last instance → cannot advance
  it('returns false when cursor is at the last instance', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    const result = advanceToNextInstance(pool);
    expect(result).toBe(false);
    expect(pool.cursor).toBe(2);
  });

  // [Implements: US-SR-006] Self-hosted mode → cannot advance
  it('returns false in self-hosted mode (single instance)', () => {
    const pool: InstancePool = {
      mode: 'self-hosted',
      instances: ['https://searx.local'],
      cursor: 0,
    };
    const result = advanceToNextInstance(pool);
    expect(result).toBe(false);
    expect(pool.cursor).toBe(0);
  });

  it('does not advance beyond the last instance', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example'],
      cursor: 1,
    };
    advanceToNextInstance(pool);
    expect(pool.cursor).toBe(1);
  });

  it('can advance through all instances sequentially', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 0,
    };
    expect(advanceToNextInstance(pool)).toBe(true);
    expect(pool.cursor).toBe(1);
    expect(advanceToNextInstance(pool)).toBe(true);
    expect(pool.cursor).toBe(2);
    expect(advanceToNextInstance(pool)).toBe(false);
    expect(pool.cursor).toBe(2);
  });

  it('logs debug message to stderr when advancing', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const pool: InstancePool = {
        mode: 'public',
        instances: ['https://a.example', 'https://b.example'],
        cursor: 0,
      };
      advanceToNextInstance(pool);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('DEBUG')
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('cursor=1')
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('does not log to stderr when advancement fails (at last instance)', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const pool: InstancePool = {
        mode: 'public',
        instances: ['https://a.example', 'https://b.example'],
        cursor: 1,
      };
      advanceToNextInstance(pool);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// promoteInstance
// ---------------------------------------------------------------------------

describe('promoteInstance', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-006] Promote moves URL to front
  it('moves the promoted URL to the front of the list', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    promoteInstance(pool, 'https://c.example');
    expect(pool.instances[0]).toBe('https://c.example');
  });

  it('resets cursor to 0 after promotion', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    promoteInstance(pool, 'https://c.example');
    expect(pool.cursor).toBe(0);
  });

  it('preserves all instances in the list after promotion (no loss)', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    promoteInstance(pool, 'https://c.example');
    expect(pool.instances).toHaveLength(3);
    expect(pool.instances).toContain('https://a.example');
    expect(pool.instances).toContain('https://b.example');
    expect(pool.instances).toContain('https://c.example');
  });

  it('reorders correctly when promoting the middle instance', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    promoteInstance(pool, 'https://b.example');
    expect(pool.instances).toEqual([
      'https://b.example',
      'https://a.example',
      'https://c.example',
    ]);
  });

  it('reorders correctly when promoting the last instance', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    promoteInstance(pool, 'https://c.example');
    expect(pool.instances).toEqual([
      'https://c.example',
      'https://a.example',
      'https://b.example',
    ]);
  });

  // [Implements: US-SR-006] Already at front → no reorder, just reset cursor
  it('does not reorder when the URL is already at front', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 1,
    };
    promoteInstance(pool, 'https://a.example');
    expect(pool.instances).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    expect(pool.cursor).toBe(0);
  });

  // [Implements: US-SR-006] Logs failover success message
  it('logs "Failover succeeded using instance: {url}" to stderr', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example'],
      cursor: 1,
    };
    promoteInstance(pool, 'https://b.example');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failover succeeded using instance: https://b.example')
    );
  });

  // [Implements: US-SR-006] Logs new ordering at debug level
  it('logs the new instance ordering at debug level', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    promoteInstance(pool, 'https://c.example');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('DEBUG')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('instance pool reordered')
    );
  });

  it('does not log reordering when URL is already at front', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example'],
      cursor: 0,
    };
    promoteInstance(pool, 'https://a.example');
    // Should still log the failover success message
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failover succeeded')
    );
    // But should NOT log the reorder debug message
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('reordered')
    );
  });

  it('logs to stderr only (never stdout)', () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const pool: InstancePool = {
        mode: 'public',
        instances: ['https://a.example', 'https://b.example'],
        cursor: 1,
      };
      promoteInstance(pool, 'https://b.example');
      expect(stderrSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('handles URL not in the list gracefully (no crash)', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example'],
      cursor: 1,
    };
    // URL not in list — indexOf returns -1, which is not > 0, so no reorder
    expect(() => promoteInstance(pool, 'https://nonexistent.example')).not.toThrow();
    // Still logs the failover success message
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failover succeeded')
    );
  });
});

// ---------------------------------------------------------------------------
// resetCursor
// ---------------------------------------------------------------------------

describe('resetCursor', () => {
  // [Implements: US-SR-006] Resets cursor to 0
  it('sets cursor to 0 when it was at a non-zero position', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    resetCursor(pool);
    expect(pool.cursor).toBe(0);
  });

  it('sets cursor to 0 when it was at 1', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example'],
      cursor: 1,
    };
    resetCursor(pool);
    expect(pool.cursor).toBe(0);
  });

  it('keeps cursor at 0 when it was already 0', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example'],
      cursor: 0,
    };
    resetCursor(pool);
    expect(pool.cursor).toBe(0);
  });

  it('resets cursor in self-hosted mode', () => {
    const pool: InstancePool = {
      mode: 'self-hosted',
      instances: ['https://searx.local'],
      cursor: 0,
    };
    resetCursor(pool);
    expect(pool.cursor).toBe(0);
  });

  it('does not modify the instances list', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    const originalInstances = [...pool.instances];
    resetCursor(pool);
    expect(pool.instances).toEqual(originalInstances);
  });

  it('does not modify the mode', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example'],
      cursor: 1,
    };
    resetCursor(pool);
    expect(pool.mode).toBe('public');
  });
});

// ---------------------------------------------------------------------------
// hasMoreInstances
// ---------------------------------------------------------------------------

describe('hasMoreInstances', () => {
  // [Implements: US-SR-006] Has more when cursor is before the last instance
  it('returns true when cursor is at the first instance (more remain)', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 0,
    };
    expect(hasMoreInstances(pool)).toBe(true);
  });

  it('returns true when cursor is at a middle instance', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 1,
    };
    expect(hasMoreInstances(pool)).toBe(true);
  });

  // [Implements: US-SR-006] No more when cursor is at the last instance
  it('returns false when cursor is at the last instance', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    expect(hasMoreInstances(pool)).toBe(false);
  });

  // [Implements: US-SR-006] Self-hosted mode → always false
  it('returns false in self-hosted mode (single instance)', () => {
    const pool: InstancePool = {
      mode: 'self-hosted',
      instances: ['https://searx.local'],
      cursor: 0,
    };
    expect(hasMoreInstances(pool)).toBe(false);
  });

  it('returns true for a two-instance pool at cursor 0', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example'],
      cursor: 0,
    };
    expect(hasMoreInstances(pool)).toBe(true);
  });

  it('returns false for a two-instance pool at cursor 1', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example'],
      cursor: 1,
    };
    expect(hasMoreInstances(pool)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Volatile state behavior — mutations are in-memory only
// ---------------------------------------------------------------------------

describe('volatile state behavior', () => {
  // [Implements: NFR-SR-006] State is process-memory volatile
  it('mutations to one pool do not affect a newly created pool', () => {
    delete process.env[ENV_KEY];
    const pool1 = createInstancePool();
    const originalInstances = [...pool1.instances];

    // Mutate pool1
    advanceToNextInstance(pool1);
    promoteInstance(pool1, pool1.instances[1]!);

    // Create a new pool — should have the original ordering
    const pool2 = createInstancePool();
    expect(pool2.instances).toEqual(originalInstances);
    expect(pool2.cursor).toBe(0);
  });

  it('promoteInstance on one pool does not affect PUBLIC_SEARXNG_INSTANCES', () => {
    delete process.env[ENV_KEY];
    const originalList = [...PUBLIC_SEARXNG_INSTANCES];

    const pool = createInstancePool();
    const lastUrl = pool.instances[pool.instances.length - 1]!;
    promoteInstance(pool, lastUrl);

    // The constant should be unchanged
    expect([...PUBLIC_SEARXNG_INSTANCES]).toEqual(originalList);
  });

  it('advanceToNextInstance mutates the pool in place', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 0,
    };
    const cursorBefore = pool.cursor;
    advanceToNextInstance(pool);
    expect(pool.cursor).not.toBe(cursorBefore);
    expect(pool.cursor).toBe(1);
  });

  it('resetCursor mutates the pool in place', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    resetCursor(pool);
    expect(pool.cursor).toBe(0);
  });

  it('promoteInstance mutates the pool instances in place', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    const instancesBefore = [...pool.instances];
    promoteInstance(pool, 'https://c.example');
    // The instances array should have been reordered
    expect(pool.instances).not.toEqual(instancesBefore);
  });
});

// ---------------------------------------------------------------------------
// Integration — failover workflow simulation
// ---------------------------------------------------------------------------

describe('integration — failover workflow simulation', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SR-006] Full failover workflow
  it('simulates a complete failover: advance → succeed → promote → reset', () => {
    delete process.env[ENV_KEY];
    const pool = createInstancePool();
    expect(pool.cursor).toBe(0);
    expect(pool.mode).toBe('public');

    // First instance fails — advance to next
    expect(hasMoreInstances(pool)).toBe(true);
    expect(advanceToNextInstance(pool)).toBe(true);
    expect(pool.cursor).toBe(1);

    // Second instance also fails — advance to next
    expect(hasMoreInstances(pool)).toBe(true);
    expect(advanceToNextInstance(pool)).toBe(true);
    expect(pool.cursor).toBe(2);

    // No more instances
    expect(hasMoreInstances(pool)).toBe(false);
    expect(advanceToNextInstance(pool)).toBe(false);

    // But wait — third instance succeeds! Promote it.
    const successUrl = getCurrentInstance(pool);
    promoteInstance(pool, successUrl);

    // After promotion, the successful instance is at front
    expect(pool.instances[0]).toBe(successUrl);
    expect(pool.cursor).toBe(0);

    // Next search() call would resetCursor (already 0)
    resetCursor(pool);
    expect(pool.cursor).toBe(0);
    expect(getCurrentInstance(pool)).toBe(successUrl);
  });

  it('simulates self-hosted mode: no failover possible', () => {
    process.env[ENV_KEY] = 'https://my-searx.local';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
    expect(hasMoreInstances(pool)).toBe(false);
    expect(advanceToNextInstance(pool)).toBe(false);
    expect(pool.cursor).toBe(0);
  });

  // [Implements: US-SR-006] Promotion changes subsequent search starting point
  it('after promotion, a new search starts with the promoted instance', () => {
    delete process.env[ENV_KEY];
    const pool = createInstancePool();
    const originalFirst = pool.instances[0]!;

    // Advance to second instance and promote it
    advanceToNextInstance(pool);
    const secondInstance = getCurrentInstance(pool);
    promoteInstance(pool, secondInstance);

    // Reset cursor for next search
    resetCursor(pool);

    // Now the first instance should be the promoted one
    expect(getCurrentInstance(pool)).toBe(secondInstance);
    expect(getCurrentInstance(pool)).not.toBe(originalFirst);
  });
});

// ---------------------------------------------------------------------------
// createInstancePool — edge case URLs
// ---------------------------------------------------------------------------

describe('createInstancePool — edge case URLs', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('throws ConfigurationError for whitespace-only SEARXNG_URL', () => {
    process.env[ENV_KEY] = '   ';
    expect(() => createInstancePool()).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError for URL with no host', () => {
    process.env[ENV_KEY] = 'https://';
    expect(() => createInstancePool()).toThrow(ConfigurationError);
  });

  it('accepts URL with trailing slash', () => {
    process.env[ENV_KEY] = 'https://searx.example.com/';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
    expect(pool.instances[0]).toBe('https://searx.example.com/');
  });

  it('accepts URL with basic auth credentials', () => {
    process.env[ENV_KEY] = 'https://user:pass@searx.example.com';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
    expect(pool.instances[0]).toBe('https://user:pass@searx.example.com');
  });

  it('accepts URL with fragment', () => {
    process.env[ENV_KEY] = 'https://searx.example.com#section';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
  });

  it('accepts URL with IP address as host', () => {
    process.env[ENV_KEY] = 'http://192.168.1.100:8080';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
    expect(pool.instances[0]).toBe('http://192.168.1.100:8080');
  });

  it('accepts minimal valid URL (http://a)', () => {
    process.env[ENV_KEY] = 'http://a';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
  });

  it('accepts URL with multiple path segments', () => {
    process.env[ENV_KEY] = 'https://example.com/searxng/search/api';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
    expect(pool.instances[0]).toBe('https://example.com/searxng/search/api');
  });

  it('accepts URL with both path and query string', () => {
    process.env[ENV_KEY] = 'https://example.com/searx?q=test&format=json';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
  });

  it('accepts URL with port and path', () => {
    process.env[ENV_KEY] = 'http://localhost:8888/searxng';
    const pool = createInstancePool();
    expect(pool.mode).toBe('self-hosted');
    expect(pool.instances[0]).toBe('http://localhost:8888/searxng');
  });

  it('throws ConfigurationError for javascript: protocol', () => {
    process.env[ENV_KEY] = 'javascript:alert(1)';
    expect(() => createInstancePool()).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError for data: protocol', () => {
    process.env[ENV_KEY] = 'data:text/html,<h1>test</h1>';
    expect(() => createInstancePool()).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError for mailto: protocol', () => {
    process.env[ENV_KEY] = 'mailto:test@example.com';
    expect(() => createInstancePool()).toThrow(ConfigurationError);
  });
});

// ---------------------------------------------------------------------------
// Independent pool objects — object identity and cross-pool isolation
// ---------------------------------------------------------------------------

describe('independent pool objects', () => {
  it('two pools created in self-hosted mode are distinct objects', () => {
    process.env[ENV_KEY] = 'https://searx.example.com';
    const pool1 = createInstancePool();
    const pool2 = createInstancePool();
    expect(pool1).not.toBe(pool2);
    expect(pool1.instances).not.toBe(pool2.instances);
  });

  it('two pools created in public mode are distinct objects', () => {
    delete process.env[ENV_KEY];
    const pool1 = createInstancePool();
    const pool2 = createInstancePool();
    expect(pool1).not.toBe(pool2);
    expect(pool1.instances).not.toBe(pool2.instances);
  });

  it('advancing cursor on one pool does not affect another', () => {
    delete process.env[ENV_KEY];
    const pool1 = createInstancePool();
    const pool2 = createInstancePool();

    advanceToNextInstance(pool1);

    expect(pool1.cursor).toBe(1);
    expect(pool2.cursor).toBe(0);
  });

  it('promoting on one pool does not affect another', () => {
    delete process.env[ENV_KEY];
    const pool1 = createInstancePool();
    const pool2 = createInstancePool();
    const originalOrder2 = [...pool2.instances];

    const lastUrl = pool1.instances[pool1.instances.length - 1]!;
    promoteInstance(pool1, lastUrl);

    expect(pool2.instances).toEqual(originalOrder2);
  });

  it('resetting cursor on one pool does not affect another', () => {
    delete process.env[ENV_KEY];
    const pool1 = createInstancePool();
    const pool2 = createInstancePool();

    advanceToNextInstance(pool1);
    advanceToNextInstance(pool2);
    resetCursor(pool1);

    expect(pool1.cursor).toBe(0);
    expect(pool2.cursor).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// No stderr logging for pure query functions
// ---------------------------------------------------------------------------

describe('no stderr logging for pure query functions', () => {
  it('getCurrentInstance does not write to stderr', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const pool: InstancePool = {
        mode: 'public',
        instances: ['https://a.example', 'https://b.example'],
        cursor: 0,
      };
      getCurrentInstance(pool);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('hasMoreInstances does not write to stderr', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const pool: InstancePool = {
        mode: 'public',
        instances: ['https://a.example', 'https://b.example'],
        cursor: 0,
      };
      hasMoreInstances(pool);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('resetCursor does not write to stderr', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const pool: InstancePool = {
        mode: 'public',
        instances: ['https://a.example', 'https://b.example'],
        cursor: 1,
      };
      resetCursor(pool);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// advanceToNextInstance — debug message content
// ---------------------------------------------------------------------------

describe('advanceToNextInstance — debug message content', () => {
  it('debug message includes the [SR] prefix', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const pool: InstancePool = {
        mode: 'public',
        instances: ['https://a.example', 'https://b.example'],
        cursor: 0,
      };
      advanceToNextInstance(pool);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SR]')
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('debug message includes the new instance URL', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const pool: InstancePool = {
        mode: 'public',
        instances: ['https://a.example', 'https://b.example'],
        cursor: 0,
      };
      advanceToNextInstance(pool);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://b.example')
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('debug message includes "instance pool advanced"', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const pool: InstancePool = {
        mode: 'public',
        instances: ['https://a.example', 'https://b.example'],
        cursor: 0,
      };
      advanceToNextInstance(pool);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('instance pool advanced')
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('debug message includes correct cursor value for multi-advance', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const pool: InstancePool = {
        mode: 'public',
        instances: ['https://a.example', 'https://b.example', 'https://c.example'],
        cursor: 0,
      };
      advanceToNextInstance(pool); // cursor → 1
      advanceToNextInstance(pool); // cursor → 2
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('cursor=2')
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// promoteInstance — self-hosted mode
// ---------------------------------------------------------------------------

describe('promoteInstance — self-hosted mode', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('logs failover success message in self-hosted mode', () => {
    const pool: InstancePool = {
      mode: 'self-hosted',
      instances: ['https://searx.local'],
      cursor: 0,
    };
    promoteInstance(pool, 'https://searx.local');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failover succeeded using instance: https://searx.local')
    );
  });

  it('does not log reorder message when only one instance', () => {
    const pool: InstancePool = {
      mode: 'self-hosted',
      instances: ['https://searx.local'],
      cursor: 0,
    };
    promoteInstance(pool, 'https://searx.local');
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('reordered')
    );
  });

  it('keeps cursor at 0 in self-hosted mode after promotion', () => {
    const pool: InstancePool = {
      mode: 'self-hosted',
      instances: ['https://searx.local'],
      cursor: 0,
    };
    promoteInstance(pool, 'https://searx.local');
    expect(pool.cursor).toBe(0);
  });

  it('keeps single instance unchanged after promotion', () => {
    const pool: InstancePool = {
      mode: 'self-hosted',
      instances: ['https://searx.local'],
      cursor: 0,
    };
    promoteInstance(pool, 'https://searx.local');
    expect(pool.instances).toEqual(['https://searx.local']);
  });
});

// ---------------------------------------------------------------------------
// Instances array isolation — copy vs reference
// ---------------------------------------------------------------------------

describe('instances array isolation', () => {
  it('public mode pool instances is a copy of PUBLIC_SEARXNG_INSTANCES', () => {
    delete process.env[ENV_KEY];
    const pool = createInstancePool();
    expect(pool.instances).not.toBe(PUBLIC_SEARXNG_INSTANCES);
  });

  it('mutating pool.instances does not affect PUBLIC_SEARXNG_INSTANCES', () => {
    delete process.env[ENV_KEY];
    const originalList = [...PUBLIC_SEARXNG_INSTANCES];
    const pool = createInstancePool();
    pool.instances.push('https://injected.example');
    expect([...PUBLIC_SEARXNG_INSTANCES]).toEqual(originalList);
  });

  it('mutating pool.instances does not affect a subsequently created pool', () => {
    delete process.env[ENV_KEY];
    const pool1 = createInstancePool();
    const originalLength = pool1.instances.length;
    pool1.instances.splice(0, 1);
    const pool2 = createInstancePool();
    expect(pool2.instances.length).toBe(originalLength);
  });

  it('self-hosted mode pool instances is an independent array', () => {
    process.env[ENV_KEY] = 'https://searx.example.com';
    const pool1 = createInstancePool();
    const pool2 = createInstancePool();
    expect(pool1.instances).not.toBe(pool2.instances);
  });
});

// ---------------------------------------------------------------------------
// resetCursor — idempotency and repeated calls
// ---------------------------------------------------------------------------

describe('resetCursor — idempotency', () => {
  it('calling resetCursor multiple times keeps cursor at 0', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 2,
    };
    resetCursor(pool);
    expect(pool.cursor).toBe(0);
    resetCursor(pool);
    expect(pool.cursor).toBe(0);
    resetCursor(pool);
    expect(pool.cursor).toBe(0);
  });

  it('resetCursor after advance returns to the first instance', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 0,
    };
    advanceToNextInstance(pool);
    expect(pool.cursor).toBe(1);
    resetCursor(pool);
    expect(pool.cursor).toBe(0);
    expect(getCurrentInstance(pool)).toBe('https://a.example');
  });
});

// ---------------------------------------------------------------------------
// Advance-reset-advance cycle
// ---------------------------------------------------------------------------

describe('advance-reset-advance cycle', () => {
  it('can advance, reset, and advance again from the beginning', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example', 'https://c.example'],
      cursor: 0,
    };

    // First cycle
    expect(advanceToNextInstance(pool)).toBe(true);
    expect(pool.cursor).toBe(1);
    resetCursor(pool);
    expect(pool.cursor).toBe(0);

    // Second cycle
    expect(advanceToNextInstance(pool)).toBe(true);
    expect(pool.cursor).toBe(1);
    expect(advanceToNextInstance(pool)).toBe(true);
    expect(pool.cursor).toBe(2);
    resetCursor(pool);
    expect(pool.cursor).toBe(0);

    // Third cycle — should be able to advance again
    expect(advanceToNextInstance(pool)).toBe(true);
    expect(pool.cursor).toBe(1);
  });

  it('resetCursor after reaching the last instance allows re-advancing', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: ['https://a.example', 'https://b.example'],
      cursor: 0,
    };

    advanceToNextInstance(pool);
    expect(pool.cursor).toBe(1);
    expect(advanceToNextInstance(pool)).toBe(false); // at end

    resetCursor(pool);
    expect(pool.cursor).toBe(0);
    expect(advanceToNextInstance(pool)).toBe(true); // can advance again
    expect(pool.cursor).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// promoteInstance — larger instance list
// ---------------------------------------------------------------------------

describe('promoteInstance — larger instance list', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('promotes the 4th instance in a 5-instance list to front', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: [
        'https://a.example',
        'https://b.example',
        'https://c.example',
        'https://d.example',
        'https://e.example',
      ],
      cursor: 3,
    };
    promoteInstance(pool, 'https://d.example');
    expect(pool.instances[0]).toBe('https://d.example');
    expect(pool.cursor).toBe(0);
    expect(pool.instances).toHaveLength(5);
  });

  it('preserves relative order of other instances after promoting 4th', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: [
        'https://a.example',
        'https://b.example',
        'https://c.example',
        'https://d.example',
        'https://e.example',
      ],
      cursor: 3,
    };
    promoteInstance(pool, 'https://d.example');
    expect(pool.instances).toEqual([
      'https://d.example',
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://e.example',
    ]);
  });

  it('promotes the 2nd instance in a 5-instance list correctly', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: [
        'https://a.example',
        'https://b.example',
        'https://c.example',
        'https://d.example',
        'https://e.example',
      ],
      cursor: 4,
    };
    promoteInstance(pool, 'https://b.example');
    expect(pool.instances).toEqual([
      'https://b.example',
      'https://a.example',
      'https://c.example',
      'https://d.example',
      'https://e.example',
    ]);
  });

  it('promotes the last instance in a 5-instance list correctly', () => {
    const pool: InstancePool = {
      mode: 'public',
      instances: [
        'https://a.example',
        'https://b.example',
        'https://c.example',
        'https://d.example',
        'https://e.example',
      ],
      cursor: 4,
    };
    promoteInstance(pool, 'https://e.example');
    expect(pool.instances).toEqual([
      'https://e.example',
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://d.example',
    ]);
  });
});

// ---------------------------------------------------------------------------
// createInstancePool — stderr log content verification
// ---------------------------------------------------------------------------

describe('createInstancePool — stderr log content verification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('self-hosted mode log includes [SR] prefix', () => {
    process.env[ENV_KEY] = 'https://searx.example.com';
    createInstancePool();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[SR]')
    );
  });

  it('self-hosted mode log includes "endpoint configured"', () => {
    process.env[ENV_KEY] = 'https://searx.example.com';
    createInstancePool();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('endpoint configured')
    );
  });

  it('public mode log includes [SR] prefix', () => {
    delete process.env[ENV_KEY];
    createInstancePool();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[SR]')
    );
  });

  it('public mode log includes "public instances with failover"', () => {
    delete process.env[ENV_KEY];
    createInstancePool();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('public instances with failover')
    );
  });

  it('public mode log includes the first instance URL', () => {
    delete process.env[ENV_KEY];
    createInstancePool();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(PUBLIC_SEARXNG_INSTANCES[0]!)
    );
  });

  it('self-hosted mode log includes the configured URL exactly', () => {
    process.env[ENV_KEY] = 'http://my-host:1234/path';
    createInstancePool();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://my-host:1234/path')
    );
  });
});
