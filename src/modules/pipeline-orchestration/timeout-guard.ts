/**
 * TimeoutGuard — enforces overall pipeline timeouts via AbortController.
 *
 * The guard starts a timer for PIPELINE_TIMEOUT_MS. On expiry it fires
 * controller.abort() so that in-flight scrape operations (both HTTP-based
 * and Puppeteer-based) receive the abort signal and cancel their underlying
 * connections. Provides cleanup() to clear the timer, and exposes the
 * AbortSignal for propagation to downstream stages.
 *
 * [Spec: US-PL-004, US-PL-005, US-PL-015, NFR-PL-005]
 */

/** Default overall pipeline timeout in milliseconds (DC-PL-002, US-PL-004). */
export const DEFAULT_PIPELINE_TIMEOUT_MS = 30000;

/**
 * TimeoutGuard wraps an AbortController with a self-starting timeout timer.
 *
 * On construction a timer is started. When the timer elapses, the underlying
 * AbortController is aborted, propagating the signal to any in-flight
 * operation that received `guard.signal` (e.g. via ScrapeOptions.signal).
 *
 * Call `cleanup()` when the pipeline completes normally to cancel the timer
 * and release resources. The method is idempotent — multiple calls are safe.
 *
 * [Implements: US-PL-004, US-PL-005, US-PL-015, NFR-PL-005]
 */
export class TimeoutGuard {
  private readonly controller: AbortController;
  private timer: ReturnType<typeof setTimeout> | null;
  private cleanedUp: boolean;

  // [Constraint: DC-PL-002, US-PL-004]
  constructor(timeoutMs: number) {
    this.controller = new AbortController();
    this.cleanedUp = false;

    this.timer = setTimeout(() => {
      process.stderr.write(
        `[PL] timeout: pipeline exceeded ${timeoutMs}ms — aborting in-flight operations\n`
      );
      // [Implements: US-PL-015] Signal all in-flight operations to abort
      this.controller.abort();
    }, timeoutMs);
  }

  /**
   * The AbortSignal for this guard. Pass it to in-flight operations (scrape
   * calls, fetch requests, Puppeteer pages) so they cancel when the timeout
   * elapses.
   *
   * [Implements: US-PL-015]
   */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Whether the pipeline has been aborted due to timeout.
   *
   * [Implements: US-PL-015, US-PL-004]
   */
  get isAborted(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Clears the pending timeout timer and releases associated resources.
   *
   * Called when the pipeline completes before the timeout elapses (US-PL-004,
   * US-PL-005). Safe to call multiple times — subsequent calls are no-ops.
   *
   * [Implements: NFR-PL-005, US-PL-004, US-PL-005]
   */
  cleanup(): void {
    if (this.cleanedUp) {
      return;
    }
    this.cleanedUp = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Convenience factory for creating a TimeoutGuard instance.
 *
 * [Implements: US-PL-004, US-PL-005]
 */
// [Implements: US-PL-004, US-PL-005]
export function createTimeoutGuard(timeoutMs: number): TimeoutGuard {
  return new TimeoutGuard(timeoutMs);
}
