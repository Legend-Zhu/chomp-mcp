/**
 * URL Validator — validates input URLs before any network operation.
 *
 * Validates that the input is a non-empty string, parses successfully via the
 * WHATWG `URL` constructor, uses only `http:` or `https:` scheme, and does
 * not resolve to a private, loopback, or link-local IP address. DNS
 * resolution is performed for hostnames that are not already IP literals to
 * prevent Server-Side Request Forgery (SSRF) attacks.
 *
 * [Spec: US-SC-013, NFR-SC-003]
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ValidationResult } from './types.js';

/** Error message returned when the URL hostname resolves to a private/loopback address. */
const SSRF_BLOCKED_ERROR =
  'URL resolves to a private or loopback address; blocked for security';

// ---------------------------------------------------------------------------
// Private IP range checking helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether an IPv4 dotted-decimal address falls within a blocked
 * range: loopback (127.0.0.0/8), private (10/8, 172.16/12, 192.168/16),
 * link-local (169.254/16), or unspecified (0.0.0.0/8).
 *
 * [Constraint: NFR-SC-003]
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => parseInt(p, 10));
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return false;

  const [a, b] = octets;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16

  return false;
}

/**
 * Expand an IPv6 address string into its full 8-group canonical form
 * (each group zero-padded to 4 hex digits, lowercase).
 *
 * Returns `null` if the address cannot be normalised (invalid format).
 */
function normalizeIPv6(ip: string): string | null {
  // Mixed IPv4 notation is handled separately by the caller.
  if (ip.includes('.')) return null;

  let groups: string[];

  const dcIndex = ip.indexOf('::');
  if (dcIndex !== -1) {
    // Only one '::' is permitted.
    if (ip.indexOf('::', dcIndex + 2) !== -1) return null;

    const before = ip.slice(0, dcIndex);
    const after = ip.slice(dcIndex + 2);

    const beforeGroups = before === '' ? [] : before.split(':');
    const afterGroups = after === '' ? [] : after.split(':');

    const present = beforeGroups.length + afterGroups.length;
    if (present > 7) return null;

    const zeros = 8 - present;
    groups = [...beforeGroups, ...Array(zeros).fill('0'), ...afterGroups];
  } else {
    groups = ip.split(':');
    if (groups.length !== 8) return null;
  }

  // Validate every group is a 1–4 digit hex value.
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  }

  return groups.map((g) => g.padStart(4, '0')).join(':');
}

/**
 * Determine whether an IPv6 address falls within a blocked range:
 * loopback (::1/128), unspecified (::/128), link-local (fe80::/10),
 * unique-local (fc00::/7), or IPv4-mapped/compatible addresses that
 * resolve to a blocked IPv4 address.
 *
 * [Constraint: NFR-SC-003]
 */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv4-mapped with dotted-decimal tail:  ::ffff:a.b.c.d
  const v4Mapped = lower.match(/ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Mapped) {
    return isPrivateIPv4(v4Mapped[1]);
  }

  // IPv4-compatible with dotted-decimal tail: ::a.b.c.d
  const v4Compat = lower.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Compat) {
    return isPrivateIPv4(v4Compat[1]);
  }

  const normalized = normalizeIPv6(lower);
  if (!normalized) return false;

  const groups = normalized.split(':');
  const firstWord = parseInt(groups[0], 16);

  // ::1 loopback
  if (normalized === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  // :: unspecified
  if (normalized === '0000:0000:0000:0000:0000:0000:0000:0000') return true;
  // fe80::/10 link-local
  if ((firstWord & 0xffc0) === 0xfe80) return true;
  // fc00::/7 unique-local
  if ((firstWord & 0xfe00) === 0xfc00) return true;

  // IPv4-mapped (hex): 0000:…:ffff:xxxx:yyyy  OR
  // IPv4-compatible (hex): 0000:0000:0000:0000:0000:0000:xxxx:yyyy
  const firstSixZero = groups.slice(0, 6).every((g) => g === '0000');
  if (groups[5] === 'ffff' || firstSixZero) {
    const hi = parseInt(groups[6], 16);
    const lo = parseInt(groups[7], 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

// [Implements: US-SC-013, NFR-SC-003]
/**
 * Validate a URL string for format, scheme, and SSRF safety.
 *
 * The function performs four sequential checks:
 * 1. The input must be a non-empty string.
 * 2. The input must parse successfully via the `URL` constructor.
 * 3. The URL scheme must be `http:` or `https:`.
 * 4. The hostname (if an IP literal) or DNS-resolved address(es) must not
 *    fall within private/loopback/link-local IP ranges.
 *
 * @param url - The URL string to validate.
 * @returns A `ValidationResult` with `valid: true` on success, or
 *          `valid: false` with a descriptive `error` message.
 */
export async function validateUrl(url: string): Promise<ValidationResult> {
  // [Implements: US-SC-013] Check 1: non-empty string
  if (typeof url !== 'string' || url.length === 0) {
    return { valid: false, error: 'URL is required' };
  }

  // [Implements: US-SC-013] Check 2: parseable via URL constructor
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: `Invalid URL: ${url}` };
  }

  // [Implements: US-SC-013] Check 3: HTTP(S) scheme only
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only HTTP(S) URLs are supported' };
  }

  // [Implements: US-SC-013, NFR-SC-003] Check 4: SSRF — block private/loopback IPs
  // Strip IPv6 brackets that the WHATWG URL hostname property includes for
  // bracketed IPv6 literals (e.g. "[::1]" → "::1").
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // --- If hostname is already an IP literal, check directly ---
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    if (isPrivateIPv4(hostname)) {
      return { valid: false, error: SSRF_BLOCKED_ERROR };
    }
    return { valid: true, error: null };
  }

  if (ipVersion === 6) {
    if (isPrivateIPv6(hostname)) {
      return { valid: false, error: SSRF_BLOCKED_ERROR };
    }
    return { valid: true, error: null };
  }

  // --- Hostname is a domain name — resolve via DNS and check each address ---
  try {
    const addresses = await lookup(hostname, { all: true });

    for (const addr of addresses) {
      const blocked =
        addr.family === 4
          ? isPrivateIPv4(addr.address)
          : addr.family === 6
            ? isPrivateIPv6(addr.address)
            : false;

      if (blocked) {
        return { valid: false, error: SSRF_BLOCKED_ERROR };
      }
    }
  } catch {
    return { valid: false, error: `Failed to resolve hostname: ${hostname}` };
  }

  return { valid: true, error: null };
}
