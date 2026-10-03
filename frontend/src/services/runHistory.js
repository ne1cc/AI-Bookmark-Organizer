// Every organized result, kept on disk so each run stays downloadable after the
// panel closes or the browser restarts. Nothing is discarded unless the user deletes it.
//
// Layout in chrome.storage.local (panel startup reads only the small keys):
//   organizedMeta / organizedData   latest run (data also mirrored to session)
//   organizedHistory                metadata of the older runs, newest first
//   organizedRun:<id>               data of one older run
const META_KEY = 'organizedMeta';
const DATA_KEY = 'organizedData';
const HISTORY_KEY = 'organizedHistory';
const RUN_PREFIX = 'organizedRun:';

const runKey = (id) => `${RUN_PREFIX}${id}`;

const read = (area, keys) => new Promise((resolve) => area.get(keys, (res) => resolve(res || {})));

const erase = (area, keys) => new Promise((resolve) => {
    if (keys.length === 0) return resolve();
    area.remove(keys, () => resolve());
});

const write = (area, entries) => new Promise((resolve, reject) => {
    area.set(entries, () => {
        const err = typeof chrome !== 'undefined' ? chrome.runtime?.lastError : null;
        if (err) reject(new Error(err.message));
        else resolve();
    });
});

/**
 * Pure: given the older runs and the run that is about to be replaced as latest,
 * returns the new older-run list (newest first).
 */
export function rotateRuns(history, previousLatest) {
    const older = Array.isArray(history) ? history : [];
    const previous = previousLatest && Number.isFinite(previousLatest.savedAt)
        ? { ...previousLatest, id: String(previousLatest.savedAt) }
        : null;
    return previous ? [previous, ...older.filter(entry => entry.id !== previous.id)] : [...older];
}

export async function saveRun(results, meta) {
    const local = chrome.storage.local;
    const stored = await read(local, [META_KEY, DATA_KEY, HISTORY_KEY]);

    // A previous latest without stored data (older builds kept metadata only)
    // has nothing to download, so it does not become a history entry.
    const previousHasData = Array.isArray(stored[DATA_KEY]) && stored[DATA_KEY].length > 0;
    const entries = rotateRuns(stored[HISTORY_KEY], previousHasData ? stored[META_KEY] : null);

    const update = { [META_KEY]: meta, [DATA_KEY]: results, [HISTORY_KEY]: entries };
    if (previousHasData) {
        const demoted = entries.find(entry => entry.id === String(stored[META_KEY].savedAt));
        if (demoted) update[runKey(demoted.id)] = stored[DATA_KEY];
    }
    await write(local, update);

    // RAM copy for fast reads in this browser session; disk is the source of truth.
    if (chrome.storage.session) {
        try { await write(chrome.storage.session, { [DATA_KEY]: results }); } catch { /* disk copy is enough */ }
    }
}

export async function loadHistory() {
    const stored = await read(chrome.storage.local, [HISTORY_KEY]);
    return Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
}

export async function loadLatestRun() {
    const stored = await read(chrome.storage.local, [META_KEY, DATA_KEY]);
    const results = stored[DATA_KEY];
    if (!stored[META_KEY] || !Array.isArray(results) || results.length === 0) return null;
    return { results, meta: stored[META_KEY] };
}

export async function loadRunData(id) {
    const stored = await read(chrome.storage.local, [runKey(id)]);
    const data = stored[runKey(id)];
    return Array.isArray(data) && data.length > 0 ? data : null;
}

// Deletes one older run (metadata and data); returns the remaining older runs.
export async function deleteRun(id) {
    const local = chrome.storage.local;
    const history = (await loadHistory()).filter(entry => entry.id !== id);
    await write(local, { [HISTORY_KEY]: history });
    await erase(local, [runKey(id)]);
    return history;
}

// Deletes every older run; the latest run is untouched.
export async function clearHistory() {
    const local = chrome.storage.local;
    const history = await loadHistory();
    await write(local, { [HISTORY_KEY]: [] });
    await erase(local, history.map(entry => runKey(entry.id)));
}
