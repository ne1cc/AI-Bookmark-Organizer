import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { OrganizerService } from './organizer'
import * as ai from './ai'
import * as bookmarksExport from './bookmarks_export'
import * as bookmarksService from './bookmarks'

// Characterization ("golden") tests for OrganizerService.start(). They record
// the exact ordered progress stream, results, stats and browser writes so the
// start() refactor can prove it changed nothing. Snapshots were recorded
// against the UNREFACTORED code. If one changes, the refactor is wrong - do not
// regenerate it.

// Date formatting (utils/dates.js) uses the host timezone and locale, and the
// fixtures sit near UTC day boundaries, so pin both for machine-independent snapshots.
process.env.TZ = 'America/Los_Angeles'
const realToLocaleDateString = Date.prototype.toLocaleDateString
Date.prototype.toLocaleDateString = function (locales, options) {
    return realToLocaleDateString.call(this, locales ?? 'en-US', options)
}

class FakeStore {
    constructor() {
        this.nodes = new Map()
        this.ops = []
        const root = { id: '0', parentId: null, title: 'root', children: [] }
        const bar = { id: '1', parentId: '0', title: 'Bookmarks Bar', children: [] }
        const other = { id: '2', parentId: '0', title: 'Other Bookmarks', children: [] }
        root.children.push(bar, other)
        for (const n of [root, bar, other]) this.nodes.set(n.id, n)
    }
    rootTree() { return [this.nodes.get('0')] }
    node(id) { return this.nodes.get(String(id)) }
    addFolder(parentId, id, title) {
        const folder = { id: String(id), parentId: String(parentId), title, children: [] }
        this.nodes.set(folder.id, folder)
        this.node(parentId).children.push(folder)
        return folder
    }
    addUrl(parentId, id, url, title, dateAdded) {
        const node = { id: String(id), parentId: String(parentId), title, url, dateAdded }
        this.nodes.set(node.id, node)
        this.node(parentId).children.push(node)
        return node
    }
    move(id, destination) {
        this.ops.push(['move', String(id), destination])
        const node = this.node(id)
        if (!node) return Promise.reject(new Error(`node ${id} not found`))
        const oldParent = this.node(node.parentId)
        oldParent.children = oldParent.children.filter(c => c.id !== node.id)
        node.parentId = destination.parentId
        const newParent = this.node(destination.parentId)
        const index = typeof destination.index === 'number' ? destination.index : newParent.children.length
        newParent.children.splice(Math.min(index, newParent.children.length), 0, node)
        return Promise.resolve(node)
    }
    remove(id) {
        this.ops.push(['remove', String(id)])
        const node = this.node(id)
        this.node(node.parentId).children = this.node(node.parentId).children.filter(c => c.id !== node.id)
        this.nodes.delete(String(id))
        return Promise.resolve()
    }
    childrenOf(parentId) { return Promise.resolve([...(this.node(parentId)?.children || [])]) }
    // Nested view of placement AND order: folders are {title: [children]}, urls are their title.
    describe(id = '0') {
        const n = this.node(id)
        return n.url ? n.title : { [n.title]: n.children.map(c => this.describe(c.id)) }
    }
}

const wire = (store) => {
    vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
    vi.spyOn(bookmarksService, 'moveBookmark').mockImplementation((id, dest) => store.move(id, dest))
    vi.spyOn(bookmarksService, 'removeBookmark').mockImplementation((id) => store.remove(id))
    vi.spyOn(bookmarksService, 'getBookmarkChildren').mockImplementation((pid) => store.childrenOf(pid))
    vi.spyOn(bookmarksService, 'findOrCreateFolder').mockImplementation(async (parentId, title) => {
        const found = [...store.nodes.values()].find(n => n.parentId === parentId && n.title === title && !n.url)
        return found ?? store.addFolder(parentId, `folder-${parentId}-${title}`, title)
    })
}

const make = (args, extra = {}) => {
    const messages = []
    const service = new OrganizerService(
        'test-key', args.categories ?? ['Tech'], (m) => messages.push(m), 'google/gemini-3.1-flash-lite',
        'medium', args.sortAlphabetically ?? true, args.removeDuplicates ?? true, args.cleanTitles ?? false,
        args.flatDateSort ?? false, args.dateSortOrder ?? 'desc', args.schemaSortOrder, args.twelfth ?? false
    )
    service.snapshotProvider = extra.snapshotProvider ?? (async () => {})
    return { service, messages }
}

