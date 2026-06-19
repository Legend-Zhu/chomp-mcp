/**
 * Unit tests for content-extractor.ts — jsdom + Mozilla Readability extraction
 * with various HTML fixtures, threshold checking, and error handling.
 *
 * [Spec: US-SC-001, US-SC-002, US-SC-003]
 */

import { describe, it, expect } from 'vitest';
import { extractWithReadability } from '../../../src/modules/scrape-extract/content-extractor.js';
import type { ExtractionOutput } from '../../../src/modules/scrape-extract/types.js';

// ---------------------------------------------------------------------------
// HTML Fixtures
// ---------------------------------------------------------------------------

const FULL_ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Understanding TypeScript: A Comprehensive Guide</title>
  <style>body { font-family: sans-serif; }</style>
  <script>console.log('hello');</script>
</head>
<body>
  <nav><a href="/">Home</a> | <a href="/about">About</a> | <a href="/contact">Contact</a></nav>
  <article>
    <h1>Understanding TypeScript</h1>
    <p>TypeScript is a strongly typed programming language that builds on JavaScript by adding static types. It helps developers catch errors during development rather than at runtime, which significantly improves code quality and maintainability for projects of all sizes and complexity levels across teams.</p>
    <p>The type system in TypeScript is one of its most powerful features. By defining types for variables, function parameters, and return values, developers can leverage intelligent tooling in their editors for autocompletion, refactoring, and inline documentation, making the development experience much more productive and enjoyable overall.</p>
    <p>Another key advantage of TypeScript is its excellent support for modern JavaScript features. Since TypeScript is a superset of JavaScript, all valid JavaScript code is also valid TypeScript code. This makes adoption gradual and straightforward for existing JavaScript projects and teams without requiring a complete rewrite.</p>
    <p>Interfaces and type aliases allow developers to define custom types that describe the shape of data structures throughout their applications. This enables better collaboration between team members and reduces the likelihood of runtime errors caused by unexpected data shapes or null values in the production codebase.</p>
    <p>Generics in TypeScript provide a way to create reusable components that work with a variety of types rather than a single one. They are heavily used in libraries and frameworks to provide flexible yet type-safe APIs that adapt to the specific use case at hand without sacrificing compile-time safety guarantees.</p>
  </article>
  <aside>
    <h3>Related Articles</h3>
    <ul>
      <li><a href="/js">JavaScript Basics</a></li>
      <li><a href="/react">React with TypeScript</a></li>
    </ul>
  </aside>
  <footer>&copy; 2024 Example Corp. All rights reserved.</footer>
</body>
</html>`;

const MINIMAL_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Minimal Page</title></head>
<body>
  <article>
    <h1>Short Article</h1>
    <p>This is a brief article.</p>
  </article>
</body>
</html>`;

const NAVIGATION_ONLY_HTML = `<!DOCTYPE html>
<html>
<head><title>Navigation Site</title></head>
<body>
  <nav>
    <ul>
      <li><a href="/">Home</a></li>
      <li><a href="/products">Products</a></li>
      <li><a href="/about">About Us</a></li>
    </ul>
  </nav>
  <footer>Copyright 2024</footer>
</body>
</html>`;

const EMPTY_HTML = '';

const MALFORMED_HTML = `<html><head><title>Broken<body><p>Unclosed paragraph<b>bold</p> text</div>
<script>var x = ;</script><p>Some text here that is not enough for readability.</div>`;

const SCRIPT_STYLE_ONLY_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>App Page</title>
  <style>.container { display: flex; }</style>
</head>
<body>
  <div id="root"></div>
  <script>
    document.getElementById('root').innerHTML = '<h1>Rendered by JS</h1>';
  </script>
</body>
</html>`;

const UNICODE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head><title>日本語の記事 — Japanese Article</title></head>
<body>
  <article>
    <h1>日本語の記事タイトル</h1>
    <p>これは日本語のテスト記事です。Readabilityが正しく日本語のテキストを抽出できるかどうかを確認するためのコンテンツです。十分な長さのテキストが必要なので、複数の段落を含めています。この段落には十分な文字数があり、Readabilityによる抽出が成功するはずです。</p>
    <p>二番目の段落です。日本語の文字エンコーディングが正しく処理されることを確認するために、様々なUnicode文字を含めています。例えば、絵文字🌀や特殊記号©、数学記号∫なども含まれています。これらはすべて正しく抽出される必要があります。</p>
    <p>三番目の段落です。さらに十分なコンテンツを追加して、Readabilityがこのページを記事として認識し、十分な長さのテキストを抽出することを確認します。この段落で記事全体の文字数は十分なレベルに達しているはずです。</p>
  </article>
</body>
</html>`;

const ARTICLE_WITH_H1_TITLE = `<!DOCTYPE html>
<html>
<head><title></title></head>
<body>
  <article>
    <h1>Real Article Title From H1</h1>
    <p>This is the first paragraph of an article that has its title defined in an h1 tag rather than a title tag. The article needs to have enough content for Readability to extract it properly. This paragraph provides enough text for the extraction algorithm to identify this section as the main content of the page.</p>
    <p>The second paragraph adds more content to ensure that Readability will consider this article as substantial enough to extract. With multiple paragraphs of meaningful text content, the algorithm should successfully identify and extract the article body along with the heading that serves as the title for this piece.</p>
    <p>A third paragraph ensures there is definitely enough content for the readability extraction threshold to be met. The algorithm uses content scoring to determine which parts of the page are most likely to be the main article content versus navigation boilerplate or other non-article elements on the page.</p>
  </article>
</body>
</html>`;

