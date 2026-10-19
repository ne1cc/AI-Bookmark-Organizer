# Resume Interrupted Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AI organize run that is interrupted (worker killed, browser restart, or an API error after retries) can be resumed from its last saved stage instead of starting over.

**Architecture:** A small storage module (`runCheckpoint.js`) owns split `chrome.storage.local` keys. `OrganizerService` writes checkpoints at stage boundaries and, via `resume(checkpoint)`, skips work already saved. The worker resumes through the existing `START_JOB` path with `resume: true`; the panel shows a Resume card and falls back to an in-panel resume exactly like a normal start.

**Tech Stack:** React 19 (JSX), Vite, Vitest + Testing Library, Chrome MV3 extension APIs (`chrome.storage.local`).

**Spec:** `.claude/memory/specs/2026-10-19-resume-interrupted-runs-design.md`

## Global Constraints

- Storage keys exactly: `runCheckpoint`, `runCheckpoint:input`, `runCheckpoint:batch:<n>`, `runCheckpoint:classified`; header `version: 1`.
- Never store the API key or model in any checkpoint key.
- Resume uses the checkpoint's settings and the **current** API key and model.
- Only AI runs (`runAI`) are checkpointed; flat date-sort runs are not.
- One checkpoint at a time; a new run clears it (after a confirm in the panel).
- No new dependencies. Match surrounding style (4-space indent, existing comment density).
- Deviation from spec (approved at plan review): no `RESUME_JOB` message — `START_JOB` carries `resume: true`, reusing the ACK + in-panel fallback machinery.
- Copy, verbatim: card title `Your last run stopped before finishing`; Discard confirm `Discard the saved progress of your last run?`; new-run confirm `Starting over discards your last run's saved progress.`; first resume log line `Resuming: skipping N finished batches` (N = saved batch count).

## Review Focus

1. A bookmark deleted between interruption and resume → its move fails, is listed in `failedMoves`, and the run still completes (Task 3).
2. A storage write fails (quota, `chrome.runtime.lastError`) mid-run → the run continues; the failure is logged once, never thrown (Task 1).
3. A half-written checkpoint (header present, `runCheckpoint:input` missing) → `load()` returns `null` and clears all keys; no Resume card (Task 1).
4. Resume clicked while a run is already processing, or twice quickly → only one run starts (Task 6).
5. Manual categories edited after the interruption → resume uses the saved categories, not the panel's current list (Task 5).

---

### Task 1: Checkpoint store

**Files:**
- Create: `frontend/src/services/runCheckpoint.js`
- Test: `frontend/src/services/runCheckpoint.test.js`

**Interfaces:**
- Produces: `createRunCheckpoint(area = chrome.storage.local, { log } = {}) => store` with:
  - `create(header, input): Promise<void>` — clears old keys, writes header (`version: 1`, `id`, `startedAt`, `updatedAt` added) and input.
  - `markStage(patch: object): Promise<void>` — shallow-merges into the in-memory header, bumps `updatedAt`, writes the header.
  - `saveBatch(n: number, results: object[]): Promise<void>` — writes `runCheckpoint:batch:<n>`, sets `header.batchesDone = number of distinct saved batch indexes`, writes header.
  - `saveClassified(rows: object[], stage: 'rehomed' | 'enriched' | 'reviewed', extra = {}): Promise<void>` — writes rows, then `markStage({ stage, ...extra })`.
  - `recordFailure(reason: string): Promise<void>` — `markStage({ failure: { reason, at: Date.now() } })`.
  - `load(): Promise<{ header, input, batches: Map<number, object[]>, classified: object[] | null } | null>`
  - `loadHeader(): Promise<object | null>` — reads only `runCheckpoint`.
  - `clear(): Promise<void>` — removes `runCheckpoint` and every `runCheckpoint:*` key (use `area.get(null)` to enumerate).
- Produces: `describeCheckpoint(header) => { title: string, source: string, progress: string, reason: string | null }` (pure; used by Task 6).

The store keeps the header in memory and writes a full copy on each change, so concurrent batch saves (the classify pool) cannot lose `batchesDone` updates.

