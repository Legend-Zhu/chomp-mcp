/**
 * Synthesize module — public API barrel exports.
 *
 * Re-exports the public entry points for consumption by the Pipeline
 * Orchestration (PL) layer and the MCP server startup health-check flow.
 *
 * Public functions:
 * - `synthesize(query, contents[], focus?)` — multi-source LLM synthesis
 * - `synthesizeSingle(url, title, content, focus?)` — single-page synthesis
 * - `createLLMClient(config)` — OpenAI-compatible client initialization
 * - `verifyLLMConnectivity(client)` — startup health-check
 * - `callLLMWithRetry(...)` — retry-wrapped chat completion (used internally)
 *
 * Re-exported types:
 * - `DigestResult`, `SourceRef` — synthesis output contract (shared)
 * - `ContentItem` — enriched search result with content (shared)
 * - `SynthesizeConfig`, `LLMResponse`, `LLMCallOptions`, `RetryConfig` —
 *   module-internal configuration and LLM interaction types
 *
 * [Spec: US-SY-001, US-SY-003, US-SY-004, DC-SY-004]
 */

// [Implements: US-SY-003, US-SY-004]
// Main synthesis entry points — consumed by PL orchestrator.
export { synthesize, synthesizeSingle } from './synthesizer.js';

// [Implements: US-SY-001]
// LLM client initialization and health-check — used by PL for startup
// connectivity verification and internally by synthesizer/batch-merger.
export {
  createLLMClient,
  verifyLLMConnectivity,
  callLLMWithRetry,
} from './llm-client.js';

// [Implements: DC-SY-004]
// Module-internal configuration and LLM interaction types.
export type {
  SynthesizeConfig,
  LLMResponse,
  LLMCallOptions,
  RetryConfig,
} from './types.js';

// Re-export shared types for downstream consumers so they can import
// everything from the synthesize barrel without reaching into shared/types.
export type { DigestResult, SourceRef } from '../../shared/types/digest.js';
export type { ContentItem } from '../../shared/types/content.js';
