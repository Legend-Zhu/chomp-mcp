/**
 * Tests for the paragraph segmenter — paragraph splitting at newline and
 * HTML-tag boundaries, minChars filtering, and empty/whitespace input handling.
 *
 * [Spec: US-DD-004]
 */

import { describe, it, expect } from 'vitest';
import { segmentParagraphs } from '../../../src/modules/deduplicate/paragraph-segmenter.js';

describe('segmentParagraphs — newline splitting', () => {
  // [Implements: US-DD-004] Two or more consecutive newlines act as paragraph boundaries
  it('splits text at double-newline boundaries into separate segments', () => {
    const text = 'First paragraph is long enough.\n\nSecond paragraph is also long.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('First paragraph is long enough.');
    expect(result[1]).toBe('Second paragraph is also long.');
  });

  it('splits at triple-newline boundaries', () => {
    const text = 'First paragraph is long enough.\n\n\nSecond paragraph is also long.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('First paragraph is long enough.');
    expect(result[1]).toBe('Second paragraph is also long.');
  });

  it('splits at boundaries with many consecutive newlines', () => {
    const text = 'First paragraph is long enough.\n\n\n\n\n\nSecond paragraph is also long.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
  });

  it('handles a single paragraph with no double-newlines as one segment', () => {
    const text = 'This is a single paragraph that is definitely long enough to pass.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  it('handles multiple paragraphs separated by double newlines', () => {
    const parts = [
      'First paragraph with enough text.',
      'Second paragraph with enough text.',
      'Third paragraph with enough text.',
    ];
    const text = parts.join('\n\n');
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(3);
    expect(result).toEqual(parts);
  });

  // [Implements: US-DD-004] Single newlines do NOT split paragraphs
  it('does NOT split on a single newline (only 2+ consecutive newlines)', () => {
    const text = 'Line one with enough text.\nLine two with enough text here.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    // Internal whitespace is collapsed — the single \n becomes a space
    expect(result[0]).toBe('Line one with enough text. Line two with enough text here.');
  });
});

describe('segmentParagraphs — HTML tag boundaries', () => {
  // [Implements: US-DD-004] HTML <br> tags are treated as paragraph boundaries
  it('splits text at <br> tags followed by double newlines', () => {
    const text = 'First paragraph is long enough.<br>\n\nSecond paragraph is also long.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('First paragraph is long enough.');
    expect(result[1]).toBe('Second paragraph is also long.');
  });

  // [Implements: US-DD-004] <br> tag alone acts as a boundary (creates \n which may not split alone)
  it('replaces <br> with newline', () => {
    const text = 'First paragraph is long enough.<br>Second paragraph is also long.';
    const result = segmentParagraphs(text);
    // <br> is replaced with \n, but single \n does not split — so it's one segment
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('First paragraph is long enough. Second paragraph is also long.');
  });

  // [Implements: US-DD-004] <br/> tag acts as boundary
  it('replaces <br/> with newline', () => {
    const text = 'First paragraph is long enough.<br/>Second paragraph is also long.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('First paragraph is long enough. Second paragraph is also long.');
  });

  // [Implements: US-DD-004] <br /> tag (with space) acts as boundary
  it('replaces <br /> with newline', () => {
    const text = 'First paragraph is long enough.<br />Second paragraph is also long.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('First paragraph is long enough. Second paragraph is also long.');
  });

  // [Implements: US-DD-004] </p> tag acts as boundary (combined with double newline)
  it('splits at </p> tags', () => {
    const text = '<p>First paragraph is long enough.</p>\n\n<p>Second paragraph is also long.</p>';
    const result = segmentParagraphs(text);
    // <p> tags remain (only closing tags and br are replaced), but content is extracted
    // The </p> is replaced with \n, and \n\n from the original creates the boundary
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('First paragraph is long enough.');
    expect(result[1]).toContain('Second paragraph is also long.');
  });

  // [Implements: US-DD-004] </p> closing tag replaced by newline, combined with extra newline
  it('treats </p> followed by newline as paragraph boundary', () => {
    const text = 'First paragraph is long enough.</p>\nSecond paragraph is also long here.';
    const result = segmentParagraphs(text);
    // </p> → \n, then \n from original → \n\n → splits
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('First paragraph is long enough.');
    expect(result[1]).toBe('Second paragraph is also long here.');
  });

  // [Implements: US-DD-004] </div> tag acts as boundary
  it('treats </div> followed by newline as paragraph boundary', () => {
    const text = 'First paragraph is long enough.</div>\nSecond paragraph is also long here.';
    const result = segmentParagraphs(text);
    // </div> → \n, then \n from original → \n\n → splits
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('First paragraph is long enough.');
    expect(result[1]).toBe('Second paragraph is also long here.');
  });

  // [Implements: US-DD-004] HTML tags are case-insensitive
  it('handles case-insensitive <BR> tags', () => {
    const text = 'First paragraph is long enough.<BR>\nSecond paragraph is also long here.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
  });

  it('handles case-insensitive </P> tags', () => {
    const text = 'First paragraph is long enough.</P>\nSecond paragraph is also long here.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
  });

  it('handles case-insensitive </DIV> tags', () => {
    const text = 'First paragraph is long enough.</DIV>\nSecond paragraph is also long here.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
  });

  // [Implements: US-DD-004] Multiple HTML tags create multiple boundaries
  it('handles multiple <br> tags with newlines creating separate paragraphs', () => {
    const text = 'First paragraph is long enough.<br>\n\nSecond paragraph is also long.<br>\n\nThird paragraph is long too.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(3);
  });

  // [Implements: US-DD-004] <br> with extra whitespace inside tag
  it('handles <br  /> with multiple spaces', () => {
    const text = 'First paragraph is long enough.<br  />Second paragraph is also long.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('First paragraph is long enough. Second paragraph is also long.');
  });
});

