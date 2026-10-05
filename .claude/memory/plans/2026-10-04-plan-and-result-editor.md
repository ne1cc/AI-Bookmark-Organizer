# Plan and Result Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One switch, **Review folders before saving**, adds two pauses to a run: the proposed folder plan (editable, binding) before any bookmark is filed, and the finished three-level folders (editable, with bookmark counts) before anything is written.

**Architecture:** Two pure editing models (`planEditor.js` for the plan, `resultEditor.js` for the finished structure) sit behind one shared tree view (`FolderTree`) inside an overlay shell (`EditorDialog`). A `ReviewPanel` component renders the review cards, owns the user's edits and mirrors them to session storage. The organizer service pauses at two gates (`reviewPlan`, `reviewResult`); the background job runner publishes what to review and relays the panel's decision. An approved plan carries `binding: true` so `reconcile` never dissolves its folders. The panel's result edits are an operation list the worker replays on the real bookmarks, so the bookmark list never crosses the port.

**Tech Stack:** React 19 (function components, plain JSX), Vite, Vitest 4 + Testing Library + jsdom, Chrome MV3 service worker (`chrome.storage.session`), Playwright-core with Chrome for Testing for the real-browser checks.

**Spec:** `.claude/memory/specs/2026-10-04-plan-editor-design.md` (read it first). Two refinements made while planning, both already folded into the spec: (1) a user-edited plan is validated in `OrganizerService.reviewPlan`, not in the job runner, so the worker path and the in-panel fallback share it; (2) the result review sends `rows` (distinct folder paths with counts) to the panel instead of a prebuilt tree, and both sides build the tree from the same rows with `buildTree`.

## Global Constraints

