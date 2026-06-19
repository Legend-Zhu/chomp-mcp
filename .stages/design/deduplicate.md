# Design: Deduplicate (DD)

## Overview

The Deduplicate and Denoise (DD) module is a **pure, network-free, deterministic transformation stage** in the web-research pipeline. It receives an array of `ContentItem` objects (search results enriched with scraped text content) from the Pipeline Orchestration (PL) module and returns a deduplicated, denoised array of `DeduplicatedItem` objects ready for LLM synthesis.

The module performs two major phases:

1. **URL-Level Deduplication** — Canonicalizes URLs by stripping tracking parameters, unifying scheme/hostname/port/fragment/trailing-slash, and sorting query parameters. Items producing identical canonical URLs are grouped; only the highest-scoring representative survives.

2. **Content-Level Deduplication** — Segments each article's text into paragraphs, computes a non-cryptographic FNV-1a 32-bit fingerprint per paragraph, builds a fingerprint set per article, then performs (a) exact-content deduplication (identical fingerprint sets → trivial removal) followed by (b) near-duplicate merging via Jaccard similarity on fingerprint sets. Near-duplicate groups are merged using a union-find (disjoint-set) structure to handle transitive relationships; the highest-scoring item is retained and discarded items' source URLs are copied into `mergedSources` for citation traceability.

The module has **zero network calls, zero LLM/AI dependencies, and zero shared mutable state**. It never throws exceptions — all per-item errors are caught, logged to stderr, and the offending item is skipped (NFR-DD-007). Output is fully deterministic (NFR-DD-003).

## Architecture

DD sits between the Scrape-Extract (SC) and Synthesize (SY) stages in the pipeline:

```
PL calls deduplicate(items: ContentItem[], config?: DDConfig): DeduplicatedItem[]
                                                    │
  ┌─────────────────────────────────────────────────▼──────────────────────────┐
  │                         deduplicator.ts (orchestrator)                       │
  │                                                                              │
  │  1. Filter empty content ─────────────► stats (emptyContentRemoved)          │
  │  2. URL normalize each item ──────────► url-normalizer.ts                    │
  │  3. Exact-URL dedup ──────────────────► content-merger.ts (dedupByUrl)      │
  │  4. Paragraph segment + fingerprint ──► paragraph-segmenter + fingerprinter │
  │  5. Exact-content dedup ─────────────► content-merger.ts (dedupExactContent)│
  │  6. Near-duplicate merge ────────────► content-merger.ts (mergeNearDups)    │
  │     └─ pairwise Jaccard ─────────────► similarity-computer.ts               │
  │  7. Assemble DeduplicatedItem[] + log summary ─► stats.ts                   │
  └─────────────────────────────────────────────────────────────────────────────┘
```

**Key design decisions:**

- **Pure function interface** — `deduplicate()` accepts an array and config, returns a new array. Input objects are never mutated (DC-DD-003). All output objects are fresh copies.
- **Deterministic ordering** — Input array order is preserved through all stages. Tie-breaking (equal scores) always favors the item appearing earlier in input (NFR-DD-003). No `Map` iteration order dependency — sorted arrays and explicit indices are used.
- **Phased dedup** — URL dedup runs first (cheapest), then exact-content dedup (cheap set-equality), then near-duplicate merge (O(N²) pairwise). Each phase reduces N for the next, minimizing computational cost.
- **Union-find for transitive near-duplicates** — If A~B and B~C (but A≁C), the transitive group {A,B,C} is merged correctly. A simple disjoint-set forest with path compression and union-by-rank handles this.
- **Fingerprint storage** — Fingerprint sets are `Set<number>` (32-bit unsigned integers), not full text. Peak memory for 20 items × ~100 paragraphs each is negligible (NFR-DD-005).

## Data Models

### ContentItem (input — defined in `shared/types/content.ts`)

This type is owned by the shared types layer. DD receives it; it does not define it.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | yes | Page title from search result or scrape |
| `url` | `string` | yes | Original URL of the page |
| `snippet` | `string` | yes | Search-result snippet text |
| `score` | `number` | yes | Relevance score from search (descending rank) |
| `content` | `string` | yes | Scraped text content (may be empty for failed scrapes) |

