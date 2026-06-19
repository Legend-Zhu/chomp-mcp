/**
 * Content extractor — jsdom + Mozilla Readability primary extraction path.
 *
 * Parses raw HTML using jsdom to construct a DOM document, then applies
 * Mozilla Readability to extract the page title and clean text content.
 *
 * Extraction outcome:
 *   - 'readability'        — textContent length ≥ MIN_CONTENT_CHARS (200)
 *   - 'readability-failed' — below threshold, parse() returned null, or threw
 *
 * When 'readability-failed' is returned, the caller (scraper) should invoke
 * the Puppeteer fallback path (US-SC-004).
 *
 * [Spec: US-SC-002, BG-SC-001, BG-SC-002, NFR-SC-001]
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

import type { ExtractionOutput } from './types.js';

/** Minimum character count for Readability success — constant: 200 (DC-SC-005). */
const MIN_CONTENT_CHARS = 200;

/**
 * Extract clean text content from raw HTML using jsdom + Mozilla Readability.
 *
 * Creates a JSDOM instance from the HTML string with the page URL set as the
 * base URI, passes the resulting DOM document to Mozilla Readability, and
 * returns the extracted title and plain text.
 *
 * Success (textContent length ≥ MIN_CONTENT_CHARS): the result carries
 * extractionMethod `'readability'` and the caller does NOT invoke Puppeteer
 * fallback.
 *
 * Failure (length < MIN_CONTENT_CHARS, `parse()` returns `null`, or an error
 * is thrown): the result carries extractionMethod `'readability-failed'` with
 * empty fields, signalling the caller to attempt Puppeteer fallback.
 *
 * JSDOM references are released in a `finally` block to support memory
 * efficiency (NFR-SC-001).
 *
 * [Implements: US-SC-002, BG-SC-001, BG-SC-002]
 *
 * @param html  - Raw HTML string from the primary HTTP fetch.
 * @param url   - Page URL, used as the base URI for the JSDOM instance.
 * @param minContentChars - Override for the success threshold (default: 200).
 * @returns ExtractionOutput with title, textContent, extractionMethod, charCount.
 */
// [Implements: US-SC-002, BG-SC-001, BG-SC-002]
export function extractWithReadability(
  html: string,
  url: string,
  minContentChars: number = MIN_CONTENT_CHARS
): ExtractionOutput {
  let dom: JSDOM | null = null;

  try {
    // [Implements: BG-SC-001] Construct DOM from HTML with base URI for Readability
    dom = new JSDOM(html, { url });

    const doc = dom.window.document;

    // [Implements: BG-SC-002] Run Readability extraction; parse() may return null
    const reader = new Readability(doc);
    const article = reader.parse();

    if (article === null) {
      // parse() returned null — flag as readability-failed for Puppeteer fallback
      return {
        title: '',
        textContent: '',
        extractionMethod: 'readability-failed',
        charCount: 0,
      };
    }

    const title = article.title ?? '';
    const textContent = article.textContent ?? '';
    const charCount = textContent.length;

    // [Implements: US-SC-002] ≥ threshold → 'readability'; otherwise → 'readability-failed'
    const extractionMethod: ExtractionOutput['extractionMethod'] =
      charCount >= minContentChars ? 'readability' : 'readability-failed';

    return { title, textContent, extractionMethod, charCount };
  } catch {
    // Readability or JSDOM threw — flag as readability-failed
    return {
      title: '',
      textContent: '',
      extractionMethod: 'readability-failed',
      charCount: 0,
    };
  } finally {
    // [Implements: NFR-SC-001] Release JSDOM references for memory efficiency
    if (dom !== null) {
      try {
        dom.window.close();
      } catch {
        // best-effort cleanup — ignore errors
      }
      dom = null;
    }
  }
}
