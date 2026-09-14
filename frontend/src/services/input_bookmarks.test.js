import { describe, it, expect, vi, afterEach } from 'vitest'
import {
    saveInputBookmarkFile,
    getInputBookmarkFile,
    getInputBookmarkFiles,
    removeInputBookmarkFile,
    downloadInputBookmarkFile,
    INPUT_MAX_BYTES,
    MAX_CACHED_INPUTS
} from './input_bookmarks'

const htmlOf = (n) => `<!DOCTYPE NETSCAPE-Bookmark-file-1>${'<DT><A HREF="https://x.com">x</A>'.repeat(n)}`

describe('input bookmarks cache', () => {
    afterEach(() => { delete global.chrome })

    it('saves raw HTML byte-for-byte with metadata in an array of cached inputs', async () => {
        let storedData = {}
        const setSpy = vi.fn((payload, cb) => {
            storedData = { ...storedData, ...payload }
            cb()
        })
        const getSpy = vi.fn((keys, cb) => cb(storedData))
        global.chrome = { runtime: {}, storage: { local: { set: setSpy, get: getSpy, remove: vi.fn() } } }

        const html = htmlOf(3)
        const res = await saveInputBookmarkFile({ filename: 'bookmarks.html', html, count: 3, dateSpan: '1/1/2020 – 2/2/2026' })
        expect(res.saved).toBe(true)
        expect(setSpy).toHaveBeenCalledTimes(1)

        const entries = storedData.inputBookmarks
        expect(Array.isArray(entries)).toBe(true)
        expect(entries).toHaveLength(1)
        expect(entries[0].html).toBe(html)
        expect(entries[0].filename).toBe('bookmarks.html')
        expect(entries[0].count).toBe(3)
        expect(entries[0].dateSpan).toBe('1/1/2020 – 2/2/2026')
        expect(typeof entries[0].savedAt).toBe('number')
        expect(typeof entries[0].id).toBe('string')
    })

    it('caches multiple inputs up to 3, keeping latest first and discarding oldest', async () => {
        let storedData = {}
        const setSpy = vi.fn((payload, cb) => {
            storedData = { ...storedData, ...payload }
            cb()
        })
        const getSpy = vi.fn((keys, cb) => cb(storedData))
        global.chrome = { runtime: {}, storage: { local: { set: setSpy, get: getSpy, remove: vi.fn() } } }

        await saveInputBookmarkFile({ filename: 'file1.html', html: htmlOf(1), count: 1, dateSpan: null })
        await saveInputBookmarkFile({ filename: 'file2.html', html: htmlOf(2), count: 2, dateSpan: null })
        await saveInputBookmarkFile({ filename: 'file3.html', html: htmlOf(3), count: 3, dateSpan: null })

        let files = await getInputBookmarkFiles()
        expect(files).toHaveLength(3)
        expect(files.map(f => f.filename)).toEqual(['file3.html', 'file2.html', 'file1.html'])

        // 4th file pushes out the oldest ('file1.html')
        await saveInputBookmarkFile({ filename: 'file4.html', html: htmlOf(4), count: 4, dateSpan: null })
        files = await getInputBookmarkFiles()
        expect(files).toHaveLength(MAX_CACHED_INPUTS)
        expect(files.map(f => f.filename)).toEqual(['file4.html', 'file3.html', 'file2.html'])
    })

    it('refreshes existing file position to top when re-saved with same name and content', async () => {
        let storedData = {}
        const setSpy = vi.fn((payload, cb) => {
            storedData = { ...storedData, ...payload }
            cb()
        })
        const getSpy = vi.fn((keys, cb) => cb(storedData))
        global.chrome = { runtime: {}, storage: { local: { set: setSpy, get: getSpy, remove: vi.fn() } } }

        await saveInputBookmarkFile({ filename: 'file1.html', html: htmlOf(1), count: 1, dateSpan: null })
        await saveInputBookmarkFile({ filename: 'file2.html', html: htmlOf(2), count: 2, dateSpan: null })

        // Re-saving file1 moves it to top
        await saveInputBookmarkFile({ filename: 'file1.html', html: htmlOf(1), count: 1, dateSpan: null })
        const files = await getInputBookmarkFiles()
        expect(files).toHaveLength(2)
        expect(files[0].filename).toBe('file1.html')
        expect(files[1].filename).toBe('file2.html')
    })

    it('refuses entries above INPUT_MAX_BYTES without throwing', async () => {
        global.chrome = { runtime: {}, storage: { local: { set: vi.fn(), get: vi.fn((k, cb) => cb({})), remove: vi.fn() } } }
        const res = await saveInputBookmarkFile({ filename: 'huge.html', html: 'x'.repeat(INPUT_MAX_BYTES + 1), count: 1, dateSpan: null })
        expect(res.saved).toBe(false)
        expect(res.reason).toBe('too-large')
    })

    it('migrates legacy single-object format from storage seamlessly', async () => {
        const legacyEntry = { filename: 'legacy.html', html: '<x/>', size: 4, savedAt: 123, count: 1, dateSpan: null }
        global.chrome = {
            runtime: {},
            storage: {
                local: {
                    set: vi.fn((p, cb) => cb()),
                    get: vi.fn((k, cb) => cb({ inputBookmarks: legacyEntry })),
                    remove: vi.fn((k, cb) => cb())
                }
            }
        }

        const files = await getInputBookmarkFiles()
        expect(files).toHaveLength(1)
        expect(files[0]).toEqual(legacyEntry)

        const latest = await getInputBookmarkFile()
        expect(latest).toEqual(legacyEntry)
    })

    it('removes a specific entry by id or filename while preserving others', async () => {
        const e1 = { id: 'id-1', filename: 'file1.html', html: '<1/>', size: 4, savedAt: 100, count: 1, dateSpan: null }
        const e2 = { id: 'id-2', filename: 'file2.html', html: '<2/>', size: 4, savedAt: 200, count: 2, dateSpan: null }
        let stored = { inputBookmarks: [e2, e1] }

        const setSpy = vi.fn((p, cb) => { stored = { ...stored, ...p }; cb() })
        const getSpy = vi.fn((k, cb) => cb(stored))
        const removeSpy = vi.fn((k, cb) => { delete stored.inputBookmarks; cb() })

        global.chrome = { runtime: {}, storage: { local: { set: setSpy, get: getSpy, remove: removeSpy } } }

        // Remove e2 by id
        const remaining = await removeInputBookmarkFile('id-2')
        expect(remaining).toHaveLength(1)
        expect(remaining[0].id).toBe('id-1')

        // Remove e1 (last entry) calls remove from storage
        await removeInputBookmarkFile('id-1')
        expect(removeSpy).toHaveBeenCalledWith(['inputBookmarks'], expect.any(Function))
    })

    it('removes all entries when called without id', async () => {
        const removeSpy = vi.fn((k, cb) => cb())
        global.chrome = { runtime: {}, storage: { local: { get: vi.fn(), set: vi.fn(), remove: removeSpy } } }

        await removeInputBookmarkFile()
        expect(removeSpy).toHaveBeenCalledWith(['inputBookmarks'], expect.any(Function))
    })
})
