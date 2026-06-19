/**
 * Internal TypeScript interfaces, configuration types, and error classes
 * for the synthesize module.
 *
 * This file is the foundational type layer that every other synthesize
 * source file depends on.
 *
 * [Spec: US-SY-001, DC-SY-004, NFR-SY-002, NFR-SY-003]
 */

import { AppError } from '../../shared/utils/errors.js';
import type { DigestResult, SourceRef } from '../../shared/types/digest.js';
import type { ContentItem } from '../../shared/types/content.js';

// Re-export shared types for convenience within the synthesize module.
export type { DigestResult, SourceRef, ContentItem };

// ---------------------------------------------------------------------------
// Default constants — consumed by llm-client.ts during initialization
// ---------------------------------------------------------------------------

// [Constraint: DC-SY-004]
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// [Constraint: DC-SY-004]
export const DEFAULT_MODEL = 'gpt-4o-mini';

// [Constraint: NFR-SY-002] Default HTTP timeout for LLM calls (60 seconds).
export const DEFAULT_TIMEOUT_MS = 60_000;

// [Constraint: DC-SY-004]
export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;

// [Constraint: DC-SY-004] Fraction of maxContextTokens considered safe.
export const DEFAULT_SAFE_THRESHOLD_RATIO = 0.8;

// [Constraint: DC-SY-004]
export const DEFAULT_MAX_BATCH_CONCURRENCY = 2;

// [Constraint: NFR-SY-003] Default retry configuration values.
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_INITIAL_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 10_000;
export const DEFAULT_RETRY_MULTIPLIER = 2;
export const DEFAULT_TIMEOUT_RETRIES = 2;

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

// [Spec: US-SY-001, Constraint: DC-SY-004]
// Configuration object created at module initialization from environment variables.
export interface SynthesizeConfig {
  /** OpenAI-compatible API key. Must be non-empty. */
  apiKey: string;
  /** LLM API base URL (e.g. https://api.openai.com/v1). */
  baseUrl: string;
  /** Model identifier (e.g. gpt-4o-mini). */
  model: string;
  /** HTTP timeout for LLM calls in milliseconds. */
  timeoutMs: number;
  /** Maximum context window for the model in tokens. */
  maxContextTokens: number;
  /** Fraction of maxContextTokens considered safe (default: 0.8). */
  safeThresholdRatio: number;
  /** Maximum concurrent LLM requests during batch-and-merge (default: 2). */
  maxBatchConcurrency: number;
}

// ---------------------------------------------------------------------------
// LLM response and call types
// ---------------------------------------------------------------------------

// [Spec: US-SY-001]
// Internal representation of a single LLM completion response.
export interface LLMResponse {
  /** Raw text content from the LLM's choices[0].message.content. */
  content: string;
  /** Token count reported by the API for the prompt. */
  promptTokens: number;
  /** Token count reported by the API for the completion. */
  completionTokens: number;
}

// [Spec: US-SY-001]
// Optional parameters for an LLM call.
export interface LLMCallOptions {
  /** Model identifier for this call. */
  model?: string;
  /** Sampling temperature (default: 0.3 for factual synthesis). */
  temperature?: number;
  /** Maximum completion tokens (default: derived from model). */
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

// [Spec: NFR-SY-003, Constraint: DC-SY-004]
// Retry policy parameters for transient LLM failures.
export interface RetryConfig {
  /** Maximum retry attempts for 429/5xx errors (default: 3). */
  maxRetries: number;
  /** Initial retry delay in milliseconds (default: 1000). */
  initialDelayMs: number;
  /** Maximum retry delay cap in milliseconds (default: 10000). */
  maxDelayMs: number;
  /** Exponential backoff multiplier (default: 2). */
  multiplier: number;
  /** Additional retries for timeout errors (default: 2). */
  timeoutRetries: number;
}

// ---------------------------------------------------------------------------
// OpenAI-agnostic client type (DC-SY-001)
// ---------------------------------------------------------------------------

// [Constraint: DC-SY-001]
// Minimal client interface to avoid coupling to a specific SDK while
// remaining structurally compatible with the OpenAI client shape.
export interface OpenAIClient {
  chat: {
    completions: {
      create: (params: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        temperature?: number;
        max_tokens?: number;
      }) => Promise<{
        choices: Array<{ message: { content?: string | null; reasoning_content?: string | null } }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
        };
      }>;
    };
  };
}

// [Constraint: DC-SY-004]
// Result of LLM client initialization — bundles the client with a
// connectivity-verification function.
export interface LLMClientInstance {
  client: OpenAIClient;
  verifyLLMConnectivity: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Error classes — all extend shared AppError
// ---------------------------------------------------------------------------

// [Spec: US-SY-001, Constraint: NFR-SY-002]
// Thrown when LLM_API_KEY is missing or empty during initialization.
export class LLMConfigError extends AppError {
  constructor(message: string) {
    super(message, 'config');
    this.name = 'LLMConfigError';
  }
}

// [Spec: US-SY-001]
// Thrown on HTTP 401/403 from the LLM API — indicates authentication failure.
export class LLMAuthError extends AppError {
  constructor(message: string) {
    super(message, 'http_error');
    this.name = 'LLMAuthError';
  }
}

// [Spec: US-SY-001, Constraint: NFR-SY-002]
// Thrown when an LLM request exceeds the configured timeout.
export class LLMTimeoutError extends AppError {
  constructor(message: string) {
    super(message, 'timeout');
    this.name = 'LLMTimeoutError';
  }
}

// [Spec: US-SY-001, Constraint: NFR-SY-003]
// Thrown on HTTP 429 from the LLM API — rate limited.
export class LLMRateLimitError extends AppError {
  constructor(message: string) {
    super(message, 'http_error');
    this.name = 'LLMRateLimitError';
  }
}

// [Spec: US-SY-001, Constraint: NFR-SY-003]
// Thrown on HTTP 5xx from the LLM API — server-side error.
export class LLMServerError extends AppError {
  constructor(message: string) {
    super(message, 'http_error');
    this.name = 'LLMServerError';
  }
}

// [Spec: US-SY-001]
// Thrown when the LLM response is unparseable or empty.
export class LLMResponseError extends AppError {
  constructor(message: string) {
    super(message, 'parse_error');
    this.name = 'LLMResponseError';
  }
}

// [Spec: US-SY-001, Constraint: NFR-SY-003]
// Thrown on network-level failures (connection refused, DNS failure, etc.).
export class LLMNetworkError extends AppError {
  constructor(message: string) {
    super(message, 'network');
    this.name = 'LLMNetworkError';
  }
}