- Run every command from `frontend/` unless a step says otherwise. The repo root is its parent.
- Stay on branch `worktree-two-phase-plan-review` (draft PR #99). Do not rename or rebase it.
- No new dependencies. Plain JSX, no TypeScript. Match the style of the file you edit (components use 4-space indent and no semicolons; services files use semicolons).
- The setting is `reviewFolders`, default `false`, label **Review folders before saving**, hidden in the no-AI date (flat) mode. It replaces the prototype's `reviewPlan` key; the prototype was never released, so nothing migrates.
- Edits apply to the current run only and are never written to the saved `categories` setting.
- Folder-name rules (editors and tests): non-empty; unique among siblings by `canonicalKey`; a subfolder is not named like its parent; names in `SINK_NAMES` (General, Other, None, Uncategorized, Misc, Miscellaneous, Various) are refused for subfolders; no `/` or `\`.
- Reviewer contracts: `planReviewer(schema, error | null)` resolves `{ decision: 'approve' | 'regenerate' | 'cancel', plan? }`; `resultReviewer(rows, error | null)` resolves `{ decision: 'approve' | 'cancel', ops? }`. A non-null `error` is the reason the previous answer was rejected.
- Operation shape: `{ op: 'rename' | 'delete' | 'move' | 'merge', path: string[], to?: string | string[] }` (`to` is the new name for `rename`, and a folder path for `move` and `merge`).
- An approved plan carries `binding: true`; nothing else sets it.
- Session-storage key for saved edits: `reviewDraft` (value `{ planEdit, resultEdit }`). Edits are only applied to the exact plan/rows they were made against.
- Every commit uses a conventional-commit message ending with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Before finishing any task: `npx vitest run` is green and `npm run lint` reports 0 errors (3 existing warnings in `Organizer.jsx` are expected).
- Shell hygiene in this worktree: run one simple command per call. A git hook rejects long chained git commands.

## File Structure

| File | Responsibility |
|---|---|
| `src/services/ai.js` (modify) | Export `normalizeSchema`; `validateSchema` calls it. |
| `src/services/planEditor.js` (new, pure) | Plan edits: rename, add, remove, move, merge. Returns `{ plan }` or `{ error }`. |
| `src/services/resultEditor.js` (new, pure) | `buildRows`, `buildTree`, `applyOps`, `detailStats`, `recordPath` for the finished structure. |
| `src/services/reconcile.js` (modify) | Honour `schema.binding`. |
| `src/services/organizer.js` (modify) | `reviewPlan` (validate, bind, loop) and `reviewResult` (apply ops, loop) gates. |
| `src/background/jobRunner.js`, `src/background/index.js` (modify) | Publish `plan` / `result` for review, relay decisions, clear stale drafts. |
| `src/components/EditorDialog.jsx` (new) | Modal shell: labelled dialog, focus trap/return, discard prompt, live error region. |
| `src/components/FolderTree.jsx` (new) | Shared tree view: expand, inline rename/add, delete confirm, move/merge menus. |
| `src/components/PlanEditor.jsx`, `ResultEditor.jsx` (new) | Thin wrappers that supply nodes and operations to `FolderTree`. |
| `src/components/ReviewPanel.jsx` (new) | The two review cards, edit drafts, lazy-loaded editors. |
| `src/components/Organizer.jsx` (modify) | Setting rename, state, decision relay, in-panel fallback gates, renders `ReviewPanel`. |

---

## Foundations: pure models and editor components (no wiring yet; every task is independently safe to commit)

### Task 1: Extract `normalizeSchema`

**Files:**
- Modify: `src/services/ai.js` (the top of `validateSchema`, around line 759)
- Create: `src/services/normalize-schema.test.js`

**Interfaces:**
- Produces: `normalizeSchema(schema): { categories: [{ name: string, sub_categories: string[] }] }`, exported from `services/ai.js`. It trims, drops case-duplicate categories, drops filler subfolders and subfolders that echo their category, and dedupes subfolders. It makes no quality judgement (no minimum category count, no catch-all rejection).

- [ ] **Step 1: Write the failing test**

Create `src/services/normalize-schema.test.js`:

````js
import { describe, expect, it } from 'vitest'
import { normalizeSchema, validateSchema } from './ai'

describe('normalizeSchema', () => {
    it('trims, drops case-duplicate categories, filler subfolders and parent echoes, and dedupes subfolders', () => {
        const result = normalizeSchema({
            categories: [
                { name: ' Tech ', sub_categories: ['Web', 'web ', 'Webs', 'General', 'Tech', '', 7] },
                { name: 'tech', sub_categories: ['Ignored'] },
                { name: 'Travel' },
                { name: '   ', sub_categories: ['Nothing'] }
            ]
        })

        expect(result).toEqual({
            categories: [
                { name: 'Tech', sub_categories: ['Web'] },
                { name: 'Travel', sub_categories: [] }
            ]
        })
    })

    it('makes no quality judgement: two categories and a catch-all name are fine', () => {
        const result = normalizeSchema({ categories: [{ name: 'Misc', sub_categories: [] }, { name: 'Tech', sub_categories: [] }] })

        expect(result.categories.map(c => c.name)).toEqual(['Misc', 'Tech'])
    })

    it('returns no categories for a missing or empty schema, and ignores extra fields', () => {
        expect(normalizeSchema(null)).toEqual({ categories: [] })
        expect(normalizeSchema({ categories: 'nope' })).toEqual({ categories: [] })
        expect(normalizeSchema({ binding: true, categories: [{ name: 'A', sub_categories: [] }] })).toEqual({ categories: [{ name: 'A', sub_categories: [] }] })
    })

    it('is what validateSchema cleans with', () => {
        const raw = { categories: [{ name: 'Tech', sub_categories: ['Web', 'web', 'General'] }, { name: 'Travel', sub_categories: ['Flights'] }, { name: 'Finance', sub_categories: ['Tax'] }] }

        expect(validateSchema(raw, { bookmarkCount: 10 }).schema).toEqual(normalizeSchema(raw))
    })
})
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/services/normalize-schema.test.js`
Expected: FAIL (`normalizeSchema` is not exported from `./ai`).

- [ ] **Step 3: Extract the function**

In `src/services/ai.js`, replace this block:

````js
// Validate a model-generated schema and return a cleaned copy alongside any
// reasons it is unusable. Normalizing here means callers (and the classifier)
// never see filler subcategories or case-duplicate folder names.
export function validateSchema(schema, { bookmarkCount = Infinity, expectedCategories = null } = {}) {
    const issues = [];
    const rawCategories = Array.isArray(schema?.categories) ? schema.categories : null;

    if (!rawCategories || rawCategories.length === 0) {
        return { ok: false, issues: ['the response contained no categories'], schema: { categories: [] } };
    }

    const categories = [];
    const seenCategories = new Set();

    for (const raw of rawCategories) {
````

with:

````js
// Trim and dedupe a schema, dropping filler subfolders and subfolders that echo
// their category. Makes no judgement about whether the structure is rich enough:
// the AI path adds those checks in `validateSchema`; a user-edited plan does not.
export function normalizeSchema(schema) {
    const rawCategories = Array.isArray(schema?.categories) ? schema.categories : [];
    const categories = [];
    const seenCategories = new Set();

    for (const raw of rawCategories) {
````

Then replace this block (a few lines further down, the end of the same loop):

````js
        categories.push({ name, sub_categories });
    }

    if (categories.length === 0) {
        return { ok: false, issues: ['no category had a usable name'], schema: { categories: [] } };
    }
````

with:

````js
        categories.push({ name, sub_categories });
    }

    return { categories };
}

// Validate a model-generated schema and return a cleaned copy alongside any
// reasons it is unusable. Normalizing here means callers (and the classifier)
// never see filler subcategories or case-duplicate folder names.
export function validateSchema(schema, { bookmarkCount = Infinity, expectedCategories = null } = {}) {
    const issues = [];

    if (!Array.isArray(schema?.categories) || schema.categories.length === 0) {
        return { ok: false, issues: ['the response contained no categories'], schema: { categories: [] } };
    }

    const { categories } = normalizeSchema(schema);

    if (categories.length === 0) {
        return { ok: false, issues: ['no category had a usable name'], schema: { categories: [] } };
    }
````

- [ ] **Step 4: Run the services tests**

Run: `npx vitest run src/services`
Expected: PASS (every existing `validateSchema` test still passes unchanged, plus the 4 new ones).

- [ ] **Step 5: Lint and commit**

Run: `npm run lint` (expect 0 errors).

```bash
git add src/services/ai.js src/services/normalize-schema.test.js
git commit -m "refactor: extract normalizeSchema from validateSchema"
```

(Add the Co-Authored-By trailer line to the message.)

---

### Task 2: The plan editing model

**Files:**
- Create: `src/services/planEditor.js`
- Test: `src/services/planEditor.test.js`

**Interfaces:**
- Consumes: `canonicalKey` (`services/subcategoryIdentity.js`), `SINK_NAMES` (`services/subcategoryPredicates.js`).
- Produces (all pure; each returns `{ plan }` or `{ error: string }` and never mutates its input; a plan is `{ categories: [{ name, sub_categories: string[] }] }`):
  - `checkName(name, siblings, parent = null): string | null`
  - `summarize(plan): { categories, subfolders }`
  - `renameCategory(plan, name, to)`, `renameSubfolder(plan, categoryName, name, to)`
  - `addCategory(plan, name)`, `addSubfolder(plan, categoryName, name)`
  - `removeCategory(plan, name)` (refuses to remove the last category), `removeSubfolder(plan, categoryName, name)`
  - `moveSubfolder(plan, fromCategory, name, toCategory)`
  - `mergeSubfolders(plan, { category, name }, { category, name })` (source disappears, target keeps its name)
  - `mergeCategories(plan, sourceName, targetName)` (source's subfolders move over, duplicates dropped, source disappears)

- [ ] **Step 1: Write the failing test**

Create `src/services/planEditor.test.js`:

````js
import { describe, expect, it } from 'vitest'
import {
    addCategory, addSubfolder, checkName, mergeCategories, mergeSubfolders, moveSubfolder,
    removeCategory, removeSubfolder, renameCategory, renameSubfolder, summarize
} from './planEditor'

const plan = () => ({
    categories: [
        { name: 'Tech', sub_categories: ['Web', 'Data'] },
        { name: 'Travel', sub_categories: ['Flights', 'Hotels'] },
        { name: 'Finance', sub_categories: [] }
    ]
})

describe('checkName', () => {
    it('accepts a fresh name', () => {
        expect(checkName('Recipes', ['Web'], 'Tech')).toBeNull()
    })

    it('rejects empty, slash, reserved, parent-echo and sibling-duplicate names', () => {
        expect(checkName('   ', [])).toMatch(/empty/i)
        expect(checkName('a/b', [])).toMatch(/slash/i)
        expect(checkName('General', [], 'Tech')).toMatch(/reserved/i)
        expect(checkName('Tech', [], 'Tech')).toMatch(/like its category/i)
        expect(checkName('web ', ['Web'], 'Tech')).toMatch(/already exists/i)
        expect(checkName('Webs', ['Web'], 'Tech')).toMatch(/already exists/i)
    })

    it('allows a reserved-looking name at the category level', () => {
        expect(checkName('Other', ['Tech'])).toBeNull()
    })
})

describe('summarize', () => {
    it('counts categories and subfolders', () => {
        expect(summarize(plan())).toEqual({ categories: 3, subfolders: 4 })
    })
})

describe('rename', () => {
    it('renames a category and keeps its subfolders', () => {
        const { plan: next } = renameCategory(plan(), 'Tech', 'Technology')
        expect(next.categories[0]).toEqual({ name: 'Technology', sub_categories: ['Web', 'Data'] })
    })

    it('refuses a category name that clashes with a sibling or one of its own subfolders', () => {
        expect(renameCategory(plan(), 'Tech', 'travel').error).toMatch(/already exists/i)
        expect(renameCategory(plan(), 'Tech', 'Web').error).toMatch(/subfolder/i)
        expect(renameCategory(plan(), 'Nope', 'X').error).toMatch(/not found/i)
    })

    it('renames a subfolder in place', () => {
        const { plan: next } = renameSubfolder(plan(), 'Tech', 'Web', 'Frontend')
        expect(next.categories[0].sub_categories).toEqual(['Frontend', 'Data'])
    })

    it('refuses an invalid subfolder name and reports a missing one', () => {
        expect(renameSubfolder(plan(), 'Tech', 'Web', 'Data').error).toMatch(/already exists/i)
        expect(renameSubfolder(plan(), 'Tech', 'Web', 'Misc').error).toMatch(/reserved/i)
        expect(renameSubfolder(plan(), 'Tech', 'Nope', 'X').error).toMatch(/not found/i)
    })

    it('allows renaming a subfolder to a different spelling of itself', () => {
        expect(renameSubfolder(plan(), 'Tech', 'Web', 'web').plan.categories[0].sub_categories[0]).toBe('web')
    })
})

describe('add', () => {
    it('adds a category with no subfolders and a subfolder at the end', () => {
        const added = addCategory(plan(), 'Reading').plan
        expect(added.categories.at(-1)).toEqual({ name: 'Reading', sub_categories: [] })
        expect(addSubfolder(added, 'Reading', 'Blogs').plan.categories.at(-1).sub_categories).toEqual(['Blogs'])
    })

    it('rejects duplicates and unknown parents', () => {
        expect(addCategory(plan(), 'tech').error).toMatch(/already exists/i)
        expect(addSubfolder(plan(), 'Tech', 'Web').error).toMatch(/already exists/i)
        expect(addSubfolder(plan(), 'Nope', 'X').error).toMatch(/not found/i)
    })
})

describe('remove', () => {
    it('removes a subfolder and a category', () => {
        expect(removeSubfolder(plan(), 'Tech', 'Web').plan.categories[0].sub_categories).toEqual(['Data'])
        expect(removeCategory(plan(), 'Travel').plan.categories.map(c => c.name)).toEqual(['Tech', 'Finance'])
    })

    it('refuses to remove the last category', () => {
        const single = { categories: [{ name: 'Tech', sub_categories: [] }] }
        expect(removeCategory(single, 'Tech').error).toMatch(/at least one category/i)
    })
})

describe('move', () => {
    it('re-parents a subfolder', () => {
        const next = moveSubfolder(plan(), 'Travel', 'Hotels', 'Tech').plan
        expect(next.categories[0].sub_categories).toEqual(['Web', 'Data', 'Hotels'])
        expect(next.categories[1].sub_categories).toEqual(['Flights'])
    })

    it('refuses a clash, the same category, and missing nodes', () => {
        const clash = addSubfolder(plan(), 'Travel', 'Data').plan
        expect(moveSubfolder(clash, 'Travel', 'Data', 'Tech').error).toMatch(/already exists/i)
        expect(moveSubfolder(plan(), 'Tech', 'Web', 'Tech').error).toMatch(/already in/i)
        expect(moveSubfolder(plan(), 'Tech', 'Nope', 'Travel').error).toMatch(/not found/i)
        expect(moveSubfolder(plan(), 'Tech', 'Web', 'Nope').error).toMatch(/not found/i)
    })
})

describe('merge', () => {
    it('merges a subfolder into another, even across categories; the target keeps its name', () => {
        const next = mergeSubfolders(plan(), { category: 'Travel', name: 'Hotels' }, { category: 'Tech', name: 'Web' }).plan
        expect(next.categories[1].sub_categories).toEqual(['Flights'])
        expect(next.categories[0].sub_categories).toEqual(['Web', 'Data'])
    })

    it('refuses to merge a subfolder into itself', () => {
        const same = { category: 'Tech', name: 'Web' }
        expect(mergeSubfolders(plan(), same, same).error).toMatch(/different/i)
    })

    it('merges categories: subfolders move over, duplicates are dropped, the source disappears', () => {
        const start = addSubfolder(plan(), 'Finance', 'Data').plan
        const next = mergeCategories(start, 'Finance', 'Tech').plan
        expect(next.categories.map(c => c.name)).toEqual(['Tech', 'Travel'])
        expect(next.categories[0].sub_categories).toEqual(['Web', 'Data'])
        const withSubs = mergeCategories(plan(), 'Travel', 'Tech').plan
        expect(withSubs.categories[0].sub_categories).toEqual(['Web', 'Data', 'Flights', 'Hotels'])
    })

    it('refuses category merges into itself or unknown categories', () => {
        expect(mergeCategories(plan(), 'Tech', 'Tech').error).toMatch(/different/i)
        expect(mergeCategories(plan(), 'Nope', 'Tech').error).toMatch(/not found/i)
    })
})

describe('immutability', () => {
    it('never mutates the input plan', () => {
        const original = plan()
        const frozen = JSON.parse(JSON.stringify(original))
        renameCategory(original, 'Tech', 'T')
        renameSubfolder(original, 'Tech', 'Web', 'W')
        addCategory(original, 'New')
        addSubfolder(original, 'Tech', 'New')
        removeCategory(original, 'Travel')
        removeSubfolder(original, 'Tech', 'Web')
        moveSubfolder(original, 'Travel', 'Hotels', 'Tech')
        mergeSubfolders(original, { category: 'Travel', name: 'Hotels' }, { category: 'Tech', name: 'Web' })
        mergeCategories(original, 'Travel', 'Tech')
        expect(original).toEqual(frozen)
    })
})
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/services/planEditor.test.js`
Expected: FAIL (cannot find `./planEditor`).

- [ ] **Step 3: Write the module**

Create `src/services/planEditor.js`:

````js
// Pure editing model for the folder plan: { categories: [{ name, sub_categories: [string] }] }.
// Every function returns { plan } or { error } and never mutates its input.
import { canonicalKey } from './subcategoryIdentity';
import { SINK_NAMES } from './subcategoryPredicates';

const copy = (plan) => ({
    ...plan,
    categories: plan.categories.map(category => ({ ...category, sub_categories: [...category.sub_categories] }))
});

const findCategory = (plan, name) => plan.categories.find(category => category.name === name);

// Returns an error string, or null when `name` is acceptable among `siblings`.
// `parent` is the category name when naming a subfolder.
export function checkName(name, siblings, parent = null) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return 'A name cannot be empty.';
    if (/[\\/]/.test(trimmed)) return 'A name cannot contain slashes.';
    if (parent !== null) {
        if (SINK_NAMES.has(trimmed.toLowerCase())) return `"${trimmed}" is reserved for bookmarks that fit nowhere.`;
        if (canonicalKey(trimmed) === canonicalKey(parent)) return 'A subfolder cannot be named like its category.';
    }
    const clash = siblings.find(sibling => canonicalKey(sibling) === canonicalKey(trimmed));
    if (clash !== undefined) return `"${clash}" already exists here.`;
    return null;
}

export function summarize(plan) {
    return {
        categories: plan.categories.length,
        subfolders: plan.categories.reduce((total, category) => total + category.sub_categories.length, 0)
    };
}

export function renameCategory(plan, name, to) {
    const category = findCategory(plan, name);
    if (!category) return { error: `Category "${name}" was not found.` };
    const error = checkName(to, plan.categories.filter(c => c !== category).map(c => c.name));
    if (error) return { error };
    // A subfolder that now echoes its renamed category would add no structure.
    if (category.sub_categories.some(sub => canonicalKey(sub) === canonicalKey(to.trim()))) {
        return { error: 'A subfolder in this category already has that name.' };
    }
    const next = copy(plan);
    findCategory(next, name).name = to.trim();
    return { plan: next };
}

export function renameSubfolder(plan, categoryName, name, to) {
    const category = findCategory(plan, categoryName);
    if (!category || !category.sub_categories.includes(name)) return { error: `Subfolder "${name}" was not found.` };
    const error = checkName(to, category.sub_categories.filter(sub => sub !== name), category.name);
    if (error) return { error };
    const next = copy(plan);
    const subs = findCategory(next, categoryName).sub_categories;
    subs[subs.indexOf(name)] = to.trim();
    return { plan: next };
}

export function addCategory(plan, name) {
    const error = checkName(name, plan.categories.map(c => c.name));
    if (error) return { error };
    const next = copy(plan);
    next.categories.push({ name: name.trim(), sub_categories: [] });
    return { plan: next };
}

export function addSubfolder(plan, categoryName, name) {
    const category = findCategory(plan, categoryName);
    if (!category) return { error: `Category "${categoryName}" was not found.` };
    const error = checkName(name, category.sub_categories, category.name);
    if (error) return { error };
    const next = copy(plan);
    findCategory(next, categoryName).sub_categories.push(name.trim());
    return { plan: next };
}

export function removeCategory(plan, name) {
    if (!findCategory(plan, name)) return { error: `Category "${name}" was not found.` };
    if (plan.categories.length === 1) return { error: 'A plan needs at least one category.' };
    const next = copy(plan);
    next.categories = next.categories.filter(category => category.name !== name);
    return { plan: next };
}

export function removeSubfolder(plan, categoryName, name) {
    const category = findCategory(plan, categoryName);
    if (!category || !category.sub_categories.includes(name)) return { error: `Subfolder "${name}" was not found.` };
    const next = copy(plan);
    const target = findCategory(next, categoryName);
    target.sub_categories = target.sub_categories.filter(sub => sub !== name);
    return { plan: next };
}

export function moveSubfolder(plan, fromCategory, name, toCategory) {
    const source = findCategory(plan, fromCategory);
    const destination = findCategory(plan, toCategory);
    if (!source || !source.sub_categories.includes(name)) return { error: `Subfolder "${name}" was not found.` };
    if (!destination) return { error: `Category "${toCategory}" was not found.` };
    if (source === destination) return { error: 'The subfolder is already in that category.' };
    const error = checkName(name, destination.sub_categories, destination.name);
    if (error) return { error };
    const next = copy(plan);
    const from = findCategory(next, fromCategory);
    from.sub_categories = from.sub_categories.filter(sub => sub !== name);
    findCategory(next, toCategory).sub_categories.push(name);
    return { plan: next };
}

// The source disappears; the target keeps its name.
export function mergeSubfolders(plan, source, target) {
    const sourceCategory = findCategory(plan, source.category);
    const targetCategory = findCategory(plan, target.category);
    if (!sourceCategory || !sourceCategory.sub_categories.includes(source.name)) return { error: `Subfolder "${source.name}" was not found.` };
    if (!targetCategory || !targetCategory.sub_categories.includes(target.name)) return { error: `Subfolder "${target.name}" was not found.` };
    if (source.category === target.category && source.name === target.name) return { error: 'Choose a different folder to merge into.' };
    return removeSubfolder(plan, source.category, source.name);
}

// The source's subfolders move into the target (names already there are dropped); the source disappears.
export function mergeCategories(plan, sourceName, targetName) {
    const source = findCategory(plan, sourceName);
    const target = findCategory(plan, targetName);
    if (!source) return { error: `Category "${sourceName}" was not found.` };
    if (!target) return { error: `Category "${targetName}" was not found.` };
    if (source === target) return { error: 'Choose a different category to merge into.' };
    const next = copy(plan);
    const into = findCategory(next, targetName);
    const known = new Set(into.sub_categories.map(canonicalKey));
    for (const sub of source.sub_categories) {
        if (known.has(canonicalKey(sub)) || canonicalKey(sub) === canonicalKey(into.name)) continue;
        known.add(canonicalKey(sub));
        into.sub_categories.push(sub);
    }
    next.categories = next.categories.filter(category => category.name !== sourceName);
    return { plan: next };
}
````

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/services/planEditor.test.js`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/planEditor.js src/services/planEditor.test.js
git commit -m "feat: add the pure plan editing model"
```

---

### Task 3: The result editing model

**Files:**
- Create: `src/services/resultEditor.js`
- Test: `src/services/resultEditor.test.js`

**Interfaces:**
- Consumes: `canonicalKey`, `shouldCreateDetailFolder` (`services/subcategoryIdentity.js`), `shouldCreateSubFolder` (`services/subcategoryPredicates.js`), `checkName` (Task 2).
- Produces (pure; none mutates its input). A "record" is a bookmark or a grouped row: `{ category, sub_category, detail_category, count? }` (a missing `count` means 1):
  - `recordPath(record): string[]`: `[category]`, `[category, sub]` or `[category, sub, detail]`: the folders the record is written into (a sink such as `General` means "directly in the parent").
  - `buildRows(items): [{ category, sub_category, detail_category, count }]`: one row per distinct folder path (sink subfolders are normalised to `General`).
  - `buildTree(records): [{ name, path, count, direct, children }]`: nested, sorted by name; `count` covers everything inside, `direct` only what is filed straight into that folder.
  - `detailStats(records): { detailFolders, detailedSubcategories }`.
  - `applyOps(records, ops): { records } | { error }`: applies `rename`, `delete`, `move`, `merge` in order, all or nothing. Rename uses the same naming rules as the plan editor. Delete moves a subfolder's bookmarks up into its category and a third-level folder's up into its subfolder; categories cannot be deleted (merge them). Move re-parents a subfolder to a category (`to: [category]`) or a third-level folder to a subfolder (`to: [category, sub]`). Merge needs a target at the same level; spellings already present under the target win.
  - The same `applyOps` runs on bookmarks in the worker and on grouped rows in the panel, so both give the same tree (the parity test pins this).

- [ ] **Step 1: Write the failing test**

Create `src/services/resultEditor.test.js`:

````js
import { describe, expect, it } from 'vitest'
import { applyOps, buildRows, buildTree, detailStats, recordPath } from './resultEditor'

const bm = (n, category, sub_category, detail_category = null) => ({
    title: `B${n}`, url: `https://example.com/${n}`, category, sub_category, detail_category
})

// Tech/Web (3, with details Frameworks x2 and Tooling x1), Tech/Data (2), Tech directly (1 via General),
// Travel/Flights (2), Travel/Hotels (1)
const items = () => [
    bm(1, 'Tech', 'Web', 'Frameworks'), bm(2, 'Tech', 'Web', 'Frameworks'), bm(3, 'Tech', 'Web', 'Tooling'),
    bm(4, 'Tech', 'Data'), bm(5, 'Tech', 'Data'),
    bm(6, 'Tech', 'General'),
    bm(7, 'Travel', 'Flights'), bm(8, 'Travel', 'Flights'),
    bm(9, 'Travel', 'Hotels')
]

const names = (nodes) => nodes.map(n => n.name)
const find = (nodes, ...path) => path.reduce((level, name) => level.children.find(n => n.name === name), { children: nodes })

describe('recordPath', () => {
    it('stops at the deepest real folder', () => {
        expect(recordPath(bm(1, 'Tech', 'Web', 'Frameworks'))).toEqual(['Tech', 'Web', 'Frameworks'])
        expect(recordPath(bm(1, 'Tech', 'Web'))).toEqual(['Tech', 'Web'])
        expect(recordPath(bm(1, 'Tech', 'General'))).toEqual(['Tech'])
        expect(recordPath(bm(1, 'Tech', 'Web', 'Web'))).toEqual(['Tech', 'Web'])
    })
})

describe('buildRows and buildTree', () => {
    it('groups bookmarks into one row per folder path with counts', () => {
        const rows = buildRows(items())
        expect(rows).toHaveLength(6)
        expect(rows.find(r => r.sub_category === 'Web' && r.detail_category === 'Frameworks').count).toBe(2)
        expect(rows.find(r => r.category === 'Tech' && r.sub_category === 'General').count).toBe(1)
    })

    it('builds the nested tree with totals and directly-filed counts', () => {
        const tree = buildTree(items())
        expect(names(tree)).toEqual(['Tech', 'Travel'])
        expect(find(tree, 'Tech').count).toBe(6)
        expect(find(tree, 'Tech').direct).toBe(1)
        expect(find(tree, 'Tech', 'Web').count).toBe(3)
        expect(find(tree, 'Tech', 'Web').direct).toBe(0)
        expect(find(tree, 'Tech', 'Web', 'Frameworks').count).toBe(2)
        expect(find(tree, 'Tech', 'Web', 'Frameworks').path).toEqual(['Tech', 'Web', 'Frameworks'])
    })

    it('gives the same tree from rows as from bookmarks', () => {
        expect(buildTree(buildRows(items()))).toEqual(buildTree(items()))
    })
})

describe('detailStats', () => {
    it('counts third-level folders and the subfolders that hold them', () => {
        expect(detailStats(items())).toEqual({ detailFolders: 2, detailedSubcategories: 1 })
        expect(detailStats(applyOps(items(), [{ op: 'delete', path: ['Tech', 'Web', 'Tooling'] }]).records))
            .toEqual({ detailFolders: 1, detailedSubcategories: 1 })
        expect(detailStats([])).toEqual({ detailFolders: 0, detailedSubcategories: 0 })
    })
})

describe('rename', () => {
    it('relabels a category, a subfolder and a third-level folder', () => {
        const { records } = applyOps(items(), [
            { op: 'rename', path: ['Tech'], to: 'Technology' },
            { op: 'rename', path: ['Technology', 'Web'], to: 'Frontend' },
            { op: 'rename', path: ['Technology', 'Frontend', 'Frameworks'], to: 'Libraries' }
        ])
        const tree = buildTree(records)
        expect(names(tree)).toEqual(['Technology', 'Travel'])
        expect(find(tree, 'Technology', 'Frontend', 'Libraries').count).toBe(2)
    })

    it('refuses empty, reserved, duplicate, parent-echo and missing targets', () => {
        const run = (op) => applyOps(items(), [op]).error
        expect(run({ op: 'rename', path: ['Tech'], to: ' ' })).toMatch(/empty/i)
        expect(run({ op: 'rename', path: ['Tech', 'Web'], to: 'General' })).toMatch(/reserved/i)
        expect(run({ op: 'rename', path: ['Tech', 'Web'], to: 'Data' })).toMatch(/already exists/i)
        expect(run({ op: 'rename', path: ['Tech', 'Web'], to: 'Tech' })).toMatch(/like its category/i)
        expect(run({ op: 'rename', path: ['Tech', 'Web', 'Tooling'], to: 'Tech' })).toMatch(/like its category/i)
        expect(run({ op: 'rename', path: ['Nope'], to: 'X' })).toMatch(/no longer exists/i)
    })
})

describe('delete', () => {
    it('moves a subfolder\'s bookmarks up into its category', () => {
        const { records } = applyOps(items(), [{ op: 'delete', path: ['Tech', 'Web'] }])
        const tree = buildTree(records)
        expect(find(tree, 'Tech', 'Web')).toBeUndefined()
        expect(find(tree, 'Tech').direct).toBe(4)
    })

    it('moves a third-level folder\'s bookmarks up into its subfolder', () => {
        const { records } = applyOps(items(), [{ op: 'delete', path: ['Tech', 'Web', 'Frameworks'] }])
        const web = find(buildTree(records), 'Tech', 'Web')
        expect(web.direct).toBe(2)
        expect(names(web.children)).toEqual(['Tooling'])
    })

    it('refuses to delete a category', () => {
        expect(applyOps(items(), [{ op: 'delete', path: ['Tech'] }]).error).toMatch(/merging/i)
    })
})

describe('move', () => {
    it('moves a subfolder, with its third-level folders, to another category', () => {
        const { records } = applyOps(items(), [{ op: 'move', path: ['Tech', 'Web'], to: ['Travel'] }])
        const tree = buildTree(records)
        expect(find(tree, 'Travel', 'Web', 'Frameworks').count).toBe(2)
        expect(find(tree, 'Tech', 'Web')).toBeUndefined()
    })

    it('moves a third-level folder to another subfolder', () => {
        const { records } = applyOps(items(), [{ op: 'move', path: ['Tech', 'Web', 'Tooling'], to: ['Tech', 'Data'] }])
        expect(find(buildTree(records), 'Tech', 'Data', 'Tooling').count).toBe(1)
    })

    it('refuses categories, clashes, the same parent and missing destinations', () => {
        const run = (op) => applyOps(items(), [op]).error
        expect(run({ op: 'move', path: ['Tech'], to: [] })).toMatch(/cannot be moved/i)
        expect(run({ op: 'move', path: ['Tech', 'Data'], to: ['Tech'] })).toMatch(/already there/i)
        expect(run({ op: 'move', path: ['Tech', 'Web'], to: ['Nope'] })).toMatch(/no longer exists/i)
        const clash = [...items(), bm(10, 'Travel', 'Web')]
        expect(applyOps(clash, [{ op: 'move', path: ['Tech', 'Web'], to: ['Travel'] }]).error).toMatch(/already exists/i)
    })
})

describe('merge', () => {
    it('merges a subfolder into another in a different category, the target keeping its name', () => {
        const { records } = applyOps(items(), [{ op: 'merge', path: ['Travel', 'Hotels'], to: ['Tech', 'Data'] }])
        const tree = buildTree(records)
        expect(find(tree, 'Tech', 'Data').count).toBe(3)
        expect(find(tree, 'Travel', 'Hotels')).toBeUndefined()
    })

    it('merges a category: its folders join the target and matching names unify on the target spelling', () => {
        const data = [...items(), bm(11, 'Learning', 'web', 'frameworks'), bm(12, 'Learning', 'web', 'frameworks'), bm(13, 'Learning', 'Notes')]
        const { records } = applyOps(data, [{ op: 'merge', path: ['Learning'], to: ['Tech'] }])
        const tree = buildTree(records)
        expect(names(tree)).toEqual(['Tech', 'Travel'])
        expect(find(tree, 'Tech', 'Web', 'Frameworks').count).toBe(4)
        expect(find(tree, 'Tech', 'Notes').count).toBe(1)
    })

    it('merges third-level folders', () => {
        const { records } = applyOps(items(), [{ op: 'merge', path: ['Tech', 'Web', 'Tooling'], to: ['Tech', 'Web', 'Frameworks'] }])
        const web = find(buildTree(records), 'Tech', 'Web')
        expect(names(web.children)).toEqual(['Frameworks'])
        expect(web.children[0].count).toBe(3)
    })

    it('refuses a different level, itself and a missing folder', () => {
        const run = (op) => applyOps(items(), [op]).error
        expect(run({ op: 'merge', path: ['Tech', 'Web'], to: ['Travel'] })).toMatch(/same level/i)
        expect(run({ op: 'merge', path: ['Tech', 'Web'], to: ['Tech', 'Web'] })).toMatch(/different/i)
        expect(run({ op: 'merge', path: ['Tech', 'Web'], to: ['Tech', 'Nope'] })).toMatch(/no longer exists/i)
    })
})

describe('applyOps', () => {
    it('applies ops in order and applies none if any fails', () => {
        const ok = applyOps(items(), [
            { op: 'rename', path: ['Tech', 'Data'], to: 'Datasets' },
            { op: 'move', path: ['Tech', 'Datasets'], to: ['Travel'] }
        ])
        expect(find(buildTree(ok.records), 'Travel', 'Datasets').count).toBe(2)

        const bad = applyOps(items(), [
            { op: 'rename', path: ['Tech', 'Data'], to: 'Datasets' },
            { op: 'rename', path: ['Tech', 'Data'], to: 'Again' }
        ])
        expect(bad.error).toMatch(/no longer exists/i)
        expect(bad.records).toBeUndefined()
    })

    it('rejects unknown operations', () => {
        expect(applyOps(items(), [{ op: 'explode', path: ['Tech'] }]).error).toMatch(/unknown edit/i)
    })

    it('never mutates the input and keeps every other field', () => {
        const input = items()
        const frozen = JSON.parse(JSON.stringify(input))
        const { records } = applyOps(input, [{ op: 'rename', path: ['Travel'], to: 'Trips' }])
        expect(input).toEqual(frozen)
        expect(records.find(r => r.title === 'B7')).toMatchObject({ url: 'https://example.com/7', category: 'Trips' })
    })

    it('gives the same tree whether the ops run on bookmarks (worker) or on grouped rows (panel)', () => {
        const ops = [
            { op: 'rename', path: ['Tech', 'Web'], to: 'Frontend' },
            { op: 'move', path: ['Tech', 'Data'], to: ['Travel'] },
            { op: 'delete', path: ['Tech', 'Frontend', 'Tooling'] },
            { op: 'merge', path: ['Travel', 'Hotels'], to: ['Travel', 'Flights'] },
            { op: 'merge', path: ['Travel'], to: ['Tech'] }
        ]
        const fromItems = applyOps(items(), ops)
        const fromRows = applyOps(buildRows(items()), ops)
        expect(fromItems.error).toBeUndefined()
        expect(buildTree(fromRows.records)).toEqual(buildTree(fromItems.records))
    })
})
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/services/resultEditor.test.js`
Expected: FAIL (cannot find `./resultEditor`).

- [ ] **Step 3: Write the module**

Create `src/services/resultEditor.js`:

````js
// Pure editing model for the finished folder structure. It works on "records":
// bookmarks ({ category, sub_category, detail_category, ... }) in the worker, or
// grouped rows ({ category, sub_category, detail_category, count }) in the panel.
// Both run the same operations, so the panel's counts always match the worker's result.
// Functions never mutate their input.
import { canonicalKey, shouldCreateDetailFolder } from './subcategoryIdentity';
import { shouldCreateSubFolder } from './subcategoryPredicates';
import { checkName } from './planEditor';

const SINK = 'General';

const weight = (record) => (Number.isFinite(record.count) ? record.count : 1);
const startsWith = (path, prefix) => path.length >= prefix.length && prefix.every((name, i) => path[i] === name);

// [category], [category, sub] or [category, sub, detail]: the folders a record is written into.
export function recordPath(record) {
    const { category, sub_category: sub, detail_category: detail } = record;
    if (!shouldCreateSubFolder(category, sub)) return [category];
    if (!shouldCreateDetailFolder(category, sub, detail)) return [category, sub];
    return [category, sub, detail];
}

// One row per distinct folder path, with how many bookmarks it holds directly.
export function buildRows(items) {
    const rows = new Map();
    for (const item of items) {
        const path = recordPath(item);
        const key = JSON.stringify(path);
        if (!rows.has(key)) {
            rows.set(key, { category: path[0], sub_category: path[1] ?? SINK, detail_category: path[2] ?? null, count: 0 });
        }
        rows.get(key).count += weight(item);
    }
    return [...rows.values()];
}

// Nested folders sorted by name: { name, path, count (all inside), direct (filed straight into it), children }.
export function buildTree(records) {
    const top = new Map();
    for (const record of records) {
        const path = recordPath(record);
        let level = top;
        let node = null;
        path.forEach((name, depth) => {
            if (!level.has(name)) level.set(name, { name, path: path.slice(0, depth + 1), count: 0, direct: 0, children: new Map() });
            node = level.get(name);
            node.count += weight(record);
            level = node.children;
        });
        node.direct += weight(record);
    }
    const flatten = (map) => [...map.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(node => ({ ...node, children: flatten(node.children) }));
    return flatten(top);
}

// Third-level folder counts for the run summary, recomputed after the user's edits.
export function detailStats(records) {
    const folders = new Set();
    const parents = new Set();
    for (const record of records) {
        const path = recordPath(record);
        if (path.length !== 3) continue;
        folders.add(JSON.stringify(path));
        parents.add(JSON.stringify(path.slice(0, 2)));
    }
    return { detailFolders: folders.size, detailedSubcategories: parents.size };
}

const within = (records, path) => records.filter(record => startsWith(recordPath(record), path));

// Distinct folder names directly under `parentPath`, optionally leaving one out.
function siblingNames(records, parentPath, leaveOut = null) {
    const names = new Set();
    for (const record of records) {
        const path = recordPath(record);
        if (path.length > parentPath.length && startsWith(path, parentPath)) names.add(path[parentPath.length]);
    }
    if (leaveOut !== null) names.delete(leaveOut);
    return [...names];
}

const missing = (path) => ({ error: `The folder "${path.join(' / ')}" no longer exists.` });

function rename(records, { path, to }) {
    if (!Array.isArray(path) || path.length === 0 || within(records, path).length === 0) return missing(path || []);
    const depth = path.length;
    const name = path[depth - 1];
    const error = checkName(to, siblingNames(records, path.slice(0, -1), name), depth === 1 ? null : path[depth - 2]);
    if (error) return { error };
    if (depth === 3 && canonicalKey(to) === canonicalKey(path[0])) return { error: 'A folder cannot be named like its category.' };
    const trimmed = to.trim();
    return {
        records: records.map(record => {
            if (!startsWith(recordPath(record), path)) return record;
            if (depth === 1) return { ...record, category: trimmed };
            if (depth === 2) return { ...record, sub_category: trimmed };
            return { ...record, detail_category: trimmed };
        })
    };
}

function remove(records, { path }) {
    if (!Array.isArray(path) || path.length === 0 || within(records, path).length === 0) return missing(path || []);
    if (path.length === 1) return { error: 'Remove a category by merging it into another one.' };
    return {
        records: records.map(record => {
            if (!startsWith(recordPath(record), path)) return record;
            if (path.length === 2) return { ...record, sub_category: SINK, detail_category: null };
            return { ...record, detail_category: null };
        })
    };
}

function move(records, { path, to }) {
    if (!Array.isArray(path) || within(records, path).length === 0) return missing(path || []);
    if (path.length === 1) return { error: 'Categories cannot be moved.' };
    if (!Array.isArray(to) || to.length !== path.length - 1) return { error: 'Choose where to move the folder.' };
    if (within(records, to).length === 0) return missing(to);
    if (to.every((name, i) => name === path[i])) return { error: 'The folder is already there.' };
    const name = path[path.length - 1];
    if (siblingNames(records, to).some(sibling => canonicalKey(sibling) === canonicalKey(name))) {
        return { error: `"${name}" already exists there.` };
    }
    if (path.length === 3 && to.some(parent => canonicalKey(parent) === canonicalKey(name))) {
        return { error: 'A folder cannot be named like its parent.' };
    }
    return {
        records: records.map(record => {
            if (!startsWith(recordPath(record), path)) return record;
            return path.length === 2
                ? { ...record, category: to[0] }
                : { ...record, category: to[0], sub_category: to[1] };
        })
    };
}

// Spellings already present under the destination win when moved bookmarks join it.
function merge(records, { path, to }) {
    if (!Array.isArray(path) || within(records, path).length === 0) return missing(path || []);
    if (!Array.isArray(to) || to.length !== path.length) return { error: 'Choose a folder at the same level to merge into.' };
    if (within(records, to).length === 0) return missing(to);
    if (to.every((name, i) => name === path[i])) return { error: 'Choose a different folder to merge into.' };

    const subSpelling = new Map();
    const detailSpelling = new Map();
    for (const record of within(records, [to[0]])) {
        const existing = recordPath(record);
        if (path.length === 1 && existing.length >= 2) subSpelling.set(canonicalKey(existing[1]), existing[1]);
        if (path.length <= 2 && existing.length === 3 && (path.length === 1 || existing[1] === to[1])) {
            detailSpelling.set(`${canonicalKey(existing[1])}\u0000${canonicalKey(existing[2])}`, existing[2]);
        }
    }

    return {
        records: records.map(record => {
            const original = recordPath(record);
            if (!startsWith(original, path)) return record;
            const next = { ...record, category: to[0] };
            if (path.length >= 2) next.sub_category = to[1];
            if (path.length === 3) next.detail_category = to[2];
            if (path.length === 1 && original.length >= 2 && subSpelling.has(canonicalKey(original[1]))) {
                next.sub_category = subSpelling.get(canonicalKey(original[1]));
            }
            if (path.length <= 2 && original.length === 3) {
                const sub = path.length === 1 ? next.sub_category : to[1];
                const found = detailSpelling.get(`${canonicalKey(sub)}\u0000${canonicalKey(original[2])}`);
                if (found !== undefined) next.detail_category = found;
            }
            return next;
        })
    };
}

const OPERATIONS = { rename, delete: remove, move, merge };

// ops: [{ op: 'rename' | 'delete' | 'move' | 'merge', path: [...], to?: ... }]
// Returns { records } with every op applied in order, or { error } with none applied.
export function applyOps(records, ops) {
    let current = records.map(record => ({ ...record }));
    for (const op of Array.isArray(ops) ? ops : []) {
        const apply = OPERATIONS[op?.op];
        if (!apply) return { error: `Unknown edit "${op?.op}".` };
        const result = apply(current, op);
        if (result.error) return { error: result.error };
        current = result.records;
    }
    return { records: current };
}
````

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/services/resultEditor.test.js`
Expected: PASS (21 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/resultEditor.js src/services/resultEditor.test.js
git commit -m "feat: add the pure result editing model"
```

---

### Task 4: Binding plans in `reconcile`

**Files:**
- Modify: `src/services/reconcile.js` (inside `reconcileSubcategories`)
- Test: `src/services/reconcile.test.js` (append one `describe`)

**Interfaces:**
- Consumes: `schema.binding === true` on the schema passed to `reconcileSubcategories(classified, schema, options)`.
- Produces: with `binding`, every folder named in the schema that holds at least one bookmark survives (no dissolve, no cap). Folders the classifier invented are cleaned up exactly as before. Without `binding`, behaviour is unchanged.

- [ ] **Step 1: Write the failing tests**

Append this to the end of `src/services/reconcile.test.js` (it reuses the file's existing `items` and `subsIn` helpers):

````js

describe('reconcileSubcategories with a binding (reviewed) plan', () => {
    const plan = (extra = {}) => ({
        categories: [{ name: 'Tech', sub_categories: ['Web Development', 'Databases', 'Hardware'] }],
        ...extra
    })
    const build = () => [
        ...items('Tech', 'Web Development', 6),
        ...items('Tech', 'Databases', 6),
        ...items('Tech', 'Hardware', 1)
    ]

    it('dissolves a one-bookmark approved folder without the flag', () => {
        const result = reconcileSubcategories(build(), plan(), { subfolderTarget: 'medium' })

        expect(new Set(subsIn(result, 'Tech'))).not.toContain('Hardware')
    })

    it('keeps every approved folder that holds a bookmark when the plan is binding', () => {
        const result = reconcileSubcategories(build(), plan({ binding: true }), { subfolderTarget: 'medium' })

        expect(new Set(subsIn(result, 'Tech'))).toEqual(new Set(['Web Development', 'Databases', 'Hardware']))
    })

    it('still folds folders the classifier invented on its own', () => {
        const classified = [...build(), ...items('Tech', 'Gadgets', 1, { proposed: true })]

        const result = reconcileSubcategories(classified, plan({ binding: true }), { subfolderTarget: 'medium' })

        expect(new Set(subsIn(result, 'Tech'))).not.toContain('Gadgets')
        expect(new Set(subsIn(result, 'Tech'))).toContain('Hardware')
    })

    it('does not cap approved folders at the per-category ceiling', () => {
        const names = Array.from({ length: 12 }, (_, i) => `Topic ${String.fromCharCode(65 + i)}`)
        const wide = { categories: [{ name: 'Tech', sub_categories: names }], binding: true }
        const classified = names.flatMap(name => items('Tech', name, 3))

        const result = reconcileSubcategories(classified, wide, { subfolderTarget: 'compact' })

        expect(new Set(subsIn(result, 'Tech')).size).toBe(12)
    })
})
````

- [ ] **Step 2: Run them to verify the binding tests fail**

Run: `npx vitest run src/services/reconcile.test.js`
Expected: FAIL on "keeps every approved folder..." and "does not cap approved folders..." (the other two already pass: they pin today's behaviour).

- [ ] **Step 3: Implement binding**

In `src/services/reconcile.js`, inside `reconcileSubcategories`, make four edits.

(a) Replace:

````js
    const tier = subfolderTier(subfolderTarget);
    const minCount = tier.minCount;
````

with:

````js
    const tier = subfolderTier(subfolderTarget);
    const minCount = tier.minCount;
    // A reviewed plan is binding: its folders are never dissolved or capped.
    const binding = schema?.binding === true;
````

(b) Replace:

````js
                tokens: tokenize(name),
                isProposed: !approved.has(key)
            });
````

with:

````js
                tokens: tokenize(name),
                isProposed: !approved.has(key),
                isBound: binding && approved.has(key)
            });
````

(c) Replace:

````js
        let survivors = resolved.filter(g => g.count >= minCount);
        let orphans = resolved.filter(g => g.count < minCount);
````

with:

````js
        let survivors = resolved.filter(g => g.count >= minCount || g.isBound);
        let orphans = resolved.filter(g => g.count < minCount && !g.isBound);
````

(d) Replace:

````js
        survivors.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        const kept = survivors.slice(0, dynamicCap);
        const capped = survivors.slice(dynamicCap);
````

with:

````js
        survivors.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        // Bound folders always stay and use up part of the ceiling; the rest compete for what is left.
        const bound = survivors.filter(g => g.isBound);
        const free = survivors.filter(g => !g.isBound);
        const freeSlots = Math.max(0, dynamicCap - bound.length);
        const kept = [...bound, ...free.slice(0, freeSlots)].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        const capped = free.slice(freeSlots);
````

- [ ] **Step 4: Run the reconcile tests**

Run: `npx vitest run src/services/reconcile.test.js`
Expected: PASS (22 tests, including every pre-existing one).

- [ ] **Step 5: Commit**

```bash
git add src/services/reconcile.js src/services/reconcile.test.js
git commit -m "feat: keep every folder of a binding (reviewed) plan during reconcile"
```

---

### Task 5: The shared editor shell, tree view and plan editor

**Files:**
- Create: `src/components/EditorDialog.jsx`
- Create: `src/components/FolderTree.jsx`
- Create: `src/components/PlanEditor.jsx`
- Test: `src/components/PlanEditor.test.jsx`

**Interfaces:**
- Consumes: the Task 2 model.
- Produces:
  - `EditorDialog({ title, summary, dirty, saveLabel = 'Save', saveDisabled = false, error, onSave, onDiscard, children })`: `role="dialog"`, `aria-modal`, labelled by `title`; focus moves in, is trapped, and returns to the opener on unmount; Escape and **Discard** ask `window.confirm('Discard your changes?')` once when `dirty`; `error` renders in a polite `role="status"` region.
  - `FolderTree({ nodes, actionsFor, onRename, onAdd, onAddRoot, onDelete, onMove, onMerge, moveTargets, mergeTargets, deleteMessage, rootAddLabel, defaultExpanded })` where `nodes` is `[{ name, path: string[], count?, direct?, children }]`, `actionsFor(node)` returns any of `'rename' | 'add' | 'delete' | 'move' | 'merge'`, and `onRename` / `onAdd` / `onAddRoot` return an error string (shown on the row, editing stays open) or `null`.
  - `PlanEditor({ plan, onSave(plan), onDiscard })`.

- [ ] **Step 1: Write the failing test**

Create `src/components/PlanEditor.test.jsx`:

````jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import PlanEditor from './PlanEditor'

const plan = () => ({
    categories: [
        { name: 'Tech', sub_categories: ['Web', 'Data'] },
        { name: 'Travel', sub_categories: ['Flights'] }
    ]
})

const setup = () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    render(<PlanEditor plan={plan()} onSave={onSave} onDiscard={onDiscard} />)
    return { onSave, onDiscard }
}

const rename = (from, to) => {
    fireEvent.click(screen.getByRole('button', { name: `Rename ${from}` }))
    const input = screen.getByRole('textbox', { name: `New name for ${from}` })
    fireEvent.change(input, { target: { value: to } })
    fireEvent.keyDown(input, { key: 'Enter' })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('PlanEditor', () => {
    it('is a labelled modal dialog that shows the live counts', () => {
        setup()

        const dialog = screen.getByRole('dialog', { name: 'Edit folder plan' })
        expect(dialog.getAttribute('aria-modal')).toBe('true')
        expect(within(dialog).getByText('2 categories · 3 subfolders')).toBeDefined()
    })

    it('renames a subfolder and saves the edited plan', () => {
        const { onSave } = setup()

        rename('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(onSave).toHaveBeenCalledWith({
            categories: [
                { name: 'Tech', sub_categories: ['Frontend', 'Data'] },
                { name: 'Travel', sub_categories: ['Flights'] }
            ]
        })
    })

    it('shows an inline reason and keeps editing when a name is not allowed', () => {
        const { onSave } = setup()

        rename('Web', 'Data')

        expect(screen.getByRole('textbox', { name: 'New name for Web' })).toBeDefined()
        expect(screen.getAllByRole('alert')[0].textContent).toMatch(/already exists/i)
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(onSave.mock.calls[0][0].categories[0].sub_categories).toEqual(['Web', 'Data'])
    })

    it('adds a category and a subfolder under it', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: '+ Add category' }))
        const root = screen.getByRole('textbox', { name: /new category/i })
        fireEvent.change(root, { target: { value: 'Reading' } })
        fireEvent.keyDown(root, { key: 'Enter' })
        fireEvent.click(screen.getByRole('button', { name: 'Add subfolder to Reading' }))
        const sub = screen.getByRole('textbox', { name: 'Name for the new subfolder in Reading' })
        fireEvent.change(sub, { target: { value: 'Blogs' } })
        fireEvent.keyDown(sub, { key: 'Enter' })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(onSave.mock.calls[0][0].categories.at(-1)).toEqual({ name: 'Reading', sub_categories: ['Blogs'] })
    })

    it('asks before deleting a category that has subfolders, with the count', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Delete Tech' }))
        expect(screen.getByRole('alertdialog').textContent).toMatch(/Delete Tech and its 2 subfolders\?/)
        fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(onSave.mock.calls[0][0].categories.map(c => c.name)).toEqual(['Travel'])
    })

    it('deletes a subfolder without asking, and refuses to delete the last category', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Delete Web' }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete Travel' }))
        fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete Tech' }))
        fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

        expect(screen.getByRole('status').textContent).toMatch(/at least one category/i)
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(onSave.mock.calls[0][0]).toEqual({ categories: [{ name: 'Tech', sub_categories: ['Data'] }] })
    })

    it('moves a subfolder to another category', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Move Web' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'Move Web to' }), { target: { value: JSON.stringify(['Travel']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(onSave.mock.calls[0][0].categories).toEqual([
            { name: 'Tech', sub_categories: ['Data'] },
            { name: 'Travel', sub_categories: ['Flights', 'Web'] }
        ])
    })

    it('merges a subfolder into another folder and a category into another category', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Merge Web' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'Merge Web into' }), { target: { value: JSON.stringify(['Travel', 'Flights']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Merge Travel' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'Merge Travel into' }), { target: { value: JSON.stringify(['Tech']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(onSave.mock.calls[0][0]).toEqual({ categories: [{ name: 'Tech', sub_categories: ['Data', 'Flights'] }] })
    })

    it('discards without asking when nothing changed, and asks once when something did', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
        const { onDiscard } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
        expect(onDiscard).toHaveBeenCalledTimes(1)
        expect(confirm).not.toHaveBeenCalled()

        rename('Web', 'Frontend')
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(onDiscard).toHaveBeenCalledTimes(1)

        confirm.mockReturnValue(true)
        fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
        expect(onDiscard).toHaveBeenCalledTimes(2)
    })

    it('moves focus into the dialog and returns it to the opener on close', () => {
        const opener = document.createElement('button')
        document.body.appendChild(opener)
        opener.focus()

        const { unmount } = render(<PlanEditor plan={plan()} onSave={() => {}} onDiscard={() => {}} />)
        expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)

        unmount()
        expect(document.activeElement).toBe(opener)
        opener.remove()
    })

    it('keeps Tab inside the dialog', () => {
        setup()
        const dialog = screen.getByRole('dialog')
        const save = screen.getByRole('button', { name: 'Save' })
        save.focus()
        const buttons = dialog.querySelectorAll('button:not([disabled]), input, select')
        const last = buttons[buttons.length - 1]
        last.focus()

        fireEvent.keyDown(last, { key: 'Tab' })

        expect(dialog.contains(document.activeElement)).toBe(true)
    })
})
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/PlanEditor.test.jsx`
Expected: FAIL (cannot find `./PlanEditor`).

- [ ] **Step 3: Create the three components**

Create `src/components/EditorDialog.jsx`:

````jsx
import { useCallback, useEffect, useRef } from 'react'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

// Window-style sheet over the side panel: labelled dialog, trapped focus, focus returns to
// whatever opened it, and Escape / Discard ask once before throwing unsaved edits away.
export default function EditorDialog({ title, summary, dirty, saveLabel = 'Save', saveDisabled = false, error, onSave, onDiscard, children }) {
    const dialogRef = useRef(null)

    const requestDiscard = useCallback(() => {
        if (dirty && !window.confirm('Discard your changes?')) return
        onDiscard()
    }, [dirty, onDiscard])

    useEffect(() => {
        const opener = document.activeElement
        const first = dialogRef.current?.querySelector(FOCUSABLE)
        if (first) first.focus()
        return () => { if (opener && typeof opener.focus === 'function') opener.focus() }
    }, [])

    const onKeyDown = (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation()
            requestDiscard()
            return
        }
        if (event.key !== 'Tab') return
        const focusable = [...dialogRef.current.querySelectorAll(FOCUSABLE)]
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
        }
    }

    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'stretch', justifyContent: 'center' }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onKeyDown={onKeyDown}
                style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: '640px', margin: '0.5rem', background: 'var(--surface-solid)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}
            >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
                    <div>
                        <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{summary}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button type="button" onClick={requestDiscard} style={{ padding: '0.4rem 0.8rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--surface-solid)', color: 'var(--text-secondary)', cursor: 'pointer' }}>Discard</button>
                        <button type="button" className="btn-primary" onClick={onSave} disabled={saveDisabled} style={{ padding: '0.4rem 0.8rem' }}>{saveLabel}</button>
                    </div>
                </div>
                <div aria-live="polite" role="status" style={{ minHeight: error ? 'auto' : 0, padding: error ? '0.5rem 1rem' : 0, color: 'var(--error)', fontSize: '0.8rem' }}>{error}</div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1rem' }}>{children}</div>
            </div>
        </div>
    )
}
````

