# Resume interrupted runs — design

**Date:** 2026-10-19 · **Status:** approved in brainstorming, pending spec review

## Depends on

PR #108 (interrupted notice shown live; this card replaces that notice) and PR #109
(`retryCause` labels, used for the card's "Stopped because" line). Start after both merge.

## Problem

An AI organize run lives only in memory (the background worker's `OrganizerService`, or the
panel's when the worker does not acknowledge). When the worker is killed, the browser restarts,
or a call still fails after its retries (e.g. a Gemini 503 overload), all finished work is lost
and the user starts over. For a ~3,600-bookmark run that is minutes of work and API quota.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Which interruptions resume | Worker killed, browser/computer restart, and a run that failed on an API error |
| How resume is offered | A card with **Resume** / **Discard**; no API calls until the user clicks |
| Settings on resume | The interrupted run's settings (plan, categories, depth, sorting); the **current** API key and model |
| Approach | Stage checkpoints in the pipeline (rejected: memoizing AI calls — breaks on the random schema sample and on model switches; serializing the service — couples storage to internals) |
| Browser bookmarks changed since | Resume uses the snapshot taken at run start; deleted bookmarks are skipped and reported, new ones are left untouched |
| How many saved runs | One; starting a new run replaces it |

## 1. What is saved, and when

Storage: `chrome.storage.local` (the extension already holds `unlimitedStorage`, and finished
runs already live there via `runHistory.js`). Split keys so a write never rewrites everything:

| Key | Contents | Written |
|---|---|---|
| `runCheckpoint` | Header: `version`, `id`, `startedAt`, `updatedAt`, `source` (`'browser'` or the file name), run settings (everything `OrganizerService` takes except API key and model), `stage` flags, designed/approved schema, `batchSize`, `batchCount`, `batchesDone`, `labels` once placement starts, `failure: { reason, at }` | At each stage boundary; `batchesDone` on every saved batch |
| `runCheckpoint:input` | Deduped links (ids, titles, URLs, dates), `duplicatesRemoved`, doomed duplicate ids, `dateSpan` | Once, before the first API call |
| `runCheckpoint:batch:<n>` | Classified results of batch `n` | As each batch succeeds |
| `runCheckpoint:classified` | Working result after rehome, then after details, then after review (each stage overwrites) | After each of those stages |

- Never saved: API key, model.
- `batchSize` is saved because `calculateAdaptiveBatchSize` depends on the model; resuming on
  another model must slice batches identically so saved batch `n` still lines up.
- Unknown `version` on load: treat as no checkpoint and clear it.

Lifecycle:
- **Created** for AI runs (`runAI`) only, right after dedupe and before the first API call.
  Flat date-sort runs are not checkpointed.
- **Kept** on worker death, browser restart, and error; an error records `failure`.
- **Deleted** on successful finish, user cancel, Discard, and when a new run starts.

## 2. Resume flow

New module `frontend/src/services/runCheckpoint.js` — only reads/writes the keys above:
`create(header, input)`, `markStage(patch)`, `saveBatch(n, results)`, `saveClassified(rows, stage)`,
`recordFailure(reason)`, `load()` → `{ header, input, batches, classified } | null`, `loadHeader()`,
`clear()`. The storage area is injected so tests use a fake.

`OrganizerService.resume(checkpoint)` sits beside `start()`; both feed `runAI`. `start()` creates
the checkpoint after `dedupe`. `resume()` rebuilds the run from the saved input and settings, then:

| Stage | On resume |
|---|---|
| `designSchema` | Skipped when a designed schema is saved |
| `reviewPlan` | Skipped when approved; if the run stopped while waiting for review, the review reopens with the saved schema (no regeneration) |
| `classifyAll` | Runs only batches without a saved result, using the saved `batchSize` |
| `reconcileClassified` | Always re-run (pure, no AI) |
| `rehomeLoose`, `enrichDetails` | Each skipped when its output is saved |
| `reviewResult` | Skipped when approved; otherwise reopens with the saved result |
| `placeInBrowser` / `writeFile` | Re-run fully with the saved `labels` (root folder title carries a date). Safe to repeat: `findOrCreateFolder` reuses folders, moving into the current parent is a no-op, reorders are idempotent. The backup download (`prepareSnapshot`) is **skipped** when placement had already started, so no second backup file captures the half-moved layout |
| finish | Checkpoint cleared |

Runner: a `RESUME_JOB` port message (current API key + model) mirrors `START_JOB`; the worker
acknowledges with `JOB_ACK` and calls `resume()`. Without an ACK the panel runs `resume()` itself,
as the start path's fallback does today.

Failures: an error after retries calls `recordFailure(reason)`; cancel calls `clear()`; a killed
worker needs nothing — everything up to the last save is on disk.

## 3. Panel

The resume card replaces today's interrupted notice. It is shown when the panel opens and when a
live run turns interrupted or errors, based on `loadHeader()` (small key only):

> **Your last run stopped before finishing**
> Browser bookmarks · started Oct 19, 9:30 AM
> Folder plan approved · classified 41 of 60 batches
> Stopped because: provider is temporarily overloaded (HTTP 503)
> **[Resume]** [Discard]

- Times render in the user's local time zone (`toLocaleString`).
- **Resume** sends `RESUME_JOB`; the usual progress view and terminal take over, with a first log
  line like "Resuming: skipping 41 finished batches".
- **Discard** confirms once ("Discard the saved progress of your last run?"), then clears.
- Starting a new run while a checkpoint exists confirms once ("Starting over discards your last
  run's saved progress.").
- No API key entered → Resume disabled with a hint.
- The red error box still shows above the card when a run fails in front of the user.
- The card is a labelled region with real buttons.

## 4. Testing

- `runCheckpoint.test.js` (fake storage): round-trip; `saveBatch` bumps `batchesDone`; `clear`
  removes every `runCheckpoint*` key; `recordFailure`; unknown `version` loads as `null` and clears.
- `organizer.test.js` (AI mocked and counted): `start()` writes the checkpoint before the first AI
  call; resume with an approved plan makes no schema call; 41/60 saved → exactly 19 classify calls,
  with the saved batch size after switching to a Pro model; stopped during plan review → review
  reopens with the saved schema; placement resume skips the backup and reuses `labels`; finish and
  cancel clear; error records `failure`.
- Background: `RESUME_JOB` → `JOB_ACK` + `resume()`; panel fallback when no ACK.
- `Organizer.test.jsx`: card renders from the header with the right progress line; Resume sends
  `RESUME_JOB` with current key + model; Discard and new-run confirms; Resume disabled without key.
- Manual (Chrome): kill the worker mid-classification at `chrome://serviceworker-internals`,
  reopen, Resume → only remaining batches run; repeat with a full browser restart mid-run.

## Out of scope

Overload fallback model, pre-run duplicate summary, result-editor parity, `Organizer.jsx` split,
checkpointing inside the rehome/detail stages, multiple saved checkpoints.
