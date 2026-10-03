import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { OrganizerService } from './organizer'
import * as ai from './ai'
import { classifyRehomeBatch } from './ai'
import * as bookmarksExport from './bookmarks_export'

// The re-home pass gives bookmarks filed directly under a category folder (the
// "General" sink) a second look against the folders that survived reconciliation.

const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] })
})

const bookmark = (id, category, sub_category = 'General') => ({
    title: `Bookmark ${id}`,
    url: `https://rehome.test/${id}`,
    category,
    sub_category,
    add_date: 1700000000 + id
})

describe('classifyRehomeBatch', () => {
    let originalFetch

    beforeEach(() => { originalFetch = global.fetch })
    afterEach(() => { global.fetch = originalFetch })

    const folders = { Tech: ['Web Development', 'Databases'], Finance: ['Trading'] }

    it('moves bookmarks into approved folders of their own category and keeps every other field', async () => {
        global.fetch = vi.fn(async () => jsonResponse({
            classified: [
                { i: 0, sub_category: ' web development ' },
                { i: 1, sub_category: 'Trading' }
            ]
        }))
        const input = [bookmark(0, 'Tech'), bookmark(1, 'Finance')]

        const result = await classifyRehomeBatch(input, 'sk-or-test-key', folders)

        expect(result.map(b => b.sub_category)).toEqual(['Web Development', 'Trading'])
        expect(result[0]).toMatchObject({ title: 'Bookmark 0', url: 'https://rehome.test/0', category: 'Tech', add_date: 1700000000 })
    })

    it('leaves a bookmark where it is for null, unknown, or another category\'s folder name', async () => {
        global.fetch = vi.fn(async () => jsonResponse({
            classified: [
                { i: 0, sub_category: null },
                { i: 1, sub_category: 'Invented Folder' },
                { i: 2, sub_category: 'Trading' }
            ]
        }))
        const input = [bookmark(0, 'Tech'), bookmark(1, 'Tech'), bookmark(2, 'Tech')]

        const result = await classifyRehomeBatch(input, 'sk-or-test-key', folders)

        expect(result.map(b => b.sub_category)).toEqual(['General', 'General', 'General'])
    })

    it('leaves a bookmark where it is when the model omits it, and ignores out-of-range indexes', async () => {
        global.fetch = vi.fn(async () => jsonResponse({
            classified: [{ i: 7, sub_category: 'Databases' }, { i: 1, sub_category: 'Databases' }]
        }))
        const input = [bookmark(0, 'Tech'), bookmark(1, 'Tech')]

        const result = await classifyRehomeBatch(input, 'sk-or-test-key', folders)

        expect(result.map(b => b.sub_category)).toEqual(['General', 'Databases'])
    })

    it('shows the model each bookmark\'s category with that category\'s approved folders', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ classified: [] }))
        global.fetch = fetchMock

        await classifyRehomeBatch([bookmark(0, 'Tech')], 'sk-or-test-key', folders)

        const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content
        expect(prompt).toContain('"Tech":["Web Development","Databases"]')
        expect(prompt).toContain('"category":"Tech"')
    })
})

describe('OrganizerService re-home pass', () => {
    const schema = { categories: [{ name: 'Tech', sub_categories: ['Web Development'] }, { name: 'Archive', sub_categories: ['Broken Links'] }, { name: 'Finance', sub_categories: [] }] }
    const links = Array.from({ length: 12 }, (_, i) => ({ title: `Link ${i}`, url: `https://rehome.test/link/${i}` }))

    // Six real folder members, plus whatever loose bookmarks a test supplies.
    const classifiedWith = (extras) => links.map((link, i) => ({
        ...link,
        ...(i < 6 ? { category: 'Tech', sub_category: 'Web Development' } : extras[i - 6])
    }))

    const run = async (extras) => {
        vi.spyOn(ai, 'generateSchema').mockResolvedValue(schema)
        vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map())
        const classified = classifiedWith(extras)
        vi.spyOn(ai, 'classifyBatch').mockResolvedValue(classified)
        const logs = []
        const service = new OrganizerService('test-key', ['Tech', 'Archive', 'Finance'], (e) => logs.push(e), undefined, 'medium', true, true, false, false, 'desc', undefined, false)
        const results = await service.start(links)
        return { results, logs, messages: logs.map(l => l.message).filter(Boolean) }
    }

    beforeEach(() => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
    })
    afterEach(() => vi.restoreAllMocks())

    it('moves loose bookmarks into a surviving folder of their category', async () => {
        const rehome = vi.spyOn(ai, 'classifyRehomeBatch').mockImplementation(async (batch) =>
            batch.map(b => ({ ...b, sub_category: 'Web Development' })))
        const loose = Array.from({ length: 6 }, () => ({ category: 'Tech', sub_category: 'General' }))

        const { results } = await run(loose)

        expect(rehome).toHaveBeenCalledTimes(1)
        expect(rehome.mock.calls[0][0]).toHaveLength(6)
        expect(rehome.mock.calls[0][2]).toEqual({ Tech: ['Web Development'] })
        expect(results.filter(b => b.sub_category === 'General')).toHaveLength(0)
        expect(results.filter(b => b.sub_category === 'Web Development')).toHaveLength(12)
    })

    it('makes no extra AI call when nothing sits directly in a category', async () => {
        const rehome = vi.spyOn(ai, 'classifyRehomeBatch')
        const placed = Array.from({ length: 6 }, () => ({ category: 'Tech', sub_category: 'Web Development' }))

        await run(placed)

        expect(rehome).not.toHaveBeenCalled()
    })

    it('leaves the Archive category alone', async () => {
        const rehome = vi.spyOn(ai, 'classifyRehomeBatch')
        const archive = Array.from({ length: 6 }, () => ({ category: 'Archive', sub_category: 'General' }))

        const { results } = await run(archive)

        expect(rehome).not.toHaveBeenCalled()
        expect(results.filter(b => b.category === 'Archive' && b.sub_category === 'General')).toHaveLength(6)
    })

    it('does not offer a category that has no folder to receive the bookmarks', async () => {
        const rehome = vi.spyOn(ai, 'classifyRehomeBatch')
        const loose = Array.from({ length: 6 }, () => ({ category: 'Finance', sub_category: 'General' }))

        await run(loose)

        expect(rehome).not.toHaveBeenCalled()
    })

    it('keeps bookmarks where they were and warns when the pass fails', async () => {
        vi.spyOn(ai, 'classifyRehomeBatch').mockRejectedValue(new Error('model unavailable'))
        const loose = Array.from({ length: 6 }, () => ({ category: 'Tech', sub_category: 'General' }))

        const { results, messages } = await run(loose)

        expect(results).toHaveLength(12)
        expect(results.filter(b => b.sub_category === 'General')).toHaveLength(6)
        expect(messages.some(m => m.includes('model unavailable'))).toBe(true)
    })

    it('stops the run when cancelled during the pass', async () => {
        vi.spyOn(ai, 'classifyRehomeBatch').mockRejectedValue(Object.assign(new Error('Operation cancelled.'), { isCancelled: true }))
        const loose = Array.from({ length: 6 }, () => ({ category: 'Tech', sub_category: 'General' }))

        const { results } = await run(loose)

        expect(results).toBeNull()
    })
})