Create `src/components/FolderTree.jsx`:

````jsx
import { useState } from 'react'

const smallButton = { padding: '0.15rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface-solid)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.72rem' }

const keyOf = (path) => JSON.stringify(path)

// Shared folder tree for both editors. It owns only transient UI state (which row is being
// renamed, which menu is open, which rows are expanded); the editors own the data.
//
// nodes: [{ name, path, count?, direct?, children: [...] }]
// actionsFor(node): any of 'rename' | 'add' | 'delete' | 'move' | 'merge'
// onRename(node, name) / onAdd(node, name) / onAddRoot(name): return an error string, or null on success
// onDelete(node), onMove(node, targetPath), onMerge(node, targetPath)
// moveTargets(node) / mergeTargets(node): [{ path, label }]
// deleteMessage(node): confirm text, asked only for folders that have children
export default function FolderTree({
    nodes, actionsFor, onRename, onAdd, onAddRoot, onDelete, onMove, onMerge,
    moveTargets = () => [], mergeTargets = () => [], deleteMessage = (node) => `Delete ${node.name}?`,
    rootAddLabel = 'Add category', defaultExpanded = false
}) {
    const [expanded, setExpanded] = useState(() => new Set())
    const [editing, setEditing] = useState(null) // { key, mode: 'rename' | 'add' | 'root', value }
    const [menu, setMenu] = useState(null) // { key, kind: 'move' | 'merge' }
    const [confirming, setConfirming] = useState(null)
    const [rowError, setRowError] = useState({}) // key -> message

    const isOpen = (key) => (defaultExpanded ? !expanded.has(key) : expanded.has(key))
    const toggle = (key) => setExpanded(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    })
    const fail = (key, message) => setRowError(prev => ({ ...prev, [key]: message }))
    const clear = (key) => setRowError(prev => { const { [key]: _gone, ...rest } = prev; return rest })

    const commit = (node) => {
        const key = editing.key
        const outcome = editing.mode === 'rename' ? onRename(node, editing.value)
            : editing.mode === 'add' ? onAdd(node, editing.value)
                : onAddRoot(editing.value)
        if (outcome) { fail(key, outcome); return }
        clear(key)
        if (editing.mode === 'add') setExpanded(prev => { const next = new Set(prev); if (defaultExpanded) next.delete(key); else next.add(key); return next })
        setEditing(null)
    }

    const nameInput = (node, label) => (
        <input
            autoFocus
            aria-label={label}
            value={editing.value}
            onChange={(event) => setEditing({ ...editing, value: event.target.value })}
            onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); commit(node) }
                if (event.key === 'Escape') { event.stopPropagation(); clear(editing.key); setEditing(null) }
            }}
            style={{ padding: '0.2rem 0.4rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface-alt)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
        />
    )

    const renderNode = (node) => {
        const key = keyOf(node.path)
        const actions = actionsFor(node)
        const open = node.children.length > 0 && isOpen(key)
        const renaming = editing?.key === key && editing.mode === 'rename'
        const adding = editing?.key === key && editing.mode === 'add'
        return (
            <li key={key} style={{ listStyle: 'none', margin: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', padding: '0.2rem 0', paddingLeft: `${(node.path.length - 1) * 1.1}rem` }}>
                    {node.children.length > 0 ? (
                        <button type="button" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => toggle(key)} style={{ ...smallButton, border: 'none', background: 'transparent' }}>{open ? '▾' : '▸'}</button>
                    ) : <span style={{ width: '1.4rem' }} />}
                    {renaming ? nameInput(node, `New name for ${node.name}`) : <span style={{ color: 'var(--text-primary)', fontSize: '0.88rem', fontWeight: node.path.length === 1 ? 600 : 400 }}>{node.name}</span>}
                    {Number.isFinite(node.count) && <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{node.count.toLocaleString()}{node.direct > 0 && node.children.length > 0 ? ` (${node.direct.toLocaleString()} directly here)` : ''}</span>}
                    {actions.includes('rename') && !renaming && <button type="button" style={smallButton} aria-label={`Rename ${node.name}`} onClick={() => { clear(key); setEditing({ key, mode: 'rename', value: node.name }) }}>Rename</button>}
                    {actions.includes('add') && !adding && <button type="button" style={smallButton} aria-label={`Add subfolder to ${node.name}`} onClick={() => { clear(key); setEditing({ key, mode: 'add', value: '' }) }}>+ Subfolder</button>}
                    {actions.includes('move') && <button type="button" style={smallButton} aria-label={`Move ${node.name}`} onClick={() => setMenu({ key, kind: 'move' })}>Move to…</button>}
                    {actions.includes('merge') && <button type="button" style={smallButton} aria-label={`Merge ${node.name}`} onClick={() => setMenu({ key, kind: 'merge' })}>Merge into…</button>}
                    {actions.includes('delete') && <button type="button" style={smallButton} aria-label={`Delete ${node.name}`} onClick={() => (node.children.length > 0 ? setConfirming(key) : onDelete(node))}>Delete</button>}
                </div>
                {adding && <div style={{ paddingLeft: `${node.path.length * 1.1}rem`, padding: '0.2rem 0 0.2rem 1.5rem' }}>{nameInput(node, `Name for the new subfolder in ${node.name}`)}</div>}
                {menu?.key === key && (
                    <div style={{ paddingLeft: `${node.path.length * 1.1}rem`, padding: '0.2rem 0 0.2rem 1.5rem' }}>
                        <select
                            autoFocus
                            aria-label={`${menu.kind === 'move' ? 'Move' : 'Merge'} ${node.name} ${menu.kind === 'move' ? 'to' : 'into'}`}
                            defaultValue=""
                            onChange={(event) => {
                                const target = JSON.parse(event.target.value)
                                setMenu(null)
                                if (menu.kind === 'move') onMove(node, target)
                                else onMerge(node, target)
                            }}
                            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null) } }}
                        >
                            <option value="" disabled>{menu.kind === 'move' ? 'Move to…' : 'Merge into…'}</option>
                            {(menu.kind === 'move' ? moveTargets(node) : mergeTargets(node)).map(target => (
                                <option key={keyOf(target.path)} value={keyOf(target.path)}>{target.label}</option>
                            ))}
                        </select>
                    </div>
                )}
                {confirming === key && (
                    <div role="alertdialog" aria-label={`Confirm delete ${node.name}`} style={{ padding: '0.3rem 0 0.3rem 1.5rem', fontSize: '0.8rem', color: 'var(--error)' }}>
                        {deleteMessage(node)}{' '}
                        <button type="button" style={smallButton} onClick={() => { setConfirming(null); onDelete(node) }}>Delete</button>{' '}
                        <button type="button" style={smallButton} onClick={() => setConfirming(null)}>Keep</button>
                    </div>
                )}
                {rowError[key] && <div role="alert" style={{ paddingLeft: '1.5rem', color: 'var(--error)', fontSize: '0.78rem' }}>{rowError[key]}</div>}
                {open && <ul style={{ margin: 0, padding: 0 }}>{node.children.map(renderNode)}</ul>}
            </li>
        )
    }

    const rootKey = '"root"'
    return (
        <div>
            <ul style={{ margin: 0, padding: 0 }}>{nodes.map(renderNode)}</ul>
            {onAddRoot && (
                <div style={{ marginTop: '0.6rem' }}>
                    {editing?.key === rootKey ? nameInput(null, `Name for the new ${rootAddLabel.replace(/^Add /, '')}`) : (
                        <button type="button" style={smallButton} onClick={() => { clear(rootKey); setEditing({ key: rootKey, mode: 'root', value: '' }) }}>+ {rootAddLabel}</button>
                    )}
                    {rowError[rootKey] && <div role="alert" style={{ color: 'var(--error)', fontSize: '0.78rem' }}>{rowError[rootKey]}</div>}
                </div>
            )}
        </div>
    )
}
````

