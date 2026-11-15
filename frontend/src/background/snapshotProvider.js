import { downloadBookmarks } from '../services/bookmarks_export';

const MAX_BACKUP_BYTES = 8 * 1024 * 1024; // spec §5: over the bound, warn and proceed

/**
 * Pre-write backup for background runs.
 * - Starts a best-effort HTML download (the README's promised local backup); a failed download is only logged.
 * - Stores the same items in chrome.storage.local; rejects if that write fails, so the run stops before writing.
 * Limits: one storage slot, overwritten each run; above 8 MB only the download is attempted.
 */
export function createStorageSnapshotProvider(log = () => {}) {
    return async (survivors, doomedDuplicates) => {
        const all = [...survivors, ...doomedDuplicates];
        try {
            const day = new Date().toISOString().slice(0, 10);
            await downloadBookmarks(all, `bookmarks_backup_${day}.html`, { saveAs: false });
        } catch (err) {
            log(`HTML backup download failed (${err?.message || err}); keeping the storage backup only.`);
        }

        const items = all.map((b) => ({
            title: b.title,
            url: b.url,
            add_date: b.add_date || (b.dateAdded ? String(Math.floor(b.dateAdded / 1000)) : undefined)
        }));
        const json = JSON.stringify(items);
        if (json.length > MAX_BACKUP_BYTES) {
            log(`Pre-write backup skipped: ${items.length} bookmarks exceed the ${Math.round(MAX_BACKUP_BYTES / (1024 * 1024))} MB storage bound. Recovery relies on an idempotent re-run.`);
            return;
        }
        await new Promise((resolve, reject) => {
            chrome.storage.local.set(
                { preWriteBackup: { savedAt: Date.now(), count: items.length, items } },
                () => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve();
                }
            );
        });
    };
}
