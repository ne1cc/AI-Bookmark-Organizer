// File-mode input preservation (spec §12): the pristine dropped-in HTML is the date
// source of truth for file mode. Cached raw, never mutated by organize runs.
// Supports caching up to 3 input files.
export const INPUT_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_CACHED_INPUTS = 3;
const STORAGE_KEY = 'inputBookmarks';

const local = () => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) throw new Error('chrome.storage.local unavailable');
    return chrome.storage.local;
};

export function normalizeBookmarkEntries(stored) {
    if (!stored) return [];
    if (Array.isArray(stored)) return stored.filter(Boolean);
    if (typeof stored === 'object' && (stored.html || stored.filename)) {
        return [stored];
    }
    return [];
}

export async function getInputBookmarkFiles() {
    return new Promise((resolve, reject) => {
        local().get([STORAGE_KEY], (res) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(normalizeBookmarkEntries(res?.[STORAGE_KEY]));
        });
    });
}

export async function getInputBookmarkFile() {
    const files = await getInputBookmarkFiles();
    return files[0] || null;
}

export async function saveInputBookmarkFile({ filename, html, count, dateSpan }) {
    if (html.length > INPUT_MAX_BYTES) return { saved: false, reason: 'too-large' };

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newEntry = {
        id,
        filename,
        html,
        size: html.length,
        savedAt: Date.now(),
        count,
        dateSpan
    };

    const currentFiles = await getInputBookmarkFiles().catch(() => []);

    // If a file with identical filename and html content already exists, replace it so it moves to top
    const filtered = currentFiles.filter(f => !(f.filename === filename && f.size === html.length));

    // Prepend new entry, keep at most MAX_CACHED_INPUTS (3)
    const updated = [newEntry, ...filtered].slice(0, MAX_CACHED_INPUTS);

    await new Promise((resolve, reject) => {
        local().set({ [STORAGE_KEY]: updated }, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
        });
    });

    return { saved: true, entry: newEntry, entries: updated };
}

export async function removeInputBookmarkFile(idOrFilename) {
    if (!idOrFilename) {
        return new Promise((resolve, reject) => {
            local().remove([STORAGE_KEY], () => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve([]);
            });
        });
    }

    const currentFiles = await getInputBookmarkFiles().catch(() => []);
    const remaining = currentFiles.filter(f => f.id !== idOrFilename && f.filename !== idOrFilename);

    await new Promise((resolve, reject) => {
        if (remaining.length === 0) {
            local().remove([STORAGE_KEY], () => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve();
            });
        } else {
            local().set({ [STORAGE_KEY]: remaining }, () => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve();
            });
        }
    });

    return remaining;
}

export function downloadInputBookmarkFile(entry) {
    if (!entry || !entry.html) return;
    const name = entry.filename || 'input_bookmarks.html';
    const blob = new Blob([entry.html], { type: 'text/html' });
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