Create `src/components/PlanEditor.jsx`:

````jsx
import { useMemo, useState } from 'react'
import EditorDialog from './EditorDialog'
import FolderTree from './FolderTree'
import {
    addCategory, addSubfolder, mergeCategories, mergeSubfolders, moveSubfolder,
    removeCategory, removeSubfolder, renameCategory, renameSubfolder, summarize
} from '../services/planEditor'

const toNodes = (plan) => plan.categories.map(category => ({
    name: category.name,
    path: [category.name],
    children: category.sub_categories.map(sub => ({ name: sub, path: [category.name, sub], children: [] }))
}))

// Edit the AI's proposed plan ({ categories: [{ name, sub_categories }] }) before any bookmark is filed.
export default function PlanEditor({ plan, onSave, onDiscard }) {
    const [draft, setDraft] = useState(plan)
    const [error, setError] = useState('')
    const nodes = useMemo(() => toNodes(draft), [draft])
    const { categories, subfolders } = summarize(draft)

    // Applies an edit; returns the error text (shown on the row) or null.
    const apply = (result) => {
        if (result.error) { setError(result.error); return result.error }
        setError('')
        setDraft(result.plan)
        return null
    }

    return (
        <EditorDialog
            title="Edit folder plan"
            summary={`${categories} categor${categories === 1 ? 'y' : 'ies'} · ${subfolders} subfolder${subfolders === 1 ? '' : 's'}`}
            dirty={JSON.stringify(draft) !== JSON.stringify(plan)}
            saveDisabled={categories === 0}
            error={error}
            onSave={() => onSave(draft)}
            onDiscard={onDiscard}
        >
            <FolderTree
                nodes={nodes}
                defaultExpanded
                actionsFor={(node) => (node.path.length === 1 ? ['rename', 'add', 'delete', 'merge'] : ['rename', 'delete', 'move', 'merge'])}
                onRename={(node, name) => apply(node.path.length === 1
                    ? renameCategory(draft, node.path[0], name)
                    : renameSubfolder(draft, node.path[0], node.path[1], name))}
                onAdd={(node, name) => apply(addSubfolder(draft, node.path[0], name))}
                onAddRoot={(name) => apply(addCategory(draft, name))}
                onDelete={(node) => apply(node.path.length === 1
                    ? removeCategory(draft, node.path[0])
                    : removeSubfolder(draft, node.path[0], node.path[1]))}
                deleteMessage={(node) => `Delete ${node.name} and its ${node.children.length} subfolder${node.children.length === 1 ? '' : 's'}?`}
                moveTargets={(node) => draft.categories
                    .filter(category => category.name !== node.path[0])
                    .map(category => ({ path: [category.name], label: category.name }))}
                mergeTargets={(node) => (node.path.length === 1
                    ? draft.categories.filter(category => category.name !== node.path[0]).map(category => ({ path: [category.name], label: category.name }))
                    : draft.categories.flatMap(category => category.sub_categories
                        .filter(sub => !(category.name === node.path[0] && sub === node.path[1]))
                        .map(sub => ({ path: [category.name, sub], label: `${category.name} / ${sub}` }))))}
                onMove={(node, target) => apply(moveSubfolder(draft, node.path[0], node.path[1], target[0]))}
                onMerge={(node, target) => apply(node.path.length === 1
                    ? mergeCategories(draft, node.path[0], target[0])
                    : mergeSubfolders(draft, { category: node.path[0], name: node.path[1] }, { category: target[0], name: target[1] }))}
            />
        </EditorDialog>
    )
}
````

- [ ] **Step 4: Run it to verify it passes, then lint**

Run: `npx vitest run src/components/PlanEditor.test.jsx`
Expected: PASS (11 tests).
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorDialog.jsx src/components/FolderTree.jsx src/components/PlanEditor.jsx src/components/PlanEditor.test.jsx
git commit -m "feat: add the plan editor window"
```

---

### Task 6: The result editor window

**Files:**
- Create: `src/components/ResultEditor.jsx`
- Test: `src/components/ResultEditor.test.jsx`

**Interfaces:**
- Consumes: `EditorDialog`, `FolderTree` (Task 5); `applyOps`, `buildTree` (Task 3).
- Produces: `ResultEditor({ rows, initialOps = [], onSave(ops), onDiscard })`. It records each accepted edit as an operation, applies it to the grouped rows so counts update instantly, rejects a bad edit inline without recording it, starts collapsed, and offers rename/merge on categories and rename/delete/move/merge on subfolders and third-level folders (no delete on categories, no add anywhere).

- [ ] **Step 1: Write the failing test**

Create `src/components/ResultEditor.test.jsx`:

````jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import ResultEditor from './ResultEditor'

// Tech/Web/Frameworks x2, Tech/Web/Tooling x1, Tech/Data x2, Tech directly x1, Travel/Flights x2, Travel/Hotels x1
const rows = () => [
    { category: 'Tech', sub_category: 'Web', detail_category: 'Frameworks', count: 2 },
    { category: 'Tech', sub_category: 'Web', detail_category: 'Tooling', count: 1 },
    { category: 'Tech', sub_category: 'Data', detail_category: null, count: 2 },
    { category: 'Tech', sub_category: 'General', detail_category: null, count: 1 },
    { category: 'Travel', sub_category: 'Flights', detail_category: null, count: 2 },
    { category: 'Travel', sub_category: 'Hotels', detail_category: null, count: 1 }
]

const setup = (props = {}) => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    render(<ResultEditor rows={rows()} onSave={onSave} onDiscard={onDiscard} {...props} />)
    return { onSave, onDiscard }
}

const expand = (name) => fireEvent.click(screen.getByRole('button', { name: `Expand ${name}` }))

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ResultEditor', () => {
    it('starts collapsed, shows counts, and reveals levels two and three on demand', () => {
        setup()

        const dialog = screen.getByRole('dialog', { name: 'Edit organized folders' })
        expect(within(dialog).getByText('9 bookmarks · 2 categories · 0 edits')).toBeDefined()
        expect(screen.queryByText('Web')).toBeNull()
        expand('Tech')
        expect(screen.getByText('Web')).toBeDefined()
        expect(screen.queryByText('Frameworks')).toBeNull()
        expand('Web')
        expect(screen.getByText('Frameworks')).toBeDefined()
        expect(screen.getByText('(1 directly here)', { exact: false })).toBeDefined()
    })

    it('records a rename as an operation and updates the tree', () => {
        const { onSave } = setup()
        expand('Tech')

        fireEvent.click(screen.getByRole('button', { name: 'Rename Web' }))
        const input = screen.getByRole('textbox', { name: 'New name for Web' })
        fireEvent.change(input, { target: { value: 'Frontend' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(screen.getByText('Frontend')).toBeDefined()
        expect(screen.getByText(/1 edit$/)).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))
        expect(onSave).toHaveBeenCalledWith([{ op: 'rename', path: ['Tech', 'Web'], to: 'Frontend' }])
    })

    it('rejects a bad edit inline without recording it', () => {
        const { onSave } = setup()
        expand('Tech')

        fireEvent.click(screen.getByRole('button', { name: 'Rename Web' }))
        const input = screen.getByRole('textbox', { name: 'New name for Web' })
        fireEvent.change(input, { target: { value: 'Data' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(screen.getAllByRole('alert')[0].textContent).toMatch(/already exists/i)
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))
        expect(onSave).toHaveBeenCalledWith([])
    })

    it('does not offer delete on categories or add anywhere', () => {
        setup()

        expect(screen.queryByRole('button', { name: 'Delete Tech' })).toBeNull()
        expect(screen.queryByRole('button', { name: /^Add subfolder/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Add category/ })).toBeNull()
    })

    it('deletes a subfolder after confirming how many bookmarks move up', () => {
        const { onSave } = setup()
        expand('Tech')

        fireEvent.click(screen.getByRole('button', { name: 'Delete Web' }))
        expect(screen.getByRole('alertdialog').textContent).toMatch(/Delete Web\? Its 3 bookmarks move up one level\./)
        fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))

        expect(onSave).toHaveBeenCalledWith([{ op: 'delete', path: ['Tech', 'Web'] }])
    })

    it('moves a subfolder to another category and a third-level folder to another subfolder', () => {
        const { onSave } = setup()
        expand('Tech')
        expand('Web')

        fireEvent.click(screen.getByRole('button', { name: 'Move Data' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'Move Data to' }), { target: { value: JSON.stringify(['Travel']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Move Tooling' }))
        const options = within(screen.getByRole('combobox', { name: 'Move Tooling to' })).getAllByRole('option').map(o => o.textContent)
        expect(options).not.toContain('Tech / Web')
        expect(options).toContain('Travel / Flights')
        fireEvent.change(screen.getByRole('combobox', { name: 'Move Tooling to' }), { target: { value: JSON.stringify(['Travel', 'Flights']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))

        expect(onSave).toHaveBeenCalledWith([
            { op: 'move', path: ['Tech', 'Data'], to: ['Travel'] },
            { op: 'move', path: ['Tech', 'Web', 'Tooling'], to: ['Travel', 'Flights'] }
        ])
    })

    it('merges at the same level only', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Merge Travel' }))
        const options = within(screen.getByRole('combobox', { name: 'Merge Travel into' })).getAllByRole('option').map(o => o.textContent)
        expect(options).toEqual(['Merge into…', 'Tech'])
        fireEvent.change(screen.getByRole('combobox', { name: 'Merge Travel into' }), { target: { value: JSON.stringify(['Tech']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))

        expect(onSave).toHaveBeenCalledWith([{ op: 'merge', path: ['Travel'], to: ['Tech'] }])
    })

    it('restores previously saved edits', () => {
        setup({ initialOps: [{ op: 'rename', path: ['Travel'], to: 'Trips' }] })

        expect(screen.getByText('Trips')).toBeDefined()
        expect(screen.getByText(/1 edit$/)).toBeDefined()
    })

    it('asks before discarding edits', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
        const { onDiscard } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Rename Travel' }))
        const input = screen.getByRole('textbox', { name: 'New name for Travel' })
        fireEvent.change(input, { target: { value: 'Trips' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

        expect(confirm).toHaveBeenCalledTimes(1)
        expect(onDiscard).not.toHaveBeenCalled()
    })
})
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/ResultEditor.test.jsx`
Expected: FAIL (cannot find `./ResultEditor`).

- [ ] **Step 3: Create the component**

Create `src/components/ResultEditor.jsx`:

````jsx
import { useMemo, useState } from 'react'
import EditorDialog from './EditorDialog'
import FolderTree from './FolderTree'
import { applyOps, buildTree } from '../services/resultEditor'

const flatten = (nodes) => nodes.flatMap(node => [node, ...flatten(node.children)])

// Edit the finished structure. `rows` are the folder paths with bookmark counts from the worker
// (see buildRows); edits are recorded as an operation list the worker replays on the real bookmarks.
export default function ResultEditor({ rows, initialOps = [], onSave, onDiscard }) {
    const [ops, setOps] = useState(initialOps)
    const [error, setError] = useState('')
    const current = useMemo(() => applyOps(rows, ops).records || rows, [rows, ops])
    const nodes = useMemo(() => buildTree(current), [current])
    const all = useMemo(() => flatten(nodes), [nodes])
    const total = current.reduce((sum, row) => sum + row.count, 0)

    const record = (op) => {
        const result = applyOps(rows, [...ops, op])
        if (result.error) { setError(result.error); return result.error }
        setError('')
        setOps([...ops, op])
        return null
    }

    const sameLevel = (node) => all.filter(other => other.path.length === node.path.length && other.path.join('\u0000') !== node.path.join('\u0000'))

    return (
        <EditorDialog
            title="Edit organized folders"
            summary={`${total.toLocaleString()} bookmarks · ${nodes.length} categor${nodes.length === 1 ? 'y' : 'ies'} · ${ops.length} edit${ops.length === 1 ? '' : 's'}`}
            dirty={ops.length > 0 && JSON.stringify(ops) !== JSON.stringify(initialOps)}
            saveLabel="Save edits"
            error={error}
            onSave={() => onSave(ops)}
            onDiscard={onDiscard}
        >
            <FolderTree
                nodes={nodes}
                actionsFor={(node) => (node.path.length === 1 ? ['rename', 'merge'] : ['rename', 'delete', 'move', 'merge'])}
                onRename={(node, name) => record({ op: 'rename', path: node.path, to: name })}
                onDelete={(node) => record({ op: 'delete', path: node.path })}
                deleteMessage={(node) => `Delete ${node.name}? Its ${node.count.toLocaleString()} bookmarks move up one level.`}
                moveTargets={(node) => all
                    .filter(other => other.path.length === node.path.length - 1 && other.path.join('\u0000') !== node.path.slice(0, -1).join('\u0000'))
                    .map(other => ({ path: other.path, label: other.path.join(' / ') }))}
                mergeTargets={(node) => sameLevel(node).map(other => ({ path: other.path, label: other.path.join(' / ') }))}
                onMove={(node, target) => record({ op: 'move', path: node.path, to: target })}
                onMerge={(node, target) => record({ op: 'merge', path: node.path, to: target })}
            />
        </EditorDialog>
    )
}
````

- [ ] **Step 4: Run it to verify it passes, then lint**

Run: `npx vitest run src/components/ResultEditor.test.jsx`
Expected: PASS (9 tests).
Run: `npm run lint` (0 errors).

- [ ] **Step 5: Commit**

```bash
git add src/components/ResultEditor.jsx src/components/ResultEditor.test.jsx
git commit -m "feat: add the result editor window"
```

---

### Task 7: `ReviewPanel`: the review cards and saved edits

**Files:**
- Create: `src/components/ReviewPanel.jsx`
- Test: `src/components/ReviewPanel.test.jsx`

**Interfaces:**
- Consumes: `PlanEditor` (Task 5), `ResultEditor` (Task 6), `buildTree` (Task 3).
- Produces: `ReviewPanel({ plan, result, onDecide })`.
  - `plan`: `{ categories: [{ name, sub_categories }], error? } | null`; `result`: `{ rows: [{ category, sub_category, detail_category, count }], error? } | null`.
  - `onDecide(kind, decision, data?)` where `kind` is `'plan' | 'result'`, `decision` is `'approve' | 'regenerate'`, and `data` is `{ plan }` or `{ ops }` only when the user edited.
  - Edits are kept in component state and mirrored to `chrome.storage.session` under `reviewDraft` as `{ planEdit, resultEdit }`. An edit records the exact plan / rows it was made against (`base`) and is ignored for anything else, so regenerated plans and stale drafts never apply. The editors are `React.lazy` so they stay out of the startup chunk.

- [ ] **Step 1: Write the failing tests**

Create `src/components/ReviewPanel.test.jsx`:

````jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import ReviewPanel from './ReviewPanel'

const plan = (extra = {}) => ({
    categories: [
        { name: 'Tech', sub_categories: ['Web', 'Data'] },
        { name: 'Travel', sub_categories: ['Flights'] }
    ],
    ...extra
})

const rows = () => [
    { category: 'Tech', sub_category: 'Web', detail_category: 'Frameworks', count: 2 },
    { category: 'Tech', sub_category: 'Web', detail_category: 'Tooling', count: 1 },
    { category: 'Tech', sub_category: 'Data', detail_category: null, count: 2 },
    { category: 'Travel', sub_category: 'Flights', detail_category: null, count: 3 }
]

let session

beforeEach(() => {
    session = { data: {} }
    global.chrome = {
        storage: {
            session: {
                get: vi.fn((keys, cb) => cb({ ...session.data })),
                set: vi.fn((obj) => { Object.assign(session.data, obj) })
            }
        }
    }
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete global.chrome })

const renamePlanFolder = async (from, to) => {
    fireEvent.click(await screen.findByRole('button', { name: `Rename ${from}` }))
    const input = screen.getByRole('textbox', { name: `New name for ${from}` })
    fireEvent.change(input, { target: { value: to } })
    fireEvent.keyDown(input, { key: 'Enter' })
}

