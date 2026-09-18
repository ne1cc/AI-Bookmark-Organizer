# Auto-Generated Categories Design

## Goal

When no manual categories are selected, let the AI infer a useful category and subcategory schema from the complete bookmark collection for the current organization run.

## User experience

- New installs start with no selected manual categories and `inferCategories` enabled.
- Existing saved manual categories remain unchanged.
- “Infer categories” is a persisted toggle in Customize Categories.
- While inference is enabled, manual category input, chips, clear/reset actions, and suggested-category actions are disabled and visually muted. Existing manual selections are preserved but ignored only when the inferred mode is active.
- Inference is used whenever the toggle is enabled; any saved manual categories remain dormant. If inference is disabled and the manual list is empty, organizing is blocked with a prompt to add at least one category.
- Generated category names and schema are run-scoped. They are not written to `chrome.storage` or used to replace the manual category list.

## AI and organizer behavior

The repository already contains the earlier schema-generation machinery: bookmark sampling, prompt construction, schema validation, corrective retry, cancellation, fallback handling, and classification. The current bug is that the empty-category branch invokes the fixed-category prompt and later applies `buildAuthoritativeSchema([])`, which reduces the inferred result to `Other`.

Add an explicit inferred-schema path that:

1. Receives the full normalized bookmark collection as the category-inference input; it must not use the fixed-category sample limit for this mode. **Superseded 2026-09-17 (PR #76):** the full collection made schema prompts for large libraries reach ~500K tokens (slow, costly, over most model context windows). Inferred mode now designs from the same evenly spaced sample as manual mode — see `2026-09-17-backend-performance-architecture-design.md`. The intent of this clause (do not lose the collection's topical variety) is preserved by even spacing plus classification's proposed-subcategory rule.
2. Asks the model to return usable top-level categories and subcategories, honoring the selected subfolder granularity.
3. Reuses existing validation, retry, cancellation, and schema normalization where compatible, but does not enforce a fixed top-level category list.
4. Carries the generated schema through classification and folder creation without rebuilding it against an empty authoritative category list.
5. Reports an actionable error if inference cannot produce a usable schema; it must not silently collapse the run to `Other`.

The same config must flow through both the side-panel in-process runner and the background service-worker runner.

## Persistence and compatibility

- Persist only the toggle setting, not inferred categories.
- The toggle defaults to `true` when absent.
- A stored manual category array, including an empty array, must hydrate correctly.
- Flat date sort remains independent and continues to bypass category inference.

## Testing

Add coverage for:

- new-install defaults and persisted toggle behavior;
- disabled manual controls while inference is active;
- blocking organization when inference is off and categories are empty;
- the full bookmark collection being supplied to inferred schema generation;
- inferred schema surviving into classification without `Other` replacement;
- generated categories not being persisted;
- cancellation and background config propagation.

## Scope

Modify the existing Organizer UI, organizer service, AI schema functions, background config plumbing, and their tests. Do not add a new provider or dependency, and do not restructure the existing bookmark parser.
