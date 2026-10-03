# 2026-10-02 — Fewer bookmarks sitting loose in category folders

Goal: reduce bookmarks filed directly under a category folder (the `General` sink) with no subfolder.

## What changed
- `frontend/src/services/ai.js`
  - New `classifyRehomeBatch(bookmarks, apiKey, foldersByCategory, ...)`: index-only re-file call. Each bookmark is
    offered only the approved subfolders of its own category; null / unknown / other-category names leave it unchanged.
  - `classifyBatch` rules 4 and 5 reworded: prefer the nearest schema sub_category over `General`.
- `frontend/src/services/organizer.js`
  - New `rehomeLoose(classified)`, run in `runAI` after `reconcileClassified` and before `enrichDetails`.
    Candidates are items where `shouldCreateSubFolder` is false (General and every other sink), in a category that has
    at least one surviving folder, excluding exempt (Archive). Chunked by `DETAIL_CLASSIFICATION_BATCH_SIZE`, run through
    `runPool` at `DETAIL_CLASSIFICATION_CONCURRENCY`. Fail-soft: errors warn and bookmarks stay put; cancel stops the run.
- `frontend/src/services/reconcile.js`
  - `nearestSibling` falls back to the largest survivor when no name token overlaps (previously `General`).
    `General` is now only used when a category has no surviving folder.
  - `isExemptCategory` exported and shared with the organizer.

## Decisions / alternatives
- Re-home runs after reconcile because the final folder list is only known then; it grows folders only, so no second reconcile.
- Reconcile fallback to the largest survivor was approved alongside the AI pass. Trade-off: those orphans are now placed
  by size rather than given to the AI pass, so a few may be less accurate than an AI re-file would be. If that shows up in
  real runs, the alternative is to leave no-overlap orphans in General for the AI pass and use the largest-survivor rule
  only for whatever the pass cannot place.
- Cost: one extra AI call per 50 loose bookmarks; zero when nothing is loose.

## Verification
- `npx vitest run` → 21 files, 507 tests passed (baseline 496).
- `npm run lint` → 0 errors, 3 warnings (pre-existing).
- `npm run build:all` → success.
- Red check: with the `rehomeLoose` call removed, 4 new tests fail; restored, all pass.

## Follow-ups
- Surface the loose count before/after in the UI run summary (currently only in the run log).
- The re-home pass cannot resurrect subfolders reconciliation dissolved; bookmarks whose only fitting folder was too small
  stay loose by design.
