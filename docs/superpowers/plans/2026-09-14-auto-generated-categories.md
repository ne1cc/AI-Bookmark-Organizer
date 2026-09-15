# Auto-Generated Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-on, run-scoped “Infer categories” mode that generates a complete category/subcategory schema from all bookmarks and requires manual categories when inference is off.

**Architecture:** Keep manual and inferred schema generation as explicit paths. The UI persists only `inferCategories`; it sends dormant manual categories unchanged plus the mode flag through both execution paths. `OrganizerService` chooses either the existing authoritative-category generator or a new dynamic generator, then carries the resulting schema unchanged through classification, reconciliation, sorting, and folder creation.

**Tech Stack:** React 18, JavaScript, Chrome/Firefox MV3 extension APIs, Vitest, Testing Library, Vite.

**Spec:** `docs/superpowers/specs/2026-09-14-auto-generated-categories-design.md`

## Global Constraints

- New installs start with no selected manual categories and `inferCategories` enabled.
- Existing saved manual category arrays remain stored and are never overwritten by an inferred schema.
- Inferred categories and subcategories are run-scoped and are never written to `chrome.storage.local` or `localStorage`.
- Inference receives every normalized bookmark in the run; it must not apply `SCHEMA_SAMPLE_LIMIT`.
- Manual mode continues to enforce the user’s exact top-level category names.
- Inference failure is terminal and actionable; it must never silently collapse to `Other`.
- Flat date sort remains schema-free and bypasses category inference.
- Add no dependency and do not restructure bookmark parsing.

---

### Task 1: Dynamic schema generation from the full bookmark collection

**Files:**
- Modify: `frontend/src/services/ai.js:499-736`
- Test: `frontend/src/services/schema-validation.test.js`

**Interfaces:**
- Consumes: existing `callModel`, `withRetry`, `validateSchema`, `subfolderBounds`, and cancellation/retry callback conventions.
- Produces: `generateInferredSchema(bookmarks, apiKey, model, subfolderTarget, isCancelled, onRetry): Promise<{ categories: Array<{ name: string, sub_categories: string[] }> }>`.

- [ ] **Step 1: Write a failing full-input inference test**

Add a test that creates 205 uniquely named bookmarks, stubs `fetch` with a valid dynamic schema, calls `generateInferredSchema`, and asserts that the serialized request contains both bookmark 1 and bookmark 205 and does not contain `FIXED TOP-LEVEL CATEGORIES`.

```js
it('uses every bookmark and permits model-generated top-level categories', async () => {
    const bookmarks = Array.from({ length: 205 }, (_, index) => ({
        title: `Bookmark ${index + 1}`,
        url: `https://example.com/${index + 1}`
    }))
    let body
    global.fetch = vi.fn(async (url, options) => {
        body = JSON.parse(options.body)
        return orResponse(JSON.stringify({
            categories: [
                { name: 'Engineering', sub_categories: ['Frontend', 'Backend'] },
                { name: 'Research', sub_categories: ['Papers', 'Reference'] },
                { name: 'Personal', sub_categories: ['Health', 'Travel'] }
            ]
        }))
    })

    const schema = await generateInferredSchema(bookmarks, 'sk-or-test-key')
    const prompt = body.messages[1].content

    expect(prompt).toContain('Bookmark 1')
    expect(prompt).toContain('Bookmark 205')
    expect(prompt).not.toContain('FIXED TOP-LEVEL CATEGORIES')
    expect(schema.categories.map(category => category.name)).toEqual(['Engineering', 'Research', 'Personal'])
})
```

- [ ] **Step 2: Run the focused test and confirm the missing-export failure**

Run: `cd frontend && npm test -- --run src/services/schema-validation.test.js`

Expected: FAIL because `generateInferredSchema` is not exported.

- [ ] **Step 3: Implement the dedicated inferred-schema function**

In `ai.js`, extract only the reusable prompt request/retry pieces needed by both modes, then implement the dynamic prompt with `const schemaSource = bookmarks` and no call to `sampleForSchema`.

```js
export async function generateInferredSchema(
    bookmarks,
    apiKey,
    model = 'google/gemini-3.1-flash-lite',
    subfolderTarget = '1-3',
    isCancelled = null,
    onRetry = null
) {
    const { ask: [askMin, askMax] } = subfolderBounds(subfolderTarget)
    const buildPrompt = issues => buildSchemaPrompt({
        bookmarks,
        bookmarkCount: bookmarks.length,
        askMin,
        askMax,
        subfolderTarget,
        fixedCategories: null,
        issues
    })
    const attempt = issues => requestSchema(buildPrompt(issues), apiKey, model, isCancelled, onRetry)
    const options = { subfolderTarget, bookmarkCount: bookmarks.length, expectedCategories: null }

    const first = validateSchema(await attempt(null), options)
    if (first.ok) return first.schema
    notifySchemaCorrection(onRetry, first.issues)

    const second = validateSchema(await attempt(first.issues), options)
    if (second.ok) return second.schema

    const error = new Error(`the AI could not infer a usable folder structure (${second.issues.join('; ')})`)
    error.schemaInvalid = true
    throw error
}
```

The inferred prompt must request broad, mutually exclusive top-level categories, require 1–3 word Title Case names, prohibit filler categories where a topical category is possible, and preserve the existing subfolder bounds and JSON shape.

- [ ] **Step 4: Add failure and cancellation coverage**

Add tests proving that two invalid dynamic schemas reject with `schemaInvalid === true`, and that the existing `isCancelled`/`onRetry` callbacks are passed through exactly as they are for manual schema generation.

```js
await expect(generateInferredSchema(bookmarks, 'sk-or-test-key', undefined, '1-3'))
    .rejects.toMatchObject({ schemaInvalid: true })
