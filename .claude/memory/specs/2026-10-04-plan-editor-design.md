# Plan and result editor — design

Status: design approved in conversation 2026-10-04; revised the same day to add the second review (levels 2 and 3);
written spec awaiting review. Builds on the light two-phase prototype (draft PR #99, "Review plan before organizing").

## Goal
Let the user edit the structure in a small editor window at two points, so what they approve is what the output contains:
1. **Plan review** (before any bookmark is filed): edit the AI's proposed categories and subfolders.
2. **Result review** (after all the data is in: classified and grouped, before anything is written): edit the full
   three-level tree, with real bookmark counts, where edits carry the actual bookmarks.

## Decisions (made with the user)
| Question | Decision |
|---|---|
| Are plan edits binding on the post-classification cleanup? | **Binding.** Every folder in the approved plan survives if at least one bookmark lands in it. |
| Which operations? | Rename, add, delete, move, merge. **Not** reorder, undo/redo, drag and drop. |
| Where does the editor live? | An overlay (dialog) inside the side panel. No new extension page, no popup window. |
| Architecture | Pure editing models + one shared tree view; edits are sent with the decision, not applied in the panel alone. |
| When can level 3 be edited? | In a **second review after filing**, where the third-level folders actually exist. Not guessed up front. |
| Why two reviews, not one? | Folders are generated at three points: the up-front plan, extra subfolders the classifier proposes batch by batch, and third-level folders built from the classified bookmarks. The final tree does not exist until the end, so the plan alone cannot show it; a result-only review would make a bad plan cost a full run. Kept both. |
| Switches | **One switch**, *Review folders before saving*, turns on both pauses (plan, then result). Off by default. At the plan pause, a quick Approve is enough if the plan looks fine. |

## Assumptions
- The plan review shows two levels (category, subfolder). Level 3 is produced by `enrichDetails` and can only be edited in
  the result review.
- Edits apply to the current run only and are never written to the saved `categories` setting.
- Regenerate (plan review) discards saved edits, with one confirm if there are any.
- An approved folder that receives zero bookmarks is not created (empty folders cannot be placed).
- At plan time no bookmark is filed, so delete/move/merge change the plan only.
- The two reviews are not separately switchable: one switch enables both.

## Part 1 — Plan review

### Data flow
1. The AI proposes a plan; the review card shows it (existing prototype behaviour).
2. **Edit plan** opens the overlay on a draft copy. **Save** closes it and updates the card; **Discard** drops the draft.
3. **Approve & organize** sends `PLAN_DECISION { decision: 'approve', plan }`; `plan` is present only if the user edited.
4. `jobRunner.resolvePlan(decision, plan)` runs `normalizeSchema(plan)`. Invalid: the job keeps waiting, `currentJob.plan.error`
   carries the reason and the card shows it. Valid: the schema gets `binding: true` and the reviewer resolves
   `{ decision: 'approve', schema }`.
5. `OrganizerService.reviewPlan` returns that schema; `classifyAll`, `reconcile`, `rehomeLoose` and placement use it. In
   manual-categories mode the edited schema replaces the "selected categories are authoritative" wrap, which runs before the
   review step; the saved category list is untouched.
6. The in-panel fallback path (no worker) resolves the same `{ decision, schema }` shape directly.

### Units
- `services/planEditor.js` (new, pure): `renameNode`, `addCategory`, `addSubfolder`, `removeCategory`, `removeSubfolder`,
  `moveSubfolder`, `mergeSubfolders`, `mergeCategories`. Each takes a plan and returns `{ plan }` or `{ error }` and never
  mutates its input. Depends on `canonicalKey` and the filler-name check only.
- `services/ai.js`: extract `normalizeSchema(schema)` (trim, dedupe, drop parent-echo and filler subfolders) out of
  `validateSchema`, and export the filler-name check. `validateSchema` calls `normalizeSchema`; behaviour and tests are
  unchanged. The AI-quality checks (minimum category count, catch-all names) stay AI-path only, so a user may keep two categories.
- `services/reconcile.js`: when `schema.binding` is set, folders in the approved plan skip the "fewer than minimum" dissolve
  and the per-category cap. Spelling merges still apply. Classifier-invented folders are cleaned up as today. Runs without
  review never carry the flag and behave exactly as before.
- `background/jobRunner.js`, `background/index.js`, `services/organizer.js`: `PLAN_DECISION` carries `plan`; the reviewer
  contract changes from a string to `{ decision, schema? }`; the prototype's tests are updated in the same change.

## Part 2 — Result review (levels 2 and 3, after all the data is in)

### Placement
After `enrichDetails` returns (its own third-level cleanup is done) and before `sortAndStrip` and placement. Nothing after
that point rewrites folder assignments, so the edited result is final. The tree shown is category → subfolder → third-level
folder, with a bookmark count on every row. Bookmarks filed directly under a category or subfolder (the General sink) are
shown as a count on that parent.

### Operations (carry the actual bookmarks)
- **Rename**: relabels every bookmark in the folder.
- **Delete**: a subfolder's bookmarks move up into the category (the existing "filed directly under the category" result);
  a third-level folder's bookmarks move up into their subfolder. Categories are removed by **merge**, since their bookmarks
  need a destination.
- **Move**: re-parents a folder with all its bookmarks (third-level folder to another subfolder; subfolder to another category).
- **Merge**: combines two folders at the same level; the target keeps its name.
- Same naming rules as the plan editor (non-empty, unique among siblings by `canonicalKey`, not equal to the parent,
  no filler names).
- **Not in version one:** adding an empty folder and moving individual bookmarks (an added folder is only useful with
  bookmark-level moves). Follow-up.

### Data flow
1. `OrganizerService.reviewResult(classified)` builds a tree with counts (`buildTree`) and calls `resultReviewer(tree)`.
2. `jobRunner` publishes it as `currentJob.result = { tree }` (small; safe for the session snapshot and port) and waits.
   The bookmark list never crosses the port.
3. The panel opens the same overlay on that tree. Edits are an operation list: `{ op: 'rename' | 'delete' | 'move' | 'merge',
   path, to? }`. The panel applies each op to its own tree (pure functions) so counts update instantly.
4. **Save results** sends `RESULT_DECISION { decision: 'approve', ops }`. The worker re-applies the same ops to the classified
   items with `resultEditor.js`, validating each (a bad op rejects the whole list with a reason and the job keeps waiting).
5. The edited items continue into `sortAndStrip` and placement. **Cancel** ends the run as in the plan review.
6. The op list is mirrored to `chrome.storage.session` keyed by job id and re-applied on reopen; cleared on every decision.

### Units
- `services/resultEditor.js` (new, pure): `buildTree(items)`, `applyOps(items, ops)` returning `{ items }` or `{ error }`.
  Never mutates its input. The panel reuses the tree-level half so both sides agree.
- `components/FolderTree.jsx` (new): the shared tree view (rows, counts, inline rename, action menus). `PlanEditor` and
  `ResultEditor` are thin wrappers that supply a tree and an operations adapter.
- `services/organizer.js`: `resultReviewer` hook and `reviewResult`, called between `enrichDetails` and `sortAndStrip`.
- `background/*`: `RESULT_DECISION` message; `resolveResult(decision, ops)`.

## Editor behaviour (shared)
- Dialog: `role="dialog"`, `aria-modal`, focus trapped, focus returns to the button that opened it. Header: title, live
  count ("5 categories · 14 subfolders"), **Discard**, **Save**. Body: expandable rows.
- Rename: click the name or pencil, inline; Enter commits, Escape cancels.
- Add (plan review only): **+** on a category adds a subfolder; **+ Add category** adds a top-level one; the new row opens in
  rename mode.
- Delete: trash icon; on a folder with children, an inline confirm states the count ("Delete Travel and its 3 subfolders?").
- Move: **Move to…** lists valid destinations. Merge: **Merge into…** lists the other folders at the same level.
- Rules, shown inline and never fixed silently: name not empty; unique among siblings; a subfolder cannot be named like its
  parent; filler names (General, Other, Misc, Miscellaneous, Uncategorized, None, Various) are refused with a reason because
  unfiled bookmarks already go to a General fallback; a plan needs at least one category (Save disabled otherwise).
- Unsaved changes: Escape or Discard asks once. Errors go through a live region; every icon button has a text label.

## Persistence and errors
- Plan review: **Save** mirrors the edited plan into `chrome.storage.session` keyed by job id; reopening restores it onto the
  card. Cleared on approve, regenerate and cancel. An unsaved draft in an open overlay is lost if the panel closes.
- Result review: the op list is mirrored as above.
- Unrecognised decisions, stale job ids and cancel behave as in the prototype.

## Settings
- One setting, `reviewFolders` (default `false`), labelled **Review folders before saving**, hidden in the no-AI date mode.
  It replaces the prototype's `reviewPlan` key; the prototype was never released, so there is nothing to migrate.

## Testing
- `planEditor`: every action; empty name, sibling duplicate, parent echo, filler names, deleting the last category,
  move/merge clashes; inputs never mutated.
- `normalizeSchema`: direct tests; existing `validateSchema` tests pass unchanged.
- `reconcile` binding: a 1-bookmark approved folder survives with `binding` and dissolves without it; invented extras are
  still cleaned; the cap is not applied to approved folders.
- `resultEditor`: `buildTree` counts; each op on items (rename, delete up one level, move, merge); bad ops return errors;
  inputs never mutated; panel-side tree ops and worker-side item ops agree on the same op list (parity test).
- Background: approve with an edited plan resolves a normalized schema with `binding: true`; an invalid plan keeps the job
  waiting; result ops are validated and applied, or rejected as a whole; session mirrors are written and cleared.
- Components: `FolderTree`, `PlanEditor`, `ResultEditor` (rename, delete with confirm, move, merge, inline errors, Save disabled
  with zero categories, discard prompt, Escape, focus trap and return, labels). `Organizer`: one switch enables both
  pauses; Approve sends the plan; Save results sends ops.
- Real Chrome with the AI mocked: plan review edits and approval (including a 1-bookmark approved folder surviving); result
  review with third-level folders present (rename, move, merge, delete) and the saved run matching the edited tree; reopening
  the panel restores both kinds of edits; invalid plan/ops are rejected without ending the run.

## Rollout
One switch, off by default, built on the prototype branch and draft PR #99 in two stages: plan review first (smaller),
result review second. Until stage two lands, the switch enables only the plan pause. One README note. Version bump and release are separate decisions.

## Out of scope
Reorder, undo/redo, drag and drop, reusable plan templates, per-folder counts in the plan review (none exist yet), adding
folders and moving individual bookmarks in the result review.

## Risks
- Binding changes cleanup for every plan-reviewed run, edited or not: more small folders can survive than today. Intended;
  the first real-key runs should check the result still reads well.
- The reviewer contract change touches the prototype's tests; update them in the same change.
- The result tree for very large collections (thousands of bookmarks, hundreds of folders) must stay responsive in a narrow
  panel: render collapsed by default and expand on demand.
- Two worker-side waits (plan, result) both live in worker memory; a browser restart mid-review loses the run, as for any
  run in progress today.
