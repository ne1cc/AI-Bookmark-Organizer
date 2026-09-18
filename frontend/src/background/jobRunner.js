import { OrganizerService } from '../services/organizer';
import { downloadBookmarks } from '../services/bookmarks_export';
import { calculateDateSpan } from '../utils/dates';
import { createStorageSnapshotProvider } from './snapshotProvider';

export class BackgroundJobRunner {
    constructor() {
        this.currentJob = {
            id: null,
            status: 'idle', // 'idle' | 'processing' | 'complete' | 'error'
            progress: 0,
            logs: [],
            activeDateSpan: null,
            backgroundNotice: '',
            errorMsg: '',
            stats: null,
            count: null,
            completedAt: null
        };
        this.organizer = null;
        this.keepAliveTimer = null;
        this.subscribers = new Set();
        this.cachedResults = null;
        this.persistJobState = true;
    }

    getState() {
        return {
            ...this.currentJob,
            logs: [...this.currentJob.logs]
        };
    }

    getResults() {
        return this.cachedResults;
    }

    subscribe(listener) {
        this.subscribers.add(listener);
        return () => this.subscribers.delete(listener);
    }

    notify(event, payload) {
        for (const listener of this.subscribers) {
            try {
                listener(event, payload);
            } catch (err) {
                console.warn('[JobRunner] Listener error:', err);
            }
        }
    }

