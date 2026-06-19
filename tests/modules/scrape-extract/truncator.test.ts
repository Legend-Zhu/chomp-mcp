/**
 * Unit tests for truncator.ts — word-boundary truncation, disabled mode,
 * marker appending, and truncated-flag correctness.
 *
 * [Spec: US-SC-008, DC-SC-005, DC-SC-006]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { truncate } from '../../../src/modules/scrape-extract/truncator.js';

describe('truncate', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // [Implements: US-SC-008] Text within limit is not truncated
  it('returns text unchanged when within the limit', () => {
    const result = truncate('hello world', 100);
    expect(result.text).toBe('hello world');
    expect(result.truncated).toBe(false);
  });

  it('returns text unchanged when exactly at the limit', () => {
    const text = 'a'.repeat(50);
    const result = truncate(text, 50);
    expect(result.text).toBe(text);
    expect(result.truncated).toBe(false);
  });

  it('returns empty string unchanged', () => {
    const result = truncate('', 100);
    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
  });

  // [Implements: US-SC-008] Truncation with word boundary
  it('truncates at word boundary when text exceeds limit', () => {
    const text = 'one two three four';
    const result = truncate(text, 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('one two…[truncated]');
  });

  it('truncates at the nearest whitespace before maxChars', () => {
    const text = 'hello beautiful world';
    // maxChars=12 → text[12]='u' (in 'beautiful'), search back to index 6 ' '
    const result = truncate(text, 12);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('hello…[truncated]');
  });

  // [Implements: US-SC-008] Hard cut when no whitespace found
  it('falls back to hard cut when no whitespace before maxChars', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const result = truncate(text, 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('abcdefghij…[truncated]');
  });

  // [Implements: US-SC-008] Marker is always appended
  it('appends the truncation marker "…[truncated]"', () => {
    const longText = 'word '.repeat(100);
    const result = truncate(longText, 50);
    expect(result.text).toContain('…[truncated]');
    expect(result.truncated).toBe(true);
  });

  // [Implements: US-SC-008] Preserves content from the beginning
  it('preserves text from the beginning, not the middle', () => {
    const title = 'Important Title';
    const body = 'lorem ipsum '.repeat(200);
    const text = `${title}\n${body}`;
    const result = truncate(text, 50);
    expect(result.text.startsWith(title)).toBe(true);
  });

  // [Implements: US-SC-008] Trims trailing whitespace before marker
  it('trims trailing whitespace before appending marker', () => {
    const text = 'hello   world something';
    // maxChars=8 → text[8]='w', search back to index 6 ' '
    const result = truncate(text, 8);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('hello…[truncated]');
    // No trailing spaces before the marker
    expect(result.text).not.toContain(' …[truncated]');
  });

  // [Implements: US-SC-008] Disabled mode: maxChars <= 0
  it('disables truncation when maxChars is 0', () => {
    const longText = 'a'.repeat(10000);
    const result = truncate(longText, 0);
    expect(result.text).toBe(longText);
    expect(result.truncated).toBe(false);
  });

  it('disables truncation when maxChars is negative', () => {
    const longText = 'a'.repeat(10000);
    const result = truncate(longText, -1);
    expect(result.text).toBe(longText);
    expect(result.truncated).toBe(false);
  });

  // [Implements: US-SC-008] Warning logged when truncation disabled
  it('logs a warning to stderr when truncation is disabled (maxChars=0)', () => {
    truncate('some text', 0);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('truncation disabled')
    );
  });

  it('logs a warning to stderr when truncation is disabled (maxChars=-5)', () => {
    truncate('some text', -5);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('truncation disabled')
    );
  });

  it('does not log a warning when truncation is active', () => {
    truncate('short', 100);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  // [Implements: US-SC-008] No warning for within-limit text
  it('does not log when text is within the limit', () => {
    truncate('hello world', 100);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  // [Implements: US-SC-008] Multi-line text truncation
  it('handles newlines as word boundaries', () => {
    const text = 'line one\nline two\nline three';
    const result = truncate(text, 12);
    expect(result.truncated).toBe(true);
    // The cut should be at the newline before 'line two\n'
    expect(result.text).toContain('…[truncated]');
    expect(result.text.startsWith('line one')).toBe(true);
  });

  // [Implements: US-SC-008] Single very long word
  it('handles single very long word by hard cut', () => {
    const text = 'supercalifragilisticexpialidocious';
    const result = truncate(text, 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('supercalif…[truncated]');
  });

  // --- Additional edge cases ---

  // [Implements: US-SC-008] Cut at maxChars when maxChars lands on whitespace
  it('cuts exactly at whitespace character at maxChars', () => {
    const text = 'abcde fghij';
    // maxChars=5, text[5]=' ' → cut at index 5
    const result = truncate(text, 5);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('abcde…[truncated]');
  });

  // [Implements: US-SC-008] Tab as whitespace boundary
  it('handles tab as word boundary', () => {
    const text = 'word1\tword2\tword3';
    const result = truncate(text, 7);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('word1…[truncated]');
  });

  // [Implements: US-SC-008] Carriage return as whitespace boundary
  it('handles carriage return as word boundary', () => {
    const text = 'line1\r\nline2';
    const result = truncate(text, 7);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('line1…[truncated]');
  });

  // [Implements: US-SC-008] maxChars = 1 with long text falls back to hard cut
  it('hard cuts at 1 char when text is long and no whitespace at 0', () => {
    const text = 'abcdefghij';
    const result = truncate(text, 1);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('a…[truncated]');
  });

  // [Implements: US-SC-008] maxChars = 1 with single-char text (not truncated)
  it('does not truncate single char when maxChars is 1', () => {
    const result = truncate('x', 1);
    expect(result.text).toBe('x');
    expect(result.truncated).toBe(false);
  });

  // [Implements: US-SC-008] Whitespace exactly at maxChars index
  it('truncates at whitespace exactly at the maxChars boundary', () => {
    const text = 'aaaa bbbb cccc';
    // maxChars=4, text[4]=' ' → cut at 4, after 'aaaa'
    const result = truncate(text, 4);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('aaaa…[truncated]');
  });

  // [Implements: US-SC-008] Text with leading whitespace
  it('handles text with leading whitespace when truncating', () => {
    const text = '   leading space content here and more words';
    const result = truncate(text, 15);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('…[truncated]');
    // The cut lands at the whitespace before "space" (index 10), preserving
    // the leading whitespace and "leading"
    expect(result.text.startsWith('   leading')).toBe(true);
  });

  // [Implements: US-SC-008] Very large maxChars with small text
  it('handles very large maxChars with small text', () => {
    const result = truncate('small', 999999999);
    expect(result.text).toBe('small');
    expect(result.truncated).toBe(false);
  });

  // [Implements: US-SC-008] Text shorter by exactly 1
  it('does not truncate when text is exactly maxChars+0', () => {
    const text = 'abcdef';
    const result = truncate(text, 6);
    expect(result.text).toBe(text);
    expect(result.truncated).toBe(false);
  });

  // [Implements: US-SC-008] Text longer by exactly 1 — truncates
  it('truncates when text exceeds maxChars by exactly 1', () => {
    const text = 'abcdefg';
    const result = truncate(text, 6);
    expect(result.truncated).toBe(true);
  });

  // [Implements: US-SC-008] Multiple spaces between words are trimmed
  it('trims multiple trailing spaces before marker', () => {
    const text = 'word     nextword';
    // maxChars=6, text[6]=' ' → found at index 6
    const result = truncate(text, 6);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('word…[truncated]');
  });

  // [Implements: US-SC-008] Unicode content
  it('handles unicode text correctly', () => {
    const text = 'café naïve résumé München Über';
    const result = truncate(text, 15);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('café naïve')).toBe(true);
    expect(result.text.endsWith('…[truncated]')).toBe(true);
  });

  // [Implements: US-SC-008] CJK characters
  it('handles CJK text with no spaces', () => {
    const text = '这是一段中文文本没有空格所以会被硬截断';
    const result = truncate(text, 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('…[truncated]');
  });

  // [Implements: DC-SC-005] Disabled mode with empty text
  it('handles empty text with disabled truncation (maxChars=0)', () => {
    const result = truncate('', 0);
    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
  });

  // [Implements: DC-SC-006] Large realistic content
  it('truncates large realistic content at word boundary', () => {
    const paragraphs = Array.from(
      { length: 100 },
      (_, i) => `This is paragraph number ${i} with some content.`
    );
    const text = paragraphs.join('\n\n');
    const result = truncate(text, 500);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(text.length);
    expect(result.text.endsWith('…[truncated]')).toBe(true);
  });

  // [Implements: DC-SC-006] Disabled mode includes maxChars value in warning
  it('includes the maxChars value in the disabled warning message', () => {
    truncate('text', -42);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('-42')
    );
  });
});
