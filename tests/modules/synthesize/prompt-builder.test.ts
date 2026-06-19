/**
 * Unit tests for the prompt-builder module.
 *
 * Tests buildSystemPrompt, buildUserPrompt, buildSingleSourcePrompt, and
 * buildMergePrompt for correct structure, content, focus directives, and
 * anti-hallucination instructions.
 *
 * [Spec: US-SY-002, US-SY-004]
 */

import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildSingleSourcePrompt,
  buildMergePrompt,
} from '../../../src/modules/synthesize/prompt-builder.js';
import type { PromptPair } from '../../../src/modules/synthesize/prompt-builder.js';
import type { ContentItem } from '../../../src/shared/types/content.js';
import type { DigestResult, SourceRef } from '../../../src/shared/types/digest.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeContentItem(
  overrides: Partial<ContentItem> = {}
): ContentItem {
  return {
    title: overrides.title ?? 'Test Title',
    url: overrides.url ?? 'https://example.com/page',
    snippet: overrides.snippet ?? 'A snippet.',
    score: overrides.score ?? 0.5,
    content: overrides.content ?? 'Some content here for testing.',
  };
}

function makeSourceRef(
  overrides: Partial<SourceRef> = {}
): SourceRef {
  return {
    url: overrides.url ?? 'https://example.com',
    title: overrides.title ?? 'Example Title',
  };
}

function makeDigestResult(
  overrides: Partial<DigestResult> = {}
): DigestResult {
  return {
    answer: overrides.answer ?? 'This is a synthesized answer.',
    keyPoints: overrides.keyPoints ?? ['Point one', 'Point two'],
    sources: overrides.sources ?? [makeSourceRef()],
  };
}

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe('buildSystemPrompt', () => {
  // [Implements: US-SY-002]
  it('includes "## Answer" section instruction', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('## Answer');
  });

  it('includes "## Key Points" section instruction', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('## Key Points');
  });

  it('includes "## Sources" section instruction', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('## Sources');
  });

  it('instructs the LLM to produce a direct answer', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('direct');
    expect(prompt.toLowerCase()).toContain('concise');
  });

  it('instructs the LLM to be factual', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('factual');
  });

  it('instructs the LLM to list key points as bullet items', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('bullet');
  });

  it('instructs the LLM to cite source URLs', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('source');
    expect(prompt.toLowerCase()).toContain('url');
  });

  // [Implements: US-SY-002] Anti-hallucination instruction
  it('includes anti-hallucination instruction (NEVER hallucinate URLs)', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/never.*hallucinate/i);
    expect(prompt).toMatch(/fabricate.*url/i);
  });

  it('instructs only to cite URLs present in the provided content', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/only.*cite.*url/i);
    expect(prompt).toMatch(/provided.*content/i);
  });

  it('returns a non-empty string', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('returns the same content on every call (deterministic)', () => {
    const a = buildSystemPrompt();
    const b = buildSystemPrompt();
    expect(a).toBe(b);
  });

  it('identifies itself as a research assistant', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('research assistant');
  });

  it('instructs to de-duplicate overlapping points', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('de-duplicate');
  });
});

// ---------------------------------------------------------------------------
// buildUserPrompt
// ---------------------------------------------------------------------------

