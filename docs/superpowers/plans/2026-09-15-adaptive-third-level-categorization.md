# Adaptive Third-Level Categorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add adaptive AI-inferred detail folders beneath useful subcategories in both manual and inferred category modes, while preserving two-level fallback behavior and browser/export parity.

**Architecture:** Keep the existing category/subcategory schema and classification contract as the first stage. After two-level reconciliation, group eligible subcategories, infer bounded detail schemas, classify only eligible bookmarks with an optional `detail_category`, then deterministically retain only splits with two or more detail folders containing at least two bookmarks each. Browser placement, HTML export, in-memory results, and reconnect recovery consume the optional field without persisting it as user configuration.

**Tech Stack:** React/Vite, JavaScript ES modules, Vitest, Chrome/Firefox Bookmarks APIs, Netscape bookmark HTML export, existing model/retry/cancellation infrastructure.

**Spec:** `docs/superpowers/specs/2026-09-15-adaptive-third-level-categorization-design.md`

## Global Constraints

- Detail inference applies in both inferred and manual category modes.
- A group is eligible only when it is a genuine subcategory with at least 6 reconciled bookmarks.
- Retained detail folders contain at least 2 bookmarks each, and a split retains at least 2 detail folders.
- Retain at most 4 detail folders per group and at most `floor(groupSize / 2)`.
- Detail-schema requests contain at most 12 groups and at most 60 evenly sampled bookmarks per group.
- Unknown, filler, empty, duplicate, parent-echoing, or path-like detail names never create folders.
- Detail enrichment failure falls back to the valid two-level result and does not fail the organization run.
- `detail_category` is run-scoped and must never be written to category settings or persisted inferred configuration.
- Flat chronological mode remains schema-free and must not call detail inference.
- Do not add dependencies, providers, user settings, or more than one new hierarchy level.

---

### Task 1: Add detail identity and deterministic reconciliation helpers

**Files:**
- Modify: `frontend/src/services/subcategoryIdentity.js`
- Modify: `frontend/src/services/reconcile.js`
- Test: `frontend/src/services/subcategory-pipeline.test.js`

**Interfaces:**
- Consumes: existing `canonicalKey`, `shouldCreateSubFolder`, and reconciled records with `category` and `sub_category`.
- Produces: `shouldCreateDetailFolder(category, subCategory, detailCategory)`, `groupEligibleDetailCandidates(classified)`, and `reconcileDetailCategories(classified, detailSchemas)`.

- [ ] **Step 1: Write failing eligibility and grouping tests.** Assert that genuine details pass, empty/sink/parent-echo values fail, groups with 6 records qualify, groups with 5 records do not, and `General` groups do not qualify.
- [ ] **Step 2: Run `cd frontend && npx vitest run src/services/subcategory-pipeline.test.js -t "detail|third-level"`; verify the new tests fail because the helpers do not exist.**
- [ ] **Step 3: Implement `shouldCreateDetailFolder` with trimmed case-insensitive comparisons. Reject `general`, `other`, `none`, `uncategorized`, `misc`, `miscellaneous`, `various`, either parent name, empty values, and names containing `/` or `\\`.**
- [ ] **Step 4: Implement `groupEligibleDetailCandidates` as a first-seen `Map` keyed by `${category.toLowerCase()}\\u0000${sub_category.toLowerCase()}`. Include only genuine subcategories with at least 6 records and preserve original records.**
- [ ] **Step 5: Implement `reconcileDetailCategories` without mutating input. Remove assignments with fewer than 2 records, clear all assignments unless at least 2 detail names survive, and return `{ classified, summary }` with `detailFoldersKept`, `detailedSubcategories`, and `groupsKeptAtTwoLevels`.**
- [ ] **Step 6: Run the focused tests again; cover one-detail collapse, two-detail retention, duplicate spelling, and sparse assignments.**
- [ ] **Step 7: Commit with `git add frontend/src/services/subcategoryIdentity.js frontend/src/services/reconcile.js frontend/src/services/subcategory-pipeline.test.js && git commit -m "feat(categorization): add adaptive detail reconciliation"`.**

---

### Task 2: Implement bounded AI detail-schema generation and validation

**Files:**
- Modify: `frontend/src/services/ai.js`
- Test: `frontend/src/services/schema-validation.test.js`
- Test: `frontend/src/services/subcategory-pipeline.test.js`

**Interfaces:**
- Consumes: existing `withRetry`, `callModel`, `canonicalKey`, and eligible groups from Task 1.
- Produces: `validateDetailSchema(response, requestedGroups)`, `buildDetailSchemaPrompt(groups)`, and `generateDetailSchemas(groups, apiKey, model, isCancelled, onRetry)`.