describe('ReviewPanel: plan review', () => {
    it('lists the proposed folders and approves them unchanged', () => {
        const onDecide = vi.fn()
        render(<ReviewPanel plan={plan()} result={null} onDecide={onDecide} />)

        const card = screen.getByRole('region', { name: 'Proposed folder plan' })
        expect(within(card).getByText('Tech')).toBeDefined()
        expect(within(card).getByText(/Web, Data/)).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: /Approve & organize/ }))

        expect(onDecide).toHaveBeenCalledWith('plan', 'approve', {})
    })

    it('edits the plan in the editor, shows it as edited, and approves with the edited plan', async () => {
        const onDecide = vi.fn()
        render(<ReviewPanel plan={plan()} result={null} onDecide={onDecide} />)

        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        await renamePlanFolder('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(screen.queryByRole('dialog')).toBeNull()
        const card = screen.getByRole('region', { name: 'Proposed folder plan' })
        expect(within(card).getByText('Edited')).toBeDefined()
        expect(within(card).getByText(/Frontend, Data/)).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: /Approve & organize/ }))

        expect(onDecide).toHaveBeenCalledWith('plan', 'approve', {
            plan: { categories: [{ name: 'Tech', sub_categories: ['Frontend', 'Data'] }, { name: 'Travel', sub_categories: ['Flights'] }] }
        })
    })

    it('treats a saved plan identical to the original as no edit', async () => {
        const onDecide = vi.fn()
        render(<ReviewPanel plan={plan()} result={null} onDecide={onDecide} />)

        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
        fireEvent.click(screen.getByRole('button', { name: /Approve & organize/ }))

        expect(onDecide).toHaveBeenCalledWith('plan', 'approve', {})
    })

    it('asks before a regenerate throws edits away, and not when there are none', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true)
        const onDecide = vi.fn()
        render(<ReviewPanel plan={plan()} result={null} onDecide={onDecide} />)

        fireEvent.click(screen.getByRole('button', { name: 'Regenerate plan' }))
        expect(confirm).not.toHaveBeenCalled()
        expect(onDecide).toHaveBeenCalledWith('plan', 'regenerate')

        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        await renamePlanFolder('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        onDecide.mockClear()

        fireEvent.click(screen.getByRole('button', { name: 'Regenerate plan' }))
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(onDecide).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate plan' }))
        expect(onDecide).toHaveBeenCalledWith('plan', 'regenerate')
    })

    it('shows the reason when the worker rejected the plan, keeping the edits', async () => {
        const { rerender } = render(<ReviewPanel plan={plan()} result={null} onDecide={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        await renamePlanFolder('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        rerender(<ReviewPanel plan={plan({ error: 'The plan needs at least one category.' })} result={null} onDecide={() => {}} />)

        expect(screen.getByRole('alert').textContent).toMatch(/at least one category/i)
        expect(screen.getByText('Edited')).toBeDefined()
    })

    it('drops edits that were made against a different plan', async () => {
        const { rerender } = render(<ReviewPanel plan={plan()} result={null} onDecide={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        await renamePlanFolder('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        rerender(<ReviewPanel plan={{ categories: [{ name: 'Reading', sub_categories: ['News'] }] }} result={null} onDecide={() => {}} />)

        expect(screen.queryByText('Edited')).toBeNull()
        expect(screen.getByText('Reading')).toBeDefined()
    })

    it('mirrors saved edits to session storage and restores them after a reopen', async () => {
        const first = render(<ReviewPanel plan={plan()} result={null} onDecide={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        await renamePlanFolder('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(global.chrome.storage.session.set).toHaveBeenCalledWith({ reviewDraft: expect.objectContaining({ planEdit: expect.objectContaining({ plan: expect.anything() }) }) })
        first.unmount()

        render(<ReviewPanel plan={plan()} result={null} onDecide={() => {}} />)

        expect(await screen.findByText('Edited')).toBeDefined()
        expect(screen.getByText(/Frontend, Data/)).toBeDefined()
    })
})

describe('ReviewPanel: result review', () => {
    it('summarises the organized folders and saves them unchanged', () => {
        const onDecide = vi.fn()
        render(<ReviewPanel plan={null} result={{ rows: rows() }} onDecide={onDecide} />)

        const card = screen.getByRole('region', { name: 'Organized folders ready for review' })
        expect(within(card).getByText(/5 bookmarks/)).toBeDefined()
        expect(within(card).getByText(/3 bookmarks/)).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: 'Save results' }))

        expect(onDecide).toHaveBeenCalledWith('result', 'approve', {})
    })

    it('edits the folders and saves the results with the recorded operations', async () => {
        const onDecide = vi.fn()
        render(<ReviewPanel plan={null} result={{ rows: rows() }} onDecide={onDecide} />)

        fireEvent.click(screen.getByRole('button', { name: 'Edit folders' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Rename Travel' }))
        const input = screen.getByRole('textbox', { name: 'New name for Travel' })
        fireEvent.change(input, { target: { value: 'Trips' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))

        expect(screen.queryByRole('dialog')).toBeNull()
        expect(screen.getByText('1 edit')).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: 'Save results' }))

        expect(onDecide).toHaveBeenCalledWith('result', 'approve', { ops: [{ op: 'rename', path: ['Travel'], to: 'Trips' }] })
    })

    it('shows the reason when the worker rejected the edits', () => {
        render(<ReviewPanel plan={null} result={{ rows: rows(), error: 'The folder "Tech / Web" no longer exists.' }} onDecide={() => {}} />)

        expect(screen.getByRole('alert').textContent).toMatch(/no longer exists/i)
    })
})
````

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/ReviewPanel.test.jsx`
Expected: FAIL (cannot find `./ReviewPanel`).

- [ ] **Step 3: Create `ReviewPanel`**

Create `src/components/ReviewPanel.jsx`:

````jsx
import { lazy, Suspense, useEffect, useState } from 'react'
import { buildTree } from '../services/resultEditor'

// The editors only load when a review is actually opened, keeping them out of the startup chunk.
const PlanEditor = lazy(() => import('./PlanEditor'))
const ResultEditor = lazy(() => import('./ResultEditor'))

const DRAFT_KEY = 'reviewDraft'
const secondary = { padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--surface-solid)', color: 'var(--text-secondary)', cursor: 'pointer' }
const chip = { fontSize: '0.68rem', padding: '0.1rem 0.45rem', borderRadius: '10px', background: 'var(--accent-soft)', color: 'var(--accent)', marginLeft: '0.5rem' }

// The two review pauses: the proposed folder plan (before any bookmark is filed) and the
// finished folders (before anything is written). The worker owns the run; this component
// owns only the user's unsaved-to-the-run edits, which it mirrors to session storage so a
// reopened panel can restore them.
//
// plan:   { categories: [{ name, sub_categories }], error? } | null
// result: { rows: [{ category, sub_category, detail_category, count }], error? } | null
// onDecide(kind: 'plan' | 'result', decision: 'approve' | 'regenerate', data?: { plan } | { ops })
export default function ReviewPanel({ plan, result, onDecide }) {
    const [planEdit, setPlanEdit] = useState(null) // { base, plan }
    const [resultEdit, setResultEdit] = useState(null) // { base, ops }
    const [editor, setEditor] = useState(null) // 'plan' | 'result' | null

    useEffect(() => {
        if (typeof chrome === 'undefined' || !chrome.storage?.session) return
        chrome.storage.session.get([DRAFT_KEY], (res) => {
            const draft = res?.[DRAFT_KEY]
            if (draft?.planEdit) setPlanEdit(prev => prev ?? draft.planEdit)
            if (draft?.resultEdit) setResultEdit(prev => prev ?? draft.resultEdit)
        })
    }, [])

    // An edit only applies to the exact plan or result it was made against, so a regenerated
    // plan (or a stale draft from an earlier run) can never be mistaken for the current one.
    const planBase = plan ? JSON.stringify(plan.categories) : null
    const resultBase = result ? JSON.stringify(result.rows) : null
    const activePlan = planEdit && planEdit.base === planBase ? planEdit.plan : null
    const activeOps = resultEdit && resultEdit.base === resultBase ? resultEdit.ops : []

    const persist = (next) => {
        try { chrome.storage?.session?.set({ [DRAFT_KEY]: next }) } catch { /* the edit still works in memory */ }
    }

    const savePlan = (edited) => {
        const next = JSON.stringify(edited.categories) === planBase ? null : { base: planBase, plan: edited }
        setPlanEdit(next)
        persist({ planEdit: next, resultEdit })
        setEditor(null)
    }

    const saveOps = (ops) => {
        const next = ops.length > 0 ? { base: resultBase, ops } : null
        setResultEdit(next)
        persist({ planEdit, resultEdit: next })
        setEditor(null)
    }

    const regenerate = () => {
        if (activePlan && !window.confirm('Regenerating throws away your edits to this plan. Continue?')) return
        onDecide('plan', 'regenerate')
    }

    const shownPlan = activePlan || (plan ? { categories: plan.categories } : null)
    const tree = result ? buildTree(result.rows) : []

    return (
        <>
            {plan && (
                <div className="card-panel plan-review" role="region" aria-label="Proposed folder plan" style={{ width: '100%', textAlign: 'left' }}>
                    <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Proposed folder plan{activePlan && <span style={chip}>Edited</span>}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.25rem 0 0.6rem' }}>
                        No bookmark has been filed yet. Edit the folders if you like, then approve to organize into them.
                    </div>
                    {plan.error && <div role="alert" style={{ color: 'var(--error)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{plan.error}</div>}
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '220px', overflowY: 'auto', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                        {shownPlan.categories.map((category) => (
                            <li key={category.name} style={{ padding: '0.15rem 0' }}>
                                <strong style={{ color: 'var(--text-primary)' }}>{category.name}</strong>
                                {category.sub_categories.length > 0 && <span> — {category.sub_categories.join(', ')}</span>}
                            </li>
                        ))}
                    </ul>
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                        <button type="button" className="btn-primary" onClick={() => onDecide('plan', 'approve', activePlan ? { plan: activePlan } : {})}>Approve &amp; organize</button>
                        <button type="button" style={secondary} onClick={() => setEditor('plan')}>Edit plan</button>
                        <button type="button" style={secondary} onClick={regenerate}>Regenerate plan</button>
                    </div>
                </div>
            )}

            {result && (
                <div className="card-panel result-review" role="region" aria-label="Organized folders ready for review" style={{ width: '100%', textAlign: 'left' }}>
                    <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Organized folders{activeOps.length > 0 && <span style={chip}>{activeOps.length} edit{activeOps.length === 1 ? '' : 's'}</span>}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.25rem 0 0.6rem' }}>
                        Every bookmark is sorted. Nothing has been saved yet: edit the folders if you like, then save the results.
                    </div>
                    {result.error && <div role="alert" style={{ color: 'var(--error)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{result.error}</div>}
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '220px', overflowY: 'auto', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                        {tree.map((category) => (
                            <li key={category.name} style={{ padding: '0.15rem 0' }}>
                                <strong style={{ color: 'var(--text-primary)' }}>{category.name}</strong>
                                <span> — {category.count.toLocaleString()} bookmark{category.count === 1 ? '' : 's'}</span>
                            </li>
                        ))}
                    </ul>
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                        <button type="button" className="btn-primary" onClick={() => onDecide('result', 'approve', activeOps.length > 0 ? { ops: activeOps } : {})}>Save results</button>
                        <button type="button" style={secondary} onClick={() => setEditor('result')}>Edit folders</button>
                    </div>
                </div>
            )}

            {editor === 'plan' && plan && (
                <Suspense fallback={null}>
                    <PlanEditor plan={shownPlan} onSave={savePlan} onDiscard={() => setEditor(null)} />
                </Suspense>
            )}
            {editor === 'result' && result && (
                <Suspense fallback={null}>
                    <ResultEditor rows={result.rows} initialOps={activeOps} onSave={saveOps} onDiscard={() => setEditor(null)} />
                </Suspense>
            )}
        </>
    )
}
````

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/components/ReviewPanel.test.jsx`
Expected: PASS (10 tests).

- [ ] **Step 5: Lint and commit**

Run: `npm run lint` (expect 0 errors).

```bash
git add src/components/ReviewPanel.jsx src/components/ReviewPanel.test.jsx
git commit -m "feat: add the review panel for the plan and result pauses"
```

---


---

## Stage 1: Plan review (the first pause)

### Task 8: `reviewPlan` gate: validate, bind, loop

**Files:**
- Modify: `src/services/organizer.js` (the import from `./ai`, and `reviewPlan`, around line 1494)
- Modify (full rewrite): `src/services/plan-review.test.js`

**Interfaces:**
- Consumes: `normalizeSchema` (Task 1); `schema.binding` is read by `reconcileSubcategories` (Task 4); `this.planReviewer(schema, error | null)` resolves `{ decision, plan? }`.
- Produces: `OrganizerService.prototype.reviewPlan(links, schema)` resolves to: the schema unchanged when there is no reviewer; `null` on cancel; otherwise `{ ...approvedSchema, binding: true }`, where `approvedSchema` is the normalized edited plan if the answer carried one, else the proposed schema. An edited plan that normalizes to zero categories is not accepted: the reviewer is asked again with the last good schema and the error text `The plan needs at least one category.`. `regenerate` calls `designSchema(links)` and asks again.

- [ ] **Step 1: Rewrite the test for the new contract**

Replace the whole contents of `src/services/plan-review.test.js` with:

````js
import { describe, expect, it, vi } from 'vitest'
import { OrganizerService } from './organizer'

// reviewPlan only touches these members, so exercise it on a minimal stand-in.
const harness = (answers, designs = []) => {
    const fake = {
        isCancelled: false,
        onProgress: vi.fn(),
        cancelled: vi.fn(() => null),
        designSchema: vi.fn(async () => designs.shift()),
        planReviewer: vi.fn(async () => answers.shift())
    }
    return { fake, review: (schema) => OrganizerService.prototype.reviewPlan.call(fake, ['link'], schema) }
}

const plan = (name) => ({ categories: [{ name, sub_categories: ['A'] }] })

describe('reviewPlan (phase 1 gate)', () => {
    it('passes the schema straight through when no reviewer is set', async () => {
        const { fake, review } = harness([])
        fake.planReviewer = null

        expect(await review(plan('Tech'))).toEqual(plan('Tech'))
    })

    it('returns the proposed schema, marked binding, once approved without designing again', async () => {
        const { fake, review } = harness([{ decision: 'approve' }])

        expect(await review(plan('Tech'))).toEqual({ ...plan('Tech'), binding: true })
        expect(fake.designSchema).not.toHaveBeenCalled()
        expect(fake.planReviewer).toHaveBeenCalledWith(plan('Tech'), null)
    })

    it('uses the normalized edited plan when the answer carries one', async () => {
        const edited = { categories: [{ name: ' Reading ', sub_categories: ['News', 'news', 'General'] }] }
        const { review } = harness([{ decision: 'approve', plan: edited }])

        expect(await review(plan('Tech'))).toEqual({ categories: [{ name: 'Reading', sub_categories: ['News'] }], binding: true })
    })

    it('asks again, with the reason, when the edited plan has no usable category', async () => {
        const { fake, review } = harness([
            { decision: 'approve', plan: { categories: [{ name: '   ', sub_categories: [] }] } },
            { decision: 'approve' }
        ])

        expect(await review(plan('Tech'))).toEqual({ ...plan('Tech'), binding: true })
        expect(fake.planReviewer).toHaveBeenNthCalledWith(2, plan('Tech'), expect.stringMatching(/at least one category/i))
    })

    it('designs a new plan on regenerate and asks about the new one', async () => {
        const { fake, review } = harness([{ decision: 'regenerate' }, { decision: 'approve' }], [plan('Reading')])

        expect(await review(plan('Tech'))).toEqual({ ...plan('Reading'), binding: true })
        expect(fake.designSchema).toHaveBeenCalledTimes(1)
        expect(fake.planReviewer).toHaveBeenNthCalledWith(2, plan('Reading'), null)
    })

    it('cancels the run when the user cancels', async () => {
        const { fake, review } = harness([{ decision: 'cancel' }])

        expect(await review(plan('Tech'))).toBeNull()
        expect(fake.cancelled).toHaveBeenCalled()
    })

    it('stops when the design pass is cancelled while regenerating', async () => {
        const { review } = harness([{ decision: 'regenerate' }], [null])

        expect(await review(plan('Tech'))).toBeNull()
    })
})
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/services/plan-review.test.js`
Expected: FAIL (the prototype `reviewPlan` expects a string decision and never sets `binding`).

- [ ] **Step 3: Implement**

In `src/services/organizer.js`, add `normalizeSchema` to the import from `./ai` (line 2). Change `generateSchema, generateInferredSchema, classifyBatch,` to `generateSchema, generateInferredSchema, normalizeSchema, classifyBatch,`.

Then replace the whole prototype `reviewPlan` method (the comment above it and the method) with:

````js
    // Phase 1 ends here: the user can approve the proposed folders (optionally edited),
    // ask for a new plan, or cancel before any bookmark is classified. An approved plan
    // is binding: reconcile keeps every folder in it.
    async reviewPlan(links, schema) {
        if (!this.planReviewer || !schema) return schema;
        let current = schema;
        let error = null;
        for (;;) {
            const answer = await this.planReviewer(current, error);
            error = null;
            if (this.isCancelled || answer?.decision === 'cancel') return this.cancelled();
            if (answer?.decision === 'regenerate') {
                this.onProgress({ status: 'processing', message: 'Regenerating the folder plan...', percent: 5 });
                current = await this.designSchema(links);
                if (!current) return current;
                continue;
            }
            let approved = current;
            if (answer?.plan) {
                approved = normalizeSchema(answer.plan);
                if (approved.categories.length === 0) {
                    error = 'The plan needs at least one category.';
                    continue;
                }
            }
            return { ...approved, binding: true };
        }
    }
````

- [ ] **Step 4: Run the services tests**

Run: `npx vitest run src/services`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/organizer.js src/services/plan-review.test.js
git commit -m "feat: validate edited plans in reviewPlan and mark approved plans binding"
```

---

### Task 9: Job runner and message routing for the plan gate

**Files:**
- Modify: `src/background/jobRunner.js`
- Modify: `src/background/index.js`
- Modify: `src/background/jobRunner.test.js` (replace the prototype `describe('plan review (two-phase)', ...)` block)
- Modify: `src/background/index.test.js` (add one test)

**Interfaces:**
- Consumes: the `planReviewer(schema, error | null)` contract from Task 8.
- Produces:
  - `startJob` accepts `config.reviewFolders` (replaces `reviewPlan`). When true and not in flat date mode, it installs `organizer.planReviewer`.
  - `jobRunner.awaitReview(kind, jobId, payload)` publishes `currentJob[kind] = payload` (`kind` is `'plan'` now, `'result'` in Stage 2), logs, flushes, and resolves with the panel's answer.
  - `jobRunner.resolveReview(kind, decision, data)` ignores unrecognised decisions, stale job ids and a `regenerate` for `'result'`; otherwise clears `currentJob[kind]` and resolves `{ decision, ...data }`.
  - `jobRunner.resolvePlan(decision, plan?)`.
  - Port message `PLAN_DECISION { decision, plan? }`.
  - `currentJob.plan` is `{ categories: [{ name, sub_categories }], error? }` while waiting, else `null`; it is part of `getState()` and of the session snapshot.
  - `startJob` removes the stale `reviewDraft` key from session storage.

- [ ] **Step 1: Replace the prototype tests**

In `src/background/jobRunner.test.js`, replace the entire `describe('plan review (two-phase)', () => { ... });` block (it starts at `describe('plan review (two-phase)'` and ends just before `it('cancels an active job cleanly'`) with:

````js
    describe('plan review (two-phase)', () => {
        const schema = { categories: [{ name: 'Tech', sub_categories: ['Web', 'Data'] }, { name: 'Travel', sub_categories: [] }] };
        // The real service pauses in start(); the stand-in does the same through planReviewer.
        const pausingOrganizer = (record) => function (apiKey, categories, onProgress) {
            this.onProgress = onProgress;
            this.cancel = vi.fn();
            this.isCancelled = false;
            this.stats = null;
            this.start = vi.fn(async () => {
                record.answer = this.planReviewer ? await this.planReviewer(schema, record.error ?? null) : { decision: 'no-reviewer' };
                return record.answer.decision === 'cancel' ? null : [{ title: 'A', url: 'https://example.com/a' }];
            });
        };

        it('publishes the proposed folders, keeps the job processing, and resumes with the edited plan', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);

            expect(runner.getState().status).toBe('processing');
            expect(runner.getState().plan).toEqual({ categories: schema.categories });

            const edited = { categories: [{ name: 'Technology', sub_categories: ['Web'] }] };
            runner.resolvePlan('approve', edited);
            await job;

            expect(record.answer).toEqual({ decision: 'approve', plan: edited });
            expect(runner.getState().plan).toBeNull();
            expect(runner.getState().status).toBe('complete');
        });

        it('approves without a plan when the user did not edit', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await job;

            expect(record.answer).toEqual({ decision: 'approve' });
        });

        it('hands the reason a previous answer was rejected to the panel', async () => {
            const record = { error: 'The plan needs at least one category.' };
            OrganizerService.mockImplementationOnce(pausingOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);

            expect(runner.getState().plan.error).toBe('The plan needs at least one category.');
            runner.resolvePlan('cancel');
            await job;
        });

        it('does not pause when review is off, nor in flat date mode', async () => {
            const off = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(off));
            await runner.startJob({ apiKey: 'k' }, null);
            expect(off.answer).toEqual({ decision: 'no-reviewer' });

            const flat = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(flat));
            await runner.startJob({ apiKey: 'k', reviewFolders: true, flatDateSort: true }, null);
            expect(flat.answer).toEqual({ decision: 'no-reviewer' });
        });

        it('ignores unrecognised decisions and decisions with nothing pending', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(record));
            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);

            runner.resolvePlan('bogus');
            expect(runner.getState().plan).not.toBeNull();

            runner.resolvePlan('approve');
            await job;
            expect(() => runner.resolvePlan('approve')).not.toThrow();
        });

        it('cancelling while the plan is waiting ends the job instead of hanging', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.cancelJob();
            await job;

            expect(record.answer.decision).toBe('cancel');
            expect(runner.getState().status).toBe('idle');
            expect(runner.getState().plan).toBeNull();
        });

        it('removes a stale saved-edits draft when a new job starts', async () => {
            await runner.startJob({ apiKey: 'k' }, null);

            expect(globalThis.chrome.storage.session.remove).toHaveBeenCalledWith(['reviewDraft']);
        });
    });

