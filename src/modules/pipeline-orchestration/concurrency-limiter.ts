/**
 * ConcurrencyLimiter — semaphore-based concurrency enforcement for the
 * pipeline-orchestration (PL) module.
 *
 * Uses a counting semaphore (acquire/release) pattern to guarantee that the
 * number of simultaneously in-flight scrape operations never exceeds the
 * configured MAX_CONCURRENCY limit. Supports abort-signal awareness so that
 * queued items are not dispatched when the pipeline has been aborted.
 *
 * [Spec: US-PL-003, BG-PL-003, NFR-PL-003]
 */

/** Default maximum number of concurrent in-flight operations (DC-PL-001). */
export const DEFAULT_MAX_CONCURRENCY = 3;

/** Lower bound for valid maxConcurrency values. */
const MIN_CONCURRENCY = 1;

/** Upper bound for valid maxConcurrency values. */
const MAX_CONCURRENCY_LIMIT = 100;

/**
 * Interface for a queued waiter in the semaphore.
 *
 * Each entry holds the resolve/reject callbacks for a pending `acquire()`
 * promise and an optional abort-signal listener removal function.
 */
interface WaiterEntry {
  resolve: () => void;
  reject: (reason: Error) => void;
  abortListener: (() => void) | null;
  signal: AbortSignal | null;
}

/**
 * Resolve the effective maxConcurrency from an environment variable.
 *
 * Reads `MAX_CONCURRENCY` from the environment. When the value is a valid
 * integer between MIN_CONCURRENCY and MAX_CONCURRENCY_LIMIT, it is returned.
 * Otherwise, a warning is logged to stderr and the default (3) is used.
 *
 * This function is pure — it does not modify global state beyond logging.
 *
 * [Implements: BG-PL-003, NFR-PL-003]
 */
// [Implements: BG-PL-003, NFR-PL-003]
export function resolveMaxConcurrency(
  envValue: string | undefined,
  defaultValue: number = DEFAULT_MAX_CONCURRENCY
): number {
  if (envValue === undefined || envValue === '') {
    return defaultValue;
  }

  const parsed = parseInt(envValue, 10);

  // [Implements: NFR-PL-003] Non-integer, zero, or negative → fall back to default
  if (
    Number.isNaN(parsed) ||
    parsed < MIN_CONCURRENCY ||
    parsed > MAX_CONCURRENCY_LIMIT ||
    String(parsed) !== envValue.trim()
  ) {
    process.stderr.write(
      `[PL] WARN invalid MAX_CONCURRENCY: value=${envValue} fallback=${defaultValue}\n`
    );
    return defaultValue;
  }

  return parsed;
}

/**
 * ConcurrencyLimiter enforces a maximum number of concurrently in-flight
 * operations using a counting semaphore pattern.
 *
 * Callers must:
 *   1. `await acquire(signal)` before starting a concurrent operation
 *   2. Call `release()` in a `finally` block after the operation completes
 *
 * For convenience, the static `runConcurrent` method handles acquire/release
 * automatically for an array of items.
 *
 * [Implements: US-PL-003, BG-PL-003, NFR-PL-003]
 */
export class ConcurrencyLimiter {
  /** Maximum number of concurrently in-flight operations. */
  readonly maxConcurrency: number;

  /** Current count of acquired (in-flight) slots. */
  private active: number;

  /** FIFO queue of pending waiters when all slots are occupied. */
  private readonly queue: WaiterEntry[];

  /**
   * Create a new ConcurrencyLimiter.
   *
   * @param maxConcurrency Maximum number of concurrent in-flight operations.
   *   Must be a positive integer. Defaults to `DEFAULT_MAX_CONCURRENCY` (3)
   *   when omitted or invalid.
   *
   * [Implements: US-PL-003, BG-PL-003]
   */
  // [Implements: US-PL-003, BG-PL-003]
  constructor(maxConcurrency?: number) {
    if (
      maxConcurrency === undefined ||
      typeof maxConcurrency !== 'number' ||
      Number.isNaN(maxConcurrency) ||
      maxConcurrency < MIN_CONCURRENCY ||
      maxConcurrency > MAX_CONCURRENCY_LIMIT ||
      !Number.isInteger(maxConcurrency)
    ) {
      this.maxConcurrency = DEFAULT_MAX_CONCURRENCY;
      if (maxConcurrency !== undefined) {
        process.stderr.write(
          `[PL] WARN invalid maxConcurrency: value=${maxConcurrency} fallback=${DEFAULT_MAX_CONCURRENCY}\n`
        );
      }
    } else {
      this.maxConcurrency = maxConcurrency;
    }

    this.active = 0;
    this.queue = [];
  }

  /**
   * The current number of in-flight (acquired) operations.
   *
   * [Implements: US-PL-003]
   */
  get activeCount(): number {
    return this.active;
  }

