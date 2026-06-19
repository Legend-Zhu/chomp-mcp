/**
 * Unit tests for MCP server tool definitions (tool-definitions.ts).
 *
 * Verifies JSON Schema structure, required fields, defaults,
 * additionalProperties: false, and TOOL_DEFINITIONS array contents.
 *
 * [Spec: US-MC-003, US-MC-004, US-MC-005, BG-MC-002, DC-MC-004]
 */

import { describe, it, expect } from 'vitest';
import {
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  TOOL_DEFINITIONS,
} from '../../../src/modules/mcp-server/tool-definitions.js';

// ---------------------------------------------------------------------------
// WEB_SEARCH_TOOL
// ---------------------------------------------------------------------------

describe('WEB_SEARCH_TOOL', () => {
  // [Implements: US-MC-003]
  it('has name "web_search"', () => {
    expect(WEB_SEARCH_TOOL.name).toBe('web_search');
  });

  // [Implements: US-MC-003]
  it('has the correct description', () => {
    expect(WEB_SEARCH_TOOL.description).toBe(
      'Perform a full web research pipeline (search \u2192 scrape \u2192 deduplicate \u2192 synthesize) and return a structured digest'
    );
  });

  it('description mentions all four pipeline stages', () => {
    const desc = WEB_SEARCH_TOOL.description.toLowerCase();
    expect(desc).toContain('search');
    expect(desc).toContain('scrape');
    expect(desc).toContain('deduplicate');
    expect(desc).toContain('synthesize');
  });

  // --- inputSchema structure ---

  // [Implements: US-MC-003, DC-MC-004]
  it('has inputSchema.type equal to "object"', () => {
    expect(WEB_SEARCH_TOOL.inputSchema.type).toBe('object');
  });

  // [Implements: US-MC-003, DC-MC-004]
  it('has inputSchema.additionalProperties set to false', () => {
    expect(WEB_SEARCH_TOOL.inputSchema.additionalProperties).toBe(false);
  });

  // [Implements: US-MC-003, DC-MC-004]
  it('has inputSchema.required containing "query"', () => {
    expect(WEB_SEARCH_TOOL.inputSchema.required).toContain('query');
  });

  it('has exactly one required field (query)', () => {
    expect(WEB_SEARCH_TOOL.inputSchema.required).toEqual(['query']);
  });

  // --- inputSchema.properties: query ---

  it('defines query as a string property', () => {
    const queryProp = WEB_SEARCH_TOOL.inputSchema.properties['query'];
    expect(queryProp).toBeDefined();
    expect((queryProp as Record<string, unknown>).type).toBe('string');
  });

  it('query property has a description', () => {
    const queryProp = WEB_SEARCH_TOOL.inputSchema.properties['query'];
    expect((queryProp as Record<string, unknown>).description).toBeDefined();
    expect(typeof (queryProp as Record<string, unknown>).description).toBe(
      'string'
    );
  });

  // --- inputSchema.properties: max_results ---

  // [Implements: US-MC-003, DC-MC-004]
  it('defines max_results as an integer property', () => {
    const maxResultsProp =
      WEB_SEARCH_TOOL.inputSchema.properties['max_results'];
    expect(maxResultsProp).toBeDefined();
    expect((maxResultsProp as Record<string, unknown>).type).toBe('integer');
  });

  // [Implements: US-MC-003, DC-MC-004]
  it('max_results has default value of 5', () => {
    const maxResultsProp =
      WEB_SEARCH_TOOL.inputSchema.properties['max_results'];
    expect((maxResultsProp as Record<string, unknown>).default).toBe(5);
  });

  it('max_results is NOT in the required array (optional)', () => {
    expect(WEB_SEARCH_TOOL.inputSchema.required).not.toContain('max_results');
  });

  it('max_results property has a description', () => {
    const maxResultsProp =
      WEB_SEARCH_TOOL.inputSchema.properties['max_results'];
    expect(
      (maxResultsProp as Record<string, unknown>).description
    ).toBeDefined();
  });

  // --- inputSchema.properties: focus ---

  it('defines focus as a string property', () => {
    const focusProp = WEB_SEARCH_TOOL.inputSchema.properties['focus'];
    expect(focusProp).toBeDefined();
    expect((focusProp as Record<string, unknown>).type).toBe('string');
  });

  it('focus is NOT in the required array (optional)', () => {
    expect(WEB_SEARCH_TOOL.inputSchema.required).not.toContain('focus');
  });

  it('focus property has a description', () => {
    const focusProp = WEB_SEARCH_TOOL.inputSchema.properties['focus'];
    expect((focusProp as Record<string, unknown>).description).toBeDefined();
  });

  // --- Properties completeness ---

  it('has exactly 3 properties: query, max_results, focus', () => {
    const keys = Object.keys(WEB_SEARCH_TOOL.inputSchema.properties);
    expect(keys).toHaveLength(3);
    expect(keys).toContain('query');
    expect(keys).toContain('max_results');
    expect(keys).toContain('focus');
  });

  // --- Overall structure validation ---

  it('has a valid ToolDefinition shape', () => {
    expect(WEB_SEARCH_TOOL).toHaveProperty('name');
    expect(WEB_SEARCH_TOOL).toHaveProperty('description');
    expect(WEB_SEARCH_TOOL).toHaveProperty('inputSchema');
    expect(typeof WEB_SEARCH_TOOL.name).toBe('string');
    expect(typeof WEB_SEARCH_TOOL.description).toBe('string');
    expect(typeof WEB_SEARCH_TOOL.inputSchema).toBe('object');
  });

  it('inputSchema is a JSON Schema draft 2020-12 object with type and properties', () => {
    const schema = WEB_SEARCH_TOOL.inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(typeof schema.properties).toBe('object');
    expect(Array.isArray(schema.required)).toBe(true);
  });

  // --- Property type correctness ---

  it('query property type is exactly "string" (not "integer" or "number")', () => {
    const queryProp = WEB_SEARCH_TOOL.inputSchema.properties['query'];
    expect((queryProp as Record<string, unknown>).type).not.toBe('integer');
    expect((queryProp as Record<string, unknown>).type).not.toBe('number');
  });

  it('max_results property type is exactly "integer" (not "string" or "number")', () => {
    const maxResultsProp =
      WEB_SEARCH_TOOL.inputSchema.properties['max_results'];
    expect((maxResultsProp as Record<string, unknown>).type).not.toBe('string');
    expect((maxResultsProp as Record<string, unknown>).type).not.toBe('number');
  });

  // --- Description content ---

  it('query property description is non-empty', () => {
    const queryProp = WEB_SEARCH_TOOL.inputSchema.properties['query'];
    expect(
      ((queryProp as Record<string, unknown>).description as string).length
    ).toBeGreaterThan(0);
  });

  it('max_results property description is non-empty', () => {
    const maxResultsProp =
      WEB_SEARCH_TOOL.inputSchema.properties['max_results'];
    expect(
      ((maxResultsProp as Record<string, unknown>).description as string)
        .length
    ).toBeGreaterThan(0);
  });

  it('focus property description is non-empty', () => {
    const focusProp = WEB_SEARCH_TOOL.inputSchema.properties['focus'];
    expect(
      ((focusProp as Record<string, unknown>).description as string).length
    ).toBeGreaterThan(0);
  });

  it('query property description mentions "search" or "query"', () => {
    const queryProp = WEB_SEARCH_TOOL.inputSchema.properties['query'];
    const desc = (
      (queryProp as Record<string, unknown>).description as string
    ).toLowerCase();
    expect(desc.includes('search') || desc.includes('query')).toBe(true);
  });

  it('max_results property description mentions "5" or "default"', () => {
    const maxResultsProp =
      WEB_SEARCH_TOOL.inputSchema.properties['max_results'];
    const desc = (
      (maxResultsProp as Record<string, unknown>).description as string
    ).toLowerCase();
    expect(desc.includes('5') || desc.includes('default')).toBe(true);
  });

  // --- No extra top-level keys ---

  it('tool object has exactly name, description, and inputSchema keys', () => {
    const keys = Object.keys(WEB_SEARCH_TOOL);
    expect(keys.sort()).toEqual(['description', 'inputSchema', 'name']);
  });

  it('inputSchema has exactly type, properties, required, additionalProperties keys', () => {
    const keys = Object.keys(WEB_SEARCH_TOOL.inputSchema).sort();
    expect(keys).toEqual([
      'additionalProperties',
      'properties',
      'required',
      'type',
    ]);
  });

  // --- Immutability / constancy ---

  it('name is a non-empty string', () => {
    expect(WEB_SEARCH_TOOL.name.length).toBeGreaterThan(0);
  });

  it('description is a non-empty string', () => {
    expect(WEB_SEARCH_TOOL.description.length).toBeGreaterThan(0);
  });

  it('required array is an array of strings', () => {
    expect(Array.isArray(WEB_SEARCH_TOOL.inputSchema.required)).toBe(true);
    for (const field of WEB_SEARCH_TOOL.inputSchema.required) {
      expect(typeof field).toBe('string');
    }
  });

  it('does not define a url property (that belongs to web_fetch)', () => {
    expect(
      WEB_SEARCH_TOOL.inputSchema.properties['url']
    ).toBeUndefined();
  });

  // --- Arrow symbol in description ---

  it('description contains arrow symbol (→) for pipeline flow', () => {
    expect(WEB_SEARCH_TOOL.description).toContain('\u2192');
  });
});

