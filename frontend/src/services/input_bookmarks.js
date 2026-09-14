// File-mode input preservation (spec §12): the pristine dropped-in HTML is the date
// source of truth for file mode. Cached raw, never mutated by organize runs.
//
// The HTML (up to 25 MB) is stored under its own key, separate from the tiny
// metadata record: panel startup reads only the metadata, so opening the side
// panel never drags megabytes out of LevelDB. The HTML is fetched on demand
// (download / re-organize). The legacy combined `inputBookmarks` entry written
// by older builds is still read and cleaned up.
export const INPUT_MAX_BYTES = 25 * 1024 * 1024;
const LEGACY_KEY = 'inputBookmarks';
const META_KEY = 'inputBookmarksMeta';
const HTML_KEY = 'inputBookmarksHtml';

const local = () => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) throw new Error('chrome.storage.local unavailable');
    return chrome.storage.local;
};

const getKeys = (keys) => new Promise((resolve, reject) => {
    local().get(keys, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res || {});
    });
});

const setKeys = (payload) => new Promise((resolve, reject) => {
    local().set(payload, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
    });
});

export async function saveInputBookmarkFile({ filename, html, count, dateSpan }) {
    if (html.length > INPUT_MAX_BYTES) return { saved: false, reason: 'too-large' };
    const meta = { filename, size: html.length, savedAt: Date.now(), count, dateSpan };
    await setKeys({ [META_KEY]: meta, [HTML_KEY]: html });
    // The legacy combined entry would keep a second 25 MB copy on disk forever.
    await new Promise((resolve) => { local().remove([LEGACY_KEY], () => resolve()); });
    return { saved: true, entry: { ...meta, html } };
}

// Tiny (bytes) record for panel startup: filename, count, dates — no HTML.
export async function getInputBookmarkMeta() {
    try {
        const res = await getKeys([META_KEY]);
        if (res[META_KEY]) return res[META_KEY];
        const legacy = await getKeys([LEGACY_KEY]);
        if (legacy[LEGACY_KEY]) {
            const entry = legacy[LEGACY_KEY];
            return { filename: entry.filename, size: entry.size, savedAt: entry.savedAt, count: entry.count, dateSpan: entry.dateSpan };
        }
        return null;
    } catch {
        return null;
    }
}

// The heavy part, only when the user actually needs the file back.
export async function getInputBookmarkHtml() {
    try {
        const res = await getKeys([HTML_KEY]);
        if (typeof res[HTML_KEY] === 'string') return res[HTML_KEY];
        const legacy = await getKeys([LEGACY_KEY]);
        return typeof legacy[LEGACY_KEY]?.html === 'string' ? legacy[LEGACY_KEY].html : null;
    } catch {
        return null;
    }
}

// Full entry including HTML (legacy-aware). Callers that already hold the
// entry from saveInputBookmarkFile should prefer their in-memory copy.
export async function getInputBookmarkFile() {
    const meta = await getInputBookmarkMeta();
    if (!meta) return null;
    const html = await getInputBookmarkHtml();
    return { ...meta, html: html || '' };
}

export async function removeInputBookmarkFile() {
    await new Promise((resolve, reject) => {
        local().remove([LEGACY_KEY, META_KEY, HTML_KEY], () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
        });
    });
}

export async function downloadInputBookmarkFile(entry) {
    const html = (typeof entry?.html === 'string' && entry.html.length > 0) ? entry.html : await getInputBookmarkHtml();
    if (!html) return;
    const name = entry?.filename || 'input_bookmarks.html';
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
        chrome.downloads.download({ url, filename: name, saveAs: true });
    } else if (typeof document !== 'undefined' && document.createElement) {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
