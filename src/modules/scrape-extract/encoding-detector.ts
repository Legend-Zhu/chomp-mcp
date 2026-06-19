/**
 * Encoding detector with charset conversion for the scrape-extract (SC) module.
 *
 * Detects character encoding from the Content-Type header, falls back to
 * HTML meta tag inspection, and defaults to UTF-8. Uses iconv-lite to
 * decode non-UTF-8 byte streams (GBK, Shift-JIS, Big5, Latin-1, etc.) to
 * UTF-8 strings. Logs a warning to stderr if replacement characters
 * exceed 5% of total output.
 *
 * [Spec: US-SC-007, US-SC-011, NFR-SC-007]
 */

import iconv from 'iconv-lite';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Replacement character U+FFFD — emitted when decoding encounters invalid bytes. */
const REPLACEMENT_CHAR = '\uFFFD';

/** Maximum number of leading body bytes to scan for meta charset declarations. */
const META_SCAN_BYTES = 512;

/** Fraction of replacement characters (U+FFFD) in decoded text above which a warning is logged. */
const REPLACEMENT_RATIO_THRESHOLD = 0.05;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the `charset` value from a Content-Type string (e.g.
 * `"text/html; charset=UTF-8"` → `"utf-8"`).
 *
 * Returns the lowercased charset value, or `null` when absent.
 *
 * [Constraint: NFR-SC-007]
 */
function parseCharsetFromContentType(contentType: string): string | null {
  const match = /charset\s*=\s*["']?([^\s"';,]+)/i.exec(contentType);
  if (match?.[1]) {
    return match[1].trim().toLowerCase();
  }
  return null;
}

/**
 * Scan the first ~512 bytes of the body for an HTML meta charset declaration.
 *
 * Handles both HTML5 (`<meta charset="...">`) and HTML4
 * (`<meta http-equiv="Content-Type" content="...; charset=...">`) syntax
 * via a single unified pattern that matches `charset=` inside any `<meta>` tag.
 *
 * Returns the lowercased charset value, or `null` when no declaration is found.
 *
 * [Constraint: NFR-SC-007]
 */
function scanMetaCharset(bodyBytes: Uint8Array): string | null {
  const scanLength = Math.min(bodyBytes.length, META_SCAN_BYTES);
  // Decode as latin1 (1:1 byte-to-char mapping) for ASCII tag scanning.
  const head = Buffer.from(bodyBytes.subarray(0, scanLength)).toString('latin1');

  const match = /<meta[^>]*charset\s*=\s*["']?\s*([^\s"'/>]+)/i.exec(head);
  if (match?.[1]) {
    return match[1].trim().toLowerCase();
  }
  return null;
}

/**
 * Determine whether a charset name is effectively UTF-8 or ASCII.
 *
 * These encodings are handled by the native `TextDecoder` fast path and do
 * not require iconv-lite.
 *
 * [Constraint: NFR-SC-007]
 */
function isUtf8OrAscii(charset: string): boolean {
  const c = charset.toLowerCase().trim();
  return c === 'utf-8' || c === 'utf8' || c === 'ascii' || c === 'us-ascii';
}

/**
 * Count U+FFFD replacement characters in the decoded text.
 * If the ratio exceeds 5%, log a warning to stderr.
 *
 * [Implements: NFR-SC-007]
 */
function checkReplacementRatio(text: string, url: string): void {
  if (text.length === 0) {
    return;
  }

  let count = 0;
  let pos = text.indexOf(REPLACEMENT_CHAR);
  while (pos !== -1) {
    count++;
    pos = text.indexOf(REPLACEMENT_CHAR, pos + REPLACEMENT_CHAR.length);
  }

  if (count > 0 && count / text.length > REPLACEMENT_RATIO_THRESHOLD) {
    process.stderr.write(`[scrape] possible encoding mismatch for ${url}\n`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the character encoding of an HTTP response body.
 *
 * Detection priority:
 * 1. `charset` parameter in the `Content-Type` header.
 * 2. HTML `<meta charset="...">` tag in the first ~512 bytes of the body.
 * 3. Default: `'utf-8'`.
 *
 * Always returns a lowercased charset label suitable for iconv-lite or
 * TextDecoder.
 *
 * @param contentType Value of the `Content-Type` response header (may be `null`).
 * @param bodyBytes    Raw response body bytes.
 * @returns            Lowercased charset label (e.g. `'utf-8'`, `'gbk'`).
 *
 * [Implements: US-SC-007]
 * [Constraint: NFR-SC-007]
 */
export function detectCharset(
  contentType: string | null,
  bodyBytes: Uint8Array
): string {
  // 1 — Content-Type header
  if (contentType) {
    const headerCharset = parseCharsetFromContentType(contentType);
    if (headerCharset) {
      return headerCharset;
    }
  }

  // 2 — HTML meta tag
  if (bodyBytes.length > 0) {
    const metaCharset = scanMetaCharset(bodyBytes);
    if (metaCharset) {
      return metaCharset;
    }
  }

  // 3 — Default
  return 'utf-8';
}

/**
 * Decode a byte stream to a UTF-8 string using the detected charset.
 *
 * For UTF-8/ASCII content, uses the native `TextDecoder` (fast path).
 * For all other charsets (GBK, Shift-JIS, Big5, Latin-1, etc.), uses
 * `iconv-lite`. Unknown charset names fall back to UTF-8 with replacement
 * characters.
 *
 * Logs to stderr when:
 * - A non-UTF-8 charset is detected: `[scrape] ENCODING {url} charset={charset}`.
 * - Replacement characters exceed 5% of the decoded text:
 *   `[scrape] possible encoding mismatch for {url}`.
 *
 * @param bodyBytes Raw response body bytes.
 * @param charset   Detected charset label (from `detectCharset`).
 * @param url       Source URL for diagnostic logging.
 * @returns         Decoded UTF-8 string.
 *
 * [Implements: US-SC-007, US-SC-011, NFR-SC-007]
 */
export function decodeToUtf8(
  bodyBytes: Uint8Array,
  charset: string,
  url: string
): string {
  // Fast path for UTF-8 / ASCII
  if (isUtf8OrAscii(charset)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes);
    checkReplacementRatio(text, url);
    return text;
  }

  // Log non-UTF-8 charset detection
  // [Implements: US-SC-011]
  process.stderr.write(`[scrape] ENCODING ${url} charset=${charset}\n`);

  // iconv-lite path for non-UTF-8 charsets
  let text: string;
  if (iconv.encodingExists(charset)) {
    text = iconv.decode(Buffer.from(bodyBytes), charset);
  } else {
    // Unknown charset — fall back to lenient UTF-8 decode
    text = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes);
  }

  // Check for excessive replacement characters
  // [Implements: NFR-SC-007]
  checkReplacementRatio(text, url);

  return text;
}