describe('segmentParagraphs — minChars filtering', () => {
  // [Implements: US-DD-004] Segments below minChars (default 20) are discarded
  it('discards segments shorter than default minChars (20)', () => {
    const text = 'Short.\n\nThis is a long enough paragraph to pass the threshold.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('This is a long enough paragraph to pass the threshold.');
  });

  // [Implements: US-DD-004] All segments below threshold are removed
  it('discards all segments when all are below minChars', () => {
    const text = 'Short one.\n\nShort two.\n\nShort three.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(0);
  });

  // [Implements: US-DD-004] Custom minChars value
  it('uses custom minChars value to filter segments', () => {
    const text = 'ABC.\n\nThis is a longer paragraph that exceeds the custom threshold.';
    const result = segmentParagraphs(text, 10);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('This is a longer paragraph that exceeds the custom threshold.');
  });

  // [Implements: US-DD-004] Very low minChars (1) retains almost everything
  it('retains all non-empty segments when minChars is 1', () => {
    const text = 'A\n\nB\n\nC';
    const result = segmentParagraphs(text, 1);
    expect(result).toEqual(['A', 'B', 'C']);
  });

  // [Implements: US-DD-004] Segment exactly at minChars boundary is retained
  it('retains segment with length exactly equal to minChars', () => {
    const exact = 'a'.repeat(20); // exactly 20 chars
    const text = `${exact}\n\nshort`;
    const result = segmentParagraphs(text, 20);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(exact);
  });

  // [Implements: US-DD-004] Segment one char below minChars is discarded
  it('discards segment one char below minChars', () => {
    const justBelow = 'a'.repeat(19); // 19 chars, below default 20
    const text = `${justBelow}\n\nThis is a long enough paragraph to pass the threshold.`;
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('This is a long enough paragraph to pass the threshold.');
  });

  // [Implements: US-DD-004] Invalid minChars (0, negative, NaN) falls back to default
  it('falls back to default minChars when minChars is 0', () => {
    const text = 'Short.\n\nThis is a long enough paragraph to pass the threshold.';
    const result = segmentParagraphs(text, 0);
    // minChars=0 is invalid (< 1), falls back to default 20
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('This is a long enough paragraph to pass the threshold.');
  });

  it('falls back to default minChars when minChars is negative', () => {
    const text = 'Short.\n\nThis is a long enough paragraph to pass the threshold.';
    const result = segmentParagraphs(text, -5);
    expect(result).toHaveLength(1);
  });

  it('falls back to default minChars when minChars is NaN', () => {
    const text = 'Short.\n\nThis is a long enough paragraph to pass the threshold.';
    const result = segmentParagraphs(text, NaN);
    expect(result).toHaveLength(1);
  });

  // [Implements: US-DD-004] High minChars filters everything
  it('filters all segments when minChars is very high', () => {
    const text = 'First paragraph is long enough.\n\nSecond paragraph is also long.';
    const result = segmentParagraphs(text, 1000);
    expect(result).toHaveLength(0);
  });

  // [Implements: US-DD-004] minChars filtering after whitespace collapse
  it('filters based on collapsed length, not raw length', () => {
    // Raw segment has lots of spaces making it look long, but after collapse it's short
    const text = 'a    b    c    d\n\nThis is a long enough paragraph to pass the threshold.';
    const result = segmentParagraphs(text, 20);
    // 'a b c d' is only 7 chars after collapse → discarded
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('This is a long enough paragraph to pass the threshold.');
  });
});

