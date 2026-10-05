// File-mode input preservation (spec §12): the pristine dropped-in HTML is the date
// source of truth for file mode. Cached raw, never mutated by organize runs.
//
// Input files are stored with unlimited capacity using the extension's unlimitedStorage.
// Each file's HTML is stored under its own key (`inputBookmarkHtml:<id>`), separate from
// the tiny metadata record in `inputBookmarksList`. Panel startup reads only the metadata
// list, so opening the side panel never drags megabytes out of LevelDB. The HTML is
// fetched on demand (download / re-organize). Legacy single-entry records are seamlessly
// migrated into the list on load.
export const INPUT_MAX_BYTES = Infinity;
const LEGACY_KEY = 'inputBookmarks';
const META_KEY = 'inputBookmarksMeta';
const HTML_KEY = 'inputBookmarksHtml';
const LIST_KEY = 'inputBookmarksList';
const DATA_PREFIX = 'inputBookmarkHtml:';

const local = () => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) throw new Error('chrome.storage.local unavailable');
    return chrome.storage.local;
};

const getKeys = (keys) => new Promise((resolve, reject) => {
    local().get(keys, (res) => {
        if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res || {});
    });
});

const setKeys = (payload) => new Promise((resolve, reject) => {
    local().set(payload, () => {
        if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
    });
});

// Returns the full list of recorded input files metadata, newest first.
// Seamlessly migrates any legacy single-slot input file into the list.
export async function listInputBookmarkFiles() {
    try {
        const res = await getKeys([LIST_KEY, META_KEY, LEGACY_KEY]);
        if (Array.isArray(res[LIST_KEY]) && res[LIST_KEY].length > 0) {
            return res[LIST_KEY];
        }
        if (res[META_KEY]) {
            const entry = res[META_KEY];
            const id = entry.id || String(entry.savedAt || Date.now());
            const meta = { id, filename: entry.filename, size: entry.size, savedAt: entry.savedAt || Date.now(), count: entry.count, dateSpan: entry.dateSpan };
            const migrated = [meta];
            const htmlRes = await getKeys([HTML_KEY]);
            const html = htmlRes[HTML_KEY];
            const toSet = { [LIST_KEY]: migrated };
            if (typeof html === 'string') {
                toSet[`${DATA_PREFIX}${id}`] = html;
            }
            await setKeys(toSet);
            return migrated;
        }
        if (res[LEGACY_KEY]) {
            const entry = res[LEGACY_KEY];
            const id = String(entry.savedAt || Date.now());
            const meta = { id, filename: entry.filename, size: entry.size, savedAt: entry.savedAt || Date.now(), count: entry.count, dateSpan: entry.dateSpan };
            const toSet = { [LIST_KEY]: [meta] };
            if (typeof entry.html === 'string') {
                toSet[`${DATA_PREFIX}${id}`] = entry.html;
            }
            await setKeys(toSet);
            return [meta];
        }
        return [];
    } catch {
        return [];
    }
}

export async function saveInputBookmarkFile({ filename, html, count, dateSpan }) {
    try {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const validHtml = typeof html === 'string' ? html : '';
        const meta = { id, filename: filename || 'bookmarks.html', size: validHtml.length, savedAt: Date.now(), count: Number(count) || 0, dateSpan };
        const existingList = await listInputBookmarkFiles();
        const updatedList = [meta, ...existingList.filter((e) => e.id !== id)];

        await setKeys({
            [LIST_KEY]: updatedList,
            [`${DATA_PREFIX}${id}`]: validHtml,
            [META_KEY]: meta,
            [HTML_KEY]: validHtml
        });

        // Clean up legacy combined entry if present
        await new Promise((resolve) => {
            local().remove([LEGACY_KEY], () => resolve());
        });

        return { saved: true, entry: { ...meta, html } };
    } catch (err) {
        return { saved: false, reason: err?.message || 'storage-error' };
    }
}

// Tiny (bytes) record for panel startup: filename, count, dates — no HTML.
// If an id is provided, returns that specific file's metadata; otherwise returns the latest.
export async function getInputBookmarkMeta(id) {
    try {
        if (id) {
            const list = await listInputBookmarkFiles();
            return list.find((e) => e.id === id) || null;
        }
        const res = await getKeys([META_KEY]);
        if (res[META_KEY]) {
            const entry = res[META_KEY];
            return {
                id: entry.id,
                filename: entry.filename,
                size: entry.size,
                savedAt: entry.savedAt,
                count: entry.count,
                dateSpan: entry.dateSpan
            };
        }
        const list = await listInputBookmarkFiles();
        if (list.length > 0) return list[0];
        const legacy = await getKeys([LEGACY_KEY]);
        if (legacy[LEGACY_KEY]) {
            const entry = legacy[LEGACY_KEY];
            return {
                filename: entry.filename,
                size: entry.size,
                savedAt: entry.savedAt,
                count: entry.count,
                dateSpan: entry.dateSpan
            };
        }
        return null;
    } catch {
        return null;
    }
}

