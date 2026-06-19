/**
 * Tests for the fingerprinter — FNV-1a 32-bit hash determinism, consistency,
 * collision resistance, known hash values, and fingerprint set computation
 * including deduplication and normalization.
 *
 * [Spec: US-DD-005, DC-DD-002]
 */

import { describe, it, expect } from 'vitest';
import {
  fnv1a32,
  computeFingerprintSet,
  FNV_OFFSET_32,
  FNV_PRIME_32,
} from '../../../src/modules/deduplicate/fingerprinter.js';

// ---------------------------------------------------------------------------
// FNV-1a constants
// ---------------------------------------------------------------------------

describe('FNV constants', () => {
  // [Constraint: DC-DD-002]
  it('exports the correct FNV-1a offset basis (2166136261)', () => {
    expect(FNV_OFFSET_32).toBe(2166136261);
    expect(FNV_OFFSET_32).toBe(0x811c9dc5);
  });

  // [Constraint: DC-DD-002]
  it('exports the correct FNV-1a prime multiplier (16777619)', () => {
    expect(FNV_PRIME_32).toBe(16777619);
    expect(FNV_PRIME_32).toBe(0x01000193);
  });

  it('offset basis is an unsigned 32-bit integer', () => {
    expect(FNV_OFFSET_32).toBeGreaterThanOrEqual(0);
    expect(FNV_OFFSET_32).toBeLessThanOrEqual(0xffffffff);
  });

  it('prime multiplier is an unsigned 32-bit integer', () => {
    expect(FNV_PRIME_32).toBeGreaterThanOrEqual(0);
    expect(FNV_PRIME_32).toBeLessThanOrEqual(0xffffffff);
  });
});

// ---------------------------------------------------------------------------
// fnv1a32 — determinism (identical input → identical hash)
// ---------------------------------------------------------------------------

describe('fnv1a32 — determinism', () => {
  // [Implements: US-DD-005] Two identical inputs always produce identical hashes
  it('produces identical hashes for identical input strings', () => {
    const text = 'hello world this is a test string';
    expect(fnv1a32(text)).toBe(fnv1a32(text));
  });

  it('produces identical hashes across multiple calls (10x)', () => {
    const text = 'deterministic consistency check';
    const first = fnv1a32(text);
    for (let i = 0; i < 10; i++) {
      expect(fnv1a32(text)).toBe(first);
    }
  });

  it('produces identical hashes for two separate identical string literals', () => {
    const a = 'the quick brown fox jumps over the lazy dog';
    const b = 'the quick brown fox jumps over the lazy dog';
    expect(fnv1a32(a)).toBe(fnv1a32(b));
  });

  it('produces identical hashes for dynamically constructed identical strings', () => {
    const built1 = ['hello', 'world'].join(' ');
    const built2 = 'hello world';
    expect(fnv1a32(built1)).toBe(fnv1a32(built2));
  });

  it('is stable across different runtime states (no shared mutable state)', () => {
    const text = 'no side effects between calls';
    const results: number[] = [];
    // Interleave with other hashing calls
    results.push(fnv1a32(text));
    fnv1a32('other text one');
    results.push(fnv1a32(text));
    fnv1a32('other text two');
    results.push(fnv1a32(text));
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });
});

// ---------------------------------------------------------------------------
// fnv1a32 — known hash values (FNV-1a reference test vectors)
// ---------------------------------------------------------------------------

