// The newest organized result plus up to MAX_RUNS - 1 older ones, kept on disk so
// every run stays downloadable after the panel closes or the browser restarts.
//
// Layout in chrome.storage.local (panel startup reads only the small keys):
//   organizedMeta / organizedData   latest run (data also mirrored to session)
//   organizedHistory                metadata of the older runs, newest first
//   organizedRun:<id>               data of one older run
export const MAX_RUNS = 3;

const META_KEY = 'organizedMeta';
const DATA_KEY = 'organizedData';
const HISTORY_KEY = 'organizedHistory';
const RUN_PREFIX = 'organizedRun:';

const runKey = (id) => `${RUN_PREFIX}${id}`;

const read = (area, keys) => new Promise((resolve) => area.get(keys, (res) => resolve(res || {})));

const write = (area, entries) => new Promise((resolve, reject) => {
    area.set(entries, () => {
        const err = typeof chrome !== 'undefined' ? chrome.runtime?.lastError : null;
        if (err) reject(new Error(err.message));
        else resolve();
    });
});

const erase = (area, keys) => new Promise((resolve) => {
    if (keys.length === 0) return resolve();
    area.remove(keys, () => resolve());
});

/**
 * Pure: given the older runs and the run that is about to be replaced as latest,
 * returns the new older-run list (newest first) and the ids that fell off the end.
 */
export function rotateRuns(history, previousLatest, max = MAX_RUNS) {
    const older = Array.isArray(history) ? history : [];
    const previous = previousLatest && Number.isFinite(previousLatest.savedAt)
        ? { ...previousLatest, id: String(previousLatest.savedAt) }
        : null;
    const merged = previous ? [previous, ...older.filter(entry => entry.id !== previous.id)] : [...older];
    return {
        entries: merged.slice(0, max - 1),
        dropped: merged.slice(max - 1).map(entry => entry.id)
    };
}

export async function saveRun(results, meta) {
    const local = chrome.storage.local;
    const stored = await read(local, [META_KEY, DATA_KEY, HISTORY_KEY]);

    // A previous latest without stored data (older builds kept metadata only)
    // has nothing to download, so it does not become a history entry.
    const previousHasData = Array.isArray(stored[DATA_KEY]) && stored[DATA_KEY].length > 0;
    const { entries, dropped } = rotateRuns(stored[HISTORY_KEY], previousHasData ? stored[META_KEY] : null);

    const update = { [META_KEY]: meta, [DATA_KEY]: results, [HISTORY_KEY]: entries };
    if (previousHasData) {
        const demoted = entries.find(entry => entry.id === String(stored[META_KEY].savedAt));
        if (demoted) update[runKey(demoted.id)] = stored[DATA_KEY];
    }
    await write(local, update);
    await erase(local, dropped.map(runKey));

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