### DeduplicatedItem (output — defined in `shared/types/deduplicate.ts`)

Extends `ContentItem` with deduplication metadata.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | yes | Inherited from ContentItem |
| `url` | `string` | yes | Original URL of the retained representative item |
| `snippet` | `string` | yes | Inherited from ContentItem |
| `score` | `number` | yes | Score of the retained representative item |
| `content` | `string` | yes | Content text of the retained representative item |
| `normalizedUrl` | `string` | yes | Canonical normalized URL after tracking-param strip, scheme/port/fragment/slash unification, and query-param sorting |
| `mergedSources` | `string[]` | yes | Array of original URLs from items merged into this representative during content-level dedup (empty if no merges) |
| `fingerprintCount` | `number` | yes | Number of unique paragraph fingerprints in this item's fingerprint set |

### DDConfig (configuration — defined in `shared/types/deduplicate.ts`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `similarityThreshold` | `number` | yes | Jaccard similarity threshold for near-duplicate classification (default: `0.85`, range `[0.0, 1.0]`) |
| `minParagraphChars` | `number` | yes | Minimum character count for a paragraph to be fingerprinted (default: `20`) |
| `extraTrackingParams` | `string[]` | yes | Additional tracking-parameter names to strip beyond the built-in blocklist (default: `[]`) |

### DedupStats (module-local — defined in `modules/deduplicate/types.ts`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `inputCount` | `number` | yes | Number of ContentItems received as input |
| `emptyContentRemoved` | `number` | yes | Items removed because content was empty/null/whitespace-only |
| `errorItemsRemoved` | `number` | yes | Items removed due to processing errors (caught exceptions) |
| `exactUrlDuplicatesRemoved` | `number` | yes | Items removed by identical normalized URL |
| `exactContentDuplicatesRemoved` | `number` | yes | Items removed by identical fingerprint sets |
| `nearDuplicatesRemoved` | `number` | yes | Items removed by near-duplicate Jaccard similarity |
| `outputCount` | `number` | yes | Number of DeduplicatedItems returned |
| `elapsedMs` | `number` | yes | Total wall-clock processing time |

### FingerprintedItem (module-internal — defined in `modules/deduplicate/types.ts`)

Intermediate working structure used during content-level deduplication. Not exported.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `item` | `ContentItem` | yes | Reference to the original content item |
| `normalizedUrl` | `string` | yes | Canonical normalized URL |
| `fingerprints` | `Set<number>` | yes | Set of 32-bit paragraph fingerprint hashes |
| `originalIndex` | `number` | yes | Zero-based position in the original input array (for deterministic tie-breaking) |

## API Endpoints

This module exposes **programmatic function interfaces** (no HTTP/MCP endpoints). PL is the sole caller.

| Function | Signature | User Stories | Description |
|----------|-----------|--------------|-------------|
| `deduplicate` | `(items: ContentItem[], config?: DDConfig) => DeduplicatedItem[]` | US-DD-001 through US-DD-011 | Full pipeline entry: URL normalize → exact-URL dedup → segment + fingerprint → exact-content dedup → near-dup merge → return enriched items |
| `normalizeUrl` | `(rawUrl: string, extraTrackingParams?: string[]) => string` | US-DD-001, US-DD-002 | Canonicalize a single URL |
| `segmentParagraphs` | `(text: string, minChars: number) => string[]` | US-DD-004 | Split text into meaningful paragraph segments |
| `computeFingerprintSet` | `(content: string, minChars: number) => Set<number>` | US-DD-005 | Build a set of FNV-1a fingerprints from content |
| `jaccardSimilarity` | `(setA: Set<number>, setB: Set<number>) => number` | US-DD-006 | Compute Jaccard coefficient between two fingerprint sets |
| `logStats` | `(stats: DedupStats) => void` | US-DD-009 | Emit structured summary to stderr |

**Input validation rules for `deduplicate()`:**

