/**
 * Static MCP tool definitions for web_search and web_fetch.
 *
 * Defines the JSON Schema (Draft 2020-12) input contracts and metadata
 * for the two tools exposed by the MCP server. These definitions are
 * returned by the tools/list handler and used to validate incoming
 * tools/call arguments.
 *
 * [Spec: US-MC-003, US-MC-004, US-MC-005, BG-MC-002, DC-MC-004]
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * MCP Tool definition object conforming to SDK Tool type.
 *
 * Each entry has a unique name, a human-readable description, and a
 * JSON Schema draft 2020-12 `inputSchema` describing the tool's parameters.
 */
export interface ToolDefinition {
  /** Tool name identifier; either 'web_search' or 'web_fetch'. */
  name: string;

  /** Human-readable description of the tool's purpose. */
  description: string;

  /** JSON Schema draft 2020-12 object defining tool parameters. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

// ---------------------------------------------------------------------------
// web_search input schema
// ---------------------------------------------------------------------------

/**
 * JSON Schema (Draft 2020-12) input contract for the web_search tool.
 * Additional properties: false.
 *
 * [Constraint: DC-MC-004]
 * [Implements: US-MC-003]
 */
const WEB_SEARCH_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: {
      type: 'string',
      description: 'The search query to research.',
    },
    max_results: {
      type: 'integer',
      default: 5,
      description: 'Maximum number of search results to process. Default: 5.',
    },
    focus: {
      type: 'string',
      description:
        'Optional aspect to emphasize in the synthesized digest.',
    },
  },
  required: ['query'],
  additionalProperties: false as const,
};

// ---------------------------------------------------------------------------
// web_fetch input schema
// ---------------------------------------------------------------------------

/**
 * JSON Schema (Draft 2020-12) input contract for the web_fetch tool.
 * Additional properties: false.
 *
 * [Constraint: DC-MC-004]
 * [Implements: US-MC-004]
 */
const WEB_FETCH_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      description: 'The URL to fetch, extract, and synthesize.',
    },
    focus: {
      type: 'string',
      description:
        'Optional aspect to emphasize in the synthesized digest.',
    },
  },
  required: ['url'],
  additionalProperties: false as const,
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Static MCP Tool definition for web_search.
 *
 * Description: Perform a full web research pipeline (search → scrape →
 * deduplicate → synthesize) and return a structured digest.
 *
 * [Implements: US-MC-003]
 */
export const WEB_SEARCH_TOOL: ToolDefinition = {
  name: 'web_search',
  description:
    'Perform a full web research pipeline (search \u2192 scrape \u2192 deduplicate \u2192 synthesize) and return a structured digest',
  inputSchema: WEB_SEARCH_INPUT_SCHEMA,
};

/**
 * Static MCP Tool definition for web_fetch.
 *
 * Description: Fetch and synthesize a specific URL into a structured
 * digest (scrape → synthesize).
 *
 * [Implements: US-MC-004]
 */
export const WEB_FETCH_TOOL: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch and synthesize a specific URL into a structured digest (scrape \u2192 synthesize)',
  inputSchema: WEB_FETCH_INPUT_SCHEMA,
};

/**
 * Array containing exactly [WEB_SEARCH_TOOL, WEB_FETCH_TOOL].
 *
 * Returned by the tools/list handler in the server module.
 *
 * [Implements: US-MC-005]
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
];
