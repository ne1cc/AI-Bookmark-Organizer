import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupSidePanel, getConnectedPortCount } from './index';
import { jobRunner } from './jobRunner';

describe('Background Service Worker Entry Point', () => {
    beforeEach(() => {
        globalThis.chrome = {
            sidePanel: {
                setPanelBehavior: vi.fn().mockResolvedValue(),
                open: vi.fn().mockResolvedValue()
            },
            windows: {
                getCurrent: vi.fn((cb) => cb && cb({ id: 123 }))
            },
            runtime: {
                onConnect: {
                    addListener: vi.fn()
                },
                onInstalled: {
                    addListener: vi.fn()
                },
                onStartup: {
                    addListener: vi.fn()
                },
                getPlatformInfo: vi.fn((cb) => cb && cb({ os: 'mac' })),
                lastError: null
            },
            notifications: {
                create: vi.fn((id, opts, cb) => cb && cb(id)),
                clear: vi.fn((id, cb) => cb && cb()),
                onClicked: {
                    addListener: vi.fn()
                }
            },
            storage: {
                session: {
                    set: vi.fn(),
                    remove: vi.fn()
                },
                local: {
                    remove: vi.fn()
                }
            }
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.chrome;
    });

    it('sets up side panel behavior on action click', async () => {
        setupSidePanel();
        expect(globalThis.chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
            openPanelOnActionClick: true
        });
    });

    it('triggers desktop notification when job completes and side panel is closed (no connected ports)', () => {
        expect(getConnectedPortCount()).toBe(0);

        jobRunner.notify('complete', {
            meta: { count: 42 },
            results: [{ id: '1' }]
        });

        expect(globalThis.chrome.notifications.create).toHaveBeenCalledWith(
            'organizer-job-complete',
            expect.objectContaining({
                title: 'AI Bookmark Organizer',
                message: expect.stringContaining('42 bookmarks ready to review and download')
            }),
            expect.any(Function)
        );
    });

    it('opens side panel when organizer notification is clicked', () => {
        // Re-trigger notification click handler logic
        if (typeof globalThis.chrome.notifications.onClicked.addListener === 'function') {
            const clickHandler = (notificationId) => {
                if (notificationId.startsWith('organizer-job')) {
                    if (globalThis.chrome.sidePanel?.open && globalThis.chrome.windows?.getCurrent) {
                        globalThis.chrome.windows.getCurrent((win) => {
                            if (win?.id) {
                                globalThis.chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
                            }
                        });
                    }
                    globalThis.chrome.notifications.clear(notificationId, () => {});
                }
            };

            clickHandler('organizer-job-complete');
            expect(globalThis.chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 123 });
            expect(globalThis.chrome.notifications.clear).toHaveBeenCalledWith('organizer-job-complete', expect.any(Function));
        }
    });

    it('acknowledges START_JOB and reports start failures over the port', async () => {
        vi.resetModules();
        let onConnectHandler = null;
        globalThis.chrome.runtime.onConnect.addListener = vi.fn((fn) => { onConnectHandler = fn; });

        await import('./index');
        const { jobRunner: freshRunner } = await import('./jobRunner');
        expect(onConnectHandler).toBeTruthy();

        const port = {
            name: 'organizer-channel',
            postMessage: vi.fn(),
            onMessage: { addListener: vi.fn() },
            onDisconnect: { addListener: vi.fn() }
        };
        onConnectHandler(port);
        const startHandler = port.onMessage.addListener.mock.calls[0][0];

        const startSpy = vi.spyOn(freshRunner, 'startJob')
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('boom'));

        // Success path: JOB_ACK is posted immediately on receipt, before the
        // run starts, so the panel can tell a live worker from a dead port.
        const inferredConfig = { apiKey: 'k', categories: [], inferCategories: true };
        startHandler({ type: 'START_JOB', payload: { config: inferredConfig, parsedBookmarks: null } });
        expect(port.postMessage).toHaveBeenCalledWith({ type: 'JOB_ACK', payload: {} });
        await vi.waitFor(() => expect(startSpy).toHaveBeenCalledWith(inferredConfig, null));

        // Failure path: start failures surface as JOB_ERROR in the panel
        // instead of dying silently in the worker console.
        port.postMessage.mockClear();
        startHandler({ type: 'START_JOB', payload: { config: {}, parsedBookmarks: null } });
        expect(port.postMessage).toHaveBeenCalledWith({ type: 'JOB_ACK', payload: {} });
        await vi.waitFor(() => {
            expect(port.postMessage).toHaveBeenCalledWith({ type: 'JOB_ERROR', payload: { message: 'boom' } });
        });

        startSpy.mockRestore();
    });

    it('returns completed results from jobRunner memory without writing them to storage', async () => {
        vi.resetModules();
        let onConnectHandler = null;
        globalThis.chrome.runtime.onConnect.addListener = vi.fn((fn) => { onConnectHandler = fn; });

        await import('./index');
        const { jobRunner: freshRunner } = await import('./jobRunner');
        const results = [{
            title: 'Generated result',
            url: 'https://example.com/generated',
            category: 'Generated Topic',
            sub_category: 'Generated Detail'
        }];
        const state = {
            id: 'job_123',
            status: 'complete',
            count: 1,
            completedAt: 1757890000000,
            stats: { categoriesCount: 1, categoryBreakdown: { 'Generated Topic': 1 } },
            activeDateSpan: '1/1/2024 – 2/1/2024'
        };
        const getResultsSpy = vi.spyOn(freshRunner, 'getResults').mockReturnValue(results);
        vi.spyOn(freshRunner, 'getState').mockReturnValue(state);

        const port = {
            name: 'organizer-channel',
            postMessage: vi.fn(),
            onMessage: { addListener: vi.fn() },
            onDisconnect: { addListener: vi.fn() }
        };
        onConnectHandler(port);
        port.postMessage.mockClear();

        const messageHandler = port.onMessage.addListener.mock.calls[0][0];
        messageHandler({ type: 'GET_RESULTS' });

        expect(getResultsSpy).toHaveBeenCalledOnce();
        expect(port.postMessage).toHaveBeenCalledWith({
            type: 'JOB_RESULTS',
            payload: {
                results,
                meta: {
                    count: 1,
                    savedAt: 1757890000000,
                    stats: state.stats,
                    dateSpan: '1/1/2024 – 2/1/2024'
                }
            }
        });
        expect(globalThis.chrome.storage.session.set).not.toHaveBeenCalled();
    });
});
