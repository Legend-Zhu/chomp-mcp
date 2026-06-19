/**
 * Parameter validation for MCP tool calls using Zod schemas.
 *
 * Validates raw MCP arguments (snake_case input from JSON-RPC) against
 * tool-specific Zod schemas and produces typed camelCase output objects
 * with human-readable error messages per US-MC-010.
 *
 * [Spec: US-MC-010, DC-MC-003, DC-MC-004]
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

// [Spec: US-MC-010, DC-MC-003]
// Validated parameter object for the web_search tool, mapped from MCP
// snake_case input to TypeScript camelCase fields.
export interface WebSearchParams {
  /** Non-empty search query string. */
  query: string;
  /** Maximum number of results to process. Integer ≥ 1. Default: 5. */
  maxResults?: number;
  /** Optional focus area to emphasize in synthesis. */
  focus?: string;
}

// [Spec: US-MC-010, DC-MC-003]
// Validated parameter object for the web_fetch tool.
export interface WebFetchParams {
  /** The URL to fetch and synthesize. Must be a valid URI. */
  url: string;
  /** Optional focus area to emphasize in synthesis. */
  focus?: string;
}

// [Spec: US-MC-010, DC-MC-003]
// Discriminated union returned by validation functions.
export type ValidationResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly message: string };

// ---------------------------------------------------------------------------
// Internal Zod schemas (snake_case input from MCP)
// ---------------------------------------------------------------------------

// [Constraint: DC-MC-003, DC-MC-004, US-MC-010]
const webSearchSchema = z
  .object({
    query: z
      .string({
        required_error: 'Missing required field: query',
        invalid_type_error: 'Missing required field: query',
      })
      .min(1, 'Missing required field: query'),
    max_results: z
      .number({
        invalid_type_error: 'max_results must be a positive integer',
      })
      .int('max_results must be a positive integer')
      .positive('max_results must be a positive integer')
      .default(5),
    focus: z.string().optional(),
  })
  .strict();

// [Constraint: DC-MC-003, DC-MC-004, US-MC-010]
const webFetchSchema = z
  .object({
    url: z.string().url(),
    focus: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

/**
 * Validate raw MCP arguments for the `web_search` tool.
 *
 * Accepts snake_case input (`query`, `max_results`, `focus`) and produces
 * a typed `WebSearchParams` object with camelCase fields on success.
 *
 * On failure, returns a human-readable error message per US-MC-010:
 * - Missing or empty `query`: `"Missing required field: query"`
 * - Non-integer or non-positive `max_results`: `"max_results must be a positive integer"`
 *
 * [Implements: US-MC-010, DC-MC-003]
 */
export function validateWebSearchParams(
  params: unknown
): ValidationResult<WebSearchParams> {
  const result = webSearchSchema.safeParse(params);

  if (result.success) {
    return {
      success: true,
      data: {
        query: result.data.query,
        maxResults: result.data.max_results,
        focus: result.data.focus,
      },
    };
  }

  // [Implements: US-MC-010] Return the first issue's custom message
  const message = result.error.issues[0]?.message ?? 'Invalid parameters';
  return { success: false, message };
}

/**
 * Validate raw MCP arguments for the `web_fetch` tool.
 *
 * Accepts snake_case input (`url`, `focus`) and produces a typed
 * `WebFetchParams` object on success.
 *
 * On failure, returns a human-readable error message per US-MC-010:
 * - Invalid URL format: `"Invalid URL format: {provided value}"`
 * - Missing required fields or other errors: ZodError default message
 *
 * [Implements: US-MC-010, DC-MC-003]
 */
export function validateWebFetchParams(
  params: unknown
): ValidationResult<WebFetchParams> {
  const result = webFetchSchema.safeParse(params);

  if (result.success) {
    return {
      success: true,
      data: {
        url: result.data.url,
        focus: result.data.focus,
      },
    };
  }

  // [Implements: US-MC-010] Check for URL format validation failure
  // and construct a custom message with the provided value.
  const urlIssue = result.error.issues.find(
    (issue) =>
      issue.path.length > 0 &&
      issue.path[0] === 'url' &&
      issue.code === 'invalid_string'
  );

  if (urlIssue !== undefined) {
    const rawUrl =
      params !== null &&
      typeof params === 'object' &&
      'url' in params
        ? String((params as Record<string, unknown>).url)
        : '';
    return { success: false, message: `Invalid URL format: ${rawUrl}` };
  }

  // [Implements: US-MC-010] For all other failures, return the ZodError message
  const message = result.error.issues[0]?.message ?? 'Invalid parameters';
  return { success: false, message };
}