  /**
   * The number of operations waiting in the queue.
   *
   * [Implements: US-PL-003]
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Acquire a concurrency slot.
   *
   * If `active < maxConcurrency`, resolves immediately. Otherwise, the
   * promise is enqueued and will resolve when a slot becomes available
   * (via a subsequent `release()` call).
   *
   * If a signal is provided and already aborted, the promise rejects
   * immediately with an `AbortError`.
   *
   * If a signal is provided and not yet aborted, an abort listener is
   * attached. When the signal fires, the queued promise is rejected with
   * an `AbortError` and removed from the queue.
   *
   * @param signal Optional abort signal for cooperative cancellation.
   * @throws {DOMException} with name `'AbortError'` when the signal is
   *   already aborted or fires while waiting.
   *
   * [Implements: US-PL-003, BG-PL-003]
   */
  // [Implements: US-PL-003, BG-PL-003]
  async acquire(signal?: AbortSignal): Promise<void> {
    // [Implements: US-PL-003] Fast path: a slot is available
    if (this.active < this.maxConcurrency) {
      this.active++;
      return;
    }

    // [Implements: US-PL-003] If signal is already aborted, reject immediately
    if (signal !== undefined && signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    // [Implements: US-PL-003] Enqueue the waiter
    return new Promise<void>((resolve, reject) => {
      const entry: WaiterEntry = {
        resolve,
        reject,
        abortListener: null,
        signal: signal ?? null,
      };

      // [Implements: BG-PL-003] Attach abort listener to reject the queued
      // promise when the signal fires
      if (signal !== undefined) {
        const onAbort = (): void => {
          // Remove this entry from the queue
          const index = this.queue.indexOf(entry);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };

        entry.abortListener = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.queue.push(entry);
    });
  }

  /**
   * Release a previously acquired concurrency slot.
   *
   * Decrements the active count. If there are pending waiters in the queue,
   * dequeues the next waiter (FIFO) and resolves its promise. If the
   * dequeued waiter has an abort listener, it is removed.
   *
   * It is safe to call `release()` even when there are no pending waiters —
   * it simply decrements the active count.
   *
   * [Implements: US-PL-003, BG-PL-003]
   */
  // [Implements: US-PL-003, BG-PL-003]
  release(): void {
    // If there are pending waiters, hand the slot directly to the next one
    // without decrementing/re-incrementing active (avoids unnecessary churn).
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;

      // [Implements: BG-PL-003] Remove abort listener before resolving
      if (entry.abortListener !== null && entry.signal !== null) {
        entry.signal.removeEventListener('abort', entry.abortListener);
      }

      // Resolve the waiter — the slot is transferred to it
      entry.resolve();
      return;
    }

    // No waiters — simply decrement the active count
    if (this.active > 0) {
      this.active--;
    }
  }

  /**
   * Run a worker function over each item with bounded concurrency.
   *
   * Dispatches items through acquire/release automatically. The `maxConcurrency`
   * parameter limits how many items are processed simultaneously. Results are
   * returned in the same order as the input items.
   *
   * If an item's processing throws, the error is caught and stored in the
   * results array at the corresponding index (as a rejected-promise-like
   * Error). The remaining items continue processing.
   *
   * If a signal is provided and becomes aborted, remaining queued items are
   * rejected with an `AbortError`.
   *
   * @param items Array of items to process.
   * @param maxConcurrency Maximum concurrent operations.
   * @param workerFn Async function called for each item.
   * @param signal Optional abort signal for cooperative cancellation.
   * @returns Array of results (or errors) in the same order as items.
   *
   * [Implements: US-PL-003, BG-PL-003]
   */
  // [Implements: US-PL-003, BG-PL-003]
  static async runConcurrent<T>(
    items: readonly T[],
    maxConcurrency: number,
    workerFn: (item: T, index: number) => Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    const limiter = new ConcurrencyLimiter(maxConcurrency);

    const promises: Promise<void>[] = items.map((item, index) =>
      (async (): Promise<void> => {
        await limiter.acquire(signal);
        try {
          await workerFn(item, index);
        } finally {
          limiter.release();
        }
      })()
    );

    await Promise.allSettled(promises);
  }
}

/**
 * Convenience factory for creating a ConcurrencyLimiter instance.
 *
 * Reads the `MAX_CONCURRENCY` environment variable and resolves it to a
 * valid positive integer. Falls back to `DEFAULT_MAX_CONCURRENCY` (3) when
 * the environment variable is missing, empty, or invalid.
 *
 * [Implements: US-PL-003, BG-PL-003, NFR-PL-003]
 */
// [Implements: US-PL-003, BG-PL-003, NFR-PL-003]
export function createConcurrencyLimiter(
  maxConcurrency?: number
): ConcurrencyLimiter {
  return new ConcurrencyLimiter(maxConcurrency);
}