describe('buildUserPrompt', () => {
  // [Implements: US-SY-002] Query appears in output
  it('includes the query in the output', () => {
    const prompt = buildUserPrompt(
      'What is TypeScript?',
      [makeContentItem()]
    );
    expect(prompt).toContain('What is TypeScript?');
    expect(prompt).toContain('Query:');
  });

  // [Implements: US-SY-002] Each content block is interleaved with URL and title
  it('includes each content item URL in the output', () => {
    const items = [
      makeContentItem({ url: 'https://a.com/page', title: 'Page A', content: 'Content A' }),
      makeContentItem({ url: 'https://b.com/page', title: 'Page B', content: 'Content B' }),
    ];
    const prompt = buildUserPrompt('test query', items);
    expect(prompt).toContain('https://a.com/page');
    expect(prompt).toContain('https://b.com/page');
  });

  it('includes each content item title in the output', () => {
    const items = [
      makeContentItem({ url: 'https://a.com', title: 'Alpha Title' }),
      makeContentItem({ url: 'https://b.com', title: 'Beta Title' }),
    ];
    const prompt = buildUserPrompt('test query', items);
    expect(prompt).toContain('Alpha Title');
    expect(prompt).toContain('Beta Title');
  });

  it('includes each content item text in the output', () => {
    const items = [
      makeContentItem({ url: 'https://a.com', content: 'Alpha content text here.' }),
      makeContentItem({ url: 'https://b.com', content: 'Beta content text here.' }),
    ];
    const prompt = buildUserPrompt('test query', items);
    expect(prompt).toContain('Alpha content text here.');
    expect(prompt).toContain('Beta content text here.');
  });

  it('separates content blocks with source markers', () => {
    const prompt = buildUserPrompt('query', [
      makeContentItem({ url: 'https://a.com' }),
    ]);
    expect(prompt).toContain('Source:');
    expect(prompt).toContain('Title:');
    expect(prompt).toContain('Content:');
  });

  // [Implements: US-SY-002] Focus directive appears when provided
  it('includes focus directive when focus is provided', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()], 'installation steps');
    expect(prompt).toContain('Please focus on:');
    expect(prompt).toContain('installation steps');
  });

  it('includes focus directive for API usage focus', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()], 'API usage');
    expect(prompt).toContain('API usage');
  });

  it('includes focus directive for version compatibility focus', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()], 'version compatibility');
    expect(prompt).toContain('version compatibility');
  });

  it('does NOT include focus directive when focus is undefined', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()]);
    expect(prompt).not.toContain('Please focus on:');
  });

  it('does NOT include focus directive when focus is empty string', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()], '');
    expect(prompt).not.toContain('Please focus on:');
  });

  it('does NOT include focus directive when focus is whitespace-only', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()], '   ');
    expect(prompt).not.toContain('Please focus on:');
  });

  it('trims whitespace from focus before including', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()], '  installation  ');
    expect(prompt).toContain('installation');
    expect(prompt).not.toContain('installation  ');
  });

  // [Implements: US-SY-002] Anti-hallucination instruction
  it('includes anti-hallucination instruction', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()]);
    expect(prompt).toContain('IMPORTANT:');
    expect(prompt).toMatch(/do not.*invent.*url/i);
  });

  it('includes anti-hallucination instruction even without focus', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()]);
    expect(prompt).toMatch(/hallucinate/i);
  });

  // Edge cases
  it('handles a single content item', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()]);
    expect(prompt).toContain('Query:');
    expect(prompt).toContain('Source:');
  });

  it('handles empty content array', () => {
    const prompt = buildUserPrompt('query', []);
    expect(prompt).toContain('Query:');
    // Should still have the anti-hallucination instruction
    expect(prompt).toContain('IMPORTANT:');
  });

  it('handles content items with empty content strings', () => {
    const prompt = buildUserPrompt('query', [
      makeContentItem({ content: '' }),
    ]);
    expect(prompt).toContain('Source:');
    expect(prompt).toContain('Title:');
  });

  it('handles content items with special characters in content', () => {
    const prompt = buildUserPrompt('query', [
      makeContentItem({ content: 'Content with <html> & special chars!' }),
    ]);
    expect(prompt).toContain('Content with <html> & special chars!');
  });

  it('preserves multi-line content', () => {
    const content = 'Line one.\nLine two.\nLine three.';
    const prompt = buildUserPrompt('query', [
      makeContentItem({ content }),
    ]);
    expect(prompt).toContain('Line one.');
    expect(prompt).toContain('Line two.');
    expect(prompt).toContain('Line three.');
  });

  it('returns a non-empty string', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()]);
    expect(prompt.length).toBeGreaterThan(10);
  });

  it('is deterministic — same input produces same output', () => {
    const items = [makeContentItem({ url: 'https://a.com', title: 'A', content: 'C' })];
    const a = buildUserPrompt('query', items, 'focus');
    const b = buildUserPrompt('query', items, 'focus');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// buildSingleSourcePrompt
// ---------------------------------------------------------------------------

describe('buildSingleSourcePrompt', () => {
  // [Implements: US-SY-004] Returns PromptPair
  it('returns an object with systemPrompt and userPrompt', () => {
    const result = buildSingleSourcePrompt(
      'query',
      'https://example.com',
      'Title',
      'Content'
    );
    expect(result).toHaveProperty('systemPrompt');
    expect(result).toHaveProperty('userPrompt');
    expect(typeof result.systemPrompt).toBe('string');
    expect(typeof result.userPrompt).toBe('string');
  });

  it('systemPrompt includes Answer, Key Points, and Sources sections', () => {
    const result = buildSingleSourcePrompt('query', 'https://example.com', 'Title', 'Content');
    expect(result.systemPrompt).toContain('## Answer');
    expect(result.systemPrompt).toContain('## Key Points');
    expect(result.systemPrompt).toContain('## Sources');
  });

  // [Implements: US-SY-004] URL appears in userPrompt
  it('includes the source URL in the userPrompt', () => {
    const result = buildSingleSourcePrompt(
      'query',
      'https://example.com/article',
      'Title',
      'Content'
    );
    expect(result.userPrompt).toContain('https://example.com/article');
  });

  // [Implements: US-SY-004] Title appears in userPrompt
  it('includes the source title in the userPrompt', () => {
    const result = buildSingleSourcePrompt(
      'query',
      'https://example.com',
      'Article Title Here',
      'Content'
    );
    expect(result.userPrompt).toContain('Article Title Here');
  });

  // [Implements: US-SY-004] Content appears in userPrompt
  it('includes the content in the userPrompt', () => {
    const result = buildSingleSourcePrompt(
      'query',
      'https://example.com',
      'Title',
      'The main content of the article goes here.'
    );
    expect(result.userPrompt).toContain('The main content of the article goes here.');
  });

  it('includes the query in the userPrompt', () => {
    const result = buildSingleSourcePrompt(
      'What is React?',
      'https://example.com',
      'Title',
      'Content'
    );
    expect(result.userPrompt).toContain('What is React?');
  });

  // [Implements: US-SY-004] Focus directive
  it('includes focus directive when focus is provided', () => {
    const result = buildSingleSourcePrompt(
      'query',
      'https://example.com',
      'Title',
      'Content',
      'API usage'
    );
    expect(result.userPrompt).toContain('API usage');
    expect(result.userPrompt).toContain('prioritize');
  });

  it('does NOT include focus directive when focus is undefined', () => {
    const result = buildSingleSourcePrompt(
      'query',
      'https://example.com',
      'Title',
      'Content'
    );
    expect(result.userPrompt).not.toContain('prioritize');
  });

  it('does NOT include focus directive when focus is empty', () => {
    const result = buildSingleSourcePrompt(
      'query',
      'https://example.com',
      'Title',
      'Content',
      ''
    );
    expect(result.userPrompt).not.toContain('prioritize');
  });

  it('does NOT include focus directive when focus is whitespace-only', () => {
    const result = buildSingleSourcePrompt(
      'query',
      'https://example.com',
      'Title',
      'Content',
      '   '
    );
    expect(result.userPrompt).not.toContain('prioritize');
  });

  // [Implements: US-SY-004] Anti-hallucination instruction
  it('includes anti-hallucination instruction referencing the source URL', () => {
    const result = buildSingleSourcePrompt(
      'query',
      'https://example.com',
      'Title',
      'Content'
    );
    expect(result.userPrompt).toContain('IMPORTANT:');
    expect(result.userPrompt).toContain('https://example.com');
    expect(result.userPrompt).toMatch(/hallucinate/i);
  });

  it('includes Source and Title markers', () => {
    const result = buildSingleSourcePrompt(
      'query',
      'https://example.com',
      'Title',
      'Content'
    );
    expect(result.userPrompt).toContain('Source:');
    expect(result.userPrompt).toContain('Title:');
    expect(result.userPrompt).toContain('Content:');
  });

  it('is deterministic — same input produces same output', () => {
    const a = buildSingleSourcePrompt('q', 'url', 't', 'c', 'f');
    const b = buildSingleSourcePrompt('q', 'url', 't', 'c', 'f');
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// buildMergePrompt
// ---------------------------------------------------------------------------

describe('buildMergePrompt', () => {
  // [Implements: US-SY-002] Returns PromptPair
  it('returns an object with systemPrompt and userPrompt', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result).toHaveProperty('systemPrompt');
    expect(result).toHaveProperty('userPrompt');
    expect(typeof result.systemPrompt).toBe('string');
    expect(typeof result.userPrompt).toBe('string');
  });

  it('systemPrompt includes Answer, Key Points, and Sources sections', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.systemPrompt).toContain('## Answer');
    expect(result.systemPrompt).toContain('## Key Points');
    expect(result.systemPrompt).toContain('## Sources');
  });

  it('systemPrompt mentions merging intermediate digests', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.systemPrompt.toLowerCase()).toContain('merge');
    expect(result.systemPrompt.toLowerCase()).toContain('intermediate');
    expect(result.systemPrompt.toLowerCase()).toContain('digest');
  });

  it('systemPrompt includes anti-hallucination instruction', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.systemPrompt).toMatch(/never.*hallucinate/i);
  });

  it('systemPrompt instructs to de-duplicate key points', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.systemPrompt.toLowerCase()).toContain('de-duplicate');
  });

  // [Implements: US-SY-002] Intermediate digest data is serialized
  it('includes the query in the userPrompt', () => {
    const result = buildMergePrompt('How does X work?', [makeDigestResult()]);
    expect(result.userPrompt).toContain('How does X work?');
  });

  it('serializes each digest answer in the userPrompt', () => {
    const digests = [
      makeDigestResult({ answer: 'Answer from digest one.' }),
      makeDigestResult({ answer: 'Answer from digest two.' }),
    ];
    const result = buildMergePrompt('query', digests);
    expect(result.userPrompt).toContain('Answer from digest one.');
    expect(result.userPrompt).toContain('Answer from digest two.');
  });

  it('serializes each digest source URL in the userPrompt', () => {
    const digests = [
      makeDigestResult({
        sources: [makeSourceRef({ url: 'https://a.com', title: 'A' })],
      }),
      makeDigestResult({
        sources: [makeSourceRef({ url: 'https://b.com', title: 'B' })],
      }),
    ];
    const result = buildMergePrompt('query', digests);
    expect(result.userPrompt).toContain('https://a.com');
    expect(result.userPrompt).toContain('https://b.com');
  });

  it('serializes each digest source title in the userPrompt', () => {
    const digests = [
      makeDigestResult({
        sources: [makeSourceRef({ url: 'https://a.com', title: 'Alpha Source' })],
      }),
    ];
    const result = buildMergePrompt('query', digests);
    expect(result.userPrompt).toContain('Alpha Source');
  });

  it('labels each digest with a digest number', () => {
    const result = buildMergePrompt('query', [
      makeDigestResult(),
      makeDigestResult(),
    ]);
    expect(result.userPrompt).toContain('Digest 1');
    expect(result.userPrompt).toContain('Digest 2');
  });

  it('includes Content: label for each digest', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.userPrompt).toContain('Content:');
  });

  it('includes Sources: label for each digest', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.userPrompt).toContain('Sources:');
  });

  // [Implements: US-SY-002] Focus directive
  it('includes focus directive when focus is provided', () => {
    const result = buildMergePrompt(
      'query',
      [makeDigestResult()],
      'performance'
    );
    expect(result.userPrompt).toContain('Please focus on:');
    expect(result.userPrompt).toContain('performance');
  });

  it('does NOT include focus directive when focus is undefined', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.userPrompt).not.toContain('Please focus on:');
  });

  it('does NOT include focus directive when focus is empty', () => {
    const result = buildMergePrompt('query', [makeDigestResult()], '');
    expect(result.userPrompt).not.toContain('Please focus on:');
  });

  it('does NOT include focus directive when focus is whitespace-only', () => {
    const result = buildMergePrompt('query', [makeDigestResult()], '  ');
    expect(result.userPrompt).not.toContain('Please focus on:');
  });

  // [Implements: US-SY-002] Anti-hallucination instruction
  it('includes anti-hallucination instruction in userPrompt', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.userPrompt).toContain('IMPORTANT:');
    expect(result.userPrompt).toMatch(/hallucinate/i);
  });

  it('handles a single digest', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.userPrompt).toContain('Digest 1');
  });

  it('handles multiple digests', () => {
    const result = buildMergePrompt('query', [
      makeDigestResult(),
      makeDigestResult(),
      makeDigestResult(),
    ]);
    expect(result.userPrompt).toContain('Digest 1');
    expect(result.userPrompt).toContain('Digest 2');
    expect(result.userPrompt).toContain('Digest 3');
  });

  it('handles digest with empty sources array', () => {
    const result = buildMergePrompt('query', [
      makeDigestResult({ sources: [] }),
    ]);
    expect(result.userPrompt).toContain('Sources:');
  });

  it('handles digest with empty answer string', () => {
    const result = buildMergePrompt('query', [
      makeDigestResult({ answer: '' }),
    ]);
    expect(result.userPrompt).toContain('Content:');
  });

  it('is deterministic — same input produces same output', () => {
    const digests = [makeDigestResult(), makeDigestResult()];
    const a = buildMergePrompt('query', digests, 'focus');
    const b = buildMergePrompt('query', digests, 'focus');
    expect(a).toEqual(b);
  });

  it('serializes sources in "- URL (title)" format', () => {
    const result = buildMergePrompt('query', [
      makeDigestResult({
        sources: [makeSourceRef({ url: 'https://test.com', title: 'Test' })],
      }),
    ]);
    expect(result.userPrompt).toContain('- https://test.com (Test)');
  });

  it('handles multiple sources per digest', () => {
    const result = buildMergePrompt('query', [
      makeDigestResult({
        sources: [
          makeSourceRef({ url: 'https://a.com', title: 'A' }),
          makeSourceRef({ url: 'https://b.com', title: 'B' }),
          makeSourceRef({ url: 'https://c.com', title: 'C' }),
        ],
      }),
    ]);
    expect(result.userPrompt).toContain('https://a.com');
    expect(result.userPrompt).toContain('https://b.com');
    expect(result.userPrompt).toContain('https://c.com');
  });
});

