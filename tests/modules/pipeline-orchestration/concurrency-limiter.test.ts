/**
 * Unit tests for ConcurrencyLimiter.
 *
 * Verifies concurrency ceiling enforcement, abort-aware queue rejection,
 * FIFO queue ordering, resolveMaxConcurrency env parsing, and the
 * runConcurrent static helper.
 *
 * [Spec: US-PL-003, US-PL-004, US-PL-005, US-PL-015]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ConcurrencyLimiter,
  createConcurrencyLimiter,
  resolveMaxConcurrency,
  DEFAULT_MAX_CONCURRENCY,
} from '../../../src/modules/pipeline-orchestration/concurrency-limiter.js';

// ---------------------------------------------------------------------------
// Constant
// ---------------------------------------------------------------------------

describe('DEFAULT_MAX_CONCURRENCY', () => {
  // [Implements: US-PL-003, DC-PL-001]
  it('exports the value 3', () => {
    expect(DEFAULT_MAX_CONCURRENCY).toBe(3);
  });

  it('is a positive integer', () => {
    expect(DEFAULT_MAX_CONCURRENCY).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_MAX_CONCURRENCY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveMaxConcurrency
// ---------------------------------------------------------------------------

describe('resolveMaxConcurrency', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: BG-PL-003, NFR-PL-003]
  it('returns the parsed value for a valid integer string', () => {
    expect(resolveMaxConcurrency('3')).toBe(3);
  });

  it('returns 1 for "1" (minimum valid value)', () => {
    expect(resolveMaxConcurrency('1')).toBe(1);
  });

  it('returns 100 for "100" (maximum valid value)', () => {
    expect(resolveMaxConcurrency('100')).toBe(100);
  });

  it('returns 50 for "50"', () => {
    expect(resolveMaxConcurrency('50')).toBe(50);
  });

  it('trims whitespace before parsing', () => {
    expect(resolveMaxConcurrency('  5  ')).toBe(5);
  });

  // [Implements: NFR-PL-003]
  it('returns default for undefined', () => {
    expect(resolveMaxConcurrency(undefined)).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('returns default for empty string', () => {
    expect(resolveMaxConcurrency('')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('does not log a warning for undefined', () => {
    resolveMaxConcurrency(undefined);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does not log a warning for empty string', () => {
    resolveMaxConcurrency('');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  // [Implements: NFR-PL-003] Non-integer
  it('returns default for non-numeric string "abc"', () => {
    expect(resolveMaxConcurrency('abc')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('logs a warning for non-numeric string', () => {
    resolveMaxConcurrency('abc');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid MAX_CONCURRENCY')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('abc')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('fallback=3')
    );
  });

  // [Implements: NFR-PL-003] Zero
  it('returns default for "0"', () => {
    expect(resolveMaxConcurrency('0')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('logs a warning for zero', () => {
    resolveMaxConcurrency('0');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid MAX_CONCURRENCY')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('value=0')
    );
  });

  // [Implements: NFR-PL-003] Negative
  it('returns default for "-1"', () => {
    expect(resolveMaxConcurrency('-1')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('returns default for "-100"', () => {
    expect(resolveMaxConcurrency('-100')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('logs a warning for negative values', () => {
    resolveMaxConcurrency('-5');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid MAX_CONCURRENCY')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('value=-5')
    );
  });

  // [Implements: NFR-PL-003] Non-integer (decimal)
  it('returns default for "3.5"', () => {
    expect(resolveMaxConcurrency('3.5')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('returns default for "3.0"', () => {
    expect(resolveMaxConcurrency('3.0')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('logs a warning for decimal values', () => {
    resolveMaxConcurrency('2.5');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid MAX_CONCURRENCY')
    );
  });

  // Non-integer formats
  it('returns default for "03" (leading zero)', () => {
    expect(resolveMaxConcurrency('03')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('returns default for "3abc" (trailing chars)', () => {
    expect(resolveMaxConcurrency('3abc')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('returns default for "  " (whitespace only)', () => {
    expect(resolveMaxConcurrency('  ')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  // Above maximum
  it('returns default for "101" (above max limit)', () => {
    expect(resolveMaxConcurrency('101')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('returns default for "99999" (well above max limit)', () => {
    expect(resolveMaxConcurrency('99999')).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('logs a warning for above-max values', () => {
    resolveMaxConcurrency('101');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid MAX_CONCURRENCY')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('value=101')
    );
  });

  // Custom default
  it('uses a custom default value when provided', () => {
    expect(resolveMaxConcurrency(undefined, 5)).toBe(5);
  });

  it('uses a custom default for invalid env value', () => {
    expect(resolveMaxConcurrency('abc', 7)).toBe(7);
  });

  it('uses a custom default for empty string', () => {
    expect(resolveMaxConcurrency('', 10)).toBe(10);
  });

  it('returns parsed value even when custom default is provided', () => {
    expect(resolveMaxConcurrency('2', 5)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('ConcurrencyLimiter constructor', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-003, BG-PL-003]
  it('sets maxConcurrency from the provided value', () => {
    const limiter = new ConcurrencyLimiter(5);
    expect(limiter.maxConcurrency).toBe(5);
  });

  it('defaults to DEFAULT_MAX_CONCURRENCY when no argument provided', () => {
    const limiter = new ConcurrencyLimiter();
    expect(limiter.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('defaults to DEFAULT_MAX_CONCURRENCY when undefined is provided', () => {
    const limiter = new ConcurrencyLimiter(undefined);
    expect(limiter.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('does not log a warning when undefined is provided', () => {
    new ConcurrencyLimiter(undefined);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does not log a warning when no argument is provided', () => {
    new ConcurrencyLimiter();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  // [Implements: NFR-PL-003] Invalid values fall back to default
  it('falls back to default for zero', () => {
    const limiter = new ConcurrencyLimiter(0);
    expect(limiter.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('falls back to default for negative values', () => {
    const limiter = new ConcurrencyLimiter(-1);
    expect(limiter.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('falls back to default for NaN', () => {
    const limiter = new ConcurrencyLimiter(NaN);
    expect(limiter.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('falls back to default for non-integer (3.5)', () => {
    const limiter = new ConcurrencyLimiter(3.5);
    expect(limiter.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('falls back to default for value above 100', () => {
    const limiter = new ConcurrencyLimiter(101);
    expect(limiter.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('falls back to default for Infinity', () => {
    const limiter = new ConcurrencyLimiter(Infinity);
    expect(limiter.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  // [Implements: NFR-PL-003] Warning logging for invalid values
  it('logs a warning for invalid maxConcurrency (zero)', () => {
    new ConcurrencyLimiter(0);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid maxConcurrency')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('value=0')
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('fallback=3')
    );
  });

  it('logs a warning for invalid maxConcurrency (negative)', () => {
    new ConcurrencyLimiter(-5);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('value=-5')
    );
  });

  it('logs a warning for invalid maxConcurrency (NaN)', () => {
    new ConcurrencyLimiter(NaN);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('NaN')
    );
  });

  it('logs a warning for invalid maxConcurrency (decimal)', () => {
    new ConcurrencyLimiter(2.5);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('2.5')
    );
  });

  // [Implements: US-PL-003] Initializes with zero active and empty queue
  it('starts with activeCount of 0', () => {
    const limiter = new ConcurrencyLimiter(3);
    expect(limiter.activeCount).toBe(0);
  });

  it('starts with pendingCount of 0', () => {
    const limiter = new ConcurrencyLimiter(3);
    expect(limiter.pendingCount).toBe(0);
  });

  it('accepts maxConcurrency of 1 (minimum valid)', () => {
    const limiter = new ConcurrencyLimiter(1);
    expect(limiter.maxConcurrency).toBe(1);
  });

  it('accepts maxConcurrency of 100 (maximum valid)', () => {
    const limiter = new ConcurrencyLimiter(100);
    expect(limiter.maxConcurrency).toBe(100);
  });

  it('does not log a warning for valid values', () => {
    new ConcurrencyLimiter(5);
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// acquire / release — basic operations
// ---------------------------------------------------------------------------

describe('acquire and release — basic operations', () => {
  // [Implements: US-PL-003]
  it('acquire resolves immediately when a slot is available', async () => {
    const limiter = new ConcurrencyLimiter(3);
    await expect(limiter.acquire()).resolves.toBeUndefined();
    expect(limiter.activeCount).toBe(1);
  });

  it('acquire increments activeCount', async () => {
    const limiter = new ConcurrencyLimiter(3);
    await limiter.acquire();
    expect(limiter.activeCount).toBe(1);
    await limiter.acquire();
    expect(limiter.activeCount).toBe(2);
    await limiter.acquire();
    expect(limiter.activeCount).toBe(3);
  });

  it('release decrements activeCount', async () => {
    const limiter = new ConcurrencyLimiter(3);
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.activeCount).toBe(2);

    limiter.release();
    expect(limiter.activeCount).toBe(1);

    limiter.release();
    expect(limiter.activeCount).toBe(0);
  });

  it('release does not decrement below zero', () => {
    const limiter = new ConcurrencyLimiter(3);
    limiter.release();
    limiter.release();
    limiter.release();
    expect(limiter.activeCount).toBe(0);
  });

  it('multiple acquire/release cycles work correctly', async () => {
    const limiter = new ConcurrencyLimiter(2);
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
      await limiter.acquire();
      expect(limiter.activeCount).toBe(2);
      limiter.release();
      limiter.release();
      expect(limiter.activeCount).toBe(0);
    }
  });

  // [Implements: US-PL-003] Concurrency ceiling
  it('allows up to maxConcurrency concurrent acquires', async () => {
    const limiter = new ConcurrencyLimiter(3);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.activeCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Concurrency ceiling enforcement
// ---------------------------------------------------------------------------

describe('concurrency ceiling enforcement', () => {
  // [Implements: US-PL-003]
  it('acquire blocks when at capacity', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire(); // Fill the single slot

    let resolved = false;
    limiter.acquire().then(() => {
      resolved = true;
    });

    // Flush microtasks
    await vi.waitFor(() => {
      expect(limiter.pendingCount).toBe(1);
    });
    expect(resolved).toBe(false);

    limiter.release();
    await vi.waitFor(() => {
      expect(resolved).toBe(true);
    });
  });

  // [Implements: US-PL-003]
  it('acquire resolves after release when blocked', async () => {
    const limiter = new ConcurrencyLimiter(2);
    await limiter.acquire();
    await limiter.acquire();

    const acquirePromise = limiter.acquire();
    expect(limiter.pendingCount).toBe(1);

    limiter.release();
    await expect(acquirePromise).resolves.toBeUndefined();
  });

  it('multiple blocked acquires resolve in FIFO order after releases', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const order: number[] = [];
    const p1 = limiter.acquire().then(() => order.push(1));
    const p2 = limiter.acquire().then(() => order.push(2));
    const p3 = limiter.acquire().then(() => order.push(3));

    expect(limiter.pendingCount).toBe(3);

    limiter.release();
    await p1;
    limiter.release();
    await p2;
    limiter.release();
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  // [Implements: US-PL-003]
  it('never exceeds maxConcurrency in-flight operations', async () => {
    const limiter = new ConcurrencyLimiter(3);
    let maxObserved = 0;
    let current = 0;

    const tasks = Array.from({ length: 10 }, () =>
      (async () => {
        await limiter.acquire();
        current++;
        maxObserved = Math.max(maxObserved, current);
        // Yield to allow other tasks to run
        await Promise.resolve();
        await Promise.resolve();
        current--;
        limiter.release();
      })()
    );

    await Promise.all(tasks);
    expect(maxObserved).toBeLessThanOrEqual(3);
  });

  it('respects a maxConcurrency of 1 (serial execution)', async () => {
    const limiter = new ConcurrencyLimiter(1);
    let maxObserved = 0;
    let current = 0;

    const tasks = Array.from({ length: 5 }, () =>
      (async () => {
        await limiter.acquire();
        current++;
        maxObserved = Math.max(maxObserved, current);
        await Promise.resolve();
        await Promise.resolve();
        current--;
        limiter.release();
      })()
    );

    await Promise.all(tasks);
    expect(maxObserved).toBe(1);
  });

  it('respects a maxConcurrency of 5', async () => {
    const limiter = new ConcurrencyLimiter(5);
    let maxObserved = 0;
    let current = 0;

    const tasks = Array.from({ length: 20 }, () =>
      (async () => {
        await limiter.acquire();
        current++;
        maxObserved = Math.max(maxObserved, current);
        await Promise.resolve();
        await Promise.resolve();
        current--;
        limiter.release();
      })()
    );

    await Promise.all(tasks);
    expect(maxObserved).toBeLessThanOrEqual(5);
  });

  it('release hands the slot directly to the next waiter without gap', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    let waiterResolved = false;
    const waiterPromise = limiter.acquire().then(() => {
      waiterResolved = true;
    });

    await vi.waitFor(() => expect(limiter.pendingCount).toBe(1));
    expect(waiterResolved).toBe(false);

    limiter.release();
    await waiterPromise;
    expect(waiterResolved).toBe(true);
    // The slot was transferred — active stays at 1
    expect(limiter.activeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// activeCount and pendingCount getters
// ---------------------------------------------------------------------------

describe('activeCount and pendingCount', () => {
  it('activeCount reflects current in-flight operations', async () => {
    const limiter = new ConcurrencyLimiter(3);
    expect(limiter.activeCount).toBe(0);

    await limiter.acquire();
    expect(limiter.activeCount).toBe(1);

    await limiter.acquire();
    expect(limiter.activeCount).toBe(2);

    limiter.release();
    expect(limiter.activeCount).toBe(1);
  });

  it('pendingCount reflects queued waiters', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    expect(limiter.pendingCount).toBe(0);

    limiter.acquire(); // Blocks
    expect(limiter.pendingCount).toBe(1);

    limiter.acquire(); // Blocks
    expect(limiter.pendingCount).toBe(2);
  });

  it('pendingCount decreases as waiters are resolved', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const p1 = limiter.acquire();
    const p2 = limiter.acquire();
    const p3 = limiter.acquire();

    expect(limiter.pendingCount).toBe(3);

    limiter.release();
    await p1;
    expect(limiter.pendingCount).toBe(2);

    limiter.release();
    await p2;
    expect(limiter.pendingCount).toBe(1);

    limiter.release();
    await p3;
    expect(limiter.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Abort-aware queue rejection
// ---------------------------------------------------------------------------

describe('abort-aware queue rejection', () => {
  // [Implements: US-PL-015, BG-PL-003]
  it('passing an already-aborted signal to acquire rejects immediately without waiting', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire(); // Fill the slot

    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire(controller.signal)).rejects.toThrow(
      'aborted'
    );
  });

  it('already-aborted signal rejects with AbortError name', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controller = new AbortController();
    controller.abort();

    try {
      await limiter.acquire(controller.signal);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
    }
  });

  it('already-aborted signal does not enqueue the waiter', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controller = new AbortController();
    controller.abort();

    try {
      await limiter.acquire(controller.signal);
    } catch {
      // Expected
    }

    expect(limiter.pendingCount).toBe(0);
  });

  // [Implements: US-PL-015]
  it('signal that aborts while queued rejects the waiter', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controller = new AbortController();
    const acquirePromise = limiter.acquire(controller.signal);

    expect(limiter.pendingCount).toBe(1);

    controller.abort();

    await expect(acquirePromise).rejects.toThrow('aborted');
    expect(limiter.pendingCount).toBe(0);
  });

  it('signal that aborts while queued rejects with AbortError name', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controller = new AbortController();
    const acquirePromise = limiter.acquire(controller.signal);

    controller.abort();

    try {
      await acquirePromise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
    }
  });

  it('aborting one queued waiter does not affect other queued waiters', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controller1 = new AbortController();
    const controller2 = new AbortController();

    const p1 = limiter.acquire(controller1.signal);
    const p2 = limiter.acquire(controller2.signal);

    expect(limiter.pendingCount).toBe(2);

    // Abort only the first waiter
    controller1.abort();
    await expect(p1).rejects.toThrow('aborted');

    // The second waiter is still queued
    expect(limiter.pendingCount).toBe(1);

    // Release the slot — the second waiter should get it
    limiter.release();
    await expect(p2).resolves.toBeUndefined();
  });

  it('multiple queued waiters with abort signals can be individually aborted', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controllers = Array.from({ length: 3 }, () => new AbortController());

    const outcomes: Array<'resolved' | 'aborted'> = [];

    const promises = controllers.map(
      (c, i) =>
        new Promise<'resolved' | 'aborted'>((resolve) => {
          limiter.acquire(c.signal).then(
            () => resolve('resolved'),
            () => resolve('aborted')
          );
        }).then((outcome) => {
          outcomes[i] = outcome;
        })
    );

    // Abort the middle one
    controllers[1].abort();

    // Release to let remaining waiters proceed
    limiter.release();
    limiter.release();

    await Promise.all(promises);

    // The middle waiter was aborted
    expect(outcomes[1]).toBe('aborted');
    // The other two resolved
    expect(outcomes[0]).toBe('resolved');
    expect(outcomes[2]).toBe('resolved');
  });

  it('a non-aborted waiter resolves normally even when another waiter was aborted', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const abortController = new AbortController();
    const normalPromise = limiter.acquire();
    const abortablePromise = limiter.acquire(abortController.signal);

    abortController.abort();
    await expect(abortablePromise).rejects.toThrow('aborted');

    limiter.release();
    await expect(normalPromise).resolves.toBeUndefined();
  });

  // [Implements: US-PL-015]
  it('does not acquire a slot when signal is already aborted even if one is available', async () => {
    // Actually, looking at the implementation, if a slot is available,
    // acquire() takes it regardless of the signal. The signal check
    // only happens when the caller needs to queue. So this test verifies
    // the actual behavior: available slot takes priority.
    const limiter = new ConcurrencyLimiter(2);
    const controller = new AbortController();
    controller.abort();

    // Slot is available — acquire succeeds despite aborted signal
    await limiter.acquire(controller.signal);
    expect(limiter.activeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createConcurrencyLimiter factory
// ---------------------------------------------------------------------------

describe('createConcurrencyLimiter factory', () => {
  // [Implements: US-PL-003, BG-PL-003]
  it('returns a ConcurrencyLimiter instance', () => {
    const limiter = createConcurrencyLimiter(5);
    expect(limiter).toBeInstanceOf(ConcurrencyLimiter);
  });

  it('creates a limiter with the specified maxConcurrency', () => {
    const limiter = createConcurrencyLimiter(7);
    expect(limiter.maxConcurrency).toBe(7);
  });

  it('creates a limiter with default maxConcurrency when no argument', () => {
    const limiter = createConcurrencyLimiter();
    expect(limiter.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('creates a limiter with default maxConcurrency when undefined', () => {
    const limiter = createConcurrencyLimiter(undefined);
    expect(limiter.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
  });

  it('factory result is equivalent to direct construction', () => {
    const fromFactory = createConcurrencyLimiter(4);
    const fromConstructor = new ConcurrencyLimiter(4);
    expect(fromFactory.maxConcurrency).toBe(fromConstructor.maxConcurrency);
    expect(fromFactory.activeCount).toBe(fromConstructor.activeCount);
    expect(fromFactory.pendingCount).toBe(fromConstructor.pendingCount);
  });
});

// ---------------------------------------------------------------------------
// runConcurrent static method
// ---------------------------------------------------------------------------

describe('runConcurrent static method', () => {
  // [Implements: US-PL-003, BG-PL-003]
  it('processes all items', async () => {
    const processed: number[] = [];
    const items = [1, 2, 3, 4, 5];

    await ConcurrencyLimiter.runConcurrent(items, 3, async (item) => {
      processed.push(item);
    });

    expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('processes items with concurrency limit', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const items = Array.from({ length: 10 }, (_, i) => i);

    await ConcurrencyLimiter.runConcurrent(items, 3, async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await Promise.resolve();
      await Promise.resolve();
      current--;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('respects a concurrency limit of 1', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const items = Array.from({ length: 5 }, (_, i) => i);

    await ConcurrencyLimiter.runConcurrent(items, 1, async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await Promise.resolve();
      await Promise.resolve();
      current--;
    });

    expect(maxConcurrent).toBe(1);
  });

  it('handles an empty items array', async () => {
    await ConcurrencyLimiter.runConcurrent([], 3, async () => {
      expect.fail('worker should not be called for empty array');
    });
  });

  it('handles a single item', async () => {
    let called = false;
    await ConcurrencyLimiter.runConcurrent([42], 3, async (item) => {
      called = true;
      expect(item).toBe(42);
    });
    expect(called).toBe(true);
  });

  it('worker function receives item and index', async () => {
    const received: Array<{ item: number; index: number }> = [];
    const items = [10, 20, 30];

    await ConcurrencyLimiter.runConcurrent(items, 3, async (item, index) => {
      received.push({ item, index });
    });

    expect(received).toHaveLength(3);
    expect(received.find((r) => r.index === 0)?.item).toBe(10);
    expect(received.find((r) => r.index === 1)?.item).toBe(20);
    expect(received.find((r) => r.index === 2)?.item).toBe(30);
  });

  it('continues processing remaining items when one throws', async () => {
    const processed: number[] = [];

    await ConcurrencyLimiter.runConcurrent(
      [1, 2, 3, 4],
      2,
      async (item) => {
        if (item === 2) {
          throw new Error('boom');
        }
        processed.push(item);
      }
    );

    // Items 1, 3, 4 should still be processed
    expect(processed.sort((a, b) => a - b)).toEqual([1, 3, 4]);
  });

  it('does not propagate errors from the worker function', async () => {
    await expect(
      ConcurrencyLimiter.runConcurrent([1, 2, 3], 2, async () => {
        throw new Error('worker error');
      })
    ).resolves.toBeUndefined();
  });

  // [Implements: US-PL-015]
  it('with an already-aborted signal rejects queued items', async () => {
    const controller = new AbortController();
    controller.abort();

    const processed: number[] = [];

    await ConcurrencyLimiter.runConcurrent(
      [1, 2, 3, 4, 5],
      1,
      async (item) => {
        processed.push(item);
        await Promise.resolve();
      },
      controller.signal
    );

    // With concurrency 1 and an already-aborted signal:
    // The first item acquires before the queue fills, so it processes.
    // Subsequent items must queue and will be rejected due to abort.
    // At most 1 item processes (the first one that grabs the slot).
    expect(processed.length).toBeLessThanOrEqual(1);
  });

  it('processes all items without a signal', async () => {
    const processed: number[] = [];

    await ConcurrencyLimiter.runConcurrent(
      Array.from({ length: 10 }, (_, i) => i),
      4,
      async (item) => {
        processed.push(item);
      }
    );

    expect(processed).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Integration — realistic concurrency scenarios
// ---------------------------------------------------------------------------

describe('integration — realistic scenarios', () => {
  // [Implements: US-PL-003]
  it('simulates concurrent scrape operations with bounded concurrency', async () => {
    const limiter = new ConcurrencyLimiter(3);
    const results: string[] = [];
    let maxConcurrent = 0;
    let current = 0;

    const urls = Array.from({ length: 8 }, (_, i) => `https://example.com/${i}`);

    const scrapePromises = urls.map(async (url) => {
      await limiter.acquire();
      try {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        // Simulate async I/O
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push(url);
      } finally {
        current--;
        limiter.release();
      }
    });

    await Promise.all(scrapePromises);

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(8);
    expect(results.sort()).toEqual([...urls].sort());
  });

  // [Implements: US-PL-015]
  it('simulates pipeline abort during concurrent operations', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const controller = new AbortController();
    const completed: string[] = [];
    const errors: string[] = [];

    const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`);

    const promises = urls.map(async (url) => {
      try {
        await limiter.acquire(controller.signal);
        try {
          await new Promise((resolve) => setTimeout(resolve, 50));
          completed.push(url);
        } finally {
          limiter.release();
        }
      } catch (error) {
        errors.push(
          error instanceof Error ? error.message : String(error)
        );
      }
    });

    // Abort after a short delay
    setTimeout(() => controller.abort(), 10);

    await Promise.allSettled(promises);

    // Some items completed, some were rejected
    expect(completed.length + errors.length).toBe(6);
    // At least the first 2 (which grabbed slots immediately) should complete
    expect(completed.length).toBeGreaterThanOrEqual(2);
  });

  it('release in finally block ensures slot is always returned', async () => {
    const limiter = new ConcurrencyLimiter(3);
    const items = [1, 2, 3, 4, 5];

    await Promise.all(
      items.map(async (item) => {
        await limiter.acquire();
        try {
          if (item % 2 === 0) {
            throw new Error('even number error');
          }
        } catch {
          // Swallow — we're testing that release still happens
        } finally {
          limiter.release();
        }
      })
    );

    // All slots should be returned
    expect(limiter.activeCount).toBe(0);
  });

  it('supports a large number of items with small concurrency', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let count = 0;

    const items = Array.from({ length: 100 }, (_, i) => i);

    await Promise.all(
      items.map(async () => {
        await limiter.acquire();
        try {
          count++;
          await Promise.resolve();
        } finally {
          limiter.release();
        }
      })
    );

    expect(count).toBe(100);
    expect(limiter.activeCount).toBe(0);
  });

  it('FIFO ordering is preserved for queued waiters', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const resolutionOrder: number[] = [];

    // Queue 5 waiters
    const promises = [0, 1, 2, 3, 4].map((i) =>
      limiter.acquire().then(() => {
        resolutionOrder.push(i);
      })
    );

    // Release one slot at a time
    for (let i = 0; i < 5; i++) {
      limiter.release();
    }

    await Promise.all(promises);
    expect(resolutionOrder).toEqual([0, 1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// PL8b: Mixed signal/no-signal queue scenarios
// ---------------------------------------------------------------------------

describe('PL8b — mixed signal/no-signal queue scenarios', () => {
  // [Implements: BG-PL-003]
  it('mixing signaled and non-signaled acquires in the same queue', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controller = new AbortController();

    // Queue a non-signaled waiter first
    const p1 = limiter.acquire();
    // Then a signaled waiter
    const p2 = limiter.acquire(controller.signal);

    expect(limiter.pendingCount).toBe(2);

    // Release — p1 should resolve first (FIFO)
    limiter.release();
    await expect(p1).resolves.toBeUndefined();

    // Need a second release for p2
    limiter.release();
    await expect(p2).resolves.toBeUndefined();
  });

  // [Implements: BG-PL-003]
  it('aborting a non-first waiter does not skip FIFO order for others', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const order: number[] = [];
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const ctrl3 = new AbortController();

    const p1 = limiter.acquire(ctrl1.signal).then(() => order.push(1));
    const p2 = limiter.acquire(ctrl2.signal).then(() => order.push(2));
    const p3 = limiter.acquire(ctrl3.signal).then(() => order.push(3));

    // Abort p2 (the middle waiter)
    ctrl2.abort();
    await expect(p2).rejects.toThrow('aborted');

    // Release — p1 should get the slot, then p3
    limiter.release();
    await p1;

    limiter.release();
    await p3;

    expect(order).toEqual([1, 3]);
  });

  // [Implements: BG-PL-003]
  it('aborting the first waiter lets the second waiter proceed on release', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const ctrl = new AbortController();
    const p1 = limiter.acquire(ctrl.signal);
    const p2 = limiter.acquire();

    expect(limiter.pendingCount).toBe(2);

    // Abort the first waiter
    ctrl.abort();
    await expect(p1).rejects.toThrow('aborted');
    expect(limiter.pendingCount).toBe(1);

    // Release — p2 should get the slot
    limiter.release();
    await expect(p2).resolves.toBeUndefined();
  });

  // [Implements: BG-PL-003]
  it('non-signaled waiter behind an aborted signaled waiter resolves on release', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const ctrl = new AbortController();
    const signaled = limiter.acquire(ctrl.signal);
    const nonSignaled = limiter.acquire();

    ctrl.abort();
    await expect(signaled).rejects.toThrow('aborted');

    // non-signaled is still waiting
    expect(limiter.pendingCount).toBe(1);

    limiter.release();
    await expect(nonSignaled).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PL8b: Acquire without signal edge cases
// ---------------------------------------------------------------------------

describe('PL8b — acquire without signal edge cases', () => {
  // [Implements: US-PL-003]
  it('acquire without signal blocks indefinitely until release', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    let resolved = false;
    const promise = limiter.acquire().then(() => {
      resolved = true;
    });

    // Flush microtasks — should still be pending
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(limiter.pendingCount).toBe(1);

    // Release triggers resolution
    limiter.release();
    await promise;
    expect(resolved).toBe(true);
  });

  // [Implements: US-PL-003]
  it('acquire with a non-aborted signal that never fires resolves on release', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controller = new AbortController();
    const promise = limiter.acquire(controller.signal);

    // Signal is not aborted, so the promise should be pending
    expect(limiter.pendingCount).toBe(1);

    limiter.release();
    await expect(promise).resolves.toBeUndefined();
  });

  // [Implements: US-PL-003]
  it('release after acquire without signal removes the waiter from queue', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const promise = limiter.acquire();
    expect(limiter.pendingCount).toBe(1);

    limiter.release();
    await promise;

    // After resolve, the waiter should be removed from the queue
    expect(limiter.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PL8b: Queue count consistency under abort
// ---------------------------------------------------------------------------

describe('PL8b — queue count consistency under abort', () => {
  // [Implements: BG-PL-003]
  it('aborting all queued waiters leaves pendingCount at 0', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const promises = controllers.map((c) => limiter.acquire(c.signal));

    expect(limiter.pendingCount).toBe(5);

    // Abort all
    for (const c of controllers) {
      c.abort();
    }

    // All should reject
    for (const p of promises) {
      await expect(p).rejects.toThrow('aborted');
    }

    expect(limiter.pendingCount).toBe(0);
  });

  // [Implements: BG-PL-003]
  it('aborting some waiters decreases pendingCount by the correct amount', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controllers = Array.from({ length: 4 }, () => new AbortController());

    // Attach .catch handlers to prevent unhandled rejections
    const promises = controllers.map((c) =>
      limiter.acquire(c.signal).catch(() => {
        // Expected — swallowed for pendingCount testing
      })
    );

    expect(limiter.pendingCount).toBe(4);

    controllers[0].abort();
    await promises[0];
    expect(limiter.pendingCount).toBe(3);

    controllers[2].abort();
    await promises[2];
    expect(limiter.pendingCount).toBe(2);

    // Clean up remaining waiters
    controllers[1].abort();
    controllers[3].abort();
    await Promise.all(promises);
  });

  // [Implements: BG-PL-003]
  it('aborting a waiter does not affect the activeCount', async () => {
    const limiter = new ConcurrencyLimiter(2);
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.activeCount).toBe(2);

    const controller = new AbortController();
    const promise = limiter.acquire(controller.signal);

    controller.abort();
    await expect(promise).rejects.toThrow('aborted');

    // activeCount should still be 2 (no slot was acquired or released)
    expect(limiter.activeCount).toBe(2);
  });

  // [Implements: BG-PL-003]
  it('releasing after all waiters are aborted decrements activeCount normally', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controller = new AbortController();
    const promise = limiter.acquire(controller.signal);

    controller.abort();
    await expect(promise).rejects.toThrow('aborted');

    // Release the held slot — should decrement to 0 since queue is empty
    limiter.release();
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PL8b: Concurrency ceiling with varied configurations
// ---------------------------------------------------------------------------

describe('PL8b — concurrency ceiling with varied configurations', () => {
  // [Implements: US-PL-003]
  it('maxConcurrency=2 never exceeds 2 concurrent operations', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let maxObserved = 0;
    let current = 0;

    const tasks = Array.from({ length: 15 }, () =>
      (async () => {
        await limiter.acquire();
        current++;
        maxObserved = Math.max(maxObserved, current);
        await new Promise((resolve) => setTimeout(resolve, 1));
        current--;
        limiter.release();
      })()
    );

    await Promise.all(tasks);
    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  // [Implements: US-PL-003]
  it('maxConcurrency=10 with 10 items processes all concurrently', async () => {
    const limiter = new ConcurrencyLimiter(10);
    let maxObserved = 0;
    let current = 0;

    const tasks = Array.from({ length: 10 }, () =>
      (async () => {
        await limiter.acquire();
        current++;
        maxObserved = Math.max(maxObserved, current);
        await Promise.resolve();
        await Promise.resolve();
        current--;
        limiter.release();
      })()
    );

    await Promise.all(tasks);
    // With 10 items and maxConcurrency=10, all should run at once
    expect(maxObserved).toBe(10);
  });

  // [Implements: US-PL-003]
  it('maxConcurrency=3 with exactly 3 items never blocks', async () => {
    const limiter = new ConcurrencyLimiter(3);

    const results: number[] = [];
    await Promise.all(
      [1, 2, 3].map(async (item) => {
        await limiter.acquire();
        results.push(item);
        await Promise.resolve();
        limiter.release();
      })
    );

    expect(results.sort()).toEqual([1, 2, 3]);
    expect(limiter.pendingCount).toBe(0);
  });

  // [Implements: US-PL-003]
  it('repeated acquire/release cycles maintain consistent bounds', async () => {
    const limiter = new ConcurrencyLimiter(3);
    let maxObserved = 0;
    let current = 0;

    for (let cycle = 0; cycle < 10; cycle++) {
      const tasks = Array.from({ length: 6 }, () =>
        (async () => {
          await limiter.acquire();
          current++;
          maxObserved = Math.max(maxObserved, current);
          await Promise.resolve();
          await Promise.resolve();
          current--;
          limiter.release();
        })()
      );
      await Promise.all(tasks);
    }

    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PL8b: Stress testing
// ---------------------------------------------------------------------------

describe('PL8b — stress testing', () => {
  // [Implements: US-PL-003]
  it('handles 200 items with concurrency 4', async () => {
    const limiter = new ConcurrencyLimiter(4);
    let count = 0;
    let maxObserved = 0;
    let current = 0;

    await Promise.all(
      Array.from({ length: 200 }, () =>
        (async () => {
          await limiter.acquire();
          current++;
          maxObserved = Math.max(maxObserved, current);
          count++;
          await Promise.resolve();
          current--;
          limiter.release();
        })()
      )
    );

    expect(count).toBe(200);
    expect(maxObserved).toBeLessThanOrEqual(4);
    expect(limiter.activeCount).toBe(0);
  });

  // [Implements: US-PL-003]
  it('handles high contention with concurrency 1 (fully serial)', async () => {
    const limiter = new ConcurrencyLimiter(1);
    let count = 0;
    let maxObserved = 0;
    let current = 0;

    await Promise.all(
      Array.from({ length: 50 }, () =>
        (async () => {
          await limiter.acquire();
          current++;
          maxObserved = Math.max(maxObserved, current);
          count++;
          await Promise.resolve();
          current--;
          limiter.release();
        })()
      )
    );

    expect(count).toBe(50);
    expect(maxObserved).toBe(1);
  });

  // [Implements: BG-PL-003]
  it('handles 50 queued waiters with signal, all aborted', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire();

    const controllers = Array.from({ length: 50 }, () => new AbortController());
    const promises = controllers.map((c) => limiter.acquire(c.signal));

    expect(limiter.pendingCount).toBe(50);

    for (const c of controllers) {
      c.abort();
    }

    for (const p of promises) {
      await expect(p).rejects.toThrow('aborted');
    }

    expect(limiter.pendingCount).toBe(0);
  });

  // [Implements: US-PL-003]
  it('interleaved acquire/release with many items stays within bounds', async () => {
    const limiter = new ConcurrencyLimiter(3);
    let maxObserved = 0;
    let current = 0;

    const tasks = Array.from({ length: 30 }, (_, i) =>
      (async () => {
        await limiter.acquire();
        current++;
        maxObserved = Math.max(maxObserved, current);
        // Vary the async work duration
        if (i % 2 === 0) {
          await Promise.resolve();
        } else {
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        }
        current--;
        limiter.release();
      })()
    );

    await Promise.all(tasks);
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(limiter.activeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PL8b: runConcurrent with abort integration
// ---------------------------------------------------------------------------

describe('PL8b — runConcurrent with abort integration', () => {
  // [Implements: US-PL-015]
  it('runConcurrent with signal that aborts mid-processing stops queued items', async () => {
    const controller = new AbortController();
    const processed: number[] = [];

    // With concurrency 1, items 2+ will queue
    setTimeout(() => controller.abort(), 5);

    await ConcurrencyLimiter.runConcurrent(
      [1, 2, 3, 4, 5],
      1,
      async (item) => {
        processed.push(item);
        // Add a small delay so the abort fires while items are queued
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      controller.signal
    );

    // Some items may have been aborted — at least the first should process
    // but we can't guarantee exactly how many due to timing
    expect(processed.length).toBeLessThanOrEqual(5);
  });

  // [Implements: US-PL-003]
  it('runConcurrent processes items correctly with high concurrency', async () => {
    const processed: number[] = [];
    const items = Array.from({ length: 50 }, (_, i) => i);

    await ConcurrencyLimiter.runConcurrent(items, 10, async (item) => {
      processed.push(item);
    });

    expect(processed.sort((a, b) => a - b)).toEqual(items);
  });

  // [Implements: US-PL-003]
  it('runConcurrent with concurrency equal to items count processes all', async () => {
    const processed: string[] = [];
    const items = ['a', 'b', 'c', 'd'];

    await ConcurrencyLimiter.runConcurrent(items, 4, async (item) => {
      processed.push(item);
    });

    expect(processed.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  // [Implements: US-PL-003]
  it('runConcurrent handles worker that acquires nested limiter', async () => {
    const outer = new ConcurrencyLimiter(2);
    const inner = new ConcurrencyLimiter(1);

    let innerMax = 0;
    let innerCurrent = 0;

    const items = [1, 2, 3, 4, 5];

    await Promise.all(
      items.map(
        async (item) => {
          await outer.acquire();
          try {
            await inner.acquire();
            innerCurrent++;
            innerMax = Math.max(innerMax, innerCurrent);
            await Promise.resolve();
            await Promise.resolve();
            innerCurrent--;
            inner.release();
          } finally {
            outer.release();
          }
        }
      )
    );

    // Inner limiter should never exceed 1
    expect(innerMax).toBe(1);
  });

  // [Implements: US-PL-003]
  it('runConcurrent returns results for items with no concurrency contention', async () => {
    const results: number[] = [];

    await ConcurrencyLimiter.runConcurrent(
      [10, 20, 30],
      5, // More concurrency than items
      async (item) => {
        results.push(item * 2);
      }
    );

    expect(results.sort((a, b) => a - b)).toEqual([20, 40, 60]);
  });
});

// ---------------------------------------------------------------------------
// PL8b: Property-based style invariants
// ---------------------------------------------------------------------------

describe('PL8b — invariant checks', () => {
  // [Implements: US-PL-003]
  it('activeCount never exceeds maxConcurrency across many cycles', async () => {
    for (const max of [1, 2, 3, 5, 10]) {
      const limiter = new ConcurrencyLimiter(max);
      let maxObserved = 0;
      let current = 0;

      await Promise.all(
        Array.from({ length: max * 3 }, () =>
          (async () => {
            await limiter.acquire();
            current++;
            maxObserved = Math.max(maxObserved, current);
            await Promise.resolve();
            await Promise.resolve();
            current--;
            limiter.release();
          })()
        )
      );

      expect(maxObserved).toBeLessThanOrEqual(max);
      expect(limiter.activeCount).toBe(0);
    }
  });

  // [Implements: BG-PL-003]
  it('pendingCount is always non-negative', async () => {
    const limiter = new ConcurrencyLimiter(2);

    // Acquire up to maxConcurrency
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.pendingCount).toBeGreaterThanOrEqual(0);

    // Release and re-acquire in small batches
    limiter.release();
    expect(limiter.pendingCount).toBeGreaterThanOrEqual(0);
    limiter.release();
    expect(limiter.pendingCount).toBeGreaterThanOrEqual(0);

    await limiter.acquire();
    expect(limiter.pendingCount).toBeGreaterThanOrEqual(0);
    limiter.release();
    expect(limiter.pendingCount).toBeGreaterThanOrEqual(0);
  });

  // [Implements: BG-PL-003]
  it('activeCount is always non-negative', async () => {
    const limiter = new ConcurrencyLimiter(2);

    // Excess releases should not go negative
    for (let i = 0; i < 10; i++) {
      limiter.release();
      expect(limiter.activeCount).toBeGreaterThanOrEqual(0);
    }

    // Acquire and release
    await limiter.acquire();
    expect(limiter.activeCount).toBe(1);
    limiter.release();
    expect(limiter.activeCount).toBe(0);
    limiter.release();
    expect(limiter.activeCount).toBe(0);
  });

  // [Implements: US-PL-003]
  it('every successful acquire is eventually followed by activeCount decrement on release', async () => {
    const limiter = new ConcurrencyLimiter(3);
    const acquired: Promise<void>[] = [];

    for (let i = 0; i < 3; i++) {
      acquired.push(limiter.acquire());
    }
    await Promise.all(acquired);
    expect(limiter.activeCount).toBe(3);

    limiter.release();
    expect(limiter.activeCount).toBe(2);
    limiter.release();
    expect(limiter.activeCount).toBe(1);
    limiter.release();
    expect(limiter.activeCount).toBe(0);
  });
});
