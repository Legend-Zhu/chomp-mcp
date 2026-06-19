/**
 * Content-type router — dispatches fetched responses by Content-Type.
 *
 * Determines the content category (HTML, JSON, XML, plain text, or binary/
 * unsupported) from the Content-Type header. When the header is missing, the
 * router falls back to byte-sniffing the first 512 bytes of the body.
 *
 * For non-HTML types, text is extracted immediately:
 *   - JSON is parsed and formatted with indentation.
 *   - XML tags are stripped via cheerio.
 *   - Plain text / Markdown is returned as-is.
 *
 * Binary types return an error result. HTML returns `kind: 'html'` with a
 * `null` `textContent` so that the caller can proceed with Readability
 * extraction.
 *
 * [Spec: US-SC-009, DC-SC-002, DC-SC-005]
 */

import * as cheerio from 'cheerio';
import type { ContentTypeResult } from './types.js';
import type { ExtractionMethod } from '../../shared/types/scrape.js';

/**
 * Binary / unsupported MIME-type prefixes and exact values.
 *
 * If the primary content-type (sans parameters) starts with any of these
 * prefixes or matches an exact entry, the router returns a binary/unsupported
 * error result.
 */
const BINARY_PREFIXES = [
  'image/',
  'video/',
  'audio/',
  'font/',
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-gzip',
  'application/x-bzip2',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats',
  'application/x-binary',
  'application/x-shockwave-flash',
];

/** Number of leading body bytes to inspect when sniffing content type. */
const SNIFF_BYTES = 512;

/**
 * Extract the primary media type (type/subtype) from a raw Content-Type header
 * value, stripping any parameters (charset, boundary, etc.).
 *
 * Returns the lowercased type/subtype, or an empty string if the input is
 * falsy.
 *
 * @param contentType Raw Content-Type header value (e.g. "text/html; charset=utf-8").
 * @returns Lowercased "type/subtype" (e.g. "text/html"), or "" if input is null/empty.
 *
 * [Spec: US-SC-009]
 */
// [Implements: US-SC-009]
export function parsePrimaryContentType(
  contentType: string | null
): string {
  if (!contentType) {
    return '';
  }
  // Split on ';' to remove parameters like "; charset=utf-8"
  const semi = contentType.indexOf(';');
  const primary =
    semi >= 0 ? contentType.slice(0, semi) : contentType;
  return primary.trim().toLowerCase();
}

/**
 * Check whether a primary content-type is a binary or unsupported type.
 *
 * @param primary Lowercased "type/subtype" string.
 * @returns `true` if the type should be rejected as binary/unsupported.
 *
 * [Spec: US-SC-009]
 */
