# Task 1 Report — Fixed Category Hierarchy

## Implementation commit

`2bfffb270047e9636db9227c1f3f795425da25f9` — `fix(schema): preserve selected category hierarchy`

## Changed files

- `frontend/src/services/ai.js`
  - Treats the supplied category list as fixed in the schema-generation prompt.
  - Rebuilds validated model output against that list, so the model contributes
    only category-scoped subcategories and cannot rename, omit, or add a
    top-level category.
- `frontend/src/services/defaultSchema.js`
  - Adds authoritative schema construction that preserves the selected category
    spelling and ordering.
  - Makes fallback schemas use curated subcategories for known categories and
    `General` for custom categories.
  - Uses `Other` as the sole safe catch-all when no categories are selected.
- `frontend/src/services/defaultSchema.test.js`
  - Covers exact selected-list preservation, custom-category fallback coverage,
    and empty-list catch-all behavior.
- `frontend/src/services/schema-validation.test.js`
  - Covers generated-schema preservation of exact selected names, exclusion of
    model-invented categories, and the scoped `General` fallback for a selected
    category absent from model output.

## Design decisions

- Top-level category names are a user-owned contract. Matching model names is
  case-insensitive and trimmed only for lookup; output uses the selected value
  verbatim and preserves its selected order.
- Missing model subcategories receive `General`, keeping every selected category
  usable without inventing arbitrary topical folders.
- Curated subcategories remain the richer fallback when schema generation is
  unavailable. `Other` is introduced only for an empty selection, not appended
  to a non-empty user selection.

## Tests run

1. `npm test -- src/services/defaultSchema.test.js`
   - Initial RED run: 7 passed, 2 failed as expected (custom category had no
     subcategory; fallback appended `Other`).
   - Green run: 9 passed, 0 failed.
2. `npm test -- src/services/defaultSchema.test.js src/services/schema-validation.test.js`
   - 2 files passed; 51 tests passed, 0 failed.
3. `npm run lint`
   - Exit 0; 0 errors. It reports four existing warnings in
     `src/components/Organizer.jsx` (three Fast Refresh export warnings and one
     `useEffect` dependency warning), outside this task's changes.
4. `npm test`
   - 15 files passed; 253 tests passed, 0 failed.
5. `git diff --check`
   - Exit 0; no whitespace errors.

## Concerns

- No implementation blockers. The full suite emits pre-existing test-console
  output and the lint warnings noted above.
- An existing untracked plan file at
  `docs/superpowers/plans/2026-09-13-fixed-category-hierarchy-plan.md` was left
  untouched and excluded from the implementation commit.

## Fix round 1

### Fix commit

`2e8e774d07f42b23bb78adcea4815da27135e619` — `fix(schema): keep classification within selected categories`

### Findings addressed

- Added `fallbackCategoryForSchema`, which uses the first approved schema
  category (preserving its exact name) and uses `Other` only for the explicit
  empty-selection catch-all schema.
- `classifyBatch` now sends invalid model categories and omitted model entries
  to that schema-aware fallback instead of creating an unselected `Other`
  category.
- Terminal batch-failure recovery in `OrganizerService` uses the same fallback
  and reports its actual category in progress messages.
- Schema-generation and classification prompts now consistently direct outliers
  to the closest approved category's `General` subcategory rather than
  instructing the model to create `Other`.
- Corrected the fallback-helper documentation: custom categories receive
  category-scoped `General`, not an empty subcategory array.

### Tests and review

1. RED: `npm test -- src/services/schema-validation.test.js src/services/organizer.test.js`
   - 6 failures reproduced the invalid-model and terminal-recovery `Other`
     paths before the implementation change.
2. Focused GREEN: `npm test -- src/services/schema-validation.test.js src/services/organizer.test.js`
   - 2 files passed; 123 tests passed, 0 failed.
   - Covers malformed/omitted classifications remaining in the approved schema
     and a two-category terminal recovery filing every bookmark under the first
     selected category.
3. `npm run lint`
   - Exit 0; 0 errors, with the same four existing `Organizer.jsx` warnings.
4. `git diff --check`
   - Exit 0; no whitespace errors.
5. Full verification: `npm test`
   - 15 files passed; 253 tests passed, 0 failed.

### Fix-round concerns

- The full suite retains its existing mocked-error console output and one
  existing unawaited-assertion warning in `organizer.test.js`.
- The unrelated untracked plan file remains untouched.