- [ ] **Step 1: Write the failing tests** (fake area: an object with `get/set/remove` over a `Map`, callback style, optional `lastError` injection)
  - `round-trips header, input, batches and classified` — after `create`, `saveBatch(0,[a])`, `saveBatch(2,[b])`, `saveClassified(rows,'rehomed')`, `load()` returns `header.batchesDone === 2`, `batches.get(2)` equals `[b]`, `classified` equals rows, `header.stage === 'rehomed'`, `header.version === 1`.
  - `never stores apiKey or model` — `create({ settings: { apiKey: 'k', selectedModel: 'm', categories: [] } }, input)` → `JSON.stringify(all stored values)` contains neither `'k'` as `apiKey` nor `selectedModel`; `create` strips both keys from `settings`.
  - `clear removes every runCheckpoint key and nothing else` — an unrelated `organizedMeta` key survives.
  - `unknown version loads as null and clears` — seed header `{ version: 0 }` → `load()` is `null`, area empty of checkpoint keys.
  - `half-written checkpoint loads as null and clears` (Review Focus 3) — header present, no input key.
  - `write failures are logged once and never throw` (Review Focus 2) — area whose `set` reports `lastError` on every call: `saveBatch` resolves, `log` called exactly once.
  - `describeCheckpoint` cases: `{ batchCount: 60, batchesDone: 41, planApproved: true }` → progress `Folder plan approved · classified 41 of 60 batches`; `stage: 'reviewed'` → `Organized folders reviewed`; `placementStarted: true` → `Folders built · moving bookmarks into place`; `failure.reason` passed through; `source` is `${settings.sourceLabel} · started ${toLocaleString(month short, day numeric, hour numeric, minute 2-digit)}`; title is the Global Constraints copy.

- [ ] **Step 2: Run to verify failure**
  Run: `cd frontend && npx vitest run src/services/runCheckpoint.test.js`
  Expected: FAIL — cannot resolve `./runCheckpoint`.

- [ ] **Step 3: Implement `createRunCheckpoint` and `describeCheckpoint` in `frontend/src/services/runCheckpoint.js`**
  Progress precedence: `placementStarted` → `stage` (`reviewed`: `Organized folders reviewed`, `enriched`: `Detail folders built`, `rehomed`: `All bookmarks classified`) → batches line (prefixed `Folder plan approved · ` when `planApproved`) → `Folder plan approved` → `Folder plan designed` (has `schema`) → `Bookmarks read`.

- [ ] **Step 4: Run to verify pass** — same command, all PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: checkpoint store for resumable runs"`

### Task 2: Write checkpoints during a run

**Files:**
- Modify: `frontend/src/services/organizer.js` (`constructor` ~266, `onProgress` wrapper ~270, `start` ~680, `cancelled` ~706, `classifyAll` ~1036, `rehomeLoose`/`enrichDetails`/`reviewResult` call sites in `runAI` ~1547, `placeInBrowser` ~1360, `finishAI` ~1431)
- Test: `frontend/src/services/organizer.test.js`

**Interfaces:**
- Consumes: Task 1 store.
- Produces on `OrganizerService`: `checkpoint` (store or `null`, default `null` → every write is a no-op), `checkpointSettings` (object or `null`, set by the runner; becomes `header.settings`).

Write points (all awaited, all skipped when `checkpoint` is null or `flatDateSort`):
- `start()` → after `dedupe`, before `runAI`: `create({ source: isBrowserMode ? 'browser' : 'file', settings: checkpointSettings }, { links, duplicatesRemoved, doomedDuplicates: this.doomedDuplicates || [], dateSpan: this.dateSpan })`.
- After `designSchema` → `markStage({ schema })`; after `reviewPlan` → `markStage({ schema: approved, planApproved: true })`.
- `classifyAll` start → `markStage({ batchSize, batchCount })`; each batch's final result → `saveBatch(idx, result)`.
- After `rehomeLoose` / `enrichDetails` / `reviewResult` → `saveClassified(rows, 'rehomed' | 'enriched' | 'reviewed')`; the `reviewed` save passes `extra = { categoryAliases: [...this.categoryAliases] }`.
- `placeInBrowser`, before `prepareSnapshot` → `markStage({ labels, placementStarted: true })`; file mode before `writeFile` → `markStage({ labels })`.
- `finishAI` and `cancelled()` → `clear()`.
- `onProgress` with `status: 'error'` → `recordFailure(message)`; `start()` wraps `runAI` so a thrown non-cancel error also calls `recordFailure(err.message)` before rethrowing.

- [ ] **Step 1: Write failing tests** (fake store recording calls, AI functions mocked as in existing `classifyBatch` tests)
  - `writes the checkpoint before the first AI call` — `create` call index < first `generateSchema`/`generateInferredSchema` call.
  - `saves every classified batch and the stage outputs` — 3 batches → `saveBatch` for 0,1,2; `saveClassified` stages in order `rehomed, enriched`.
  - `clears on finish and on cancel`; `records the reason on an error` — schema mock rejects with 503 error → `recordFailure` called with its message and the store is not cleared.
  - `flat date-sort runs write nothing`.