describe('segmentParagraphs — empty and whitespace input', () => {
  // [Implements: US-DD-004] Empty string produces zero segments
  it('returns empty array for empty string', () => {
    const result = segmentParagraphs('');
    expect(result).toEqual([]);
  });

  // [Implements: US-DD-004] Whitespace-only string produces zero segments
  it('returns empty array for whitespace-only string', () => {
    const result = segmentParagraphs('   ');
    expect(result).toEqual([]);
  });

  it('returns empty array for tab-only string', () => {
    const result = segmentParagraphs('\t\t\t');
    expect(result).toEqual([]);
  });

  it('returns empty array for newline-only string', () => {
    const result = segmentParagraphs('\n\n\n');
    expect(result).toEqual([]);
  });

  it('returns empty array for mixed whitespace string', () => {
    const result = segmentParagraphs(' \t\n\r \n\t ');
    expect(result).toEqual([]);
  });

  // [Implements: US-DD-004] Empty/whitespace input with custom minChars
  it('returns empty array for empty string with custom minChars', () => {
    const result = segmentParagraphs('', 1);
    expect(result).toEqual([]);
  });

  it('returns empty array for whitespace-only string with custom minChars', () => {
    const result = segmentParagraphs('   ', 1);
    expect(result).toEqual([]);
  });
});

describe('segmentParagraphs — whitespace collapsing', () => {
  // [Implements: US-DD-004] Internal whitespace is collapsed to single spaces
  it('collapses multiple spaces within a segment to single space', () => {
    const text = 'This    has    extra    spaces    but    is    long    enough.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('This has extra spaces but is long enough.');
  });

  // [Implements: US-DD-004] Internal tabs are collapsed
  it('collapses tabs within a segment', () => {
    const text = 'Column1\t\tColumn2\t\tColumn3\t\tthat\t\tis\t\tlong\t\tenough.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Column1 Column2 Column3 that is long enough.');
  });

  // [Implements: US-DD-004] Leading/trailing whitespace is trimmed
  it('trims leading whitespace from segments', () => {
    const text = '   Leading whitespace paragraph is long enough here.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Leading whitespace paragraph is long enough here.');
  });

  it('trims trailing whitespace from segments', () => {
    const text = 'Trailing whitespace paragraph is long enough here.   ';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Trailing whitespace paragraph is long enough here.');
  });

  // [Implements: US-DD-004] Mixed whitespace collapsed
  it('collapses mixed whitespace (spaces, tabs, newlines) within segment', () => {
    const text = 'Word1 \t \n Word2 \t \n Word3 that is long enough to pass.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Word1 Word2 Word3 that is long enough to pass.');
  });
});

describe('segmentParagraphs — cross-platform line endings', () => {
  // [Implements: US-DD-004] Windows-style \r\n line endings
  it('handles \\r\\n line endings normalized to \\n', () => {
    const text = 'First paragraph is long enough.\r\n\r\nSecond paragraph is also long.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('First paragraph is long enough.');
    expect(result[1]).toBe('Second paragraph is also long.');
  });

  // [Implements: US-DD-004] Old Mac-style \r line endings
  it('handles \\r line endings normalized to \\n', () => {
    const text = 'First paragraph is long enough.\r\rSecond paragraph is also long.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
  });

  // [Implements: US-DD-004] Mixed line ending styles
  it('handles mixed \\r\\n and \\n line endings', () => {
    const text = 'First paragraph is long enough.\r\n\r\nSecond paragraph.\n\nThird paragraph is long enough too.';
    const result = segmentParagraphs(text);
    // 'Second paragraph.' is only 17 chars — below default threshold 20
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('First paragraph is long enough.');
    expect(result[1]).toBe('Third paragraph is long enough too.');
  });
});

