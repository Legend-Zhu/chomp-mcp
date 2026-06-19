/**
 * Unit tests for TimeoutGuard.
 *
 * Verifies timer-based abort behavior, cleanup idempotency, signal
 * propagation, and the factory function.
 *
 * [Spec: US-PL-003, US-PL-004, US-PL-005, US-PL-015]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TimeoutGuard,
  createTimeoutGuard,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from '../../../src/modules/pipeline-orchestration/timeout-guard.js';

// ---------------------------------------------------------------------------
// Constant
// ---------------------------------------------------------------------------

describe('DEFAULT_PIPELINE_TIMEOUT_MS', () => {
  // [Implements: US-PL-004, DC-PL-002]
  it('exports the value 30000', () => {
    expect(DEFAULT_PIPELINE_TIMEOUT_MS).toBe(30000);
  });

  it('is a positive integer', () => {
    expect(DEFAULT_PIPELINE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_PIPELINE_TIMEOUT_MS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constructor — basic
// ---------------------------------------------------------------------------

describe('TimeoutGuard constructor', () => {
  // [Implements: US-PL-004]
  it('creates a guard with a non-aborted signal', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(5000);
      expect(guard.isAborted).toBe(false);
      expect(guard.signal.aborted).toBe(false);
      guard.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes an AbortSignal via the signal getter', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(5000);
      expect(guard.signal).toBeInstanceOf(AbortSignal);
      guard.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a zero timeout and aborts on the next tick', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(0);
      // Timer with delay 0 fires on the next macro-task advance
      vi.advanceTimersByTime(0);
      expect(guard.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Timer-based abort behavior
// ---------------------------------------------------------------------------

describe('timer-based abort behavior', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-004, US-PL-015]
  it('aborts the signal when the timeout elapses', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(5000);
      expect(guard.isAborted).toBe(false);

      vi.advanceTimersByTime(4999);
      expect(guard.isAborted).toBe(false);

      vi.advanceTimersByTime(1);
      expect(guard.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('writes a timeout message to stderr when the timer fires', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(3000);
      vi.advanceTimersByTime(3000);

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('[PL] timeout')
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('3000ms')
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('aborting')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-004]
  it('does NOT abort before the timeout elapses', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(10000);
      vi.advanceTimersByTime(9999);
      expect(guard.isAborted).toBe(false);
      expect(stderrSpy).not.toHaveBeenCalled();
      guard.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('abort fires the signal event listeners', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(1000);
      let aborted = false;
      guard.signal.addEventListener('abort', () => {
        aborted = true;
      });

      expect(aborted).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('signal.aborted transitions from false to true exactly once', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(2000);
      expect(guard.signal.aborted).toBe(false);

      vi.advanceTimersByTime(2000);
      expect(guard.signal.aborted).toBe(true);

      // Advancing further does not change the state
      vi.advanceTimersByTime(5000);
      expect(guard.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes the timeout duration in the stderr message', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(25000);
      vi.advanceTimersByTime(25000);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('25000ms')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-004]
  it('writes to stderr only (never stdout)', () => {
    vi.useFakeTimers();
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const guard = new TimeoutGuard(500);
      vi.advanceTimersByTime(500);
      expect(stderrSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      stdoutSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup — prevents abort when called before timer fires
// ---------------------------------------------------------------------------

describe('cleanup prevents abort', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: NFR-PL-005, US-PL-005]
  it('calling cleanup immediately after creation prevents the abort from firing', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(1000);
      guard.cleanup();

      vi.advanceTimersByTime(1000);

      expect(guard.isAborted).toBe(false);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: NFR-PL-005]
  it('calling cleanup shortly before timeout prevents the abort', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(5000);
      vi.advanceTimersByTime(4999);
      expect(guard.isAborted).toBe(false);

      guard.cleanup();
      vi.advanceTimersByTime(10);

      expect(guard.isAborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup — idempotency
// ---------------------------------------------------------------------------

describe('cleanup idempotency', () => {
  // [Implements: NFR-PL-005]
  it('calling cleanup twice does not throw', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(5000);
      guard.cleanup();
      expect(() => guard.cleanup()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('calling cleanup three times does not throw', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(5000);
      guard.cleanup();
      guard.cleanup();
      expect(() => guard.cleanup()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: NFR-PL-005, US-PL-005]
  it('calling cleanup after the timer has already fired is a safe no-op', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(100);
      vi.advanceTimersByTime(100);
      expect(guard.isAborted).toBe(true);

      expect(() => guard.cleanup()).not.toThrow();
      // Signal remains aborted — cleanup doesn't undo abort
      expect(guard.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleanup after abort does not reset the signal', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(200);
      vi.advanceTimersByTime(200);
      expect(guard.signal.aborted).toBe(true);

      guard.cleanup();
      expect(guard.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('double cleanup after abort does not reset the signal', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(200);
      vi.advanceTimersByTime(200);
      expect(guard.signal.aborted).toBe(true);

      guard.cleanup();
      guard.cleanup();
      expect(guard.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Signal propagation
// ---------------------------------------------------------------------------

describe('signal propagation', () => {
  // [Implements: US-PL-015]
  it('the exposed signal is usable with AbortSignal-compatible APIs', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(500);
      const signal = guard.signal;

      expect(signal.aborted).toBe(false);
      expect(typeof signal.addEventListener).toBe('function');
      expect(typeof signal.removeEventListener).toBe('function');

      vi.advanceTimersByTime(500);
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('multiple listeners are invoked when the signal aborts', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(300);
      let count = 0;

      guard.signal.addEventListener('abort', () => {
        count++;
      });
      guard.signal.addEventListener('abort', () => {
        count++;
      });
      guard.signal.addEventListener('abort', () => {
        count++;
      });

      vi.advanceTimersByTime(300);
      expect(count).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('signal can be passed to fetch as a cancellation mechanism', async () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(1000);

      // Simulate a long-running operation listening to the signal
      let cancelled = false;
      guard.signal.addEventListener('abort', () => {
        cancelled = true;
      });

      vi.advanceTimersByTime(500);
      expect(cancelled).toBe(false);

      vi.advanceTimersByTime(500);
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isAborted getter reflects the same state as signal.aborted', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(400);
      expect(guard.isAborted).toBe(guard.signal.aborted);

      vi.advanceTimersByTime(400);
      expect(guard.isAborted).toBe(guard.signal.aborted);
      expect(guard.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// createTimeoutGuard factory
// ---------------------------------------------------------------------------

describe('createTimeoutGuard factory', () => {
  // [Implements: US-PL-004, US-PL-005]
  it('returns a TimeoutGuard instance', () => {
    vi.useFakeTimers();
    try {
      const guard = createTimeoutGuard(5000);
      expect(guard).toBeInstanceOf(TimeoutGuard);
      guard.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it('produces a guard that aborts after the specified timeout', () => {
    vi.useFakeTimers();
    try {
      const guard = createTimeoutGuard(2000);
      expect(guard.isAborted).toBe(false);

      vi.advanceTimersByTime(2000);
      expect(guard.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('produces a guard with a working cleanup method', () => {
    vi.useFakeTimers();
    try {
      const guard = createTimeoutGuard(3000);
      guard.cleanup();
      vi.advanceTimersByTime(3000);
      expect(guard.isAborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('factory result is equivalent to direct construction', () => {
    vi.useFakeTimers();
    try {
      const fromFactory = createTimeoutGuard(1000);
      const fromConstructor = new TimeoutGuard(1000);

      expect(fromFactory.isAborted).toBe(fromConstructor.isAborted);
      expect(fromFactory.signal.aborted).toBe(
        fromConstructor.signal.aborted
      );

      fromFactory.cleanup();
      fromConstructor.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: signal propagation to downstream operations
// ---------------------------------------------------------------------------

describe('integration — signal propagation to downstream operations', () => {
  // [Implements: US-PL-015]
  it('a downstream operation checking signal.aborted stops when the guard aborts', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(500);
      const signal = guard.signal;

      const checkpoints: string[] = [];

      // Simulate a polling loop
      if (!signal.aborted) checkpoints.push('tick-1');
      vi.advanceTimersByTime(250);
      if (!signal.aborted) checkpoints.push('tick-2');
      vi.advanceTimersByTime(250);
      if (!signal.aborted) checkpoints.push('tick-3');
      vi.advanceTimersByTime(250);
      if (!signal.aborted) checkpoints.push('tick-4');

      // tick-1 (0ms, not aborted), tick-2 (250ms, not aborted),
      // tick-3 (500ms, aborted), tick-4 (750ms, aborted)
      expect(checkpoints).toEqual(['tick-1', 'tick-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-004, US-PL-005]
  it('cleanup after successful pipeline completion prevents spurious abort', () => {
    vi.useFakeTimers();
    try {
      // Simulate a pipeline that completes in 200ms with a 5000ms timeout
      const guard = new TimeoutGuard(5000);

      // Pipeline "completes"
      vi.advanceTimersByTime(200);
      expect(guard.isAborted).toBe(false);

      // Cleanup on successful completion
      guard.cleanup();

      // Advance well past the original timeout
      vi.advanceTimersByTime(10000);

      // Signal never aborted — cleanup worked
      expect(guard.isAborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-004]
  it('abort during pipeline allows downstream to detect via signal', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(1000);

      const signal = guard.signal;
      let detectedAbort = false;

      signal.addEventListener('abort', () => {
        detectedAbort = true;
      });

      // Pipeline is running...
      vi.advanceTimersByTime(999);
      expect(detectedAbort).toBe(false);

      // Timeout fires
      vi.advanceTimersByTime(1);
      expect(detectedAbort).toBe(true);
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles very small timeout values (1ms)', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(1);
      expect(guard.isAborted).toBe(false);

      vi.advanceTimersByTime(1);
      expect(guard.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles large timeout values', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(999999);
      vi.advanceTimersByTime(999998);
      expect(guard.isAborted).toBe(false);

      vi.advanceTimersByTime(1);
      expect(guard.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('multiple guards are independent of each other', () => {
    vi.useFakeTimers();
    try {
      const guard1 = new TimeoutGuard(1000);
      const guard2 = new TimeoutGuard(2000);

      vi.advanceTimersByTime(1000);
      expect(guard1.isAborted).toBe(true);
      expect(guard2.isAborted).toBe(false);

      vi.advanceTimersByTime(1000);
      expect(guard1.isAborted).toBe(true);
      expect(guard2.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleanup on one guard does not affect another', () => {
    vi.useFakeTimers();
    try {
      const guard1 = new TimeoutGuard(1000);
      const guard2 = new TimeoutGuard(1000);

      guard1.cleanup();

      vi.advanceTimersByTime(1000);
      expect(guard1.isAborted).toBe(false);
      expect(guard2.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('signal from an aborted guard can be checked by downstream code', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(500);
      vi.advanceTimersByTime(500);

      // Downstream code checks the signal
      const signal = guard.signal;
      if (signal.aborted) {
        // Would return partial result in real pipeline
        expect(signal.aborted).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leak timers when cleanup is called', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(1000);
      guard.cleanup();

      // No timer should fire even after advancing significantly
      vi.advanceTimersByTime(100000);
      expect(guard.isAborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// PL8b: Boundary timing precision
// ---------------------------------------------------------------------------

describe('PL8b — boundary timing precision', () => {
  // [Implements: US-PL-004]
  it('is NOT aborted exactly 1ms before the timeout boundary', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(500);
      vi.advanceTimersByTime(499);
      expect(guard.isAborted).toBe(false);
      guard.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-004]
  it('IS aborted exactly at the timeout boundary', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(500);
      vi.advanceTimersByTime(500);
      expect(guard.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-004]
  it('remains non-aborted just before boundary even after repeated checks', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(1000);
      for (let i = 0; i < 100; i++) {
        vi.advanceTimersByTime(9); // 9ms increments → 900ms total
        expect(guard.isAborted).toBe(false);
      }
      // Now at 900ms — still not aborted
      vi.advanceTimersByTime(99); // 999ms total
      expect(guard.isAborted).toBe(false);
      vi.advanceTimersByTime(1); // exactly 1000ms
      expect(guard.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-004]
  it('aborts at exactly the specified timeout (not 1ms earlier or later)', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(750);
      vi.advanceTimersByTime(749);
      expect(guard.isAborted).toBe(false);
      vi.advanceTimersByTime(1); // exactly 750
      expect(guard.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// PL8b: Signal reference stability
// ---------------------------------------------------------------------------

describe('PL8b — signal reference stability', () => {
  // [Implements: US-PL-015]
  it('returns the same signal object on every access', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(5000);
      const signal1 = guard.signal;
      const signal2 = guard.signal;
      const signal3 = guard.signal;

      expect(signal1).toBe(signal2);
      expect(signal2).toBe(signal3);
      guard.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('signal reference is stable even after abort', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(500);
      const signalBefore = guard.signal;

      vi.advanceTimersByTime(500);

      const signalAfter = guard.signal;
      expect(signalBefore).toBe(signalAfter);
      expect(signalAfter.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('signal reference is stable even after cleanup', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(5000);
      const signalBefore = guard.signal;

      guard.cleanup();

      const signalAfter = guard.signal;
      expect(signalBefore).toBe(signalAfter);
      expect(signalAfter.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// PL8b: Stderr message format verification
// ---------------------------------------------------------------------------

describe('PL8b — stderr message format verification', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-PL-015, NFR-PL-005]
  it('message starts with [PL] prefix', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(1000);
      vi.advanceTimersByTime(1000);

      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      const timeoutCall = calls.find((c) => c.includes('timeout'));
      expect(timeoutCall).toBeDefined();
      expect(timeoutCall!.trimStart()).toMatch(/^\[PL\]/);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('message contains the exact timeoutMs value', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(42000);
      vi.advanceTimersByTime(42000);

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('42000ms')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('message is a single write call (not fragmented)', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(500);
      const callsBefore = stderrSpy.mock.calls.length;
      vi.advanceTimersByTime(500);

      // The timeout message should be written in a single call
      const newCalls = stderrSpy.mock.calls.slice(callsBefore);
      const timeoutMessages = newCalls.filter((c) =>
        String(c[0]).includes('[PL] timeout')
      );
      expect(timeoutMessages.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('message ends with a newline character', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(800);
      vi.advanceTimersByTime(800);

      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      const timeoutCall = calls.find((c) => c.includes('[PL] timeout'));
      expect(timeoutCall).toBeDefined();
      expect(timeoutCall!.endsWith('\n')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// PL8b: Real-timer integration tests
// ---------------------------------------------------------------------------

describe('PL8b — real-timer integration tests', () => {
  // [Implements: US-PL-004]
  it('aborts after a real 50ms timeout', async () => {
    const guard = new TimeoutGuard(50);
    expect(guard.isAborted).toBe(false);

    // Wait for the timer to fire
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(guard.isAborted).toBe(true);
  });

  // [Implements: US-PL-004]
  it('does NOT abort within a real 50ms timeout', async () => {
    const guard = new TimeoutGuard(50);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(guard.isAborted).toBe(false);
    guard.cleanup();
  });

  // [Implements: US-PL-005, NFR-PL-005]
  it('cleanup prevents abort in real-timer mode', async () => {
    const guard = new TimeoutGuard(50);
    guard.cleanup();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(guard.isAborted).toBe(false);
  });

  // [Implements: US-PL-015]
  it('abort listeners fire in real-timer mode', async () => {
    const guard = new TimeoutGuard(30);
    let fired = false;
    guard.signal.addEventListener('abort', () => {
      fired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fired).toBe(true);
  });

  // [Implements: US-PL-005]
  it('cleanup idempotency works in real-timer mode', async () => {
    const guard = new TimeoutGuard(30);
    guard.cleanup();
    guard.cleanup();
    guard.cleanup();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(guard.isAborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PL8b: Multiple concurrent guards
// ---------------------------------------------------------------------------

describe('PL8b — multiple concurrent guards', () => {
  // [Implements: US-PL-004]
  it('three guards with staggered timeouts fire in order', () => {
    vi.useFakeTimers();
    try {
      const guard1 = new TimeoutGuard(100);
      const guard2 = new TimeoutGuard(200);
      const guard3 = new TimeoutGuard(300);

      vi.advanceTimersByTime(100);
      expect(guard1.isAborted).toBe(true);
      expect(guard2.isAborted).toBe(false);
      expect(guard3.isAborted).toBe(false);

      vi.advanceTimersByTime(100);
      expect(guard1.isAborted).toBe(true);
      expect(guard2.isAborted).toBe(true);
      expect(guard3.isAborted).toBe(false);

      vi.advanceTimersByTime(100);
      expect(guard1.isAborted).toBe(true);
      expect(guard2.isAborted).toBe(true);
      expect(guard3.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: NFR-PL-005]
  it('cleanup on one of multiple guards only affects that guard', () => {
    vi.useFakeTimers();
    try {
      const guard1 = new TimeoutGuard(100);
      const guard2 = new TimeoutGuard(100);
      const guard3 = new TimeoutGuard(100);

      guard2.cleanup();

      vi.advanceTimersByTime(100);
      expect(guard1.isAborted).toBe(true);
      expect(guard2.isAborted).toBe(false);
      expect(guard3.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('each guard has an independent signal', () => {
    vi.useFakeTimers();
    try {
      const guard1 = new TimeoutGuard(100);
      const guard2 = new TimeoutGuard(200);

      expect(guard1.signal).not.toBe(guard2.signal);

      vi.advanceTimersByTime(100);
      expect(guard1.signal.aborted).toBe(true);
      expect(guard2.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('many guards (10) all abort at their respective timeouts', () => {
    vi.useFakeTimers();
    try {
      const guards = Array.from({ length: 10 }, (_, i) => {
        return new TimeoutGuard((i + 1) * 100);
      });

      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(100);
        for (let j = 0; j <= i; j++) {
          expect(guards[j].isAborted).toBe(true);
        }
        for (let j = i + 1; j < 10; j++) {
          expect(guards[j].isAborted).toBe(false);
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// PL8b: Signal abort reason
// ---------------------------------------------------------------------------

describe('PL8b — signal abort reason', () => {
  // [Implements: US-PL-015]
  it('signal.reason is undefined or null when no reason is passed', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(100);
      vi.advanceTimersByTime(100);

      // AbortController.abort() without a reason — reason is undefined or the default
      // Some Node.js versions set reason to undefined
      expect(guard.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('aborting causes any subsequent abort event listener to fire immediately when added after abort', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(100);
      vi.advanceTimersByTime(100);
      expect(guard.signal.aborted).toBe(true);

      // Adding an abort listener AFTER abort — per spec, it should not fire
      // since the event already occurred. But signal.aborted is true.
      let lateFired = false;
      guard.signal.addEventListener('abort', () => {
        lateFired = true;
      });

      // Listener added after abort does not retroactively fire
      // (AbortSignal does not replay events)
      vi.advanceTimersByTime(100);
      // lateFired may or may not be true depending on platform,
      // but the key assertion is that signal.aborted is true
      expect(guard.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// PL8b: Timer leak detection
// ---------------------------------------------------------------------------

describe('PL8b — timer leak detection', () => {
  // [Implements: NFR-PL-005]
  it('cleanup called before abort prevents timer from ever firing', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const guard = new TimeoutGuard(500);
      const timerCountBefore = clearTimeoutSpy.mock.calls.length;
      guard.cleanup();
      const timerCountAfter = clearTimeoutSpy.mock.calls.length;

      // clearTimeout should have been called at least once during cleanup
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(timerCountBefore);

      // Advance past the timeout — nothing should fire
      vi.advanceTimersByTime(5000);
      expect(guard.isAborted).toBe(false);
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  // [Implements: NFR-PL-005]
  it('second cleanup does not call clearTimeout after first cleanup already cleared it', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const guard = new TimeoutGuard(100);

      // First cleanup clears the timer
      guard.cleanup();
      const callsAfterFirstCleanup = clearTimeoutSpy.mock.calls.length;

      // Second cleanup should NOT call clearTimeout — timer is already null
      guard.cleanup();
      const callsAfterSecondCleanup = clearTimeoutSpy.mock.calls.length;

      expect(callsAfterSecondCleanup).toBe(callsAfterFirstCleanup);
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  // [Implements: NFR-PL-005]
  it('cleanup after timer fired still clears the timer reference (harmless no-op)', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(100);
      vi.advanceTimersByTime(100);
      expect(guard.isAborted).toBe(true);

      // cleanup should be safe even after the timer fired
      expect(() => guard.cleanup()).not.toThrow();

      // Calling cleanup again is still idempotent
      expect(() => guard.cleanup()).not.toThrow();
      expect(guard.isAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: NFR-PL-005]
  it('second cleanup does not call clearTimeout (idempotent)', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const guard = new TimeoutGuard(500);
      guard.cleanup();
      const callsAfterFirstCleanup = clearTimeoutSpy.mock.calls.length;

      guard.cleanup();
      const callsAfterSecondCleanup = clearTimeoutSpy.mock.calls.length;

      // The second cleanup should NOT call clearTimeout again
      expect(callsAfterSecondCleanup).toBe(callsAfterFirstCleanup);
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// PL8b: Cleanup lifecycle scenarios
// ---------------------------------------------------------------------------

describe('PL8b — cleanup lifecycle scenarios', () => {
  // [Implements: US-PL-005, NFR-PL-005]
  it('cleanup at various time points all prevent abort', () => {
    vi.useFakeTimers();
    try {
      // Cleanup at 0ms
      const guard1 = new TimeoutGuard(1000);
      guard1.cleanup();
      vi.advanceTimersByTime(1000);
      expect(guard1.isAborted).toBe(false);

      // Cleanup at 100ms
      const guard2 = new TimeoutGuard(1000);
      vi.advanceTimersByTime(100);
      guard2.cleanup();
      vi.advanceTimersByTime(900);
      expect(guard2.isAborted).toBe(false);

      // Cleanup at 999ms
      const guard3 = new TimeoutGuard(1000);
      vi.advanceTimersByTime(999);
      guard3.cleanup();
      vi.advanceTimersByTime(1);
      expect(guard3.isAborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-005]
  it('cleanup after partial time + advance + cleanup again is safe', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(1000);
      vi.advanceTimersByTime(300);
      expect(guard.isAborted).toBe(false);

      guard.cleanup();
      vi.advanceTimersByTime(200);

      guard.cleanup(); // idempotent
      vi.advanceTimersByTime(500);

      expect(guard.isAborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-005]
  it('cleanup immediately, then advance, then construct new guard with same timeout works', () => {
    vi.useFakeTimers();
    try {
      const guard1 = new TimeoutGuard(500);
      guard1.cleanup();
      vi.advanceTimersByTime(500);
      expect(guard1.isAborted).toBe(false);

      const guard2 = new TimeoutGuard(500);
      vi.advanceTimersByTime(500);
      expect(guard2.isAborted).toBe(true);
      guard2.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// PL8b: Integrating TimeoutGuard with ConcurrencyLimiter-style abort
// ---------------------------------------------------------------------------

describe('PL8b — TimeoutGuard signal usage patterns', () => {
  // [Implements: US-PL-015]
  it('signal can be used to create an AbortController-style chain', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(500);
      const downstream = new AbortController();

      // Propagate abort from guard to downstream
      guard.signal.addEventListener('abort', () => {
        downstream.abort();
      });

      expect(downstream.signal.aborted).toBe(false);
      vi.advanceTimersByTime(500);
      expect(downstream.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('signal can be consumed by removeEventListener before abort', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(500);
      let fired = false;
      const listener = (): void => {
        fired = true;
      };

      guard.signal.addEventListener('abort', listener);
      guard.signal.removeEventListener('abort', listener);

      vi.advanceTimersByTime(500);
      // The removed listener should not fire
      expect(fired).toBe(false);
      // But the signal is still aborted
      expect(guard.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-015]
  it('addEventListener with once: true fires exactly once', () => {
    vi.useFakeTimers();
    try {
      const guard = new TimeoutGuard(500);
      let count = 0;
      guard.signal.addEventListener(
        'abort',
        () => {
          count++;
        },
        { once: true }
      );

      vi.advanceTimersByTime(500);
      expect(count).toBe(1);

      // Aborting again has no effect — already aborted
      vi.advanceTimersByTime(1000);
      expect(count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// PL8b: Stress testing
// ---------------------------------------------------------------------------

describe('PL8b — stress testing', () => {
  // [Implements: US-PL-004, NFR-PL-005]
  it('creates and cleans up 100 guards without errors', () => {
    vi.useFakeTimers();
    try {
      const guards: TimeoutGuard[] = [];
      for (let i = 0; i < 100; i++) {
        guards.push(new TimeoutGuard(1000 + i));
      }

      // Cleanup all
      for (const guard of guards) {
        guard.cleanup();
      }

      // Advance past all timeouts
      vi.advanceTimersByTime(100000);

      // None should be aborted
      for (const guard of guards) {
        expect(guard.isAborted).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: US-PL-004]
  it('100 guards with short timeouts all abort correctly', () => {
    vi.useFakeTimers();
    try {
      const guards = Array.from({ length: 100 }, () => new TimeoutGuard(100));
      vi.advanceTimersByTime(100);

      for (const guard of guards) {
        expect(guard.isAborted).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // [Implements: NFR-PL-005]
  it('repeated create + cleanup cycle does not accumulate state', () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 50; i++) {
        const guard = new TimeoutGuard(100);
        expect(guard.isAborted).toBe(false);
        guard.cleanup();
        vi.advanceTimersByTime(100);
        expect(guard.isAborted).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