````

- [ ] **Step 2: Add the routing test**

In `src/background/index.test.js`, add this test right after the `acknowledges START_JOB...` test (before `GET_RESULTS returns completed results...`):

````js
    it('routes PLAN_DECISION to the job runner with the edited plan', async () => {
        vi.resetModules();
        let onConnectHandler = null;
        globalThis.chrome.runtime.onConnect.addListener = vi.fn((fn) => { onConnectHandler = fn; });

        await import('./index');
        const { jobRunner: freshRunner } = await import('./jobRunner');
        const port = {
            name: 'organizer-channel',
            postMessage: vi.fn(),
            onMessage: { addListener: vi.fn() },
            onDisconnect: { addListener: vi.fn() }
        };
        onConnectHandler(port);
        const handler = port.onMessage.addListener.mock.calls[0][0];
        const planSpy = vi.spyOn(freshRunner, 'resolvePlan').mockImplementation(() => {});

        handler({ type: 'PLAN_DECISION', payload: { decision: 'approve', plan: { categories: [] } } });
        handler({ type: 'PLAN_DECISION', payload: { decision: 'regenerate' } });

        expect(planSpy).toHaveBeenNthCalledWith(1, 'approve', { categories: [] });
        expect(planSpy).toHaveBeenNthCalledWith(2, 'regenerate', undefined);
    });

````

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/background`
Expected: FAIL (`reviewFolders` is ignored, `awaitReview` does not exist, `resolvePlan` ignores the plan).

- [ ] **Step 4: Implement in `jobRunner.js`**

Make these edits in `src/background/jobRunner.js`.

(a) Constructor: replace `this.pendingPlan = null;` with `this.pendingReview = null;`.

(b) `startJob` config destructuring: replace

````js
            autoImport = true,
            reviewPlan = false
        } = config;
````

with

````js
            autoImport = true,
            reviewFolders = false
        } = config;
````

(c) In `startJob`, right after the existing `chrome.storage.session.remove(['organizedData'])` block (the `if (typeof chrome !== 'undefined' && chrome.storage?.session) { try { chrome.storage.session.remove(['organizedData']); } catch {} }` just after `this.cachedResults = null;`), add:

````js
        // Edits saved for an earlier run's review must not leak into this one.
        if (typeof chrome !== 'undefined' && chrome.storage?.session) {
            try {
                chrome.storage.session.remove(['reviewDraft']);
            } catch {}
        }
````

(d) Replace

````js
        if (reviewPlan && !flatDateSort) {
            this.organizer.planReviewer = (schema) => this.awaitPlanDecision(jobId, schema);
        }
````

with

````js
        if (reviewFolders && !flatDateSort) {
            this.organizer.planReviewer = (schema, error) => this.awaitReview('plan', jobId, {
                categories: (schema.categories || []).map(c => ({ name: c.name, sub_categories: [...(c.sub_categories || [])] })),
                ...(error ? { error } : {})
            });
        }
````

(e) Replace the prototype `awaitPlanDecision` and `resolvePlan` methods (from the `// Phase 1 -> 2 gate:` comment through the end of `resolvePlan`) with:

````js
    // Review gates (plan, result): publish what to review on `currentJob[kind]` and wait for the
    // panel's decision. The job stays 'processing' while waiting, so every existing panel path
    // (restore, cancel, handshake) keeps working; a non-null `plan` / `result` marks the wait.
    awaitReview(kind, jobId, payload) {
        return new Promise((resolve) => {
            this.pendingReview = { kind, jobId, resolve };
            this.currentJob[kind] = payload;
            this.currentJob.backgroundNotice = '';
            this.addLog(kind === 'plan'
                ? 'Folder plan ready — review it, then approve to start organizing.'
                : 'Organized folders ready — review them, then save the results.');
            this.flushState();
        });
    }

    resolveReview(kind, decision, data = {}) {
        const pending = this.pendingReview;
        if (!['approve', 'regenerate', 'cancel'].includes(decision)) return;
        if (!pending || pending.kind !== kind || pending.jobId !== this.currentJob.id) return;
        if (kind === 'result' && decision === 'regenerate') return;
        this.pendingReview = null;
        this.currentJob[kind] = null;
        const label = kind === 'plan' ? 'Plan' : 'Result review';
        this.addLog(decision === 'regenerate'
            ? 'Plan rejected — generating a new one.'
            : decision === 'approve' ? `${label} approved.` : `${label} cancelled.`);
        this.flushState();
        pending.resolve({ decision, ...data });
    }

    resolvePlan(decision, plan) {
        this.resolveReview('plan', decision, plan ? { plan } : {});
    }
````

(f) In `cancelJob`, replace `if (this.pendingPlan) this.resolvePlan('cancel');` with `if (this.pendingReview) this.resolveReview(this.pendingReview.kind, 'cancel');`.

- [ ] **Step 5: Implement in `index.js`**

In `src/background/index.js`, replace

````js
                case 'PLAN_DECISION':
                    jobRunner.resolvePlan(msg.payload?.decision);
                    break;
````

with

````js
                case 'PLAN_DECISION':
                    jobRunner.resolvePlan(msg.payload?.decision, msg.payload?.plan);
                    break;
````

- [ ] **Step 6: Run the background tests**

Run: `npx vitest run src/background`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/background
git commit -m "feat: relay edited plans through the job runner review gate"
```

---

### Task 10: Wire the plan review into `Organizer`

**Files:**
- Modify: `src/components/Organizer.jsx`
- Test: `src/components/Organizer.test.jsx` (append one `describe`)

**Interfaces:**
- Consumes: `ReviewPanel` (Task 7); the worker contract from Task 9 (`STATUS_UPDATE.payload.plan`, `PLAN_DECISION`, session snapshot `activeJobState.plan`).
- Produces: setting `reviewFolders` (localStorage + `chrome.storage.local`), sent as `config.reviewFolders` in `START_JOB`; `decideReview(kind, decision, data)` relays an answer to the worker or to the in-panel resolver; the switch is labelled **Review folders before saving**; `ReviewPanel` renders in the processing view. (Result review is added in Task 14.)

- [ ] **Step 1: Write the failing `Organizer` tests**

Append this to the end of `src/components/Organizer.test.jsx`:

````jsx

describe('Review folders (two-phase)', () => {
    const connectedPanel = (sessionData = {}) => {
        const listeners = []
        const mockPort = {
            postMessage: vi.fn((msg) => {
                if (msg?.type === 'START_JOB') listeners.forEach((fn) => fn({ type: 'JOB_ACK', payload: {} }))
            }),
            onMessage: { addListener: vi.fn((fn) => listeners.push(fn)), removeListener: vi.fn() },
            onDisconnect: { addListener: vi.fn() },
            disconnect: vi.fn()
        }
        global.chrome = {
            runtime: { connect: vi.fn(() => mockPort) },
            storage: {
                local: { get: vi.fn((keys, cb) => cb({})), set: vi.fn(), remove: vi.fn() },
                session: { get: vi.fn((keys, cb) => cb(sessionData)), set: vi.fn() }
            }
        }
        return { listeners, mockPort }
    }
    const planState = (extra = {}) => ({
        id: 'job_1',
        status: 'processing',
        progress: 14,
        logs: [],
        plan: { categories: [{ name: 'Tech', sub_categories: ['Web', 'Data'] }, { name: 'Travel', sub_categories: ['Flights'] }] },
        ...extra
    })

    beforeEach(() => {
        localStorage.clear()
        vi.clearAllMocks()
    })

    afterEach(() => {
        cleanup()
        delete global.chrome
    })

    it('has a Review folders before saving switch that is off by default and remembers being turned on', () => {
        connectedPanel()
        render(<Organizer />)

        const toggle = screen.getByRole('switch', { name: 'Review folders before saving' })
        expect(toggle.getAttribute('aria-checked')).toBe('false')

        fireEvent.click(toggle)

        expect(toggle.getAttribute('aria-checked')).toBe('true')
        expect(localStorage.getItem('reviewFolders')).toBe('true')
    })

    it('sends the switch to the worker with START_JOB', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-port')
        localStorage.setItem('reviewFolders', 'true')
        const { mockPort } = connectedPanel()
        render(<Organizer />)

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))
        })

        expect(mockPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'START_JOB',
            payload: expect.objectContaining({ config: expect.objectContaining({ reviewFolders: true }) })
        }))
    })

    it('shows the proposed plan from the worker and relays the decision', async () => {
        const { listeners, mockPort } = connectedPanel()
        render(<Organizer />)

        act(() => { listeners.forEach((fn) => fn({ type: 'STATUS_UPDATE', payload: planState() })) })

        const card = await screen.findByRole('region', { name: 'Proposed folder plan' })
        expect(card.textContent).toMatch(/Web, Data/)
        expect(screen.getByText('Waiting for your approval')).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: /Approve & organize/ }))

        expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'PLAN_DECISION', payload: { decision: 'approve' } })
        expect(screen.queryByRole('region', { name: 'Proposed folder plan' })).toBeNull()
    })

    it('sends the edited plan with the decision', async () => {
        const { listeners, mockPort } = connectedPanel()
        render(<Organizer />)
        act(() => { listeners.forEach((fn) => fn({ type: 'STATUS_UPDATE', payload: planState() })) })

        fireEvent.click(await screen.findByRole('button', { name: 'Edit plan' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Rename Web' }))
        const input = screen.getByRole('textbox', { name: 'New name for Web' })
        fireEvent.change(input, { target: { value: 'Frontend' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        fireEvent.click(screen.getByRole('button', { name: /Approve & organize/ }))

        expect(mockPort.postMessage).toHaveBeenCalledWith({
            type: 'PLAN_DECISION',
            payload: {
                decision: 'approve',
                plan: { categories: [{ name: 'Tech', sub_categories: ['Frontend', 'Data'] }, { name: 'Travel', sub_categories: ['Flights'] }] }
            }
        })
    })

    it('restores the plan card from the session snapshot after the panel is reopened', async () => {
        connectedPanel({ activeJobState: planState() })
        render(<Organizer />)

        expect(await screen.findByRole('region', { name: 'Proposed folder plan' })).toBeDefined()
    })
})
````

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/Organizer.test.jsx -t "Review folders"`
Expected: FAIL (the switch is still called "Review plan before organizing"; no `ReviewPanel`).

- [ ] **Step 3: Wire `Organizer.jsx`**

Make these edits in `src/components/Organizer.jsx` (each is an exact find-and-replace).

(a) Add the import after `import { saveRun, loadRunData, deleteRun, clearHistory } from '../services/runHistory'`:

````jsx
import ReviewPanel from './ReviewPanel'
````

(b) State. Replace

````jsx
    // Two-phase prototype: pause after the AI proposes the folders so the user can approve them first.
    const [reviewPlan, setReviewPlan] = useState(() => getStored('reviewPlan', false))
    const [planForReview, setPlanForReview] = useState(null)
    const planResolverRef = useRef(null)
````

with

````jsx
    // Pause for review: the proposed folders before anything is filed, and the finished folders before they are saved.
    const [reviewFolders, setReviewFolders] = useState(() => getStored('reviewFolders', false))
    const [planForReview, setPlanForReview] = useState(null) // { categories, error? } while the worker waits for a plan decision
    const planResolverRef = useRef(null)
````

(c) Stored-settings read. In the `chrome.storage.local.get([...])` list replace `'dateSortOrder', 'reviewPlan', 'organizedMeta'` with `'dateSortOrder', 'reviewFolders', 'organizedMeta'`, and replace

````jsx
                if (typeof result.reviewPlan === 'boolean') {
                    setReviewPlan(result.reviewPlan)
                    try { localStorage.setItem('reviewPlan', JSON.stringify(result.reviewPlan)) } catch {}
                }
````

with

````jsx
                if (typeof result.reviewFolders === 'boolean') {
                    setReviewFolders(result.reviewFolders)
                    try { localStorage.setItem('reviewFolders', JSON.stringify(result.reviewFolders)) } catch {}
                }
````

(d) Toggle handler. Replace

````jsx
    const handleReviewPlanToggle = useCallback((enabled) => {
        setReviewPlan(enabled)
        updateSetting('reviewPlan', enabled)
    }, [updateSetting])
````

with

````jsx
    const handleReviewFoldersToggle = useCallback((enabled) => {
        setReviewFolders(enabled)
        updateSetting('reviewFolders', enabled)
    }, [updateSetting])
````

(e) Decision relay. Replace the whole `decidePlan` callback

````jsx
    const decidePlan = useCallback((decision) => {
        setPlanForReview(null)
        if (planResolverRef.current) {
            const resolve = planResolverRef.current
            planResolverRef.current = null
            resolve(decision)
        } else if (portRef.current) {
            try { portRef.current.postMessage({ type: 'PLAN_DECISION', payload: { decision } }) } catch {}
        }
    }, [])
````

with

````jsx
    // Answer a review pause. In-panel runs resolve the waiting promise directly; worker runs get a port message.
    const decideReview = useCallback((kind, decision, data = {}) => {
        const answer = { decision, ...data }
        if (kind === 'plan') setPlanForReview(null)
        const resolverRef = planResolverRef
        if (resolverRef.current) {
            const resolve = resolverRef.current
            resolverRef.current = null
            resolve(answer)
        } else if (portRef.current) {
            try { portRef.current.postMessage({ type: 'PLAN_DECISION', payload: answer }) } catch {}
        }
    }, [])
````

(f) Cancel. In `handleCancel` replace `if (planResolverRef.current) decidePlan('cancel')` with `if (planResolverRef.current) decideReview('plan', 'cancel')`, and replace its dependency list `[addLog, decidePlan]` with `[addLog, decideReview]`.

(g) Config. In the `START_JOB` payload replace

````jsx
                                    schemaSortOrder,
                                    reviewPlan
                                },
````

with

````jsx
                                    schemaSortOrder,
                                    reviewFolders
                                },
````

(h) In-panel gate. Replace

````jsx
            if (reviewPlan && !flatDateSort) {
                organizerRef.current.planReviewer = (schema) => new Promise((resolve) => {
                    planResolverRef.current = resolve
                    setPlanForReview({ categories: (schema.categories || []).map(c => ({ name: c.name, sub_categories: c.sub_categories || [] })) })
                    addLog('Folder plan ready — review it, then approve to start organizing.')
                })
            }
````

with

````jsx
            if (reviewFolders && !flatDateSort) {
                organizerRef.current.planReviewer = (schema, error) => new Promise((resolve) => {
                    planResolverRef.current = resolve
                    setPlanForReview({
                        categories: (schema.categories || []).map(c => ({ name: c.name, sub_categories: [...(c.sub_categories || [])] })),
                        ...(error ? { error } : {})
                    })
                    addLog('Folder plan ready — review it, then approve to start organizing.')
                })
            }
````

(i) The `startOrganization` callback's dependency list: replace `scheduleReturnToMenu, wirePort, reviewPlan]);` with `scheduleReturnToMenu, wirePort, reviewFolders]);`.

(j) Settings switch. Replace the block that starts with `{/* Review Plan Toggle (two-phase prototype) */}` and ends at its closing `)}` (the whole `{!flatDateSort && ( <div className="card-panel" ...> ... </div> )}`) with:

````jsx
                    {/* Review Folders Toggle */}
                    {!flatDateSort && (
                        <div className="card-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                            <div>
                                <label style={{ display: 'block', color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '500' }}>
                                    Review folders before saving
                                </label>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                                    Pause to approve or edit the proposed folders before any bookmark is filed, and again to edit the finished folders before they are saved
                                </div>
                            </div>
                            <button
                                role="switch"
                                aria-label="Review folders before saving"
                                aria-checked={reviewFolders}
                                onClick={() => handleReviewFoldersToggle(!reviewFolders)}
                                style={{ width: '44px', height: '24px', borderRadius: '12px', border: '1px solid var(--border)', background: reviewFolders ? 'var(--accent)' : 'var(--surface-solid)', position: 'relative', cursor: 'pointer', padding: 0, flexShrink: 0, transition: 'background 0.2s ease' }}
                            >
                                <span style={{ position: 'absolute', top: '2px', left: reviewFolders ? '22px' : '2px', width: '18px', height: '18px', borderRadius: '50%', background: reviewFolders ? 'var(--on-accent)' : 'var(--text-muted)', transition: 'left 0.2s ease' }} />
                            </button>
                        </div>
                    )}
````

(k) Plan card. Replace the whole `{planForReview && ( <div className="card-panel plan-review" ...> ... </div> )}` block (inside the processing view, just before the `Cancel` row) with:

````jsx
                        <ReviewPanel plan={planForReview} result={null} onDecide={decideReview} />
````

- [ ] **Step 4: Run the full suite and lint**

