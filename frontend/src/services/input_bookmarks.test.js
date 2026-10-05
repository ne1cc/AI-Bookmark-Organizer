import { describe, it, expect, vi, afterEach } from 'vitest'
import {
    saveInputBookmarkFile,
    getInputBookmarkMeta,
    getInputBookmarkHtml,
    getInputBookmarkFile,
    listInputBookmarkFiles,
    removeInputBookmarkFile,
    clearAllInputBookmarkFiles,
    downloadInputBookmarkFile,
    INPUT_MAX_BYTES
} from './input_bookmarks'

const htmlOf = (n) => `<!DOCTYPE NETSCAPE-Bookmark-file-1>${'<DT><A HREF="https://x.com">x</A>'.repeat(n)}`

describe('input bookmarks cache', () => {
    afterEach(() => { delete global.chrome })

    it('saves HTML and metadata under separate keys and drops the legacy entry', async () => {
        const setSpy = vi.fn((payload, cb) => cb())
        const removeSpy = vi.fn((keys, cb) => cb())
        global.chrome = { runtime: {}, storage: { local: { set: setSpy, get: vi.fn((k, cb) => cb({})), remove: removeSpy } } }
        const html = htmlOf(3)
        const res = await saveInputBookmarkFile({ filename: 'bookmarks.html', html, count: 3, dateSpan: '1/1/2020 – 2/2/2026' })
        expect(res.saved).toBe(true)
        expect(setSpy).toHaveBeenCalledTimes(1)
        const payload = setSpy.mock.calls[0][0]
        expect(payload.inputBookmarksHtml).toBe(html)
        expect(payload.inputBookmarksMeta).toEqual(expect.objectContaining({
            filename: 'bookmarks.html',
            count: 3,
            size: html.length
        }))
        expect(payload.inputBookmarksMeta.html).toBeUndefined()
        expect(payload.inputBookmarksList).toHaveLength(1)
        expect(payload[`inputBookmarkHtml:${res.entry.id}`]).toBe(html)
        expect(removeSpy).toHaveBeenCalledWith(['inputBookmarks'], expect.any(Function))
    })

    it('allows unlimited input bookmark files and large file sizes without refusal', async () => {
        const store = {}
        global.chrome = { runtime: {}, storage: { local: {
            set: vi.fn((p, cb) => { Object.assign(store, p); cb() }),
            get: vi.fn((keys, cb) => {
                const res = {}
                for (const k of [].concat(keys)) if (k in store) res[k] = store[k]
                cb(res)
            }),
            remove: vi.fn((keys, cb) => {
                for (const k of [].concat(keys)) delete store[k]
                cb()
            })
        } } }
        // 30MB file size simulation
        const largeHtml = 'x'.repeat(30 * 1024 * 1024)
        const res = await saveInputBookmarkFile({ filename: 'large_bookmarks.html', html: largeHtml, count: 50000, dateSpan: null })
        expect(res.saved).toBe(true)
        expect(res.entry.size).toBe(30 * 1024 * 1024)
    })

    it('supports multiple input bookmark files and individual deletion', async () => {
        const store = {}
        global.chrome = { runtime: {}, storage: { local: {
            set: vi.fn((p, cb) => { Object.assign(store, p); cb() }),
            get: vi.fn((keys, cb) => {
                const res = {}
                for (const k of [].concat(keys)) if (k in store) res[k] = store[k]
                cb(res)
            }),
            remove: vi.fn((keys, cb) => {
                for (const k of [].concat(keys)) delete store[k]
                cb()
            })
        } } }

        const file1 = await saveInputBookmarkFile({ filename: 'first.html', html: '<first/>', count: 10, dateSpan: '2023' })
        const file2 = await saveInputBookmarkFile({ filename: 'second.html', html: '<second/>', count: 20, dateSpan: '2024' })

        const list = await listInputBookmarkFiles()
        expect(list).toHaveLength(2)
        expect(list[0].filename).toBe('second.html')
        expect(list[1].filename).toBe('first.html')

        expect(await getInputBookmarkHtml(file1.entry.id)).toBe('<first/>')
        expect(await getInputBookmarkHtml(file2.entry.id)).toBe('<second/>')

        // Remove only the first file
        const afterDelete = await removeInputBookmarkFile(file1.entry.id)
        expect(afterDelete).toHaveLength(1)
        expect(afterDelete[0].filename).toBe('second.html')
        expect(await getInputBookmarkHtml(file1.entry.id)).toBeNull()
        expect(await getInputBookmarkHtml(file2.entry.id)).toBe('<second/>')

        // Clear all files
        await clearAllInputBookmarkFiles()
        expect(await listInputBookmarkFiles()).toEqual([])
    })

    it('round-trips metadata and HTML through storage', async () => {
        const meta = { filename: 'b.html', size: 4, savedAt: 123, count: 1, dateSpan: null }
        global.chrome = { runtime: {}, storage: { local: {
            set: vi.fn((p, cb) => cb()),
            get: vi.fn((keys, cb) => {
                const res = {}
                if (keys.includes('inputBookmarksMeta')) res.inputBookmarksMeta = meta
                if (keys.includes('inputBookmarksHtml')) res.inputBookmarksHtml = '<x/>'
                cb(res)
            }),
            remove: vi.fn((keys, cb) => cb())
        } } }
        await expect(getInputBookmarkMeta()).resolves.toEqual(meta)
        await expect(getInputBookmarkHtml()).resolves.toBe('<x/>')
        await expect(getInputBookmarkFile()).resolves.toEqual({ ...meta, html: '<x/>' })
        await removeInputBookmarkFile()
        expect(global.chrome.storage.local.remove).toHaveBeenCalledWith(
            ['inputBookmarks', 'inputBookmarksMeta', 'inputBookmarksHtml'],
            expect.any(Function)
        )
    })

    it('reads a legacy combined entry so pre-upgrade caches still show and download', async () => {
        const legacy = { filename: 'old.html', html: '<legacy/>', size: 9, savedAt: 5, count: 2, dateSpan: null }
        global.chrome = { runtime: {}, storage: { local: {
            set: vi.fn((p, cb) => cb()),
            get: vi.fn((keys, cb) => {
                const res = {}
                if (keys.includes('inputBookmarks')) res.inputBookmarks = legacy
                cb(res)
            }),
            remove: vi.fn((keys, cb) => cb())
        } } }
        await expect(getInputBookmarkMeta()).resolves.toEqual(expect.objectContaining({ filename: 'old.html', count: 2 }))
        await expect(getInputBookmarkMeta()).resolves.not.toHaveProperty('html')
        await expect(getInputBookmarkHtml()).resolves.toBe('<legacy/>')
    })

    it('returns null metadata and null HTML when nothing is cached', async () => {
        global.chrome = { runtime: {}, storage: { local: {
            set: vi.fn((p, cb) => cb()),
            get: vi.fn((keys, cb) => cb({})),
            remove: vi.fn((keys, cb) => cb())
        } } }
        await expect(getInputBookmarkMeta()).resolves.toBeNull()
        await expect(getInputBookmarkHtml()).resolves.toBeNull()
    })
})