```

- [ ] **Step 5: Run AI tests and commit**

Run: `cd frontend && npm test -- --run src/services/schema-validation.test.js src/services/organizer.test.js`

Expected: PASS.

```bash
git add frontend/src/services/ai.js frontend/src/services/schema-validation.test.js
git commit -m "feat(ai): infer category schema from full collection"
```

### Task 2: Carry inferred schemas through OrganizerService without authoritative replacement

**Files:**
- Modify: `frontend/src/services/organizer.js:1-5,232-275,438-480,795-1030`
- Test: `frontend/src/services/organizer.test.js`

**Interfaces:**
- Consumes: `generateInferredSchema` from Task 1.
- Produces: `new OrganizerService(..., schemaSortOrder, inferCategories)` with `inferCategories = true`; an internal `isInferenceMode()` predicate; an effective run schema that is dynamic in inference mode and authoritative in manual mode.

- [ ] **Step 1: Write a failing organizer-path regression test**

Mock `generateInferredSchema` to return Engineering/Research, mock `classifyBatch`, construct the service with `categories = []` and `inferCategories = true`, and assert that classification receives the inferred schema unchanged.

```js
it('classifies against the run-scoped inferred schema instead of replacing it with Other', async () => {
    const inferred = {
        categories: [
            { name: 'Engineering', sub_categories: ['Frontend'] },
            { name: 'Research', sub_categories: ['Papers'] }
        ]
    }
    vi.spyOn(ai, 'generateInferredSchema').mockResolvedValue(inferred)
    const classify = vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
        { title: 'React', url: 'https://react.dev', category: 'Engineering', sub_category: 'Frontend' }
    ])

    const service = new OrganizerService(
        'test-key', [], vi.fn(), undefined, undefined, undefined,
        undefined, undefined, false, undefined, undefined, true
    )
    await service.start([{ title: 'React', url: 'https://react.dev' }])

    expect(classify.mock.calls[0][2]).toEqual(inferred)
    expect(classify.mock.calls[0][2].categories[0].name).not.toBe('Other')
})
```

- [ ] **Step 2: Run the focused organizer test and confirm it fails**

Run: `cd frontend && npm test -- --run src/services/organizer.test.js`

Expected: FAIL because `OrganizerService` still calls `generateSchema` and `buildAuthoritativeSchema([])`.

- [ ] **Step 3: Add the explicit mode branch**

Append `inferCategories = true` to the constructor, store it, and select the schema generator before classification.

```js
const inferenceMode = this.inferCategories
schema = inferenceMode
    ? await generateInferredSchema(
        activeLinks, this.apiKey, this.model, this.subfolderTarget,
        () => this.isCancelled, schemaRetryReporter
    )
    : await generateSchema(
        activeLinks, this.apiKey, this.categories, this.model, this.subfolderTarget,
        () => this.isCancelled, schemaRetryReporter
    )

