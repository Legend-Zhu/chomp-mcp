/**
 * Unit tests for url-validator.ts — SSRF checks, scheme validation,
 * malformed URL handling, and private IP range detection.
 *
 * [Spec: US-SC-007, US-SC-008, US-SC-009, US-SC-013, NFR-SC-003]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:dns/promises so we can simulate DNS resolution without network.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup as dnsLookup } from 'node:dns/promises';
import {
  isPrivateIPv4,
  isPrivateIPv6,
  validateUrl,
} from '../../../src/modules/scrape-extract/url-validator.js';

const mockLookup = vi.mocked(dnsLookup);

describe('isPrivateIPv4', () => {
  it('detects loopback 127.0.0.0/8', () => {
    expect(isPrivateIPv4('127.0.0.1')).toBe(true);
    expect(isPrivateIPv4('127.255.255.255')).toBe(true);
  });

  it('detects private 10.0.0.0/8', () => {
    expect(isPrivateIPv4('10.0.0.1')).toBe(true);
    expect(isPrivateIPv4('10.255.255.255')).toBe(true);
  });

  it('detects private 172.16.0.0/12', () => {
    expect(isPrivateIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateIPv4('172.31.255.255')).toBe(true);
  });

  it('rejects 172.32.0.0 as outside the private range', () => {
    expect(isPrivateIPv4('172.32.0.1')).toBe(false);
    expect(isPrivateIPv4('172.15.0.1')).toBe(false);
  });

  it('detects private 192.168.0.0/16', () => {
    expect(isPrivateIPv4('192.168.0.1')).toBe(true);
    expect(isPrivateIPv4('192.168.255.255')).toBe(true);
  });

  it('detects link-local 169.254.0.0/16 (cloud metadata)', () => {
    expect(isPrivateIPv4('169.254.169.254')).toBe(true);
    expect(isPrivateIPv4('169.254.0.1')).toBe(true);
  });

  it('detects unspecified 0.0.0.0/8', () => {
    expect(isPrivateIPv4('0.0.0.0')).toBe(true);
    expect(isPrivateIPv4('0.1.2.3')).toBe(true);
  });

  it('returns false for public IPs', () => {
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv4('1.1.1.1')).toBe(false);
    expect(isPrivateIPv4('93.184.216.34')).toBe(false);
  });

  it('returns false for malformed IPv4 strings', () => {
    expect(isPrivateIPv4('invalid')).toBe(false);
    expect(isPrivateIPv4('1.2.3')).toBe(false);
    expect(isPrivateIPv4('256.1.1.1')).toBe(false);
    expect(isPrivateIPv4('')).toBe(false);
  });

  // --- Additional edge cases ---

  it('returns false for CGNAT 100.64.0.0/10 (not in blocked ranges)', () => {
    expect(isPrivateIPv4('100.64.0.1')).toBe(false);
    expect(isPrivateIPv4('100.127.255.255')).toBe(false);
  });

  it('returns false for multicast 224.0.0.0/4', () => {
    expect(isPrivateIPv4('224.0.0.1')).toBe(false);
    expect(isPrivateIPv4('239.255.255.255')).toBe(false);
  });

  it('returns false for benchmarking 198.18.0.0/15', () => {
    expect(isPrivateIPv4('198.18.0.1')).toBe(false);
    expect(isPrivateIPv4('198.19.255.255')).toBe(false);
  });

  it('returns false for addresses with too many octets', () => {
    expect(isPrivateIPv4('1.2.3.4.5')).toBe(false);
    expect(isPrivateIPv4('192.168.1.1.1')).toBe(false);
  });

  it('returns false for negative octets', () => {
    expect(isPrivateIPv4('-1.0.0.0')).toBe(false);
    expect(isPrivateIPv4('1.-2.3.4')).toBe(false);
  });

  it('rejects 172.0.0.1 and 172.15.x.x as outside 172.16/12', () => {
    expect(isPrivateIPv4('172.0.0.1')).toBe(false);
    expect(isPrivateIPv4('172.1.0.1')).toBe(false);
    expect(isPrivateIPv4('172.15.255.255')).toBe(false);
  });

  it('rejects 172.32.x.x as outside 172.16/12', () => {
    expect(isPrivateIPv4('172.32.0.0')).toBe(false);
    expect(isPrivateIPv4('172.255.255.255')).toBe(false);
  });
});

describe('isPrivateIPv6', () => {
  it('detects loopback ::1', () => {
    expect(isPrivateIPv6('::1')).toBe(true);
  });

  it('detects unspecified ::', () => {
    expect(isPrivateIPv6('::')).toBe(true);
  });

  it('detects link-local fe80::/10', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('febf::1')).toBe(true);
  });

  it('detects unique-local fc00::/7', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fd00::1')).toBe(true);
    expect(isPrivateIPv6('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
  });

  it('detects IPv4-mapped loopback ::ffff:127.0.0.1', () => {
    expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIPv6('::ffff:10.0.0.1')).toBe(true);
  });

  it('returns false for IPv4-mapped public addresses', () => {
    expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);
  });

  it('returns false for public IPv6 addresses', () => {
    expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false);
  });

  it('returns false for invalid IPv6 strings', () => {
    expect(isPrivateIPv6('not-an-ip')).toBe(false);
  });

  // --- Additional edge cases ---

  it('detects link-local fe80:: (all zeros host part)', () => {
    expect(isPrivateIPv6('fe80::')).toBe(true);
  });

  it('returns false for multicast ff02::1', () => {
    expect(isPrivateIPv6('ff02::1')).toBe(false);
  });

  it('returns false for documentation prefix 2001:db8::1', () => {
    expect(isPrivateIPv6('2001:db8::1')).toBe(false);
  });

  it('returns false for IPv4-mapped public ::ffff:93.184.216.34', () => {
    expect(isPrivateIPv6('::ffff:93.184.216.34')).toBe(false);
  });

  it('returns false for fec0::1 (deprecated site-local, outside fe80::/10)', () => {
    expect(isPrivateIPv6('fec0::1')).toBe(false);
  });

  it('returns false for addresses with invalid group lengths', () => {
    expect(isPrivateIPv6('gggg::1')).toBe(false);
  });

  it('detects unique-local fd00:abcd:ef01::1', () => {
    expect(isPrivateIPv6('fd00:abcd:ef01::1')).toBe(true);
  });

  it('returns false for addresses with multiple ::', () => {
    expect(isPrivateIPv6('fe80::1::2')).toBe(false);
  });

  it('handles full-form public IPv6 address', () => {
    expect(
      isPrivateIPv6('2606:4700:4700:0000:0000:0000:0000:1111')
    ).toBe(false);
  });
});

describe('validateUrl', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  // [Implements: US-SC-013] Empty URL
  it('rejects empty string with "URL is required"', async () => {
    const result = await validateUrl('');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('URL is required');
  });

  // [Implements: US-SC-013] Malformed URL
  it('rejects malformed URL', async () => {
    const result = await validateUrl('not a url');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });

  it('rejects URL without protocol', async () => {
    const result = await validateUrl('example.com/path');
    expect(result.valid).toBe(false);
  });

  // [Implements: US-SC-013] Non-HTTP scheme
  it('rejects ftp scheme with "Only HTTP(S) URLs are supported"', async () => {
    const result = await validateUrl('ftp://example.com/file');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Only HTTP(S) URLs are supported');
  });

  it('rejects file scheme', async () => {
    const result = await validateUrl('file:///etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Only HTTP(S) URLs are supported');
  });

  it('rejects javascript scheme', async () => {
    const result = await validateUrl('javascript:alert(1)');
    expect(result.valid).toBe(false);
  });

  // [Implements: NFR-SC-003] SSRF — IPv4 literal private
  it('blocks 127.0.0.1 via SSRF check', async () => {
    const result = await validateUrl('http://127.0.0.1/');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('private or loopback');
  });

  it('blocks 10.0.0.1 via SSRF check', async () => {
    const result = await validateUrl('http://10.0.0.1/');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('private or loopback');
  });

  it('blocks 192.168.1.1 via SSRF check', async () => {
    const result = await validateUrl('http://192.168.1.1/');
    expect(result.valid).toBe(false);
  });

  it('blocks 169.254.169.254 via SSRF check', async () => {
    const result = await validateUrl('http://169.254.169.254/');
    expect(result.valid).toBe(false);
  });

  it('blocks 0.0.0.0 via SSRF check', async () => {
    const result = await validateUrl('http://0.0.0.0/');
    expect(result.valid).toBe(false);
  });

  // [Implements: NFR-SC-003] SSRF — IPv6 literal loopback
  it('blocks [::1] via SSRF check', async () => {
    const result = await validateUrl('http://[::1]/');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('private or loopback');
  });

  it('blocks [fe80::1] via SSRF check', async () => {
    const result = await validateUrl('http://[fe80::1]/');
    expect(result.valid).toBe(false);
  });

  // [Implements: NFR-SC-003] Public IPv4 literal passes
  it('accepts public IPv4 literal http://8.8.8.8', async () => {
    const result = await validateUrl('http://8.8.8.8/');
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  it('accepts public IPv4 literal https://1.1.1.1', async () => {
    const result = await validateUrl('https://1.1.1.1/');
    expect(result.valid).toBe(true);
  });

  // [Implements: NFR-SC-003] Public IPv6 literal passes
  it('accepts public IPv6 literal', async () => {
    const result = await validateUrl('http://[2606:4700:4700::1111]/');
    expect(result.valid).toBe(true);
  });

  // [Implements: NFR-SC-003] DNS resolves to public IP
  it('accepts domain that resolves to a public IP', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);
    const result = await validateUrl('https://example.com/');
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
    expect(mockLookup).toHaveBeenCalledWith('example.com', { all: true });
  });

  // [Implements: NFR-SC-003] DNS resolves to private IP — blocked
  it('blocks domain that resolves to a private IP', async () => {
    mockLookup.mockResolvedValue([
      { address: '10.0.0.5', family: 4 },
    ]);
    const result = await validateUrl('https://internal.example.com/');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('private or loopback');
  });

  // [Implements: NFR-SC-003] DNS resolves to loopback — blocked
  it('blocks domain that resolves to 127.0.0.1', async () => {
    mockLookup.mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
    ]);
    const result = await validateUrl('https://localhost.example.com/');
    expect(result.valid).toBe(false);
  });

  // [Implements: NFR-SC-003] DNS resolves to private IPv6 — blocked
  it('blocks domain that resolves to a private IPv6', async () => {
    mockLookup.mockResolvedValue([
      { address: '::1', family: 6 },
    ]);
    const result = await validateUrl('https://v6loop.example.com/');
    expect(result.valid).toBe(false);
  });

  // [Implements: NFR-SC-003] DNS resolution failure
  it('returns error when DNS resolution fails', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    const result = await validateUrl('https://nonexistent.invalid/');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Failed to resolve hostname');
  });

  // [Implements: NFR-SC-003] Mixed DNS results — any private blocks
  it('blocks when one of multiple resolved addresses is private', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]);
    const result = await validateUrl('https://mixed.example.com/');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('private or loopback');
  });

  // [Implements: US-SC-013] HTTPS with path and query
  it('accepts HTTPS URL with path and query string', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);
    const result = await validateUrl('https://example.com/path?query=1');
    expect(result.valid).toBe(true);
  });

  // --- Additional edge cases ---

  // [Implements: US-SC-013] data: scheme
  it('rejects data: scheme', async () => {
    const result = await validateUrl('data:text/html,<h1>hi</h1>');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Only HTTP(S) URLs are supported');
  });

  // [Implements: US-SC-013] ws: scheme
  it('rejects ws: scheme', async () => {
    const result = await validateUrl('ws://example.com/socket');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Only HTTP(S) URLs are supported');
  });

  // [Implements: US-SC-013] wss: scheme
  it('rejects wss: scheme', async () => {
    const result = await validateUrl('wss://example.com/socket');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Only HTTP(S) URLs are supported');
  });

  // [Implements: NFR-SC-003] Public IPv4 literal with port
  it('accepts public IPv4 literal with explicit port', async () => {
    const result = await validateUrl('http://8.8.8.8:8080/');
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  // [Implements: NFR-SC-003] Public IPv6 literal with port
  it('accepts public IPv6 literal with explicit port', async () => {
    const result = await validateUrl('http://[2606:4700:4700::1111]:8080/');
    expect(result.valid).toBe(true);
  });

  // [Implements: US-SC-013] URL with fragment
  it('accepts HTTPS URL with fragment', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);
    const result = await validateUrl('https://example.com/page#section');
    expect(result.valid).toBe(true);
  });

  // [Implements: NFR-SC-003] localhost hostname resolves via DNS to loopback
  it('blocks localhost that resolves to 127.0.0.1 via DNS', async () => {
    mockLookup.mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
    ]);
    const result = await validateUrl('http://localhost:3000/');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('private or loopback');
  });

  // [Implements: NFR-SC-003] Domain with explicit port
  it('accepts domain with explicit port resolving to public IP', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);
    const result = await validateUrl('https://example.com:443/api');
    expect(result.valid).toBe(true);
  });

  // [Implements: NFR-SC-003] DNS resolves to link-local IPv6
  it('blocks domain that resolves to link-local IPv6 fe80::1', async () => {
    mockLookup.mockResolvedValue([
      { address: 'fe80::1', family: 6 },
    ]);
    const result = await validateUrl('https://llv6.example.com/');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('private or loopback');
  });

  // [Implements: NFR-SC-003] DNS resolves to unique-local IPv6
  it('blocks domain that resolves to unique-local IPv6 fd00::1', async () => {
    mockLookup.mockResolvedValue([
      { address: 'fd00::1', family: 6 },
    ]);
    const result = await validateUrl('https://ula.example.com/');
    expect(result.valid).toBe(false);
  });

  // [Implements: NFR-SC-003] All DNS results public — accepted
  it('accepts when all multiple resolved addresses are public', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    const result = await validateUrl('https://dualstack.example.com/');
    expect(result.valid).toBe(true);
  });

  // [Implements: NFR-SC-003] Mixed public IPv4 and private IPv6
  it('blocks when DNS returns public IPv4 and private IPv6', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '::1', family: 6 },
    ]);
    const result = await validateUrl('https://mixed46.example.com/');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('private or loopback');
  });

  // [Implements: US-SC-013] Whitespace-only URL is malformed
  it('rejects whitespace-only string as malformed URL', async () => {
    const result = await validateUrl('   ');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });

  // [Implements: US-SC-013] URL with credentials resolves through DNS
  it('accepts HTTPS URL with credentials and public DNS', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);
    const result = await validateUrl('https://user:pass@example.com/');
    expect(result.valid).toBe(true);
  });

  // [Implements: NFR-SC-003] DNS failure includes hostname in error
  it('includes hostname in the DNS resolution failure error', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    const result = await validateUrl('https://specific-host.invalid/');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('specific-host.invalid');
  });

  // [Implements: NFR-SC-003] Empty array of DNS results is accepted (no private)
  it('accepts when DNS returns an empty address array', async () => {
    mockLookup.mockResolvedValue([]);
    const result = await validateUrl('https://empty.example.com/');
    expect(result.valid).toBe(true);
  });
});
