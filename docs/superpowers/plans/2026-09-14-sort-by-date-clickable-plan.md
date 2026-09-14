# Plan: Sort-by-Date Clickable Controls (Flat Date Card)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** In the idle-state "Sort by Date Added (Flat List)" card, make the card title and the chronological-direction readout clickable. No behavior change to the existing toggle switch or the Newest/Oldest First segmented buttons.

**Branch:** `chore/sort-by-date-clickable` (base = origin/main `954997f`). Work happens in the worktree checked out at that branch. Related context: `fix/date-sort-direction-label` (unmerged, test-only) locks in the readout string "Newest bookmarks at the top" — this plan's test must include that same assertion so that branch stays redundant.

**Spec:** none (chore task, user-approved scope: "Both" — title toggles mode, readout flips direction). Rulings made without a spec are provisional.

## Global Constraints

- Exact strings preserved verbatim: `Newest bookmarks at the top` and `Oldest bookmarks at the top` — each must remain unique in the document (the unmerged test branch asserts `getByText('Newest bookmarks at the top')`).
- Existing controls keep behavior and accessible names: the switch keeps `role="switch"`, `aria-label="Sort by Date Added (Flat List)"`, `aria-checked={flatDateSort}`; the `Newest First` / `Oldest First` buttons keep calling `handleDateSortOrderChange('desc' | 'asc')`.
- The new title button must NOT duplicate the switch's accessible name — give it a distinct `aria-label` (e.g. `Toggle Sort by Date Added`).
- Tests: `cd frontend && npm test` — all green before commit. Lint: `cd frontend && npm run lint` — 0 errors.
- No new runtime dependencies. No code comments. Conventional Commits (`chore(ui): ...`).
- Follow the file's existing conventions: inline style objects, `var(--text-muted)`-style CSS variables, `useCallback` handlers.

## Interface contracts

- Reuse existing handlers only: `handleFlatDateSortToggle(enabled)` (Organizer.jsx:475) and `handleDateSortOrderChange(order)` (Organizer.jsx:479, persists to localStorage + chrome.storage). No new state, no service-layer changes (`flatDateSort`/`dateSortOrder` semantics untouched).

---

### Task 1: Clickable card title + direction readout

**Files:**
- Modify: `frontend/src/components/Organizer.jsx` — title label at :1033-1035 and direction readout span at :1094-1096 (inside the `flatDateSort &&` block that starts :1088)
- Test: `frontend/src/components/Organizer.test.jsx` — extend the flat-date-sort describe (existing test at :165-177; the unmerged branch adds its assertion inside it)

**Steps:**

- [ ] **Step 1: Write the failing tests** in `frontend/src/components/Organizer.test.jsx`:

  1. Clicking the card title ("Sort by Date Added (Flat List)" text) toggles the mode: `aria-checked` on `getByRole('switch')` goes false → true, and a second click returns it to false.
  2. With the mode enabled, clicking the direction readout flips its text exactly once between `Newest bookmarks at the top` and `Oldest bookmarks at the top` per click.
  3. Include the unmerged branch's assertion: after enabling the mode, `screen.getByText('Newest bookmarks at the top')` is defined (default order desc).

- [ ] **Step 2: Run tests to verify they fail** — `cd frontend && npx vitest run src/components/Organizer.test.jsx`

- [ ] **Step 3: Implement** in `Organizer.jsx`:
  - Title (:1033-1035): becomes a real `<button type="button">` with `onClick={() => handleFlatDateSortToggle(!flatDateSort)}`, distinct `aria-label="Toggle Sort by Date Added"`, pointer cursor, unstyled/transparent background consistent with the card's look.
  - Direction readout (:1094-1096): becomes a `<button type="button">` with `onClick={() => handleDateSortOrderChange(dateSortOrder === 'desc' ? 'asc' : 'desc')}`, `title="Click to reverse direction"`, pointer cursor + subtle affordance (e.g. underline on the dynamic text), keeping the exact dynamic strings.

- [ ] **Step 4: Full verification** — `cd frontend && npm test` (all green) and `cd frontend && npm run lint` (0 errors). Commit: `chore(ui): make flat date sort title and direction readout clickable`.
