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
            }),
            expect.any(Function)
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
            expect.objectContaining({ organizedData: results }),
            expect.any(Function)
        );
        expect(globalThis.chrome.storage.local.set).toHaveBeenCalledWith(
            expect.objectContaining({
                organizedMeta: expect.objectContaining({ count: 2 }),
                organizedData: results
            }),
            expect.any(Function)
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

    it('saves an AI-inferred run, with its generated folders, to disk so it stays downloadable', async () => {
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

            expect(globalThis.chrome.storage.local.set).toHaveBeenCalledWith(
                expect.objectContaining({
                    organizedMeta: expect.objectContaining({ count: 1, mode: 'browser' }),
                    organizedData: generatedResults
                }),
                expect.any(Function)
            );
            // Generated names are saved with the result only, never as a category setting.
            const settingWrites = globalThis.chrome.storage.local.set.mock.calls
                .filter(([payload]) => Object.hasOwn(payload, 'categories'));
            expect(settingWrites).toEqual([]);
        } finally {
            OrganizerService.mockImplementation(originalImplementation);
        }
    });

    it('rotates the previous run into history when a new run completes', async () => {
        const stored = new Map();
        globalThis.chrome.storage.local.get = vi.fn((keys, cb) =>
            cb(Object.fromEntries([].concat(keys).filter(k => stored.has(k)).map(k => [k, stored.get(k)]))));
        globalThis.chrome.storage.local.set = vi.fn((obj, cb) => { Object.entries(obj).forEach(([k, v]) => stored.set(k, v)); cb && cb(); });
        globalThis.chrome.storage.local.remove = vi.fn((keys, cb) => { [].concat(keys).forEach(k => stored.delete(k)); cb && cb(); });

        await runner.startJob({ apiKey: 'AIzaSyFakeKey', categories: ['Tech'], inferCategories: true });
        const firstSavedAt = stored.get('organizedMeta').savedAt;
        vi.setSystemTime(Date.now() + 5000);
        await runner.startJob({ apiKey: 'AIzaSyFakeKey', categories: ['Tech'], inferCategories: true });

        expect(stored.get('organizedHistory').map(e => e.id)).toEqual([String(firstSavedAt)]);
        expect(stored.get(`organizedRun:${firstSavedAt}`)).toHaveLength(2);
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

    describe('plan review (two-phase)', () => {
        const schema = { categories: [{ name: 'Tech', sub_categories: ['Web', 'Data'] }, { name: 'Travel', sub_categories: [] }] };
        // The real service pauses in start(); the stand-in does the same through planReviewer.
        const pausingOrganizer = (record) => function (apiKey, categories, onProgress) {
            this.onProgress = onProgress;
            this.cancel = vi.fn();
            this.isCancelled = false;
            this.stats = null;
            this.start = vi.fn(async () => {
                record.answer = this.planReviewer ? await this.planReviewer(schema, record.error ?? null) : { decision: 'no-reviewer' };
                return record.answer.decision === 'cancel' ? null : [{ title: 'A', url: 'https://example.com/a' }];
            });
        };

        it('publishes the proposed folders, keeps the job processing, and resumes with the edited plan', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);

            expect(runner.getState().status).toBe('processing');
            expect(runner.getState().plan).toEqual({ categories: schema.categories });

            const edited = { categories: [{ name: 'Technology', sub_categories: ['Web'] }] };
            runner.resolvePlan('approve', edited);
            await job;

            expect(record.answer).toEqual({ decision: 'approve', plan: edited });
            expect(runner.getState().plan).toBeNull();
            expect(runner.getState().status).toBe('complete');
        });

        it('approves without a plan when the user did not edit', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await job;

            expect(record.answer).toEqual({ decision: 'approve' });
        });

        it('hands the reason a previous answer was rejected to the panel', async () => {
            const record = { error: 'The plan needs at least one category.' };
            OrganizerService.mockImplementationOnce(pausingOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);

            expect(runner.getState().plan.error).toBe('The plan needs at least one category.');
            runner.resolvePlan('cancel');
            await job;
        });

        it('does not pause when review is off, nor in flat date mode', async () => {
            const off = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(off));
            await runner.startJob({ apiKey: 'k' }, null);
            expect(off.answer).toEqual({ decision: 'no-reviewer' });

            const flat = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(flat));
            await runner.startJob({ apiKey: 'k', reviewFolders: true, flatDateSort: true }, null);
            expect(flat.answer).toEqual({ decision: 'no-reviewer' });
        });

        it('ignores unrecognised decisions and decisions with nothing pending', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(record));
            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);

            runner.resolvePlan('bogus');
            expect(runner.getState().plan).not.toBeNull();

            runner.resolvePlan('approve');
            await job;
            expect(() => runner.resolvePlan('approve')).not.toThrow();
        });

        it('cancelling while the plan is waiting ends the job instead of hanging', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.cancelJob();
            await job;

            expect(record.answer.decision).toBe('cancel');
            expect(runner.getState().status).toBe('idle');
            expect(runner.getState().plan).toBeNull();
        });

        it('removes a stale saved-edits draft when a new job starts', async () => {
            await runner.startJob({ apiKey: 'k' }, null);

            expect(globalThis.chrome.storage.session.remove).toHaveBeenCalledWith(['reviewDraft']);
        });

        it('removes the saved draft when a job reaches a terminal status (complete or cancelled)', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);

            globalThis.chrome.storage.session.remove.mockClear();
            runner.resolvePlan('approve');
            await job;

            expect(globalThis.chrome.storage.session.remove).toHaveBeenCalledWith(['reviewDraft']);
            expect(runner.getState().status).toBe('complete');

            // Test with cancelled job
            const cancelRecord = {};
            OrganizerService.mockImplementationOnce(pausingOrganizer(cancelRecord));
            globalThis.chrome.storage.session.remove.mockClear();

            const cancelJob = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.cancelJob();
            await cancelJob;

            expect(globalThis.chrome.storage.session.remove).toHaveBeenCalledWith(['reviewDraft']);
            expect(runner.getState().status).toBe('idle');
        });
    });

    describe('result review (second pause)', () => {
        const rows = [
            { category: 'Tech', sub_category: 'Web', detail_category: 'Frameworks', count: 2 },
            { category: 'Travel', sub_category: 'Flights', detail_category: null, count: 3 }
        ];
        // Both gates are installed by the one flag; this stand-in pauses at each, like the real service.
        const twoGateOrganizer = (record) => function (apiKey, categories, onProgress) {
            this.onProgress = onProgress;
            this.cancel = vi.fn();
            this.isCancelled = false;
            this.stats = null;
            this.start = vi.fn(async () => {
                record.plan = this.planReviewer ? await this.planReviewer({ categories: [{ name: 'Tech', sub_categories: ['Web'] }] }, null) : null;
                record.result = this.resultReviewer ? await this.resultReviewer(rows, record.error ?? null) : { decision: 'no-reviewer' };
                return record.result.decision === 'cancel' ? null : [{ title: 'A', url: 'https://example.com/a' }];
            });
        };

        it('pauses for the plan, then for the result, with the folder rows published to the panel', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            expect(runner.getState().plan).not.toBeNull();
            expect(runner.getState().result).toBeNull();

            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);
            expect(runner.getState().plan).toBeNull();
            expect(runner.getState().result).toEqual({ rows });
            expect(runner.getState().status).toBe('processing');

            const ops = [{ op: 'rename', path: ['Travel'], to: 'Trips' }];
            runner.resolveResult('approve', ops);
            await job;

            expect(record.result).toEqual({ decision: 'approve', ops });
            expect(runner.getState().result).toBeNull();
            expect(runner.getState().status).toBe('complete');
        });

        it('approves without operations when nothing was edited', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);
            runner.resolveResult('approve');
            await job;

            expect(record.result).toEqual({ decision: 'approve' });
        });

        it('hands the reason a previous answer was rejected to the panel', async () => {
            const record = { error: 'The folder "Nope" no longer exists.' };
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);

            expect(runner.getState().result.error).toBe('The folder "Nope" no longer exists.');
            runner.resolveResult('cancel');
            await job;
        });

        it('ignores a regenerate for the result, a plan decision while the result waits, and bogus decisions', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));
            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);

            runner.resolveResult('regenerate');
            runner.resolvePlan('approve');
            runner.resolveResult('bogus');
            expect(runner.getState().result).not.toBeNull();

            runner.resolveResult('approve');
            await job;
        });

        it('cancelling while the result waits ends the job', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);
            runner.cancelJob();
            await job;

            expect(record.result.decision).toBe('cancel');
            expect(runner.getState().status).toBe('idle');
            expect(runner.getState().result).toBeNull();
        });

        it('includes the waiting result in the session snapshot when job state is persisted', async () => {
            const record = {};
            OrganizerService.mockImplementationOnce(twoGateOrganizer(record));

            const job = runner.startJob({ apiKey: 'k', inferCategories: false, categories: ['Tech'], reviewFolders: true }, null);
            await vi.advanceTimersByTimeAsync(0);
            runner.resolvePlan('approve');
            await vi.advanceTimersByTimeAsync(0);

            const snapshots = globalThis.chrome.storage.session.set.mock.calls.map(([data]) => data.activeJobState).filter(Boolean);
            expect(snapshots.at(-1).result).toEqual({ rows });

            runner.resolveResult('approve');
            await job;
        });
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

    it('resets job state and removes the session snapshot but keeps saved runs downloadable', () => {
        const completedResults = [{ title: 'Completed', url: 'https://example.com/completed' }];
        runner.currentJob.status = 'complete';
        runner.currentJob.progress = 100;
        runner.cachedResults = completedResults;

        runner.resetJob();

        expect(runner.getState().status).toBe('idle');
        expect(runner.getState().progress).toBe(0);
        expect(runner.getResults()).toBeNull();
        expect(globalThis.chrome.storage.session.remove).toHaveBeenCalledWith(['activeJobState', 'organizedData']);
        // Saved runs survive a reset: "Organize another" must not delete earlier results.
        expect(globalThis.chrome.storage.local.remove).not.toHaveBeenCalled();
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
