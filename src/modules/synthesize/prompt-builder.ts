/**
 * Prompt builder — constructs system, user, single-source, and merge prompts
 * for LLM synthesis.
 *
 * All functions are pure: they accept data and return strings or prompt
 * objects without performing any I/O or side effects.
 *
 * [Spec: US-SY-002, US-SY-004]
 */

import type { ContentItem } from '../../shared/types/content.js';
import type { DigestResult, SourceRef } from '../../shared/types/digest.js';

/**
 * A pair of system and user prompts ready for an LLM call.
 */
export interface PromptPair {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Construct the system prompt that instructs the LLM to produce a well-
 * structured synthesis with an Answer section, Key Points bullets, and a
 * Sources section — while being concise, factual, and never hallucinating URLs.
 *
 * [Implements: US-SY-002]
 */
export function buildSystemPrompt(): string {
  return [
    'You are a precise research assistant. Your task is to synthesize information from the provided source materials into a clear, structured response.',
    '',
    'Format your response using the following sections:',
    '',
    '## Answer',
    'Provide a direct, concise answer to the query. Synthesize information across sources. Do not add information that is not supported by the provided content.',
    '',
    '## Key Points',
    'List the most important findings as bullet items (using "- "). Each bullet should be a single, self-contained point. De-duplicate overlapping points from different sources.',
    '',
    '## Sources',
    'List the source URLs you referenced, one per line. Only include URLs that were provided in the source materials.',
    '',
    'Guidelines:',
    '- Be concise and factual.',
    '- Prefer information from higher-ranked sources when sources conflict.',
    '- If the provided content does not contain enough information to answer the query, say so explicitly.',
    '- NEVER hallucinate or fabricate URLs. Only cite URLs that are explicitly present in the provided content.',
    '- Do not include URLs in the Answer or Key Points sections — cite them only in the Sources section.',
  ].join('\n');
}

/**
 * Construct the user prompt by interleaving each content block with its
 * source URL and title, appending an optional focus directive, and including
 * the anti-hallucination instruction for source citations.
 *
 * [Implements: US-SY-002]
 */
export function buildUserPrompt(
  query: string,
  contents: ContentItem[],
  focus?: string
): string {
  const parts: string[] = [];

  // [Implements: US-SY-002] Start with the query
  parts.push(`Query: ${query}`);
  parts.push('');

  // [Implements: US-SY-002] Interleave each content block with its source URL and title
  for (const item of contents) {
    parts.push('---');
    parts.push(`Source: ${item.url}`);
    parts.push(`Title: ${item.title}`);
    parts.push('Content:');
    parts.push(item.content);
    parts.push('');
  }

  // [Implements: US-SY-002] Append focus directive if provided
  if (focus !== undefined && focus.trim().length > 0) {
    parts.push(`Please focus on: ${focus.trim()}`);
    parts.push('');
  }

  // [Implements: US-SY-002] Anti-hallucination instruction for source citations
  parts.push(
    'IMPORTANT: Only cite URLs that appear in the sources above. Do not invent or hallucinate any URLs.'
  );

  return parts.join('\n');
}

/**
 * Construct a prompt pair for summarizing a single page's key information.
 *
 * The system prompt reuses the standard synthesis directives. The user prompt
 * includes the single page's URL, title, content, the query context, and an
 * optional focus directive instructing the LLM to prioritize the specified
 * aspect.
 *
 * [Implements: US-SY-004]
 */
export function buildSingleSourcePrompt(
  query: string,
  url: string,
  title: string,
  content: string,
  focus?: string
): PromptPair {
  const systemPrompt = buildSystemPrompt();

  const userParts: string[] = [];

  // [Implements: US-SY-004] Query context
  userParts.push(`Query: ${query}`);
  userParts.push('');

  // [Implements: US-SY-004] Single page source information
  userParts.push('---');
  userParts.push(`Source: ${url}`);
  userParts.push(`Title: ${title}`);
  userParts.push('Content:');
  userParts.push(content);
  userParts.push('');

  // [Implements: US-SY-004] Focus directive — prioritize extracting information relevant to the focus
  if (focus !== undefined && focus.trim().length > 0) {
    userParts.push(
      `Please prioritize extracting information relevant to: ${focus.trim()}`
    );
    userParts.push('');
  }

  // [Implements: US-SY-004] Anti-hallucination instruction
  userParts.push(
    `IMPORTANT: Only cite the source URL above (${url}). Do not invent or hallucinate any URLs.`
  );

  const userPrompt = userParts.join('\n');

  return { systemPrompt, userPrompt };
}

/**
 * Construct a prompt pair for merging multiple intermediate digests into a
 * single coherent result.
 *
 * The system prompt instructs the LLM to merge intermediate digests by
 * de-duplicating key points and merging source lists. The user prompt
 * serializes each intermediate DigestResult's content and sources.
 *
 * [Implements: US-SY-002]
 */
export function buildMergePrompt(
  query: string,
  digests: DigestResult[],
  focus?: string
): PromptPair {
  const systemPrompt = [
    'You are a precise research assistant. Your task is to merge multiple intermediate synthesis digests into a single coherent, de-duplicated response.',
    '',
    'Format your response using the following sections:',
    '',
    '## Answer',
    'Provide a direct, concise answer to the query by combining the information from all intermediate digests.',
    '',
    '## Key Points',
    'List the most important findings as bullet items (using "- "). Merge and de-duplicate overlapping key points from different digests. Retain unique points.',
    '',
    '## Sources',
    'List all unique source URLs from the intermediate digests, one per line. Merge and de-duplicate the source lists.',
    '',
    'Guidelines:',
    '- Be concise and factual.',
    '- De-duplicate overlapping key points across digests.',
    '- Merge all source lists into a single de-duplicated list.',
    '- NEVER hallucinate or fabricate URLs. Only cite URLs that are present in the intermediate digests.',
    '- Do not include URLs in the Answer or Key Points sections — cite them only in the Sources section.',
  ].join('\n');

  const userParts: string[] = [];

  // [Implements: US-SY-002] Query context
  userParts.push(`Query: ${query}`);
  userParts.push('');

  // [Implements: US-SY-002] Serialize each intermediate DigestResult's content and sources
  for (let i = 0; i < digests.length; i++) {
    const digest = digests[i];
    userParts.push(`--- Digest ${i + 1} ---`);
    userParts.push('Content:');
    userParts.push(digest.answer);
    userParts.push('Sources:');

    const sourceLines = digest.sources.map(
      (src: SourceRef) => `- ${src.url} (${src.title})`
    );
    userParts.push(sourceLines.join('\n'));
    userParts.push('');
  }

  // [Implements: US-SY-002] Focus directive if provided
  if (focus !== undefined && focus.trim().length > 0) {
    userParts.push(`Please focus on: ${focus.trim()}`);
    userParts.push('');
  }

  // [Implements: US-SY-002] Anti-hallucination instruction
  userParts.push(
    'IMPORTANT: Only cite URLs that appear in the intermediate digests above. Do not invent or hallucinate any URLs.'
  );

  const userPrompt = userParts.join('\n');

  return { systemPrompt, userPrompt };
}
