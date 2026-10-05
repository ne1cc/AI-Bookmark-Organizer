# Plan editor — design

Status: design approved in conversation 2026-10-04; written spec awaiting review.
Builds on the light two-phase prototype (draft PR #99, "Review plan before organizing").

## Goal
In review mode, let the user edit the AI's proposed folder structure before any bookmark is filed: rename, add, delete,
move and merge folders, in a small editor window. What the user approves is what the output contains.

## Decisions (made with the user)
| Question | Decision |
|---|---|
| Are edits binding on the post-classification cleanup? | **Binding.** Every folder in the approved plan survives if at least one bookmark lands in it. |
| Which operations? | Rename, add, delete, move, merge. **Not** reorder, undo/redo, drag and drop. |
| Where does the editor live? | An overlay (dialog) inside the side panel. No new extension page, no popup window. |
| Architecture | Pure editing model (`planEditor.js`) + overlay component; edited plan sent with the approve decision. |

## Assumptions
- The editor shows two levels (category, subfolder). The third level is still produced automatically by `enrichDetails`.
- Edits apply to the current run only and are never written to the saved `categories` setting.
- Regenerate discards saved edits (one confirm if there are any).
- An approved folder that receives zero bookmarks is not created (empty folders cannot be placed).
- At plan time no bookmark is filed, so delete/move/merge change the plan only; nothing needs re-homing.

## Data flow
1. The AI proposes a plan; the review card shows it (existing behaviour).
2. **Edit plan** opens the overlay on a draft copy. **Save** closes it and updates the card; **Discard** drops the draft.
3. **Approve & organize** sends `PLAN_DECISION { decision: 'approve', plan }`; `plan` is present only if the user edited.
4. `jobRunner.resolvePlan(decision, plan)` runs `normalizeSchema(plan)`. Invalid: the job keeps waiting, `currentJob.plan.error`
   carries the reason and the card shows it. Valid: the schema gets `binding: true` and the reviewer resolves
   `{ decision: 'approve', schema }`.
5. `OrganizerService.reviewPlan` returns that schema, and `classifyAll`, `reconcile`, `rehomeLoose` and placement use it.
   In manual-categories mode the edited schema replaces the "selected categories are authoritative" wrap, which runs before
   the review step; the saved category list is untouched.
6. The in-panel fallback path (no worker) resolves the same `{ decision, schema }` shape directly.

## Units
- `services/planEditor.js` (new, pure): `renameNode`, `addCategory`, `addSubfolder`, `removeCategory`, `removeSubfolder`,
  `moveSubfolder`, `mergeSubfolders`, `mergeCategories`. Each takes a plan and returns `{ plan }` or `{ error }` and never
  mutates its input. Depends on `canonicalKey` and the filler-name check only.
- `services/ai.js`: extract `normalizeSchema(schema)` (trim, dedupe, drop parent-echo and filler subfolders) out of
  `validateSchema`, and export the filler-name check. `validateSchema` calls `normalizeSchema`; its behaviour and tests are
  unchanged. The AI-quality checks (minimum category count, catch-all names) stay AI-path only, so a user may keep two categories.
- `components/PlanEditor.jsx` (new): the overlay; draft state in a reducer over `planEditor.js`; props `plan`, `onSave`, `onDiscard`.
- `components/Organizer.jsx`: **Edit plan** button, saved-edit state, sends `plan` with approve, restores it on reopen.
- `background/jobRunner.js`, `background/index.js`, `services/organizer.js`: `PLAN_DECISION` carries `plan`; the reviewer
  contract changes from a string to `{ decision, schema? }`; the prototype's tests are updated accordingly.
- `services/reconcile.js`: when `schema.binding` is set, folders in the approved plan skip the "fewer than minimum" dissolve
  and the per-category cap. Spelling merges still apply. Classifier-invented folders are cleaned up as today. Runs without
  review never carry the flag and behave exactly as before.

## Editor behaviour
- Dialog: `role="dialog"`, `aria-modal`, focus trapped, focus returns to **Edit plan** on close. Header: title, live count
  ("5 categories · 14 subfolders"), **Discard**, **Save**. Body: expandable category rows, **+ Add category** at the bottom.
- Rename: click the name or pencil, inline; Enter commits, Escape cancels.
- Add: **+** on a category adds a subfolder; **+ Add category** adds a top-level one; the new row opens in rename mode.
- Delete: trash on a subfolder removes it; on a category, an inline confirm states the count ("Delete Travel and its 3 subfolders?").
- Move: **Move to…** on a subfolder lists the other categories and re-parents it. Categories are not movable.
- Merge: **Merge into…** lists the other folders at the same level. Subfolders (even under different categories): the source is
  removed and the target keeps its name. Categories: the source's subfolders move into the target, duplicates are dropped,
  the source is removed.
- Rules, shown inline and never fixed silently: name not empty; unique among siblings by `canonicalKey`; a subfolder cannot be
  named like its parent; filler names (General, Other, Misc, Miscellaneous, Uncategorized, None, Various) are refused with a
  reason, because unfiled bookmarks already go to a General fallback; a plan needs at least one category (Save is disabled
  otherwise). A category with no subfolders is allowed.
- Unsaved changes: Escape or Discard asks once. Errors go through a live region; every icon button has a text label.

## Persistence and errors
- **Save** mirrors the edited plan into `chrome.storage.session` keyed by job id; reopening the panel restores it onto the
  review card. It is cleared on approve, regenerate and cancel. An unsaved draft in an open overlay is lost if the panel closes.
- Unrecognised decisions, stale job ids and cancel behave as in the prototype.

## Testing
- `planEditor`: every action; empty name, sibling duplicate, parent echo, filler names, deleting the last category,
  move/merge name clashes; inputs never mutated.
- `normalizeSchema`: direct tests; the existing `validateSchema` tests pass unchanged.
- `reconcile` binding: a 1-bookmark approved folder survives with `binding` and dissolves without it; invented extras are
  still cleaned; the cap is not applied to approved folders.
- Background: approve with an edited plan resolves a normalized schema with `binding: true`; an invalid plan keeps the job
  waiting and reports an error; the session draft is written on Save and cleared on every decision.
- `PlanEditor` component: rename, add, delete with confirm, move, merge, inline errors, Save disabled with zero categories,
  discard prompt when dirty, Escape, focus trap and return, labels.
- `Organizer`: Edit plan, Save, then Approve sends the plan; Regenerate asks for confirmation when edits exist.
- Real Chrome with the AI mocked: rename, add, move and merge, then Approve; the saved run contains exactly the edited
  categories including an approved folder that got one bookmark; reopening the panel restores saved edits; a hand-sent invalid
  plan is rejected without ending the run.

## Rollout
Stays behind **Review plan before organizing** (off by default), on the prototype branch and draft PR #99. One README note.
Version bump and release are separate decisions.

## Out of scope
Reorder, undo/redo, drag and drop, reusable plan templates, editing the third level, per-folder bookmark counts.

## Risks
- Binding changes cleanup for every reviewed run, edited or not: more small folders can survive than today. Intended
  ("what you approve is what you get"), but the first real-key runs should check the result still reads well.
- The reviewer contract change touches the prototype's tests; they must be updated in the same change.
