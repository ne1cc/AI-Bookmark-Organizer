# Adaptive Third-Level Categorization Design

## Goal

Extend bookmark organization from two inferred folder levels to an adaptive three-level hierarchy:

```text
Category → Subcategory → Detail folder → Bookmark
```

Detail folders are inferred only when a populated subcategory contains enough material to support useful groups. The feature applies to both category modes: fully inferred mode and manual top-level category mode.

## Existing behavior

The current pipeline already produces and enforces two levels:

- inferred mode generates top-level categories and subcategories from the bookmark file;
- manual mode treats the selected top-level categories as authoritative and generates subcategories beneath them;
- classification assigns each bookmark a `category` and `sub_category`;
- reconciliation removes weak, duplicate, and one-bookmark subcategories;
- browser writes and HTML exports create `Category/Subcategory` paths.

The third level must extend this pipeline without weakening the existing category/subcategory contract or changing saved manual category settings.

## Product behavior

### Adaptive eligibility

A subcategory is eligible for detail-folder inference only when all of the following are true:

1. It is a genuine folder according to the existing `shouldCreateSubFolder(category, subCategory)` rule. Sink values such as `General`, `None`, `Uncategorized`, an empty value, or a value echoing its parent are not eligible.
2. It contains at least 6 bookmarks after category/subcategory reconciliation.
3. The AI can propose at least 2 distinct, meaningful detail folders.
4. Final assignment leaves at least 2 bookmarks in every retained detail folder.

Eligible groups may contain 2–4 retained detail folders. The upper bound is also limited by `floor(bookmarkCount / 2)`, ensuring every possible folder can meet the two-bookmark minimum.

If any condition fails, the group remains unchanged and its bookmarks stay directly inside the subcategory. Failure to enrich one group must not fail the whole organization run.

### Category modes

- **Inferred categories enabled:** the AI infers categories, subcategories, and eligible detail folders.
- **Manual categories enabled:** the selected categories remain authoritative; the AI infers subcategories and eligible detail folders beneath them.

No new preference or toggle is added. The existing subfolder granularity setting continues to control second-level subcategory generation. Third-level detail folders always use the adaptive 2–4 rule above.

### Folder output

Bookmarks with a retained detail assignment are written to:

```text
AI Organized Bookmarks-YYYY-MM-DD/
  Category/
    Subcategory/
      Detail folder/
        Bookmark
```

Bookmarks without a retained detail assignment keep the existing path:

```text
AI Organized Bookmarks-YYYY-MM-DD/
  Category/
    Subcategory/
      Bookmark
```

Chrome/Firefox bookmark writes and downloaded Netscape HTML must produce equivalent hierarchy.

## Architecture

Use staged adaptive enrichment after the existing category/subcategory classification and reconciliation pass.

### Stage 1: existing two-level schema and classification

Keep the current schema shape and all current behavior unchanged:

```js
{
  categories: [
    { name: 'Engineering', sub_categories: ['Frontend', 'Backend'] }
  ]
}
```

The existing classifier continues to return:

```js
{
  category: 'Engineering',
  sub_category: 'Frontend'
}
```

This preserves compatibility with fixed-category validation, fallback behavior, subcategory reconciliation, and all current tests.

### Stage 2: identify eligible groups

After `reconcileSubcategories`, group bookmarks by the canonical pair `(category, sub_category)`. Retain only groups satisfying the eligibility rules. Group identity must use the existing canonical subcategory normalization so spacing and case variants cannot create duplicate work.

### Stage 3: infer detail schemas in bounded batched requests

Send eligible groups through the same detail-schema stage in batches of at most 12 groups. Include at most 60 bookmarks sampled evenly from each group so large collections cannot produce an unbounded prompt. Each input group includes its authoritative category and subcategory names plus indexed bookmark titles and URLs. The response contract is:

```js
{
  groups: [
    {
      category: 'Engineering',
      sub_category: 'Frontend',
      detail_categories: ['Frameworks', 'CSS & Design Systems']
    }
  ]
}
```

The validator must:

- accept only requested category/subcategory pairs;
- normalize names and discard empty, duplicate, filler, parent-echoing, or path-like values;
- retain 2–4 detail names per group, further capped by `floor(groupSize / 2)`;
- omit invalid groups rather than failing valid sibling groups;
- reject a wholly unusable response so one corrective retry can request a fixed response.

Each detail-schema batch uses the existing model, cancellation signal, retry machinery, JSON parsing, and network/rate-limit reporting. A failed batch is retried once for schema correction; if it remains unusable, only those groups stay at two levels.

### Stage 4: classify only eligible bookmarks

Classify bookmarks only within groups that have an approved detail schema. The response adds one field:

```js
{
  i: 0,
  detail_category: 'Frameworks'
}
```