// [Implements: US-SC-009]
export function isBinaryType(primary: string): boolean {
  for (const prefix of BINARY_PREFIXES) {
    if (primary === prefix || primary.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Sniff the first bytes of a body to guess the content category when the
 * Content-Type header is missing.
 *
 * Checks for:
 *   - HTML: presence of `<html`, `<!doctype`, or `<body` (case-insensitive).
 *   - XML: starts with `<?xml`.
 *   - JSON: starts with `{` or `[`.
 *   - Otherwise: plain text.
 *
 * @param bodyText Decoded body text (at least the first 512 chars are examined).
 * @returns Detected content category: `'html' | 'json' | 'xml' | 'text'`.
 *
 * [Spec: US-SC-009]
 */
// [Implements: US-SC-009]
export function sniffContentType(bodyText: string): 'html' | 'json' | 'xml' | 'text' {
  const head = bodyText.slice(0, SNIFF_BYTES).toLowerCase();

  // Check for HTML signatures
  if (
    head.includes('<html') ||
    head.includes('<!doctype') ||
    head.includes('<body')
  ) {
    return 'html';
  }

  // Check for XML declaration
  const trimmed = head.trimStart();
  if (trimmed.startsWith('<?xml')) {
    return 'xml';
  }

  // Check for JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }

  // Default: plain text
  return 'text';
}

/**
 * Parse and pretty-print a JSON string.
 *
 * On successful parse, returns `JSON.stringify(obj, null, 2)` (indented).
 * If parsing fails, returns `null` so the caller can fall back to raw text.
 *
 * @param bodyText Raw body text expected to be JSON.
 * @returns Formatted JSON string, or `null` if parse fails.
 *
 * [Spec: US-SC-009]
 */
// [Implements: US-SC-009]
export function formatJson(bodyText: string): string | null {
  try {
    const obj = JSON.parse(bodyText);
    return JSON.stringify(obj, null, 2);
  } catch {
    return null;
  }
}

/**
 * Strip XML/HTML tags and return only text content, using cheerio.
 *
 * @param bodyText Raw body text expected to be XML.
 * @returns Extracted text content (may be empty string).
 *
 * [Spec: US-SC-009]
 */
// [Implements: US-SC-009]
export function stripXmlTags(bodyText: string): string {
  const $ = cheerio.load(bodyText, { xml: true });
  return $.text().trim();
}

/**
 * Route a fetched response by Content-Type and extract text for non-HTML types.
 *
 * Behavior:
 *   - `application/json`: Parse JSON → indented text. Falls back to raw text
 *     on parse failure.
 *   - `application/xml`, `text/xml`, `application/rss+xml`, `application/atom+xml`:
 *     Strip tags via cheerio.
 *   - `text/plain`, `text/markdown`: Return as-is.
 *   - Binary types (`image/*`, `application/pdf`, etc.): Return error.
 *   - `text/html` (or sniffed HTML): Return `kind: 'html'` with `null` text
 *     for further Readability extraction.
 *
 * When the Content-Type header is missing, the router sniffs the first 512
 * bytes of `bodyText` to detect HTML, JSON, XML, or plain text.
 *
 * @param contentType Raw Content-Type header value, or `null` if missing.
 * @param bodyText Decoded body text (post-encoding-conversion, pre-truncation).
 * @returns ContentTypeResult describing the detected category and extracted text.
 *
 * [Spec: US-SC-009, DC-SC-002]
 */
// [Implements: US-SC-009]
export function routeContent(
  contentType: string | null,
  bodyText: string
): ContentTypeResult {
  const primary = parsePrimaryContentType(contentType);

  // If we have a Content-Type header, route by it
  if (primary) {
    // Binary / unsupported types
    if (isBinaryType(primary)) {
      return {
        kind: 'binary',
        textContent: null,
        extractionMethod: null,
        error: `Unsupported content type: ${primary}`,
      };
    }

    // JSON
    if (primary === 'application/json') {
      const formatted = formatJson(bodyText);
      return {
        kind: 'json',
        textContent: formatted ?? bodyText,
        extractionMethod: 'json' as ExtractionMethod,
        error: null,
      };
    }

    // XML family
    if (
      primary === 'application/xml' ||
      primary === 'text/xml' ||
      primary === 'application/rss+xml' ||
      primary === 'application/atom+xml'
    ) {
      const stripped = stripXmlTags(bodyText);
      return {
        kind: 'xml',
        textContent: stripped,
        extractionMethod: 'xml' as ExtractionMethod,
        error: null,
      };
    }

    // Plain text / Markdown
    if (primary === 'text/plain' || primary === 'text/markdown') {
      return {
        kind: 'text',
        textContent: bodyText,
        extractionMethod: 'raw-text' as ExtractionMethod,
        error: null,
      };
    }

    // HTML — defer to Readability
    if (
      primary === 'text/html' ||
      primary === 'application/xhtml+xml'
    ) {
      return {
        kind: 'html',
        textContent: null,
        extractionMethod: null,
        error: null,
      };
    }

    // Any other text/* subtype — treat as plain text
    if (primary.startsWith('text/')) {
      return {
        kind: 'text',
        textContent: bodyText,
        extractionMethod: 'raw-text' as ExtractionMethod,
        error: null,
      };
    }

    // Unknown application/* or other type — try to sniff, else unsupported
    const sniffed = sniffContentType(bodyText);
    return routeBySniffedType(sniffed, bodyText, primary);
  }

  // No Content-Type header — sniff the body
  const sniffed = sniffContentType(bodyText);
  return routeBySniffedType(sniffed, bodyText, null);
}

/**
 * Build a ContentTypeResult from a sniffed content category.
 *
 * @param sniffed The sniffed category: 'html' | 'json' | 'xml' | 'text'.
 * @param bodyText Decoded body text.
 * @param fallbackContentType Original content-type for error message (or null).
 * @returns ContentTypeResult.
 *
 * [Spec: US-SC-009]
 */
// [Implements: US-SC-009]
function routeBySniffedType(
  sniffed: 'html' | 'json' | 'xml' | 'text',
  bodyText: string,
  fallbackContentType: string | null
): ContentTypeResult {
  switch (sniffed) {
    case 'html':
      return {
        kind: 'html',
        textContent: null,
        extractionMethod: null,
        error: null,
      };

    case 'json': {
      const formatted = formatJson(bodyText);
      return {
        kind: 'json',
        textContent: formatted ?? bodyText,
        extractionMethod: 'json' as ExtractionMethod,
        error: null,
      };
    }

    case 'xml': {
      const stripped = stripXmlTags(bodyText);
      return {
        kind: 'xml',
        textContent: stripped,
        extractionMethod: 'xml' as ExtractionMethod,
        error: null,
      };
    }

    case 'text':
      return {
        kind: 'text',
        textContent: bodyText,
        extractionMethod: 'raw-text' as ExtractionMethod,
        error: null,
      };

    default:
      return {
        kind: 'unsupported',
        textContent: null,
        extractionMethod: null,
        error: fallbackContentType
          ? `Unsupported content type: ${fallbackContentType}`
          : 'Unsupported content type: unknown',
      };
  }
}
