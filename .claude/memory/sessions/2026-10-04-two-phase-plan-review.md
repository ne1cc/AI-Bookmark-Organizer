# 2026-10-04 — Two-phase prototype, light version ("Review plan before organizing")

Prototype of the two-phase idea: phase 1 proposes the folder structure, the user approves it, phase 2 files the bookmarks.
Only the **light** size is built: an opt-in toggle, a read-only plan with Approve / Regenerate / Cancel. No plan editing.

## What changed
- `services/organizer.js`: `planReviewer` hook (null by default) and `reviewPlan(links, schema)`, called in `runAI` between
  `designSchema` and `classifyAll`. It loops: `approve` returns the schema, `regenerate` calls `designSchema` again and asks
  again, `cancel` (or `isCancelled`) ends the run through `this.cancelled()`.
- `background/jobRunner.js`: `config.reviewPlan` installs a reviewer (not in flat date mode). `awaitPlanDecision` publishes
  `currentJob.plan = {categories:[{name, sub_categories}]}` and waits; `resolvePlan(decision)` accepts only
  approve/regenerate/cancel and ignores everything else or a stale job id. `cancelJob` resolves a pending plan with `cancel`
  so nothing hangs. `plan` is part of the session snapshot, so a reopened panel restores the card.
- `background/index.js`: `PLAN_DECISION` port message.
- `components/Organizer.jsx`: `reviewPlan` setting (storage key `reviewPlan`, default off) with a switch in the settings grid
  (hidden in flat date mode); `planForReview` state fed by `STATUS_UPDATE.plan` / the session snapshot; "Proposed folder plan"
  card with Approve & organize / Regenerate plan; the in-panel fallback run uses a local resolver. While waiting, the
  progress button reads "Waiting for your approval".

## Decisions
- The job `status` stays `'processing'` while waiting; `plan` being non-null is what marks "waiting for the user". This keeps
  every existing panel path (restore, cancel, ACK handshake) working without a new status value.
- Review is per-run opt-in and off by default; the date-based (no AI) mode has no plan, so it is exempt.
- Rejected for the light version: editable plans, locked folders, per-folder bookmark counts, saving the plan with the run.

## Verification
- `npx vitest run` → 23 files, 545 tests passed (536 before; +5 `plan-review.test.js`, +4 jobRunner gate tests).
- `npm run lint` → 0 errors, 3 pre-existing warnings. `npm run build:all` → success.
- Real Chrome for Testing + Playwright, AI mocked (`/tmp/pwdbg/plan.js`): 13/13 checks. Off by default and no pause; toggle
  persists; plan card shows the folders with zero classification calls; Regenerate gives a second schema call and a different
  plan; Approve classifies against the NEW plan and the saved run uses its categories; Cancel at the plan classifies nothing and
  adds no saved run; reopening the panel mid-review restores the card and Approve then completes; no page errors.

## Known limits / follow-ups
- The wait lives in the service worker's memory. While the panel is closed the keep-alive timer holds the worker, but if the
  browser restarts mid-review the run is lost (same as any in-flight run today).
- File-mode runs: the plan is made before classification, so counts per folder are not shown (they don't exist yet).
- Not verified: the real AI producing a plan (mocked), the Firefox sidebar.
- Stale comment noticed, not touched: `Organizer.jsx` still says "latest plus the two before it" next to `saveRun`, left over
  from when runs were capped at 3.
- Screenshot used a page-scoped Playwright capture (not the desktop), saved under `/tmp/pwdbg`, outside the repo.
