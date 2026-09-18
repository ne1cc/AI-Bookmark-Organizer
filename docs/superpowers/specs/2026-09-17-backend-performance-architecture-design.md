# Backend Performance Architecture Design

Date: 2026-09-17 · PR: #76 (`t3code/optimize-backend-performance`)

This document records the performance architecture of the backend pipeline
(background service worker → `OrganizerService` → AI calls → bookmark writes),
the reasoning behind each tuning constant, and where to look when something
goes wrong. Read it before debugging slow runs, missing folders, or odd
progress behavior.

## Pipeline overview

```text
jobRunner.startJob (background service worker)
  └─ OrganizerService.start
       ├─ read + dedupe (URL index; doomed duplicates deferred)
       ├─ Phase 1: schema design        ← 1-2 AI calls, sampled input
       ├─ Phase 2: classification       ← 4-worker pool, batches of 30-50
       ├─ reconcile subcategories       (local)
       ├─ Phase 3: detail schemas       ← 3-worker pool, 12 groups/request
       ├─ Phase 4: detail classification← 4-worker pool, 50 records/chunk
       ├─ reconcile detail categories   (local)
       └─ writes: snapshot → folders → moveItems(15/chunk)
                  → removeDoomedDuplicates(15/chunk) → reorderFolder
```

## 1. Schema sampling (`ai.js:505`)

**Both** inferred-category and manual-category schema design build the prompt
from an evenly spaced sample of `SCHEMA_SAMPLE_LIMIT = 400` bookmarks
(`sampleForSchema`, `ai.js:522`), never the whole collection.

### Why (the bug this fixed)

Before this change, inference mode serialized the **entire** collection into
the schema prompt (a behavior mandated by the 2026-09-14 auto-generated
categories spec, which predates large-library testing). A 5-10k bookmark
library produced a ~500K-token request: slow, expensive, and over the context
window of most OpenRouter models. The spec's intent — "don't lose the full
collection's topical variety" — is preserved by even spacing (exports are
grouped by folder, so spacing samples every folder) at a fraction of the cost.

### Why 400 and not larger

- Each sampled bookmark costs ~30-40 prompt tokens; 400 ≈ 15K input tokens.
- 15K + instructions stays inside even the smallest OpenRouter model context
  windows (32K). 800+ would risk hard failures on those models.
- Schema design runs only 1-2 times per job, so doubling the sample doubles a
  negligible cost while doubling topic coverage.
- `retrySchemaOnSmallerSample` (`organizer.js:500`) uses
  `floor(SCHEMA_SAMPLE_LIMIT / 2)` = **200** as its reduced retry, so
  truncation-prone runs fall back to the old, proven default.

### Safety net for themes the sample misses

Classification prompt rule 3 lets the model propose **one** new subcategory
per batch when ≥3 bookmarks share a theme no schema subcategory captures;
`reconcileSubcategories` then merges/folds proposals. A niche topic absent
from the sample is therefore not lost — it just arrives as a proposal.

### Debugging

| Symptom | Look at |
| --- | --- |
| Inferred schema misses a niche category | Normal at any sample size; check the "Subcategories: +N AI-created" log — proposals usually absorb it. If frequent, raise `SCHEMA_SAMPLE_LIMIT` (keep ≤ ~500). |
| "sample of 400 of N" log absent | Collection ≤ 400, no sampling happens — correct. |
| Schema truncated (`finish_reason: length`) | Corrective round-trip runs once; then `retrySchemaOnSmallerSample` (200); then curated fallback. Check logs for "CORRECTION REQUIRED" / "smaller sample". |

## 2. Detail-phase concurrency

Two independent worker pools replaced fully sequential loops:

- **Detail-schema generation** — `generateDetailSchemas` (`ai.js:1077`,
  `DETAIL_SCHEMA_CONCURRENCY = 3`): batches of `DETAIL_SCHEMA_GROUP_LIMIT`
  (12) groups each, each group sampled to `DETAIL_SCHEMA_SAMPLE_LIMIT` (60).
  Heavy requests, so a smaller pool.