| Condition | Behavior | User Story |
|-----------|----------|------------|
| `items` is empty array `[]` | Return `[]` immediately, log zero-stats summary | US-DD-011 |
| `items` has exactly 1 element | Normalize URL, fingerprint, return single item (no pairwise comparison) | US-DD-011 |
| `config` is `undefined` | Load default config from `shared/config` (reads env vars) | US-DD-010 |
| `config.similarityThreshold` outside `[0.0, 1.0]` | Warn to stderr, fall back to `0.85` | US-DD-010 |
| Item has empty/null/whitespace-only `content` | Remove item, log warning with URL, increment `emptyContentRemoved` | US-DD-004, US-DD-011 |
| Item causes exception during any stage | Catch, log URL + error to stderr, skip item, increment `errorItemsRemoved` | US-DD-009, NFR-DD-007 |

## Error Handling

**Core principle: the DD module NEVER throws exceptions to callers.** All errors are caught internally, logged to stderr, and processing continues (NFR-DD-007, DC-DD-003).

### Error Response Format

All error logging uses the shared `log` utility (stderr-only structured logger):

```
[DD] WARN empty content: url={url}
[DD] ERROR processing item: url={url} error={message}
[DD] WARN invalid similarity threshold: value={value} fallback=0.85
[DD] WARN high pairwise cost: N={count} max={MAX_PAIRWISE_ITEMS}
```

### Module-Specific Error Types

The DD module does not define custom error classes — it catches all exceptions generically. The shared `AppError` base class is available for internal use if typed errors are needed, but the module's design is catch-all-and-continue.

| Error Scenario | Handling | Affected Stat |
|----------------|----------|---------------|
| `URL` constructor throws on malformed URL during normalization | Log `[DD] ERROR normalize-url: url={url} error={msg}`, skip item | `errorItemsRemoved` |
| Content is empty string, `null`, or whitespace-only | Log `[DD] WARN empty content: url={url}`, skip item | `emptyContentRemoved` |
| Paragraph segmentation or fingerprinting throws | Log `[DD] ERROR fingerprint: url={url} error={msg}`, skip item | `errorItemsRemoved` |
| `DEDUP_SIMILARITY_THRESHOLD` is outside `[0.0, 1.0]` | Log warning, use default `0.85` | (config fallback) |
| `DEDUP_EXTRA_TRACKING_PARAMS` has empty entries (e.g., `"a,,b"`) | Filter out empty strings silently | (config cleanup) |

## Component Interfaces

### url-normalizer.ts

```typescript
/** Built-in tracking parameter blocklist (DC-DD-006). */
const TRACKING_PARAM_BLOCKLIST: readonly string[];

/**
 * Canonicalize a URL by: converting http→https, lowercasing hostname,
 * removing fragment, removing default ports (80/443), removing trailing
 * slash (if path length > 1), stripping tracking parameters, and sorting
 * remaining query parameters alphabetically by key.
 *
 * @param rawUrl - The raw URL string to normalize.
 * @param extraTrackingParams - Additional param names to strip (merged with blocklist).
 * @returns The canonical normalized URL string.
 * @throws Error if rawUrl cannot be parsed by the WHATWG URL constructor.
 */
function normalizeUrl(rawUrl: string, extraTrackingParams?: string[]): string;
```

### paragraph-segmenter.ts

```typescript
/**
 * Split text content into paragraph segments.
 *
 * Boundaries are detected at: 2+ consecutive newlines, <br>, <br/>,
 * <br />, </p>, and </div> tags. Segments shorter than minChars are
 * discarded as too short for meaningful fingerprinting.
 *
 * @param text - Raw text content (may contain HTML break/paragraph tags).
 * @param minChars - Minimum characters for a segment to be retained.
 * @returns Array of paragraph strings (trimmed, internal whitespace collapsed).
 *          Returns empty array if text is empty/whitespace-only.
 */
function segmentParagraphs(text: string, minChars: number): string[];
```

### fingerprinter.ts

```typescript
/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_32: number; // 2166136261

/** FNV-1a 32-bit prime. */
const FNV_PRIME_32: number; // 16777619

/**
 * Compute a non-cryptographic FNV-1a 32-bit hash of a normalized paragraph string.
 *
 * The input is expected to already be normalized (trimmed, whitespace-collapsed,
 * lowercased). Uses Math.imul for correct 32-bit multiplication and >>> 0 for
 * unsigned conversion.
 *
 * @param normalizedText - Pre-normalized paragraph text.
 * @returns Unsigned 32-bit integer fingerprint.
 */
function fnv1a32(normalizedText: string): number;

/**
 * Build a fingerprint set for an article by segmenting into paragraphs,
 * normalizing each, computing FNV-1a hashes, and collecting unique hashes.
 *
 * @param content - Full article text content.
 * @param minChars - Minimum paragraph length (passed to segmentParagraphs).
 * @returns Set of unique 32-bit paragraph fingerprints.
 */
function computeFingerprintSet(content: string, minChars: number): Set<number>;
```

