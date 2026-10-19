import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackgroundJobRunner } from './jobRunner';
import { OrganizerService } from '../services/organizer';

// The job runner's gates and the organizer's real reviewPlan / reviewResult, wired together the way
// startJob installs them. Only the AI work is replaced: the stand-in start() calls the two real
// methods around fixed data, so no network or bookmark API is involved.
vi.mock('../services/organizer', async (importActual) => {
    const actual = await importActual();
    const real = actual.OrganizerService.prototype;
    return {
        ...actual,
        OrganizerService: vi.fn(function (apiKey, categories, onProgress) {
            this.onProgress = onProgress;
            this.cancel = vi.fn();
            this.isCancelled = false;
            this.cancelled = () => null;
            this.stats = { detailFoldersCount: 0, detailedSubcategories: 0 };
            this.designSchema = vi.fn(async () => ({ categories: [{ name: 'Tech', sub_categories: ['Web'] }] }));
            this.reviewPlan = real.reviewPlan;
            this.reviewResult = real.reviewResult;
            this.start = vi.fn(async () => {
                const schema = await this.reviewPlan([], await this.designSchema([]));
                if (!schema) return null;
                this.approvedSchema = schema;
                const classified = [
                    { title: 'A', url: 'https://example.com/a', category: 'Tech', sub_category: 'Web', detail_category: null },
                    { title: 'B', url: 'https://example.com/b', category: 'Travel', sub_category: 'Flights', detail_category: null }
                ];
                const final = await this.reviewResult(classified);
                this.finalRecords = final;
                return final;
            });
        })
    };
});

describe('review flow through the job runner with the real review gates', () => {
    let runner;
    let organizer;

    beforeEach(() => {
        vi.useFakeTimers();
        OrganizerService.mockClear();
        globalThis.chrome = {
            runtime: { getPlatformInfo: vi.fn((cb) => cb && cb({ os: 'mac' })), lastError: null },
            storage: {
                session: { get: vi.fn((keys, cb) => cb && cb({})), set: vi.fn((data, cb) => cb && cb()), remove: vi.fn((keys, cb) => cb && cb()) },
                local: { get: vi.fn((keys, cb) => cb && cb({})), set: vi.fn((data, cb) => cb && cb()), remove: vi.fn((keys, cb) => cb && cb()) }
            },
            notifications: { create: vi.fn(), clear: vi.fn() }
        };
        runner = new BackgroundJobRunner();
        const construct = OrganizerService.getMockImplementation();
        OrganizerService.mockImplementation(function (...args) {
            construct.apply(this, args);
            organizer = this;
        });
    });

    afterEach(() => {
        runner.stopKeepAlive?.();
        vi.useRealTimers();
        delete globalThis.chrome;
    });

    it('approves an edited plan as binding, then applies result edits to the finished folders', async () => {
        const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
        await vi.advanceTimersByTimeAsync(0);
        expect(runner.getState().plan).toEqual({ categories: [{ name: 'Tech', sub_categories: ['Web'] }] });

        runner.resolvePlan('approve', { categories: [{ name: ' Technology ', sub_categories: ['Web', 'Data'] }] });
        await vi.advanceTimersByTimeAsync(0);
        expect(organizer.approvedSchema.binding).toBe(true);
        expect(organizer.approvedSchema.categories.map(c => c.name)).toEqual(['Technology']);

        expect(runner.getState().result.rows).toEqual([
            { category: 'Tech', sub_category: 'Web', detail_category: null, count: 1 },
            { category: 'Travel', sub_category: 'Flights', detail_category: null, count: 1 }
        ]);
        runner.resolveResult('approve', [{ op: 'rename', path: ['Travel'], to: 'Trips' }]);
        await job;

        expect(organizer.finalRecords.map(r => r.category)).toEqual(['Tech', 'Trips']);
        expect(runner.getState().status).toBe('complete');
    });

    it('re-asks with the reason when the edits do not apply, then accepts a valid answer', async () => {
        const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
        await vi.advanceTimersByTimeAsync(0);
        runner.resolvePlan('approve');
        await vi.advanceTimersByTimeAsync(0);

        runner.resolveResult('approve', [{ op: 'rename', path: ['Nope'], to: 'Else' }]);
        await vi.advanceTimersByTimeAsync(0);
        expect(runner.getState().result.error).toMatch(/Nope.*no longer exists/);
        expect(runner.getState().status).toBe('processing');

        runner.resolveResult('approve');
        await job;
        expect(organizer.finalRecords.map(r => r.category)).toEqual(['Tech', 'Travel']);
        expect(runner.getState().status).toBe('complete');
    });

    it('cancelling at the result review stops the run without results', async () => {
        const job = runner.startJob({ apiKey: 'k', reviewFolders: true }, null);
        await vi.advanceTimersByTimeAsync(0);
        runner.resolvePlan('approve');
        await vi.advanceTimersByTimeAsync(0);

        runner.resolveResult('cancel');
        await job;

        expect(organizer.finalRecords).toBeNull();
        expect(runner.getState().result).toBeNull();
    });
});