// ---------------------------------------------------------------------------
// PromptPair type compliance
// ---------------------------------------------------------------------------

describe('PromptPair type compliance', () => {
  it('buildSingleSourcePrompt returns a valid PromptPair', () => {
    const result: PromptPair = buildSingleSourcePrompt(
      'query',
      'url',
      'title',
      'content'
    );
    expect(result.systemPrompt).toBeDefined();
    expect(result.userPrompt).toBeDefined();
  });

  it('buildMergePrompt returns a valid PromptPair', () => {
    const result: PromptPair = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.systemPrompt).toBeDefined();
    expect(result.userPrompt).toBeDefined();
  });

  it('systemPrompt and userPrompt are both non-empty strings', () => {
    const single = buildSingleSourcePrompt('query', 'url', 'title', 'content');
    expect(single.systemPrompt.length).toBeGreaterThan(0);
    expect(single.userPrompt.length).toBeGreaterThan(0);

    const merge = buildMergePrompt('query', [makeDigestResult()]);
    expect(merge.systemPrompt.length).toBeGreaterThan(0);
    expect(merge.userPrompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt — additional content and structure tests
// ---------------------------------------------------------------------------

describe('buildSystemPrompt — additional content tests', () => {
  it('mentions synthesizing information from sources', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('synthesize');
    expect(prompt.toLowerCase()).toContain('source material');
  });

  it('instructs to use "- " format for bullets', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"- "');
  });

  it('instructs not to add unsupported information', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/do not add.*not.*supported/i);
  });

  it('instructs to prefer higher-ranked sources on conflicts', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('higher-ranked');
    expect(prompt.toLowerCase()).toContain('conflict');
  });

  it('instructs to say so if content is insufficient', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('enough information');
    expect(prompt.toLowerCase()).toContain('say so explicitly');
  });

  it('instructs to keep URLs only in the Sources section', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/do not include url.*answer.*key points/i);
  });

  it('contains a Guidelines section', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Guidelines:');
  });

  it('includes "Format your response" instruction', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('format your response');
  });

  it('answer section instructs for a direct, concise answer', () => {
    const prompt = buildSystemPrompt();
    // The ## Answer section should contain instruction about directness
    const answerSection = prompt.split('## Answer')[1] ?? '';
    expect(answerSection.toLowerCase()).toContain('direct');
    expect(answerSection.toLowerCase()).toContain('concise');
  });
});