- [ ] **Step 2: Run** `npx vitest run src/services/organizer.test.js -t checkpoint` → FAIL.
- [ ] **Step 3: Implement the write points above.**
- [ ] **Step 4: Run the full suite** `npx vitest run` → all PASS (existing tests pass `checkpoint: null` implicitly).
- [ ] **Step 5: Commit** — `git commit -m "feat: save organize progress at each stage"`

### Task 3: `OrganizerService.resume`

**Files:**
- Modify: `frontend/src/services/organizer.js`
- Test: `frontend/src/services/organizer.test.js`

**Interfaces:**
- Consumes: `load()` result shape from Task 1.
- Produces: `OrganizerService.resume(checkpoint): Promise<results | null>` — same return contract as `start()`.

`resume` restores `this.doomedDuplicates`, `this.dateSpan`, `this.categoryAliases` (from `header.categoryAliases`), logs `Resuming: skipping N finished batches`, then runs `runAI({ links: input.links, duplicatesRemoved: input.duplicatesRemoved, isBrowserMode: header.source === 'browser' })` with `this.resumeState = checkpoint`. In `runAI` each stage consults `resumeState`:
- `header.schema` → skip `designSchema`; `header.planApproved` → skip `reviewPlan`, else review the saved schema.
- `classifyAll` uses `header.batchSize` when present and skips indexes in `batches`.
- Stage order `rehomed < enriched < reviewed`: start from `classified` at the saved stage, skipping `reconcileClassified` and every stage up to and including it.
- `header.labels` replaces freshly computed labels; `header.placementStarted` skips `prepareSnapshot`.

