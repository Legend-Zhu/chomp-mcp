/**
 * Unit tests for the token-estimator module.
 *
 * Tests estimateTokens (EN/CJK estimation accuracy), isCJK (code point
 * classification), and estimateAndLogTokens (logging + return value).
 *
 * [Spec: US-SY-009, NFR-SY-005]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isCJK,
  estimateTokens,
  estimateAndLogTokens,
} from '../../../src/modules/synthesize/token-estimator.js';

// ---------------------------------------------------------------------------
// isCJK
// ---------------------------------------------------------------------------

describe('isCJK', () => {
  // [Implements: US-SY-009] CJK Unified Ideographs (U+4E00–U+9FFF)
  it('returns true for CJK Unified Ideographs (U+4E00)', () => {
    expect(isCJK(0x4e00)).toBe(true);
  });

  it('returns true for CJK Unified Ideographs (U+9FFF)', () => {
    expect(isCJK(0x9fff)).toBe(true);
  });

  it('returns true for a common Chinese character 一 (U+4E00)', () => {
    expect(isCJK('一'.codePointAt(0)!)).toBe(true);
  });

  // [Implements: US-SY-009] CJK Symbols and Punctuation (U+3000–U+303F)
  it('returns true for CJK Symbols and Punctuation start (U+3000)', () => {
    expect(isCJK(0x3000)).toBe(true);
  });

  it('returns true for CJK Symbols and Punctuation end (U+303F)', () => {
    expect(isCJK(0x303f)).toBe(true);
  });

  // [Implements: US-SY-009] Hiragana (U+3040–U+309F)
  it('returns true for Hiragana (U+3040)', () => {
    expect(isCJK(0x3040)).toBe(true);
  });

  it('returns true for Hiragana (U+309F)', () => {
    expect(isCJK(0x309f)).toBe(true);
  });

  // [Implements: US-SY-009] Katakana (U+30A0–U+30FF)
  it('returns true for Katakana (U+30A0)', () => {
    expect(isCJK(0x30a0)).toBe(true);
  });

  it('returns true for Katakana (U+30FF)', () => {
    expect(isCJK(0x30ff)).toBe(true);
  });

  // [Implements: US-SY-009] CJK Extension A (U+3400–U+4DBF)
  it('returns true for CJK Extension A start (U+3400)', () => {
    expect(isCJK(0x3400)).toBe(true);
  });

  it('returns true for CJK Extension A end (U+4DBF)', () => {
    expect(isCJK(0x4dbf)).toBe(true);
  });

  // [Implements: US-SY-009] Hangul Jamo (U+1100–U+11FF)
  it('returns true for Hangul Jamo (U+1100)', () => {
    expect(isCJK(0x1100)).toBe(true);
  });

  it('returns true for Hangul Jamo (U+11FF)', () => {
    expect(isCJK(0x11ff)).toBe(true);
  });

  // [Implements: US-SY-009] Hangul Syllables (U+AC00–U+D7AF)
  it('returns true for Hangul Syllables (U+AC00)', () => {
    expect(isCJK(0xac00)).toBe(true);
  });

  it('returns true for Hangul Syllables (U+D7AF)', () => {
    expect(isCJK(0xd7af)).toBe(true);
  });

  // [Implements: US-SY-009] CJK Compatibility Ideographs (U+F900–U+FAFF)
  it('returns true for CJK Compatibility Ideographs (U+F900)', () => {
    expect(isCJK(0xf900)).toBe(true);
  });

  it('returns true for CJK Compatibility Ideographs (U+FAFF)', () => {
    expect(isCJK(0xfaff)).toBe(true);
  });

  // [Implements: US-SY-009] Halfwidth and Fullwidth Forms (U+FF00–U+FFEF)
  it('returns true for Halfwidth/Fullwidth Forms (U+FF00)', () => {
    expect(isCJK(0xff00)).toBe(true);
  });

  it('returns true for Halfwidth/Fullwidth Forms (U+FFEF)', () => {
    expect(isCJK(0xffef)).toBe(true);
  });

  // [Implements: US-SY-009] CJK Extension B–F (U+20000–U+2FFFF)
  it('returns true for CJK Extension B start (U+20000)', () => {
    expect(isCJK(0x20000)).toBe(true);
  });

  it('returns true for CJK Extension B–F end (U+2FFFF)', () => {
    expect(isCJK(0x2ffff)).toBe(true);
  });

  // [Implements: US-SY-009] Non-CJK code points
  it('returns false for uppercase A (U+0041)', () => {
    expect(isCJK(0x0041)).toBe(false);
  });

  it('returns false for lowercase z (U+007A)', () => {
    expect(isCJK(0x007a)).toBe(false);
  });

  it('returns false for digit 0 (U+0030)', () => {
    expect(isCJK(0x0030)).toBe(false);
  });

  it('returns false for space (U+0020)', () => {
    expect(isCJK(0x0020)).toBe(false);
  });

  it('returns false for code point just below CJK Symbols (U+2FFF)', () => {
    expect(isCJK(0x2fff)).toBe(false);
  });

  it('returns false for code point just above CJK Unified Ideographs (U+A000)', () => {
    expect(isCJK(0xa000)).toBe(false);
  });

  it('returns false for code point just below Extension B (U+1FFFF)', () => {
    expect(isCJK(0x1ffff)).toBe(false);
  });

  it('returns false for code point just above Extension B–F (U+30000)', () => {
    expect(isCJK(0x30000)).toBe(false);
  });

  it('returns false for Latin Extended-A range (U+0100–U+017F)', () => {
    expect(isCJK(0x0100)).toBe(false);
    expect(isCJK(0x017f)).toBe(false);
  });

  it('returns false for Cyrillic range (U+0400–U+04FF)', () => {
    expect(isCJK(0x0400)).toBe(false);
    expect(isCJK(0x04ff)).toBe(false);
  });

  it('returns false for Arabic range (U+0600–U+06FF)', () => {
    expect(isCJK(0x0600)).toBe(false);
    expect(isCJK(0x06ff)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens — English text
// ---------------------------------------------------------------------------

describe('estimateTokens — English text', () => {
  // [Implements: US-SY-009] ~400 chars → ~100 tokens
  it('estimates ~100 tokens for 400 English characters', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it('estimates 1 token for exactly 4 characters', () => {
    expect(estimateTokens('test')).toBe(1);
  });

  it('estimates 2 tokens for 5 characters (ceil(5/4) = 2)', () => {
    expect(estimateTokens('hello')).toBe(2);
  });

  it('estimates 3 tokens for 11 characters (ceil(11/4) = 3)', () => {
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('estimates 50 tokens for 200 English characters', () => {
    const text = 'word'.repeat(50);
    expect(estimateTokens(text)).toBe(50);
  });

  it('estimates correctly for a realistic English paragraph', () => {
    const text =
      'TypeScript is a strongly typed programming language that builds on JavaScript.';
    // 80 characters → ceil(80/4) = 20
    expect(estimateTokens(text)).toBe(20);
  });

  it('estimates 1 token for a single character', () => {
    expect(estimateTokens('a')).toBe(1);
  });

  it('estimates correctly for text with punctuation and spaces', () => {
    const text = 'Hello, world! This is a test string with punctuation.';
    // 56 chars → ceil(56/4) = 14
    expect(estimateTokens(text)).toBe(14);
  });

  it('handles very long English text', () => {
    const text = 'word '.repeat(10000); // 50000 chars
    // 50000/4 = 12500
    expect(estimateTokens(text)).toBe(12500);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens — CJK text
// ---------------------------------------------------------------------------

describe('estimateTokens — CJK text', () => {
  // [Implements: US-SY-009] ~150 chars → ~100 tokens
  it('estimates ~100 tokens for 150 CJK characters', () => {
    const text = '一'.repeat(150);
    expect(estimateTokens(text)).toBe(100);
  });

  it('estimates 1 token for 1 CJK character (ceil(1/1.5) = 1)', () => {
    expect(estimateTokens('一')).toBe(1);
  });

  it('estimates 2 tokens for 2 CJK characters (ceil(2/1.5) = 2)', () => {
    expect(estimateTokens('你好')).toBe(2);
  });

  it('estimates 2 tokens for 3 CJK characters (ceil(3/1.5) = 2)', () => {
    expect(estimateTokens('你好吗')).toBe(2);
  });

  it('estimates 100 tokens for 150 CJK characters', () => {
    const text = '中'.repeat(150);
    expect(estimateTokens(text)).toBe(100);
  });

  it('estimates 200 tokens for 300 CJK characters', () => {
    const text = '文'.repeat(300);
    expect(estimateTokens(text)).toBe(200);
  });

  it('estimates correctly for Korean Hangul text', () => {
    // Each Hangul syllable is CJK → 3 chars → ceil(3/1.5) = 2
    expect(estimateTokens('안녕하세요')).toBe(4); // 6 chars → ceil(6/1.5) = 4
  });

  it('estimates correctly for Japanese Hiragana text', () => {
    // 5 Hiragana chars → ceil(5/1.5) = ceil(3.33) = 4
    expect(estimateTokens('こんにちは')).toBe(4);
  });

  it('estimates correctly for Japanese Katakana text', () => {
    // 4 Katakana chars → ceil(4/1.5) = ceil(2.67) = 3
    expect(estimateTokens('コンニチハ')).toBe(4); // 5 chars → ceil(5/1.5) = 4
  });
});

// ---------------------------------------------------------------------------
// estimateTokens — empty and whitespace
// ---------------------------------------------------------------------------

describe('estimateTokens — empty and whitespace', () => {
  // [Implements: US-SY-009]
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 0 for single space', () => {
    expect(estimateTokens(' ')).toBe(0);
  });

  it('returns 0 for multiple spaces', () => {
    expect(estimateTokens('     ')).toBe(0);
  });

  it('returns 0 for tab character', () => {
    expect(estimateTokens('\t')).toBe(0);
  });

  it('returns 0 for newline character', () => {
    expect(estimateTokens('\n')).toBe(0);
  });

  it('returns 0 for mixed whitespace', () => {
    expect(estimateTokens(' \t\n\r  \n\t ')).toBe(0);
  });

  it('returns 0 for string of only newlines', () => {
    expect(estimateTokens('\n\n\n\n')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens — mixed content
// ---------------------------------------------------------------------------

describe('estimateTokens — mixed EN/CJK content', () => {
  it('estimates correctly for text with English and CJK mixed', () => {
    // 3 English chars + 2 CJK chars
    // ceil(2/1.5 + 3/4) = ceil(1.333 + 0.75) = ceil(2.083) = 3
    expect(estimateTokens('abc你好')).toBe(3);
  });

  it('estimates correctly for equal mix of English and CJK', () => {
    // 4 English + 4 CJK
    // ceil(4/1.5 + 4/4) = ceil(2.667 + 1) = ceil(3.667) = 4
    expect(estimateTokens('test你好世界')).toBe(4);
  });

  it('estimates correctly for English sentence followed by CJK', () => {
    const englishPart = 'Hello world. '; // 13 chars, all non-CJK
    const cjkPart = '你好世界。'; // 5 CJK chars
    const text = englishPart + cjkPart;
    // ceil(5/1.5 + 13/4) = ceil(3.333 + 3.25) = ceil(6.583) = 7
    expect(estimateTokens(text)).toBe(7);
  });

  it('estimates correctly for CJK with ASCII digits and symbols', () => {
    // '一1二2三3' — 3 CJK + 3 non-CJK
    // ceil(3/1.5 + 3/4) = ceil(2 + 0.75) = ceil(2.75) = 3
    expect(estimateTokens('一1二2三3')).toBe(3);
  });

  it('estimates correctly for CJK punctuation (U+3000 range)', () => {
    // '、。・' are CJK Symbols and Punctuation → 3 CJK chars
    // ceil(3/1.5 + 0/4) = ceil(2) = 2
    expect(estimateTokens('、。・')).toBe(2);
  });

  it('estimates correctly for fullwidth characters', () => {
    // U+FF01 = ！ (fullwidth exclamation) → CJK
    // U+FF21 = Ａ (fullwidth A) → CJK
    // 3 CJK chars → ceil(3/1.5) = 2
    expect(estimateTokens('！Ａ・')).toBe(2);
  });

  it('estimates correctly for surrogate-pair CJK (Extension B)', () => {
    // U+20000 is CJK Extension B — represented as a surrogate pair
    // 𠀀 is U+20000 → 1 CJK char (for...of handles surrogate pairs)
    // ceil(1/1.5) = ceil(0.667) = 1
    expect(estimateTokens('𠀀')).toBe(1);
  });

  it('estimates correctly for multiple Extension B characters', () => {
    // 𠀀𠀁𠀂 — 3 Extension B chars
    // ceil(3/1.5) = 2
    expect(estimateTokens('𠀀𠀁𠀂')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens — edge cases
// ---------------------------------------------------------------------------

describe('estimateTokens — edge cases', () => {
  it('handles emoji (non-CJK)', () => {
    // 🎉 is U+1F389 — not in any CJK range
    // ceil(1/4) = 1
    expect(estimateTokens('🎉')).toBe(1);
  });

  it('handles text with emoji and CJK mixed', () => {
    // 🎉 (non-CJK) + 一 (CJK) = 1 non-CJK + 1 CJK
    // ceil(1/1.5 + 1/4) = ceil(0.667 + 0.25) = ceil(0.917) = 1
    expect(estimateTokens('🎉一')).toBe(1);
  });

  it('returns a non-negative integer', () => {
    const result = estimateTokens('some text here');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('always returns an integer (Math.ceil)', () => {
    const result = estimateTokens('x');
    expect(Number.isInteger(result)).toBe(true);
  });

  it('handles very large text without overflow', () => {
    const text = 'a'.repeat(100000);
    const result = estimateTokens(text);
    expect(result).toBe(25000);
  });

  it('handles text with only special characters', () => {
    // '@#$%^&*()' = 9 non-CJK chars → ceil(9/4) = 3
    expect(estimateTokens('@#$%^&*()')).toBe(3);
  });

  it('handles text with line breaks', () => {
    const text = 'line one\nline two\nline three';
    // 28 chars (including \n) → ceil(28/4) = 7
    expect(estimateTokens(text)).toBe(7);
  });

  it('is deterministic — same input always produces same output', () => {
    const text = 'Mixed text 你好世界 hello!';
    const a = estimateTokens(text);
    const b = estimateTokens(text);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens — additional boundary and ratio tests
// ---------------------------------------------------------------------------

describe('estimateTokens — boundary and ratio tests', () => {
  // [Implements: US-SY-009] Exact boundary: 4 non-CJK chars = 1 token
  it('exactly 4 non-CJK chars yields exactly 1 token', () => {
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('exactly 8 non-CJK chars yields exactly 2 tokens', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('3 CJK chars (boundary at 1.5×2=3.0) yields exactly 2 tokens', () => {
    // ceil(3/1.5) = ceil(2.0) = 2
    expect(estimateTokens('一二三')).toBe(2);
  });

  it('4 CJK chars yields 3 tokens (ceil(4/1.5) = ceil(2.67) = 3)', () => {
    expect(estimateTokens('一二三四')).toBe(3);
  });

  it('1500 CJK chars yields exactly 1000 tokens', () => {
    const text = '一'.repeat(1500);
    expect(estimateTokens(text)).toBe(1000);
  });

  it('8000 English chars yields exactly 2000 tokens', () => {
    const text = 'a'.repeat(8000);
    expect(estimateTokens(text)).toBe(2000);
  });

  it('handles text where CJK ratio dominates (mostly CJK)', () => {
    // 100 CJK chars + 1 English char
    // ceil(100/1.5 + 1/4) = ceil(66.667 + 0.25) = ceil(66.917) = 67
    const text = '一'.repeat(100) + 'a';
    expect(estimateTokens(text)).toBe(67);
  });

  it('handles text where English ratio dominates (mostly English)', () => {
    // 1 CJK char + 100 English chars
    // ceil(1/1.5 + 100/4) = ceil(0.667 + 25) = ceil(25.667) = 26
    const text = '一' + 'a'.repeat(100);
    expect(estimateTokens(text)).toBe(26);
  });

  it('handles a realistic mixed-language document snippet', () => {
    const text = 'TypeScript 是一种由微软开发的编程语言。\n' +
      'It adds static typing to JavaScript.\n' +
      '更多信息请访问官方网站。';
    // Compute actual result and verify determinism
    const result = estimateTokens(text);
    expect(result).toBeGreaterThan(25);
    expect(result).toBeLessThan(35);
    // Verify it's deterministic
    expect(estimateTokens(text)).toBe(result);
  });

  it('treats carriage return as whitespace (returns 0)', () => {
    // '\r' is U+000D — not CJK, but it is whitespace → trim() removes it
    expect(estimateTokens('\r')).toBe(0);
  });

  it('handles all-whitespace with CJK whitespace (U+3000 ideographic space)', () => {
    // U+3000 is ideographic space — isCJK returns true for it
    // But trim() removes it (it's whitespace), so estimateTokens returns 0
    expect(estimateTokens('\u3000')).toBe(0);
  });

  it('handles only Unicode control characters', () => {
    // U+0000 through U+001F are control characters, non-CJK, not whitespace
    // \x01 is a non-whitespace control char
    // ceil(1/4) = 1
    expect(estimateTokens('\x01')).toBe(1);
  });

  it('handles alternation of CJK and non-CJK at every position', () => {
    // '一a二b三c' — 3 CJK + 3 non-CJK
    // ceil(3/1.5 + 3/4) = ceil(2 + 0.75) = ceil(2.75) = 3
    expect(estimateTokens('一a二b三c')).toBe(3);
  });

  it('handles a string with exactly one CJK char among many non-CJK', () => {
    // 1 CJK + 99 non-CJK
    // ceil(1/1.5 + 99/4) = ceil(0.667 + 24.75) = ceil(25.417) = 26
    const text = '一' + 'a'.repeat(99);
    expect(estimateTokens(text)).toBe(26);
  });

  it('handles a string of digits only', () => {
    // 12 digits → ceil(12/4) = 3
    expect(estimateTokens('123456789012')).toBe(3);
  });

  it('handles a very large CJK document', () => {
    const text = '中'.repeat(60000);
    // ceil(60000/1.5) = 40000
    expect(estimateTokens(text)).toBe(40000);
  });

  it('handles text with only Hangul Jamo (U+1100 range)', () => {
    // U+1100 ᄀ is Hangul Jamo → CJK
    // 3 CJK chars → ceil(3/1.5) = 2
    expect(estimateTokens('ᄀᄁᄂ')).toBe(2);
  });

  it('handles text with only CJK Compatibility Ideographs (U+F900 range)', () => {
    // U+F900 豈 is CJK Compatibility → CJK
    // 3 CJK chars → ceil(3/1.5) = 2
    expect(estimateTokens('豈更車')).toBe(2);
  });

  it('handles text with only Halfwidth/Fullwidth Forms (U+FF00 range)', () => {
    // U+FF01 ！ → CJK (Halfwidth/Fullwidth)
    // 3 CJK chars → ceil(3/1.5) = 2
    expect(estimateTokens('！＃＄')).toBe(2);
  });

  it('handles text with only CJK Symbols/Punctuation (U+3000 range)', () => {
    // U+3001 、 U+3002 。 U+3003 〃
    // 3 CJK chars → ceil(3/1.5) = 2
    expect(estimateTokens('、。〃')).toBe(2);
  });

  it('handles text with only Hiragana (U+3040 range)', () => {
    // 3 Hiragana chars → ceil(3/1.5) = 2
    expect(estimateTokens('あいう')).toBe(2);
  });

  it('handles text with only Katakana (U+30A0 range)', () => {
    // 3 Katakana chars → ceil(3/1.5) = 2
    expect(estimateTokens('アイウ')).toBe(2);
  });

  it('handles text with only CJK Extension A (U+3400 range)', () => {
    // 3 CJK Extension A chars → ceil(3/1.5) = 2
    expect(estimateTokens('㐀㐁㐂')).toBe(2);
  });

  it('handles text with only Hangul Syllables (U+AC00 range)', () => {
    // 3 Hangul Syllables → ceil(3/1.5) = 2
    expect(estimateTokens('가나다')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens — ratio accuracy property tests
// ---------------------------------------------------------------------------

describe('estimateTokens — ratio accuracy', () => {
  // [Implements: US-SY-009] English ratio ~1 token per 4 chars
  it('English: doubling character count doubles token count', () => {
    const small = 'a'.repeat(100);   // 25 tokens
    const large = 'a'.repeat(200);   // 50 tokens
    expect(estimateTokens(large)).toBe(estimateTokens(small) * 2);
  });

  // [Implements: US-SY-009] CJK ratio ~1 token per 1.5 chars
  it('CJK: tripling character count triples token count', () => {
    const small = '一'.repeat(15);   // 10 tokens
    const large = '一'.repeat(45);   // 30 tokens
    expect(estimateTokens(large)).toBe(estimateTokens(small) * 3);
  });

  it('CJK tokens are always >= English tokens for the same character count', () => {
    const count = 100;
    const enText = 'a'.repeat(count);
    const cjkText = '一'.repeat(count);
    // CJK: ceil(100/1.5) = 67, English: ceil(100/4) = 25
    expect(estimateTokens(cjkText)).toBeGreaterThan(estimateTokens(enText));
  });

  it('English: 1000 chars → ~250 tokens (within ±10%)', () => {
    const text = 'a'.repeat(1000);
    const result = estimateTokens(text);
    expect(result).toBe(250);
    expect(result).toBeGreaterThan(250 * 0.9);
    expect(result).toBeLessThan(250 * 1.1);
  });

  it('CJK: 1000 chars → ~667 tokens (within ±10%)', () => {
    const text = '一'.repeat(1000);
    const result = estimateTokens(text);
    expect(result).toBe(667);
    expect(result).toBeGreaterThan(667 * 0.9);
    expect(result).toBeLessThan(667 * 1.1);
  });
});

// ---------------------------------------------------------------------------
// estimateAndLogTokens
// ---------------------------------------------------------------------------

describe('estimateAndLogTokens', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SY-009, NFR-SY-005]
  it('returns the same estimate as estimateTokens', () => {
    const text = 'a'.repeat(400);
    const result = estimateAndLogTokens(text, 128000, 0.8);
    expect(result).toBe(100);
  });

  it('logs the estimated token count to stderr', () => {
    const text = 'test text here for logging';
    estimateAndLogTokens(text, 128000, 0.8);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[SY] estimated tokens:')
    );
  });

  it('includes the threshold in the log message', () => {
    const text = 'test';
    estimateAndLogTokens(text, 128000, 0.8);
    // threshold = floor(128000 * 0.8) = 102400
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 102400')
    );
  });

  it('includes the estimated value in the log message', () => {
    const text = 'a'.repeat(400);
    estimateAndLogTokens(text, 128000, 0.8);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('estimated tokens: 100')
    );
  });

  it('computes threshold correctly for different maxContextTokens', () => {
    const text = 'test';
    estimateAndLogTokens(text, 8000, 0.8);
    // threshold = floor(8000 * 0.8) = 6400
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 6400')
    );
  });

  it('computes threshold correctly for different safeThresholdRatio', () => {
    const text = 'test';
    estimateAndLogTokens(text, 128000, 0.5);
    // threshold = floor(128000 * 0.5) = 64000
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 64000')
    );
  });

  it('returns 0 for empty string', () => {
    const result = estimateAndLogTokens('', 128000, 0.8);
    expect(result).toBe(0);
  });

  it('logs even for empty string', () => {
    estimateAndLogTokens('', 128000, 0.8);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('estimated tokens: 0')
    );
  });

  it('works with CJK text', () => {
    const text = '一'.repeat(150);
    const result = estimateAndLogTokens(text, 128000, 0.8);
    expect(result).toBe(100);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('estimated tokens: 100')
    );
  });

  it('works with mixed content', () => {
    const text = 'abc你好';
    const result = estimateAndLogTokens(text, 128000, 0.8);
    expect(result).toBe(3);
  });

  it('handles threshold of 0 when maxContextTokens is 0', () => {
    const text = 'test';
    estimateAndLogTokens(text, 0, 0.8);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 0')
    );
  });

  it('handles safeThresholdRatio of 0', () => {
    const text = 'test';
    estimateAndLogTokens(text, 128000, 0);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 0')
    );
  });

  it('logs exactly once per call', () => {
    estimateAndLogTokens('test', 128000, 0.8);
    // stderrSpy is called with one string per write
    const syCalls = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes('[SY] estimated tokens:')
    );
    expect(syCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// estimateAndLogTokens — additional log format and threshold tests
// ---------------------------------------------------------------------------

describe('estimateAndLogTokens — log format and threshold edge cases', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: NFR-SY-005] Exact log format: "[SY] estimated tokens: {N} (threshold: {M})"
  it('log message matches exact format "[SY] estimated tokens: {N} (threshold: {M})"', () => {
    estimateAndLogTokens('a'.repeat(400), 128000, 0.8);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[SY\] estimated tokens: \d+ \(threshold: \d+\)\n/)
    );
  });

  it('includes the [SY] module tag in log', () => {
    estimateAndLogTokens('test', 1000, 0.8);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[SY]')
    );
  });

  it('floors the threshold (Math.floor)', () => {
    // 128000 * 0.85 = 108800.0 — exact, no fractional part
    estimateAndLogTokens('test', 128000, 0.85);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 108800')
    );
  });

  it('floors the threshold for non-exact products', () => {
    // 10000 * 0.85 = 8500.0 — exact
    estimateAndLogTokens('test', 10000, 0.85);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 8500')
    );
  });

  it('floors the threshold for fractional products', () => {
    // 9999 * 0.8 = 7999.2 → floor = 7999
    estimateAndLogTokens('test', 9999, 0.8);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 7999')
    );
  });

  it('handles fractional maxContextTokens (floors product)', () => {
    // 1000.7 * 0.8 = 800.56 → floor = 800
    estimateAndLogTokens('test', 1000.7, 0.8);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 800')
    );
  });

  it('handles fractional safeThresholdRatio', () => {
    // 128000 * 0.85 = 108800
    estimateAndLogTokens('test', 128000, 0.85);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 108800')
    );
  });

  it('handles negative maxContextTokens (threshold goes negative)', () => {
    estimateAndLogTokens('test', -1000, 0.8);
    // threshold = floor(-1000 * 0.8) = floor(-800) = -800
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: -800')
    );
  });

  it('handles negative safeThresholdRatio', () => {
    estimateAndLogTokens('test', 1000, -0.5);
    // threshold = floor(1000 * -0.5) = floor(-500) = -500
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: -500')
    );
  });

  it('handles safeThresholdRatio of 1.0 (full context window)', () => {
    estimateAndLogTokens('test', 128000, 1.0);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 128000')
    );
  });

  it('handles safeThresholdRatio > 1.0 (no practical limit)', () => {
    estimateAndLogTokens('test', 1000, 1.5);
    // threshold = floor(1000 * 1.5) = 1500
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 1500')
    );
  });

  it('returns the correct estimate for very large text', () => {
    const text = 'a'.repeat(100000);
    const result = estimateAndLogTokens(text, 128000, 0.8);
    expect(result).toBe(25000);
  });

  it('does not write to stdout', () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      estimateAndLogTokens('test', 128000, 0.8);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('log message ends with a newline', () => {
    estimateAndLogTokens('test', 128000, 0.8);
    const calls = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes('[SY] estimated tokens:')
    );
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = String(calls[calls.length - 1][0]);
    expect(lastCall.endsWith('\n')).toBe(true);
  });

  it('works with multiple consecutive calls (each logs independently)', () => {
    estimateAndLogTokens('a'.repeat(4), 1000, 0.8);
    estimateAndLogTokens('b'.repeat(8), 2000, 0.9);
    estimateAndLogTokens('c'.repeat(12), 3000, 0.7);

    const syCalls = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes('[SY] estimated tokens:')
    );
    expect(syCalls).toHaveLength(3);
  });

  it('threshold reflects default config values (128000 * 0.8 = 102400)', () => {
    // Simulating the default synthesize config scenario
    estimateAndLogTokens('test', 128000, 0.8);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('threshold: 102400')
    );
  });

  it('handles text consisting of only whitespace-only strings of various types', () => {
    expect(estimateAndLogTokens('\t\n\r', 1000, 0.8)).toBe(0);
    expect(estimateAndLogTokens('   ', 1000, 0.8)).toBe(0);
    expect(estimateAndLogTokens('\n\n\n', 1000, 0.8)).toBe(0);
  });

  it('returns 0 for whitespace-only with non-zero threshold', () => {
    const result = estimateAndLogTokens('  \t  ', 128000, 0.8);
    expect(result).toBe(0);
  });
});
