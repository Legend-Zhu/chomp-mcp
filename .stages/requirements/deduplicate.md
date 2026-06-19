# Requirements: Deduplicate and Denoise

## Overview
The Deduplicate and Denoise (DD) module eliminates redundant content from scraped search results to prevent noise from degrading downstream LLM synthesis quality. It performs two phases: (1) URL normalization that strips tracking parameters, unifies scheme and case, removes fragments, and sorts query parameters to produce a canonical URL form, and (2) content-level deduplication using paragraph fingerprinting and Jaccard similarity comparison to detect and merge near-duplicate articles, retaining only the highest-scoring representative. This module operates as a pure, network-free transformation step within the pipeline, receiving scraped content items and outputting a deduplicated, ranked set.

## User Stories

### US-DD-001: Remove Tracking Parameters from URLs
**As a** pipeline orchestrator, **I want** URLs to have tracking parameters stripped during normalization, **so that** the same article reached via different marketing links is recognized as identical.

**Acceptance Criteria:**
- WHEN a URL contains parameters matching the tracking blocklist (e.g., `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `gclid`, `fbclid`, `mc_cid`, `mc_eid`, `ref`, `_hsenc`, `_hsmi`, `igshid`, `si`) THEN the system SHALL remove those parameters entirely from the normalized URL
- WHEN a URL contains a parameter name that is not in the tracking blocklist THEN the system SHALL preserve that parameter and its value
- WHEN all query parameters of a URL are removed as tracking parameters THEN the system SHALL produce a URL with no trailing `?` character

### US-DD-002: Normalize URL Structure
**As a** pipeline orchestrator, **I want** URL scheme, hostname, fragment, and trailing slash to be unified, **so that** structurally identical URLs with cosmetic differences are treated as the same resource.

**Acceptance Criteria:**
- WHEN a URL uses the `http` scheme THEN the system SHALL convert it to the `https` scheme in the normalized form
- WHEN a URL hostname contains uppercase characters THEN the system SHALL convert the hostname to lowercase
- WHEN a URL contains a fragment identifier (e.g., `#section`) THEN the system SHALL remove the fragment
- WHEN a URL path ends with a trailing slash AND the path length is greater than one character THEN the system SHALL remove the trailing slash
- WHEN a URL contains multiple query parameters THEN the system SHALL sort the remaining (non-tracking) query parameters alphabetically by key
- WHEN a URL contains percent-encoded characters in the path THEN the system SHALL preserve the original encoding without double-decoding or re-encoding
- WHEN a URL contains a default port (80 for http, 443 for https) THEN the system SHALL omit the port from the normalized form

### US-DD-003: Detect and Remove Exact URL Duplicates
**As a** pipeline orchestrator, **I want** items with identical normalized URLs to be identified as exact duplicates, **so that** only one representative item per unique URL proceeds to content deduplication.

**Acceptance Criteria:**
- WHEN two or more content items produce identical normalized URLs THEN the system SHALL group them together as an exact-URL-duplicate set
- WHEN an exact-URL-duplicate set contains multiple items THEN the system SHALL retain only the item with the highest `score` value and discard the rest
- WHEN an exact-URL-duplicate set contains items with equal scores THEN the system SHALL retain the item that appeared first in the input order
- WHEN the system discards duplicate items THEN it SHALL log to stderr the count of items removed by exact-URL deduplication

### US-DD-004: Segment Content into Paragraphs
**As a** pipeline orchestrator, **I want** article text content to be segmented into discrete paragraphs, **so that** paragraph-level fingerprints can be computed for similarity comparison.

**Acceptance Criteria:**
- WHEN content text contains two or more consecutive newline characters THEN the system SHALL split the text at those boundaries into separate paragraph segments
- WHEN a paragraph segment contains fewer than `MIN_PARAGRAPH_CHARS` characters (default: 20) THEN the system SHALL discard that segment as too short for meaningful fingerprinting
- WHEN content text is empty or contains only whitespace THEN the system SHALL produce zero paragraph segments and flag the item for removal
- WHEN content text contains HTML-style break tags or `<p>` tags THEN the system SHALL treat those as paragraph boundaries in addition to newlines

### US-DD-005: Compute Paragraph-Level Content Fingerprints
**As a** pipeline orchestrator, **I want** each paragraph segment to be converted into a compact fingerprint hash, **so that** article similarity can be compared efficiently without storing full text.

**Acceptance Criteria:**
- WHEN a paragraph segment is provided THEN the system SHALL normalize the text by trimming whitespace, collapsing internal whitespace runs to single spaces, and converting to lowercase before hashing
- WHEN a normalized paragraph is provided THEN the system SHALL compute a non-cryptographic 32-bit hash (e.g., FNV-1a or xxHash32) as the fingerprint
- WHEN two identical normalized paragraphs are fingerprinted THEN the system SHALL produce identical fingerprint values
- WHEN an article is processed THEN the system SHALL produce a set (deduplicated) of all paragraph fingerprints for that article, hereafter called the article's fingerprint set
- WHEN the system computes a fingerprint set THEN it SHALL store the fingerprint set alongside the content item for downstream similarity comparison

### US-DD-006: Compute Pairwise Content Similarity
**As a** pipeline orchestrator, **I want** pairwise similarity scores computed between all remaining content items, **so that** near-duplicate articles can be identified for merging.

**Acceptance Criteria:**
- WHEN two content items' fingerprint sets are compared THEN the system SHALL compute the Jaccard similarity coefficient defined as the size of the intersection divided by the size of the union of the two fingerprint sets
- WHEN two content items have identical fingerprint sets THEN the system SHALL produce a similarity score of 1.0
- WHEN two content items have no overlapping fingerprints THEN the system SHALL produce a similarity score of 0.0
- WHEN the number of remaining content items after URL deduplication is N THEN the system SHALL compute at most N*(N-1)/2 pairwise comparisons
- WHEN N exceeds `MAX_PAIRWISE_ITEMS` (default: 50) THEN the system SHALL log a warning to stderr indicating that pairwise comparison cost is high

### US-DD-007: Merge Near-Duplicate Content Items
**As a** pipeline orchestrator, **I want** content items whose similarity exceeds the configurable threshold to be merged into a single representative, **so that** downstream synthesis receives only distinct perspectives.

**Acceptance Criteria:**
- WHEN the pairwise similarity score between two items is greater than or equal to `DEDUP_SIMILARITY_THRESHOLD` (default: 0.85) THEN the system SHALL classify those two items as near-duplicates
- WHEN a group of near-duplicate items is identified THEN the system SHALL retain only the item with the highest `score` value as the representative and discard the rest
- WHEN near-duplicate items have equal scores THEN the system SHALL retain the item that appeared first in the input order
- WHEN an item is near-duplicate to items in an already-formed group THEN the system SHALL add that item to the existing group rather than creating a new group
- WHEN the system discards a near-duplicate item THEN it SHALL copy any unique source URL from the discarded item into the retained item's `mergedSources` array for citation traceability
- WHEN the merge process completes THEN the system SHALL log to stderr the number of near-duplicate items removed and the number of groups merged

### US-DD-008: Detect and Remove Exact Content Duplicates
**As a** pipeline orchestrator, **I want** items with identical fingerprint sets (similarity = 1.0) to be detected as exact content duplicates before near-duplicate analysis, **so that** trivially identical articles are removed first with lower computational cost.

**Acceptance Criteria:**
- WHEN two content items have identical fingerprint sets THEN the system SHALL classify them as exact-content duplicates
- WHEN an exact-content-duplicate set contains multiple items THEN the system SHALL retain only the item with the highest score
- WHEN the system removes exact-content duplicates THEN it SHALL log to stderr the count removed
- WHEN exact-content duplicates are removed THEN the system SHALL exclude them from subsequent near-duplicate pairwise comparison to reduce computation

### US-DD-009: Output Deduplication Statistics
**As a** pipeline orchestrator, **I want** the deduplication module to emit a structured summary of its operations, **so that** observability logs provide insight into pipeline noise reduction.

**Acceptance Criteria:**
- WHEN the deduplication process completes THEN the system SHALL log to stderr a summary line containing: input count, exact-URL-duplicates removed, exact-content-duplicates removed, near-duplicates removed, output count
- WHEN the deduplication process removes zero items THEN the system SHALL still log the summary with zero counts
- WHEN the deduplication process encounters an error on a single item THEN the system SHALL log the error to stderr with the item's URL and continue processing remaining items without aborting

### US-DD-010: Configure Deduplication Parameters
**As a** system operator, **I want** the similarity threshold and minimum paragraph length to be configurable via environment variables, **so that** I can tune deduplication aggressiveness for different use cases.

**Acceptance Criteria:**
- WHEN the `DEDUP_SIMILARITY_THRESHOLD` environment variable is set to a value between 0.0 and 1.0 THEN the system SHALL use that value as the near-duplicate similarity threshold
- WHEN the `DEDUP_SIMILARITY_THRESHOLD` environment variable is not set THEN the system SHALL default to 0.85
- WHEN the `DEDUP_SIMILARITY_THRESHOLD` environment variable is set to a value outside the range [0.0, 1.0] THEN the system SHALL log a warning to stderr and fall back to the default value of 0.85
- WHEN the `MIN_PARAGRAPH_CHARS` environment variable is set to a positive integer THEN the system SHALL use that value as the minimum paragraph length for fingerprinting
- WHEN the `MIN_PARAGRAPH_CHARS` environment variable is not set THEN the system SHALL default to 20

### US-DD-011: Process Deduplication Pipeline End-to-End
**As a** pipeline orchestrator, **I want** a single entry function that accepts scraped content items and returns deduplicated items, **so that** the PL module can invoke deduplication as one atomic step.

**Acceptance Criteria:**
- WHEN the deduplicate function receives an array of content items (each containing at minimum: `url`, `content`, `score`) THEN the system SHALL execute the full pipeline: URL normalization → exact-URL dedup → paragraph segmentation → fingerprint computation → exact-content dedup → near-duplicate merge → return results
- WHEN the deduplicate function receives an empty array THEN the system SHALL return an empty array without error
- WHEN the deduplicate function receives a single item THEN the system SHALL return that single item after URL normalization without performing pairwise comparison
- WHEN the deduplicate function completes THEN each returned item SHALL include the fields: `normalizedUrl`, `content`, `score`, `mergedSources` (array of URLs from merged duplicates, may be empty), and `fingerprintCount` (integer)
- WHEN a content item has empty or null content text THEN the system SHALL remove that item and log a warning to stderr with the item's URL

## Business Goals

### BG-DD-001: Reduce Duplicate Content Ratio
- Description: Minimize the proportion of duplicate or near-duplicate content items that reach the LLM synthesis stage, as duplicates waste token budget and bias synthesis output.
- Metric: Duplicate reduction ratio = (input item count − output item count) / input item count, measured per pipeline invocation.
- Target: Achieve a duplicate reduction ratio of ≥ 30% on typical multi-source search queries (where the same article is commonly reposted across blogs/aggregators).

### BG-DD-002: Preserve Content Coverage
- Description: Ensure that genuinely distinct articles are not incorrectly merged, preserving the diversity of perspectives and facts available for synthesis.
- Metric: False-positive merge rate = count of non-duplicate pairs incorrectly classified as near-duplicates / total non-duplicate pairs, measured via offline evaluation on a labeled test set.
- Target: False-positive merge rate < 2% at the default similarity threshold of 0.85.

### BG-DD-003: Maintain Pipeline Throughput
- Description: Deduplication must not become a bottleneck in the overall pipeline, which targets < 30 seconds end-to-end for a web_search call with max_results=5.
- Metric: DD module wall-clock processing time for a typical input of 5 content items (each ≤ 8000 characters).
- Target: Processing time < 500 milliseconds for 5 items; < 2 seconds for 20 items.

## Non-Functional Requirements

### NFR-DD-001: Deduplication Latency
- Category: performance
- Description: The full deduplication pipeline (normalization + fingerprinting + pairwise comparison + merging) SHALL complete in under 500 ms for the typical workload of 5–8 content items with ≤ 8000 characters each.
- Priority: important

### NFR-DD-002: Pairwise Comparison Scalability
- Category: performance
- Description: The pairwise similarity computation SHALL use set-intersection operations on integer hash sets with O(min(|A|, |B|)) complexity per pair, avoiding full-text comparisons. For inputs exceeding 50 items, the module SHALL warn but continue without truncation.
- Priority: important

### NFR-DD-003: Deterministic Output
- Category: reliability
- Description: Given the same input items in the same order with the same configuration, the deduplication module SHALL produce identical output on every invocation. No randomization, timestamp-based logic, or non-deterministic iteration over hash maps SHALL affect the result ordering.
- Priority: critical

### NFR-DD-004: No False-Negative Content Loss
- Category: reliability
- Description: The module SHALL never discard a content item unless it has been positively identified as a duplicate of a retained item. Items with empty content SHALL be logged and removed with a warning, but items with valid content shall only be removed through the deduplication algorithms.
- Priority: critical

### NFR-DD-005: Memory Efficiency
- Category: performance
- Description: The module SHALL not retain full article text in memory beyond what is needed for output. Fingerprint sets SHALL use typed arrays or Sets of 32-bit integers. Peak memory for deduplication of 20 items shall not exceed 10 MB.
- Priority: important

### NFR-DD-006: URL Normalization Injection Safety
- Category: security
- Description: URL normalization SHALL use a standard URL parser (WHATWG URL API or equivalent) and SHALL NOT execute any string interpolation, eval, or dynamic code path based on URL content. Malformed URLs SHALL be caught and logged without crashing.
- Priority: critical

### NFR-DD-007: Graceful Degradation on Malformed Input
- Category: reliability
- Description: If any individual content item causes an exception during normalization, segmentation, or fingerprinting, the module SHALL catch the error, log the item URL and error message to stderr, skip that item, and continue processing the remaining items.
- Priority: important

## Design Constraints

### DC-DD-001: No Network Calls
- Description: The DD module SHALL make zero network requests. It operates exclusively on in-memory data passed from the SC (scrape-extract) module. No HTTP calls, DNS lookups, or external service invocations are permitted.
- Severity: critical

### DC-DD-002: No External LLM or AI Dependency
- Description: The DD module SHALL NOT call any LLM or embedding API for similarity detection. Deduplication is performed entirely via deterministic algorithms (hash-based fingerprinting + Jaccard similarity). This keeps the module zero-cost and testable in isolation.
- Severity: critical

### DC-DD-003: Pure Function Interface
- Description: The module's primary `deduplicate(items: ContentItem[], config?: DDConfig): ContentItem[]` function SHALL be a pure function with no side effects except stderr logging. It SHALL not mutate the input array or input objects; it SHALL return new objects for all output items.
- Severity: important

### DC-DD-004: TypeScript Strict Mode Compliance
- Description: All code in the DD module SHALL compile under TypeScript strict mode (`tsc --noEmit`) with zero errors. All function parameters, return types, and internal variables SHALL have explicit type annotations. The module SHALL export typed interfaces for `ContentItem`, `DeduplicatedItem`, and `DDConfig`.
- Severity: critical

### DC-DD-005: Configuration via Environment Variables Only
- Description: All configurable parameters (similarity threshold, minimum paragraph length, tracking parameter blocklist additions) SHALL be read from environment variables at module initialization time. No configuration files shall be required. Defaults SHALL be embedded in code.
- Severity: important

### DC-DD-006: Tracking Parameter Blocklist Extensibility
- Description: The default tracking parameter blocklist SHALL be defined as a constant array in code. Users SHALL be able to extend the list via the `DEDUP_EXTRA_TRACKING_PARAMS` environment variable (comma-separated values) without modifying source code.
- Severity: important