// ---------------------------------------------------------------------------
// buildUserPrompt — additional structure and order tests
// ---------------------------------------------------------------------------

describe('buildUserPrompt — additional structure and order tests', () => {
  it('places Query: before any Source: blocks', () => {
    const prompt = buildUserPrompt('test query', [makeContentItem()]);
    const queryPos = prompt.indexOf('Query:');
    const sourcePos = prompt.indexOf('Source:');
    expect(queryPos).toBeLessThan(sourcePos);
  });

  it('places content blocks before the anti-hallucination instruction', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()]);
    const contentPos = prompt.indexOf('Content:');
    const importantPos = prompt.indexOf('IMPORTANT:');
    expect(contentPos).toBeLessThan(importantPos);
  });

  it('places focus directive after content blocks but before anti-hallucination', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()], 'focus area');
    const contentPos = prompt.indexOf('Content:');
    const focusPos = prompt.indexOf('Please focus on:');
    const importantPos = prompt.indexOf('IMPORTANT:');
    expect(contentPos).toBeLessThan(focusPos);
    expect(focusPos).toBeLessThan(importantPos);
  });

  it('separates content blocks with "---" delimiter', () => {
    const items = [
      makeContentItem({ url: 'https://a.com' }),
      makeContentItem({ url: 'https://b.com' }),
    ];
    const prompt = buildUserPrompt('query', items);
    expect(prompt).toContain('---');
  });

  it('includes Query: label followed by the actual query text', () => {
    const prompt = buildUserPrompt('My search query', [makeContentItem()]);
    expect(prompt).toContain('Query: My search query');
  });

  it('handles a query with special characters', () => {
    const prompt = buildUserPrompt('What is C++ & why use it?', [makeContentItem()]);
    expect(prompt).toContain('What is C++ & why use it?');
  });

  it('handles a query with newlines', () => {
    const prompt = buildUserPrompt('multi\nline\nquery', [makeContentItem()]);
    expect(prompt).toContain('multi\nline\nquery');
  });

  it('handles empty query string', () => {
    const prompt = buildUserPrompt('', [makeContentItem()]);
    expect(prompt).toContain('Query:');
  });

  it('handles many content items (10+)', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeContentItem({ url: `https://item${i}.com`, title: `Item ${i}` })
    );
    const prompt = buildUserPrompt('query', items);
    for (let i = 0; i < 10; i++) {
      expect(prompt).toContain(`https://item${i}.com`);
      expect(prompt).toContain(`Item ${i}`);
    }
  });

  it('includes the anti-hallucination instruction even when focus is present', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()], 'focus');
    expect(prompt).toContain('IMPORTANT:');
    expect(prompt).toMatch(/hallucinate/i);
  });

  it('handles content with empty title', () => {
    const prompt = buildUserPrompt('query', [
      makeContentItem({ title: '', url: 'https://a.com' }),
    ]);
    expect(prompt).toContain('Source: https://a.com');
    expect(prompt).toContain('Title:');
  });

  it('handles content with empty URL', () => {
    const prompt = buildUserPrompt('query', [
      makeContentItem({ url: '' }),
    ]);
    expect(prompt).toContain('Source:');
    expect(prompt).toContain('Title:');
  });

  it('preserves URL with query parameters and fragments', () => {
    const url = 'https://example.com/path?q=test&sort=asc#section';
    const prompt = buildUserPrompt('query', [makeContentItem({ url })]);
    expect(prompt).toContain(url);
  });

  it('returns the anti-hallucination instruction as the last meaningful content', () => {
    const prompt = buildUserPrompt('query', [makeContentItem()], 'focus');
    // The anti-hallucination instruction should be the last line
    const trimmed = prompt.trim();
    expect(trimmed).toMatch(/hallucinate/i);
  });
});