describe('fnv1a32 — known hash values', () => {
  // [Implements: US-DD-005] FNV-1a reference test vectors
  it('hashes empty string to the FNV offset basis', () => {
    // Standard FNV-1a: fnv1a_32("") = 0x811c9dc5
    expect(fnv1a32('')).toBe(2166136261);
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('')).toBe(FNV_OFFSET_32);
  });

  // [Constraint: DC-DD-002] FNV-1a test vector for "a"
  it('hashes "a" to the known FNV-1a test vector', () => {
    // Standard FNV-1a: fnv1a_32("a") = 0xe40c292c
    expect(fnv1a32('a')).toBe(3826002220);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });

  // [Constraint: DC-DD-002] FNV-1a test vector for "foobar"
  it('hashes "foobar" to the known FNV-1a test vector', () => {
    // Standard FNV-1a: fnv1a_32("foobar") = 0xbf9cf968
    expect(fnv1a32('foobar')).toBe(3214735720);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('hashes "a" differently from empty string', () => {
    expect(fnv1a32('a')).not.toBe(fnv1a32(''));
  });

  it('hashes single space differently from empty string', () => {
    expect(fnv1a32(' ')).not.toBe(fnv1a32(''));
  });
});

// ---------------------------------------------------------------------------
// fnv1a32 — collision resistance (different inputs → different hashes)
// ---------------------------------------------------------------------------

describe('fnv1a32 — collision resistance', () => {
  // [Implements: US-DD-005] Different inputs should produce different hashes
  it('produces different hashes for different single characters', () => {
    const hashes = new Set<number>();
    for (let i = 0; i < 26; i++) {
      hashes.add(fnv1a32(String.fromCharCode(97 + i)));
    }
    expect(hashes.size).toBe(26);
  });

  it('produces different hashes for different digits', () => {
    const hashes = new Set<number>();
    for (let i = 0; i < 10; i++) {
      hashes.add(fnv1a32(String(i)));
    }
    expect(hashes.size).toBe(10);
  });

  it('produces different hashes for strings differing by one character', () => {
    expect(fnv1a32('hello world')).not.toBe(fnv1a32('hello worle'));
  });

  it('produces different hashes for prefixes (ab vs abc)', () => {
    expect(fnv1a32('ab')).not.toBe(fnv1a32('abc'));
  });

  it('produces different hashes for reversed strings', () => {
    expect(fnv1a32('hello')).not.toBe(fnv1a32('olleh'));
  });

  it('produces different hashes for case variants', () => {
    expect(fnv1a32('Hello')).not.toBe(fnv1a32('hello'));
    expect(fnv1a32('HELLO')).not.toBe(fnv1a32('hello'));
  });

  it('produces different hashes for whitespace variants', () => {
    expect(fnv1a32('hello world')).not.toBe(fnv1a32('hello  world'));
    expect(fnv1a32('hello world')).not.toBe(fnv1a32('hello\tworld'));
  });

  it('produces different hashes for a set of distinct long strings', () => {
    const strings = [
      'the quick brown fox jumps over the lazy dog',
      'lorem ipsum dolor sit amet consectetur adipiscing elit',
      'a completely different sentence about various topics here',
      'yet another unique string with its own hash value now',
      'final distinct paragraph content for hash uniqueness test',
    ];
    const hashes = strings.map(fnv1a32);
    const unique = new Set(hashes);
    expect(unique.size).toBe(strings.length);
  });

  it('produces no collisions across 100 distinct numeric strings', () => {
    const hashes = new Set<number>();
    for (let i = 0; i < 100; i++) {
      hashes.add(fnv1a32(`item number ${i} content`));
    }
    expect(hashes.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// fnv1a32 — return value properties
// ---------------------------------------------------------------------------

describe('fnv1a32 — return value properties', () => {
  // [Implements: US-DD-005] Result is an unsigned 32-bit integer
  it('always returns a non-negative integer', () => {
    const inputs = ['', 'a', 'hello', 'test string', 'longer test string here'];
    for (const input of inputs) {
      const hash = fnv1a32(input);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(hash)).toBe(true);
    }
  });

  it('always returns a value within unsigned 32-bit range', () => {
    const inputs = [
      '',
      'a',
      'test',
      'a very long string that goes on and on for testing purposes here',
    ];
    for (const input of inputs) {
      const hash = fnv1a32(input);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('returns a number type (not bigint)', () => {
    const hash = fnv1a32('test');
    expect(typeof hash).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// fnv1a32 — character processing
// ---------------------------------------------------------------------------

describe('fnv1a32 — character processing', () => {
  it('processes each character in order (longer strings produce different hashes)', () => {
    const h1 = fnv1a32('hello');
    const h2 = fnv1a32('hello!');
    const h3 = fnv1a32('hello world');
    expect(h1).not.toBe(h2);
    expect(h2).not.toBe(h3);
    expect(h1).not.toBe(h3);
  });

  it('treats uppercase and lowercase as different characters', () => {
    expect(fnv1a32('A')).not.toBe(fnv1a32('a'));
    expect(fnv1a32('ABC')).not.toBe(fnv1a32('abc'));
  });

  it('handles special characters', () => {
    const hash = fnv1a32('hello!@#$%^&*()');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBe(fnv1a32('hello!@#$%^&*()'));
  });

  it('handles newlines and tabs', () => {
    const hash = fnv1a32('hello\nworld\ttab');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBe(fnv1a32('hello\nworld\ttab'));
  });

  it('handles unicode characters (BMP)', () => {
    const hash = fnv1a32('café résumé');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBe(fnv1a32('café résumé'));
  });

  it('handles CJK characters', () => {
    const hash = fnv1a32('这是一段中文测试文本');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBe(fnv1a32('这是一段中文测试文本'));
  });

  it('produces a hash for a single character', () => {
    const hash = fnv1a32('x');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — basic functionality
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — basic functionality', () => {
  // [Implements: US-DD-005] Produces a set of fingerprints for paragraph content
  it('returns a Set<number>', () => {
    const content = 'This is a paragraph with enough text to pass.';
    const result = computeFingerprintSet(content);
    expect(result).toBeInstanceOf(Set);
  });

  it('produces one fingerprint for a single paragraph', () => {
    const content = 'This is a single paragraph with enough text to pass.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });

  // [Implements: US-DD-005] Multiple paragraphs produce multiple fingerprints
  it('produces multiple fingerprints for multiple paragraphs', () => {
    const content = [
      'First paragraph with enough text content here.',
      'Second paragraph with enough text content here.',
      'Third paragraph with enough text content here.',
    ].join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(3);
  });

  it('produces the correct hash for a single paragraph', () => {
    const paragraph = 'this is a single paragraph with enough text to pass.';
    const content = paragraph;
    const result = computeFingerprintSet(content);
    // The paragraph is already normalized (no extra whitespace, lowercase)
    // so its fingerprint should match fnv1a32(paragraph)
    expect(result.has(fnv1a32(paragraph))).toBe(true);
  });

  it('produces the correct hashes for multiple paragraphs', () => {
    const para1 = 'first paragraph with enough text content here.';
    const para2 = 'second paragraph with enough text content here.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    expect(result.has(fnv1a32(para1))).toBe(true);
    expect(result.has(fnv1a32(para2))).toBe(true);
  });

  it('stores fingerprint set as numbers', () => {
    const content = 'A paragraph with enough text content to pass.';
    const result = computeFingerprintSet(content);
    for (const fp of result) {
      expect(typeof fp).toBe('number');
      expect(Number.isInteger(fp)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — identical paragraph deduplication
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — identical paragraph deduplication', () => {
  // [Implements: US-DD-005] Identical paragraphs produce identical fingerprints
  it('deduplicates identical paragraphs into a single fingerprint', () => {
    const para = 'This is an identical paragraph with enough text content here.';
    const content = [para, para, para].join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });

  it('deduplicates some identical paragraphs from a larger set', () => {
    const paraA = 'Paragraph A has enough text content to pass the threshold.';
    const paraB = 'Paragraph B has enough text content to pass the threshold.';
    const paraC = 'Paragraph C has enough text content to pass the threshold.';
    const content = [paraA, paraB, paraA, paraC, paraB].join('\n\n');
    const result = computeFingerprintSet(content);
    // 3 unique paragraphs (A, B, C), duplicates collapsed
    expect(result.size).toBe(3);
  });

  it('deduplicates paragraphs that differ only in whitespace before hashing', () => {
    const para1 = 'This paragraph has enough text content to pass the threshold.';
    const para2 = 'This  paragraph  has  enough  text  content  to  pass  the  threshold.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    // After normalization (collapse whitespace), both paragraphs are identical
    expect(result.size).toBe(1);
  });

  it('deduplicates paragraphs that differ only in case before hashing', () => {
    const para1 = 'This paragraph has enough text content to pass the threshold.';
    const para2 = 'THIS PARAGRAPH HAS ENOUGH TEXT CONTENT TO PASS THE THRESHOLD.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    // After normalization (lowercase), both paragraphs are identical
    expect(result.size).toBe(1);
  });

  it('deduplicates paragraphs differing in both whitespace and case', () => {
    const para1 = 'This paragraph has enough text content to pass the threshold.';
    const para2 = '   THIS   PARAGRAPH   HAS   ENOUGH   TEXT   CONTENT   TO   PASS   THE   THRESHOLD.   ';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });

  it('preserves distinct paragraphs when they are genuinely different', () => {
    const para1 = 'This is about topic one with enough text content here.';
    const para2 = 'This is about topic two with enough text content here.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('deduplicates many copies of the same paragraph', () => {
    const para = 'Repeated paragraph content with enough text to pass the minimum threshold.';
    const content = Array.from({ length: 50 }, () => para).join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — text normalization before hashing
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — text normalization', () => {
  // [Implements: US-DD-005] Trim, collapse whitespace, lowercase before hashing
  it('normalizes by trimming leading and trailing whitespace', () => {
    const para = 'a paragraph with enough text content to pass the threshold.';
    const content1 = para;
    const content2 = `   ${para}   `;
    const result1 = computeFingerprintSet(content1);
    const result2 = computeFingerprintSet(content2);
    // Both should produce the same fingerprint set
    expect(result1.size).toBe(result2.size);
    expect([...result1]).toEqual([...result2]);
  });

  it('normalizes by collapsing internal whitespace runs to single spaces', () => {
    const para1 = 'this paragraph has enough text content to pass the threshold.';
    const para2 = 'this    paragraph    has    enough    text    content    to    pass    the    threshold.';
    const content1 = para1;
    const content2 = para2;
    const result1 = computeFingerprintSet(content1);
    const result2 = computeFingerprintSet(content2);
    expect([...result1]).toEqual([...result2]);
  });

  it('normalizes by converting to lowercase', () => {
    const para1 = 'this paragraph has enough text content to pass the threshold.';
    const para2 = 'This Paragraph Has Enough Text Content To Pass The Threshold.';
    const result1 = computeFingerprintSet(para1);
    const result2 = computeFingerprintSet(para2);
    expect([...result1]).toEqual([...result2]);
  });

  it('normalizes tabs and newlines within a paragraph to single spaces', () => {
    const para1 = 'word1 word2 word3 that is long enough to pass the threshold.';
    const para2 = 'word1\tword2\nword3\tthat\tis\tlong\tenough\tto\tpass\tthe\tthreshold.';
    const result1 = computeFingerprintSet(para1);
    const result2 = computeFingerprintSet(para2);
    expect([...result1]).toEqual([...result2]);
  });

  it('applies all normalizations together (trim + collapse + lowercase)', () => {
    const normalized = 'this is a paragraph with enough text to pass.';
    const raw = '   This    is    a    PARAGRAPH\n\twith    enough    text    to    pass.   ';
    const resultNormalized = computeFingerprintSet(normalized);
    const resultRaw = computeFingerprintSet(raw);
    // Both should produce the same single fingerprint
    expect(resultNormalized.size).toBe(1);
    expect(resultRaw.size).toBe(1);
    expect([...resultNormalized][0]).toBe([...resultRaw][0]);
    // The fingerprint should match direct hashing of the normalized text
    expect([...resultNormalized][0]).toBe(fnv1a32(normalized));
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — minChars parameter
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — minChars parameter', () => {
  // [Implements: US-DD-005] minChars controls paragraph filtering
  it('uses default minChars (20) when not specified', () => {
    const content = 'Short.\n\nThis is a paragraph with enough text content to pass.';
    const result = computeFingerprintSet(content);
    // 'Short.' is 6 chars — below default 20, discarded
    expect(result.size).toBe(1);
  });

  it('uses custom minChars value to filter paragraphs', () => {
    const content = 'Short.\n\nThis is a paragraph with enough text content to pass.';
    const result = computeFingerprintSet(content, 1);
    // minChars=1 — 'Short.' (6 chars) now passes
    expect(result.size).toBe(2);
  });

  it('filters all paragraphs when minChars is very high', () => {
    const content = 'First paragraph with enough text.\n\nSecond paragraph with enough text.';
    const result = computeFingerprintSet(content, 1000);
    expect(result.size).toBe(0);
  });

  it('returns empty set when all segments are below minChars', () => {
    const content = 'abc\n\ndef\n\nghi';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(0);
  });

  it('produces different fingerprint counts with different minChars', () => {
    const content = [
      'Abc.',
      'This is a longer paragraph that exceeds the default threshold.',
      'Def.',
      'Another long paragraph that exceeds the default threshold easily.',
    ].join('\n\n');

    const resultDefault = computeFingerprintSet(content);
    const resultLow = computeFingerprintSet(content, 3);

    expect(resultDefault.size).toBe(2); // only the two long paragraphs (4 chars and 4 chars are below 20)
    expect(resultLow.size).toBe(4); // all four pass with minChars=3
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — empty and edge-case inputs
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — empty and edge-case inputs', () => {
  // [Implements: US-DD-005] Empty content produces empty fingerprint set
  it('returns an empty set for empty string', () => {
    const result = computeFingerprintSet('');
    expect(result.size).toBe(0);
  });

  it('returns an empty set for whitespace-only string', () => {
    const result = computeFingerprintSet('   ');
    expect(result.size).toBe(0);
  });

  it('returns an empty set for newline-only string', () => {
    const result = computeFingerprintSet('\n\n\n');
    expect(result.size).toBe(0);
  });

  it('returns an empty set for content with only short segments', () => {
    const result = computeFingerprintSet('ab\n\ncd\n\nef');
    expect(result.size).toBe(0);
  });

  it('handles a single very long paragraph', () => {
    const longPara = 'a'.repeat(10000);
    const result = computeFingerprintSet(longPara);
    expect(result.size).toBe(1);
    expect(result.has(fnv1a32(longPara))).toBe(true);
  });

  it('handles many distinct paragraphs', () => {
    const paragraphs = Array.from(
      { length: 20 },
      (_, i) => `This is paragraph number ${i} with enough text content to pass the minimum threshold.`
    );
    const content = paragraphs.join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(20);
  });

  it('handles content with leading and trailing newlines', () => {
    const content = '\n\nFirst paragraph with enough text content here.\n\nSecond paragraph with enough text content here.\n\n';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('handles content with mixed long and short paragraphs', () => {
    const content = [
      'Short.',
      'This is a long enough paragraph to pass.',
      'Tiny.',
      'Another long enough paragraph to keep here.',
    ].join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('handles whitespace-only segments between real paragraphs', () => {
    const content = 'First paragraph with enough text content here.\n\n   \n\nSecond paragraph with enough text content here.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — relationship with fnv1a32
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — consistency with fnv1a32', () => {
  it('produces fingerprint values that match direct fnv1a32 calls on normalized text', () => {
    const para1 = 'first paragraph with enough text content here.';
    const para2 = 'second paragraph with enough text content here.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);

    const expected1 = fnv1a32(para1.trim().replace(/\s+/g, ' ').toLowerCase());
    const expected2 = fnv1a32(para2.trim().replace(/\s+/g, ' ').toLowerCase());

    expect(result.has(expected1)).toBe(true);
    expect(result.has(expected2)).toBe(true);
    expect(result.size).toBe(2);
  });

  it('produces identical results for content that normalizes the same way', () => {
    const base = 'This is a test paragraph with enough text content to pass the threshold.';
    const variant1 = base;
    const variant2 = `   ${base.toUpperCase().replace(/ /g, '  ')}   `;

    const result1 = computeFingerprintSet(variant1);
    const result2 = computeFingerprintSet(variant2);

    expect(result1.size).toBe(1);
    expect(result2.size).toBe(1);
    expect([...result1][0]).toBe([...result2][0]);
  });

  it('each fingerprint in the set is a valid unsigned 32-bit integer', () => {
    const content = [
      'First paragraph with enough text content here.',
      'Second paragraph with enough text content here.',
      'Third paragraph with enough text content here.',
    ].join('\n\n');
    const result = computeFingerprintSet(content);
    for (const fp of result) {
      expect(fp).toBeGreaterThanOrEqual(0);
      expect(fp).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(fp)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — multi-paragraph with duplicates (integration)
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — multi-paragraph integration', () => {
  // [Implements: US-DD-005] Article with duplicates produces a deduplicated fingerprint set
  it('produces a deduplicated set for an article with repeated paragraphs', () => {
    const unique1 = 'The quick brown fox jumps over the lazy dog every day.';
    const unique2 = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed.';
    const unique3 = 'A third paragraph about a completely different topic here.';

    const content = [
      unique1,
      unique2,
      unique1, // duplicate of first
      unique3,
      unique2, // duplicate of second
      unique1, // duplicate of first again
    ].join('\n\n');

    const result = computeFingerprintSet(content);
    // 3 unique paragraphs despite 6 total segments
    expect(result.size).toBe(3);

    // Verify each unique paragraph's fingerprint is present
    const fp1 = fnv1a32(unique1.trim().replace(/\s+/g, ' ').toLowerCase());
    const fp2 = fnv1a32(unique2.trim().replace(/\s+/g, ' ').toLowerCase());
    const fp3 = fnv1a32(unique3.trim().replace(/\s+/g, ' ').toLowerCase());

    expect(result.has(fp1)).toBe(true);
    expect(result.has(fp2)).toBe(true);
    expect(result.has(fp3)).toBe(true);
  });

  it('produces a smaller set than total segment count when duplicates exist', () => {
    const para = 'This paragraph will be repeated multiple times in this test.';
    const content = Array.from({ length: 10 }, () => para).join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
    expect(result.size).toBeLessThan(10);
  });

  it('handles a realistic article with some duplicates and some unique paragraphs', () => {
    const paragraphs = [
      'Introduction to the topic with enough text content to pass.',
      'The main body discusses several important points about the subject.',
      'Introduction to the topic with enough text content to pass.', // dup
      'Further analysis reveals additional insights worth noting here.',
      'The main body discusses several important points about the subject.', // dup
      'Conclusion summarizes the findings and suggests future directions.',
    ];
    const content = paragraphs.join('\n\n');
    const result = computeFingerprintSet(content);
    // 4 unique paragraphs (first, second, fourth, sixth)
    expect(result.size).toBe(4);
  });

  it('handles paragraphs that are nearly identical but not exact (different fingerprints)', () => {
    const para1 = 'This is paragraph one with enough text to pass the threshold.';
    const para2 = 'This is paragraph two with enough text to pass the threshold.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    // "one" vs "two" — different after normalization
    expect(result.size).toBe(2);
  });

  it('produces a fingerprint set usable for downstream similarity comparison', () => {
    // Simulate two articles with some overlapping paragraphs
    const shared = 'This is a shared paragraph that appears in both articles here.';
    const article1Unique = 'This paragraph is unique to the first article only.';
    const article2Unique = 'This paragraph is unique to the second article only.';

    const fps1 = computeFingerprintSet(`${shared}\n\n${article1Unique}`);
    const fps2 = computeFingerprintSet(`${shared}\n\n${article2Unique}`);

    // Both sets should have size 2
    expect(fps1.size).toBe(2);
    expect(fps2.size).toBe(2);

    // The shared paragraph's fingerprint should be in both sets
    const sharedFp = fnv1a32(shared.trim().replace(/\s+/g, ' ').toLowerCase());
    expect(fps1.has(sharedFp)).toBe(true);
    expect(fps2.has(sharedFp)).toBe(true);

    // Compute intersection for Jaccard similarity (should be 1 shared / 3 union = ~0.33)
    const intersection = [...fps1].filter((fp) => fps2.has(fp));
    const union = new Set([...fps1, ...fps2]);
    expect(intersection.length).toBe(1);
    expect(union.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// fnv1a32 — additional known hash vectors
// ---------------------------------------------------------------------------

describe('fnv1a32 — additional known hash vectors', () => {
  // [Implements: US-DD-005] Additional FNV-1a reference test vectors for known strings
  it('hashes "foo" to a consistent FNV-1a hash value', () => {
    // Verified against this implementation's output
    expect(fnv1a32('foo')).toBe(2851307223);
    expect(fnv1a32('foo')).toBe(0xa9f37ed7);
  });

  it('hashes "ab" to a consistent FNV-1a hash value', () => {
    // Verified against this implementation's output
    expect(fnv1a32('ab')).toBe(1294271946);
    expect(fnv1a32('ab')).toBe(0x4d2505ca);
  });

  it('hashes "abc" to a consistent FNV-1a hash value', () => {
    // Verified against this implementation's output
    expect(fnv1a32('abc')).toBe(440920331);
    expect(fnv1a32('abc')).toBe(0x1a47e90b);
  });

  it('hashes "the quick brown fox jumps over the lazy dog" consistently', () => {
    // Verify determinism for a well-known pangram
    const h = fnv1a32('the quick brown fox jumps over the lazy dog');
    expect(fnv1a32('the quick brown fox jumps over the lazy dog')).toBe(h);
  });

  it('hashes a URL string consistently', () => {
    const url = 'https://example.com/path/to/page?query=1&sort=desc';
    expect(fnv1a32(url)).toBe(fnv1a32(url));
    expect(fnv1a32(url)).toBeGreaterThanOrEqual(0);
  });

  it('produces different hashes for "foo" vs "bar"', () => {
    expect(fnv1a32('foo')).not.toBe(fnv1a32('bar'));
  });

  it('produces different hashes for all single ASCII characters 0–127', () => {
    const hashes = new Set<number>();
    for (let i = 0; i < 128; i++) {
      hashes.add(fnv1a32(String.fromCharCode(i)));
    }
    expect(hashes.size).toBe(128);
  });
});

// ---------------------------------------------------------------------------
// fnv1a32 — incremental hash property
// ---------------------------------------------------------------------------

describe('fnv1a32 — incremental hash property', () => {
  // [Implements: US-DD-005] Appending characters changes the hash
  it('produces different hashes for string and string + 1 char', () => {
    const base = 'hello world this is a test';
    const extended = base + '!';
    expect(fnv1a32(base)).not.toBe(fnv1a32(extended));
  });

  it('produces different hashes for progressively longer prefixes', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const hashes: number[] = [];
    for (let i = 1; i <= text.length; i++) {
      hashes.push(fnv1a32(text.slice(0, i)));
    }
    // All prefixes should produce unique hashes
    const unique = new Set(hashes);
    expect(unique.size).toBe(text.length);
  });

  it('produces different hashes when prepending a character', () => {
    expect(fnv1a32('abc')).not.toBe(fnv1a32('_abc'));
  });

  it('produces different hashes when inserting a character in the middle', () => {
    expect(fnv1a32('hello world')).not.toBe(fnv1a32('hello  world'));
    expect(fnv1a32('hello world')).not.toBe(fnv1a32('hello-xworld'));
  });

  it('hashing a string matches hashing it character-by-character and continuing', () => {
    // This tests the incremental property: hash("abc") should equal
    // continuing from hash("ab") with char "c"
    // FNV-1a: hash = (hash XOR char) * prime, iterating
    const text = 'test string for incremental property';
    const full = fnv1a32(text);

    // Manually compute hash of "test string for incremental propert" then add 'y'
    let partial = FNV_OFFSET_32;
    for (let i = 0; i < text.length - 1; i++) {
      partial ^= text.charCodeAt(i);
      partial = Math.imul(partial, FNV_PRIME_32);
    }
    // Add the last character 'y'
    partial ^= text.charCodeAt(text.length - 1);
    partial = Math.imul(partial, FNV_PRIME_32);
    const continued = partial >>> 0;

    expect(full).toBe(continued);
  });
});

// ---------------------------------------------------------------------------
// fnv1a32 — avalanche property (small input change → large hash change)
// ---------------------------------------------------------------------------

describe('fnv1a32 — avalanche effect', () => {
  // [Implements: US-DD-005] Small changes in input cause large changes in hash
  it('produces very different hashes for strings differing in one bit (case toggle)', () => {
    // 'a' (0x61) vs 'A' (0x41) — differ by one bit
    const h1 = fnv1a32('test string with letter a here');
    const h2 = fnv1a32('test string with letter A here');
    // Hashes should be very different (not just slightly different)
    expect(h1).not.toBe(h2);
    // Count differing bits
    let diffBits = 0;
    let diff = h1 ^ h2;
    while (diff > 0) {
      diffBits += diff & 1;
      diff = diff >>> 1;
    }
    // Expect at least 6 of 32 bits to differ for avalanche property
    expect(diffBits).toBeGreaterThanOrEqual(6);
  });

  it('produces very different hashes for adjacent digits', () => {
    const h1 = fnv1a32('this is item number 1 content here');
    const h2 = fnv1a32('this is item number 2 content here');
    expect(h1).not.toBe(h2);
    let diffBits = 0;
    let diff = h1 ^ h2;
    while (diff > 0) {
      diffBits += diff & 1;
      diff = diff >>> 1;
    }
    expect(diffBits).toBeGreaterThanOrEqual(6);
  });

  it('produces different hashes for strings of the same length', () => {
    const strings = [
      'aaaaaaaaaaaaaaaaaaaa',
      'baaaaaaaaaaaaaaaaaaa',
      'caaaaaaaaaaaaaaaaaaa',
      'daaaaaaaaaaaaaaaaaaa',
      'eaaaaaaaaaaaaaaaaaaa',
    ];
    const hashes = strings.map(fnv1a32);
    const unique = new Set(hashes);
    expect(unique.size).toBe(strings.length);
  });
});

// ---------------------------------------------------------------------------
// fnv1a32 — distribution properties
// ---------------------------------------------------------------------------

describe('fnv1a32 — distribution', () => {
  // [Implements: US-DD-005] Hash values should be well distributed
  it('distributes hashes across the 32-bit space for numeric strings', () => {
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      samples.push(fnv1a32(`item_${i}`));
    }
    // Check that hashes span a reasonable range (not clustered in one area)
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const range = max - min;
    // Range should be a significant fraction of the 32-bit space (>1 billion)
    expect(range).toBeGreaterThan(1_000_000_000);
  });

  it('produces unique hashes for 1000 distinct inputs', () => {
    const hashes = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      hashes.add(fnv1a32(`unique string number ${i} for distribution test`));
    }
    expect(hashes.size).toBe(1000);
  });

  it('produces unique hashes for sequential numbers as strings', () => {
    const hashes = new Set<number>();
    for (let i = 0; i < 500; i++) {
      hashes.add(fnv1a32(String(i)));
    }
    expect(hashes.size).toBe(500);
  });

  it('hash values are not systematically biased toward low values', () => {
    let highCount = 0;
    const threshold = 0x80000000; // half of uint32 space
    for (let i = 0; i < 1000; i++) {
      if (fnv1a32(`bias test string ${i}`) >= threshold) {
        highCount++;
      }
    }
    // Roughly half should be in the upper half of the uint32 space
    // Allow a wide margin (300–700 out of 1000)
    expect(highCount).toBeGreaterThan(300);
    expect(highCount).toBeLessThan(700);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — HTML tag handling
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — HTML tag handling', () => {
  // [Implements: US-DD-005] HTML boundary tags create paragraph segments
  it('handles <br> tags as paragraph boundaries when combined with newlines', () => {
    const content = 'First paragraph with enough text here.<br>\n\nSecond paragraph with enough text here.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('handles </p> tags as paragraph boundaries when combined with newlines', () => {
    const content = 'First paragraph with enough text here.</p>\n\nSecond paragraph with enough text here.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('handles </div> tags as paragraph boundaries when combined with newlines', () => {
    const content = 'First paragraph with enough text here.</div>\n\nSecond paragraph with enough text here.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('handles case-insensitive HTML tags', () => {
    const content = 'First paragraph with enough text here.<BR>\n\nSecond paragraph with enough text here.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('produces the same fingerprint regardless of HTML tag used for boundary', () => {
    const para1 = 'first paragraph with enough text content here.';
    const para2 = 'second paragraph with enough text content here.';

    const contentBr = `${para1}<br>\n\n${para2}`;
    const contentP = `${para1}</p>\n\n${para2}`;
    const contentNewline = `${para1}\n\n${para2}`;

    const resultBr = computeFingerprintSet(contentBr);
    const resultP = computeFingerprintSet(contentP);
    const resultNewline = computeFingerprintSet(contentNewline);

    // All three should produce the same fingerprint set
    expect(resultBr.size).toBe(2);
    expect([...resultBr].sort()).toEqual([...resultNewline].sort());
    expect([...resultP].sort()).toEqual([...resultNewline].sort());
  });

  it('handles mixed HTML tags and newlines', () => {
    const content = 'First paragraph with enough text.<br>\n\nSecond paragraph with enough text.\n\nThird paragraph with enough text too.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — cross-platform line endings
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — cross-platform line endings', () => {
  // [Implements: US-DD-005] \r\n and \r line endings are normalized
  it('handles Windows-style \\r\\n line endings', () => {
    const para1 = 'first paragraph with enough text content here.';
    const para2 = 'second paragraph with enough text content here.';
    const content = `${para1}\r\n\r\n${para2}`;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
    expect(result.has(fnv1a32(para1))).toBe(true);
    expect(result.has(fnv1a32(para2))).toBe(true);
  });

  it('handles old Mac-style \\r line endings', () => {
    const para1 = 'first paragraph with enough text content here.';
    const para2 = 'second paragraph with enough text content here.';
    const content = `${para1}\r\r${para2}`;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('produces the same fingerprints regardless of line ending style', () => {
    const para1 = 'first paragraph with enough text content here.';
    const para2 = 'second paragraph with enough text content here.';

    const contentUnix = `${para1}\n\n${para2}`;
    const contentWin = `${para1}\r\n\r\n${para2}`;
    const contentMac = `${para1}\r\r${para2}`;

    const resultUnix = computeFingerprintSet(contentUnix);
    const resultWin = computeFingerprintSet(contentWin);
    const resultMac = computeFingerprintSet(contentMac);

    expect([...resultUnix].sort()).toEqual([...resultWin].sort());
    expect([...resultWin].sort()).toEqual([...resultMac].sort());
  });

  it('handles mixed line endings within the same content', () => {
    const para1 = 'first paragraph with enough text content here.';
    const para2 = 'second paragraph with enough text content here.';
    const para3 = 'third paragraph with enough text content here.';
    // Mix \n\n, \r\n\r\n, and \r\r
    const content = `${para1}\n\n${para2}\r\n\r\n${para3}`;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — large-scale fingerprinting
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — large-scale fingerprinting', () => {
  // [Implements: US-DD-005, NFR-DD-005] Handles large content efficiently
  it('handles 100 distinct paragraphs', () => {
    const paragraphs = Array.from(
      { length: 100 },
      (_, i) => `This is paragraph number ${i} with enough text content to pass the minimum threshold.`
    );
    const content = paragraphs.join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(100);
  });

  it('handles 100 paragraphs with 50% duplicates (50 unique)', () => {
    const paragraphs = Array.from(
      { length: 100 },
      (_, i) => `This is paragraph number ${i % 50} with enough text content to pass the threshold.`
    );
    const content = paragraphs.join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(50);
  });

  it('handles a very large single paragraph (100000 chars)', () => {
    const longPara = 'word '.repeat(20000); // 100000 chars
    const result = computeFingerprintSet(longPara);
    expect(result.size).toBe(1);
  });

  it('handles 500 distinct paragraphs efficiently', () => {
    const paragraphs = Array.from(
      { length: 500 },
      (_, i) => `Unique paragraph ${i} with enough text to pass the threshold check.`
    );
    const content = paragraphs.join('\n\n');
    const start = Date.now();
    const result = computeFingerprintSet(content);
    const elapsed = Date.now() - start;
    expect(result.size).toBe(500);
    // Should complete in a reasonable time (< 100ms)
    expect(elapsed).toBeLessThan(100);
  });

  it('handles content with many short segments (all filtered) without error', () => {
    const segments: string[] = [];
    for (let i = 0; i < 1000; i++) {
      segments.push('short');
    }
    const content = segments.join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(0);
  });

  it('handles content with many paragraphs of varying lengths', () => {
    const paragraphs: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) {
        paragraphs.push(`This is paragraph number ${i} long enough to pass the minimum threshold.`);
      } else {
        paragraphs.push('Short.'); // Below threshold
      }
    }
    const content = paragraphs.join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — fingerprint count properties
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — fingerprint count properties', () => {
  // [Implements: US-DD-005] Fingerprint count equals unique paragraph count
  it('fingerprint count equals number of unique qualifying paragraphs', () => {
    const unique1 = 'A unique paragraph with enough text content here.';
    const unique2 = 'Another unique paragraph with enough text content.';
    const unique3 = 'A third unique paragraph with sufficient text content.';

    const content = [unique1, unique2, unique3].join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(3);
  });

  it('fingerprint count is less than total segment count when duplicates exist', () => {
    const unique1 = 'A unique paragraph with enough text content here.';
    const unique2 = 'Another unique paragraph with enough text content.';

    const content = [unique1, unique2, unique1, unique1, unique2].join('\n\n');
    const result = computeFingerprintSet(content);
    // 5 segments, 2 unique → fingerprint count = 2
    expect(result.size).toBe(2);
    expect(result.size).toBeLessThan(5);
  });

  it('fingerprint count is zero when no paragraphs qualify', () => {
    const content = 'ab\n\ncd\n\nef\n\nghi';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(0);
  });

  it('fingerprint count is one for a single qualifying paragraph', () => {
    const content = 'A single qualifying paragraph with enough text content.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });

  it('fingerprint count does not exceed the number of qualifying segments', () => {
    const paragraphs = [
      'First unique paragraph with enough text content here.',
      'Second unique paragraph with enough text content here.',
      'Third unique paragraph with enough text content here.',
      'First unique paragraph with enough text content here.', // dup
    ];
    const content = paragraphs.join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(3);
    expect(result.size).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — normalization with HTML tags
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — normalization with HTML residue', () => {
  // [Implements: US-DD-005] Normalization handles paragraphs with remaining HTML content
  it('normalizes paragraphs that contain remaining HTML open tags (treated as text)', () => {
    // <p> open tags are NOT replaced, only closing tags. The segment includes <p>
    const content = '<p>This is a paragraph with enough text content.</p>\n\n<p>Second paragraph with enough text.</p>';
    const result = computeFingerprintSet(content);
    // Two segments after splitting at </p>\n\n<p>
    expect(result.size).toBe(2);
  });

  it('produces consistent fingerprints regardless of leading HTML open tag', () => {
    const para = 'this is a paragraph with enough text content to pass.';
    // Without open tag
    const result1 = computeFingerprintSet(para);
    // The segment includes the <p> tag as literal text since open tags aren't replaced
    // With open tag — different normalized text, different fingerprint
    const withPTag = '<p>this is a paragraph with enough text content to pass.';
    const result2 = computeFingerprintSet(withPTag);
    // Different because <p> is part of the normalized text
    expect(result1.size).toBe(1);
    expect(result2.size).toBe(1);
    expect([...result1][0]).not.toBe([...result2][0]);
  });

  it('normalizes whitespace in paragraphs containing HTML entity-like text', () => {
    const para = 'this paragraph has    extra    spaces    and    enough    text.';
    const result = computeFingerprintSet(para);
    expect(result.size).toBe(1);
    // Normalized form should be 'this paragraph has extra spaces and enough text.'
    const expected = 'this paragraph has extra spaces and enough text.';
    expect(result.has(fnv1a32(expected))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — minChars boundary edge cases
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — minChars boundary edge cases', () => {
  // [Implements: US-DD-005] minChars boundary behavior
  it('retains segment exactly at minChars boundary', () => {
    const exact = 'a'.repeat(20); // exactly 20 chars (default minChars)
    const content = exact;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });

  it('discards segment one char below minChars boundary', () => {
    const justBelow = 'a'.repeat(19); // 19 chars, below default 20
    const content = justBelow;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(0);
  });

  it('uses minChars=1 to retain all non-empty segments', () => {
    const content = 'A\n\nB\n\nC';
    const result = computeFingerprintSet(content, 1);
    expect(result.size).toBe(3);
  });

  it('falls back to default minChars when 0 is passed', () => {
    // minChars=0 is invalid (< 1), falls back to default 20
    const content = 'Short.\n\nThis is a paragraph with enough text to pass.';
    const result = computeFingerprintSet(content, 0);
    expect(result.size).toBe(1);
  });

  it('falls back to default minChars when negative is passed', () => {
    const content = 'Short.\n\nThis is a paragraph with enough text to pass.';
    const result = computeFingerprintSet(content, -10);
    expect(result.size).toBe(1);
  });

  it('falls back to default minChars when NaN is passed', () => {
    const content = 'Short.\n\nThis is a paragraph with enough text to pass.';
    const result = computeFingerprintSet(content, NaN);
    expect(result.size).toBe(1);
  });

  it('filters based on collapsed length, not raw length', () => {
    // Raw segment has lots of spaces making it look long, but after collapse it's short
    const content = 'a    b    c    d\n\nThis is a paragraph with enough text content to pass.';
    const result = computeFingerprintSet(content, 20);
    // 'a b c d' is only 7 chars after collapse → discarded
    expect(result.size).toBe(1);
  });

  it('minChars filters paragraphs before normalization dedup', () => {
    // Two identical short paragraphs (below threshold) should be discarded
    const content = 'short.\n\nshort.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(0);
  });

  it('high minChars filters everything, even long paragraphs', () => {
    const content = 'This is a very long paragraph that is definitely over twenty characters long.';
    const result = computeFingerprintSet(content, 1000);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — determinism
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — determinism', () => {
  // [Implements: US-DD-005] Same input always produces same output
  it('produces identical fingerprint sets for identical content', () => {
    const content = 'First paragraph with enough text here.\n\nSecond paragraph with enough text here.';
    const result1 = computeFingerprintSet(content);
    const result2 = computeFingerprintSet(content);
    expect([...result1].sort()).toEqual([...result2].sort());
  });

  it('produces identical fingerprint sets across multiple calls', () => {
    const content = 'A paragraph with enough text content here.\n\nAnother paragraph with enough text here.';
    const results: number[][] = [];
    for (let i = 0; i < 5; i++) {
      results.push([...computeFingerprintSet(content)].sort());
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0]);
    }
  });

  it('is not affected by interleaved calls with different content', () => {
    const content1 = 'First article paragraph with enough text content here.';
    const content2 = 'Second article paragraph with different text content.';

    const r1a = [...computeFingerprintSet(content1)].sort();
    computeFingerprintSet(content2);
    const r1b = [...computeFingerprintSet(content1)].sort();

    expect(r1a).toEqual(r1b);
  });

  it('produces deterministic order for same input with custom minChars', () => {
    const content = 'Short.\n\nThis is a paragraph with enough text to pass.\n\nAnother long enough paragraph here.';
    const r1 = [...computeFingerprintSet(content, 5)].sort();
    const r2 = [...computeFingerprintSet(content, 5)].sort();
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — special characters and unicode
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — special characters and unicode', () => {
  // [Implements: US-DD-005] Handles special characters in content
  it('handles content with punctuation marks', () => {
    const content = 'Hello, world! This is a paragraph with enough text. Is it working? Yes, it is!';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
    // Normalized: lowercase, collapsed whitespace
    const normalized = content.trim().replace(/\s+/g, ' ').toLowerCase();
    expect(result.has(fnv1a32(normalized))).toBe(true);
  });

  it('handles content with CJK characters', () => {
    const content = '这是一段足够长的中文段落内容，用于测试指纹计算功能是否正常工作。';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
    // Normalized: lowercase (no change for CJK), collapsed whitespace
    const normalized = content.trim().replace(/\s+/g, ' ').toLowerCase();
    expect(result.has(fnv1a32(normalized))).toBe(true);
  });

  it('handles multiple CJK paragraphs', () => {
    const content = '这是第一段足够长的中文段落内容需要超过二十个字符才行。\n\n这是第二段同样足够长的中文内容也需要超过二十个字符。';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('handles content with emoji', () => {
    const content = 'This paragraph has emoji 🎉🎊✨ and enough text content to pass.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });

  it('handles content with accented characters (BMP)', () => {
    const content = 'Café résumé naïve façade — this paragraph has enough text to pass.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });

  it('normalizes accented characters by case (accented uppercase → accented lowercase)', () => {
    const para1 = 'café résumé naïve this paragraph has enough text.';
    const para2 = 'CAFÉ RÉSUMÉ NAÏVE THIS PARAGRAPH HAS ENOUGH TEXT.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    // After lowercase normalization, both should be identical
    expect(result.size).toBe(1);
  });

  it('handles content with numbers and symbols', () => {
    const content = 'Item 1 costs $100.99 (50% off). This is enough text content here for the test.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });

  it('handles content with mixed scripts (Latin + CJK)', () => {
    const content = 'This is English text with 中文 mixed in, enough text here to pass the threshold check.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — content with only short segments after collapse
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — short segments after whitespace collapse', () => {
  // [Implements: US-DD-005] Segments that become short after whitespace collapse are filtered
  it('filters segments that are long before collapse but short after', () => {
    // 'a    b    c' → 'a b c' (5 chars after collapse, below default 20)
    const content = 'a    b    c\n\nThis is a paragraph with enough text content to pass.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });

  it('filters segments with many newlines that collapse to short', () => {
    // Lots of newlines collapse to spaces, resulting in a short segment
    const content = 'a\nb\nc\nd\ne\n\nThis is a paragraph with enough text content to pass.';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });

  it('retains segments that are exactly at threshold after collapse', () => {
    // After collapse: 'a b c d e f g h i j' (19 chars) — below 20, discarded
    // After collapse: 'a b c d e f g h i j k' (21 chars) — above 20, retained
    const atThreshold = 'a b c d e f g h i j k'; // 21 chars after normalization
    const content = atThreshold;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(1);
  });

  it('filters segments that are mostly HTML tags and collapse to short text', () => {
    // HTML closing tags become newlines, collapsing the content
    const content = '<p>a</p><p>b</p>\n\nThis is a paragraph with enough text content to pass.';
    const result = computeFingerprintSet(content);
    // The first segment becomes '<p>a b' after </p> → \n collapse and it's short → discarded
    expect(result.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — paragraph order independence
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — paragraph order independence', () => {
  // [Implements: US-DD-005] Set is order-independent
  it('produces the same fingerprint set regardless of paragraph order', () => {
    const para1 = 'first unique paragraph with enough text content here.';
    const para2 = 'second unique paragraph with enough text content here.';
    const para3 = 'third unique paragraph with enough text content here.';

    const order1 = computeFingerprintSet(`${para1}\n\n${para2}\n\n${para3}`);
    const order2 = computeFingerprintSet(`${para3}\n\n${para1}\n\n${para2}`);
    const order3 = computeFingerprintSet(`${para2}\n\n${para3}\n\n${para1}`);

    expect([...order1].sort()).toEqual([...order2].sort());
    expect([...order2].sort()).toEqual([...order3].sort());
    expect([...order1].sort()).toEqual([...order3].sort());
  });

  it('produces the same count regardless of paragraph order', () => {
    const para1 = 'first unique paragraph with enough text content here.';
    const para2 = 'second unique paragraph with enough text content here.';

    const result1 = computeFingerprintSet(`${para1}\n\n${para2}`);
    const result2 = computeFingerprintSet(`${para2}\n\n${para1}`);

    expect(result1.size).toBe(result2.size);
    expect(result1.size).toBe(2);
  });

  it('produces the same deduplicated set regardless of duplicate placement', () => {
    const unique = 'a unique paragraph with enough text content to pass.';

    const result1 = computeFingerprintSet(`${unique}\n\n${unique}\n\n${unique}`);
    const result2 = computeFingerprintSet(`${unique}\n\n${unique}\n\n${unique}\n\n${unique}`);

    expect(result1.size).toBe(1);
    expect(result2.size).toBe(1);
    expect([...result1][0]).toBe([...result2][0]);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — no false positives (distinct paragraphs stay distinct)
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — no false positive deduplication', () => {
  // [Implements: US-DD-005] Genuinely different paragraphs should not be deduplicated
  it('does not deduplicate paragraphs that differ by one word', () => {
    const para1 = 'this paragraph discusses topic one with enough text.';
    const para2 = 'this paragraph discusses topic two with enough text.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('does not deduplicate paragraphs that differ by punctuation', () => {
    const para1 = 'this paragraph has enough text content here.';
    const para2 = 'this paragraph has enough text content here!';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('does not deduplicate paragraphs that differ by trailing period', () => {
    const para1 = 'this paragraph has enough text content to pass';
    const para2 = 'this paragraph has enough text content to pass.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('does not deduplicate paragraphs that differ by a single character at the end', () => {
    const para1 = 'this paragraph has enough text content to pass here.';
    const para2 = 'this paragraph has enough text content to pass heres.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('does not deduplicate paragraphs that differ only by a number', () => {
    const paras = Array.from(
      { length: 10 },
      (_, i) => `this is paragraph number ${i} with enough text content to pass.`
    );
    const content = paras.join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(10);
  });

  it('does not deduplicate paragraphs that differ by word order', () => {
    const para1 = 'the quick brown fox jumps over the lazy dog every day.';
    const para2 = 'the lazy dog jumps over the quick brown fox every day.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('does not deduplicate paragraphs with different whitespace patterns that normalize differently', () => {
    // These have different content (not just whitespace), so they should stay distinct
    const para1 = 'word one word two word three with enough text to pass.';
    const para2 = 'word two word one word three with enough text to pass.';
    const content = `${para1}\n\n${para2}`;
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeFingerprintSet — integration with real-world-like content
// ---------------------------------------------------------------------------

describe('computeFingerprintSet — real-world-like content', () => {
  // [Implements: US-DD-005] Handles realistic article content
  it('processes a realistic news article with multiple paragraphs', () => {
    const article = [
      'The government announced new policies today that will affect millions of citizens across the country.',
      'The announcement came after weeks of deliberation and consultation with various stakeholders in the industry.',
      'Critics have raised concerns about the potential impact on small businesses and local communities nationwide.',
      'Supporters argue that the changes are necessary to address long-standing issues in the current system.',
      'The implementation timeline spans over three years with regular reviews and adjustments planned throughout.',
    ].join('\n\n');
    const result = computeFingerprintSet(article);
    expect(result.size).toBe(5);
  });

  it('processes a realistic article with some duplicate boilerplate paragraphs', () => {
    const boilerplate = 'Subscribe to our newsletter for more updates and exclusive content delivered daily.';
    const article = [
      'Breaking news article with enough text content to pass the minimum threshold check easily.',
      boilerplate, // boilerplate
      'The main story continues with detailed analysis of the situation and expert opinions.',
      boilerplate, // duplicate boilerplate
      'Additional reporting from our correspondent in the field provides more context here.',
    ].join('\n\n');
    const result = computeFingerprintSet(article);
    // 4 unique paragraphs (boilerplate appears twice but deduped)
    expect(result.size).toBe(4);
  });

  it('processes content with HTML tags simulating scraped web content', () => {
    const content = [
      '<p>The first paragraph of the article with enough text content to pass.</p>',
      '<p>The second paragraph continues the discussion with more detail here.</p>',
      '<p>The third paragraph concludes the article with a summary statement.</p>',
    ].join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(3);
  });

  it('processes content with mixed HTML and plain text paragraphs', () => {
    const content = 'Plain text paragraph with enough content to pass the threshold.\n\n<p>HTML paragraph with enough content to pass the threshold too.</p>';
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(2);
  });

  it('handles a large article with 50 paragraphs and 10 duplicates', () => {
    const unique: string[] = [];
    for (let i = 0; i < 40; i++) {
      unique.push(`Paragraph ${i} discusses topic ${i} with enough text content to pass the minimum threshold requirement.`);
    }
    // Add 10 duplicates of existing paragraphs
    const withDups = [...unique];
    for (let i = 0; i < 10; i++) {
      withDups.push(unique[i]);
    }
    const content = withDups.join('\n\n');
    const result = computeFingerprintSet(content);
    expect(result.size).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// FNV constant relationship properties
// ---------------------------------------------------------------------------

describe('FNV constant relationship properties', () => {
  // [Constraint: DC-DD-002]
  it('offset basis and prime are distinct values', () => {
    expect(FNV_OFFSET_32).not.toBe(FNV_PRIME_32);
  });

  it('prime is an odd number (required for FNV-1a)', () => {
    expect(FNV_PRIME_32 % 2).toBe(1);
  });

  it('offset basis is within the standard FNV-1a 32-bit range', () => {
    // Standard FNV offset basis for 32-bit: 0x811c9dc5
    expect(FNV_OFFSET_32).toBe(0x811c9dc5);
  });

  it('prime is within the standard FNV-1a 32-bit range', () => {
    // Standard FNV prime for 32-bit: 0x01000193
    expect(FNV_PRIME_32).toBe(0x01000193);
  });

  it('multiplying offset by prime and XORing char "a" yields the known hash', () => {
    // Manually verify: fnv1a32("a") should be:
    //   hash = offset_basis
    //   hash = hash XOR 'a'(97)
    //   hash = hash * prime
    let expected = FNV_OFFSET_32;
    expected ^= 'a'.charCodeAt(0);
    expected = Math.imul(expected, FNV_PRIME_32);
    expected = expected >>> 0;

    expect(fnv1a32('a')).toBe(expected);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });
});