- [ ] **Step 1: Write failing tests**
  - `resume with an approved plan makes no schema call`.
  - `resume with 41 of 60 batches saved classifies exactly 19 batches, with the saved batch size after switching to a Pro model` — construct with model containing `pro`, header `batchSize: 25`; assert `classifyBatch` calls 19 and each batch length ≤ 25.
  - `a run stopped during plan review reopens the review with the saved schema` — `planReviewer` receives the saved schema; no schema generation.
  - `resume after review keeps result-review renames` — `header.categoryAliases: [['New','Old']]` → final category ranking treats `New` as `Old` (assert folder order equals the non-resumed run's).
  - `placement resume skips the backup and reuses the saved folder name` — `snapshotProvider` not called; `findOrCreateFolder` called with `header.labels.rootFolderTitle`.
  - `a bookmark deleted since the interruption is reported and the run completes` (Review Focus 1) — `moveBookmark` rejects for one id → result returned, `stats.failedMoves` contains its title.

- [ ] **Step 2: Run** `npx vitest run src/services/organizer.test.js -t resume` → FAIL.
- [ ] **Step 3: Implement `resume` and the `resumeState` checks.**
- [ ] **Step 4: Run** `npx vitest run` → all PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: resume an organize run from its checkpoint"`

### Task 4: Worker resumes through `START_JOB`

**Files:**
- Modify: `frontend/src/background/jobRunner.js` (`startJob` ~175, organizer setup ~251–325)
- Modify: `frontend/src/background/index.js` (`START_JOB` case ~104)
- Test: `frontend/src/background/jobRunner.test.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `jobRunner.startJob(config, parsedBookmarks = null, { resume = false } = {})`. With `resume`, it `load()`s the checkpoint; if `null`, posts the job error `No saved run to resume.`; otherwise builds the config as `{ ...checkpoint.header.settings, apiKey: config.apiKey, selectedModel: config.selectedModel }`, passes `checkpoint.input.links` as `parsedBookmarks` when `header.source === 'file'`, and calls `organizer.resume(checkpoint)` instead of `start()`.
- Every AI run sets `organizer.checkpoint = createRunCheckpoint()` and `organizer.checkpointSettings = { categories, inferCategories, subfolderTarget, sortAlphabetically, removeDuplicates, cleanTitles, dateSortOrder, schemaSortOrder, reviewFolders, autoImport, sourceLabel }` (`sourceLabel` from `config`).
- `index.js`: `START_JOB` passes `{ resume: Boolean(msg.payload?.resume) }`.

- [ ] **Step 1: Failing tests** — `resume: true` with a saved checkpoint calls `resume` (not `start`) with current key + model and saved categories; missing checkpoint → status `error`, message `No saved run to resume.`; a normal start sets `checkpointSettings` without `apiKey`.
- [ ] **Step 2: Run** `npx vitest run src/background` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: resume runs in the background worker"`

### Task 5: Panel start path can resume

**Files:**
- Modify: `frontend/src/components/Organizer.jsx` (`startProcess` ~1148–1460)
- Test: `frontend/src/components/Organizer.test.jsx`

**Interfaces:**
- Consumes: Task 1 store, Task 4 `START_JOB` `resume` flag.
- Produces: `startProcess({ resumeFrom } = {})` — `resumeFrom` is a loaded checkpoint. The run config becomes `{ ...current panel config, ...resumeFrom.header.settings }` with the current `apiKey` and `selectedModel`; the `START_JOB` payload adds `resume: true` and `config.sourceLabel` (current file name, or `Browser bookmarks`). The in-panel fallback sets the same `checkpoint`/`checkpointSettings` on its `OrganizerService` and calls `resume(resumeFrom)`.
- A normal start (no `resumeFrom`) with a saved header asks `window.confirm('Starting over discards your last run\'s saved progress.')`; cancel aborts, OK clears the checkpoint then starts.

- [ ] **Step 1: Failing tests**
  - `resume sends START_JOB with resume, current key and model, and the saved categories` (Review Focus 5) — panel categories `['A']`, checkpoint categories `['Saved']` → payload `config.categories` is `['Saved']`, `apiKey`/`selectedModel` are the panel's, `resume: true`.
  - `falls back to an in-panel resume without an ACK` — no ACK → `OrganizerService.prototype.resume` called once.
  - `starting a new run with a saved checkpoint asks first` — confirm `false` → no `START_JOB`; `true` → checkpoint cleared and `START_JOB` without `resume`.
- [ ] **Step 2: Run** `npx vitest run src/components/Organizer.test.jsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: panel start path can resume a saved run"`

### Task 6: Resume card

**Files:**
- Create: `frontend/src/components/ResumeCard.jsx`
- Modify: `frontend/src/components/Organizer.jsx` (mount effect ~480–515; interrupted-notice render ~3077)
- Test: `frontend/src/components/Organizer.test.jsx`

**Interfaces:**
- Consumes: `describeCheckpoint`, `loadHeader`, `load`, `clear` (Task 1); `startProcess({ resumeFrom })` (Task 5).
- Produces: `<ResumeCard header canResume onResume onDiscard />` — `role="region"` `aria-label="Saved run"`; renders the four `describeCheckpoint` lines (reason line only when present); buttons `Resume` (disabled when `!canResume`, with hint `Enter your API key to resume.`) and `Discard`.

Organizer: load the header on mount and whenever `status` becomes `idle` or `error`; render the card instead of the interrupted notice when a header exists and `status !== 'processing'`. Resume: `load()` then `startProcess({ resumeFrom })`; disable the button while `status === 'processing'` or a resume is starting. Discard: `window.confirm('Discard the saved progress of your last run?')` → `clear()` → hide card.

- [ ] **Step 1: Failing tests**
  - `shows the saved run with its progress line` — header with 41/60 → text `classified 41 of 60 batches` and the reason.
  - `Resume is disabled without an API key`.
  - `Resume starts only one run when clicked twice` (Review Focus 4) — two clicks → one `START_JOB`.
  - `Discard asks, then removes the card`.
  - `the interrupted notice still shows when there is no saved run` — existing reopen test keeps passing.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `npx vitest run && npx eslint .` → PASS, 0 errors.
- [ ] **Step 5: Commit** — `git commit -m "feat: Resume card for interrupted runs"`

### Task 7: Manual verification and handoff

- [ ] **Step 1:** `cd frontend && npm run build:all` → both builds succeed.
- [ ] **Step 2:** In Chrome, load `frontend/dist/chrome`, start a browser-mode AI run, stop the worker at `chrome://serviceworker-internals` during classification, reopen the panel → card shows `classified X of Y`; Resume → log `Resuming: skipping X finished batches`, run completes, card gone.
- [ ] **Step 3:** Repeat, quitting Chromium mid-classification instead; relaunch → card present; Resume completes.
- [ ] **Step 4:** Write `.claude/memory/sessions/2026-10-19-resume-interrupted-runs.md` (files, decisions incl. the `START_JOB` deviation, verification output), push, open the PR.
