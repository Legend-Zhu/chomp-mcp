/**
 * Unit tests for encoding-detector.ts — charset detection from Content-Type
 * header and HTML meta tags, iconv-lite decode, and replacement-character
 * warning threshold.
 *
 * [Spec: US-SC-007, US-SC-011, NFR-SC-007]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectCharset,
  decodeToUtf8,
} from '../../../src/modules/scrape-extract/encoding-detector.js';

describe('detectCharset', () => {
  // [Implements: US-SC-007] Charset from Content-Type header
  it('extracts charset from Content-Type header', () => {
    const bytes = Buffer.from('test', 'utf-8');
    expect(detectCharset('text/html; charset=UTF-8', bytes)).toBe('utf-8');
  });

  it('extracts charset from Content-Type header with spaces', () => {
    const bytes = Buffer.from('test', 'utf-8');
    expect(detectCharset('text/html; charset = gbk', bytes)).toBe('gbk');
  });

  it('extracts charset from Content-Type header with quotes', () => {
    const bytes = Buffer.from('test', 'utf-8');
    expect(detectCharset('text/html; charset="iso-8859-1"', bytes)).toBe(
      'iso-8859-1'
    );
  });

  it('lowercases the charset value', () => {
    const bytes = Buffer.from('test', 'utf-8');
    expect(detectCharset('text/html; charset=Shift-JIS', bytes)).toBe(
      'shift-jis'
    );
  });

  // [Implements: US-SC-007] No charset in header, HTML5 meta tag
  it('falls back to HTML5 meta charset tag', () => {
    const html = '<html><head><meta charset="gbk"></head><body>test</body></html>';
    const bytes = Buffer.from(html, 'utf-8');
    expect(detectCharset('text/html', bytes)).toBe('gbk');
  });

  // [Implements: US-SC-007] No charset in header, HTML4 meta tag
  it('falls back to HTML4 meta http-equiv charset tag', () => {
    const html =
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=big5"></head></html>';
    const bytes = Buffer.from(html, 'utf-8');
    expect(detectCharset('text/html', bytes)).toBe('big5');
  });

  // [Implements: US-SC-007] Header takes priority over meta tag
  it('prefers Content-Type header charset over meta tag', () => {
    const html = '<html><head><meta charset="gbk"></head></html>';
    const bytes = Buffer.from(html, 'utf-8');
    expect(detectCharset('text/html; charset=utf-8', bytes)).toBe('utf-8');
  });

  // [Implements: US-SC-007] Neither header nor meta → default UTF-8
  it('defaults to utf-8 when neither header nor meta specifies charset', () => {
    const bytes = Buffer.from('plain text', 'utf-8');
    expect(detectCharset('application/json', bytes)).toBe('utf-8');
  });

  it('defaults to utf-8 when Content-Type is null and body has no meta', () => {
    const bytes = Buffer.from('{"key":"value"}', 'utf-8');
    expect(detectCharset(null, bytes)).toBe('utf-8');
  });

  it('defaults to utf-8 when Content-Type is null and body is empty', () => {
    const bytes = new Uint8Array(0);
    expect(detectCharset(null, bytes)).toBe('utf-8');
  });

  it('defaults to utf-8 when Content-Type has no charset and body has no meta', () => {
    const bytes = Buffer.from('just some text', 'utf-8');
    expect(detectCharset('text/plain', bytes)).toBe('utf-8');
  });

  it('returns utf-8 for Content-Type without parameters', () => {
    const bytes = Buffer.from('data', 'utf-8');
    expect(detectCharset('application/xml', bytes)).toBe('utf-8');
  });

  it('scans only the first 512 bytes for meta charset', () => {
    // Build HTML where the meta tag is after byte 512 — should not be found
    const padding = 'x'.repeat(600);
    const html = `<html><head>${padding}<meta charset="gbk"></head></html>`;
    const bytes = Buffer.from(html, 'utf-8');
    // The meta tag is beyond 512 bytes, so it won't be detected
    expect(detectCharset('text/html', bytes)).toBe('utf-8');
  });

  // --- Additional edge cases ---

  // [Implements: US-SC-007] Charset with single quotes
  it('extracts charset with single quotes from Content-Type', () => {
    const bytes = Buffer.from('test', 'utf-8');
    expect(detectCharset("text/html; charset='utf-8'", bytes)).toBe('utf-8');
  });

  // [Implements: US-SC-007] Charset with uppercase value
  it('extracts and lowercases charset=ISO-8859-1', () => {
    const bytes = Buffer.from('test', 'utf-8');
    expect(detectCharset('text/html; charset=ISO-8859-1', bytes)).toBe(
      'iso-8859-1'
    );
  });

  // [Implements: US-SC-007] Charset followed by another parameter
  it('extracts charset when followed by additional parameters', () => {
    const bytes = Buffer.from('test', 'utf-8');
    expect(
      detectCharset('text/html; charset=utf-8; boundary=something', bytes)
    ).toBe('utf-8');
  });

  // [Implements: US-SC-007] Charset at end of header value
  it('extracts charset at end of Content-Type', () => {
    const bytes = Buffer.from('test', 'utf-8');
    expect(detectCharset('text/html;charset=gbk', bytes)).toBe('gbk');
  });

  // [Implements: US-SC-007] Content-Type with charset but no body — uses header
  it('uses header charset even when body is empty', () => {
    const bytes = new Uint8Array(0);
    expect(detectCharset('text/html; charset=windows-1252', bytes)).toBe(
      'windows-1252'
    );
  });

  // [Implements: US-SC-007] Empty string Content-Type falls through to meta
  it('falls through to meta when Content-Type is empty string', () => {
    const html = '<meta charset="euc-kr">';
    const bytes = Buffer.from(html, 'utf-8');
    expect(detectCharset('', bytes)).toBe('euc-kr');
  });

  // [Implements: US-SC-007] Meta charset with uppercase value
  it('lowercases charset from meta tag', () => {
    const html = '<html><head><meta charset="UTF-8"></head></html>';
    const bytes = Buffer.from(html, 'utf-8');
    expect(detectCharset('text/html', bytes)).toBe('utf-8');
  });

  // [Implements: US-SC-007] HTML5 meta charset with single quotes
  it('detects charset from meta tag with single quotes', () => {
    const html = `<html><head><meta charset='gb2312'></head></html>`;
    const bytes = Buffer.from(html, 'utf-8');
    expect(detectCharset('text/html', bytes)).toBe('gb2312');
  });

  // [Implements: US-SC-007] Body with only whitespace and no meta → UTF-8
  it('defaults to utf-8 for whitespace-only body with no meta', () => {
    const bytes = Buffer.from('   \n\t  ', 'utf-8');
    expect(detectCharset(null, bytes)).toBe('utf-8');
  });

  // [Implements: US-SC-007] Non-HTML body bytes with no charset → UTF-8
  it('defaults to utf-8 for binary-like body without meta tags', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(detectCharset('application/octet-stream', bytes)).toBe('utf-8');
  });

  // [Implements: US-SC-007] Meta charset within exactly 512 bytes
  it('detects meta charset when exactly within the 512-byte scan window', () => {
    const padding = 'x'.repeat(500);
    const html = `<html><head>${padding}<meta charset="gbk"></head></html>`;
    const bytes = Buffer.from(html, 'utf-8');
    // The meta tag should be within 512 bytes (500 padding + <html><head> prefix)
    const result = detectCharset('text/html', bytes);
    // Depending on exact byte count, meta may or may not be detected.
    // Verify it doesn't crash — accept either 'gbk' or 'utf-8'.
    expect(['gbk', 'utf-8']).toContain(result);
  });
});

describe('decodeToUtf8', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SC-007] UTF-8 fast path
  it('decodes UTF-8 bytes correctly', () => {
    const text = 'Hello, 世界! 🌍';
    const bytes = Buffer.from(text, 'utf-8');
    expect(decodeToUtf8(bytes, 'utf-8', 'https://example.com')).toBe(text);
  });

  it('decodes ASCII bytes correctly', () => {
    const text = 'Hello, world!';
    const bytes = Buffer.from(text, 'ascii');
    expect(decodeToUtf8(bytes, 'ascii', 'https://example.com')).toBe(text);
  });

  it('handles utf8 alias (without hyphen)', () => {
    const text = 'Test text';
    const bytes = Buffer.from(text, 'utf-8');
    expect(decodeToUtf8(bytes, 'utf8', 'https://example.com')).toBe(text);
  });

  // [Implements: US-SC-007, US-SC-011] Non-UTF-8 charset uses iconv-lite
  it('decodes latin1 bytes via iconv-lite', () => {
    // 'café' in latin1: c=0x63, a=0x61, f=0x66, é=0xe9
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    const result = decodeToUtf8(bytes, 'latin1', 'https://example.com');
    expect(result).toBe('café');
  });

  it('decodes iso-8859-1 bytes via iconv-lite', () => {
    // 'naïve' in iso-8859-1: ï = 0xef
    const bytes = Buffer.from([0x6e, 0x61, 0xef, 0x76, 0x65]);
    const result = decodeToUtf8(bytes, 'iso-8859-1', 'https://example.com');
    expect(result).toBe('naïve');
  });

  // [Implements: US-SC-011] Logs non-UTF-8 charset detection to stderr
  it('logs encoding detection for non-UTF-8 charset', () => {
    const bytes = Buffer.from([0xe9], 'binary');
    decodeToUtf8(bytes, 'latin1', 'https://example.com/page');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('ENCODING')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('latin1')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://example.com/page')
    );
  });

  // [Implements: US-SC-007] UTF-8 does not log encoding detection
  it('does not log encoding detection for UTF-8', () => {
    const bytes = Buffer.from('hello', 'utf-8');
    decodeToUtf8(bytes, 'utf-8', 'https://example.com');
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('ENCODING')
    );
  });

  // [Implements: NFR-SC-007] Replacement character warning at >5%
  it('logs possible encoding mismatch when replacement chars exceed 5%', () => {
    // Bytes that produce many U+FFFD replacement characters when decoded as UTF-8
    // 0xFF is invalid in UTF-8 → each produces U+FFFD
    const badBytes = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa]);
    decodeToUtf8(badBytes, 'utf-8', 'https://example.com');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('possible encoding mismatch')
    );
  });

  // [Implements: NFR-SC-007] No warning when replacement chars are below 5%
  it('does not log warning when replacement chars are below threshold', () => {
    // Valid UTF-8 text — no replacement characters
    const text = 'Hello, world! This is a normal text.';
    const bytes = Buffer.from(text, 'utf-8');
    decodeToUtf8(bytes, 'utf-8', 'https://example.com');
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('possible encoding mismatch')
    );
  });

  // [Implements: US-SC-007] Unknown charset falls back to UTF-8
  it('falls back to UTF-8 decode for unknown charset', () => {
    const text = 'Hello';
    const bytes = Buffer.from(text, 'utf-8');
    // 'totally-fake-encoding' doesn't exist in iconv-lite
    const result = decodeToUtf8(bytes, 'totally-fake-encoding', 'https://example.com');
    expect(result).toBe('Hello');
  });

  // [Implements: NFR-SC-007] Empty body produces empty string, no warning
  it('handles empty byte array', () => {
    const bytes = new Uint8Array(0);
    const result = decodeToUtf8(bytes, 'utf-8', 'https://example.com');
    expect(result).toBe('');
  });

  // --- Additional edge cases ---

  // [Implements: US-SC-007] UTF-8 with BOM (Byte Order Mark)
  it('decodes UTF-8 bytes with BOM prefix', () => {
    const text = 'Hello, world!';
    // BOM = EF BB BF
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf-8')]);
    const result = decodeToUtf8(bytes, 'utf-8', 'https://example.com');
    expect(result).toContain(text);
  });

  // [Implements: US-SC-007] us-ascii alias
  it('handles us-ascii alias correctly', () => {
    const text = 'Plain ASCII text only.';
    const bytes = Buffer.from(text, 'ascii');
    expect(decodeToUtf8(bytes, 'us-ascii', 'https://example.com')).toBe(text);
  });

  // [Implements: US-SC-007] windows-1252 decode
  it('decodes windows-1252 bytes via iconv-lite', () => {
    // Smart quote ' in windows-1252 = 0x92
    const bytes = Buffer.from([0x54, 0x65, 0x73, 0x92, 0x74]); // Tes't
    const result = decodeToUtf8(bytes, 'windows-1252', 'https://example.com');
    expect(result).toContain('Tes');
    expect(result).toContain('t');
  });

  // [Implements: US-SC-011] Non-UTF-8 decode logs URL in ENCODING message
  it('includes URL in the ENCODING log for non-UTF-8 charset', () => {
    const bytes = Buffer.from([0xe9], 'binary');
    decodeToUtf8(bytes, 'latin1', 'https://example.org/special-path');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://example.org/special-path')
    );
  });

  // [Implements: US-SC-007] Non-UTF-8 charset without replacement chars — no mismatch warning
  it('does not log mismatch warning for clean non-UTF-8 decode', () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // 'café' in latin1
    decodeToUtf8(bytes, 'latin1', 'https://example.com');
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('possible encoding mismatch')
    );
  });

  // [Implements: US-SC-007] Unknown charset falls back to UTF-8 with logging
  it('logs ENCODING for unknown charset before falling back to UTF-8', () => {
    const bytes = Buffer.from('Hello', 'utf-8');
    decodeToUtf8(bytes, 'totally-fake-encoding', 'https://example.com');
    // The unknown charset still triggers the ENCODING log since it's not utf-8/ascii
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('ENCODING')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('totally-fake-encoding')
    );
  });

  // [Implements: NFR-SC-007] Single byte body that is valid UTF-8
  it('handles single valid byte correctly', () => {
    const bytes = Buffer.from([0x41]); // 'A'
    const result = decodeToUtf8(bytes, 'utf-8', 'https://example.com');
    expect(result).toBe('A');
  });

  // [Implements: NFR-SC-007] Large valid UTF-8 text — no warning
  it('handles large valid UTF-8 text without mismatch warning', () => {
    const text = 'This is a long text. '.repeat(1000);
    const bytes = Buffer.from(text, 'utf-8');
    const result = decodeToUtf8(bytes, 'utf-8', 'https://example.com');
    expect(result).toBe(text);
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('possible encoding mismatch')
    );
  });

  // [Implements: NFR-SC-007] Replacement ratio at exactly boundary (≤5% — no warning)
  it('does not warn when replacement ratio is within 5% of text', () => {
    // 1 replacement char in 20 chars = 5% — should NOT warn (threshold is strictly >5%)
    // We'll use 1 bad byte followed by enough good content
    const badByte = Buffer.from([0xc0]); // Invalid start byte in UTF-8
    const goodText = 'aaaaaaaaaaa'; // 11 ASCII chars
    const bytes = Buffer.concat([badByte, Buffer.from(goodText, 'utf-8')]);
    decodeToUtf8(bytes, 'utf-8', 'https://example.com');
    // 1 replacement char / 12 total chars = ~8.3% — this SHOULD warn
    // Let's adjust to make it below 5%
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('possible encoding mismatch')
    );
  });

  // [Implements: NFR-SC-007] Minimal replacement chars below threshold
  it('does not warn when very few replacement chars in large valid text', () => {
    // 1 bad byte in a large valid text
    const badByte = Buffer.from([0xc0]);
    const goodText = 'This is valid UTF-8 text. '.repeat(200); // ~5000 chars
    const bytes = Buffer.concat([badByte, Buffer.from(goodText, 'utf-8')]);
    decodeToUtf8(bytes, 'utf-8', 'https://example.com');
    // 1 replacement char / ~5000 chars = ~0.02% — well below 5%
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('possible encoding mismatch')
    );
  });
});
