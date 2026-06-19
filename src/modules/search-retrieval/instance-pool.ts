/**
 * SearXNG instance pool management with failover support.
 *
 * Reads SEARXNG_URL from the process environment to determine operational
 * mode (self-hosted vs public). In self-hosted mode, the configured URL is
 * the sole endpoint with no failover. In public mode, a built-in ordered
 * list of public SearXNG instances is used with cursor-based rotation,
 * failover advancement, and successful-instance promotion.
 *
 * All state is process-memory volatile — no file I/O or database writes
 * (NFR-SR-006, DC-SR-005).
 *
 * [Spec: US-SR-006, US-SR-007, BG-SR-003, NFR-SR-006, DC-SR-001, DC-SR-005, DC-SR-007]
 */

import { ConfigurationError } from './errors.js';

// ---------------------------------------------------------------------------
// SearXNGMode
// ---------------------------------------------------------------------------

/**
 * Operational mode for the instance pool.
 *
 * - `'self-hosted'` — SEARXNG_URL is set; single instance, no failover
 * - `'public'` — SEARXNG_URL is absent; built-in list with failover
 *
 * [Constraint: DC-SR-001]
 */
export type SearXNGMode = 'self-hosted' | 'public';

// ---------------------------------------------------------------------------
// InstancePool
// ---------------------------------------------------------------------------

/**
 * Manages the ordered list of SearXNG instance URLs and a cursor tracking
 * the current target.
 *
 * In self-hosted mode, `instances` contains exactly one URL and failover
 * is disabled. In public mode, `instances` contains at least 3 URLs and
 * is reordered on successful failover promotion.
 *
 * [Spec: US-SR-006, US-SR-007, Constraint: DC-SR-005]
 */
export interface InstancePool {
  /** Operational mode: 'self-hosted' or 'public'. */
  mode: SearXNGMode;
  /** Ordered list of instance base URLs (minItems: 1). */
  instances: string[];
  /** Index into `instances` pointing to the current target (min: 0). */
  cursor: number;
}

// ---------------------------------------------------------------------------
// Built-in public SearXNG instances
// ---------------------------------------------------------------------------

/**
 * Built-in ordered list of public SearXNG instance URLs used as failover
 * candidates when SEARXNG_URL is not configured.
 *
 * Contains at least 3 entries per US-SR-006 requirement. These are
 * well-known public instances that support the JSON output format.
 *
 * [Implements: US-SR-006]
 * [Constraint: DC-SR-001]
 */
export const PUBLIC_SEARXNG_INSTANCES: readonly string[] = [
  'https://searx.be',
  'https://search.bus-hit.me',
  'https://searx.tiekoetter.com',
];

// ---------------------------------------------------------------------------
// createInstancePool
// ---------------------------------------------------------------------------

/**
 * Create an InstancePool by reading the SEARXNG_URL environment variable.
 *
 * Decision logic:
 *   1. If SEARXNG_URL is present and valid HTTP(S) URL → self-hosted mode
 *      with that URL as the sole instance (failover disabled).
 *   2. If SEARXNG_URL is present but invalid → throw ConfigurationError.
 *   3. If SEARXNG_URL is absent → public mode with built-in instance list.
 *
 * Logs mode selection and endpoint configuration to stderr.
 *
 * @returns A new InstancePool configured from the environment.
 * @throws {ConfigurationError} If SEARXNG_URL is set but is not a valid HTTP(S) URL.
 *
 * [Implements: US-SR-007]
 * [Constraint: DC-SR-005, NFR-SR-006]
 */
export function createInstancePool(): InstancePool {
  const rawUrl = process.env['SEARXNG_URL'];

  if (rawUrl !== undefined && rawUrl.length > 0) {
    // [Implements: US-SR-007] Validate SEARXNG_URL as HTTP(S) URL
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      // [Implements: US-SR-007] Invalid URL syntax — missing protocol or malformed
      throw new ConfigurationError('SEARXNG_URL must be a valid HTTP(S) URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      // [Implements: US-SR-007] Valid URL but wrong protocol (e.g. ftp://)
      throw new ConfigurationError('SEARXNG_URL must be a valid HTTP(S) URL');
    }

    // [Implements: US-SR-007] Self-hosted mode — sole endpoint, no failover
    process.stderr.write(
      `[SR] SearXNG endpoint configured: ${rawUrl}, mode: self-hosted\n`
    );

    return {
      mode: 'self-hosted',
      instances: [rawUrl],
      cursor: 0,
    };
  }

  // [Implements: US-SR-007] Public mode — built-in instances with failover
  process.stderr.write(
    '[SR] SearXNG mode: public instances with failover\n'
  );

  const firstInstance = PUBLIC_SEARXNG_INSTANCES[0]!;
  process.stderr.write(
    `[SR] SearXNG endpoint configured: ${firstInstance}, mode: public\n`
  );

  return {
    mode: 'public',
    instances: [...PUBLIC_SEARXNG_INSTANCES],
    cursor: 0,
  };
}

