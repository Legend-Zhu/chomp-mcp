/**
 * Similarity computer — Jaccard similarity coefficient on fingerprint sets.
 *
 * Computes |A ∩ B| / |A ∪ B| by iterating over the smaller set for
 * intersection counting, achieving O(min(|A|, |B|)) time complexity.
 *
 * Returns 1.0 for identical sets, 0.0 for disjoint sets, and 0.0 when
 * both sets are empty.
 *
 * [Spec: US-DD-006, NFR-DD-002]
 */

import { MAX_PAIRWISE_ITEMS } from './types.js';

// [Implements: US-DD-006]
/**
 * Compute the Jaccard similarity coefficient between two fingerprint sets.
 *
 * Jaccard similarity = |A ∩ B| / |A ∪ B|
 *
 * - Identical sets → 1.0
 * - Disjoint sets  → 0.0
 * - Both empty     → 0.0
 *
 * The function iterates over the smaller set to count intersection elements,
 * giving O(min(|A|, |B|)) time complexity.
 *
 * @param setA - First fingerprint set.
 * @param setB - Second fingerprint set.
 * @returns Similarity score clamped to [0.0, 1.0].
 *
 * [Implements: US-DD-006]
 * [Constraint: NFR-DD-002]
 */
export function jaccardSimilarity(
  setA: Set<number>,
  setB: Set<number>
): number {
  // [Implements: US-DD-006] Both sets empty → return 0.0
  if (setA.size === 0 && setB.size === 0) {
    return 0.0;
  }

  // [Implements: US-DD-006] Determine smaller and larger set so we
  // iterate over the smaller for O(min(|A|, |B|)) intersection counting.
  const smaller: Set<number> = setA.size <= setB.size ? setA : setB;
  const larger: Set<number> = setA.size <= setB.size ? setB : setA;

  // Count intersection by checking each element of the smaller set
  // against the larger set.
  let intersection = 0;
  for (const elem of smaller) {
    if (larger.has(elem)) {
      intersection++;
    }
  }

  // [Implements: US-DD-006] Union size = |A| + |B| - |A ∩ B|
  const union = setA.size + setB.size - intersection;

  // Guard against division by zero (both-empty case handled above,
  // but kept defensively in case of future changes).
  if (union === 0) {
    return 0.0;
  }

  const result = intersection / union;

  // [Implements: US-DD-006] Clamp to [0.0, 1.0]
  return Math.min(1.0, Math.max(0.0, result));
}

// [Implements: US-DD-006]
/**
 * Log a warning to stderr when the number of items for pairwise comparison
 * exceeds MAX_PAIRWISE_ITEMS, indicating high computational cost.
 *
 * The pairwise comparison count is N*(N-1)/2 for N items.
 *
 * @param count - Number of items to compare pairwise.
 *
 * [Implements: US-DD-006]
 * [Constraint: DC-DD-005]
 */
export function warnHighPairwiseCost(count: number): void {
  if (count > MAX_PAIRWISE_ITEMS) {
    process.stderr.write(
      `[DD] WARN high pairwise cost: N=${count} max=${MAX_PAIRWISE_ITEMS}\n`
    );
  }
}
