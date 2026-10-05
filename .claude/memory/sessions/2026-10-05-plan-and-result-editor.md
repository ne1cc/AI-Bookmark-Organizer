# Session handoff: plan review + result review editors (PR #99)

Branch `worktree-two-phase-plan-review` (draft PR #99). Spec: `.claude/memory/specs/2026-10-04-plan-editor-design.md`.
Plan: `.claude/memory/plans/2026-10-04-plan-and-result-editor.md` (repo is authoritative where they differ).

## What shipped
One setting, **Review folders before saving** (`reviewFolders`, default off, hidden in no-AI date mode), adds two pauses:
1. Plan review before any bookmark is classified: approve, edit (rename/add/delete/move/merge), or regenerate. An approved plan is `binding: true`, so `reconcile` keeps all its folders.
2. Result review after the third level is built and before sorting/writing: finished folders with counts, edits rename/delete/move/merge, recorded as an operation list the worker replays on the real bookmarks.

## Files modified (significant)
- `frontend/src/services/planEditor.js`, `resultEditor.js` (new pure models; `resultEditor` canonicalises records and rejects malformed ops: `Object.hasOwn`, path/to shape checks).
- `frontend/src/services/organizer.js`: `reviewPlan`, `reviewResult` gates (~1531-1590), fail-closed answers, `aliasCategories`/`rankCategories` so renamed categories keep their rank, constructor `planReviewer`/`resultReviewer`/`categoryAliases`.
- `frontend/src/services/reconcile.js`: `schema.binding`; `ai.js`: `normalizeSchema` extracted.
- `frontend/src/background/jobRunner.js`: `awaitReview`/`resolveReview`/`resolvePlan`/`resolveResult`, `review` notification, stale review released in `startJob` (with an organizer-identity guard on the old job's tail), draft removal at terminal states. `index.js`: `PLAN_DECISION`/`RESULT_DECISION`, `organizer-job-review` notification.
- `frontend/src/components/`: `EditorDialog`, `FolderTree` (explicit Move/Merge confirm), `PlanEditor`, `ResultEditor`, `ReviewPanel` (owns edits, mirrors to `chrome.storage.session.reviewDraft`, Clear edits), `Organizer.jsx` (setting, `decideReview`, in-panel reviewers, STATUS_UPDATE guard).
- `README.md` bullet; spec and plan amended.

## Structural side effects
- New session-storage key `reviewDraft` `{planEdit:{base,plan}, resultEdit:{base,ops}}` (generated folder names; accepted, see spec). Removed at terminal states, at `startJob` and after in-panel runs.
- Job state gains `plan` / `result` (non-null = waiting for a review). Port messages `PLAN_DECISION`, `RESULT_DECISION`. Notification id `organizer-job-review`.
- Reviewer contracts: `planReviewer(schema, error|null)` -> `{decision:'approve'|'regenerate'|'cancel', plan?}`; `resultReviewer(rows, error|null)` -> `{decision:'approve'|'cancel', ops?}`.

## Decisions and rejected alternatives
- One setting for both pauses (not two): the user's call after seeing that levels 2-3 only exist after classification.
- Result edits as an op list replayed in the worker, not a bookmark list sent over the port.
- No add in the result review (no bookmark to put in a new folder); rename via a Rename button only.
- Move/merge need an explicit confirm button (arrowing a closed select fires `change`).
- Merged `origin/main` into the branch instead of rebasing (no force push needed; no conflicts).
- Parked minors: see `.superpowers/sdd/.../progress.md` rulings (a stale in-panel resolver blocking a later worker run; dead port not nulled after a failed postMessage; cleared-edits notice vs parent state; no test for in-panel draft removal; planEditor test gaps; FolderTree a11y minors).

## Verification (after merging origin/main, from `frontend/`)
```
npx vitest run     -> Test Files 33 passed (33) / Tests 732 passed (732)
npm run lint       -> 3 problems (0 errors, 3 warnings)   [react-refresh warnings in Organizer.jsx, pre-existing]
npm run build:all  -> chrome and firefox "built in" with no errors
node /tmp/pwdbg/plan-edit.js   <worktree>/frontend/dist/chrome -> 13/13 checks passed
node /tmp/pwdbg/result-edit.js <worktree>/frontend/dist/chrome -> 13/13 checks passed
```
The two scripts live outside the repo (`/tmp/pwdbg`, Chrome for Testing + mocked AI); `result-edit.js` clicks the Confirm move/merge buttons.

## Open questions / follow-ups
- First real-key run: binding keeps more small folders than today; check the result still reads well.
- Not done: slash-collision checks (`checkName`) on plan input from ports, focus return to the row after each edit, label-in-name for Move to/Merge into.
- PR #99 is still draft; mark ready and merge are the user's call.