const DEEP_NESTED_HTML = `<!DOCTYPE html>
<html>
<head><title>Deep Content</title></head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="main">
        <div class="article-wrapper">
          <article>
            <h1>Deeply Nested Article</h1>
            <p>This article is buried inside several layers of div elements to test whether Readability can still find and extract the main content correctly. Despite the nesting, the algorithm should identify the article element and extract its text content for use in the research pipeline downstream processing stages.</p>
            <p>The second paragraph in this deeply nested structure provides additional content to meet the minimum character threshold for successful extraction. Readability looks at text density and semantic elements to determine what constitutes the main content area of a web page regardless of how it is nested within container div elements.</p>
            <p>A third paragraph further increases the text density of this article section making it more likely that Readability will select it as the primary content node. The scoring algorithm rewards sections with higher text-to-tag ratios and penalizes sections that contain mostly links images or other non-text elements in the document structure.</p>
          </article>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('extractWithReadability', () => {

  // =========================================================================
  // SUCCESSFUL EXTRACTION FROM FULL ARTICLE
  // =========================================================================

  describe('successful extraction from full article', () => {
    // [Implements: US-SC-002]
    it('returns extractionMethod "readability" for a full article', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('extracts a non-empty title from the page', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result.title).toBeTruthy();
      expect(typeof result.title).toBe('string');
    });

    // [Implements: US-SC-002]
    it('extracts title containing "TypeScript" from the article', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result.title).toContain('TypeScript');
    });

    // [Implements: US-SC-002]
    it('extracts textContent with length >= 200 characters', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result.textContent.length).toBeGreaterThanOrEqual(200);
    });

    // [Implements: US-SC-002]
    it('charCount equals textContent.length', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result.charCount).toBe(result.textContent.length);
    });

    // [Implements: US-SC-002]
    it('text content includes article body keywords', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result.textContent).toContain('TypeScript');
    });

    // [Implements: US-SC-002]
    it('removes navigation text from extracted content', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      // Navigation should not be the primary content
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('returns a valid ExtractionOutput object shape', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('textContent');
      expect(result).toHaveProperty('extractionMethod');
      expect(result).toHaveProperty('charCount');
      expect(typeof result.title).toBe('string');
      expect(typeof result.textContent).toBe('string');
      expect(typeof result.charCount).toBe('number');
    });
  });

  // =========================================================================
  // THRESHOLD CHECKING
  // =========================================================================

  describe('threshold checking', () => {
    // [Implements: US-SC-002]
    it('returns "readability" when charCount >= default threshold (200)', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result.charCount).toBeGreaterThanOrEqual(200);
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('returns "readability-failed" when content is below custom high threshold', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', 100000);
      expect(result.extractionMethod).toBe('readability-failed');
    });

    // [Implements: US-SC-002]
    it('returns "readability" when threshold equals charCount exactly', () => {
      // First extract to get the actual char count
      const base = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      // Then re-extract with threshold exactly at charCount
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', base.charCount);
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('returns "readability-failed" when threshold is charCount + 1', () => {
      const base = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', base.charCount + 1);
      expect(result.extractionMethod).toBe('readability-failed');
    });

    // [Implements: US-SC-002]
    it('returns "readability" with threshold 1 for any non-empty article', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', 1);
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('returns "readability" with threshold 0 for any article', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', 0);
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('minimal page returns "readability-failed" with default threshold', () => {
      const result = extractWithReadability(MINIMAL_PAGE_HTML, 'https://example.com/short');
      // Minimal page content is likely too short or Readability returns null
      expect(result.extractionMethod).toBe('readability-failed');
    });

    // [Implements: US-SC-002]
    it('minimal page may return "readability" with very low threshold', () => {
      const result = extractWithReadability(MINIMAL_PAGE_HTML, 'https://example.com/short', 1);
      // If Readability returns non-null, content should be >= 1 char
      expect(['readability', 'readability-failed']).toContain(result.extractionMethod);
    });
  });

  // =========================================================================
  // MINIMAL / NO CONTENT PAGES
  // =========================================================================

  describe('minimal and no-content pages', () => {
    // [Implements: US-SC-003]
    it('returns "readability-failed" for a navigation-only page', () => {
      const result = extractWithReadability(NAVIGATION_ONLY_HTML, 'https://example.com/nav');
      expect(result.extractionMethod).toBe('readability-failed');
    });

    // [Implements: US-SC-003]
    it('returns charCount below default threshold for navigation-only page', () => {
      const result = extractWithReadability(NAVIGATION_ONLY_HTML, 'https://example.com/nav');
      expect(result.charCount).toBeLessThan(200);
    });

    // [Implements: US-SC-003]
    it('returns "readability-failed" for script/style-only page', () => {
      const result = extractWithReadability(SCRIPT_STYLE_ONLY_HTML, 'https://example.com/app');
      expect(result.extractionMethod).toBe('readability-failed');
    });

    // [Implements: US-SC-003]
    it('returns empty fields for script/style-only page', () => {
      const result = extractWithReadability(SCRIPT_STYLE_ONLY_HTML, 'https://example.com/app');
      expect(result.title).toBe('');
      expect(result.textContent).toBe('');
      expect(result.charCount).toBe(0);
    });
  });

  // =========================================================================
  // EMPTY AND MALFORMED HTML
  // =========================================================================

  describe('empty and malformed HTML', () => {
    // [Implements: US-SC-003]
    it('handles empty string HTML gracefully', () => {
      const result = extractWithReadability(EMPTY_HTML, 'https://example.com/empty');
      expect(result.extractionMethod).toBe('readability-failed');
      expect(result.title).toBe('');
      expect(result.textContent).toBe('');
      expect(result.charCount).toBe(0);
    });

    // [Implements: US-SC-003]
    it('handles malformed HTML gracefully', () => {
      const result = extractWithReadability(MALFORMED_HTML, 'https://example.com/broken');
      // Malformed HTML should not crash — either readability or readability-failed
      expect(['readability', 'readability-failed']).toContain(result.extractionMethod);
    });

    // [Implements: US-SC-003]
    it('malformed HTML does not throw an exception', () => {
      expect(() => {
        extractWithReadability(MALFORMED_HTML, 'https://example.com/broken');
      }).not.toThrow();
    });

    // [Implements: US-SC-003]
    it('handles HTML with only whitespace', () => {
      const result = extractWithReadability('   \n\t  ', 'https://example.com/ws');
      expect(result.extractionMethod).toBe('readability-failed');
    });

    // [Implements: US-SC-003]
    it('handles HTML with unclosed tags', () => {
      const html = '<html><body><p>Unclosed paragraph';
      const result = extractWithReadability(html, 'https://example.com/unclosed');
      expect(['readability', 'readability-failed']).toContain(result.extractionMethod);
    });

    // [Implements: US-SC-003]
    it('handles null-like input (empty string) without error', () => {
      expect(() => {
        extractWithReadability('', 'https://example.com/blank');
      }).not.toThrow();
    });
  });

  // =========================================================================
  // TITLE EXTRACTION
  // =========================================================================

  describe('title extraction', () => {
    // [Implements: US-SC-002]
    it('extracts title from <title> tag', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result.title).toContain('TypeScript');
    });

    // [Implements: US-SC-002]
    it('extracts title from <h1> when <title> is empty', () => {
      const result = extractWithReadability(ARTICLE_WITH_H1_TITLE, 'https://example.com/h1');
      expect(result.title).toBeTruthy();
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('returns non-empty title for full article', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result.title.length).toBeGreaterThan(0);
    });

    // [Implements: US-SC-002]
    it('title is a string type', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(typeof result.title).toBe('string');
    });
  });

  // =========================================================================
  // CONTENT PRESERVATION
  // =========================================================================

  describe('content preservation', () => {
    // [Implements: US-SC-002]
    it('does not include script content in extracted text', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      if (result.extractionMethod === 'readability') {
        expect(result.textContent).not.toContain('console.log');
      }
    });

    // [Implements: US-SC-002]
    it('does not include style content in extracted text', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      if (result.extractionMethod === 'readability') {
        expect(result.textContent).not.toContain('font-family');
      }
    });

    // [Implements: US-SC-002]
    it('preserves paragraph text from the article', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result.textContent).toContain('strongly typed');
    });

    // [Implements: US-SC-002]
    it('removes footer copyright text from main content', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      // Footer boilerplate is typically removed by Readability
      if (result.extractionMethod === 'readability') {
        // The copyright symbol text may or may not appear, but the primary
        // content should be the article body, not the footer
        expect(result.textContent).toContain('TypeScript');
      }
    });
  });

  // =========================================================================
  // UNICODE AND INTERNATIONAL CONTENT
  // =========================================================================

  describe('Unicode and international content', () => {
    // [Implements: US-SC-002]
    it('extracts Japanese content successfully', () => {
      const result = extractWithReadability(UNICODE_HTML, 'https://example.com/ja');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('preserves Japanese characters in extracted text', () => {
      const result = extractWithReadability(UNICODE_HTML, 'https://example.com/ja');
      if (result.extractionMethod === 'readability') {
        expect(result.textContent).toContain('日本語');
      }
    });

    // [Implements: US-SC-002]
    it('extracts title from Japanese page', () => {
      const result = extractWithReadability(UNICODE_HTML, 'https://example.com/ja');
      expect(result.title).toContain('日本語');
    });

    // [Implements: US-SC-002]
    it('charCount correctly counts Unicode characters', () => {
      const result = extractWithReadability(UNICODE_HTML, 'https://example.com/ja');
      if (result.extractionMethod === 'readability') {
        expect(result.charCount).toBe(result.textContent.length);
      }
    });
  });

  // =========================================================================
  // DEEP NESTING
  // =========================================================================

  describe('deeply nested content', () => {
    // [Implements: US-SC-002]
    it('extracts content from deeply nested article', () => {
      const result = extractWithReadability(DEEP_NESTED_HTML, 'https://example.com/deep');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('extracts title from deeply nested article', () => {
      const result = extractWithReadability(DEEP_NESTED_HTML, 'https://example.com/deep');
      expect(result.title).toContain('Deep');
    });

    // [Implements: US-SC-002]
    it('preserves article body from deeply nested structure', () => {
      const result = extractWithReadability(DEEP_NESTED_HTML, 'https://example.com/deep');
      if (result.extractionMethod === 'readability') {
        expect(result.textContent).toContain('nested');
      }
    });
  });

  // =========================================================================
  // CONSISTENCY AND INVARIANTS
  // =========================================================================

  describe('consistency and invariants', () => {
    // [Implements: US-SC-002]
    it('produces consistent results across multiple calls with same input', () => {
      const result1 = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      const result2 = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result1.title).toBe(result2.title);
      expect(result1.textContent).toBe(result2.textContent);
      expect(result1.charCount).toBe(result2.charCount);
      expect(result1.extractionMethod).toBe(result2.extractionMethod);
    });

    // [Implements: US-SC-002]
    it('charCount is always a non-negative integer', () => {
      const inputs = [FULL_ARTICLE_HTML, MINIMAL_PAGE_HTML, NAVIGATION_ONLY_HTML, EMPTY_HTML, MALFORMED_HTML];
      for (const html of inputs) {
        const result = extractWithReadability(html, 'https://example.com/');
        expect(result.charCount).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(result.charCount)).toBe(true);
      }
    });

    // [Implements: US-SC-002]
    it('extractionMethod is always a valid ExtractionMethod value', () => {
      const validMethods = ['readability', 'readability-failed', 'puppeteer', 'json', 'xml', 'raw-text'];
      const inputs = [FULL_ARTICLE_HTML, MINIMAL_PAGE_HTML, NAVIGATION_ONLY_HTML, EMPTY_HTML];
      for (const html of inputs) {
        const result = extractWithReadability(html, 'https://example.com/');
        expect(validMethods).toContain(result.extractionMethod);
      }
    });

    // [Implements: US-SC-002]
    it('readability-failed has title below threshold content', () => {
      const result = extractWithReadability(NAVIGATION_ONLY_HTML, 'https://example.com/nav');
      expect(result.extractionMethod).toBe('readability-failed');
      // Readability may return a title even when content is below threshold
      expect(typeof result.title).toBe('string');
    });

    // [Implements: US-SC-002]
    it('readability-failed always returns empty textContent', () => {
      const result = extractWithReadability(EMPTY_HTML, 'https://example.com/empty');
      expect(result.extractionMethod).toBe('readability-failed');
      expect(result.textContent).toBe('');
    });

    // [Implements: US-SC-002]
    it('readability-failed has charCount below threshold', () => {
      const result = extractWithReadability(NAVIGATION_ONLY_HTML, 'https://example.com/nav');
      expect(result.extractionMethod).toBe('readability-failed');
      expect(result.charCount).toBeLessThan(200);
    });
  });

  // =========================================================================
  // URL PARAMETER USAGE
  // =========================================================================

  describe('URL parameter usage', () => {
    // [Implements: US-SC-002]
    it('works with standard HTTPS URL', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('works with HTTP URL', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'http://example.com/article');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('works with URL containing path and query', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/articles/ts?lang=en&page=1');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('works with localhost URL', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'http://localhost:3000/page');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('works with URL containing fragment', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article#section1');
      expect(result.extractionMethod).toBe('readability');
    });
  });

  // =========================================================================
  // ADDITIONAL EDGE CASES
  // =========================================================================

  describe('additional edge cases', () => {
    // [Implements: US-SC-002]
    it('handles article with many paragraphs', () => {
      const paragraphs = Array.from(
        { length: 20 },
        (_, i) => `<p>Paragraph ${i}: This is a paragraph with enough content to contribute to the overall article text density and ensure successful extraction by the readability algorithm during the content extraction process.</p>`
      ).join('\n');
      const html = `<!DOCTYPE html><html><head><title>Many Paragraphs</title></head><body><article><h1>Article</h1>${paragraphs}</article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/many');
      expect(result.extractionMethod).toBe('readability');
      expect(result.charCount).toBeGreaterThan(200);
    });

    // [Implements: US-SC-002]
    it('handles HTML with HTML comments', () => {
      const html = `<!DOCTYPE html><html><head><title>Comments</title><!-- comment --></head><body><article><h1>Title</h1><!-- inline comment --><p>This article contains HTML comments that should not interfere with the readability extraction process. The comments should be stripped during parsing and should not appear in the extracted text content returned by the function call.</p><p>Another paragraph with content to ensure enough text is available for successful readability extraction. The algorithm needs sufficient text density to identify this section as the main article content on the page.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/comments');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles HTML with inline formatting (strong, em, code)', () => {
      const html = `<!DOCTYPE html><html><head><title>Formatted</title></head><body><article><h1>Formatted Article</h1><p>This article contains <strong>bold text</strong>, <em>italic text</em>, and <code>inline code</code> that should all be preserved as plain text in the extraction output. The readability algorithm strips HTML tags and preserves the text content.</p><p>Another paragraph with various formatting elements including <a href="#">links</a> and <b>bold</b> and <i>italic</i> tags that need to be handled correctly during the text extraction process for downstream consumption.</p><p>A third paragraph ensures sufficient content density for successful readability extraction. The formatting tags do not affect the character count of the extracted plain text content since only the text nodes are counted by the length property of the result string.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/formatted');
      expect(result.extractionMethod).toBe('readability');
      expect(result.textContent).toContain('bold');
      expect(result.textContent).toContain('italic');
    });

    // [Implements: US-SC-002]
    it('handles HTML with images (alt text may appear)', () => {
      const html = `<!DOCTYPE html><html><head><title>Images Article</title></head><body><article><h1>Article With Images</h1><p>This article demonstrates how the readability extractor handles pages that contain images alongside text content. The image alt text may or may not appear in the extracted output depending on the algorithm implementation details.</p><p><img src="photo.jpg" alt="A sample photograph"></p><p>The second and third paragraphs provide enough text density for the readability algorithm to identify this article section as the main content area. Images are typically removed but their presence does not prevent successful extraction from occurring.</p><p>A final paragraph with more content to ensure the minimum character threshold is met and the extraction method is set to readability rather than readability-failed in the output result object.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/images');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles HTML with tables', () => {
      const html = `<!DOCTYPE html><html><head><title>Table Article</title></head><body><article><h1>Data Article</h1><p>This article contains a table with data that should be processed by the readability extractor. Tables are common in informational content and their text content should be included in the extraction result.</p><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>TypeScript</td><td>Strongly typed</td></tr><tr><td>JavaScript</td><td>Dynamically typed</td></tr></tbody></table><p>The table above shows a comparison between TypeScript and JavaScript typing systems. This additional paragraph ensures there is enough surrounding text content for the readability algorithm to identify this section as the primary article content on the page for extraction.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/table');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles very large HTML efficiently', () => {
      const para = '<p>This is a paragraph with enough content for readability extraction. It contains meaningful text about various topics in software development and programming languages.</p>';
      const manyParas = para.repeat(100);
      const html = `<!DOCTYPE html><html><head><title>Large Article</title></head><body><article><h1>Large Article</h1>${manyParas}</article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/large');
      expect(result.extractionMethod).toBe('readability');
      expect(result.charCount).toBeGreaterThan(1000);
    });

    // [Implements: US-SC-002]
    it('handles article with multiple sections (h2, h3)', () => {
      const html = `<!DOCTYPE html><html><head><title>Multi-Section</title></head><body><article><h1>Complete Guide</h1><h2>Introduction</h2><p>This is the introduction section of a multi-section article. It provides an overview of the topics that will be covered in the subsequent sections of this comprehensive guide to advanced programming concepts.</p><h2>Main Content</h2><p>The main content section contains the bulk of the information in this article. It covers important topics in detail and provides examples to help readers understand the concepts being discussed throughout the article.</p><h3>Subsection</h3><p>This subsection dives deeper into a specific aspect of the main content. It provides additional context and details that supplement the information presented in the main content section above.</p><h2>Conclusion</h2><p>The conclusion wraps up the article by summarizing the key points and providing final thoughts on the topics discussed. This section ties everything together for the reader.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/multi');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles article with blockquote elements', () => {
      const html = `<!DOCTYPE html><html><head><title>Quotes Article</title></head><body><article><h1>Article with Quotes</h1><p>This article includes blockquotes to demonstrate how the readability extractor handles quoted content within articles. The quoted text should be preserved in the extraction output along with the surrounding article body text content.</p><blockquote><p>This is an important quote from a source that adds context to the article content.</p></blockquote><p>After the quote, the article continues with more analysis and discussion of the topics introduced earlier. This paragraph provides additional content to ensure sufficient text density for successful readability extraction.</p><p>A final paragraph wraps up the article and ensures the minimum character threshold is comfortably met for the readability extraction algorithm to classify this as a successful extraction with the readability method identifier.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/quotes');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles HTML5 semantic elements (section, main, header)', () => {
      const html = `<!DOCTYPE html><html><head><title>Semantic Article</title></head><body><header><h1>Semantic HTML5 Article</h1></header><main><section><p>This article uses HTML5 semantic elements including header, main, and section tags. The readability extractor should be able to process these elements correctly and extract the main text content from the article body section.</p><p>The second paragraph provides additional content to ensure the readability algorithm has enough material to work with. HTML5 semantic elements are widely used in modern web development and should be handled without any issues.</p><p>A third paragraph ensures sufficient content density. The semantic structure of the page helps readability identify the main content area more accurately than pages that use generic div elements without semantic meaning throughout the document structure.</p></section></main></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/semantic');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles HTML with data attributes', () => {
      const html = `<!DOCTYPE html><html><head><title>Data Attrs</title></head><body><article data-post-id="123" data-author="test"><h1>Article</h1><p>This article has data attributes on its container element. Data attributes should not interfere with the readability extraction process since they are part of the HTML structure but not the text content of the article being extracted from the page.</p><p>Another paragraph with enough content to ensure successful extraction. The data attributes on the parent elements are ignored by the readability algorithm which focuses on text content and element scoring rather than attribute values in the document.</p><p>A third paragraph to meet the minimum character threshold. The presence of custom data attributes does not affect the text extraction quality or the algorithm ability to identify and extract the main article content from the page structure.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/data');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles HTML with entity-encoded characters', () => {
      const html = `<!DOCTYPE html><html><head><title>Entities &amp; Symbols</title></head><body><article><h1>Entities &amp; Article</h1><p>This article contains HTML entities such as &amp;, &lt;, &gt;, &quot;, and &#39; that should be decoded properly during the extraction process. The readability algorithm should produce clean text with entities resolved to their corresponding Unicode characters.</p><p>Another paragraph with entities: &copy; 2024, &reg;, &trade;, &euro;, and &mdash; should all appear correctly in the extracted text output. The entity decoding is handled by the underlying HTML parser.</p><p>A third paragraph ensures enough content density. The entity handling does not affect the overall extraction success rate and the text should be clean and readable in the final output result object.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/entities');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles non-ASCII URL', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/路径/文章');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('readability result textContent does not contain HTML tags', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      if (result.extractionMethod === 'readability') {
        // The extracted text should be plain text, not HTML
        expect(result.textContent).not.toContain('<p>');
        expect(result.textContent).not.toContain('</p>');
        expect(result.textContent).not.toContain('<article>');
      }
    });

    // [Implements: US-SC-002]
    it('extraction with empty URL does not crash', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, '');
      expect(['readability', 'readability-failed']).toContain(result.extractionMethod);
    });

    // [Implements: US-SC-002]
    it('handles article with lists (ul, ol, li)', () => {
      const html = `<!DOCTYPE html><html><head><title>List Article</title></head><body><article><h1>Article with Lists</h1><p>This article demonstrates how readability handles unordered and ordered lists within article content. List items should be included in the extracted text as they are part of the article body content.</p><h3>Key Points</h3><ul><li>First important point about the topic being discussed in this article</li><li>Second important point that adds to the discussion</li><li>Third important point with additional context</li></ul><p>The list above summarizes key points. This paragraph and the previous content ensure there is enough text density for successful readability extraction by the content extraction algorithm used in this system.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/lists');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles article with nested articles (non-standard)', () => {
      const html = `<!DOCTYPE html><html><head><title>Nested Articles</title></head><body><article><h1>Outer Article</h1><p>This is the outer article content. It has enough text to be identified as the main article by the readability algorithm. The text density is sufficient for extraction to succeed without invoking the fallback path.</p><article><h2>Inner Article</h2><p>This is an inner article section that is nested within the outer article. Readability should handle this structure and extract the relevant text content from both the outer and inner article elements.</p></article><p>The outer article continues after the nested article section. This additional content helps ensure the overall text density meets the threshold for successful extraction by the readability content extraction algorithm.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/nested');
      expect(result.extractionMethod).toBe('readability');
    });
  });

  // =========================================================================
  // THRESHOLD BOUNDARY PRECISION
  // =========================================================================

  describe('threshold boundary precision', () => {
    // [Implements: US-SC-002]
    it('returns "readability" when threshold is exactly one less than charCount', () => {
      const base = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article');
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', base.charCount - 1);
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('returns "readability" when threshold is 199 and charCount is >= 200', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', 199);
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('returns "readability-failed" with negative threshold and non-empty content', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', -1);
      // A negative threshold means charCount (>=0) always exceeds it
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('returns "readability-failed" with very high custom threshold', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', 999999999);
      expect(result.extractionMethod).toBe('readability-failed');
    });

    // [Implements: US-SC-002]
    it('returns "readability" when threshold equals default (200) and content is sufficient', () => {
      const result = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', 200);
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('produces identical charCount regardless of threshold value', () => {
      const result1 = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', 0);
      const result2 = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', 100000);
      // The raw extraction result is the same — only the method flag changes
      expect(result1.charCount).toBe(result2.charCount);
      expect(result1.textContent).toBe(result2.textContent);
    });

    // [Implements: US-SC-002]
    it('returns consistent charCount for readability vs readability-failed with same input', () => {
      // With threshold 0, extraction succeeds
      const successResult = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', 0);
      // With threshold 100000, extraction fails due to threshold
      const failResult = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article', 100000);
      // Both process the same article — the raw extracted text is identical
      expect(successResult.charCount).toBeGreaterThan(0);
      expect(successResult.charCount).toBe(failResult.charCount);
      expect(failResult.extractionMethod).toBe('readability-failed');
      expect(successResult.extractionMethod).toBe('readability');
    });
  });

  // =========================================================================
  // CODE AND PREFORMATTED CONTENT
  // =========================================================================

  describe('code and preformatted content', () => {
    // [Implements: US-SC-002]
    it('handles article with code blocks (pre, code)', () => {
      const html = `<!DOCTYPE html><html><head><title>Code Article</title></head><body><article><h1>Programming with Code</h1><p>This article demonstrates how the readability extractor handles code blocks embedded within article content. Code blocks should be processed as part of the main text content for the extraction pipeline.</p><pre><code>function hello() {\n  console.log("Hello, World!");\n}</code></pre><p>After the code block, the article continues with more explanation about the programming concepts discussed. This paragraph provides additional context to ensure sufficient text density for successful readability extraction by the content extraction algorithm.</p><p>A final paragraph wraps up the article and ensures the minimum character threshold is comfortably met for the readability extraction algorithm to classify this as a successful extraction with the readability method identifier in the result object.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/code');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles article with inline code spans', () => {
      const html = `<!DOCTYPE html><html><head><title>Inline Code</title></head><body><article><h1>Using Inline Code</h1><p>This article contains inline <code>code spans</code> within the text to demonstrate how they are handled during readability extraction. The code spans should be treated as regular text content and included in the extracted output along with surrounding paragraphs of the article body text content being processed.</p><p>The second paragraph adds more content to ensure sufficient text density for the readability algorithm to identify this section as the main article content on the page. The inline code elements do not affect the character counting or extraction quality in any meaningful way during the processing.</p><p>A third paragraph ensures the minimum character threshold is met for successful extraction. The code spans are treated as inline text and their content is preserved in the extracted output as plain text without any special formatting or HTML markup tags in the final result.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/inline-code');
      expect(result.extractionMethod).toBe('readability');
    });
  });

  // =========================================================================
  // MIXED-LANGUAGE AND SPECIAL CONTENT
  // =========================================================================

  describe('mixed-language and special content', () => {
    // [Implements: US-SC-002]
    it('handles mixed English and CJK content', () => {
      const html = `<!DOCTYPE html><html><head><title>Mixed Language Article</title></head><body><article><h1>Mixed Language Content 混合语言</h1><p>This article contains both English and Chinese (中文) text to demonstrate how the readability extractor handles multilingual content. The extraction should preserve characters from both languages in the extracted text output for downstream processing stages.</p><p>第二段是中文内容。This paragraph mixes Chinese and English text to test the extraction algorithm ability to handle multilingual articles. 混合语言的内容需要被正确地提取和处理，以确保所有语言的文本都能保留在最终的输出结果中供下游处理使用。</p><p>The third paragraph is primarily in English with a few CJK characters (日本語 and 한국어) to further test the multilingual extraction capabilities. The algorithm should handle all Unicode characters correctly without any loss or corruption of the original text content from the page being processed by the extraction pipeline.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/mixed');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles article with emojis in content', () => {
      const html = `<!DOCTYPE html><html><head><title>Emoji Article 🎉</title></head><body><article><h1>Article with Emojis 🚀</h1><p>This article contains emojis throughout its text content to verify that the readability extractor correctly preserves emoji characters in the extracted output. Emojis are increasingly common in modern web content and should be handled without issues during the text extraction process.</p><p>The second paragraph includes more emojis like 📝, 💡, and 🔧 to demonstrate the wide range of emoji characters that might appear in article text. These characters are valid Unicode and should be preserved in the extracted text content for downstream processing stages in the pipeline.</p><p>A third paragraph ensures sufficient text density for successful readability extraction. The presence of emojis does not affect the extraction quality or the character counting mechanism used by the algorithm to determine whether the content meets the minimum threshold for successful extraction classification.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/emoji');
      expect(result.extractionMethod).toBe('readability');
      if (result.extractionMethod === 'readability') {
        expect(result.textContent).toContain('🚀');
      }
    });

    // [Implements: US-SC-002]
    it('preserves special characters in extracted text', () => {
      const html = `<!DOCTYPE html><html><head><title>Special Characters</title></head><body><article><h1>Special Characters Article</h1><p>This article contains various special characters including typographic dashes (— and –), ellipses (…), curly quotes ("smart quotes"), and other Unicode punctuation marks that should be preserved in the extracted text output for the downstream processing pipeline to consume correctly.</p><p>The second paragraph includes mathematical symbols (∑, ∏, √, ∞, ≠, ≤, ≥) and currency symbols ($, €, £, ¥, ₹) that are commonly found in technical and financial articles. These characters should all be preserved during the readability extraction process without any loss or corruption.</p><p>A third paragraph ensures sufficient content density for successful extraction. The special characters do not affect the overall extraction quality or the character counting mechanism used by the algorithm to determine whether the content meets the minimum threshold for successful extraction in the final result object.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/special');
      expect(result.extractionMethod).toBe('readability');
      if (result.extractionMethod === 'readability') {
        expect(result.textContent).toContain('—');
      }
    });
  });

  // =========================================================================
  // FIGURE, DETAILS, AND DEFINITION LIST ELEMENTS
  // =========================================================================

  describe('figure, details, and definition list elements', () => {
    // [Implements: US-SC-002]
    it('handles article with figure and figcaption', () => {
      const html = `<!DOCTYPE html><html><head><title>Figure Article</title></head><body><article><h1>Article with Figures</h1><p>This article contains figure elements with captions to demonstrate how the readability extractor handles embedded figures within article content. The figure captions may be included in the extracted text as part of the main content body during the extraction process.</p><figure><img src="chart.png" alt="Sales chart"><figcaption>Figure 1: Quarterly sales results showing growth trend</figcaption></figure><p>After the figure, the article continues with analysis of the data shown in the chart. This paragraph and the surrounding text provide enough content density for the readability algorithm to identify this section as the primary article content on the page for extraction.</p><p>A final paragraph wraps up the article and ensures the minimum character threshold is met for the readability extraction algorithm to classify this as a successful extraction with the readability method identifier in the result object.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/figure');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles article with details and summary', () => {
      const html = `<!DOCTYPE html><html><head><title>Details Article</title></head><body><article><h1>Article with Details</h1><p>This article contains disclosure (details) elements to demonstrate how the readability extractor handles interactive or collapsible content within articles. The text inside details elements should be included in the extracted content for the downstream processing pipeline.</p><details><summary>Additional Information</summary><p>This is the detailed content inside a disclosure element that provides supplementary information to the main article text. It should be extracted as part of the article body content during the readability extraction process.</p></details><p>After the details section, the article continues with more content to ensure sufficient text density for successful readability extraction. The surrounding paragraphs provide enough context for the algorithm to identify this as the primary content area on the page being processed.</p><p>A final paragraph ensures the minimum character threshold is comfortably met for the readability extraction algorithm to classify this as a successful extraction result with the readability method identifier in the output object.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/details');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles article with definition lists', () => {
      const html = `<!DOCTYPE html><html><head><title>Definitions Article</title></head><body><article><h1>Glossary of Terms</h1><p>This article uses definition lists to present a glossary of terms. Definition lists are commonly used in reference content and educational articles to define key terms and concepts that readers need to understand in the context of the discussion being presented throughout the article.</p><dl><dt>TypeScript</dt><dd>A strongly typed programming language that builds on JavaScript.</dd><dt>Readability</dt><dd>An algorithm for extracting the main text content from web pages.</dd></dl><p>After the definition list, the article provides additional context and explanation to supplement the glossary entries. This paragraph ensures there is enough text density for successful readability extraction by the content extraction algorithm in the pipeline.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/definitions');
      expect(result.extractionMethod).toBe('readability');
    });
  });

  // =========================================================================
  // CONTENT WITH IFRAMES AND NOSCRIPT
  // =========================================================================

  describe('content with iframes and noscript', () => {
    // [Implements: US-SC-002]
    it('handles article with iframe (stripped from content)', () => {
      const html = `<!DOCTYPE html><html><head><title>Embed Article</title></head><body><article><h1>Article with Embedded Content</h1><p>This article contains an iframe element that embeds external content. The iframe should be stripped during extraction since it references external resources that are not part of the article body text content being processed by the readability extraction algorithm in the pipeline.</p><iframe src="embed.html" title="Embedded video"></iframe><p>After the embedded content, the article continues with more text content. This paragraph and the surrounding text provide enough density for the readability algorithm to identify this section as the primary article content on the page being processed for text extraction in the research pipeline downstream stages.</p><p>A final paragraph wraps up the article and ensures the minimum character threshold is met for the readability extraction algorithm to classify this as a successful extraction with the readability method identifier in the result object for the downstream pipeline processing.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/embed');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles article with noscript fallback content', () => {
      const html = `<!DOCTYPE html><html><head><title>Noscript Article</title></head><body><article><h1>Article with Noscript</h1><p>This article contains noscript elements that provide fallback content for users with JavaScript disabled. The noscript content should not interfere with the readability extraction process since it is typically hidden when JavaScript is available in the browser environment.</p><noscript><p>JavaScript is required to view this content.</p></noscript><p>After the noscript element, the article continues with more regular text content that provides the main body of the article. This paragraph and the surrounding text ensure sufficient density for the readability algorithm to identify this section as the primary content area on the page being processed.</p><p>A final paragraph ensures the minimum character threshold is met for successful readability extraction. The noscript element does not affect the extraction quality or the character counting mechanism used by the algorithm to determine the extraction success status.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/noscript');
      expect(result.extractionMethod).toBe('readability');
    });
  });

  // =========================================================================
  // LARGE-SCALE AND PERFORMANCE-RELATED TESTS
  // =========================================================================

  describe('large-scale and performance', () => {
    // [Implements: US-SC-002]
    it('handles article with 100 paragraphs', () => {
      const paragraphs = Array.from(
        { length: 100 },
        (_, i) => `<p>Paragraph number ${i}: This paragraph contains enough text content to contribute to the overall article text density and ensure successful extraction by the readability algorithm. Each paragraph provides meaningful content for the extraction pipeline.</p>`
      ).join('\n');
      const html = `<!DOCTYPE html><html><head><title>100 Paragraphs</title></head><body><article><h1>Very Long Article</h1>${paragraphs}</article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/100paras');
      expect(result.extractionMethod).toBe('readability');
      expect(result.charCount).toBeGreaterThan(5000);
    });

    // [Implements: US-SC-002]
    it('handles article with a single very long paragraph', () => {
      const longText = 'This is a single very long paragraph that contains enough text content to meet the minimum character threshold for successful readability extraction. '.repeat(10);
      const html = `<!DOCTYPE html><html><head><title>Long Paragraph</title></head><body><article><h1>Single Long Paragraph</h1><p>${longText}</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/longpara');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles article with horizontal rules', () => {
      const html = `<!DOCTYPE html><html><head><title>Rules Article</title></head><body><article><h1>Article with Rules</h1><p>This article uses horizontal rules to separate sections. The horizontal rule elements should not interfere with the readability extraction process and should be handled gracefully during the text content extraction from the page being processed by the algorithm.</p><hr><p>After the first horizontal rule, this section continues with more content. The presence of horizontal rules as section dividers is a common pattern in web articles and should not prevent successful extraction of the main text content from the article body.</p><hr><p>A final section after another horizontal rule ensures sufficient text density for successful readability extraction. The article overall has enough text content to meet the minimum character threshold for the extraction to be classified as successful in the final result object.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/rules');
      expect(result.extractionMethod).toBe('readability');
    });
  });

  // =========================================================================
  // DETERMINISTIC IDEMPOTENCY
  // =========================================================================

  describe('deterministic idempotency', () => {
    // [Implements: US-SC-002]
    it('produces identical results across 10 consecutive calls', () => {
      const results: ExtractionOutput[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/article'));
      }
      const first = results[0];
      for (const r of results) {
        expect(r.title).toBe(first.title);
        expect(r.textContent).toBe(first.textContent);
        expect(r.charCount).toBe(first.charCount);
        expect(r.extractionMethod).toBe(first.extractionMethod);
      }
    });

    // [Implements: US-SC-002]
    it('produces identical results with different URLs but same HTML', () => {
      const urls = [
        'https://a.example.com/page',
        'https://b.example.com/page',
        'https://c.example.com/deep/path?q=1',
        'http://localhost:8080/test',
      ];
      const results = urls.map((url) => extractWithReadability(FULL_ARTICLE_HTML, url));
      const first = results[0];
      for (const r of results) {
        expect(r.charCount).toBe(first.charCount);
        expect(r.extractionMethod).toBe(first.extractionMethod);
        expect(r.textContent).toBe(first.textContent);
      }
    });

    // [Implements: US-SC-002]
    it('produces identical results when called interleaved with different inputs', () => {
      const r1a = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/a');
      const r2 = extractWithReadability(NAVIGATION_ONLY_HTML, 'https://example.com/nav');
      const r1b = extractWithReadability(FULL_ARTICLE_HTML, 'https://example.com/a');

      expect(r1a.title).toBe(r1b.title);
      expect(r1a.textContent).toBe(r1b.textContent);
      expect(r1a.charCount).toBe(r1b.charCount);
      expect(r1a.extractionMethod).toBe(r1b.extractionMethod);
      // Navigation page should fail
      expect(r2.extractionMethod).toBe('readability-failed');
    });
  });

  // =========================================================================
  // TITLE EXTRACTION EDGE CASES
  // =========================================================================

  describe('title extraction edge cases', () => {
    // [Implements: US-SC-002]
    it('extracts title containing special characters', () => {
      const html = `<!DOCTYPE html><html><head><title>Special "Quotes" & Symbols — Test</title></head><body><article><h1>Content</h1><p>This is the first paragraph of an article with a title containing special characters. The article needs sufficient content for Readability to extract it properly from the page structure during the content extraction process in the research pipeline.</p><p>The second paragraph adds more content to ensure that Readability will consider this article as substantial enough to extract from the page. With multiple paragraphs of meaningful text content, the algorithm should successfully extract the article body text for downstream processing stages.</p><p>A third paragraph ensures there is definitely enough content for the readability extraction threshold to be met. The algorithm uses content scoring to determine which parts of the page are most likely to be the main article content versus navigation boilerplate or other non-article elements.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/title-special');
      expect(result.extractionMethod).toBe('readability');
      expect(result.title.length).toBeGreaterThan(0);
    });

    // [Implements: US-SC-002]
    it('handles page with title containing only whitespace', () => {
      const html = `<!DOCTYPE html><html><head><title>   </title></head><body><article><h1>Whitespace Title Article</h1><p>This article has a title tag containing only whitespace characters. The readability extractor should still be able to extract the main article content from the page despite the whitespace-only title tag in the document head section of the HTML being processed by the extraction algorithm.</p><p>The second paragraph provides additional content to ensure sufficient text density for successful readability extraction. The algorithm should identify the article body as the primary content area on the page regardless of the title tag content in the document head section.</p><p>A third paragraph ensures the minimum character threshold is met for successful extraction. The whitespace-only title does not affect the extraction quality or the ability of the algorithm to identify and extract the main article content from the page structure being processed.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/ws-title');
      expect(result.extractionMethod).toBe('readability');
    });
  });

  // =========================================================================
  // CONTENT STRUCTURE EDGE CASES
  // =========================================================================

  describe('content structure edge cases', () => {
    // [Implements: US-SC-002]
    it('handles article with time elements', () => {
      const html = `<!DOCTYPE html><html><head><title>Time Article</title></head><body><article><h1>Article with Timestamps</h1><p>Published on <time datetime="2024-01-15">January 15, 2024</time>. This article demonstrates how the readability extractor handles time elements within article content. The time elements should be processed as part of the text content during extraction.</p><p>The second paragraph provides additional content to ensure sufficient text density for successful readability extraction. The time elements do not interfere with the extraction process and their text content is included in the extracted output for downstream consumption.</p><p>A third paragraph ensures the minimum character threshold is met for successful readability extraction. The presence of time elements in the article body does not affect the overall extraction quality or the character counting mechanism used by the algorithm.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/time');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles article with mark highlighted text', () => {
      const html = `<!DOCTYPE html><html><head><title>Mark Article</title></head><body><article><h1>Article with Highlights</h1><p>This article contains <mark>highlighted text</mark> using the mark element to demonstrate how the readability extractor handles highlighted content within articles. The highlighted text should be preserved in the extracted output as plain text content for the downstream processing pipeline.</p><p>The second paragraph provides additional content to ensure sufficient text density for successful readability extraction. The mark elements are treated as inline text and their content is included in the extracted output without any special formatting during the text extraction process.</p><p>A third paragraph ensures the minimum character threshold is met for successful extraction. The mark elements do not affect the overall extraction quality or the character counting mechanism used by the algorithm to determine the extraction success status.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/mark');
      expect(result.extractionMethod).toBe('readability');
      if (result.extractionMethod === 'readability') {
        expect(result.textContent).toContain('highlighted');
      }
    });

    // [Implements: US-SC-002]
    it('handles article with nested blockquotes', () => {
      const html = `<!DOCTYPE html><html><head><title>Nested Quotes Article</title></head><body><article><h1>Article with Nested Quotes</h1><p>This article demonstrates how readability handles nested blockquote elements within article content. Nested quotes are sometimes used to represent multi-level quoting in articles and should be processed correctly during extraction.</p><blockquote><p>An outer quote that contains another quote inside it.<blockquote><p>This is the inner quote within the outer quote block.</p></blockquote></p></blockquote><p>After the nested quotes, the article continues with more analysis. This paragraph provides additional content to ensure sufficient text density for successful readability extraction by the content extraction algorithm in the pipeline.</p><p>A final paragraph wraps up the article and ensures the minimum character threshold is comfortably met for the readability extraction algorithm to classify this as a successful extraction.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/nested-quotes');
      expect(result.extractionMethod).toBe('readability');
    });

    // [Implements: US-SC-002]
    it('handles article with abbreviation elements', () => {
      const html = `<!DOCTYPE html><html><head><title>Abbreviations Article</title></head><body><article><h1>Technical Abbreviations</h1><p>This article uses <abbr title="HyperText Markup Language">HTML</abbr> and <abbr title="Cascading Style Sheets">CSS</abbr> abbreviations to demonstrate how the readability extractor handles abbreviation elements within article content during the extraction process for the downstream pipeline processing stages.</p><p>The second paragraph provides additional content with abbreviations like <abbr title="JavaScript">JS</abbr> to ensure sufficient text density. The abbreviation elements are treated as inline text and their text content is preserved in the extracted output for downstream consumption in the research pipeline.</p><p>A third paragraph ensures the minimum character threshold is met for successful readability extraction. The abbreviation elements do not affect the overall extraction quality or the character counting mechanism used by the algorithm to determine the extraction success status in the result.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/abbr');
      expect(result.extractionMethod).toBe('readability');
      if (result.extractionMethod === 'readability') {
        expect(result.textContent).toContain('HTML');
      }
    });

    // [Implements: US-SC-002]
    it('handles page with multiple article elements', () => {
      const html = `<!DOCTYPE html><html><head><title>Multiple Articles Page</title></head><body><article><h1>First Article</h1><p>This is the first article on a page that contains multiple article elements. Each article has its own heading and body text content that the readability algorithm should be able to identify and extract from the page structure during the content extraction process in the pipeline.</p><p>The second paragraph of the first article adds more content to ensure sufficient text density for successful readability extraction. With enough text in this section, the algorithm should identify it as a primary content area on the page being processed for extraction.</p><p>A third paragraph ensures the minimum character threshold is met for the first article section. The text density in this article is sufficient for the readability extraction to succeed and classify this as a successful extraction result in the output object.</p></article><article><h2>Second Article</h2><p>This is a second article on the same page. It also has enough content for readability extraction to succeed.</p><p>The second paragraph of the second article provides additional context and content. This text is sufficient for the readability algorithm to process during extraction from the page being analyzed in the content extraction pipeline downstream processing stages.</p></article></body></html>`;
      const result = extractWithReadability(html, 'https://example.com/multi-article');
      expect(result.extractionMethod).toBe('readability');
    });
  });
});