describe('segmentParagraphs — mixed HTML and newline boundaries', () => {
  // [Implements: US-DD-004] Combination of HTML tags and newlines
  it('splits on a mix of <br> tags and double newlines', () => {
    const text = 'First paragraph is long enough.<br>\n\nSecond paragraph is also long.\n\nThird paragraph is long too.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(3);
  });

  // [Implements: US-DD-004] HTML closing tags followed by newlines
  it('splits on </p> tags followed by newlines', () => {
    const text = 'First paragraph is long enough.</p>\n\nSecond paragraph is also long.</p>';
    const result = segmentParagraphs(text);
    // </p> replaced by \n → 'enough.\n\n\nSecond...' → splits on \n{2,}
    expect(result).toHaveLength(2);
  });

  // [Implements: US-DD-004] Multiple different HTML boundary tags
  it('handles mix of <br>, </p>, and </div> tags', () => {
    const text = 'First paragraph is long enough.<br>\n\nSecond paragraph is also long.</p>\n\nThird paragraph is long enough too.</div>';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(3);
  });
});

describe('segmentParagraphs — edge cases', () => {
  // [Implements: US-DD-004] Text that is all one segment after filtering
  it('returns a single segment when text has no boundaries', () => {
    const text = 'Thisisaverylongsinglewordwithoutanyboundariesatallwhatsoeverhere.';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  // [Implements: US-DD-004] Many short segments all filtered out
  it('returns empty array when all segments are too short', () => {
    const text = 'ab\n\ncd\n\nef\n\ngh';
    const result = segmentParagraphs(text);
    expect(result).toEqual([]);
  });

  // [Implements: US-DD-004] Alternating long and short segments
  it('keeps only long segments from alternating long/short input', () => {
    const text = [
      'Short.',
      'This is a long enough paragraph to pass.',
      'Tiny.',
      'Another long enough paragraph to keep here.',
    ].join('\n\n');
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('This is a long enough paragraph to pass.');
    expect(result[1]).toBe('Another long enough paragraph to keep here.');
  });

  // [Implements: US-DD-004] Unicode text segments
  it('handles unicode/CJK text segments correctly', () => {
    const text = '这是第一段足够长的中文段落内容这里需要超过二十个字。\n\n这是第二段同样足够长的中文内容也需要超过二十个字。';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
  });

  // [Implements: US-DD-004] Large realistic multi-paragraph content
  it('segments large realistic content correctly', () => {
    const paragraphs = Array.from(
      { length: 20 },
      (_, i) => `This is paragraph number ${i} with enough text content to pass the minimum threshold.`
    );
    const text = paragraphs.join('\n\n');
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(20);
  });

  // [Implements: US-DD-004] Leading/trailing newlines around content
  it('handles leading and trailing newlines', () => {
    const text = '\n\n\nFirst paragraph is long enough.\n\n\nSecond paragraph is also long.\n\n\n';
    const result = segmentParagraphs(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('First paragraph is long enough.');
    expect(result[1]).toBe('Second paragraph is also long.');
  });

  // [Implements: US-DD-004] Text with only HTML tags and whitespace
  it('handles text that is mostly HTML tags with some content', () => {
    const text = '<p>First paragraph is long enough here.</p><p>Second paragraph is also long.</p>';
    const result = segmentParagraphs(text);
    // Each </p> is replaced with \n, but there's only single \n between them
    // So both become one segment with internal whitespace collapsed
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('First paragraph is long enough here.');
    expect(result[0]).toContain('Second paragraph is also long.');
  });

  // [Implements: US-DD-004] Segment that becomes empty after trimming
  it('discards segments that are only whitespace between boundaries', () => {
    const text = 'First paragraph is long enough.\n\n   \n\nSecond paragraph is also long.';
    const result = segmentParagraphs(text);
    // The whitespace-only segment '   ' collapses to '' (0 chars) → discarded
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('First paragraph is long enough.');
    expect(result[1]).toBe('Second paragraph is also long.');
  });
});