Run: `npx vitest run`
Expected: PASS (the five new `Organizer` tests included).
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/Organizer.jsx src/components/Organizer.test.jsx
git commit -m "feat: review and edit the proposed folder plan before organizing"
```

---

---

### Task 11: Real-browser check of the plan review

**Files:** none in the repo (a throwaway script outside it, `/tmp/pwdbg/plan-edit.js`).

- [ ] **Step 1: Build**

Run: `npm run build:all`
Expected: both builds succeed.

- [ ] **Step 2: Create the script** (Playwright-core and Chrome for Testing are already installed under `/tmp/pwdbg`; if not, `cd /tmp/pwdbg && npm install playwright-core && npx playwright-core install chromium`)

Create `/tmp/pwdbg/plan-edit.js`:

````js
// Real-Chrome check of the plan review (Stage 1). Usage: node plan-edit.js <absolute path to frontend/dist/chrome>
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(EXT, 'manifest.json'))) {
    console.error('usage: node plan-edit.js <absolute path to frontend/dist/chrome>');
    process.exit(2);
}

const PLAN = {
    Tech: ['Web', 'Data', 'Tools'], Finance: ['Trading', 'Banking', 'Crypto'],
    Travel: ['Flights', 'Hotels', 'Guides'], Reading: ['News', 'Blogs', 'Papers']
};

// Runs inside the service worker: answers every AI call locally and counts them.
// If __classifyPlan is set, classification files bookmarks into THAT plan (used after the user's edits);
// bookmark 0 goes to a folder named Recipes when the plan has one, so it holds exactly one bookmark.
const installMock = ({ PLAN }) => {
    const json = (content) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.__aiCalls = [];
    globalThis.__classifyPlan = null;
    globalThis.fetch = async (url, opts) => {
        if (!String(url).includes('openrouter.ai')) return realFetch(url, opts);
        const prompt = JSON.parse(opts.body).messages[1].content;
        if (prompt.includes('APPROVED SCHEMA')) {
            globalThis.__aiCalls.push('classify');
            const marker = 'BOOKMARKS (each with its index "i"):';
            const start = prompt.indexOf(marker) + marker.length;
            const batch = JSON.parse(prompt.slice(start, prompt.lastIndexOf(']') + 1).trim());
            const plan = globalThis.__classifyPlan || PLAN;
            const names = Object.keys(plan).filter(name => name !== 'Recipes');
            return json({ classified: batch.map((entry) => {
                const n = Number(/Bookmark (\d+)/.exec(entry.title || '')?.[1] ?? entry.i);
                if (n === 0 && plan.Recipes) return { i: entry.i, category: 'Recipes', sub_category: plan.Recipes[0] };
                const category = names[n % names.length];
                const subs = plan[category];
                return { i: entry.i, category, sub_category: subs.length ? subs[Math.floor(n / names.length) % subs.length] : 'General' };
            }) });
        }
        if (prompt.includes('APPROVED SUBFOLDERS BY CATEGORY')) { globalThis.__aiCalls.push('rehome'); return json({ classified: [] }); }
        if (prompt.includes('BOOKMARKS TO ANALYZE')) {
            globalThis.__aiCalls.push('schema');
            return json({ categories: Object.entries(PLAN).map(([name, sub_categories]) => ({ name, sub_categories })) });
        }
        if (prompt.includes('third-level bookmark folders')) { globalThis.__aiCalls.push('detail-schema'); return json({ groups: [] }); }
        globalThis.__aiCalls.push('other');
        return json({});
    };
};

const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' +
    Array.from({ length: 120 }, (_, i) => `<DT><A HREF="https://site${i}.example.com/page" ADD_DATE="${1700000000 + i * 1000}">Bookmark ${i}</A>`).join('\n') + '\n</DL><p>';

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };

(async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-'));
    const inputPath = path.join(userDataDir, 'input.html');
    fs.writeFileSync(inputPath, html);
    const ctx = await chromium.launchPersistentContext(userDataDir, {
        executablePath: chromium.executablePath(), headless: false, acceptDownloads: true,
        args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = new URL(sw.url()).host;
    const calls = () => sw.evaluate(() => globalThis.__aiCalls.slice());
    const count = async (kind) => (await calls()).filter(c => c === kind).length;
    const savedRun = () => sw.evaluate(async () => {
        const stored = await chrome.storage.local.get(['organizedData', 'organizedMeta', 'categories']);
        return { data: stored.organizedData || [], savedAt: stored.organizedMeta?.savedAt ?? null, categories: stored.categories };
    });

    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`chrome-extension://${id}/index.html`);
    await page.evaluate(async () => { localStorage.setItem('apiKey', 'sk-or-test-key'); await chrome.storage.local.set({ apiKey: 'sk-or-test-key' }); });
    await page.reload();
    await page.waitForSelector('input[type=file]', { state: 'attached' });

    const startRun = async () => {
        await sw.evaluate(installMock, { PLAN });
        await page.setInputFiles('input[type=file]', inputPath);
        await page.getByRole('button', { name: /Organize File & Download/ }).click();
    };
    const planCard = page.getByRole('region', { name: 'Proposed folder plan' });
    const rename = async (from, to) => {
        await page.getByRole('button', { name: `Rename ${from}`, exact: true }).click();
        const input = page.getByRole('textbox', { name: `New name for ${from}` });
        await input.fill(to);
        await input.press('Enter');
    };

    // 1. The switch is off by default, labelled as designed, and persists.
    const toggle = page.getByRole('switch', { name: 'Review folders before saving' });
    check('switch exists and is off by default', (await toggle.getAttribute('aria-checked')) === 'false');
    await toggle.click();
    check('switch persists as reviewFolders', (await page.evaluate(async () => (await chrome.storage.local.get('reviewFolders')).reviewFolders)) === true);

    // 2. Edit the plan: rename a category, add a category with a subfolder, then save.
    await startRun();
    await planCard.waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: 'Edit plan' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit folder plan' });
    await dialog.waitFor();
    await rename('Tech', 'Technology');
    await page.getByRole('button', { name: '+ Add category' }).click();
    const rootInput = page.getByRole('textbox', { name: /new category/i });
    await rootInput.fill('Recipes');
    await rootInput.press('Enter');
    await page.getByRole('button', { name: 'Add subfolder to Recipes' }).click();
    const subInput = page.getByRole('textbox', { name: 'Name for the new subfolder in Recipes' });
    await subInput.fill('Dinner');
    await subInput.press('Enter');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const cardText = await planCard.innerText();
    check('card shows the edited plan', /Edited/.test(cardText) && /Technology/.test(cardText) && /Recipes — Dinner/.test(cardText), JSON.stringify(cardText.split('\n').slice(0, 8)));
    check('nothing classified while the plan is under review', (await count('classify')) === 0);

    // 3. Reopen the panel mid-review: the saved edits come back.
    await page.reload();
    await planCard.waitFor({ timeout: 15000 });
    check('reopening the panel restores the edited plan', /Edited/.test(await planCard.innerText()) && /Technology/.test(await planCard.innerText()));

    // 4. A hand-sent invalid plan is rejected with a reason; the run keeps waiting.
    await page.evaluate(() => {
        const port = chrome.runtime.connect({ name: 'organizer-channel' });
        port.postMessage({ type: 'PLAN_DECISION', payload: { decision: 'approve', plan: { categories: [] } } });
    });
    await page.waitForFunction(() => /at least one category/i.test(document.querySelector('[aria-label="Proposed folder plan"]')?.innerText || ''), null, { timeout: 15000 });
    check('an invalid plan is rejected with a reason and the run keeps waiting', (await count('classify')) === 0);

    // 5. Approve the edited plan: classification files into it; the one-bookmark Recipes folder survives.
    const editedPlan = { Technology: PLAN.Tech, Finance: PLAN.Finance, Travel: PLAN.Travel, Reading: PLAN.Reading, Recipes: ['Dinner'] };
    await sw.evaluate((plan) => { globalThis.__classifyPlan = plan; }, editedPlan);
    await page.getByRole('button', { name: /Approve & organize/ }).click();
    // Once the result review exists (Stage 2) the run pauses a second time; save its results unchanged.
    const saveResults = page.getByRole('button', { name: 'Save results' });
    await Promise.race([
        page.waitForSelector('text=/Organization complete/i', { timeout: 60000 }),
        saveResults.waitFor({ timeout: 60000 })
    ]);
    if (await saveResults.isVisible().catch(() => false)) await saveResults.click();
    await page.waitForSelector('text=/Organization complete/i', { timeout: 60000 });
    await page.waitForTimeout(2000);
    const run = await savedRun();
    const names = [...new Set(run.data.map(b => b.category))].sort();
    check('saved run has exactly the edited categories', names.join() === 'Finance,Reading,Recipes,Technology,Travel', names.join());
    const recipes = run.data.filter(b => b.category === 'Recipes');
    check('the one-bookmark approved folder survived reconcile', recipes.length === 1 && recipes[0].sub_category === 'Dinner', JSON.stringify(recipes.map(b => b.sub_category)));
    check('the edits were never written to the categories setting', run.categories === undefined);

    // 6. Regenerate asks before throwing edits away.
    await page.reload();
    await page.waitForSelector('input[type=file]', { state: 'attached' });
    await startRun();
    await planCard.waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: 'Edit plan' }).click();
    await rename('Tech', 'Technology');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    page.once('dialog', dlg => dlg.dismiss());
    await page.getByRole('button', { name: 'Regenerate plan' }).click();
    await page.waitForTimeout(500);
    check('declining the confirm keeps the edits and the same plan', /Edited/.test(await planCard.innerText()) && (await count('schema')) === 1);
    page.once('dialog', dlg => dlg.accept());
    await page.getByRole('button', { name: 'Regenerate plan' }).click();
    await page.waitForFunction(() => !/Edited/.test(document.querySelector('[aria-label="Proposed folder plan"]')?.innerText || 'x'), null, { timeout: 30000 }).catch(() => {});
    check('accepting regenerates a fresh plan without the edits', (await count('schema')) === 2 && !/Edited/.test(await planCard.innerText()));

    // 7. Cancel at the plan: back to the menu, nothing classified, no new saved run.
    const before = await savedRun();
    await page.getByRole('button', { name: /^Cancel/ }).click();
    await page.waitForSelector('button:has-text("Organize File")', { timeout: 20000 });
    await page.waitForTimeout(1000);
    const after = await savedRun();
    check('cancel at the plan classifies nothing and saves no run', (await count('classify')) === 0 && after.savedAt === before.savedAt, `savedAt ${before.savedAt}->${after.savedAt}`);

    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('E2E FAILED', e); process.exit(1); });
````

- [ ] **Step 3: Run it**

Run: `cd /tmp/pwdbg && node plan-edit.js "<absolute path to frontend>/dist/chrome"`
Expected: every line prints `PASS` and the last line is `N/N checks passed`. If a selector no longer matches because the UI differs, fix the script, not the product, unless the product behaviour is wrong.

- [ ] **Step 4: Record and push**

Run: `git push` (from the worktree).
Expected: Stage 1 is shippable on its own: with the switch on, the run pauses at an editable, binding plan.

---


## Stage 2: Result review (the second pause)

### Task 12: `reviewResult` gate

**Files:**
- Modify: `src/services/organizer.js` (a new import, a new method, and one call in `runAI`)
- Test: `src/services/result-review.test.js` (new)

**Interfaces:**
- Consumes: `buildRows`, `applyOps`, `detailStats` (Task 3); `this.resultReviewer(rows, error | null)` resolves `{ decision: 'approve' | 'cancel', ops? }`.
- Produces: `OrganizerService.prototype.reviewResult(classified)` resolves to: the same array when there is no reviewer or the answer has no operations; `null` on cancel; otherwise the edited records (`applyOps` clones them, keeping every other field). If `applyOps` returns an error the reviewer is asked again with that error and the same rows. After edits, `this.stats.detailFoldersCount` and `this.stats.detailedSubcategories` are recomputed. `runAI` calls it right after `enrichDetails` and before `sortAndStrip`.

- [ ] **Step 1: Write the failing test**

Create `src/services/result-review.test.js`:

````js
import { describe, expect, it, vi } from 'vitest'
import { OrganizerService } from './organizer'
import { buildRows } from './resultEditor'

const bm = (n, category, sub_category, detail_category = null) => ({
    title: `B${n}`, url: `https://example.com/${n}`, category, sub_category, detail_category
})

const items = () => [
    bm(1, 'Tech', 'Web', 'Frameworks'), bm(2, 'Tech', 'Web', 'Frameworks'), bm(3, 'Tech', 'Web', 'Tooling'),
    bm(4, 'Tech', 'Data'), bm(5, 'Travel', 'Flights')
]

// reviewResult only touches these members, so exercise it on a minimal stand-in.
const harness = (answers) => {
    const fake = {
        isCancelled: false,
        onProgress: vi.fn(),
        cancelled: vi.fn(() => null),
        stats: { detailFoldersCount: 2, detailedSubcategories: 1 },
        resultReviewer: vi.fn(async () => answers.shift())
    }
    return { fake, review: (classified) => OrganizerService.prototype.reviewResult.call(fake, classified) }
}

describe('reviewResult (phase 2 gate)', () => {
    it('passes the records straight through when no reviewer is set', async () => {
        const { fake, review } = harness([])
        fake.resultReviewer = null
        const input = items()

        expect(await review(input)).toBe(input)
    })

    it('shows the grouped folder rows and returns the records untouched when saved without edits', async () => {
        const { fake, review } = harness([{ decision: 'approve' }])
        const input = items()

        expect(await review(input)).toBe(input)
        expect(fake.resultReviewer).toHaveBeenCalledWith(buildRows(input), null)
    })

    it('applies the edits to the real bookmarks and recomputes the third-level counts', async () => {
        const { fake, review } = harness([{ decision: 'approve', ops: [{ op: 'delete', path: ['Tech', 'Web', 'Tooling'] }] }])

        const out = await review(items())

        expect(out.find(b => b.title === 'B3')).toMatchObject({ url: 'https://example.com/3', category: 'Tech', sub_category: 'Web', detail_category: null })
        expect(fake.stats).toEqual({ detailFoldersCount: 1, detailedSubcategories: 1 })
    })

    it('asks again with the reason when an edit cannot be applied, then accepts a good answer', async () => {
        const { fake, review } = harness([
            { decision: 'approve', ops: [{ op: 'rename', path: ['Nope'], to: 'X' }] },
            { decision: 'approve', ops: [{ op: 'rename', path: ['Travel'], to: 'Trips' }] }
        ])
        const input = items()

        const out = await review(input)

        expect(fake.resultReviewer).toHaveBeenNthCalledWith(2, buildRows(input), expect.stringMatching(/no longer exists/i))
        expect(out.find(b => b.title === 'B5').category).toBe('Trips')
    })

    it('cancels the run when the user cancels', async () => {
        const { fake, review } = harness([{ decision: 'cancel' }])

        expect(await review(items())).toBeNull()
        expect(fake.cancelled).toHaveBeenCalled()
    })
})

describe('runAI with the result review', () => {
    const stub = (order, reviewResult) => ({
        isCancelled: false,
        categories: [],
        dateSpan: null,
        schemaSortOrder: 'alpha',
        designSchema: vi.fn(async () => { order.push('design'); return { categories: [{ name: 'Tech', sub_categories: ['Web'] }] } }),
        reviewPlan: vi.fn(async (links, schema) => { order.push('reviewPlan'); return schema }),
        classifyAll: vi.fn(async () => { order.push('classify'); return items() }),
        reconcileClassified: vi.fn((classified) => { order.push('reconcile'); return classified }),
        rehomeLoose: vi.fn(async (classified) => { order.push('rehome'); return classified }),
        enrichDetails: vi.fn(async (classified) => { order.push('enrich'); return classified }),
        reviewResult: vi.fn(reviewResult),
        sortAndStrip: vi.fn((classified) => { order.push('sort'); return classified }),
        writeFile: vi.fn(() => { order.push('write') }),
        finishAI: vi.fn((finalResults) => { order.push('finish'); return finalResults })
    })

    it('pauses for the result review after the third level is built and before sorting and writing', async () => {
        const order = []
        const fake = stub(order, async (classified) => { order.push('reviewResult'); return classified })

        await OrganizerService.prototype.runAI.call(fake, { links: [{}], duplicatesRemoved: 0, isBrowserMode: false })

        expect(order).toEqual(['design', 'reviewPlan', 'classify', 'reconcile', 'rehome', 'enrich', 'reviewResult', 'sort', 'write', 'finish'])
    })

    it('stops before sorting when the result review is cancelled', async () => {
        const order = []
        const fake = stub(order, async () => { order.push('reviewResult'); return null })

        const out = await OrganizerService.prototype.runAI.call(fake, { links: [{}], duplicatesRemoved: 0, isBrowserMode: false })

        expect(out).toBeNull()
        expect(order).not.toContain('sort')
        expect(order).not.toContain('write')
    })
})
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/services/result-review.test.js`
Expected: FAIL (`reviewResult` is not a function).

- [ ] **Step 3: Implement**

In `src/services/organizer.js`:

(a) After the line `import { reconcileSubcategories, groupEligibleDetailCandidates, reconcileDetailCategories, canonicalKey, isExemptCategory } from './reconcile';` add:

````js
import { buildRows, applyOps, detailStats } from './resultEditor';
````

(b) Right after the `reviewPlan` method (before `async runAI(`), add:

````js
    // Phase 2 ends here: every folder (all three levels) now exists, and the user can edit them,
    // with their bookmarks, before anything is sorted and written.
    async reviewResult(classified) {
        if (!this.resultReviewer) return classified;
        let error = null;
        for (;;) {
            const answer = await this.resultReviewer(buildRows(classified), error);
            error = null;
            if (this.isCancelled || answer?.decision === 'cancel') return this.cancelled();
            const ops = Array.isArray(answer?.ops) ? answer.ops : [];
            if (ops.length === 0) return classified;
            const applied = applyOps(classified, ops);
            if (applied.error) {
                error = applied.error;
                continue;
            }
            const { detailFolders, detailedSubcategories } = detailStats(applied.records);
            this.stats.detailFoldersCount = detailFolders;
            this.stats.detailedSubcategories = detailedSubcategories;
            this.onProgress({ status: 'info', message: `Applied ${ops.length} edit${ops.length === 1 ? '' : 's'} to the folder structure.` });
            return applied.records;
        }
    }

````

(c) In `runAI`, replace

````js
        classified = await this.enrichDetails(classified);
        if (!classified) return null;

        // Creation order determines display order in Chrome, so sorting the
````

with

````js
        classified = await this.enrichDetails(classified);
        if (!classified) return null;
        classified = await this.reviewResult(classified);
        if (!classified) return null;

        // Creation order determines display order in Chrome, so sorting the
````

- [ ] **Step 4: Run the services tests**

Run: `npx vitest run src/services`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/organizer.js src/services/result-review.test.js
git commit -m "feat: pause for a result review after the third level is built"
```

---

### Task 13: Job runner and message routing for the result gate

**Files:**
- Modify: `src/background/jobRunner.js`
- Modify: `src/background/index.js`
- Test: `src/background/jobRunner.test.js` (add one `describe`), `src/background/index.test.js` (add one test)

**Interfaces:**
- Consumes: `awaitReview` / `resolveReview` (Task 9); the `resultReviewer(rows, error | null)` contract (Task 12).
- Produces: with `config.reviewFolders` (and not in flat date mode) `startJob` installs `organizer.resultReviewer` as well; `currentJob.result` is `{ rows, error? }` while waiting, else `null`, and is part of `getState()` and of the session snapshot; `jobRunner.resolveResult(decision, ops?)`; port message `RESULT_DECISION { decision, ops? }`. A `regenerate` for the result is ignored (not offered).

- [ ] **Step 1: Write the failing tests**

In `src/background/jobRunner.test.js`, add this `describe` right after the closing of `describe('plan review (two-phase)', ...)`:

````js
    describe('result review (second pause)', () => {
        const rows = [
            { category: 'Tech', sub_category: 'Web', detail_category: 'Frameworks', count: 2 },
            { category: 'Travel', sub_category: 'Flights', detail_category: null, count: 3 }
        ];
        // Both gates are installed by the one flag; this stand-in pauses at each, like the real service.
        const twoGateOrganizer = (record) => function (apiKey, categories, onProgress) {
            this.onProgress = onProgress;
            this.cancel = vi.fn();
            this.isCancelled = false;
            this.stats = null;
            this.start = vi.fn(async () => {
                record.plan = this.planReviewer ? await this.planReviewer({ categories: [{ name: 'Tech', sub_categories: ['Web'] }] }, null) : null;
                record.result = this.resultReviewer ? await this.resultReviewer(rows, record.error ?? null) : { decision: 'no-reviewer' };
                return record.result.decision === 'cancel' ? null : [{ title: 'A', url: 'https://example.com/a' }];
            });
        };

        it('pauses for the plan, then for the result, with the folder rows published to the panel', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            expect(runner.getState().plan).not.toBeNull();
            expect(runner.getState().result).toBeNull();

            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);
            expect(runner.getState().plan).toBeNull();
            expect(runner.getState().result).toEqual({ rows });
            expect(runner.getState().status).toBe('processing');

            const ops = [{ op: 'rename', path: ['Travel'], to: 'Trips' }];
            runner.resolveResult('approve', ops);
            await job;

            expect(record.result).toEqual({ decision: 'approve', ops });
            expect(runner.getState().result).toBeNull();
            expect(runner.getState().status).toBe('complete');
        });

        it('approves without operations when nothing was edited', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);
            runner.resolveResult('approve');
            await job;

            expect(record.result).toEqual({ decision: 'approve' });
        });

        it('hands the reason a previous answer was rejected to the panel', async () => {
            const record = { error: 'The folder "Nope" no longer exists.' };
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);

            expect(runner.getState().result.error).toBe('The folder "Nope" no longer exists.');
            runner.resolveResult('cancel');
            await job;
        });

        it('ignores a regenerate for the result, a plan decision while the result waits, and bogus decisions', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));
            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);

            runner.resolveResult('regenerate');
            runner.resolvePlan('approve');
            runner.resolveResult('bogus');
            expect(runner.getState().result).not.toBeNull();

            runner.resolveResult('approve');
            await job;
        });

        it('cancelling while the result waits ends the job', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);
            runner.cancelJob();
            await job;

            expect(record.result.decision).toBe('cancel');
            expect(runner.getState().status).toBe('idle');
            expect(runner.getState().result).toBeNull();
        });

        it('includes the waiting result in the session snapshot when job state is persisted', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', inferCategories: false, categories: ['Tech'], reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);

            const snapshots = globalThis.chrome.storage.session.set.mock.calls.map(([data]) => data.activeJobState).filter(Boolean);
            expect(snapshots.at(-1).result).toEqual({ rows });

            runner.resolveResult('approve');
            await job;
        });
    });

````

In `src/background/index.test.js`, add this test right after `routes PLAN_DECISION to the job runner with the edited plan`:

````js
    it('routes RESULT_DECISION to the job runner with the recorded operations', async () => {
        vi.resetModules();
        let onConnectHandler = null;
        globalThis.chrome.runtime.onConnect.addListener = vi.fn((fn) => { onConnectHandler = fn; });

        await import('./index');
        const { jobRunner: freshRunner } = await import('./jobRunner');
        const port = {
            name: 'organizer-channel',
            postMessage: vi.fn(),
            onMessage: { addListener: vi.fn() },
            onDisconnect: { addListener: vi.fn() }
        };
        onConnectHandler(port);
        const handler = port.onMessage.addListener.mock.calls[0][0];
        const resultSpy = vi.spyOn(freshRunner, 'resolveResult').mockImplementation(() => {});

        const ops = [{ op: 'delete', path: ['Tech', 'Web'] }];
        handler({ type: 'RESULT_DECISION', payload: { decision: 'approve', ops } });
        handler({ type: 'RESULT_DECISION', payload: { decision: 'cancel' } });

        expect(resultSpy).toHaveBeenNthCalledWith(1, 'approve', ops);
        expect(resultSpy).toHaveBeenNthCalledWith(2, 'cancel', undefined);
    });