if (!inferenceMode) {
    schema = buildAuthoritativeSchema(this.categories, schema)
}
```

Use `schema.categories` rather than `buildAuthoritativeSchema(this.categories)` to build `categoryRank` in inference mode. Keep the current authoritative rebuild, reduced-sample retry, and curated fallback only for manual mode.

- [ ] **Step 4: Make inference failure terminal**

In the schema-generation catch, retain cancellation handling first. When `inferenceMode` is true, emit an error that tells the user category inference failed and rethrow/return through the existing terminal error path. Do not call `retrySchemaOnSmallerSample`, `buildFallbackSchema([])`, or classify against `Other`.

```js
if (inferenceMode) {
    this.onProgress({
        status: 'error',
        message: `Could not infer categories from your bookmarks: ${err.message}`
    })
    throw err
}
```

- [ ] **Step 5: Add mode-isolation tests**

Add tests proving:

- inference failure never calls `classifyBatch` and never produces `Other`;
- manual mode still calls `generateSchema` and enforces the selected category names;
- flat date sort does not call either schema generator;
- inferred category names are reflected in `stats.categoryBreakdown`/`categoriesCount` but are not sent to a storage API by the service.

- [ ] **Step 6: Run organizer tests and commit**

Run: `cd frontend && npm test -- --run src/services/organizer.test.js src/services/subcategory-pipeline.test.js`

Expected: PASS.

```bash
git add frontend/src/services/organizer.js frontend/src/services/organizer.test.js
git commit -m "feat(organizer): preserve run-scoped inferred categories"
```

### Task 3: Add the default-on Infer categories UI and manual-mode validation

**Files:**
- Modify: `frontend/src/components/Organizer.jsx:182-190,423-504,540-590,840-1045,1597-1810`
- Test: `frontend/src/components/Organizer.test.jsx`

**Interfaces:**
- Consumes: final `inferCategories` constructor parameter from Task 2.
- Produces: persisted boolean setting `inferCategories`; new-install `categories = []`; UI mode selection and validation before either run path starts.

- [ ] **Step 1: Write failing UI state tests**

Add tests for the new-install defaults and dormant controls.

```jsx
it('defaults new installs to inferred categories with no manual selection', () => {
    render(<Organizer />)

    expect(screen.getByRole('switch', { name: /Infer categories/i }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/No manual categories selected/i)).toBeDefined()
    expect(screen.getByPlaceholderText(/Add custom category/i).disabled).toBe(true)
})
```

Add a persistence test that turns inference off and expects both `localStorage.setItem('inferCategories', 'false')` behavior and `chrome.storage.local.set({ inferCategories: false })` through `updateSetting`.

- [ ] **Step 2: Run the component test and confirm it fails**

Run: `cd frontend && npm test -- --run src/components/Organizer.test.jsx`

Expected: FAIL because the toggle is absent and defaults still select `DEFAULT_CATEGORIES`.

- [ ] **Step 3: Implement state initialization and storage hydration**

Initialize categories and inference independently, preserving stored arrays including `[]`.

```js
const [categories, setCategories] = useState(() => getStored('categories', []))
const [inferCategories, setInferCategories] = useState(() => getStored('inferCategories', true))

