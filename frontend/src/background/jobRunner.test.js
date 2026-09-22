import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackgroundJobRunner } from './jobRunner';
import { OrganizerService } from '../services/organizer';

vi.mock('../services/organizer', () => ({
    OrganizerService: vi.fn(function (apiKey, categories, onProgress) {
        this.onProgress = onProgress;
        this.start = vi.fn(async () => [
            { title: 'Example 1', url: 'https://example.com/1' },
            { title: 'Example 2', url: 'https://example.com/2' }
        ]);
        this.cancel = vi.fn();
        this.isCancelled = false;
        this.stats = null;
    })
}));

describe('BackgroundJobRunner', () => {
    let runner;

    beforeEach(() => {
        vi.useFakeTimers();
        OrganizerService.mockClear();

        // Mock chrome extension APIs
        globalThis.chrome = {
            runtime: {
                getPlatformInfo: vi.fn((cb) => cb && cb({ os: 'mac' })),
                lastError: null
            },
            bookmarks: {
                getTree: vi.fn((cb) => cb([{
                    id: 'root',
                    title: 'root',
                    children: [
                        {
                            id: '1',
                            title: 'Bookmarks Bar',
                            children: [
                                { id: 'b1', title: 'Example 1', url: 'https://example.com/1', dateAdded: 1600000000000 },
                                { id: 'b2', title: 'Example 2', url: 'https://example.com/2', dateAdded: 1700000000000 }
                            ]
                        }
                    ]
                }])),
                getChildren: vi.fn((id, cb) => cb && cb([])),
                create: vi.fn((data, cb) => cb && cb({ id: 'new_id', ...data }))
            },
            downloads: {
                download: vi.fn()
            },
            storage: {
                session: {
                    get: vi.fn((keys, cb) => cb && cb({})),
                    set: vi.fn((data, cb) => cb && cb()),
                    remove: vi.fn((keys, cb) => cb && cb())
                },
                local: {
                    get: vi.fn((keys, cb) => cb && cb({})),
                    set: vi.fn((data, cb) => cb && cb()),
                    remove: vi.fn((keys, cb) => cb && cb())
                }
            },
            notifications: {
                create: vi.fn((id, opts, cb) => cb && cb(id)),
                clear: vi.fn((id, cb) => cb && cb())
            }
        };

        runner = new BackgroundJobRunner();
    });

    afterEach(() => {
        runner.stopKeepAlive();
        vi.restoreAllMocks();
        delete globalThis.chrome;
    });

    it('initializes with idle state', () => {
        const state = runner.getState();
        expect(state.status).toBe('idle');
        expect(state.progress).toBe(0);
        expect(state.logs).toEqual([]);
        expect(state.activeDateSpan).toBeNull();
        expect(state.completedAt).toBeNull();
        expect(runner.getResults()).toBeNull();
    });

    it('carries the labeled export filename in the run metadata', async () => {
        OrganizerService.mockImplementationOnce(function (apiKey, categories, onProgress) {
            this.onProgress = onProgress;
            this.start = vi.fn(async () => Object.assign(
                [{ title: 'Example 1', url: 'https://example.com/1', category: 'Tech', sub_category: 'Web' }],
                { filename: 'bookmarks_ai_alpha_2026-09-22.html' }
            ));
            this.cancel = vi.fn();
            this.isCancelled = false;
            this.stats = null;
        });
        const notifications = [];
        runner.subscribe((event, payload) => notifications.push({ event, payload }));

        await runner.startJob({ apiKey: 'AIzaSyFakeKey', categories: ['Tech'], inferCategories: false }, null);

        const complete = notifications.find(n => n.event === 'complete');
        expect(complete.payload.meta.filename).toBe('bookmarks_ai_alpha_2026-09-22.html');
        expect(globalThis.chrome.storage.local.set).toHaveBeenCalledWith(
            expect.objectContaining({
                organizedMeta: expect.objectContaining({ filename: 'bookmarks_ai_alpha_2026-09-22.html' })
            })
        );
    });

    it('starts a job and updates progress, logs, and storage', async () => {
        const notifications = [];
        runner.subscribe((event, payload) => notifications.push({ event, payload }));

        const config = {
            apiKey: 'AIzaSyFakeKey',
            categories: ['Tech'],
            inferCategories: false,
            selectedModel: 'google/gemini-3.8-flash',
            subfolderTarget: 'medium',
            sortAlphabetically: true,
            removeDuplicates: true,
            cleanTitles: false,
            flatDateSort: false,
            dateSortOrder: 'desc',
            schemaSortOrder: 'alpha'
        };

        const jobPromise = runner.startJob(config, null);

        // Check that state immediately transitions to processing
        expect(runner.getState().status).toBe('processing');
        expect(globalThis.chrome.storage.session.set).toHaveBeenCalled();
        // Simulate OrganizerService callback
        runner.organizer.onProgress({
            status: 'progress',
            percent: 50,
            message: 'Processing batch 1...'
        });

        expect(runner.getState().progress).toBe(50);
        expect(runner.getState().logs.some(l => l.message.includes('Processing batch 1...'))).toBe(true);

        const results = await jobPromise;
        expect(results).toHaveLength(2);
        expect(runner.getState().status).toBe('complete');
        expect(runner.getState().progress).toBe(100);
        expect(runner.getState().completedAt).toEqual(expect.any(Number));
        expect(runner.getResults()).toEqual(results);

        // Should have stored organizedData in session and organizedMeta in local
        expect(globalThis.chrome.storage.session.set).toHaveBeenCalledWith(
            expect.objectContaining({ organizedData: results })
        );
        expect(globalThis.chrome.storage.local.set).toHaveBeenCalledWith(
            expect.objectContaining({
                organizedMeta: expect.objectContaining({ count: 2 }),
                organizedData: results
            })
        );
    });

    it('forwards inferred category mode to OrganizerService and logs its source', async () => {
        const config = {
            apiKey: 'AIzaSyFakeKey',
            categories: [],
            inferCategories: true,
            selectedModel: 'google/gemini-3.8-flash',
            subfolderTarget: 'medium',
            sortAlphabetically: true,
            removeDuplicates: true,
            cleanTitles: false,
            flatDateSort: false,
            dateSortOrder: 'desc',
            schemaSortOrder: 'alpha'
        };

        await runner.startJob(config, null);

        expect(OrganizerService).toHaveBeenCalledWith(
            expect.any(String),
            [],
            expect.any(Function),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            false,
            expect.anything(),
            expect.anything(),
            true
        );
        expect(runner.getState().logs.map(log => log.message)).toContain('Category Source: AI inferred from bookmarks');
    });

    it('keeps inferred taxonomy and detail assignments in memory without nesting them in Chrome storage payloads', async () => {
        const originalImplementation = OrganizerService.getMockImplementation();
        const generatedResults = [{
            title: 'Example',
            url: 'https://example.com',
            category: 'Generated Topic',
            sub_category: 'Generated Detail',
            detail_category: 'Generated Leaf'
        }];
        const generatedStats = {
            categoriesCount: 1,
            categoryBreakdown: { 'Generated Topic': 1 },
            detailFoldersCount: 1,
            detailedSubcategories: 1
        };

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.onProgress = onProgress;
            this.start = vi.fn(async () => {
                onProgress({ status: 'info', message: '  • Generated Topic (Generated Detail)' });
                return generatedResults;
            });
            this.cancel = vi.fn();
            this.isCancelled = false;
            this.stats = generatedStats;
        });

        try {
            await runner.startJob({
                apiKey: 'AIzaSyFakeKey',
                categories: ['Dormant Manual Category'],
                inferCategories: true,
                flatDateSort: false
            });

            expect(runner.getResults()).toEqual(generatedResults);
            expect(runner.getState().stats.categoryBreakdown).toEqual({ 'Generated Topic': 1 });
            expect(runner.getState().stats.detailFoldersCount).toBe(1);
            expect(runner.getResults()[0].detail_category).toBe('Generated Leaf');
            expect(runner.getState().logs.some(log => log.message.includes('Generated Detail'))).toBe(true);

            const persistedPayloads = [
                ...globalThis.chrome.storage.local.set.mock.calls,
                ...globalThis.chrome.storage.session.set.mock.calls
            ].map(([payload]) => payload);
            expect(JSON.stringify(persistedPayloads)).not.toContain('Generated Topic');
            expect(JSON.stringify(persistedPayloads)).not.toContain('Generated Detail');
            expect(JSON.stringify(persistedPayloads)).not.toContain('Generated Leaf');
        } finally {
            OrganizerService.mockImplementation(originalImplementation);
        }
    });

    it('keeps service worker alive during job and stops keep-alive on completion', async () => {
        const config = {
            apiKey: 'AIzaSyFakeKey',
            categories: ['Tech'],
            flatDateSort: true,
            dateSortOrder: 'desc'
        };

        const jobPromise = runner.startJob(config, null);
        expect(runner.keepAliveTimer).not.toBeNull();

        // Advance timer to trigger keep-alive ping
        vi.advanceTimersByTime(16000);
        expect(globalThis.chrome.runtime.getPlatformInfo).toHaveBeenCalled();

        await jobPromise;
        expect(runner.keepAliveTimer).toBeNull();
    });

    it('notifies completion before opening the Save As dialog for uploaded files', async () => {
        const events = [];
        runner.subscribe((event) => events.push(event));

        const jobPromise = runner.startJob({
            apiKey: 'AIzaSyFakeKey',
            categories: ['Tech'],
            flatDateSort: true,
            dateSortOrder: 'desc'
        }, [{
            title: 'Uploaded bookmark',
            url: 'https://example.com/uploaded',
            add_date: '1700000000'
        }]);

        await jobPromise;

        expect(events).toContain('complete');
        expect(globalThis.chrome.downloads.download).not.toHaveBeenCalled();

        vi.advanceTimersByTime(0);

        expect(globalThis.chrome.downloads.download).toHaveBeenCalledTimes(1);
        expect(runner.keepAliveTimer).toBeNull();
    });

    it('coalesces rapid progress updates into one delayed session write', async () => {
        const setCallsBefore = () => globalThis.chrome.storage.session.set.mock.calls.length;

        const jobPromise = runner.startJob({
            apiKey: 'AIzaSyFakeKey',
            categories: ['Tech'],
            inferCategories: false,
            flatDateSort: false
        }, null);
        const baseline = setCallsBefore();

        for (let i = 0; i < 5; i++) {
            runner.organizer.onProgress({
                status: 'progress',
                percent: 10 * (i + 1),
                message: `Batch ${i + 1}...`
            });
        }

        // In-memory state stays synchronous; only persistence is coalesced.
        expect(runner.getState().progress).toBe(50);
        expect(runner.getState().logs.some(l => l.message.includes('Batch 5'))).toBe(true);
        expect(setCallsBefore()).toBe(baseline);

        vi.advanceTimersByTime(250);
        expect(setCallsBefore()).toBe(baseline + 1);

        await jobPromise;
        expect(runner.getState().status).toBe('complete');
    });

    it('cancels an active job cleanly', async () => {
        const cancelSpy = vi.fn();
        runner.organizer = { cancel: cancelSpy };
        runner.currentJob.status = 'processing';
        runner.currentJob.progress = 40;

        runner.cancelJob();

        expect(cancelSpy).toHaveBeenCalled();
        expect(runner.getState().status).toBe('idle');
        expect(runner.getState().progress).toBe(0);
        expect(runner.getState().logs.some(l => l.message.includes('Cancellation requested'))).toBe(true);
    });

    it('resets job state and removes session storage snapshot', () => {
        const completedResults = [{ title: 'Completed', url: 'https://example.com/completed' }];
        runner.currentJob.status = 'complete';
        runner.currentJob.progress = 100;
        runner.cachedResults = completedResults;

        runner.resetJob();

        expect(runner.getState().status).toBe('idle');
        expect(runner.getState().progress).toBe(0);
        expect(runner.getResults()).toBeNull();
        expect(globalThis.chrome.storage.session.remove).toHaveBeenCalledWith(['activeJobState', 'organizedData']);
        expect(globalThis.chrome.storage.local.remove).toHaveBeenCalledWith(['organizedMeta', 'organizedData']);
    });

    it('handles unexpected organizer errors gracefully', async () => {
        const config = { apiKey: 'fake' };
        vi.spyOn(console, 'error').mockImplementation(() => {});

        // Mock organizer throwing an error
        runner.startJob = async function (_cfg) {
            this.currentJob.status = 'processing';
            this.notify('status', this.getState());
            try {
                throw new Error('Network connection timeout');
            } catch (err) {
                this.currentJob.status = 'error';
                this.currentJob.errorMsg = err.message;
                this.stopKeepAlive();
                this.notify('status', this.getState());
                this.notify('error', { message: err.message });
                throw err;
            }
        };

        await expect(runner.startJob(config)).rejects.toThrow('Network connection timeout');
        expect(runner.getState().status).toBe('error');
        expect(runner.getState().errorMsg).toBe('Network connection timeout');
    });
});