describe('input bookmarks download', () => {
    afterEach(() => { delete global.chrome; delete window.showSaveFilePicker })

    it('offers the Save As picker with the original filename and writes the pristine HTML', async () => {
        const html = htmlOf(2)
        const write = vi.fn(async () => {})
        window.showSaveFilePicker = vi.fn(async () => ({ name: 'copy.html', createWritable: async () => ({ write, close: vi.fn(async () => {}) }) }))
        global.chrome = { runtime: {}, downloads: { download: vi.fn() } }

        const result = await downloadInputBookmarkFile({ filename: 'bookmarks_20260603.html', html })

        expect(window.showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'bookmarks_20260603.html' }))
        expect(write).toHaveBeenCalledWith(html)
        expect(global.chrome.downloads.download).not.toHaveBeenCalled()
        expect(result).toEqual({ status: 'saved', method: 'picker', name: 'copy.html' })
    })

    it('falls back to a saveAs download when the picker is unavailable', async () => {
        delete window.showSaveFilePicker
        URL.createObjectURL = vi.fn(() => 'blob:input')
        global.chrome = { runtime: {}, downloads: { download: vi.fn() } }

        await downloadInputBookmarkFile({ filename: 'in.html', html: htmlOf(1) })

        expect(global.chrome.downloads.download).toHaveBeenCalledWith(
            expect.objectContaining({ filename: 'in.html', saveAs: true }),
            expect.any(Function)
        )
    })
})