// ---------------------------------------------------------------------------
// buildSingleSourcePrompt — additional tests
// ---------------------------------------------------------------------------

describe('buildSingleSourcePrompt — additional tests', () => {
  it('systemPrompt is the same as buildSystemPrompt output', () => {
    const result = buildSingleSourcePrompt('q', 'url', 't', 'c');
    expect(result.systemPrompt).toBe(buildSystemPrompt());
  });

  it('userPrompt includes "---" delimiter', () => {
    const result = buildSingleSourcePrompt('q', 'url', 't', 'c');
    expect(result.userPrompt).toContain('---');
  });

  it('focus directive uses "prioritize" language', () => {
    const result = buildSingleSourcePrompt('q', 'url', 't', 'c', 'pricing');
    expect(result.userPrompt).toContain('Please prioritize extracting information relevant to:');
    expect(result.userPrompt).toContain('pricing');
  });

  it('focus directive is trimmed before inclusion', () => {
    const result = buildSingleSourcePrompt('q', 'url', 't', 'c', '  pricing  ');
    expect(result.userPrompt).toContain('pricing');
    expect(result.userPrompt).not.toContain('pricing  ');
  });

  it('anti-hallucination references the specific source URL', () => {
    const result = buildSingleSourcePrompt(
      'q',
      'https://unique-source.com/article',
      't',
      'c'
    );
    expect(result.userPrompt).toContain('https://unique-source.com/article');
    expect(result.userPrompt).toMatch(/only cite the source url/i);
  });

  it('places Query: before Source: in userPrompt', () => {
    const result = buildSingleSourcePrompt('my query', 'https://a.com', 't', 'c');
    const queryPos = result.userPrompt.indexOf('Query:');
    const sourcePos = result.userPrompt.indexOf('Source:');
    expect(queryPos).toBeLessThan(sourcePos);
  });

  it('handles empty content string', () => {
    const result = buildSingleSourcePrompt('q', 'url', 't', '');
    expect(result.userPrompt).toContain('Content:');
  });

  it('handles empty title string', () => {
    const result = buildSingleSourcePrompt('q', 'url', '', 'content');
    expect(result.userPrompt).toContain('Title:');
  });

  it('preserves multi-line content in userPrompt', () => {
    const content = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const result = buildSingleSourcePrompt('q', 'url', 't', content);
    expect(result.userPrompt).toContain('Paragraph one.');
    expect(result.userPrompt).toContain('Paragraph two.');
    expect(result.userPrompt).toContain('Paragraph three.');
  });

  it('handles content with special characters and HTML', () => {
    const content = '<div>Hello & goodbye</div>';
    const result = buildSingleSourcePrompt('q', 'url', 't', content);
    expect(result.userPrompt).toContain('<div>Hello & goodbye</div>');
  });
});