- [ ] **Step 1: Write failing tests for valid detail names, unknown parent pairs, duplicate/filler/echo/path names, the 4-name cap, and groups with fewer than 2 valid names.**
- [ ] **Step 2: Run `cd frontend && npx vitest run src/services/schema-validation.test.js src/services/subcategory-pipeline.test.js -t "detail schema|detail folder"`; verify failure.**
- [ ] **Step 3: Add and export these exact limits: `DETAIL_SCHEMA_GROUP_LIMIT = 12`, `DETAIL_SCHEMA_SAMPLE_LIMIT = 60`, `DETAIL_MIN_BOOKMARKS = 6`, `DETAIL_MIN_FOLDER_SIZE = 2`, and `DETAIL_MAX_FOLDERS = 4`.**
- [ ] **Step 4: Implement `validateDetailSchema` returning `{ ok, schemas, issues }`. Match only requested canonical parent pairs; normalize names; discard invalid values; cap each group to `Math.min(4, Math.floor(bookmarkCount / 2))`; omit invalid groups; set `ok` false only when no group is usable.**
- [ ] **Step 5: Implement `buildDetailSchemaPrompt` with at most 12 groups and 60 evenly sampled `{ title, url }` records per group. Require JSON `{ groups: [{ category, sub_category, detail_categories }] }`, short Title Case names, at least 2 meaningful groups, and no filler/path names.**
- [ ] **Step 6: Implement `generateDetailSchemas` with bounded batches, existing retry/JSON/cancellation handling, one correction retry per invalid batch, sibling-batch isolation, and an empty-map best-effort result when detail enrichment cannot be completed. Cancellation must still throw/return through the existing cancellation path.**
- [ ] **Step 7: Run the focused AI tests, including sampling, correction retry, invalid sibling isolation, and cancellation.**
- [ ] **Step 8: Commit with `git add frontend/src/services/ai.js frontend/src/services/schema-validation.test.js frontend/src/services/subcategory-pipeline.test.js && git commit -m "feat(ai): infer bounded third-level folder schemas"`.**

---

### Task 3: Add detail classification and organizer integration

**Files:**
- Modify: `frontend/src/services/ai.js`
- Modify: `frontend/src/services/organizer.js`
- Test: `frontend/src/services/organizer.test.js`
- Test: `frontend/src/services/subcategory-pipeline.test.js`

**Interfaces:**
- Consumes: Task 1 grouping/reconciliation, Task 2 detail schemas, existing `classifyBatch`, retries, and cancellation.
- Produces: optional `detail_category` records and organizer stats `detailFoldersCount` and `detailedSubcategories`.

- [ ] **Step 1: Write failing tests for `normalizeDetailClassification(entry, detailSchema)`, unknown-name clearing, inferred-mode end-to-end assignment, and manual-mode preservation of selected top-level categories.**
- [ ] **Step 2: Run `cd frontend && npx vitest run src/services/organizer.test.js src/services/subcategory-pipeline.test.js -t "detail|third-level"`; verify failure.**
- [ ] **Step 3: Implement `normalizeDetailClassification` to return approved spelling or `null`; never promote unknown values into proposals. Add a detail classifier prompt restricted to the approved detail names for each parent pair.**
- [ ] **Step 4: After existing `reconcileSubcategories`, log `Finding useful third-level groups...`, identify eligible groups, generate bounded detail schemas, classify only eligible bookmarks, and apply `reconcileDetailCategories`. No detail calls occur when no group qualifies.**
- [ ] **Step 5: Make detail-stage transport, parsing, and validation errors warnings that preserve the two-level result. Cancellation must stop the run through the existing cancellation result.**
- [ ] **Step 6: Initialize/finalize detail stats and sort final records by category, subcategory, detail category, then the selected bookmark sort. Keep flat date mode before this stage.**
- [ ] **Step 7: Run focused organizer tests for both modes, sparse fallback, cancellation, stats, and flat-date bypass.**
- [ ] **Step 8: Commit with `git add frontend/src/services/ai.js frontend/src/services/organizer.js frontend/src/services/organizer.test.js frontend/src/services/subcategory-pipeline.test.js && git commit -m "feat(organizer): enrich eligible groups with detail folders"`.**

---

### Task 4: Create three-level browser folders and preserve export parity

**Files:**
- Modify: `frontend/src/services/bookmarks.js`
- Modify: `frontend/src/services/bookmarks_export.js`
- Modify: `frontend/src/services/organizer.js`
- Test: `frontend/src/services/bookmarks.test.js`
- Test: `frontend/src/services/bookmarks_export.test.js`

**Interfaces:**
- Consumes: `detail_category` records and `shouldCreateDetailFolder`.
- Produces: browser and Netscape HTML paths `Category/Subcategory/Detail` with two-level fallback.

