/**
 * LLM Client — init, health check, and retry-wrapped chat completion.
 *
 * Provides three functions consumed by the synthesizer:
 * - `createLLMClient(config)` — instantiates an OpenAI-compatible client.
 * - `verifyLLMConnectivity(client)` — sends a minimal test prompt to check reachability.
 * - `callLLMWithRetry(client, systemPrompt, userPrompt, options?)` — performs a
 *   chat completion with exponential backoff for transient errors, timeout
 *   retries for timeout errors, and immediate propagation for auth errors.
 *
 * [Spec: US-SY-001, US-SY-006, NFR-SY-001, NFR-SY-002, NFR-SY-003, NFR-SY-006, DC-SY-001, DC-SY-002]
 */

import OpenAI from 'openai';

import type {
  SynthesizeConfig,
  LLMResponse,
  LLMCallOptions,
  RetryConfig,
  OpenAIClient,
} from './types.js';

import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_RETRY_MULTIPLIER,
  DEFAULT_TIMEOUT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MODEL,
  LLMConfigError,
  LLMAuthError,
  LLMTimeoutError,
  LLMRateLimitError,
  LLMServerError,
  LLMResponseError,
  LLMNetworkError,
} from './types.js';

// ---------------------------------------------------------------------------
// Default retry configuration
// ---------------------------------------------------------------------------

// [Constraint: NFR-SY-003, DC-SY-004]
// Default retry config matching the design specification.
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: DEFAULT_MAX_RETRIES,
  initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
  multiplier: DEFAULT_RETRY_MULTIPLIER,
  timeoutRetries: DEFAULT_TIMEOUT_RETRIES,
};

// [Constraint: US-SY-006]
// Default sampling temperature for factual synthesis.
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_COMPLETION_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// [Implements: NFR-SY-006, US-SY-006]
/**
 * Sleep for a specified number of milliseconds. Resolves immediately if the
 * delay is zero or negative.
 */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// [Implements: US-SY-006, NFR-SY-003]
/**
 * Compute the retry delay using exponential backoff with ±20% jitter.
 *
 * delay = min(initialDelayMs * multiplier^attempt, maxDelayMs)
 *
 * Jitter is applied as a random multiplier between 0.8 and 1.2.
 *
 * @param attempt - Zero-based attempt index (0 = first retry).
 * @param config - Retry configuration with backoff parameters.
 * @returns Delay in milliseconds including jitter.
 *
 * [Constraint: NFR-SY-003]
 */
function computeBackoffDelay(attempt: number, config: RetryConfig): number {
  const baseDelay =
    config.initialDelayMs * Math.pow(config.multiplier, attempt);
  const cappedDelay = Math.min(baseDelay, config.maxDelayMs);

  // [Constraint: NFR-SY-003] Add ±20% jitter
  const jitterFactor = 0.8 + Math.random() * 0.4; // range [0.8, 1.2]
  return Math.floor(cappedDelay * jitterFactor);
}

/**
 * Extract an HTTP status code from an error thrown by the OpenAI SDK.
 *
 * The OpenAI SDK throws errors with a `status` property (or nested in
 * `error.status`). Returns `undefined` if no status can be determined.
 */
function getHttpStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') {
    return undefined;
  }

  // OpenAI SDK APIError has a `status` property directly.
  const directStatus = (error as { status?: unknown }).status;
  if (typeof directStatus === 'number') {
    return directStatus;
  }

  // Some error shapes nest the status inside an `error` property.
  const nestedError = (error as { error?: unknown }).error;
  if (nestedError !== null && typeof nestedError === 'object') {
    const nestedStatus = (nestedError as { status?: unknown }).status;
    if (typeof nestedStatus === 'number') {
      return nestedStatus;
    }
  }

  return undefined;
}

/**
 * Extract a descriptive error message from an unknown error.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Determine whether an error is an AbortError (timeout from AbortController).
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError';
  }
  if (error !== null && typeof error === 'object') {
    const name = (error as { name?: unknown }).name;
    return name === 'AbortError';
  }
  return false;
}

/**
 * Check if an error code indicates a network-level failure.
 */
function isNetworkErrorCode(code: string): boolean {
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTDOWN' ||
    code === 'EACCES' ||
    code === 'EADDRINUSE' ||
    code === 'EADDRNOTAVAIL'
  );
}

/**
 * Extract a node error code from an error object.
 */
function getErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

// [Implements: US-SY-006, NFR-SY-002]
/**
 * Wrap a promise with a timeout using AbortController.
 *
 * Creates an AbortController that fires after `timeoutMs` and races the
 * supplied promise against the abort timer. If the timeout fires first,
 * the promise rejects with a synthetic AbortError.
 *
 * This enforces the per-attempt HTTP timeout for LLM calls independent of
 * the SDK's built-in timeout handling.
 *
 * @param fn - Factory that receives the AbortSignal and returns the promise to race.
 * @param timeoutMs - Timeout duration in milliseconds.
 * @returns The resolved value of the promise, or rejects on timeout/error.
 *
 * [Spec: NFR-SY-002]
 */
function withAbortTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        controller.abort();
        const timeoutErr = new Error(
          `Request timed out after ${timeoutMs}ms`
        );
        timeoutErr.name = 'AbortError';
        reject(timeoutErr);
      }
    }, timeoutMs);

    fn(controller.signal).then(
      (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// [Implements: US-SY-001, NFR-SY-002, DC-SY-002]
/**
 * Create an OpenAI-compatible client instance from a SynthesizeConfig.
 *
 * Validates that `config.apiKey` is non-empty (after trim), then instantiates
 * the OpenAI SDK client with the provided `baseURL` and `timeout`.
 *
 * @param config - SynthesizeConfig with apiKey, baseUrl, model, timeoutMs.
 * @returns An OpenAIClient instance configured for the specified endpoint.
 * @throws {LLMConfigError} If `config.apiKey` is missing or whitespace-only.
 *
 * [Spec: US-SY-001, Constraint: NFR-SY-002, DC-SY-002]
 */
export function createLLMClient(config: SynthesizeConfig): OpenAIClient {
  // [Implements: US-SY-001, NFR-SY-002] Validate API key is present and non-empty
  if (
    config.apiKey === undefined ||
    config.apiKey === null ||
    config.apiKey.trim().length === 0
  ) {
    // [Constraint: NFR-SY-006] Never log the actual key value — only the variable name
    throw new LLMConfigError('LLM_API_KEY is required');
  }

  // [Implements: US-SY-001, DC-SY-002] Instantiate OpenAI-compatible client.
  // Set maxRetries to 0 — we manage our own retry logic in callLLMWithRetry.
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: config.timeoutMs,
    maxRetries: 0,
  });

  // The OpenAI SDK client is structurally compatible with our OpenAIClient interface.
  return client as unknown as OpenAIClient;
}

// [Implements: US-SY-001, NFR-SY-002]
/**
 * Verify LLM endpoint connectivity by sending a minimal test prompt.
 *
 * Sends a one-token prompt to the chat completions endpoint and returns
 * `true` if the call succeeds. Any error (auth, network, timeout, parse)
 * results in `false`. Errors are logged to stderr for diagnostics.
 *
 * @param client - The OpenAIClient instance to test.
 * @returns `true` if the endpoint is reachable and responds successfully;
 *   `false` on any error.
 *
 * [Spec: US-SY-001, Constraint: NFR-SY-002]
 */
export async function verifyLLMConnectivity(
  client: OpenAIClient
): Promise<boolean> {
  try {
    await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    });
    return true;
  } catch (error) {
    // [Constraint: NFR-SY-006] Log error details without exposing API key
    const message = getErrorMessage(error);
    process.stderr.write(`[SY] LLM connectivity check failed: ${message}\n`);
    return false;
  }
}

// [Implements: US-SY-006, NFR-SY-002, NFR-SY-003, DC-SY-001]
/**
 * Call the LLM chat completions endpoint with retry and timeout enforcement.
 *
 * Implements:
 * - AbortController-based timeout for each attempt.
 * - Exponential backoff retry for HTTP 429, 5xx, and network errors (up to
 *   `maxRetries` = 3).
 * - Separate retry budget for timeout errors (up to `timeoutRetries` = 2).
 * - Immediate throw (no retry) for HTTP 401/403 auth errors.
 * - Response validation: empty content throws LLMResponseError.
 *
 * The error types thrown are the module-specific LLM error classes. The
 * synthesizer orchestrator catches these and triggers degradation fallback.
 *
 * @param client - The OpenAIClient instance to use for the call.
 * @param systemPrompt - The system message content.
 * @param userPrompt - The user message content.
 * @param options - Optional call parameters (temperature, maxTokens).
 * @returns LLMResponse with content, promptTokens, and completionTokens.
 * @throws {LLMAuthError} On HTTP 401/403 (propagates immediately for degradation).
 * @throws {LLMRateLimitError} After exhausting retries for HTTP 429.
 * @throws {LLMServerError} After exhausting retries for HTTP 5xx.
 * @throws {LLMTimeoutError} After exhausting timeout retries.
 * @throws {LLMNetworkError} After exhausting retries for network errors.
 * @throws {LLMResponseError} On empty/whitespace-only response content.
 *
 * [Spec: US-SY-006, Constraint: NFR-SY-002, NFR-SY-003, DC-SY-001]
 */