// ---------------------------------------------------------------------------
// buildMergePrompt — additional tests
// ---------------------------------------------------------------------------

describe('buildMergePrompt — additional tests', () => {
  it('systemPrompt instructs to merge and de-duplicate key points from different digests', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.systemPrompt.toLowerCase()).toContain('merge');
    expect(result.systemPrompt.toLowerCase()).toContain('de-duplicate');
  });

  it('systemPrompt instructs to merge source lists into a single de-duplicated list', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.systemPrompt.toLowerCase()).toContain('source list');
  });

  it('userPrompt places Query: before Digest blocks', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    const queryPos = result.userPrompt.indexOf('Query:');
    const digestPos = result.userPrompt.indexOf('Digest 1');
    expect(queryPos).toBeLessThan(digestPos);
  });

  it('userPrompt places digest blocks before anti-hallucination instruction', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    const digestPos = result.userPrompt.indexOf('Digest 1');
    const importantPos = result.userPrompt.indexOf('IMPORTANT:');
    expect(digestPos).toBeLessThan(importantPos);
  });

  it('userPrompt places focus directive between digests and anti-hallucination', () => {
    const result = buildMergePrompt('query', [makeDigestResult()], 'cost');
    const digestPos = result.userPrompt.indexOf('Digest 1');
    const focusPos = result.userPrompt.indexOf('Please focus on:');
    const importantPos = result.userPrompt.indexOf('IMPORTANT:');
    expect(digestPos).toBeLessThan(focusPos);
    expect(focusPos).toBeLessThan(importantPos);
  });

  it('serializes digest keyPoints as part of the answer content', () => {
    const digest = makeDigestResult({
      answer: 'Main answer text.',
      keyPoints: ['First point', 'Second point'],
    });
    const result = buildMergePrompt('query', [digest]);
    expect(result.userPrompt).toContain('Main answer text.');
  });

  it('serializes digest with multiple sources correctly', () => {
    const result = buildMergePrompt('query', [
      makeDigestResult({
        sources: [
          makeSourceRef({ url: 'https://a.com', title: 'Title A' }),
          makeSourceRef({ url: 'https://b.com', title: 'Title B' }),
        ],
      }),
    ]);
    expect(result.userPrompt).toContain('- https://a.com (Title A)');
    expect(result.userPrompt).toContain('- https://b.com (Title B)');
  });

  it('handles 10 digests', () => {
    const digests = Array.from({ length: 10 }, (_, i) =>
      makeDigestResult({ answer: `Digest answer ${i + 1}.` })
    );
    const result = buildMergePrompt('query', digests);
    expect(result.userPrompt).toContain('Digest 10');
    expect(result.userPrompt).toContain('Digest answer 10.');
  });

  it('handles digest with very long answer', () => {
    const longAnswer = 'A'.repeat(5000);
    const result = buildMergePrompt('query', [
      makeDigestResult({ answer: longAnswer }),
    ]);
    expect(result.userPrompt).toContain(longAnswer);
  });

  it('handles digest with empty keyPoints array', () => {
    const result = buildMergePrompt('query', [
      makeDigestResult({ keyPoints: [] }),
    ]);
    expect(result.userPrompt).toContain('Content:');
  });

  it('focus directive is trimmed before inclusion', () => {
    const result = buildMergePrompt('query', [makeDigestResult()], '  cost  ');
    expect(result.userPrompt).toContain('cost');
    expect(result.userPrompt).not.toContain('cost  ');
  });

  it('anti-hallucination mentions intermediate digests', () => {
    const result = buildMergePrompt('query', [makeDigestResult()]);
    expect(result.userPrompt).toMatch(/intermediate digests/i);
  });

  it('places anti-hallucination instruction as last content', () => {
    const result = buildMergePrompt('query', [makeDigestResult()], 'focus');
    const trimmed = result.userPrompt.trim();
    expect(trimmed).toMatch(/hallucinate/i);
  });

  it('digest numbering is sequential starting at 1', () => {
    const digests = [makeDigestResult(), makeDigestResult(), makeDigestResult()];
    const result = buildMergePrompt('query', digests);
    expect(result.userPrompt).toContain('--- Digest 1 ---');
    expect(result.userPrompt).toContain('--- Digest 2 ---');
    expect(result.userPrompt).toContain('--- Digest 3 ---');
    expect(result.userPrompt).not.toContain('Digest 0');
  });
});