````

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/background`
Expected: FAIL (`resolveResult` does not exist; no `resultReviewer`; `state.result` is `undefined`).

- [ ] **Step 3: Implement in `jobRunner.js`**

(a) There are three job-state objects (the constructor's `this.currentJob`, the one built in `startJob`, and the one built in `resetJob`); each ends with

````js
            completedAt: null,
            plan: null
        };
````

Replace every one of them with

````js
            completedAt: null,
            plan: null,
            result: null
        };
````

(b) In `persistSessionSnapshot`, replace

````js
                        completedAt: this.currentJob.completedAt,
                        plan: this.currentJob.plan
                    }
````

with

````js
                        completedAt: this.currentJob.completedAt,
                        plan: this.currentJob.plan,
                        result: this.currentJob.result
                    }
````

(c) Replace the reviewer installation

````js
        if (reviewFolders && !flatDateSort) {
            this.organizer.planReviewer = (schema, error) => this.awaitReview('plan', jobId, {
                categories: (schema.categories || []).map(c => ({ name: c.name, sub_categories: [...(c.sub_categories || [])] })),
                ...(error ? { error } : {})
            });
        }
````

with

````js
        if (reviewFolders && !flatDateSort) {
            this.organizer.planReviewer = (schema, error) => this.awaitReview('plan', jobId, {
                categories: (schema.categories || []).map(c => ({ name: c.name, sub_categories: [...(c.sub_categories || [])] })),
                ...(error ? { error } : {})
            });
            this.organizer.resultReviewer = (rows, error) => this.awaitReview('result', jobId, {
                rows,
                ...(error ? { error } : {})
            });
        }
````

(d) After `resolvePlan`, add:

````js
    resolveResult(decision, ops) {
        this.resolveReview('result', decision, Array.isArray(ops) ? { ops } : {});
    }
````

- [ ] **Step 4: Implement in `index.js`**

In `src/background/index.js`, add this case right after the `PLAN_DECISION` case:

````js
                case 'RESULT_DECISION':
                    jobRunner.resolveResult(msg.payload?.decision, msg.payload?.ops);
                    break;
````

- [ ] **Step 5: Run the background tests**

Run: `npx vitest run src/background`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background
git commit -m "feat: relay result-review edits through the job runner"
```

---

### Task 14: Wire the result review into `Organizer`

**Files:**
- Modify: `src/components/Organizer.jsx`
- Test: `src/components/Organizer.test.jsx` (add tests inside the `describe('Review folders (two-phase)', ...)` block from Task 10)

**Interfaces:**
- Consumes: `ReviewPanel` (already renders the result card when given `result`); the worker contract from Task 13 (`STATUS_UPDATE.payload.result`, `RESULT_DECISION`, snapshot `activeJobState.result`); the in-panel `resultReviewer` contract from Task 12.
- Produces: `resultForReview` state, relayed by the same `decideReview(kind, ...)`; the in-panel fallback run pauses at the result review too.

- [ ] **Step 1: Write the failing tests**

Add these inside the `describe('Review folders (two-phase)', ...)` block in `src/components/Organizer.test.jsx`, after its last test (before the closing `})`):

````jsx

    const resultState = (extra = {}) => ({
        id: 'job_1',
        status: 'processing',
        progress: 80,
        logs: [],
        result: {
            rows: [
                { category: 'Tech', sub_category: 'Web', detail_category: 'Frameworks', count: 2 },
                { category: 'Tech', sub_category: 'Data', detail_category: null, count: 3 },
                { category: 'Travel', sub_category: 'Flights', detail_category: null, count: 4 }
            ]
        },
        ...extra
    })

    it('shows the finished folders from the worker and relays the decision', async () => {
        const { listeners, mockPort } = connectedPanel()
        render(<Organizer />)

        act(() => { listeners.forEach((fn) => fn({ type: 'STATUS_UPDATE', payload: resultState() })) })

        const card = await screen.findByRole('region', { name: 'Organized folders ready for review' })
        expect(card.textContent).toMatch(/Tech — 5 bookmarks/)
        expect(screen.getByText('Waiting for your approval')).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: 'Save results' }))

        expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'RESULT_DECISION', payload: { decision: 'approve' } })
        expect(screen.queryByRole('region', { name: 'Organized folders ready for review' })).toBeNull()
    })

    it('sends the recorded edits with the decision', async () => {
        const { listeners, mockPort } = connectedPanel()
        render(<Organizer />)
        act(() => { listeners.forEach((fn) => fn({ type: 'STATUS_UPDATE', payload: resultState() })) })

        fireEvent.click(await screen.findByRole('button', { name: 'Edit folders' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Rename Travel' }))
        const input = screen.getByRole('textbox', { name: 'New name for Travel' })
        fireEvent.change(input, { target: { value: 'Trips' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))
        fireEvent.click(screen.getByRole('button', { name: 'Save results' }))

        expect(mockPort.postMessage).toHaveBeenCalledWith({
            type: 'RESULT_DECISION',
            payload: { decision: 'approve', ops: [{ op: 'rename', path: ['Travel'], to: 'Trips' }] }
        })
    })

    it('restores the result card from the session snapshot after the panel is reopened', async () => {
        connectedPanel({ activeJobState: resultState() })
        render(<Organizer />)

        expect(await screen.findByRole('region', { name: 'Organized folders ready for review' })).toBeDefined()
    })

    it('shows the reason when the worker rejected the edits', async () => {
        const { listeners } = connectedPanel()
        render(<Organizer />)
        const state = resultState()

        act(() => { listeners.forEach((fn) => fn({ type: 'STATUS_UPDATE', payload: { ...state, result: { ...state.result, error: 'The folder "Nope" no longer exists.' } } })) })

        expect((await screen.findByRole('alert')).textContent).toMatch(/no longer exists/i)
    })
````

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/Organizer.test.jsx -t "Review folders"`
Expected: FAIL (no `resultForReview` state; `result={null}` is passed).

- [ ] **Step 3: Wire `Organizer.jsx`**

Make these edits in `src/components/Organizer.jsx` (each an exact find-and-replace).

(a) State. Replace

````jsx
    const [planForReview, setPlanForReview] = useState(null) // { categories, error? } while the worker waits for a plan decision
    const planResolverRef = useRef(null)
````

with

````jsx
    const [planForReview, setPlanForReview] = useState(null) // { categories, error? } while the worker waits for a plan decision
    const planResolverRef = useRef(null)
    const [resultForReview, setResultForReview] = useState(null) // { rows, error? } while the worker waits for a result decision
    const resultResolverRef = useRef(null)
````

(b) Worker status. Replace

````jsx
                setPlanForReview(state.status === 'processing' ? (state.plan || null) : null);
````

with

````jsx
                setPlanForReview(state.status === 'processing' ? (state.plan || null) : null);
                setResultForReview(state.status === 'processing' ? (state.result || null) : null);
````

(c) Session snapshot restore. Replace

````jsx
                            if (aj.plan) setPlanForReview(aj.plan);
````

with

````jsx
                            if (aj.plan) setPlanForReview(aj.plan);
                            if (aj.result) setResultForReview(aj.result);
````

(d) Decision relay. Replace the whole `decideReview` callback (the Task 10 version) with:

````jsx
    // Answer a review pause. In-panel runs resolve the waiting promise directly; worker runs get a port message.
    const decideReview = useCallback((kind, decision, data = {}) => {
        const answer = { decision, ...data }
        const resolverRef = kind === 'plan' ? planResolverRef : resultResolverRef
        if (kind === 'plan') setPlanForReview(null)
        else setResultForReview(null)
        if (resolverRef.current) {
            const resolve = resolverRef.current
            resolverRef.current = null
            resolve(answer)
        } else if (portRef.current) {
            try { portRef.current.postMessage({ type: kind === 'plan' ? 'PLAN_DECISION' : 'RESULT_DECISION', payload: answer }) } catch {}
        }
    }, [])
````

(e) Cancel. Replace

````jsx
        if (planResolverRef.current) decideReview('plan', 'cancel')
````

with

````jsx
        if (planResolverRef.current) decideReview('plan', 'cancel')
        if (resultResolverRef.current) decideReview('result', 'cancel')
````

(f) In-panel fallback gate. Replace

````jsx
                    addLog('Folder plan ready — review it, then approve to start organizing.')
                })
            }
````

with

````jsx
                    addLog('Folder plan ready — review it, then approve to start organizing.')
                })
                organizerRef.current.resultReviewer = (rows, error) => new Promise((resolve) => {
                    resultResolverRef.current = resolve
                    setResultForReview({ rows, ...(error ? { error } : {}) })
                    addLog('Organized folders ready — review them, then save the results.')
                })
            }
````

(g) Render. Replace

````jsx
                        <ReviewPanel plan={planForReview} result={null} onDecide={decideReview} />
````

with

````jsx
                        <ReviewPanel plan={planForReview} result={resultForReview} onDecide={decideReview} />
````

(h) Progress button. Replace

````jsx
                                {!planForReview && <Loader2 size={18} className="spin-icon" />}
                                <span>{planForReview ? 'Waiting for your approval' : `In Progress... ${Math.min(99, Math.max(0, progress))}%`}</span>
````

with

````jsx
                                {!(planForReview || resultForReview) && <Loader2 size={18} className="spin-icon" />}
                                <span>{(planForReview || resultForReview) ? 'Waiting for your approval' : `In Progress... ${Math.min(99, Math.max(0, progress))}%`}</span>
````

- [ ] **Step 4: Run the full suite and lint**

Run: `npx vitest run`
Expected: PASS.
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/Organizer.jsx src/components/Organizer.test.jsx
git commit -m "feat: review and edit the finished folders before they are saved"
```

---

### Task 15: Real-browser check, docs and wrap-up

**Files:**
- Modify: `../README.md` (one bullet)
- Create: `../.claude/memory/sessions/<today>-plan-and-result-editor.md` (handoff)
- No product code.

- [ ] **Step 1: Build and run the result-review check**

Run: `npm run build:all`
Expected: both builds succeed.

Create `/tmp/pwdbg/result-edit.js`:

````js
// Real-Chrome check of the result review (Stage 2). Usage: node result-edit.js <absolute path to frontend/dist/chrome>
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(EXT, 'manifest.json'))) {
    console.error('usage: node result-edit.js <absolute path to frontend/dist/chrome>');
    process.exit(2);
}

const PLAN = {
    Tech: ['Web', 'Data', 'Tools'], Finance: ['Trading', 'Banking', 'Crypto'],
    Travel: ['Flights', 'Hotels', 'Guides'], Reading: ['News', 'Blogs', 'Papers']
};

// 120 bookmarks: 30 per category, 10 per subfolder, and every subfolder gets two third-level folders of 5.
const installMock = ({ PLAN }) => {
    const json = (content) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.__aiCalls = [];
    globalThis.fetch = async (url, opts) => {
        if (!String(url).includes('openrouter.ai')) return realFetch(url, opts);
        const prompt = JSON.parse(opts.body).messages[1].content;
        if (prompt.includes('APPROVED SCHEMA')) {
            globalThis.__aiCalls.push('classify');
            const marker = 'BOOKMARKS (each with its index "i"):';
            const start = prompt.indexOf(marker) + marker.length;
            const batch = JSON.parse(prompt.slice(start, prompt.lastIndexOf(']') + 1).trim());
            const names = Object.keys(PLAN);
            return json({ classified: batch.map((entry) => {
                const n = Number(/Bookmark (\d+)/.exec(entry.title || '')?.[1] ?? entry.i);
                const category = names[n % names.length];
                return { i: entry.i, category, sub_category: PLAN[category][Math.floor(n / names.length) % PLAN[category].length] };
            }) });
        }
        if (prompt.includes('APPROVED SUBFOLDERS BY CATEGORY')) { globalThis.__aiCalls.push('rehome'); return json({ classified: [] }); }
        if (prompt.includes('BOOKMARKS TO ANALYZE')) {
            globalThis.__aiCalls.push('schema');
            return json({ categories: Object.entries(PLAN).map(([name, sub_categories]) => ({ name, sub_categories })) });
        }
        if (prompt.includes('third-level bookmark folders')) {
            globalThis.__aiCalls.push('detail-schema');
            const groups = [...prompt.matchAll(/"category":\s*"([^"]+)",\s*"sub_category":\s*"([^"]+)"/g)]
                .map(([, category, sub_category]) => ({ category, sub_category, detail_categories: ['Alpha Group', 'Beta Group'] }));
            return json({ groups });
        }
        if (prompt.includes('approved detail folder')) {
            globalThis.__aiCalls.push('detail');
            const names = JSON.parse(/APPROVED DETAIL NAMES: (\[.*?\])/.exec(prompt)[1]);
            const marker = 'BOOKMARKS (each with its index "i"):';
            const start = prompt.indexOf(marker) + marker.length;
            const batch = JSON.parse(prompt.slice(start, prompt.lastIndexOf(']') + 1).trim());
            return json({ classified: batch.map((entry) => ({ i: entry.i, detail_category: names[entry.i % names.length] })) });
        }
        globalThis.__aiCalls.push('other');
        return json({});
    };
};

const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' +
    Array.from({ length: 120 }, (_, i) => `<DT><A HREF="https://site${i}.example.com/page" ADD_DATE="${1700000000 + i * 1000}">Bookmark ${i}</A>`).join('\n') + '\n</DL><p>';

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };

(async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-'));
    const inputPath = path.join(userDataDir, 'input.html');
    fs.writeFileSync(inputPath, html);
    const ctx = await chromium.launchPersistentContext(userDataDir, {
        executablePath: chromium.executablePath(), headless: false, acceptDownloads: true,
        args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const id = new URL(sw.url()).host;
    const savedRun = () => sw.evaluate(async () => {
        const stored = await chrome.storage.local.get(['organizedData', 'organizedMeta']);
        return { data: stored.organizedData || [], savedAt: stored.organizedMeta?.savedAt ?? null };
    });

    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`chrome-extension://${id}/index.html`);
    await page.evaluate(async () => {
        localStorage.setItem('apiKey', 'sk-or-test-key');
        localStorage.setItem('reviewFolders', 'true');
        await chrome.storage.local.set({ apiKey: 'sk-or-test-key', reviewFolders: true });
    });
    await page.reload();
    await page.waitForSelector('input[type=file]', { state: 'attached' });

    const planCard = page.getByRole('region', { name: 'Proposed folder plan' });
    const resultCard = page.getByRole('region', { name: 'Organized folders ready for review' });
    const startRunToResultReview = async () => {
        await sw.evaluate(installMock, { PLAN });
        await page.setInputFiles('input[type=file]', inputPath);
        await page.getByRole('button', { name: /Organize File & Download/ }).click();
        await planCard.waitFor({ timeout: 60000 });
        await page.getByRole('button', { name: /Approve & organize/ }).click();
        await resultCard.waitFor({ timeout: 90000 });
    };
    const expand = (name) => page.getByRole('button', { name: `Expand ${name}`, exact: true }).click();
    const collapse = (name) => page.getByRole('button', { name: `Collapse ${name}`, exact: true }).click();
    const moveTo = async (name, optionLabel) => {
        await page.getByRole('button', { name: `Move ${name}`, exact: true }).click();
        const select = page.getByRole('combobox', { name: `Move ${name} to` });
        await select.selectOption({ label: optionLabel });
    };

    // 1. Plan approved unchanged; the second pause shows every folder with counts before anything is saved.
    const before = await savedRun();
    await startRunToResultReview();
    const summary = await resultCard.innerText();
    check('result review appears after the third level is built, with counts', /Tech — 30 bookmarks/.test(summary) && /Reading — 30 bookmarks/.test(summary), JSON.stringify(summary.split('\n').slice(0, 6)));
    check('nothing is saved while the result is under review', (await savedRun()).savedAt === before.savedAt);

    // 2. Edit levels 2 and 3: rename a third-level folder, delete one, move a subfolder, merge two third-level folders.
    await page.getByRole('button', { name: 'Edit folders' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit organized folders' });
    await dialog.waitFor();
    await expand('Tech');
    await expand('Web');
    check('third-level folders are listed', (await dialog.innerText()).includes('Alpha Group') && (await dialog.innerText()).includes('Beta Group'));

    await page.getByRole('button', { name: 'Rename Alpha Group', exact: true }).click();
    const renameInput = page.getByRole('textbox', { name: 'New name for Alpha Group' });
    await renameInput.fill('Frameworks');
    await renameInput.press('Enter');
    await collapse('Tech');                          // keep one folder open at a time so each button is unambiguous

    await expand('Finance');
    await expand('Banking');
    await page.getByRole('button', { name: 'Delete Beta Group', exact: true }).click();
    await collapse('Finance');

    await expand('Travel');
    await moveTo('Hotels', 'Reading');
    await collapse('Travel');

    await expand('Reading');
    await expand('News');
    await page.getByRole('button', { name: 'Merge Alpha Group', exact: true }).click();
    await page.getByRole('combobox', { name: 'Merge Alpha Group into' }).selectOption({ label: 'Reading / News / Beta Group' });
    await page.getByRole('button', { name: 'Save edits' }).click();
    check('the card counts the edits', /4 edits/.test(await resultCard.innerText()), await resultCard.innerText());

    // 3. Reopen the panel mid-review: the edits come back.
    await page.reload();
    await resultCard.waitFor({ timeout: 15000 });
    check('reopening the panel restores the edits', /4 edits/.test(await resultCard.innerText()));

    // 4. Hand-sent invalid operations are rejected with a reason; the run keeps waiting.
    await page.evaluate(() => {
        const port = chrome.runtime.connect({ name: 'organizer-channel' });
        port.postMessage({ type: 'RESULT_DECISION', payload: { decision: 'approve', ops: [{ op: 'rename', path: ['Nope'], to: 'X' }] } });
    });
    await page.waitForFunction(() => /no longer exists/i.test(document.querySelector('[aria-label="Organized folders ready for review"]')?.innerText || ''), null, { timeout: 15000 });
    check('invalid operations are rejected with a reason and nothing is saved', (await savedRun()).savedAt === before.savedAt);

    // 5. Save the results: the saved run matches the edited tree.
    await page.getByRole('button', { name: 'Save results' }).click();
    await page.waitForSelector('text=/Organization complete/i', { timeout: 60000 });
    await page.waitForTimeout(2000);
    const { data } = await savedRun();
    const where = (category, sub, detail) => data.filter(b => b.category === category && b.sub_category === sub && (b.detail_category ?? null) === detail).length;
    check('renamed third-level folder holds its 5 bookmarks', where('Tech', 'Web', 'Frameworks') === 5 && where('Tech', 'Web', 'Alpha Group') === 0, `Frameworks=${where('Tech', 'Web', 'Frameworks')}`);
    check('deleting a third-level folder moved its bookmarks up into the subfolder', where('Finance', 'Banking', null) === 5 && where('Finance', 'Banking', 'Alpha Group') === 5, `up=${where('Finance', 'Banking', null)}`);
    check('moved subfolder keeps its bookmarks under the new category', data.filter(b => b.category === 'Reading' && b.sub_category === 'Hotels').length === 10 && data.filter(b => b.category === 'Travel' && b.sub_category === 'Hotels').length === 0);
    check('merged third-level folders became one', where('Reading', 'News', 'Beta Group') === 10 && where('Reading', 'News', 'Alpha Group') === 0, `merged=${where('Reading', 'News', 'Beta Group')}`);
    check('every bookmark is still there, with its title and url', data.length === 120 && data.every(b => b.title && b.url));

    // 6. Cancel at the result review: nothing saved.
    await page.reload();
    await page.waitForSelector('input[type=file]', { state: 'attached' });
    const kept = await savedRun();
    await startRunToResultReview();
    await page.getByRole('button', { name: /^Cancel/ }).click();
    await page.waitForSelector('button:has-text("Organize File")', { timeout: 20000 });
    await page.waitForTimeout(1000);
    check('cancel at the result review saves nothing', (await savedRun()).savedAt === kept.savedAt);

    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('E2E FAILED', e); process.exit(1); });
````

Run: `cd /tmp/pwdbg && node result-edit.js "<absolute path to frontend>/dist/chrome"`
Expected: every line `PASS`, last line `N/N checks passed`. Also re-run `node plan-edit.js "<same path>"` (Task 11): the plan review must still pass with the result gate present. The script already clicks **Save results** when the second pause appears.

- [ ] **Step 2: README**

In `../README.md`, under "What it does", after the bullet `- Adjusts folder detail to your collection, with an optional third level for larger groups.`, add:

````md
- Optionally pauses to let you review and edit the proposed folders before anything is filed, and the finished folders (with bookmark counts) before they are saved: rename, add, delete, move and merge.
````

- [ ] **Step 3: Handoff note**

Create `../.claude/memory/sessions/<today as YYYY-MM-DD>-plan-and-result-editor.md` with these sections, filled with what actually happened: Files modified (with the line ranges of the significant changes in `organizer.js`, `jobRunner.js`, `Organizer.jsx`, `reconcile.js`, `ai.js`); Structural side effects (reviewer contracts now take `(value, error)` and resolve objects, `schema.binding`, `currentJob.plan` / `currentJob.result`, `PLAN_DECISION` / `RESULT_DECISION`, session key `reviewDraft`, setting `reviewFolders`); Decisions and rejected alternatives (see the spec); Exact verification commands with their real output (`npx vitest run`, `npm run lint`, `npm run build:all`, both `node` scripts); Open questions (real-model plan quality with binding on, very large result trees in the narrow panel).

- [ ] **Step 4: Final verification**

Run: `npx vitest run`, `npm run lint`, `npm run build:all`.
Expected: all green; lint 0 errors.

- [ ] **Step 5: Push and update the PR**

```bash
git add ../README.md ../.claude/memory/sessions
git commit -m "docs: document the review pauses and add the handoff note"
git push
```

Then update the description of draft PR #99 (`gh pr edit 99 --body ...`) to describe the finished feature: one switch; the plan review with the editor; the result review for levels 2 and 3; binding; the test counts and the two real-browser scripts' results. Mark the PR ready for review only when asked.

