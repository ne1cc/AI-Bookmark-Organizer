# Task 2 Report — Enforce Two-Level Classification and Placement

## Implementation commit

`b03a3d8bcc7c45050e2e74ed611c5d3de51b03c5` — `fix(organizer): enforce category subfolder pairs`

## Changed files

- `frontend/src/services/ai.js`
  - Extracted schema-aware classification normalization for reuse by the AI
    response handler and `OrganizerService`.
  - Rejects an invented category and routes it to the schema fallback category
    with `General`.
  - Rejects an approved subcategory when it belongs to a different approved
    category, routing it to the selected category's `General` bucket.
  - Keeps genuinely new subcategory names as proposals for the existing
    reconciliation pass.
- `frontend/src/services/organizer.js`
  - Rebuilds the working schema from the selected category list before batch
    classification, including recovery/fallback paths.
  - Normalizes every returned classification before reconciliation and browser
    placement, so adapters or mocked/classifier boundary responses cannot
    create unselected categories or cross-category subfolders.
- `frontend/src/services/organizer.test.js`
  - Adds browser-mode integration coverage for category/subcategory placement.
    It verifies that a subcategory valid only under Finance is not created under
    Tech, that an invented category is not created, and that valid Finance
    bookmarks land in Finance → Investing.

## Decisions

- The selected category list remains the sole top-level authority. The
  OrganizerService re-applies it immediately before classification so generated,
  retried, and fallback schemas all use the same contract.
- A subcategory recognized under another approved category is an invalid pair,
  not a proposed folder. It is filed directly under the chosen category using
  `General`.
- Unknown subcategory names under a valid category remain proposals. This
  preserves the existing reconciliation behavior that merges, folds, and caps
  proposed folders across batches.
- Sorting and browser write/reorder behavior were not altered; validation runs
  before reconciliation and uses its resulting labels for placement.

## Tests and verification

1. RED: `npm test -- src/services/organizer.test.js`
   - 81 passed, 1 failed as intended.
   - The new placement test showed the invented category was created as a
     browser folder instead of being routed to the selected-category fallback.
2. Focused GREEN: `npm test -- src/services/organizer.test.js src/services/schema-validation.test.js src/services/subcategory-pipeline.test.js`
   - 3 files passed; 131 tests passed, 0 failed.
3. Lint: `npm run lint`
   - Exit 0; 0 errors and 4 pre-existing warnings in
     `src/components/Organizer.jsx` (three Fast Refresh export warnings and one
     `useEffect` dependency warning).
4. Full suite: `npm test`
   - 15 files passed; 254 tests passed, 0 failed.
5. Diff check: `git diff --check`
   - Exit 0; no whitespace errors before the implementation commit.
6. Self-review
   - Reviewed the final implementation diff and confirmed schema normalization
     occurs before reconciliation, placement still keys subfolders by
     `category/subcategory`, and no reconciliation or sorting logic changed.

## Concerns

- The full suite retains existing expected mocked API-error console output and
  an existing unawaited assertion warning in `organizer.test.js`; neither comes
  from Task 2's changed lines.
- The unrelated untracked file
  `docs/superpowers/plans/2026-09-13-fixed-category-hierarchy-plan.md` was left
  untouched and excluded from both Task 2 commits.
