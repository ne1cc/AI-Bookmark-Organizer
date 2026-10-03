# 2026-10-02 — Keep the last 3 organized runs on disk + always offer Save As

Two requirements from the user: (1) every run must be stored so it can be downloaded, up to 3;
(2) every download must give a Save As dialog.

## Findings that drove the design
- Default runs (AI-inferred categories) never saved their result: `persistJobState = flatDateSort || !inferCategories`
  in `jobRunner.js` and `shouldPersistRun` in `Organizer.jsx` skipped storage. Only the uploaded input file was cached.
  That gate was added deliberately in `eae7bbc` (tests pinned "no generated names in Chrome storage"). The user
  explicitly reversed it; those tests were rewritten.
- Downloads were not failing: the user's Chromium saved files straight to ~/Downloads (`name (n).html`) and ignored
  `saveAs: true`, so there was no dialog and no feedback. Verified from `chrome://downloads` and the Downloads folder.
- A headless Playwright harness cannot show the real Save As dialog (it intercepts downloads), so it hid this.

## What changed
- `services/runHistory.js` (new): `saveRun`, `loadLatestRun`, `loadHistory`, `loadRunData`, pure `rotateRuns`. Layout in
  `chrome.storage.local`: `organizedMeta`/`organizedData` = latest; `organizedHistory` = metadata of up to 2 older runs;
  `organizedRun:<id>` = data of one older run. Session mirror of the latest data is best-effort. Previous latest only
  rotates into history if it has stored data. MAX_RUNS = 3 in total.
- `background/jobRunner.js`: every completed run goes through `saveRun` (meta gains `mode: 'file' | 'browser'`) and is
  awaited before the worker may idle. `resetJob` no longer deletes saved runs ("Organize another" / removing the
  uploaded file call it; wiping history there would defeat the feature).
- `background/index.js`: `GET_RESULTS` falls back to the saved latest run after a worker restart; "unavailable" only when
  nothing is saved.
- `services/bookmarks_export.js`: `saveHtmlFile` opens `showSaveFilePicker` (synchronously from the click), falls back to
  `chrome.downloads` with `saveAs: true`, then an anchor. `downloadBookmarks` now returns a promise of
  `{status: 'saved' | 'started' | 'cancelled'}`. `services/input_bookmarks.js` uses it too (dynamic import keeps the
  exporter out of the startup chunk).
- `components/Organizer.jsx`: in-panel runs saved via `saveRun`; startup cleanup no longer deletes `organizedData`;
  "Previous runs (N)" list (next to the banner, not inside it) with a Download per run; live updates via
  `chrome.storage.onChanged`; log line after each save ("Saved <name>." / "Download started…").

## Decisions / alternatives rejected
- Older runs on disk (`storage.local`, `unlimitedStorage` already in the manifest) rather than session memory, because
  the requirement is "available to download, every single run". Startup reads only the small keys, never the data.
- Rotate rather than duplicate: the existing latest-run keys and every reader of them are unchanged.
- Automatic download at the end of a file-mode run runs in the service worker with no click, so it cannot open the picker;
  it keeps `chrome.downloads` + `saveAs: true`. The Download buttons are the reliable path.
- Separate branch/PR from the sorting change (#94); both build on `main` independently.

## Verification
- `npx vitest run` → 21 files, 519 tests passed on a main base (530 with the sorting PR's tests).
- `npm run lint` → 0 errors, 3 pre-existing warnings. `npm run build:all` → success.
- Real Chrome for Testing + Playwright, mocked AI, default AI-inferred file-mode flow, 4 consecutive runs (60/80/100/120):
  latest = 120, older = [100, 80], run 1 deleted, exactly 2 `organizedRun:*` keys, no `categories` setting written.
  Reopened panel: banner (120) + "Previous runs (2)"; Save As picker (stubbed) wrote 80, 120 and the pristine 120-link
  input; log showed "Saved …"; no page errors.

## Not verified / follow-ups
- The native Save As dialog itself, and `showSaveFilePicker` inside the real side panel. If the picker is refused there,
  the fallback is `chrome.downloads` (the previous behavior), so a dialog is not guaranteed in a Chromium that ignores `saveAs`.
- Service-worker restart path is unit-tested (`GET_RESULTS` fallback) but was not exercised in a real browser.
- No UI to delete an individual saved run.
- My probe once ran `screencapture` of the full display; images were deleted. Use window-scoped capture next time.