// ---------------------------------------------------------------------------
// WEB_FETCH_TOOL
// ---------------------------------------------------------------------------

describe('WEB_FETCH_TOOL', () => {
  // [Implements: US-MC-004]
  it('has name "web_fetch"', () => {
    expect(WEB_FETCH_TOOL.name).toBe('web_fetch');
  });

  // [Implements: US-MC-004]
  it('has the correct description', () => {
    expect(WEB_FETCH_TOOL.description).toBe(
      'Fetch and synthesize a specific URL into a structured digest (scrape \u2192 synthesize)'
    );
  });

  it('description mentions fetch, synthesize, and URL', () => {
    const desc = WEB_FETCH_TOOL.description.toLowerCase();
    expect(desc).toContain('fetch');
    expect(desc).toContain('synthesize');
    expect(desc).toContain('url');
  });

  // --- inputSchema structure ---

  // [Implements: US-MC-004, DC-MC-004]
  it('has inputSchema.type equal to "object"', () => {
    expect(WEB_FETCH_TOOL.inputSchema.type).toBe('object');
  });

  // [Implements: US-MC-004, DC-MC-004]
  it('has inputSchema.additionalProperties set to false', () => {
    expect(WEB_FETCH_TOOL.inputSchema.additionalProperties).toBe(false);
  });

  // [Implements: US-MC-004, DC-MC-004]
  it('has inputSchema.required containing "url"', () => {
    expect(WEB_FETCH_TOOL.inputSchema.required).toContain('url');
  });

  it('has exactly one required field (url)', () => {
    expect(WEB_FETCH_TOOL.inputSchema.required).toEqual(['url']);
  });

  // --- inputSchema.properties: url ---

  // [Implements: US-MC-004, DC-MC-004]
  it('defines url as a string property', () => {
    const urlProp = WEB_FETCH_TOOL.inputSchema.properties['url'];
    expect(urlProp).toBeDefined();
    expect((urlProp as Record<string, unknown>).type).toBe('string');
  });

  // [Implements: US-MC-004, DC-MC-004]
  it('url property has format "uri"', () => {
    const urlProp = WEB_FETCH_TOOL.inputSchema.properties['url'];
    expect((urlProp as Record<string, unknown>).format).toBe('uri');
  });

  it('url property has a description', () => {
    const urlProp = WEB_FETCH_TOOL.inputSchema.properties['url'];
    expect((urlProp as Record<string, unknown>).description).toBeDefined();
    expect(typeof (urlProp as Record<string, unknown>).description).toBe(
      'string'
    );
  });

  // --- inputSchema.properties: focus ---

  it('defines focus as a string property', () => {
    const focusProp = WEB_FETCH_TOOL.inputSchema.properties['focus'];
    expect(focusProp).toBeDefined();
    expect((focusProp as Record<string, unknown>).type).toBe('string');
  });

  it('focus is NOT in the required array (optional)', () => {
    expect(WEB_FETCH_TOOL.inputSchema.required).not.toContain('focus');
  });

  it('focus property has a description', () => {
    const focusProp = WEB_FETCH_TOOL.inputSchema.properties['focus'];
    expect((focusProp as Record<string, unknown>).description).toBeDefined();
  });

  // --- Properties completeness ---

  it('has exactly 2 properties: url and focus', () => {
    const keys = Object.keys(WEB_FETCH_TOOL.inputSchema.properties);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('url');
    expect(keys).toContain('focus');
  });

  // --- Overall structure validation ---

  it('has a valid ToolDefinition shape', () => {
    expect(WEB_FETCH_TOOL).toHaveProperty('name');
    expect(WEB_FETCH_TOOL).toHaveProperty('description');
    expect(WEB_FETCH_TOOL).toHaveProperty('inputSchema');
    expect(typeof WEB_FETCH_TOOL.name).toBe('string');
    expect(typeof WEB_FETCH_TOOL.description).toBe('string');
    expect(typeof WEB_FETCH_TOOL.inputSchema).toBe('object');
  });

  it('inputSchema is a JSON Schema draft 2020-12 object with type and properties', () => {
    const schema = WEB_FETCH_TOOL.inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(typeof schema.properties).toBe('object');
    expect(Array.isArray(schema.required)).toBe(true);
  });

  // --- Property type correctness ---

  it('url property type is exactly "string" (not "integer" or "number")', () => {
    const urlProp = WEB_FETCH_TOOL.inputSchema.properties['url'];
    expect((urlProp as Record<string, unknown>).type).not.toBe('integer');
    expect((urlProp as Record<string, unknown>).type).not.toBe('number');
  });

  // --- URL format constraint ---

  it('url property has format set to "uri" (not "url" or undefined)', () => {
    const urlProp = WEB_FETCH_TOOL.inputSchema.properties['url'];
    expect((urlProp as Record<string, unknown>).format).toBe('uri');
    expect((urlProp as Record<string, unknown>).format).not.toBe('url');
  });

  it('url property does NOT have a default value', () => {
    const urlProp = WEB_FETCH_TOOL.inputSchema.properties['url'];
    expect((urlProp as Record<string, unknown>).default).toBeUndefined();
  });

  // --- Description content ---

  it('url property description is non-empty', () => {
    const urlProp = WEB_FETCH_TOOL.inputSchema.properties['url'];
    expect(
      ((urlProp as Record<string, unknown>).description as string).length
    ).toBeGreaterThan(0);
  });

  it('focus property description is non-empty', () => {
    const focusProp = WEB_FETCH_TOOL.inputSchema.properties['focus'];
    expect(
      ((focusProp as Record<string, unknown>).description as string).length
    ).toBeGreaterThan(0);
  });

  it('url property description mentions "url" or "fetch"', () => {
    const urlProp = WEB_FETCH_TOOL.inputSchema.properties['url'];
    const desc = (
      (urlProp as Record<string, unknown>).description as string
    ).toLowerCase();
    expect(desc.includes('url') || desc.includes('fetch')).toBe(true);
  });

  // --- No extra top-level keys ---

  it('tool object has exactly name, description, and inputSchema keys', () => {
    const keys = Object.keys(WEB_FETCH_TOOL);
    expect(keys.sort()).toEqual(['description', 'inputSchema', 'name']);
  });

  it('inputSchema has exactly type, properties, required, additionalProperties keys', () => {
    const keys = Object.keys(WEB_FETCH_TOOL.inputSchema).sort();
    expect(keys).toEqual([
      'additionalProperties',
      'properties',
      'required',
      'type',
    ]);
  });

  // --- Immutability / constancy ---

  it('name is a non-empty string', () => {
    expect(WEB_FETCH_TOOL.name.length).toBeGreaterThan(0);
  });

  it('description is a non-empty string', () => {
    expect(WEB_FETCH_TOOL.description.length).toBeGreaterThan(0);
  });

  it('required array is an array of strings', () => {
    expect(Array.isArray(WEB_FETCH_TOOL.inputSchema.required)).toBe(true);
    for (const field of WEB_FETCH_TOOL.inputSchema.required) {
      expect(typeof field).toBe('string');
    }
  });

  it('does not define a query property (that belongs to web_search)', () => {
    expect(
      WEB_FETCH_TOOL.inputSchema.properties['query']
    ).toBeUndefined();
  });

  it('does not define a max_results property (that belongs to web_search)', () => {
    expect(
      WEB_FETCH_TOOL.inputSchema.properties['max_results']
    ).toBeUndefined();
  });

  // --- Arrow symbol in description ---

  it('description contains arrow symbol (→) for pipeline flow', () => {
    expect(WEB_FETCH_TOOL.description).toContain('\u2192');
  });
});

