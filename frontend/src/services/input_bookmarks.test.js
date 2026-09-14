import { describe, it, expect, vi, afterEach } from 'vitest'
import { saveInputBookmarkFile, getInputBookmarkMeta, getInputBookmarkHtml, getInputBookmarkFile, removeInputBookmarkFile, INPUT_MAX_BYTES } from './input_bookmarks'

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
        expect(removeSpy).toHaveBeenCalledWith(['inputBookmarks'], expect.any(Function))
    })

    it('refuses entries above INPUT_MAX_BYTES without throwing', async () => {
        global.chrome = { runtime: {}, storage: { local: { set: vi.fn(), get: vi.fn((k, cb) => cb({})), remove: vi.fn() } } }
        const res = await saveInputBookmarkFile({ filename: 'huge.html', html: 'x'.repeat(INPUT_MAX_BYTES + 1), count: 1, dateSpan: null })
        expect(res.saved).toBe(false)
        expect(res.reason).toBe('too-large')
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