- [ ] **Step 1: Write failing browser mock tests asserting detail folders are parented by the subcategory and unsplit records remain directly under the subcategory.**
- [ ] **Step 2: Write failing export tests asserting nested `H3`/`DL` output, no literal `General` detail folder, and isolation of same-named details under different parents.**
- [ ] **Step 3: Run `cd frontend && npx vitest run src/services/bookmarks.test.js src/services/bookmarks_export.test.js -t "detail|third-level|nested"`; verify failure.**
- [ ] **Step 4: Extend browser placement after subcategory resolution. Use a cache key containing the parent folder ID and detail name, apply `shouldCreateDetailFolder`, and set the bookmark destination to the detail folder only for valid details.**
- [ ] **Step 5: Extend organizer placement with the same path rule while preserving cancellation and failed-move accounting.**
- [ ] **Step 6: Extend export grouping to category → subcategory → detail using `Map`s. Emit detail folders only for valid details and keep root bookmarks at the subcategory level otherwise. Preserve escaping, URL sanitization, dates, icons, and flat mode.**
- [ ] **Step 7: Run placement/export tests and verify parent IDs, hierarchy, fallback, and security cases pass.**
- [ ] **Step 8: Commit with `git add frontend/src/services/bookmarks.js frontend/src/services/bookmarks_export.js frontend/src/services/organizer.js frontend/src/services/bookmarks.test.js frontend/src/services/bookmarks_export.test.js && git commit -m "feat(bookmarks): write inferred detail folders"`.**

---

### Task 5: Preserve detail results through background recovery and UI reporting

**Files:**
- Modify: `frontend/src/background/jobRunner.js`
- Modify: `frontend/src/background/index.js`
- Modify: `frontend/src/components/Organizer.jsx`
- Test: `frontend/src/background/jobRunner.test.js`
- Test: `frontend/src/background/index.test.js`
- Test: `frontend/src/components/Organizer.test.jsx`

**Interfaces:**
- Consumes: optional `detail_category`, detail stats/logs, and existing transient result lifecycle.
- Produces: reconnect-safe completed results retaining detail assignments without settings leakage.

- [ ] **Step 1: Write failing tests with a result containing `category`, `sub_category`, and `detail_category`; assert `GET_RESULTS` preserves it while settings payloads contain no generated detail fields.**
- [ ] **Step 2: Run `cd frontend && npx vitest run src/background/jobRunner.test.js src/background/index.test.js src/components/Organizer.test.jsx -t "detail|reconnect|GET_RESULTS"`; verify failure.**
- [ ] **Step 3: Audit state cloning and GET_RESULTS/recovery paths. Preserve `detail_category` in transient results; keep `JOB_ACK`, `GET_STATUS`, `GET_RESULTS`, and `JOB_RESULTS_UNAVAILABLE` unchanged and keep generated hierarchy out of settings writes.**
- [ ] **Step 4: Display detail counts/logs and ensure download handlers pass the optional field into `downloadBookmarks`.**
- [ ] **Step 5: Run focused background/UI tests and verify reconnect, download, and persistence-boundary assertions pass.**
- [ ] **Step 6: Commit with `git add frontend/src/background/jobRunner.js frontend/src/background/index.js frontend/src/components/Organizer.jsx frontend/src/background/jobRunner.test.js frontend/src/background/index.test.js frontend/src/components/Organizer.test.jsx && git commit -m "feat(recovery): retain inferred detail folders across reconnects"`.**

---

### Task 6: Complete verification and update documentation

**Files:**
- Verify: all implementation/test files from Tasks 1–5
- Modify if needed: `README.md`, `TESTING.md`

- [ ] **Step 1: Run `cd frontend && npm test`; require zero failures.**
- [ ] **Step 2: Run `npm run lint`, `npm run build:chrome`, and `npm run build:firefox`; require zero lint errors and successful bundles.**
- [ ] **Step 3: Run the targeted seven-file acceptance suite covering schema validation, pipeline, organizer, browser/export, background, and Organizer UI tests.**
- [ ] **Step 4: Inspect `rg -n "detail_category|detail_categories" src` and confirm matches are run-scoped; no settings persistence includes generated fields.**
- [ ] **Step 5: Update README/TESTING only if needed to document both modes, the six-bookmark eligibility threshold, two-bookmark minimum, and two-level fallback. If changed, commit separately with `docs: describe adaptive detail folders`.**
- [ ] **Step 6: Run `git diff --check`, `git status --short`, and `git log --oneline -10`; confirm no generated artifacts or unrelated files are present.**

---

### Task 7: Review, package, and update PR #70

**Files:**
- Generate: `frontend/dist/bookmark-organizer-chrome-v1.4.0.zip`
- Generate: `frontend/dist/bookmark-organizer-firefox-v1.4.0.zip`
- Generate: `frontend/dist/bookmark-organizer-firefox-source-v1.4.0.zip`

- [ ] **Step 1: Request an independent review of the complete diff, requiring checks for both modes, thresholds, fallback, persistence boundaries, recovery, browser/export parity, and flat-date bypass.**
- [ ] **Step 2: Run `cd frontend && npm run package:all`; verify all three versioned archives and manifest versions.**
- [ ] **Step 3: Run manual Chrome and Firefox smoke checks with a collection large enough to produce two detail folders, plus sparse-group, manual-mode, inferred-mode, reconnect/download, and flat-date cases.**
- [ ] **Step 4: Update PR #70 with the three-level hierarchy, adaptive thresholds, fallback behavior, test counts, package paths, and smoke-test results.**
- [ ] **Step 5: Only after every automated and manual check passes, create the local annotated tag `v1.4.0-rc.1`. Do not push the tag without explicit authorization.**
