/**
 * Tests for the similarity computer — Jaccard similarity coefficient on
 * fingerprint sets, covering identical sets, disjoint sets, empty sets,
 * partial overlap, asymmetric sizes, and the warnHighPairwiseCost helper.
 *
 * [Spec: US-DD-006, NFR-DD-002]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  jaccardSimilarity,
  warnHighPairwiseCost,
} from '../../../src/modules/deduplicate/similarity-computer.js';

// ---------------------------------------------------------------------------
// jaccardSimilarity — identical sets
// ---------------------------------------------------------------------------

describe('jaccardSimilarity — identical sets', () => {
  // [Implements: US-DD-006] Identical fingerprint sets → 1.0
  it('returns 1.0 for two identical non-empty sets', () => {
    const setA = new Set([1, 2, 3, 4, 5]);
    const setB = new Set([1, 2, 3, 4, 5]);
    expect(jaccardSimilarity(setA, setB)).toBe(1.0);
  });

  it('returns 1.0 for identical single-element sets', () => {
    const setA = new Set([42]);
    const setB = new Set([42]);
    expect(jaccardSimilarity(setA, setB)).toBe(1.0);
  });

  it('returns 1.0 for identical large sets', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const setA = new Set(values);
    const setB = new Set(values);
    expect(jaccardSimilarity(setA, setB)).toBe(1.0);
  });

  it('returns 1.0 for identical sets with reordered elements', () => {
    const setA = new Set([1, 2, 3, 4, 5]);
    const setB = new Set([5, 4, 3, 2, 1]);
    expect(jaccardSimilarity(setA, setB)).toBe(1.0);
  });

  it('returns 1.0 for identical sets with negative numbers', () => {
    const setA = new Set([-3, -1, -5, 0, 7]);
    const setB = new Set([-3, -1, -5, 0, 7]);
    expect(jaccardSimilarity(setA, setB)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity — disjoint sets
// ---------------------------------------------------------------------------

describe('jaccardSimilarity — disjoint sets', () => {
  // [Implements: US-DD-006] No overlapping fingerprints → 0.0
  it('returns 0.0 for two disjoint non-empty sets', () => {
    const setA = new Set([1, 2, 3]);
    const setB = new Set([4, 5, 6]);
    expect(jaccardSimilarity(setA, setB)).toBe(0.0);
  });

  it('returns 0.0 for disjoint single-element sets', () => {
    const setA = new Set([1]);
    const setB = new Set([2]);
    expect(jaccardSimilarity(setA, setB)).toBe(0.0);
  });

  it('returns 0.0 for disjoint large sets', () => {
    const setA = new Set(Array.from({ length: 50 }, (_, i) => i));
    const setB = new Set(Array.from({ length: 50 }, (_, i) => i + 1000));
    expect(jaccardSimilarity(setA, setB)).toBe(0.0);
  });

  it('returns 0.0 for disjoint sets with negative vs positive', () => {
    const setA = new Set([-1, -2, -3]);
    const setB = new Set([1, 2, 3]);
    expect(jaccardSimilarity(setA, setB)).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity — empty sets
// ---------------------------------------------------------------------------

describe('jaccardSimilarity — empty sets', () => {
  // [Implements: US-DD-006] Both sets empty → 0.0
  it('returns 0.0 when both sets are empty', () => {
    const setA = new Set<number>([]);
    const setB = new Set<number>([]);
    expect(jaccardSimilarity(setA, setB)).toBe(0.0);
  });

  it('returns 0.0 when only setA is empty', () => {
    const setA = new Set<number>([]);
    const setB = new Set([1, 2, 3]);
    expect(jaccardSimilarity(setA, setB)).toBe(0.0);
  });

  it('returns 0.0 when only setB is empty', () => {
    const setA = new Set([1, 2, 3]);
    const setB = new Set<number>([]);
    expect(jaccardSimilarity(setA, setB)).toBe(0.0);
  });

  it('returns 0.0 when setA is empty and setB has a single element', () => {
    const setA = new Set<number>([]);
    const setB = new Set([99]);
    expect(jaccardSimilarity(setA, setB)).toBe(0.0);
  });

  it('returns 0.0 when setA has a single element and setB is empty', () => {
    const setA = new Set([99]);
    const setB = new Set<number>([]);
    expect(jaccardSimilarity(setA, setB)).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity — partial overlap
// ---------------------------------------------------------------------------

describe('jaccardSimilarity — partial overlap', () => {
  // [Implements: US-DD-006] Intersection/union formula
  it('computes correct fraction for partial overlap (1 of 5)', () => {
    // A = {1,2,3}, B = {3,4,5} → ∩={3}, ∪={1,2,3,4,5} → 1/5
    const setA = new Set([1, 2, 3]);
    const setB = new Set([3, 4, 5]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(1 / 5, 10);
  });

  it('computes correct fraction for partial overlap (2 of 4)', () => {
    // A = {1,2,3}, B = {2,3,4} → ∩={2,3}, ∪={1,2,3,4} → 2/4 = 0.5
    const setA = new Set([1, 2, 3]);
    const setB = new Set([2, 3, 4]);
    expect(jaccardSimilarity(setA, setB)).toBe(0.5);
  });

  it('computes correct fraction for partial overlap (3 of 5)', () => {
    // A = {1,2,3,4}, B = {2,3,4,5} → ∩={2,3,4}, ∪={1,2,3,4,5} → 3/5
    const setA = new Set([1, 2, 3, 4]);
    const setB = new Set([2, 3, 4, 5]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(3 / 5, 10);
  });

  it('computes correct fraction for partial overlap (1 of 3)', () => {
    // A = {1,2}, B = {2,3} → ∩={2}, ∪={1,2,3} → 1/3
    const setA = new Set([1, 2]);
    const setB = new Set([2, 3]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(1 / 3, 10);
  });

  it('computes correct fraction for near-identical overlap (4 of 5)', () => {
    // A = {1,2,3,4,5}, B = {2,3,4,5,6} → ∩={2,3,4,5}, ∪={1,2,3,4,5,6} → 4/6
    const setA = new Set([1, 2, 3, 4, 5]);
    const setB = new Set([2, 3, 4, 5, 6]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(4 / 6, 10);
  });

  it('computes correct fraction for minimal overlap in larger sets', () => {
    // A = {10,20,30,40,50}, B = {50,60,70,80,90} → ∩={50}, ∪={10,20,...,90} → 1/9
    const setA = new Set([10, 20, 30, 40, 50]);
    const setB = new Set([50, 60, 70, 80, 90]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(1 / 9, 10);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity — asymmetric set sizes
// ---------------------------------------------------------------------------

describe('jaccardSimilarity — asymmetric set sizes', () => {
  // [Implements: US-DD-006] O(min) efficiency handles asymmetric sizes
  it('computes correctly when setA is a proper subset of setB', () => {
    // A = {1,2}, B = {1,2,3,4,5} → ∩={1,2}, ∪={1,2,3,4,5} → 2/5
    const setA = new Set([1, 2]);
    const setB = new Set([1, 2, 3, 4, 5]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(2 / 5, 10);
  });

  it('computes correctly when setB is a proper subset of setA', () => {
    // A = {1,2,3,4,5}, B = {1,2} → ∩={1,2}, ∪={1,2,3,4,5} → 2/5
    const setA = new Set([1, 2, 3, 4, 5]);
    const setB = new Set([1, 2]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(2 / 5, 10);
  });

  it('computes correctly when setA is much smaller than setB with full overlap', () => {
    // A = {1,2,3}, B = {1,2,3,4,5,6,7,8,9,10} → ∩={1,2,3}, ∪=10 → 3/10
    const setA = new Set([1, 2, 3]);
    const setB = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(3 / 10, 10);
  });

  it('computes correctly when setB is much smaller than setA with full overlap', () => {
    // A = {1,2,3,4,5,6,7,8,9,10}, B = {1,2,3} → ∩={1,2,3}, ∪=10 → 3/10
    const setA = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const setB = new Set([1, 2, 3]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(3 / 10, 10);
  });

  it('computes correctly for single-element setA overlapping larger setB', () => {
    // A = {5}, B = {3,4,5,6,7} → ∩={5}, ∪={3,4,5,6,7} → 1/5
    const setA = new Set([5]);
    const setB = new Set([3, 4, 5, 6, 7]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(1 / 5, 10);
  });

  it('computes correctly for single-element setB overlapping larger setA', () => {
    // A = {3,4,5,6,7}, B = {5} → ∩={5}, ∪={3,4,5,6,7} → 1/5
    const setA = new Set([3, 4, 5, 6, 7]);
    const setB = new Set([5]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(1 / 5, 10);
  });

  it('computes 1.0 when smaller set is fully contained in larger set', () => {
    // A = {42}, B = {42, 100} → ∩={42}, ∪={42,100} → 1/2
    const setA = new Set([42]);
    const setB = new Set([42, 100]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(1 / 2, 10);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity — result range
// ---------------------------------------------------------------------------

describe('jaccardSimilarity — result range and clamping', () => {
  // [Implements: US-DD-006] Result is always in [0.0, 1.0]
  it('returns a value within [0.0, 1.0] for arbitrary sets', () => {
    const setA = new Set([1, 2, 3, 4, 5]);
    const setB = new Set([3, 4, 5, 6, 7, 8, 9, 10]);
    const result = jaccardSimilarity(setA, setB);
    expect(result).toBeGreaterThanOrEqual(0.0);
    expect(result).toBeLessThanOrEqual(1.0);
  });

  it('never exceeds 1.0 for any overlap ratio', () => {
    const setA = new Set([1, 2, 3]);
    const setB = new Set([1, 2, 3]);
    expect(jaccardSimilarity(setA, setB)).toBeLessThanOrEqual(1.0);
  });

  it('never drops below 0.0 for disjoint sets', () => {
    const setA = new Set([1, 2, 3]);
    const setB = new Set([4, 5, 6]);
    expect(jaccardSimilarity(setA, setB)).toBeGreaterThanOrEqual(0.0);
  });

  it('clamps identical large sets to exactly 1.0', () => {
    const values = Array.from({ length: 200 }, (_, i) => i);
    const setA = new Set(values);
    const setB = new Set(values);
    expect(jaccardSimilarity(setA, setB)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity — O(min) efficiency property
// ---------------------------------------------------------------------------

describe('jaccardSimilarity — O(min) efficiency property', () => {
  // [Implements: NFR-DD-002] Iterates over the smaller set regardless of argument order
  it('produces same result regardless of which set is first argument', () => {
    const small = new Set([1, 2, 3]);
    const large = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const ab = jaccardSimilarity(small, large);
    const ba = jaccardSimilarity(large, small);
    expect(ab).toBe(ba);
  });

  it('produces same result for reversed identical sets', () => {
    const setA = new Set([5, 4, 3, 2, 1]);
    const setB = new Set([1, 2, 3, 4, 5]);
    expect(jaccardSimilarity(setA, setB)).toBe(jaccardSimilarity(setB, setA));
  });

  it('produces same result for reversed disjoint sets', () => {
    const setA = new Set([1, 2, 3]);
    const setB = new Set([4, 5, 6]);
    expect(jaccardSimilarity(setA, setB)).toBe(jaccardSimilarity(setB, setA));
  });

  it('produces same result for reversed partially-overlapping sets', () => {
    const setA = new Set([1, 2, 3, 4, 5, 6, 7]);
    const setB = new Set([5, 6, 7, 8, 9, 10]);
    expect(jaccardSimilarity(setA, setB)).toBe(jaccardSimilarity(setB, setA));
  });

  it('handles extremely asymmetric sizes without error', () => {
    // 1 element vs 1000 elements with 1 overlap
    const setA = new Set([500]);
    const setB = new Set(Array.from({ length: 1000 }, (_, i) => i));
    const result = jaccardSimilarity(setA, setB);
    // ∩={500}, ∪=1000 → 1/1000
    expect(result).toBeCloseTo(1 / 1000, 10);
  });

  it('handles extremely asymmetric sizes reversed without error', () => {
    const setA = new Set(Array.from({ length: 1000 }, (_, i) => i));
    const setB = new Set([500]);
    const result = jaccardSimilarity(setA, setB);
    expect(result).toBeCloseTo(1 / 1000, 10);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity — edge cases
// ---------------------------------------------------------------------------

describe('jaccardSimilarity — edge cases', () => {
  it('handles sets containing zero values', () => {
    const setA = new Set([0, 1, 2]);
    const setB = new Set([0, 3, 4]);
    // ∩={0}, ∪={0,1,2,3,4} → 1/5
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(1 / 5, 10);
  });

  it('handles sets with large integer values', () => {
    const setA = new Set([2147483647, -2147483648, 0]);
    const setB = new Set([2147483647, 100, 200]);
    // ∩={2147483647}, ∪={2147483647,-2147483648,0,100,200} → 1/5
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(1 / 5, 10);
  });

  it('handles sets with fractional/float-like integers (hash values)', () => {
    // Typical fingerprint hashes are uint32 values
    const setA = new Set([123456789, 987654321, 555555555]);
    const setB = new Set([987654321, 111111111, 222222222]);
    // ∩={987654321}, ∪={123456789,987654321,555555555,111111111,222222222} → 1/5
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(1 / 5, 10);
  });

  it('handles identical single-element sets with same value', () => {
    const setA = new Set([0]);
    const setB = new Set([0]);
    expect(jaccardSimilarity(setA, setB)).toBe(1.0);
  });

  it('handles partial overlap where intersection equals one set size', () => {
    // A = {1,2,3}, B = {1,2,3,4} → ∩={1,2,3}, ∪={1,2,3,4} → 3/4
    const setA = new Set([1, 2, 3]);
    const setB = new Set([1, 2, 3, 4]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(3 / 4, 10);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity — known Jaccard values (table-driven)
// ---------------------------------------------------------------------------

describe('jaccardSimilarity — known values', () => {
  // [Implements: US-DD-006] |A ∩ B| / |A ∪ B| for documented cases
  const cases: Array<{
    name: string;
    a: number[];
    b: number[];
    expected: number;
  }> = [
    {
      name: 'identical size-3 sets',
      a: [1, 2, 3],
      b: [1, 2, 3],
      expected: 1.0,
    },
    {
      name: 'disjoint size-3 sets',
      a: [1, 2, 3],
      b: [4, 5, 6],
      expected: 0.0,
    },
    {
      name: '2 common out of 5 total',
      a: [1, 2, 3],
      b: [2, 3, 4],
      expected: 2 / 4,
    },
    {
      name: '3 common out of 7 total',
      a: [1, 2, 3, 4, 5],
      b: [3, 4, 5, 6, 7],
      expected: 3 / 7,
    },
    {
      name: 'half overlap',
      a: [1, 2],
      b: [2, 3],
      expected: 1 / 3,
    },
    {
      name: 'one common of six total',
      a: [1, 2, 3, 4],
      b: [4, 5, 6, 7],
      expected: 1 / 7,
    },
    {
      name: 'subset fully contained (2 of 5)',
      a: [1, 2],
      b: [1, 2, 3, 4, 5],
      expected: 2 / 5,
    },
  ];

  for (const { name, a, b, expected } of cases) {
    it(`returns ${expected} for "${name}"`, () => {
      const result = jaccardSimilarity(new Set(a), new Set(b));
      expect(result).toBeCloseTo(expected, 10);
    });
  }
});

// ---------------------------------------------------------------------------
// warnHighPairwiseCost
// ---------------------------------------------------------------------------

describe('warnHighPairwiseCost', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: NFR-DD-002] N > MAX_PAIRWISE_ITEMS → warn
  it('logs a warning when count exceeds MAX_PAIRWISE_ITEMS (51)', () => {
    warnHighPairwiseCost(51);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('high pairwise cost')
    );
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('N=51'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('max=50'));
  });

  it('logs a warning for a large count (100)', () => {
    warnHighPairwiseCost(100);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('high pairwise cost')
    );
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('N=100'));
  });

  // [Implements: NFR-DD-002] N == MAX_PAIRWISE_ITEMS → no warn (boundary)
  it('does NOT log a warning when count equals MAX_PAIRWISE_ITEMS (50)', () => {
    warnHighPairwiseCost(50);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does NOT log a warning when count is below MAX_PAIRWISE_ITEMS (49)', () => {
    warnHighPairwiseCost(49);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does NOT log a warning when count is 1', () => {
    warnHighPairwiseCost(1);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does NOT log a warning when count is 0', () => {
    warnHighPairwiseCost(0);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('logs exactly once for a single call with high count', () => {
    warnHighPairwiseCost(75);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('includes the WARN prefix and DD module tag in the message', () => {
    warnHighPairwiseCost(60);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DD] WARN')
    );
  });
});