// The heavy part, fetched only on demand when the user actually needs the file back.
export async function getInputBookmarkHtml(id) {
    try {
        if (id) {
            const key = `${DATA_PREFIX}${id}`;
            const res = await getKeys([key, META_KEY, HTML_KEY, LEGACY_KEY]);
            if (typeof res[key] === 'string') return res[key];
            if ((!res[META_KEY]?.id || res[META_KEY]?.id === id) && typeof res[HTML_KEY] === 'string') {
                return res[HTML_KEY];
            }
            if ((!res[LEGACY_KEY]?.id || res[LEGACY_KEY]?.id === id) && typeof res[LEGACY_KEY]?.html === 'string') {
                return res[LEGACY_KEY].html;
            }
            return null;
        }
        const res = await getKeys([HTML_KEY]);
        if (typeof res[HTML_KEY] === 'string') return res[HTML_KEY];
        const list = await listInputBookmarkFiles();
        if (list.length > 0 && list[0].id) {
            const key = `${DATA_PREFIX}${list[0].id}`;
            const itemRes = await getKeys([key]);
            if (typeof itemRes[key] === 'string') return itemRes[key];
        }
        const legacy = await getKeys([LEGACY_KEY]);
        return typeof legacy[LEGACY_KEY]?.html === 'string' ? legacy[LEGACY_KEY].html : null;
    } catch {
        return null;
    }
}

// Full entry including HTML (legacy-aware). Callers that already hold the
// entry from saveInputBookmarkFile should prefer their in-memory copy.
export async function getInputBookmarkFile(id) {
    const meta = await getInputBookmarkMeta(id);
    if (!meta) return null;
    const html = await getInputBookmarkHtml(id || meta.id);
    return { ...meta, html: html || '' };
}

// Removes a specific input file by id, or removes all if id is omitted.
export async function removeInputBookmarkFile(id) {
    if (!id) {
        let extraKeys = [];
        try {
            const res = await getKeys([LIST_KEY]);
            if (Array.isArray(res[LIST_KEY])) {
                extraKeys = [LIST_KEY, ...res[LIST_KEY].map((e) => `${DATA_PREFIX}${e.id}`)];
            }
        } catch {}
        const keys = extraKeys.length > 0
            ? ['inputBookmarks', 'inputBookmarksMeta', 'inputBookmarksHtml', ...extraKeys]
            : ['inputBookmarks', 'inputBookmarksMeta', 'inputBookmarksHtml'];
        await new Promise((resolve, reject) => {
            local().remove(keys, () => {
                if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve();
            });
        });
        return [];
    }

    const list = await listInputBookmarkFiles();
    const updated = list.filter((e) => e.id !== id);
    const keysToRemove = [`${DATA_PREFIX}${id}`];

    await new Promise((resolve, reject) => {
        local().remove(keysToRemove, () => {
            if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
        });
    });

    if (updated.length > 0) {
        const nextLatest = updated[0];
        const nextHtml = await getInputBookmarkHtml(nextLatest.id);
        const toSet = {
            [LIST_KEY]: updated,
            [META_KEY]: nextLatest
        };
        if (nextHtml) toSet[HTML_KEY] = nextHtml;
        await setKeys(toSet);
    } else {
        await new Promise((resolve) => {
            local().remove([META_KEY, HTML_KEY, LIST_KEY], () => resolve());
        });
    }
    return updated;
}

export async function clearAllInputBookmarkFiles() {
    return removeInputBookmarkFile();
}

export async function downloadInputBookmarkFile(entry) {
    const html = (typeof entry?.html === 'string' && entry.html.length > 0)
        ? entry.html
        : await getInputBookmarkHtml(entry?.id);
    if (!html) return { status: 'unavailable' };
    // Loaded on demand so the export module stays out of the panel's startup chunk.
    const { saveHtmlFile } = await import('./bookmarks_export');
    return saveHtmlFile(html, entry?.filename || 'input_bookmarks.html');
}