The prompt must restrict assignments to the approved detail names for that bookmark's category/subcategory pair. Unknown names are ignored, not promoted into new folders.

### Stage 5: reconcile assignments

For each group:

1. Count assignments to approved detail folders.
2. Remove every detail folder with fewer than 2 bookmarks.
3. Clear `detail_category` for bookmarks assigned to a removed or unknown folder.
4. Retain the split only if at least 2 detail folders remain.
5. If fewer than 2 remain, clear all detail assignments in that subcategory.

This stage is deterministic and is the final authority on whether a third level is created.

## Data model

Organized bookmark records gain one optional run-scoped field:

```js
{
  category: 'Engineering',
  sub_category: 'Frontend',
  detail_category: 'Frameworks'
}
```

`detail_category` is not written into settings or the saved manual category list. It may travel with in-memory/background result records in the same way as `category` and `sub_category`, allowing reconnect recovery and download after completion.

The first two levels remain represented by the existing schema. The approved detail schema exists only for the current run and is used for validation, progress reporting, sorting, and placement.

## Placement and export

Add a shared predicate for real detail folders. It must reject empty values, `General`, `Other`, `None`, `Uncategorized`, `Misc`, values matching the category, and values matching the subcategory.

### Browser writes

After creating/finding the subcategory folder, create/find the detail folder beneath it only when both the subcategory and detail predicates pass. Cache paths with all three names so identically named detail folders under different parents remain independent.

Both organizer browser moves and imported/downloaded result writes must use the same hierarchy rule.

### HTML export

The Netscape exporter must group by category, then subcategory, then optional detail folder. Bookmarks without a valid detail folder remain directly under their subcategory. Escaping, URL sanitization, dates, icons, and insertion order retain their current behavior.

### Sorting

Folder ordering remains stable by category, subcategory, then detail folder. The selected content sort applies to bookmarks within their final destination folder. The feature must not alter flat chronological mode, which remains schema-free.

## Progress, statistics, and errors

Progress logs should identify the new stage without presenting it as another full run:

- `Finding useful third-level groups...`
- `Inferring detail folders for N eligible subcategories...`
- `Detail folders: N created across M subcategories; K groups kept at two levels.`

Add run statistics for `detailFoldersCount` and `detailedSubcategoriesCount`. Existing category counts and breakdowns remain unchanged.

Detail enrichment is best-effort:

- cancellation still stops the full run immediately;
- transport, parsing, or validation failure after retries logs a warning and continues with the valid two-level result;
- one invalid group does not discard valid detail schemas for other groups;
- no failure may create an unapproved detail folder.

## Persistence and reconnect behavior

The third-level schema and assignments are run-scoped. They must not be stored as configuration. Completed result payloads may include `detail_category`, so current transient result recovery and download behavior naturally preserve the generated hierarchy while the worker holds those results.

No new background message type is required. Existing `JOB_ACK`, status polling, `GET_RESULTS`, result-unavailable handling, and rerun messaging remain unchanged.

## Testing

Add coverage for:

1. Eligibility excludes groups with fewer than 6 bookmarks and sink subcategories.
2. Detail-schema validation accepts only requested parent pairs and 2–4 useful names.
3. Detail classification cannot invent a new folder name.
4. Reconciliation removes folders with one bookmark and collapses a group unless at least two valid folders remain.
5. Inferred mode retains AI-generated category, subcategory, and detail assignments end to end.
6. Manual mode retains selected top-level categories while inferring levels two and three.
7. Browser placement creates `Category/Subcategory/Detail` only for valid detail assignments.
8. HTML export mirrors the browser hierarchy and keeps unsplit bookmarks at the subcategory root.
9. Identically named detail folders under different subcategories remain separate.
10. Detail inference failure falls back to the existing two-level output without failing the run.
11. Cancellation during detail enrichment stops processing.
12. Background/transient results preserve `detail_category` without persisting it as a setting.
13. Flat date mode performs no detail inference.
14. Existing two-level tests remain green, proving backward compatibility when no group qualifies.

## Non-goals

- User-authored third-level schemas or a new detail-folder editor.
- A new granularity preference for the third level.
- More than three folder levels.
- Persisting inferred detail schemas between runs.
- Replacing the existing category/subcategory generation and reconciliation pipeline.
- Creating detail folders for sparse groups merely to make the tree visually uniform.

## Acceptance criteria

- Both category modes can produce an inferred third level.
- No detail folder is created from a group with fewer than 6 bookmarks.
- Every retained detail folder contains at least 2 bookmarks.
- Every split subcategory retains at least 2 detail folders.
- Browser and HTML output represent the same three-level hierarchy.
- Failed detail enrichment degrades to the existing valid two-level result.
- No inferred hierarchy field is saved as user configuration.
- Flat date sorting remains unchanged and schema-free.