const handleInferCategoriesToggle = useCallback(enabled => {
    setInferCategories(enabled)
    updateSetting('inferCategories', enabled)
}, [updateSetting])
```

Add `inferCategories` to the `chrome.storage.local.get` key list and hydrate it only when `typeof result.inferCategories === 'boolean'`. Change category hydration to `if (Array.isArray(result.categories))` so an empty saved list remains empty.

- [ ] **Step 4: Render and style the toggle and dormant editor**

Place a labeled switch in the Customize Categories header. Wrap manual input, active chips, clear/reset controls, and suggestions in a container with `aria-disabled={inferCategories}`, reduced opacity, blur (subtle enough to remain readable), and `pointerEvents: inferCategories ? 'none' : 'auto'`. Disable the actual input/buttons as well so keyboard users cannot activate them.

Use explanatory copy:

```text
Infer categories
AI creates categories from this run’s bookmarks. Manual choices stay saved but inactive.
```

- [ ] **Step 5: Add preflight validation and pass the mode through both panel paths**

Before constructing/sending a job, block only the non-flat manual-mode case with no categories.

```js
if (!flatDateSort && !inferCategories && categories.length === 0) {
    setErrorMsg('Add at least one category or turn on Infer categories.')
    setStatus('error')
    return
}
```

Add `inferCategories` to the `START_JOB` config payload and append it to the in-panel `OrganizerService` constructor call. Include it in the `startOrganization` callback dependency array.

- [ ] **Step 6: Add run-scoped persistence coverage**

Mock an inferred organization completion and assert that neither local nor Chrome storage receives generated category names. Also assert that turning inference off re-enables the preserved manual controls and that manual mode with `[]` shows the required-category error.

- [ ] **Step 7: Run component tests and commit**

Run: `cd frontend && npm test -- --run src/components/Organizer.test.jsx`

Expected: PASS.

```bash
git add frontend/src/components/Organizer.jsx frontend/src/components/Organizer.test.jsx
git commit -m "feat(ui): add inferred category mode"
```

### Task 4: Propagate inference mode through background execution

**Files:**
- Modify: `frontend/src/background/jobRunner.js:105-221`
- Test: `frontend/src/background/jobRunner.test.js`
- Test: `frontend/src/background/index.test.js`

**Interfaces:**
- Consumes: `config.inferCategories: boolean` from Task 3 and the final `OrganizerService` constructor argument from Task 2.
- Produces: identical inferred/manual behavior whether the service worker acknowledges `START_JOB` or the panel falls back to local execution.

- [ ] **Step 1: Write a failing config-forwarding test**

Add `inferCategories: true` to a background job config, mock/capture `OrganizerService`, and assert that its final constructor argument is `true`.

```js
expect(OrganizerService).toHaveBeenCalledWith(
    expect.any(String),
    [],
    expect.any(Function),
    expect.anything(),
    expect.anything(),
    expect.anything(),
    expect.anything(),
    expect.anything(),
    false,
    expect.anything(),
    expect.anything(),
    true
)
```

- [ ] **Step 2: Run background tests and confirm the missing forwarding failure**

Run: `cd frontend && npm test -- --run src/background/jobRunner.test.js src/background/index.test.js`

Expected: FAIL because `inferCategories` is not destructured or forwarded.

- [ ] **Step 3: Forward and log the mode**

Destructure `inferCategories = true`, append it to `new OrganizerService(...)`, and add one non-flat startup log:

```js
this.addLog(`Category Source: ${inferCategories ? 'AI inferred from bookmarks' : `${categories.length} manual categories`}`)
```

Do not put inferred schema/category names into `currentJob`, session snapshots, or local storage.

- [ ] **Step 4: Verify both service-worker and fallback contracts**

Extend the `START_JOB` message test to assert the config remains intact through `background/index.js`. Keep the existing UI test that exercises the unacknowledged-worker fallback and assert the locally constructed service receives the same mode.

- [ ] **Step 5: Run background and component tests and commit**

Run: `cd frontend && npm test -- --run src/background/jobRunner.test.js src/background/index.test.js src/components/Organizer.test.jsx`

Expected: PASS.

```bash
git add frontend/src/background/jobRunner.js frontend/src/background/jobRunner.test.js frontend/src/background/index.test.js frontend/src/components/Organizer.test.jsx
git commit -m "feat(background): forward inferred category mode"
```

### Task 5: End-to-end regression, compatibility, and release verification

**Files:**
- Modify: `frontend/src/services/subcategory-pipeline.test.js`
- Modify: `frontend/src/services/defaultSchema.test.js`
- Verify: `frontend/src/services/defaultSchema.js`
- Verify: `frontend/package.json`

**Interfaces:**
- Consumes: completed inferred/manual flows from Tasks 1–4.
- Produces: regression evidence that inferred and manual modes remain isolated across the complete pipeline.

- [ ] **Step 1: Add a pipeline regression test**

Create a test with an inferred schema containing at least three top-level categories, classify bookmarks into each, and assert the final results retain those generated names and subcategory pairs.

```js
expect(new Set(results.map(item => item.category))).toEqual(
    new Set(['Engineering', 'Research', 'Personal'])
)
expect(results).not.toContainEqual(expect.objectContaining({ category: 'Other' }))
```

- [ ] **Step 2: Add compatibility assertions**

Assert that manual empty-category fallback helpers still return `Other` when called directly, while OrganizerService never invokes that fallback in inferred mode. This protects the old helper contract without allowing it back into the new path.

- [ ] **Step 3: Run the full test suite**

Run: `cd frontend && npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 4: Run static and production checks**

Run: `cd frontend && npm run lint`

Expected: no new lint errors in changed files. If repository-baseline lint errors remain in untouched files, record them verbatim in the handoff.

Run: `cd frontend && npm run build`

Expected: Chrome and Firefox production builds complete successfully.

- [ ] **Step 5: Review persistence and diff boundaries**

Run:

```bash
git diff main...HEAD --check
git diff main...HEAD -- frontend/src docs/superpowers
git status --short
```

Confirm the only persistent setting added is `inferCategories`, no generated schema is stored, and no build artifacts or unrelated files are tracked.

- [ ] **Step 6: Commit final regression coverage**

```bash
git add frontend/src/services/subcategory-pipeline.test.js frontend/src/services/defaultSchema.test.js
git commit -m "test: cover inferred category pipeline"
```