    startKeepAlive() {
        this.stopKeepAlive();
        if (typeof setInterval !== 'undefined') {
            this.keepAliveTimer = setInterval(() => {
                try {
                    if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
                        chrome.runtime.getPlatformInfo(() => {
                            // keep-alive ping
                        });
                    }
                } catch {
                    // Ignore keep-alive failure
                }
            }, 15000);
        }
    }

    stopKeepAlive() {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    persistSessionSnapshot() {
        if (!this.persistJobState) return;
        if (typeof chrome !== 'undefined' && chrome.storage?.session) {
            try {
                chrome.storage.session.set({
                    activeJobState: {
                        id: this.currentJob.id,
                        status: this.currentJob.status,
                        progress: this.currentJob.progress,
                        logs: this.currentJob.logs.slice(-60),
                        activeDateSpan: this.currentJob.activeDateSpan,
                        backgroundNotice: this.currentJob.backgroundNotice,
                        errorMsg: this.currentJob.errorMsg,
                        stats: this.currentJob.stats,
                        count: this.currentJob.count,
                        completedAt: this.currentJob.completedAt
                    }
                });
            } catch {
                // Ignore storage session errors
            }
        }
    }

    addLog(message) {
        const entry = { message, timestamp: Date.now() };
        this.currentJob.logs.push(entry);
        if (this.currentJob.logs.length > 150) {
            this.currentJob.logs = this.currentJob.logs.slice(-100);
        }
        this.notify('log', entry);
    }

    async startJob(config, parsedBookmarks = null) {
        const {
            apiKey,
            categories,
            selectedModel,
            subfolderTarget,
            sortAlphabetically,
            removeDuplicates,
            cleanTitles,
            flatDateSort,
            dateSortOrder,
            schemaSortOrder,
            inferCategories = true,
            autoImport = true
        } = config;
        this.persistJobState = flatDateSort || !inferCategories;

        const jobId = `job_${Date.now()}`;
        this.cachedResults = null;
        if (typeof chrome !== 'undefined' && chrome.storage?.session) {
            try {
                chrome.storage.session.remove(['organizedData']);
            } catch {}
        }
        this.currentJob = {
            id: jobId,
            status: 'processing',
            progress: 0,
            logs: [],
            activeDateSpan: null,
            backgroundNotice: '',
            errorMsg: '',
            stats: null,
            count: null,
            completedAt: null
        };

        this.startKeepAlive();
        this.persistSessionSnapshot();
        this.notify('status', this.getState());

        if (parsedBookmarks) {
            this.addLog(`Auto-Import File to Other Bookmarks: ${autoImport ? 'On (top of list)' : 'Off'}`);
        }

        if (flatDateSort) {
            const orderLabel = dateSortOrder === 'desc' ? 'Newest First' : 'Oldest First';
            this.addLog('Starting Chronological Date Sort...');
            this.addLog('Mode: Flat List (No Folders / Schema-free)');
            this.addLog(`Sort Direction: ${orderLabel}`);
            this.addLog(`Remove Duplicate URLs: ${removeDuplicates ? 'On' : 'Off'}`);
            this.addLog(`Clean Bookmark Titles: ${cleanTitles ? 'On' : 'Off'}`);
        } else {
            this.addLog('Starting AI Organization in Background...');
            this.addLog(`Using Model: Google Gemini ${selectedModel || 'Default'}`);
            this.addLog(`Subfolder Organization: ${subfolderTarget || 'medium'}`);
            this.addLog(`Folder Content Sorting: ${schemaSortOrder || 'Alphabetical (A–Z)'}`);
            this.addLog(`Remove Duplicate URLs: ${removeDuplicates ? 'On' : 'Off'}`);
            this.addLog(`Clean Bookmark Titles: ${cleanTitles ? 'On' : 'Off'}`);
            this.addLog(`Category Source: ${inferCategories ? 'AI inferred from bookmarks' : `${categories.length} manual categories`}`);
        }

        this.organizer = new OrganizerService(
            apiKey,
            categories,
            (data) => {
                if (this.currentJob.id !== jobId) return;

                if (data.dateSpan) {
                    this.currentJob.activeDateSpan = data.dateSpan;
                }
                if (data.status === 'info') {
                    this.addLog(data.message);
                } else if (data.status === 'processing') {
                    if (data.message) this.addLog(data.message);
                    if (typeof data.percent === 'number') this.currentJob.progress = data.percent;
                } else if (data.status === 'progress') {
                    if (data.message) this.addLog(data.message);
                    this.currentJob.progress = data.percent;
                    if (data.clearNotice) {
                        this.currentJob.backgroundNotice = '';
                    }
                } else if (data.status === 'retry') {
                    this.addLog(data.message);
                    this.currentJob.backgroundNotice = data.message;
                } else if (data.status === 'warning') {
                    this.addLog(data.message);
                    if (data.message?.includes('Pausing') || data.message?.includes('Retrying') || data.message?.includes('background')) {
                        this.currentJob.backgroundNotice = data.message;
                    }
                    if (data.message?.includes('cancelled') || data.message?.includes('Cancelled')) {
                        this.currentJob.status = 'idle';
                        this.currentJob.progress = 0;
                        this.currentJob.backgroundNotice = '';
                    }
                } else if (data.status === 'error') {
                    this.currentJob.errorMsg = data.message;
                    this.currentJob.backgroundNotice = '';
                    this.currentJob.status = 'error';
                } else if (data.status === 'success') {
                    this.addLog(data.message);
                    this.currentJob.backgroundNotice = '';
                } else if (data.status === 'done') {
                    this.addLog(data.message);
                    this.currentJob.backgroundNotice = '';
                    this.currentJob.status = 'complete';
                    this.currentJob.progress = 100;
                }

                this.persistSessionSnapshot();
                this.notify('status', this.getState());
            },
            selectedModel,
            subfolderTarget,
            sortAlphabetically,
            removeDuplicates,
            cleanTitles,
            flatDateSort,
            dateSortOrder,
            schemaSortOrder,
            // Do not open a native Save As dialog inline with start(). Let
            // start() resolve and notify the panel that the job is complete
            // first, then launch the dialog on the next task.
            parsedBookmarks ? () => {} : inferCategories
        );
        this.organizer.snapshotProvider = createStorageSnapshotProvider((msg) => this.addLog(msg));

        try {
            const results = await this.organizer.start(parsedBookmarks);

            if (this.organizer.isCancelled || !results) {
                this.currentJob.status = 'idle';
                this.currentJob.progress = 0;
                this.currentJob.backgroundNotice = '';
                this.stopKeepAlive();
                this.persistSessionSnapshot();
                this.notify('status', this.getState());
                this.notify('cancelled', {});
                return null;
            }

            if (results && results.length > 0) {
                this.cachedResults = results;
                const completedAt = Date.now();
                const stats = this.organizer?.stats || results.stats || null;
                const finalSpan = stats?.dateSpan || this.currentJob.activeDateSpan || calculateDateSpan(results);
                const enrichedStats = {
                    ...(stats || {}),
                    ...(finalSpan ? { dateSpan: finalSpan } : {})
                };
                const meta = {
                    count: results.length,
                    savedAt: completedAt,
                    stats: enrichedStats,
                    ...(finalSpan ? { dateSpan: finalSpan } : {})
                };

                this.currentJob.status = 'complete';
                this.currentJob.progress = 100;
                this.currentJob.stats = enrichedStats;
                this.currentJob.count = results.length;
                this.currentJob.completedAt = completedAt;
                if (finalSpan) {
                    this.currentJob.activeDateSpan = finalSpan;
                }

                if (this.persistJobState && typeof chrome !== 'undefined' && chrome.storage) {
                    if (chrome.storage.session) {
                        try {
                            chrome.storage.session.set({ organizedData: results });
                        } catch { /* ignore session set errors */ }
                    }
                    if (chrome.storage.local) {
                        chrome.storage.local.set({ organizedMeta: meta, organizedData: results });
                    }
                }

                if (!parsedBookmarks) this.stopKeepAlive();
                this.persistSessionSnapshot();
                this.notify('status', this.getState());
                this.notify('complete', { results, meta, stats: enrichedStats });
                if (parsedBookmarks) {
                    setTimeout(() => {
                        try {
                            downloadBookmarks(results);
                        } catch (downloadError) {
                            console.warn('[Background] Deferred file download failed:', downloadError);
                        } finally {
                            this.stopKeepAlive();
                        }
                    }, 0);
                }
                return results;
            }

            return results;
        } catch (err) {
            if (this.organizer?.isCancelled || err?.isCancelled || err?.name === 'AbortError') {
                this.currentJob.status = 'idle';
                this.currentJob.progress = 0;
                this.currentJob.backgroundNotice = '';
                this.stopKeepAlive();
                this.persistSessionSnapshot();
                this.notify('status', this.getState());
                this.notify('cancelled', {});
                return null;
            }
            console.error('[JobRunner] Execution error:', err);
            this.currentJob.status = 'error';
            this.currentJob.errorMsg = err?.message || 'Failed to complete organization.';
            this.stopKeepAlive();
            this.persistSessionSnapshot();
            this.notify('status', this.getState());
            this.notify('error', { message: this.currentJob.errorMsg });
            throw err;
        }
    }

    cancelJob() {
        if (this.organizer) {
            this.organizer.cancel();
        }
        this.currentJob.status = 'idle';
        this.currentJob.progress = 0;
        this.currentJob.backgroundNotice = '';
        this.addLog('Cancellation requested — process cancelled.');
        this.stopKeepAlive();
        this.persistSessionSnapshot();
        this.notify('status', this.getState());
        this.notify('cancelled', {});
    }

    resetJob() {
        this.cancelJob();
        this.cachedResults = null;
        this.currentJob = {
            id: null,
            status: 'idle',
            progress: 0,
            logs: [],
            activeDateSpan: null,
            backgroundNotice: '',
            errorMsg: '',
            stats: null,
            count: null,
            completedAt: null
        };
        if (typeof chrome !== 'undefined' && chrome.storage?.session) {
            try {
                chrome.storage.session.remove(['activeJobState', 'organizedData']);
            } catch {
                // Ignore removal error
            }
        }
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            try {
                chrome.storage.local.remove(['organizedMeta', 'organizedData']);
            } catch {
                // Ignore removal error
            }
        }
        this.notify('status', this.getState());
    }
}

export const jobRunner = new BackgroundJobRunner();
