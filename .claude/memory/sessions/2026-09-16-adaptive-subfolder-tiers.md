# 2026-09-16 — Adaptive three-tier subfolder scale + population-aware budgets

## What changed
Redefined the subfolder granularity tiers (Compact now 3-5, per user request), made the ask
adaptive within each tier, and made it population-aware per category (census-measured).

- `frontend/src/services/ai.js`
  - `SUBFOLDER_BOUNDS` (6 keys incl. 3 dead legacy ids) → `SUBFOLDER_TIERS` (3 tiers):
    `3-5` Compact {ask:[3,5], min:2, max:5, minCount:3}, `5-8` Balanced {min:3, max:8, minCount:3},
    `8-12` Detailed {min:3, max:12, minCount:2}. Each tier now carries `minCount`
    (reconciliation dissolve floor) — data, not the old hardcoded id list.
  - New `normalizeSubfolderTarget()` (single source for all 6 retired ids: `0-5`,`1-3`→`3-5`,
    `3-6`,`5-10`→`5-8`, `6-10`,`10+`→`8-12`; unknown→`3-5`). Organizer.jsx's local copy deleted.
  - New `adaptiveSubfolderAsk(target, bookmarkCount)`: band bottom pinned to tier floor;
    band top opens with log-scaled collection size (150→3000 bookmarks maps 0→1).
    Tiny collections (<40) relax the whole band to [1, lo].
  - New `requiredSubfolderMin()` shared by `validateSchema` and the correction prompt text
    (correction now cites the enforced floor, not the ask bottom).
  - Schema prompt rule 1 gained the "band, not a quota" clause: scale per category to its
    weight in the collection (dominant → top of band, sparse → bottom); no padding.
- `frontend/src/services/reconcile.js` — `minCount`/`max` now read from the tier.
- `frontend/src/services/organizer.js` — constructor default `3-5`; reduced-sample retry `5-8`.
- `frontend/src/components/Organizer.jsx` — new tier ids/labels/descriptions, explainer image
  keys rekeyed, normalize imported from services/ai.
- `frontend/src/background/jobRunner.js` — log fallback `3-5`.
- `README.md` — tier ranges updated.

## Rationale (design alternatives rejected)
- Model-estimated per-category weights as a JSON field: superseded — a measured census
  (classifying the existing 200-bookmark sample, one extra call, index-only output) is
  grounded data at nearly the same cost; stated shares remain a possible future fallback.
- Continuous slider (0-10): deferred; three named tiers kept for UI simplicity, but the
  engine no longer hardcodes anything per-id so adding a slider later is mechanical.
- Per-category population caps inside reconciliation: analyzed and NOT needed — survivors
  ≥ minCount already implies ≤ floor(n_c/minCount) folders survive; minCount dissolution
  + tier cap are exactly the population ceiling once real counts exist.
- Two-pass classify-sample-then-schema: rejected; census (one call, ≤200 bookmarks) gives
  the shares the pre-pass would, without a full extra classification wave.

## Census mechanism (session 2)
- `censusShares()` in ai.js: classifies the schema sample into the selected top-level
  categories, one call, `{assignments: [int]}` output, deduped case-insensitive names.
  Best-effort by design: 1 attempt, malformed/short/invalid-index → null (no retry
  burn); cancellation propagates. null → uniform bands = previous behavior.
- `buildCategoryBands(shares, N, target)`: per-category band from population math
  n̂_c = share_c × N; popMax = ⌊n̂_c/minCount⌋; popMax < tier floor → band [1, popMax]
  (sparse branch); else [floor, floor + t·(min(tierMax, popMax) − floor)] with
  t = collectionSpread(N) (extracted log curve, 150→3000).
- generateSchema: census → bands → prompt gains "PER-CATEGORY SUBFOLDER RANGES" block;
  rule 1 references per-category ranges; "ranges are bands, not quotas" wording.
- validateSchema: options.categoryBands (Map lowercase-name → band); per-category floor
  = min(requiredMin, band.lower) — keeps today's leniency for healthy categories,
  permits minimal structure for near-empty ones; floorForCategory stripped from output.
- Reconciliation, classification batching: unchanged (see rejected-alternatives note).

## Verification
- `npx vitest run` → 18 files, 345 tests passed (321 → 345 across both sessions).
- `npm run lint` → 0 errors, 4 warnings (baseline 5).
- `npm run build:chrome` → success.

## Notes / follow-ups
- Census adds 1 AI call per organize run (~2-3s, few hundred output tokens, independent
  of collection size). K ≤ 1 categories skips it entirely.
- The lopsided behavioral test (4000 bookmarks, 99.75% Finance) pins the divergence:
  dominant category gets "5-8", near-empty ones "exactly 1".
- Possible future: cross-check census shares against realized classification counts and
  surface divergence in the run log; surfacing per-category final folder counts in UI.

## Ship
- Rebased onto origin/main mid-flight (upstream had added `buildSchemaPrompt` extraction,
  `generateInferredSchema`, and the detail-folders third level). Merged resolution: kept
  upstream's prompt-builder architecture, threaded census/bands through it as
  `rangesBlock`/`askText` params; inferred path intentionally runs without census
  (no fixed category list to measure) and relies on reconciliation for per-category
  enforcement after classification.
- Post-rebase verification: 439 tests passed (upstream added ~94), lint 0 errors,
  build:all green.
- Shipped: https://github.com/ne1cc/AI-Bookmark-Organizer/pull/77
  (branch `t3code/audit-subcategory-designation`, commit `27f87ba`).
- Styling pass (commit 59d9884): `.header-title-block` padding-top
  clamp(0.5rem, 2cqi, 1rem) — toolbar→title gap 12px → 24px, verified via Playwright.

## Session 3 — strict cutoffs removed (commit c95e231)
- Tiers are now relative pressure weights: compact 0.5, medium 0.7, detailed 1.0
  (minCount folder-size floors stay: 3/3/2). Ids are `compact`/`medium`/`detailed`;
  ALL retired numeric ids map in LEGACY_SUBFOLDER_TARGETS.
- `categorySubfolderPlan(shares, N, target)`: k = round(w × √n̂), band = ±2 clamped to
  [1, ⌊n̂/minCount⌋]. Removed adaptiveSubfolderAsk/collectionSpread/requiredSubfolderMin/
  buildCategoryBands — no log curve, no tier min/max constants anywhere.
- validateSchema: per-tier depth floors deleted; rejects only degenerate schemas
  (0 real subs, flat-overall, narrow breadth). subfolderTarget no longer a param.
- reconcile: fixed tier ceiling replaced by dynamicCap = max(3, 2×round(w×√n_c)) from
  real per-category counts (categoryTotals includes sink items).
- Census fallback: uniform shares (1/K) when census fails/skipped; K=0 → qualitative
  ask (no numbers) — also used by generateInferredSchema.
- UI: buttons show Compact / Medium / Detailed with no numbers; diagrams unchanged.
- Gotcha for future sweeps: perl pattern '10+' matches bookmark id '10' (regex +);
  escape metacharacters when sweeping ids vs tier ids.
- Verification: 433 tests, lint 0 errors, build:all green, UI verified via Playwright.
- Stored prefs migrate transparently: old ids normalize on load (UI + engine).