- **Detail classification** — `organizer.js:11`
  (`DETAIL_CLASSIFICATION_CONCURRENCY = 4`): a flat task list of
  (group, chunk) pairs, 50 records per chunk, matching the main
  classification pool size.

### Invariants to preserve when touching this code

1. **Task order is index order.** Tasks are dispatched `detailTaskIdx++` in a
   synchronous while-loop, so the `detailCalls` order in tests is
   `[50, 50, 20]`-style deterministic. Do not await between dispatch and the
   classify call.
2. **`detailed` is a sparse array of per-task arrays.** Failed tasks leave
   holes; the assignment map is built with
   `detailed.flat().filter(Boolean)` (`organizer.js:1190`). **`Array#flat`
   drops holes; `map` alone does not** — mapping without flattening once
   produced a one-entry map keyed `\0\0ordinal:url:` and nulled every detail
   assignment. If detail folders silently disappear, check this line first.
3. **Cancellation rethrows; other errors count and continue.** A cancelled
   chunk throws (worker → `Promise.all` rejects → outer catch returns null);
   a failed chunk increments `detailClassificationFailures` and its group
   stays at two levels.
4. **Reconciliation needs ≥2 folders with ≥2 bookmarks per parent**
   (`reconcile.js`, `DETAIL_MIN_FOLDER_SIZE`). A group whose records all land
   in one detail folder is *correctly* collapsed to two levels — this is not
   a classification bug.

### Debugging

| Symptom | Look at |
| --- | --- |
| More 429s than before | Pools are separate (4 + 3 + retry traffic don't coordinate). `withRetry` backoff handles it; if sustained, lower `DETAIL_*_CONCURRENCY`. |
| Group stuck at two levels | Check the "skipped" / "partial failures" warnings; then reconciliation minimums (point 4 above). |
| Detail assignments all null | The `.flat()` invariant (point 2). |

## 3. Write-path chunking

- `moveItems`: 15 concurrent moves per chunk (unchanged).
- `removeDoomedDuplicates` (`organizer.js:352`): now the same 15-per-chunk
  pattern instead of one sequential `removeBookmark` per duplicate. Errors
  per node are collected in `failedMoves`; chunks are sequential.

## 4. Job-state throttling (`jobRunner.js:11, 65-89`)

`emitState()` / `flushState()` coalesce state persistence and port broadcasts:

- **Non-terminal** progress/log events schedule a single 250ms flush
  (`STATE_FLUSH_DELAY_MS`); bursts of events collapse into one
  `chrome.storage.session` write and one STATUS_UPDATE per port.
- **Terminal** statuses (`complete`, `error`, `idle`) flush immediately and
  cancel any pending flush, so a terminal state is never followed by a stale
  duplicate.
- In-memory state (`currentJob`) is always synchronous — `getState()` never
  lags; only persistence and port fan-out are throttled.
- The separate `'log'` port event is gone (nothing emits it); log lines
  travel inside STATUS_UPDATE payloads. Panel terminal/log streams update at
  a ~4fps cadence by design.

### Persistence gates (unchanged, but relevant)

`persistSessionSnapshot` and the `organizedData` writes are gated by
`persistJobState = flatDateSort || !inferCategories` — **inferred-category
runs persist nothing**, so an empty `chrome.storage.session` after an
inferred run is correct, not a bug.

### Debugging

| Symptom | Look at |
| --- | --- |
| Progress bar moves in steps | By design (250ms coalescing). |
| Storage write counts in tests | Advance fake timers by 250ms; terminal paths write immediately. |
| Status looks stale after error/complete | `flushState()` runs on every terminal path; a stale state means a path was missed — check that every status mutation ends in `flushState()` or `emitState()`. |

## Not implemented (post-release candidates)

- **Adaptive request timeout** — `REQUEST_TIMEOUT_MS = 30000` (`ai.js`) is
  fixed; pro models generating 8-16K tokens can exceed it and burn retries on
  false aborts. Scale with `maxTokens`/model tier.
- **Concurrent `reorderFolder`** — folders are independent; order within a
  folder must stay sequential.
- **Shared adaptive rate-limit limiter** — one semaphore across all AI calls
  that ramps down on 429 and up when healthy, instead of independent pools.