### similarity-computer.ts

```typescript
/**
 * Compute the Jaccard similarity coefficient between two fingerprint sets.
 *
 * Jaccard = |A ∩ B| / |A ∪ B|
 *
 * Iterates over the smaller set for intersection counting: O(min(|A|, |B|)).
 * Returns 1.0 for identical sets, 0.0 for disjoint sets.
 * Returns 0.0 if both sets are empty.
 *
 * @param setA - First fingerprint set.
 * @param setB - Second fingerprint set.
 * @returns Similarity coefficient in [0.0, 1.0].
 */
function jaccardSimilarity(setA: Set<number>, setB: Set<number>): number;
```

### content-merger.ts

```typescript
/**
 * Remove exact-URL duplicates: group FingerprintedItems by normalizedUrl,
 * retain the highest-scoring item per group (ties → earliest originalIndex).
 *
 * @param items - FingerprintedItems with normalized URLs populated.
 * @returns Object with retained items array and count of removed items.
 */
function deduplicateByUrl(items: FingerprintedItem[]): {
  retained: FingerprintedItem[];
  removed: number;
};

/**
 * Remove exact-content duplicates: group by identical fingerprint set
 * (compared via sorted-array join), retain highest-scoring item per group.
 * Excluded items' URLs are added to retained items' mergedSources.
 *
 * @param items - FingerprintedItems with fingerprints populated.
 * @returns Object with retained items array, removed count, and
 *          mergedSources updates applied to retained items.
 */
function deduplicateExactContent(items: FingerprintedItem[]): {
  retained: FingerprintedItem[];
  removed: number;
};

/**
 * Merge near-duplicate items using Jaccard similarity and union-find.
 *
 * Algorithm:
 *  1. Compute pairwise Jaccard similarity for all N*(N-1)/2 pairs.
 *  2. Build edges where similarity >= threshold.
 *  3. Use union-find to form transitive groups.
 *  4. Per group: retain highest-scoring item (ties → earliest originalIndex),
 *     copy discarded items' URLs into retained item's mergedSources.
 *
 * @param items - FingerprintedItems (post exact-URL and exact-content dedup).
 * @param threshold - Jaccard similarity threshold (from DDConfig).
 * @returns Object with retained items array, removed count, and groups merged count.
 */
function mergeNearDuplicates(items: FingerprintedItem[], threshold: number): {
  retained: FingerprintedItem[];
  removed: number;
  groupsMerged: number;
};
```

### stats.ts

```typescript
/**
 * Create a new DedupStats accumulator with zero counts.
 * @returns Fresh DedupStats object.
 */
function createDedupStats(): DedupStats;

/**
 * Log the deduplication summary to stderr.
 * Format: `[DD] summary: input={N} url_dups_removed={N} content_dups_removed={N} near_dups_removed={N} empty_removed={N} errors={N} output={N} elapsed={ms}ms`
 *
 * @param stats - The completed DedupStats object.
 */
function logStats(stats: DedupStats): void;
```

### deduplicator.ts (module orchestrator)

```typescript
/**
 * Full deduplication pipeline entry point.
 *
 * Phases (in order):
 *  1. Filter empty-content items (log + remove).
 *  2. Normalize each item's URL (catch errors per item).
 *  3. Exact-URL dedup (retain highest score per canonical URL).
 *  4. Segment paragraphs + compute fingerprint sets.
 *  5. Exact-content dedup (identical fingerprint sets).
 *  6. Near-duplicate merge (Jaccard >= threshold via union-find).
 *  7. Assemble DeduplicatedItem[] with normalizedUrl, mergedSources, fingerprintCount.
 *  8. Log summary stats to stderr.
 *
 * @param items - ContentItems from the scrape stage.
 * @param config - Optional DDConfig override (defaults from env vars if omitted).
 * @returns Array of DeduplicatedItem (input is never mutated).
 */
function deduplicate(items: ContentItem[], config?: DDConfig): DeduplicatedItem[];
```

