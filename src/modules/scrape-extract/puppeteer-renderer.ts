/**
 * Puppeteer headless browser fallback renderer.
 *
 * Provides the fallback rendering path for JavaScript-heavy SPA pages where
 * the primary Readability extraction yields insufficient content (< 200 chars).
 * Dynamically imports Puppeteer, launches a headless browser with hardened
 * sandbox-disabling flags, navigates to the URL, waits for network idle,
 * extracts the fully-rendered HTML, and returns it for Readability re-extraction.
 *
 * All browser console output is captured and routed to stderr exclusively.
 * If Puppeteer is not installed or fails to launch, the function returns a
 * failure result rather than crashing the process.
 *
 * [Spec: US-SC-004, US-SC-011, NFR-SC-002, NFR-SC-006, DC-SC-004, BG-SC-003]
 */

import type { Browser } from 'puppeteer';
import type { RenderResult } from './types.js';

/** Maximum wait time in ms for networkidle0 during rendering (US-SC-004). */
const MAX_NETWORK_IDLE_WAIT_MS = 10_000;

// [Implements: US-SC-004, US-SC-011, NFR-SC-002, NFR-SC-006, DC-SC-004, BG-SC-003]
/**
 * Render a URL using a headless Puppeteer browser and return the fully-rendered HTML.
 *
 * This function is the fallback path invoked when the primary Readability
 * extraction on the static HTML yields fewer than `minContentChars` (200)
 * characters. It launches a Chromium instance via Puppeteer, navigates to the
 * target URL, waits for `networkidle0` (or at most 10 seconds), and extracts
 * the page's DOM HTML.
 *
 * The entire body is wrapped in a try/catch to guarantee that no uncaught
 * errors propagate to the caller. If Puppeteer is not installed, fails to
 * launch, or encounters a navigation error, a `RenderResult` with
 * `success: false` is returned with a descriptive error message.
 *
 * All console messages and page errors emitted by the browser are captured
 * and written to `process.stderr` only — never to stdout (NFR-SC-006).
 *
 * @param url       - The URL to render.
 * @param timeoutMs - Per-page timeout in milliseconds. The actual navigation
 *                    timeout is capped at 10 seconds per the networkidle0 wait
 *                    requirement (US-SC-004).
 * @returns         - `RenderResult` with rendered HTML on success, or an error
 *                    message on failure.
 *
 * [Spec: US-SC-004, US-SC-011, NFR-SC-002, NFR-SC-006, DC-SC-004, BG-SC-003]
 */
export async function renderPage(
  url: string,
  timeoutMs: number
): Promise<RenderResult> {
  let browser: Browser | null = null;

  try {
    // [Implements: BG-SC-003] Dynamic import — handles the case where Puppeteer
    // is not installed gracefully without crashing the process.
    const puppeteer = await import('puppeteer');

    // [Implements: NFR-SC-002] Launch headless browser with hardened flags
    // for container/CI environments (--no-sandbox, --disable-gpu,
    // --disable-dev-shm-usage).
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
      ],
    });

    const page = await browser.newPage();

    // [Implements: NFR-SC-006] Capture all browser console output and route
    // to stderr only — never stdout.
    page.on('console', (msg) => {
      process.stderr.write(`[scrape] puppeteer console: ${msg.text()}\n`);
    });

    page.on('pageerror', (err: Error) => {
      process.stderr.write(`[scrape] puppeteer pageerror: ${err.message}\n`);
    });

    // [Implements: US-SC-004] Wait for networkidle0 or max 10 seconds,
    // whichever comes first. The navigation timeout is the lesser of the
    // provided timeoutMs and the 10-second network idle ceiling.
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: Math.min(timeoutMs, MAX_NETWORK_IDLE_WAIT_MS),
    });

    // [Implements: US-SC-004] Extract the fully-rendered HTML from the DOM
    // after JavaScript execution completes.
    const html = await page.content();

    return { success: true, html, error: null };
  } catch (error) {
    // [Implements: NFR-SC-002] Log warning to stderr and return error result
    // rather than crashing the process. Covers: Puppeteer not installed,
    // browser launch failure, navigation timeout, and any other unexpected
    // error during rendering.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[scrape] puppeteer render failed for ${url}: ${message}\n`
    );

    return {
      success: false,
      html: null,
      error: `Puppeteer rendering failed: ${message}`,
    };
  } finally {
    // [Implements: US-SC-004] Always close the browser to release system
    // resources, even on error or timeout. Best-effort — ignore close errors.
    if (browser !== null) {
      try {
        await browser.close();
      } catch {
        // Best-effort cleanup — ignore errors during close.
      }
    }
  }
}