// ---------------------------------------------------------------------------
// Cross-function consistency tests
// ---------------------------------------------------------------------------

describe('cross-function consistency', () => {
  it('buildSingleSourcePrompt systemPrompt matches buildSystemPrompt', () => {
    const single = buildSingleSourcePrompt('q', 'url', 't', 'c');
    const standard = buildSystemPrompt();
    expect(single.systemPrompt).toBe(standard);
  });

  it('both single-source and merge prompts include anti-hallucination in userPrompt', () => {
    const single = buildSingleSourcePrompt('q', 'url', 't', 'c');
    const merge = buildMergePrompt('q', [makeDigestResult()]);
    expect(single.userPrompt).toMatch(/hallucinate/i);
    expect(merge.userPrompt).toMatch(/hallucinate/i);
  });

  it('both single-source and merge userPrompts start with Query:', () => {
    const single = buildSingleSourcePrompt('my query', 'url', 't', 'c');
    const merge = buildMergePrompt('my query', [makeDigestResult()]);
    expect(single.userPrompt.trim().startsWith('Query:')).toBe(true);
    expect(merge.userPrompt.trim().startsWith('Query:')).toBe(true);
  });

  it('buildUserPrompt with empty array still produces valid output', () => {
    const prompt = buildUserPrompt('query', []);
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('Query:');
    expect(prompt).toContain('IMPORTANT:');
  });

  it('buildUserPrompt anti-hallucination instruction matches across calls', () => {
    const a = buildUserPrompt('q', [makeContentItem()]);
    const b = buildUserPrompt('q', [makeContentItem()]);
    // Extract the IMPORTANT section
    const extractImportant = (s: string) => {
      const idx = s.indexOf('IMPORTANT:');
      return s.substring(idx);
    };
    expect(extractImportant(a)).toBe(extractImportant(b));
  });
});