export async function callLLMWithRetry(
  client: OpenAIClient,
  systemPrompt: string,
  userPrompt: string,
  options?: LLMCallOptions
): Promise<LLMResponse> {
  // [Constraint: NFR-SY-003] Use default retry configuration
  const retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG;
  const callTimeoutMs = DEFAULT_TIMEOUT_MS;

  // [Constraint: US-SY-006] Temperature defaults to 0.3 for factual synthesis
  const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
  const model = options?.model ?? DEFAULT_MODEL;
  const maxTokens = options?.maxTokens ?? DEFAULT_COMPLETION_TOKENS;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  // [Implements: US-SY-006] Track attempt counts separately for transient vs timeout
  let transientAttempt = 0;
  let timeoutAttempt = 0;

  for (;;) {
    try {
      // [Implements: US-SY-006, NFR-SY-002] Wrap the LLM call with AbortController timeout
      const response = await withAbortTimeout(
        (_signal: AbortSignal) =>
          client.chat.completions.create({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
        callTimeoutMs
      );

      // [Implements: US-SY-006] Extract content from choices[0].message.content
      const content = response.choices[0]?.message?.content ?? '';

      // [Implements: US-SY-006] Validate response content is non-empty
      if (content.trim().length === 0) {
        throw new LLMResponseError(
          'LLM returned empty or whitespace-only content'
        );
      }

      // [Implements: US-SY-006] Extract token usage from the response
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;

      return {
        content,
        promptTokens,
        completionTokens,
      };
    } catch (error) {
      // Re-throw our own typed errors directly (already classified)
      if (error instanceof LLMResponseError) {
        throw error;
      }

      // [Implements: US-SY-006] Classify and handle errors by HTTP status
      const status = getHttpStatus(error);
      const message = getErrorMessage(error);

      // --- Auth errors (401/403) — no retry, immediate propagation ---
      // [Constraint: DC-SY-002, US-SY-006]
      if (status === 401 || status === 403) {
        process.stderr.write('[SY] LLM auth failed — check LLM_API_KEY\n');
        throw new LLMAuthError(
          `HTTP ${status}: Authentication failed — check LLM_API_KEY`
        );
      }

      // --- Timeout (AbortError or HTTP 408) ---
      // [Implements: US-SY-006, NFR-SY-002]
      if (isAbortError(error) || status === 408) {
        if (timeoutAttempt >= retryConfig.timeoutRetries) {
          process.stderr.write(
            `[SY] timeout retries exhausted (${retryConfig.timeoutRetries})\n`
          );
          throw new LLMTimeoutError(
            `LLM request timed out after ${callTimeoutMs}ms (exhausted ${retryConfig.timeoutRetries} timeout retries)`
          );
        }

        const delay = computeBackoffDelay(timeoutAttempt, retryConfig);
        process.stderr.write(
          `[SY] retry ${timeoutAttempt + 1}/${retryConfig.timeoutRetries}: timeout\n`
        );
        timeoutAttempt++;
        await sleep(delay);
        continue;
      }

      // --- Rate limit (429) ---
      // [Implements: US-SY-006, NFR-SY-003]
      if (status === 429) {
        if (transientAttempt >= retryConfig.maxRetries) {
          process.stderr.write(
            `[SY] retries exhausted for rate limit (${retryConfig.maxRetries})\n`
          );
          throw new LLMRateLimitError(
            `HTTP 429: Rate limited — retries exhausted (${retryConfig.maxRetries})`
          );
        }

        const delay = computeBackoffDelay(transientAttempt, retryConfig);
        process.stderr.write(
          `[SY] retry ${transientAttempt + 1}/${retryConfig.maxRetries}: rate limited\n`
        );
        transientAttempt++;
        await sleep(delay);
        continue;
      }

      // --- Server error (5xx) ---
      // [Implements: US-SY-006, NFR-SY-003]
      if (status !== undefined && status >= 500 && status < 600) {
        if (transientAttempt >= retryConfig.maxRetries) {
          process.stderr.write(
            `[SY] retries exhausted for server error (${retryConfig.maxRetries})\n`
          );
          throw new LLMServerError(
            `HTTP ${status}: Server error — retries exhausted (${retryConfig.maxRetries})`
          );
        }

        const delay = computeBackoffDelay(transientAttempt, retryConfig);
        process.stderr.write(
          `[SY] retry ${transientAttempt + 1}/${retryConfig.maxRetries}: server error (HTTP ${status})\n`
        );
        transientAttempt++;
        await sleep(delay);
        continue;
      }

      // --- Network errors (connection refused, DNS failure, etc.) ---
      // [Implements: US-SY-006, NFR-SY-003]
      const errorCode = getErrorCode(error);
      if (
        (errorCode !== undefined && isNetworkErrorCode(errorCode)) ||
        status === undefined
      ) {
        if (transientAttempt >= retryConfig.maxRetries) {
          process.stderr.write(
            `[SY] retries exhausted for network error (${retryConfig.maxRetries})\n`
          );
          throw new LLMNetworkError(
            `Network error${errorCode !== undefined ? ` (${errorCode})` : ''}: ${message} — retries exhausted (${retryConfig.maxRetries})`
          );
        }

        const delay = computeBackoffDelay(transientAttempt, retryConfig);
        process.stderr.write(
          `[SY] retry ${transientAttempt + 1}/${retryConfig.maxRetries}: ${errorCode ?? 'network error'}\n`
        );
        transientAttempt++;
        await sleep(delay);
        continue;
      }

      // --- Unexpected error with a known status (e.g., 4xx other than 401/403/429) ---
      // [Implements: US-SY-006] Not retryable — throw as server error
      if (status !== undefined) {
        throw new LLMServerError(`HTTP ${status}: ${message}`);
      }

      // --- Truly unexpected error ---
      throw new LLMServerError(`Unexpected LLM error: ${message}`);
    }
  }
}