const record = async (service, messages, input, store) => {
    const results = await service.start(input)
    return {
        returned: results === null ? 'null' : 'array',
        results: results ? results.map(b => ({ ...b })) : null,
        resultStats: results?.stats ?? null,
        filename: results?.filename ?? null,
        isFlat: results?.isFlat ?? null,
        serviceStats: service.stats,
        dateSpan: service.dateSpan,
        messages,
        tree: store ? store.describe() : null,
        ops: store ? store.ops : null
    }
}

const fileFlatInput = () => [
    { title: 'Zebra', url: 'https://zebra.com', add_date: '1600000000' },
    { title: 'Apple', url: 'https://apple.com', add_date: '1600000000' },
    { title: 'Mango', url: 'https://mango.com', add_date: '1700000000' },
    { title: 'Undated B', url: 'https://undated-b.com' },
    { title: 'Undated A', url: 'https://undated-a.com' },
    { title: 'Apple dup', url: 'https://apple.com', add_date: '1650000000' }
]

describe('start() golden snapshots', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-10-01T12:00:00-07:00'))
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    describe('G1/G2 file flat', () => {
        it.each(['desc', 'asc', 'alpha-asc', 'alpha-desc'])('order %s', async (dateSortOrder) => {
            const fileDownload = vi.fn()
            const { service, messages } = make({ flatDateSort: true, dateSortOrder, twelfth: fileDownload })
            const snap = await record(service, messages, fileFlatInput())
            expect(fileDownload).toHaveBeenCalledTimes(1)
            expect(snap).toMatchSnapshot()
        })

        it('file flat with cleanTitles', async () => {
            vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => batch.map(b => ({ ...b, title: `${b.title} (clean)` })))
            const fileDownload = vi.fn()
            const { service, messages } = make({ flatDateSort: true, cleanTitles: true, twelfth: fileDownload })
            expect(await record(service, messages, fileFlatInput())).toMatchSnapshot()
        })
    })

    describe('G3 browser flat alphabetical', () => {
        it('moves into one root folder, removes duplicates, reorders', async () => {
            const store = new FakeStore()
            store.addUrl('1', '10', 'https://zebra.com', 'Zebra', 1500000000000)
            store.addUrl('1', '11', 'https://apple.com', 'Apple', 1700000000000)
            store.addUrl('1', '12', 'https://mango.com', 'Mango', 1600000000000)
            store.addUrl('1', '13', 'https://apple.com', 'Apple copy', 1710000000000)
            wire(store)
            const { service, messages } = make({ flatDateSort: true, dateSortOrder: 'alpha-asc' })
            expect(await record(service, messages, null, store)).toMatchSnapshot()
        })
    })

    describe('G4 browser flat month buckets', () => {
        it.each(['desc', 'asc'])('order %s', async (dateSortOrder) => {
            const store = new FakeStore()
            store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
            store.addUrl('1', '11', 'https://b.com', 'B', 1700000000000)
            store.addUrl('1', '12', 'https://c.com', 'C', 1700000000001)
            store.addUrl('1', '13', 'https://d.com', 'D', 1600000000000)
            store.addUrl('1', '14', 'https://e.com', 'E', undefined)
            wire(store)
            const { service, messages } = make({ flatDateSort: true, dateSortOrder })
            expect(await record(service, messages, null, store)).toMatchSnapshot()
        })
    })

    describe('G5 file AI with detail enrichment', () => {
        it('inferred schema, date-desc contents', async () => {
            const links = Array.from({ length: 6 }, (_, i) => ({
                title: `Link ${i}`, url: `https://detail.test/${i}`, add_date: String(1600000000 + (i % 3) * 172800)
            }))
            const schema = { categories: [{ name: 'Tech', sub_categories: ['Frontend'] }] }
            vi.spyOn(ai, 'generateInferredSchema').mockResolvedValue(schema)
            vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => batch.map(b => ({ ...b, category: 'Tech', sub_category: 'Frontend' })))
            vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map([['tech\u0000frontend', ['React', 'Vue']]]))
            vi.spyOn(ai, 'classifyDetailBatch').mockImplementation(async (chunk) => chunk.map((b, i) => ({ ...b, detail_category: i % 2 ? 'Vue' : 'React' })))
            const fileDownload = vi.fn()
            // A function as the 12th constructor arg is the file-download handler and implies inference mode.
            const { service, messages } = make({ categories: [], schemaSortOrder: 'date-desc', twelfth: fileDownload })
            expect(await record(service, messages, links)).toMatchSnapshot()
        })
    })

    describe('G6 browser AI placement', () => {
        it.each(['alpha', 'domain', 'date-asc', 'none'])('schemaSortOrder %s', async (schemaSortOrder) => {
            const store = new FakeStore()
            store.addUrl('1', '10', 'https://alpha.com/b', 'Zeta', 1500000000000)
            store.addUrl('1', '11', 'https://www.zeta.com/a', 'Alpha', 1700000000000)
            store.addUrl('1', '12', 'https://beta.com/c', 'Beta', 1600000000000)
            store.addUrl('1', '13', 'https://bank.com', 'Bank', 1600000000000)
            store.addUrl('1', '14', 'https://www.zeta.com/a', 'Alpha dup', 1710000000000)
            wire(store)
            vi.spyOn(ai, 'generateSchema').mockResolvedValue({
                categories: [
                    { name: 'Tech', sub_categories: ['Tools'] },
                    { name: 'Finance', sub_categories: ['Banking'] }
                ]
            })
            vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => batch.map(b => (
                b.url.includes('bank')
                    ? { ...b, category: 'Finance', sub_category: 'Banking' }
                    : { ...b, category: 'Tech', sub_category: 'Tools' }
            )))
            vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map())
            const { service, messages } = make({ categories: ['Tech', 'Finance'], schemaSortOrder })
            expect(await record(service, messages, null, store)).toMatchSnapshot()
        })
    })

    describe('G7 multi-batch AI with one failed batch (order-insensitive progress)', () => {
        it('classifies concurrently and retries the failed batch', async () => {
            const links = Array.from({ length: 120 }, (_, i) => ({ title: `Link ${i}`, url: `https://multi.test/${i}`, add_date: String(1600000000 + i) }))
            // File mode (function 12th arg) implies inference mode, so mock the inferred schema.
            vi.spyOn(ai, 'generateInferredSchema').mockResolvedValue({ categories: [{ name: 'Tech', sub_categories: ['Tools'] }] })
            vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map())
            let failedOnce = false
            vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => {
                if (!failedOnce && batch[0].title === 'Link 45') {
                    failedOnce = true
                    throw new Error('boom')
                }
                return batch.map(b => ({ ...b, category: 'Tech', sub_category: 'Tools' }))
            })
            const { service, messages } = make({ categories: ['Tech'], schemaSortOrder: 'alpha', twelfth: vi.fn() })
            const snap = await record(service, messages, links)
            // Concurrent lanes may interleave progress messages differently across
            // equivalent implementations; their multiset is the contract here.
            snap.messages = [...snap.messages].map(m => JSON.stringify(m)).sort()
            expect(snap).toMatchSnapshot()
        })
    })

    describe('G8 early exits', () => {
        it('empty input', async () => {
            const { service, messages } = make({ categories: ['Tech'] })
            expect(await record(service, messages, [])).toMatchSnapshot()
        })

        it('cancel during classification', async () => {
            vi.spyOn(ai, 'generateInferredSchema').mockResolvedValue({ categories: [{ name: 'Tech', sub_categories: [] }] })
            const links = [{ title: 'A', url: 'https://a.com' }]
            const { service, messages } = make({ categories: ['Tech'], twelfth: vi.fn() })
            vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => {
                service.cancel()
                return batch.map(b => ({ ...b, category: 'Tech', sub_category: 'General' }))
            })
            expect(await record(service, messages, links)).toMatchSnapshot()
        })

        it('snapshot failure aborts before touching bookmarks (browser flat)', async () => {
            const store = new FakeStore()
            store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
            wire(store)
            const { service, messages } = make(
                { flatDateSort: true, dateSortOrder: 'alpha-asc' },
                { snapshotProvider: async () => { throw new Error('disk full') } }
            )
            expect(await record(service, messages, null, store)).toMatchSnapshot()
        })

        it('snapshot failure aborts before touching bookmarks (browser AI)', async () => {
            const store = new FakeStore()
            store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
            wire(store)
            vi.spyOn(ai, 'generateSchema').mockResolvedValue({ categories: [{ name: 'Tech', sub_categories: [] }] })
            vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => batch.map(b => ({ ...b, category: 'Tech', sub_category: 'General' })))
            vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map())
            const { service, messages } = make(
                { categories: ['Tech'] },
                { snapshotProvider: async () => { throw new Error('disk full') } }
            )
            expect(await record(service, messages, null, store)).toMatchSnapshot()
        })
    })
})
