import { describe, it, expect, vi, afterEach } from 'vitest'
import { createStorageSnapshotProvider } from './snapshotProvider'
import { downloadBookmarks } from '../services/bookmarks_export'

vi.mock('../services/bookmarks_export', () => ({ downloadBookmarks: vi.fn(() => Promise.resolve({ status: 'started' })) }))

describe('createStorageSnapshotProvider', () => {
    afterEach(() => { delete global.chrome })

    it('persists survivors plus doomed duplicates as add_date entries', async () => {
        const setSpy = vi.fn((payload, cb) => cb())
        global.chrome = { runtime: {}, storage: { local: { set: setSpy } } }
        const provider = createStorageSnapshotProvider()
        await provider(
            [{ title: 'A', url: 'https://a.com', dateAdded: 1500000000000, id: '10' }],
            [{ title: 'A mid', url: 'https://a.com', dateAdded: 1600000000000, id: '12' }]
        )
        expect(setSpy).toHaveBeenCalledTimes(1)
        const [payload] = setSpy.mock.calls[0]
        expect(payload.preWriteBackup.count).toBe(2)
        expect(payload.preWriteBackup.items).toEqual([
            { title: 'A', url: 'https://a.com', add_date: '1500000000' },
            { title: 'A mid', url: 'https://a.com', add_date: '1600000000' }
        ])
    })

    it('skips persistence above the 8 MB bound and logs instead', async () => {
        const setSpy = vi.fn((payload, cb) => cb())
        global.chrome = { storage: { local: { set: setSpy } } }
        const logs = []
        const provider = createStorageSnapshotProvider((m) => logs.push(m))
        const big = { title: 'x', url: `https://big.com/${'a'.repeat(3 * 1024 * 1024)}`, dateAdded: 1 }
        await provider([big, big, big], [])
        expect(setSpy).not.toHaveBeenCalled()
        expect(logs.some(m => m.includes('backup skipped'))).toBe(true)
    })

    it('downloads an HTML backup of every bookmark without a Save As dialog', async () => {
        global.chrome = { runtime: {}, storage: { local: { set: vi.fn((p, cb) => cb()) } } }
        await createStorageSnapshotProvider()([{ title: 'A', url: 'https://a.com' }], [{ title: 'B', url: 'https://a.com' }])
        const [items, filename, options] = downloadBookmarks.mock.calls.at(-1)
        expect(items).toHaveLength(2)
        expect(filename).toMatch(/^bookmarks_backup_\d{4}-\d{2}-\d{2}\.html$/)
        expect(options).toEqual({ saveAs: false })
    })

    it('logs a failed download and still writes the storage backup', async () => {
        downloadBookmarks.mockRejectedValueOnce(new Error('blocked'))
        const setSpy = vi.fn((p, cb) => cb())
        global.chrome = { runtime: {}, storage: { local: { set: setSpy } } }
        const logs = []
        await createStorageSnapshotProvider((m) => logs.push(m))([{ title: 'A', url: 'https://a.com' }], [])
        expect(logs.some(m => m.includes('blocked'))).toBe(true)
        expect(setSpy).toHaveBeenCalledTimes(1)
    })

    it('rejects when storage.local.set fails', async () => {
        global.chrome = { runtime: {}, storage: { local: { set: vi.fn((p, cb) => { global.chrome.runtime.lastError = { message: 'quota' }; cb(); }) } } }
        const provider = createStorageSnapshotProvider()
        await expect(provider([], [])).rejects.toThrow('quota')
    })
})
