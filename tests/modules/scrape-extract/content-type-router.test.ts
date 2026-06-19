/**
 * Unit tests for content-type-router.ts — HTML/JSON/XML/text/binary routing,
 * byte sniffing for missing Content-Type, and text extraction per type.
 *
 * [Spec: US-SC-009, DC-SC-002, DC-SC-005]
 */

import { describe, it, expect } from 'vitest';
import {
  parsePrimaryContentType,
  isBinaryType,
  sniffContentType,
  formatJson,
  stripXmlTags,
  routeContent,
} from '../../../src/modules/scrape-extract/content-type-router.js';

// ---------------------------------------------------------------------------
// parsePrimaryContentType
// ---------------------------------------------------------------------------

describe('parsePrimaryContentType', () => {
  // [Implements: US-SC-009]
  it('extracts type/subtype without parameters', () => {
    expect(parsePrimaryContentType('text/html; charset=utf-8')).toBe('text/html');
  });

  it('extracts type/subtype without parameters (multiple params)', () => {
    expect(
      parsePrimaryContentType('multipart/form-data; boundary=something; charset=utf-8')
    ).toBe('multipart/form-data');
  });

  it('returns lowercased type/subtype', () => {
    expect(parsePrimaryContentType('TEXT/HTML')).toBe('text/html');
  });

  it('returns the value as-is when no parameters present', () => {
    expect(parsePrimaryContentType('application/json')).toBe('application/json');
  });

  it('trims whitespace', () => {
    expect(parsePrimaryContentType('  text/plain  ')).toBe('text/plain');
  });

  it('returns empty string for null', () => {
    expect(parsePrimaryContentType(null)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(parsePrimaryContentType('')).toBe('');
  });

  // --- Additional edge cases ---

  it('handles content-type with only semicolon', () => {
    expect(parsePrimaryContentType('application/json;')).toBe('application/json');
  });

  it('lowercases mixed-case type and subtype', () => {
    expect(parsePrimaryContentType('Application/JSON')).toBe('application/json');
  });

  it('handles content-type with boundary value containing semicolons', () => {
    expect(
      parsePrimaryContentType('multipart/form-data; boundary=----WebKitForm')
    ).toBe('multipart/form-data');
  });

  it('handles content-type with trailing semicolon and spaces', () => {
    expect(parsePrimaryContentType('text/html;  ')).toBe('text/html');
  });
});

// ---------------------------------------------------------------------------
// isBinaryType
// ---------------------------------------------------------------------------

describe('isBinaryType', () => {
  // [Implements: US-SC-009]
  it('detects image types as binary', () => {
    expect(isBinaryType('image/png')).toBe(true);
    expect(isBinaryType('image/jpeg')).toBe(true);
    expect(isBinaryType('image/gif')).toBe(true);
    expect(isBinaryType('image/svg+xml')).toBe(true);
  });

  it('detects video types as binary', () => {
    expect(isBinaryType('video/mp4')).toBe(true);
  });

  it('detects audio types as binary', () => {
    expect(isBinaryType('audio/mpeg')).toBe(true);
  });

  it('detects font types as binary', () => {
    expect(isBinaryType('font/woff2')).toBe(true);
  });

  it('detects application/pdf as binary', () => {
    expect(isBinaryType('application/pdf')).toBe(true);
  });

  it('detects application/octet-stream as binary', () => {
    expect(isBinaryType('application/octet-stream')).toBe(true);
  });

  it('detects application/zip as binary', () => {
    expect(isBinaryType('application/zip')).toBe(true);
  });

  it('detects Office document types as binary', () => {
    expect(isBinaryType('application/msword')).toBe(true);
    expect(isBinaryType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });

  it('returns false for text/html', () => {
    expect(isBinaryType('text/html')).toBe(false);
  });

  it('returns false for application/json', () => {
    expect(isBinaryType('application/json')).toBe(false);
  });

  it('returns false for text/xml', () => {
    expect(isBinaryType('text/xml')).toBe(false);
  });

  it('returns false for text/plain', () => {
    expect(isBinaryType('text/plain')).toBe(false);
  });

  // --- Additional edge cases ---

  it('detects additional image subtypes as binary', () => {
    expect(isBinaryType('image/webp')).toBe(true);
    expect(isBinaryType('image/tiff')).toBe(true);
    expect(isBinaryType('image/bmp')).toBe(true);
  });

  it('detects additional video subtypes as binary', () => {
    expect(isBinaryType('video/webm')).toBe(true);
    expect(isBinaryType('video/ogg')).toBe(true);
    expect(isBinaryType('video/x-msvideo')).toBe(true);
  });

  it('detects additional audio subtypes as binary', () => {
    expect(isBinaryType('audio/ogg')).toBe(true);
    expect(isBinaryType('audio/wav')).toBe(true);
  });

  it('detects additional font subtypes as binary', () => {
    expect(isBinaryType('font/ttf')).toBe(true);
    expect(isBinaryType('font/otf')).toBe(true);
  });

  it('detects application/gzip as binary', () => {
    expect(isBinaryType('application/gzip')).toBe(true);
  });

  it('detects application/x-tar as binary', () => {
    expect(isBinaryType('application/x-tar')).toBe(true);
  });

  it('detects application/vnd.ms-excel as binary', () => {
    expect(isBinaryType('application/vnd.ms-excel')).toBe(true);
  });

  it('detects application/vnd.ms-powerpoint as binary', () => {
    expect(isBinaryType('application/vnd.ms-powerpoint')).toBe(true);
  });

  it('detects application/x-shockwave-flash as binary', () => {
    expect(isBinaryType('application/x-shockwave-flash')).toBe(true);
  });

  it('returns false for application/rss+xml', () => {
    expect(isBinaryType('application/rss+xml')).toBe(false);
  });

  it('returns false for application/atom+xml', () => {
    expect(isBinaryType('application/atom+xml')).toBe(false);
  });

  it('returns false for application/xhtml+xml', () => {
    expect(isBinaryType('application/xhtml+xml')).toBe(false);
  });

  it('returns false for application/xml', () => {
    expect(isBinaryType('application/xml')).toBe(false);
  });

  it('returns false for text/markdown', () => {
    expect(isBinaryType('text/markdown')).toBe(false);
  });

  it('returns false for text/csv', () => {
    expect(isBinaryType('text/csv')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sniffContentType
// ---------------------------------------------------------------------------

describe('sniffContentType', () => {
  // [Implements: US-SC-009] HTML detection
  it('detects HTML by <html> tag', () => {
    expect(sniffContentType('<html><body>Hello</body></html>')).toBe('html');
  });

  it('detects HTML by <!doctype> declaration', () => {
    expect(sniffContentType('<!DOCTYPE html>\n<html>')).toBe('html');
  });

  it('detects HTML by <body> tag', () => {
    expect(sniffContentType('<body>Content</body>')).toBe('html');
  });

  it('detects HTML case-insensitively', () => {
    expect(sniffContentType('<HTML><BODY>Test</BODY></HTML>')).toBe('html');
  });

  // [Implements: US-SC-009] XML detection
  it('detects XML by <?xml declaration', () => {
    expect(sniffContentType('<?xml version="1.0"?><root/>')).toBe('xml');
  });

  // [Implements: US-SC-009] JSON detection
  it('detects JSON starting with {', () => {
    expect(sniffContentType('{"key": "value"}')).toBe('json');
  });

  it('detects JSON starting with [', () => {
    expect(sniffContentType('[1, 2, 3]')).toBe('json');
  });

  // [Implements: US-SC-009] Plain text detection
  it('defaults to text for unrecognized content', () => {
    expect(sniffContentType('Hello, this is plain text.')).toBe('text');
  });

  it('defaults to text for empty string', () => {
    expect(sniffContentType('')).toBe('text');
  });

  it('handles leading whitespace before JSON/XML markers', () => {
    expect(sniffContentType('  \n {"a":1}')).toBe('json');
    expect(sniffContentType('  \n<?xml version="1.0"?>')).toBe('xml');
  });

  // --- Additional edge cases ---

  // [Implements: US-SC-009] <!DOCTYPE with lowercase
  it('detects lowercase <!doctype html>', () => {
    expect(sniffContentType('<!doctype html>')).toBe('html');
  });

  // [Implements: US-SC-009] HTML detection priority over JSON
  it('detects HTML over JSON when both markers present', () => {
    // HTML markers are checked first
    expect(sniffContentType('<html>{"not json": true}</html>')).toBe('html');
  });

  // [Implements: US-SC-009] JSON with nested array inside object
  it('detects JSON with object containing arrays', () => {
    expect(sniffContentType('{"items": [1, 2, 3]}')).toBe('json');
  });

  // [Implements: US-SC-009] Tab as leading whitespace
  it('handles leading tab before JSON marker', () => {
    expect(sniffContentType('\t{"key": 1}')).toBe('json');
  });

  // [Implements: US-SC-009] Multiple leading whitespace chars
  it('handles mixed leading whitespace before markers', () => {
    expect(sniffContentType('  \r\n\t  <html>')).toBe('html');
  });

  // [Implements: US-SC-009] Whitespace-only string defaults to text
  it('defaults to text for whitespace-only string', () => {
    expect(sniffContentType('   \n\t  ')).toBe('text');
  });

  // [Implements: US-SC-009] XML with standalone attribute
  it('detects XML with standalone attribute', () => {
    expect(sniffContentType('<?xml version="1.0" standalone="yes"?><root/>')).toBe(
      'xml'
    );
  });

  // [Implements: US-SC-009] XML with encoding attribute
  it('detects XML with encoding attribute', () => {
    expect(
      sniffContentType('<?xml version="1.0" encoding="UTF-8"?><feed/>')
    ).toBe('xml');
  });

  // [Implements: US-SC-009] JSON number-only is not detected as JSON
  it('defaults to text for content starting with a number', () => {
    expect(sniffContentType('12345 text')).toBe('text');
  });

  // [Implements: US-SC-009] HTML <HEAD tag detection
  it('does not detect <head> alone as html (only <html>, <body>, <!doctype>)', () => {
    // Only <html>, <body>, and <!doctype> are HTML markers
    expect(sniffContentType('<head><title>Test</title></head>')).toBe('text');
  });

  // [Implements: US-SC-009] JSON with leading whitespace and bracket
  it('detects JSON array with leading whitespace', () => {
    expect(sniffContentType('  [1, 2]')).toBe('json');
  });
});

// ---------------------------------------------------------------------------
// formatJson
// ---------------------------------------------------------------------------

describe('formatJson', () => {
  // [Implements: US-SC-009]
  it('formats valid JSON with indentation', () => {
    const result = formatJson('{"name":"test","value":42}');
    expect(result).not.toBeNull();
    expect(result).toContain('"name": "test"');
    expect(result).toContain('"value": 42');
    expect(result).toContain('\n');
  });

  it('formats nested objects', () => {
    const result = formatJson('{"a":{"b":[1,2]}}');
    expect(result).not.toBeNull();
    expect(result).toContain('"a"');
    expect(result).toContain('"b"');
  });

  it('returns null for invalid JSON', () => {
    expect(formatJson('not json')).toBeNull();
  });

  it('returns null for incomplete JSON', () => {
    expect(formatJson('{"key":')).toBeNull();
  });

  it('formats JSON arrays', () => {
    const result = formatJson('[1, 2, 3]');
    expect(result).not.toBeNull();
    expect(result).toContain('1');
    expect(result).toContain('2');
    expect(result).toContain('3');
  });

  // --- Additional edge cases ---

  it('formats empty JSON object', () => {
    const result = formatJson('{}');
    expect(result).toBe('{}');
  });

  it('formats empty JSON array', () => {
    const result = formatJson('[]');
    expect(result).toBe('[]');
  });

  it('formats JSON with string values', () => {
    const result = formatJson('{"greeting":"hello world"}');
    expect(result).not.toBeNull();
    expect(result).toContain('"greeting": "hello world"');
  });

  it('formats JSON with boolean and null values', () => {
    const result = formatJson('{"active":true,"deleted":null}');
    expect(result).not.toBeNull();
    expect(result).toContain('"active": true');
    expect(result).toContain('"deleted": null');
  });

  it('formats JSON with deeply nested structures', () => {
    const result = formatJson('{"a":{"b":{"c":{"d":1}}}}');
    expect(result).not.toBeNull();
    expect(result).toContain('"d": 1');
  });

  it('formats JSON with array of objects', () => {
    const result = formatJson('[{"x":1},{"y":2}]');
    expect(result).not.toBeNull();
    expect(result).toContain('"x": 1');
    expect(result).toContain('"y": 2');
  });

  it('returns null for empty string', () => {
    expect(formatJson('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(formatJson('   ')).toBeNull();
  });

  it('handles JSON number input', () => {
    const result = formatJson('42');
    expect(result).toBe('42');
  });

  it('handles JSON string input', () => {
    const result = formatJson('"hello"');
    expect(result).toBe('"hello"');
  });

  it('handles JSON null input', () => {
    const result = formatJson('null');
    expect(result).toBe('null');
  });

  it('handles JSON true/false input', () => {
    expect(formatJson('true')).toBe('true');
    expect(formatJson('false')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// stripXmlTags
// ---------------------------------------------------------------------------

describe('stripXmlTags', () => {
  // [Implements: US-SC-009]
  it('extracts text from simple XML', () => {
    const result = stripXmlTags('<root>Hello World</root>');
    expect(result).toBe('Hello World');
  });

  it('extracts text from nested elements', () => {
    const result = stripXmlTags('<root><item>Hello</item><item>World</item></root>');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('extracts text from XML with attributes', () => {
    const result = stripXmlTags('<root attr="val">Content</root>');
    expect(result).toBe('Content');
  });

  it('handles XML with declaration', () => {
    const result = stripXmlTags('<?xml version="1.0"?><root>Data</root>');
    expect(result).toBe('Data');
  });

  it('returns empty string for XML with no text content', () => {
    const result = stripXmlTags('<root></root>');
    expect(result).toBe('');
  });

  // --- Additional edge cases ---

  it('extracts text from self-closing tags', () => {
    const result = stripXmlTags('<root><empty/>Text Here</root>');
    expect(result).toContain('Text Here');
  });

  it('handles XML with CDATA section', () => {
    const result = stripXmlTags('<root><![CDATA[Hello CDATA]]></root>');
    expect(result).toContain('Hello CDATA');
  });

  it('extracts text from deeply nested XML', () => {
    const xml = '<a><b><c><d>Deep Text</d></c></b></a>';
    expect(stripXmlTags(xml)).toContain('Deep Text');
  });

  it('extracts text from XML with multiple root-level elements', () => {
    const xml = '<item>One</item><item>Two</item>';
    const result = stripXmlTags(xml);
    expect(result).toContain('One');
    expect(result).toContain('Two');
  });

  it('returns empty string for empty input', () => {
    expect(stripXmlTags('')).toBe('');
  });

  it('handles XML-like content with mixed text and tags', () => {
    const xml = '<p>Start <b>bold</b> middle <i>italic</i> end</p>';
    const result = stripXmlTags(xml);
    expect(result).toContain('Start');
    expect(result).toContain('bold');
    expect(result).toContain('middle');
    expect(result).toContain('italic');
    expect(result).toContain('end');
  });

  it('extracts text from XML with namespace prefixes', () => {
    const xml = '<ns:root xmlns:ns="http://example.com"><ns:item>Namespaced</ns:item></ns:root>';
    const result = stripXmlTags(xml);
    expect(result).toContain('Namespaced');
  });

  it('trims whitespace from extracted text', () => {
    const result = stripXmlTags('<root>  Spaced Text  </root>');
    expect(result).toBe('Spaced Text');
  });
});

// ---------------------------------------------------------------------------
// routeContent
// ---------------------------------------------------------------------------

describe('routeContent', () => {
  // [Implements: US-SC-009] JSON routing
  it('routes application/json with parsed and formatted text', () => {
    const result = routeContent('application/json', '{"key":"value"}');
    expect(result.kind).toBe('json');
    expect(result.extractionMethod).toBe('json');
    expect(result.error).toBeNull();
    expect(result.textContent).toContain('"key": "value"');
  });

  it('routes application/json with charset parameter', () => {
    const result = routeContent('application/json; charset=utf-8', '{"a":1}');
    expect(result.kind).toBe('json');
    expect(result.extractionMethod).toBe('json');
  });

  it('falls back to raw text when JSON is invalid', () => {
    const result = routeContent('application/json', 'not valid json');
    expect(result.kind).toBe('json');
    expect(result.extractionMethod).toBe('json');
    expect(result.textContent).toBe('not valid json');
  });

  // [Implements: US-SC-009] XML routing
  it('routes application/xml with stripped tags', () => {
    const result = routeContent('application/xml', '<root>Hello</root>');
    expect(result.kind).toBe('xml');
    expect(result.extractionMethod).toBe('xml');
    expect(result.error).toBeNull();
    expect(result.textContent).toContain('Hello');
  });

  it('routes text/xml with stripped tags', () => {
    const result = routeContent('text/xml', '<root>Data</root>');
    expect(result.kind).toBe('xml');
    expect(result.extractionMethod).toBe('xml');
  });

  it('routes application/rss+xml with stripped tags', () => {
    const result = routeContent(
      'application/rss+xml',
      '<rss><channel><title>Feed</title></channel></rss>'
    );
    expect(result.kind).toBe('xml');
    expect(result.extractionMethod).toBe('xml');
    expect(result.textContent).toContain('Feed');
  });

  it('routes application/atom+xml with stripped tags', () => {
    const result = routeContent('application/atom+xml', '<feed><title>Atom</title></feed>');
    expect(result.kind).toBe('xml');
    expect(result.extractionMethod).toBe('xml');
  });

  // [Implements: US-SC-009] Plain text routing
  it('routes text/plain as raw text', () => {
    const result = routeContent('text/plain', 'Hello, plain text!');
    expect(result.kind).toBe('text');
    expect(result.extractionMethod).toBe('raw-text');
    expect(result.error).toBeNull();
    expect(result.textContent).toBe('Hello, plain text!');
  });

  it('routes text/plain with charset parameter', () => {
    const result = routeContent('text/plain; charset=utf-8', 'data');
    expect(result.kind).toBe('text');
    expect(result.extractionMethod).toBe('raw-text');
  });

  // [Implements: US-SC-009] Markdown routing
  it('routes text/markdown as raw text', () => {
    const md = '# Title\n\nSome **bold** text.';
    const result = routeContent('text/markdown', md);
    expect(result.kind).toBe('text');
    expect(result.extractionMethod).toBe('raw-text');
    expect(result.textContent).toBe(md);
  });

  // [Implements: US-SC-009] Other text/* subtypes treated as plain text
  it('routes text/csv as raw text', () => {
    const result = routeContent('text/csv', 'a,b,c\n1,2,3');
    expect(result.kind).toBe('text');
    expect(result.extractionMethod).toBe('raw-text');
    expect(result.textContent).toBe('a,b,c\n1,2,3');
  });

  // [Implements: US-SC-009] Binary routing
  it('routes application/pdf as binary with error', () => {
    const result = routeContent('application/pdf', '');
    expect(result.kind).toBe('binary');
    expect(result.textContent).toBeNull();
    expect(result.extractionMethod).toBeNull();
    expect(result.error).toBe('Unsupported content type: application/pdf');
  });

  it('routes image/png as binary with error', () => {
    const result = routeContent('image/png', '');
    expect(result.kind).toBe('binary');
    expect(result.error).toBe('Unsupported content type: image/png');
  });

  it('routes application/octet-stream as binary', () => {
    const result = routeContent('application/octet-stream', '');
    expect(result.kind).toBe('binary');
    expect(result.error).toContain('Unsupported content type');
  });

  it('routes application/zip as binary', () => {
    const result = routeContent('application/zip', '');
    expect(result.kind).toBe('binary');
  });

  it('includes the primary content type in the binary error message', () => {
    const result = routeContent('application/pdf; charset=binary', '');
    expect(result.error).toBe('Unsupported content type: application/pdf');
  });

  // [Implements: US-SC-009] HTML routing
  it('routes text/html with null textContent for Readability', () => {
    const html = '<html><body><p>Content</p></body></html>';
    const result = routeContent('text/html', html);
    expect(result.kind).toBe('html');
    expect(result.textContent).toBeNull();
    expect(result.extractionMethod).toBeNull();
    expect(result.error).toBeNull();
  });

  it('routes application/xhtml+xml as html', () => {
    const xhtml = '<?xml version="1.0"?><html><body>Test</body></html>';
    const result = routeContent('application/xhtml+xml', xhtml);
    expect(result.kind).toBe('html');
    expect(result.textContent).toBeNull();
  });

  // [Implements: US-SC-009] Missing Content-Type → byte sniffing
  it('sniffs HTML when Content-Type is null', () => {
    const html = '<html><body>Sniffed</body></html>';
    const result = routeContent(null, html);
    expect(result.kind).toBe('html');
    expect(result.textContent).toBeNull();
  });

  it('sniffs HTML from <!doctype> when Content-Type is null', () => {
    const html = '<!DOCTYPE html>\n<html><body>Page</body></html>';
    const result = routeContent(null, html);
    expect(result.kind).toBe('html');
  });

  it('sniffs JSON when Content-Type is null', () => {
    const result = routeContent(null, '{"key": "value"}');
    expect(result.kind).toBe('json');
    expect(result.extractionMethod).toBe('json');
    expect(result.textContent).toContain('"key": "value"');
  });

  it('sniffs XML when Content-Type is null', () => {
    const xml = '<?xml version="1.0"?><root>Data</root>';
    const result = routeContent(null, xml);
    expect(result.kind).toBe('xml');
    expect(result.extractionMethod).toBe('xml');
  });

  it('sniffs plain text when Content-Type is null', () => {
    const result = routeContent(null, 'Just plain text content');
    expect(result.kind).toBe('text');
    expect(result.extractionMethod).toBe('raw-text');
    expect(result.textContent).toBe('Just plain text content');
  });

  // [Implements: US-SC-009] Unknown content type with sniffing fallback
  it('sniffs HTML for unknown content type with HTML body', () => {
    const html = '<html><body>Content</body></html>';
    const result = routeContent('application/foo', html);
    expect(result.kind).toBe('html');
  });

  it('sniffs text for unknown content type with plain text body', () => {
    const result = routeContent('application/custom', 'some text here');
    expect(result.kind).toBe('text');
    expect(result.extractionMethod).toBe('raw-text');
  });

  // --- Additional edge cases ---

  // [Implements: US-SC-009] JSON with nested object formatting
  it('formats nested JSON objects in routeContent', () => {
    const result = routeContent('application/json', '{"data":{"nested":true}}');
    expect(result.kind).toBe('json');
    expect(result.textContent).toContain('"nested": true');
  });

  // [Implements: US-SC-009] JSON array routing
  it('routes JSON array content', () => {
    const result = routeContent('application/json', '[1, 2, 3]');
    expect(result.kind).toBe('json');
    expect(result.textContent).not.toBeNull();
    expect(result.textContent).toContain('1');
  });

  // [Implements: US-SC-009] text/event-stream treated as text
  it('routes text/event-stream as raw text', () => {
    const result = routeContent('text/event-stream', 'data: hello\n\n');
    expect(result.kind).toBe('text');
    expect(result.extractionMethod).toBe('raw-text');
  });

  // [Implements: US-SC-009] text/css treated as text
  it('routes text/css as raw text', () => {
    const result = routeContent('text/css', '.class { color: red; }');
    expect(result.kind).toBe('text');
    expect(result.extractionMethod).toBe('raw-text');
  });

  // [Implements: US-SC-009] text/javascript treated as text
  it('routes text/javascript as raw text', () => {
    const result = routeContent('text/javascript', 'console.log("hi");');
    expect(result.kind).toBe('text');
    expect(result.extractionMethod).toBe('raw-text');
  });

  // [Implements: US-SC-009] Binary with body text — still binary
  it('routes image/jpeg as binary even with non-empty body', () => {
    const result = routeContent('image/jpeg', 'not actually an image');
    expect(result.kind).toBe('binary');
    expect(result.textContent).toBeNull();
    expect(result.error).toBe('Unsupported content type: image/jpeg');
  });

  // [Implements: US-SC-009] video/mp4 binary routing
  it('routes video/mp4 as binary', () => {
    const result = routeContent('video/mp4', '');
    expect(result.kind).toBe('binary');
    expect(result.error).toBe('Unsupported content type: video/mp4');
  });

  // [Implements: US-SC-009] audio/mpeg binary routing
  it('routes audio/mpeg as binary', () => {
    const result = routeContent('audio/mpeg', '');
    expect(result.kind).toBe('binary');
    expect(result.error).toBe('Unsupported content type: audio/mpeg');
  });

  // [Implements: US-SC-009] font/woff binary routing
  it('routes font/woff as binary', () => {
    const result = routeContent('font/woff', '');
    expect(result.kind).toBe('binary');
  });

  // [Implements: US-SC-009] application/gzip binary routing
  it('routes application/gzip as binary', () => {
    const result = routeContent('application/gzip', '');
    expect(result.kind).toBe('binary');
  });

  // [Implements: US-SC-009] Unknown application/* sniffs JSON body
  it('sniffs JSON for unknown application type with JSON body', () => {
    const result = routeContent('application/custom', '{"sniffed": true}');
    expect(result.kind).toBe('json');
    expect(result.extractionMethod).toBe('json');
  });

  // [Implements: US-SC-009] Unknown application/* sniffs XML body
  it('sniffs XML for unknown application type with XML body', () => {
    const result = routeContent('application/custom', '<?xml version="1.0"?><root/>');
    expect(result.kind).toBe('xml');
    expect(result.extractionMethod).toBe('xml');
  });

  // [Implements: US-SC-009] Sniffed JSON falls back to raw on invalid JSON
  it('falls back to raw text when sniffed JSON is invalid', () => {
    const result = routeContent('application/custom', '{invalid json content}');
    expect(result.kind).toBe('json');
    expect(result.textContent).toBe('{invalid json content}');
  });

  // [Implements: US-SC-009] Empty body with null Content-Type sniffs as text
  it('sniffs empty body as text when Content-Type is null', () => {
    const result = routeContent(null, '');
    expect(result.kind).toBe('text');
    expect(result.extractionMethod).toBe('raw-text');
    expect(result.textContent).toBe('');
  });

  // [Implements: US-SC-009] Whitespace body with null Content-Type sniffs as text
  it('sniffs whitespace-only body as text', () => {
    const result = routeContent(null, '   \n  ');
    expect(result.kind).toBe('text');
  });

  // [Implements: US-SC-009] text/html with parameters
  it('routes text/html with charset parameter as html', () => {
    const result = routeContent('text/html; charset=iso-8859-1', '<html></html>');
    expect(result.kind).toBe('html');
    expect(result.textContent).toBeNull();
  });

  // [Implements: US-SC-009] application/xhtml+xml with parameters
  it('routes application/xhtml+xml with parameters as html', () => {
    const result = routeContent(
      'application/xhtml+xml; charset=utf-8',
      '<html><body>XHTML</body></html>'
    );
    expect(result.kind).toBe('html');
    expect(result.textContent).toBeNull();
  });

  // [Implements: US-SC-009] Sniffed XML strips tags
  it('strips tags from sniffed XML content', () => {
    const result = routeContent(null, '<?xml version="1.0"?><root><item>Hello</item></root>');
    expect(result.kind).toBe('xml');
    expect(result.textContent).toContain('Hello');
  });

  // [Implements: US-SC-009] Sniffed JSON with array body
  it('sniffs JSON array body when Content-Type is null', () => {
    const result = routeContent(null, '[{"a":1},{"b":2}]');
    expect(result.kind).toBe('json');
    expect(result.textContent).toContain('"a": 1');
    expect(result.textContent).toContain('"b": 2');
  });

  // [Implements: US-SC-009] text/html content is deferred (textContent is null)
  it('returns null textContent for text/html for deferred Readability', () => {
    const result = routeContent('text/html', '<p>Some paragraph</p>');
    expect(result.kind).toBe('html');
    expect(result.textContent).toBeNull();
    expect(result.extractionMethod).toBeNull();
    expect(result.error).toBeNull();
  });
});