// ---------------------------------------------------------------------------
// TOOL_DEFINITIONS array
// ---------------------------------------------------------------------------

describe('TOOL_DEFINITIONS', () => {
  // [Implements: US-MC-005]
  it('contains exactly 2 tool definitions', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(2);
  });

  // [Implements: US-MC-005]
  it('contains web_search as the first tool', () => {
    expect(TOOL_DEFINITIONS[0]).toBe(WEB_SEARCH_TOOL);
    expect(TOOL_DEFINITIONS[0].name).toBe('web_search');
  });

  // [Implements: US-MC-005]
  it('contains web_fetch as the second tool', () => {
    expect(TOOL_DEFINITIONS[1]).toBe(WEB_FETCH_TOOL);
    expect(TOOL_DEFINITIONS[1].name).toBe('web_fetch');
  });

  it('contains both web_search and web_fetch tools', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
  });

  it('has no duplicate tool names', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  // --- All entries are valid ToolDefinitions ---

  it('every entry has name, description, and inputSchema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.inputSchema).toBe('object');
    }
  });

  it('every entry has inputSchema with type, properties, required, and additionalProperties', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const schema = tool.inputSchema;
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(Array.isArray(schema.required)).toBe(true);
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it('every entry has a non-empty name', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name.length).toBeGreaterThan(0);
    }
  });

  it('every entry has a non-empty description', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('every entry has at least one required field', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.required.length).toBeGreaterThan(0);
    }
  });

  // --- Tool ordering ---

  it('orders tools as [web_search, web_fetch]', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      'web_search',
      'web_fetch',
    ]);
  });

  // --- Tool isolation (different tools have different schemas) ---

  it('web_search and web_fetch have different required fields', () => {
    const searchRequired = WEB_SEARCH_TOOL.inputSchema.required;
    const fetchRequired = WEB_FETCH_TOOL.inputSchema.required;
    expect(searchRequired).not.toEqual(fetchRequired);
  });

  it('web_search has max_results property, web_fetch does not', () => {
    expect(
      WEB_SEARCH_TOOL.inputSchema.properties['max_results']
    ).toBeDefined();
    expect(
      WEB_FETCH_TOOL.inputSchema.properties['max_results']
    ).toBeUndefined();
  });

  it('web_fetch has url property with format uri, web_search does not', () => {
    const fetchUrl = WEB_FETCH_TOOL.inputSchema.properties['url'];
    expect(fetchUrl).toBeDefined();
    expect((fetchUrl as Record<string, unknown>).format).toBe('uri');

    expect(
      WEB_SEARCH_TOOL.inputSchema.properties['url']
    ).toBeUndefined();
  });

  // --- Cross-tool consistency ---

  it('both tools have exactly one required field', () => {
    expect(WEB_SEARCH_TOOL.inputSchema.required).toHaveLength(1);
    expect(WEB_FETCH_TOOL.inputSchema.required).toHaveLength(1);
  });

  it('both tools have additionalProperties set to false', () => {
    expect(WEB_SEARCH_TOOL.inputSchema.additionalProperties).toBe(false);
    expect(WEB_FETCH_TOOL.inputSchema.additionalProperties).toBe(false);
  });

  it('both tools share the same focus property type', () => {
    const searchFocus = WEB_SEARCH_TOOL.inputSchema.properties['focus'];
    const fetchFocus = WEB_FETCH_TOOL.inputSchema.properties['focus'];
    expect((searchFocus as Record<string, unknown>).type).toBe(
      (fetchFocus as Record<string, unknown>).type
    );
  });

  it('both tools have inputSchema.type equal to "object"', () => {
    expect(WEB_SEARCH_TOOL.inputSchema.type).toBe('object');
    expect(WEB_FETCH_TOOL.inputSchema.type).toBe('object');
  });

  it('both tools share the same description text for focus property', () => {
    const searchFocusDesc = (
      WEB_SEARCH_TOOL.inputSchema.properties['focus'] as Record<
        string,
        unknown
      >
    ).description;
    const fetchFocusDesc = (
      WEB_FETCH_TOOL.inputSchema.properties['focus'] as Record<
        string,
        unknown
      >
    ).description;
    expect(searchFocusDesc).toBe(fetchFocusDesc);
  });

  // --- Array immutability / reference identity ---

  it('TOOL_DEFINITIONS entries are the same object references as WEB_SEARCH_TOOL and WEB_FETCH_TOOL', () => {
    expect(TOOL_DEFINITIONS[0]).toBe(WEB_SEARCH_TOOL);
    expect(TOOL_DEFINITIONS[1]).toBe(WEB_FETCH_TOOL);
  });

  it('TOOL_DEFINITIONS is an array', () => {
    expect(Array.isArray(TOOL_DEFINITIONS)).toBe(true);
  });

  // --- No null/undefined entries ---

  it('has no null or undefined entries', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool).not.toBeNull();
      expect(tool).not.toBeUndefined();
    }
  });

  // --- Name uniqueness guarantee ---

  it('tool names are distinct strings', () => {
    expect(WEB_SEARCH_TOOL.name).not.toBe(WEB_FETCH_TOOL.name);
  });

  // --- Description uniqueness ---

  it('tool descriptions are distinct strings', () => {
    expect(WEB_SEARCH_TOOL.description).not.toBe(
      WEB_FETCH_TOOL.description
    );
  });
});