// ---------------------------------------------------------------------------
// getCurrentInstance
// ---------------------------------------------------------------------------

/**
 * Get the URL of the instance currently pointed to by the cursor.
 *
 * @param pool - The instance pool.
 * @returns The current instance URL string.
 *
 * [Implements: US-SR-006]
 */
export function getCurrentInstance(pool: InstancePool): string {
  return pool.instances[pool.cursor]!;
}

// ---------------------------------------------------------------------------
// advanceToNextInstance
// ---------------------------------------------------------------------------

/**
 * Advance the cursor to the next instance in the failover list.
 *
 * Called by the retry-failover logic when all retries against the current
 * instance are exhausted and additional candidates exist. Resets implicitly
 * by moving the cursor — the retry-failover module resets its own retry
 * counter when this returns `true`.
 *
 * @param pool - The instance pool (mutated in place).
 * @returns `true` if the cursor was advanced to a valid next instance;
 *          `false` if no more instances remain.
 *
 * [Implements: US-SR-006]
 */
export function advanceToNextInstance(pool: InstancePool): boolean {
  if (pool.cursor < pool.instances.length - 1) {
    pool.cursor++;
    process.stderr.write(
      `[SR] DEBUG instance pool advanced to cursor=${pool.cursor}, instance=${pool.instances[pool.cursor]}\n`
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// promoteInstance
// ---------------------------------------------------------------------------

/**
 * Promote the specified instance URL to the front of the candidate list.
 *
 * Called when a failover instance returns a successful response. Moves the
 * instance to position 0 and resets the cursor so subsequent searches start
 * with the proven-working instance.
 *
 * Logs the failover success message and the new instance ordering at debug
 * level.
 *
 * @param pool - The instance pool (mutated in place).
 * @param url - The instance URL to promote to the front.
 *
 * [Implements: US-SR-006]
 */
export function promoteInstance(pool: InstancePool, url: string): void {
  // [Implements: US-SR-006] Log failover success
  process.stderr.write(
    `[SR] Failover succeeded using instance: ${url}\n`
  );

  const index = pool.instances.indexOf(url);
  if (index > 0) {
    // [Implements: US-SR-006] Move instance to front of the list
    pool.instances.splice(index, 1);
    pool.instances.unshift(url);
    pool.cursor = 0;

    // [Implements: US-SR-006] Log new ordering at debug level
    process.stderr.write(
      `[SR] DEBUG instance pool reordered: ${pool.instances.join(', ')}\n`
    );
  } else if (index === 0) {
    // Already at front — just ensure cursor points to it
    pool.cursor = 0;
  }
}

// ---------------------------------------------------------------------------
// resetCursor
// ---------------------------------------------------------------------------

/**
 * Reset the cursor to 0 (the first instance in the list).
 *
 * Called at the start of each search() invocation to begin with the
 * preferred (front-most) instance.
 *
 * @param pool - The instance pool (mutated in place).
 *
 * [Implements: US-SR-006]
 */
export function resetCursor(pool: InstancePool): void {
  pool.cursor = 0;
}

// ---------------------------------------------------------------------------
// hasMoreInstances
// ---------------------------------------------------------------------------

/**
 * Check whether additional failover candidates remain after the current cursor.
 *
 * In self-hosted mode, always returns `false` (single instance, no failover).
 * In public mode, returns `true` while there are untried instances.
 *
 * @param pool - The instance pool.
 * @returns `true` if the cursor is not at the last instance; `false` otherwise.
 *
 * [Implements: US-SR-006]
 */
export function hasMoreInstances(pool: InstancePool): boolean {
  return pool.cursor < pool.instances.length - 1;
}