### types.ts (module-local)

```typescript
/** Re-exports from shared types for module-internal convenience. */
export type { DeduplicatedItem, DDConfig } from '../../shared/types/deduplicate.js';
export type { ContentItem } from '../../shared/types/content.js';

/** Module-local statistics accumulator. */
interface DedupStats { /* fields as defined in Data Models */ }

/** Module-internal working structure. */
interface FingerprintedItem { /* fields as defined in Data Models */ }

/** Maximum items before pairwise comparison cost warning (US-DD-006). */
const MAX_PAIRWISE_ITEMS: number; // 50
```

## Dependencies

This module requires **no external packages** beyond the project-wide dev dependencies. It uses only Node.js built-in APIs (`URL`, `URLSearchParams`) and internal shared utilities.

| Package | Version | Purpose |
|---------|---------|---------|
| _(none — no external runtime dependencies)_ | — | DD is a pure-algorithm module using only `URL`/`URLSearchParams` (Node.js built-in) and shared project utilities |

**Internal (project) dependencies consumed:**

| Internal Module | Symbols Used | Purpose |
|----------------|-------------|---------|
| `shared/types/content.ts` | `ContentItem` | Input type |
| `shared/types/deduplicate.ts` | `DeduplicatedItem`, `DDConfig` | Output + config types (this module's own shared type definitions) |
| `shared/utils/logger.ts` | `log` | Structured stderr logging (`.info`, `.warn`, `.error`) |
| `shared/config/index.ts` | `appConfig.ddConfig` | Default `DDConfig` from environment variables |

No packages from index.md's dependency table are assigned to the DD module — it is explicitly network-free, LLM-free, and framework-free. This is consistent with DC-DD-001 (no network), DC-DD-002 (no LLM), and the "pure function" constraint (DC-DD-003).

## File Generation Order

Files are listed in dependency order (types first, then leaf utilities, then the orchestrator, then the barrel export). All paths are relative to project root and use the EXACT directory names from the project layout.

| # | File Path | Purpose | Depends On |
|---|-----------|---------|------------|
| 1 | `src/shared/types/deduplicate.ts` | `DeduplicatedItem`, `DDConfig` shared type definitions | `shared/types/content.ts` (for `ContentItem` base) |
| 2 | `src/modules/deduplicate/types.ts` | Module-local `DedupStats`, `FingerprintedItem`, `MAX_PAIRWISE_ITEMS` constant; re-exports shared types | `shared/types/deduplicate.ts`, `shared/types/content.ts` |
| 3 | `src/modules/deduplicate/url-normalizer.ts` | `TRACKING_PARAM_BLOCKLIST` constant + `normalizeUrl()` — WHATWG URL API canonicalization | `shared/utils/logger.ts` |
| 4 | `src/modules/deduplicate/paragraph-segmenter.ts` | `segmentParagraphs()` — text splitting on newlines and HTML break/paragraph tags | _(none — pure string processing)_ |
| 5 | `src/modules/deduplicate/fingerprinter.ts` | `FNV_OFFSET_32`, `FNV_PRIME_32` constants + `fnv1a32()` + `computeFingerprintSet()` | `paragraph-segmenter.ts` |
| 6 | `src/modules/deduplicate/similarity-computer.ts` | `jaccardSimilarity()` — set intersection/union computation | _(none — pure set math)_ |
| 7 | `src/modules/deduplicate/content-merger.ts` | `deduplicateByUrl()`, `deduplicateExactContent()`, `mergeNearDuplicates()` + internal `UnionFind` class | `types.ts`, `similarity-computer.ts` |
| 8 | `src/modules/deduplicate/stats.ts` | `createDedupStats()`, `logStats()` | `types.ts`, `shared/utils/logger.ts` |
| 9 | `src/modules/deduplicate/deduplicator.ts` | `deduplicate()` — full pipeline orchestrator wiring all phases together | `types.ts`, `url-normalizer.ts`, `fingerprinter.ts`, `content-merger.ts`, `stats.ts`, `shared/utils/logger.ts`, `shared/config/index.ts` |
| 10 | `src/modules/deduplicate/index.ts` | Public barrel: re-exports `deduplicate()`, `normalizeUrl()`, `DeduplicatedItem`, `DDConfig` | `deduplicator.ts`, `url-normalizer.ts`, `shared/types/deduplicate.ts` |

### Test files (mirror structure under `tests/`)

| # | File Path | Purpose |
|---|-----------|---------|
| 11 | `tests/modules/deduplicate/url-normalizer.test.ts` | Tracking param removal, scheme/port/fragment/slash unification, query sort, malformed URL handling |
| 12 | `tests/modules/deduplicate/paragraph-segmenter.test.ts` | Newline splitting, HTML tag boundaries, min-char filtering, empty input |
| 13 | `tests/modules/deduplicate/fingerprinter.test.ts` | FNV-1a determinism, identical-paragraph collision, fingerprint set deduplication |
| 14 | `tests/modules/deduplicate/similarity-computer.test.ts` | Jaccard correctness: identical=1.0, disjoint=0.0, partial overlap, empty sets |
| 15 | `tests/modules/deduplicate/content-merger.test.ts` | Exact-URL dedup, exact-content dedup, near-dup union-find transitivity, score tie-breaking, mergedSources propagation |
| 16 | `tests/modules/deduplicate/deduplicator.test.ts` | End-to-end pipeline: empty input, single item, full dedup chain, error isolation, determinism, stats logging |

### Detailed Design Notes Per File

**url-normalizer.ts** — The built-in `TRACKING_PARAM_BLOCKLIST` contains exactly these 14 entries: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `gclid`, `fbclid`, `mc_cid`, `mc_eid`, `ref`, `_hsenc`, `_hsmi`, `igshid`, `si` (US-DD-001). The `DEDUP_EXTRA_TRACKING_PARAMS` env var provides a comma-separated extension list merged at config-load time (DC-DD-006). Normalization uses the WHATWG `URL` constructor (NFR-DD-006) — no string interpolation or eval. After parsing: set `protocol = 'https:'`, lowercase `hostname`, clear `hash`, remove `port` if it equals the default for the scheme, strip trailing `/` from `pathname` (when `pathname.length > 1`), iterate `searchParams` deleting any key in the blocklist, call `searchParams.sort()`, and return `url.toString()` (the WHATWG API automatically omits `?` when searchParams is empty).

**fingerprinter.ts** — FNV-1a 32-bit hash is implemented in pure TypeScript using `Math.imul(hash, FNV_PRIME_32)` for correct 32-bit multiplication and `hash >>> 0` for unsigned conversion. Text normalization before hashing: `.trim()`, `.replace(/\s+/g, ' ')`, `.toLowerCase()`. The `computeFingerprintSet` function delegates to `segmentParagraphs` then maps each paragraph through normalization + `fnv1a32`, collecting results into a `Set<number>` to deduplicate identical paragraphs within the same article (US-DD-005).

**content-merger.ts** — Contains an internal `UnionFind` class with `find()` (path compression) and `union()` (union by rank) for O(α(N)) amortized operations. Exact-content dedup uses fingerprint-set equality: two sets are equal iff same size and `setA` is a subset of `setB` (checked by iterating the smaller set). Near-duplicate merge builds an N×N pairwise matrix via `jaccardSimilarity()`, creates union edges for pairs ≥ threshold, then groups by connected components. Within each group, the representative is the item with max `score` (ties broken by `originalIndex` ascending). Discarded items' `item.url` values are pushed into the representative's `mergedSources` array.

**deduplicator.ts** — Orchestrates all phases sequentially. Constructs a fresh `DedupStats` at entry. If `config` is undefined, loads from `shared/config`. Each phase updates the stats counters. Per-item try/catch wraps each item through normalization + segmentation + fingerprinting; failed items are logged and skipped. After all phases, maps surviving `FingerprintedItem`s to `DeduplicatedItem` objects (shallow copy of ContentItem fields + `normalizedUrl`, `mergedSources`, `fingerprintCount`), calls `logStats()`, and returns. The entire function is synchronous (no async needed — pure CPU work). The elapsed time is measured via `performance.now()` at entry and exit.
