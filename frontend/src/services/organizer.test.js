import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { removeDuplicateUrls, checkUrlReachable, filterReachableBookmarks, OrganizerService, getBookmarkTimestamp, getBookmarkDomain, calculateDateSpan, buildUrlIndex, dedupeFromIndex, removeBrowserDuplicates } from './organizer'
import * as ai from './ai'
import { classifyBatch, generateSchema, withRetry, geminiModelId, isNetworkError, isRateLimitError, isRetryableError } from './ai'
import * as bookmarksExport from './bookmarks_export'
import * as bookmarksService from './bookmarks'
import { DEFAULT_CATEGORIES, SUGGESTED_ADDABLE_CATEGORIES, SCHEMA_SORT_OPTIONS } from '../components/Organizer'
import { groupEligibleDetailCandidates, reconcileDetailCategories } from './reconcile'

class FakeBookmarkStore {
    constructor() {
        this.nodes = new Map();   // id -> {id, parentId, title, url?, dateAdded?, children?: []}
        this.ops = [];
        const root = { id: '0', parentId: null, title: 'root', children: [] };
        const bar = { id: '1', parentId: '0', title: 'Bookmarks Bar', children: [] };
        const other = { id: '2', parentId: '0', title: 'Other Bookmarks', children: [] };
        root.children.push(bar, other);
        for (const n of [root, bar, other]) this.nodes.set(n.id, n);
    }
    rootTree() {
        const root = this.nodes.get('0');
        return [root];
    }
    node(id) { return this.nodes.get(String(id)); }
    addFolder(parentId, id, title) {
        const folder = { id: String(id), parentId: String(parentId), title, children: [] };
        this.nodes.set(folder.id, folder);
        this.node(parentId).children.push(folder);
        return folder;
    }
    addUrl(parentId, id, url, title, dateAdded) {
        const node = { id: String(id), parentId: String(parentId), title, url, dateAdded };
        this.nodes.set(node.id, node);
        this.node(parentId).children.push(node);
        return node;
    }
    move(id, destination) {
        this.ops.push(['move', String(id), destination]);
        const node = this.node(id);
        if (!node) return Promise.reject(new Error(`node ${id} not found`));
        const oldParent = this.node(node.parentId);
        oldParent.children = oldParent.children.filter(c => c.id !== node.id);
        node.parentId = destination.parentId;
        const newParent = this.node(destination.parentId);
        if (!newParent) return Promise.reject(new Error(`parent ${destination.parentId} not found`));
        const index = typeof destination.index === 'number' ? destination.index : newParent.children.length;
        newParent.children.splice(Math.min(index, newParent.children.length), 0, node);
        return Promise.resolve(node);
    }
    remove(id) {
        this.ops.push(['remove', String(id)]);
        const node = this.node(id);
        if (!node) return Promise.reject(new Error(`node ${id} not found`));
        this.node(node.parentId).children = this.node(node.parentId).children.filter(c => c.id !== node.id);
        this.nodes.delete(String(id));
        return Promise.resolve();
    }
    childrenOf(parentId) {
        return Promise.resolve([...(this.node(parentId)?.children || [])]);
    }
}

const wireStore = (store) => {
    vi.spyOn(bookmarksService, 'moveBookmark').mockImplementation((id, dest) => store.move(id, dest));
    vi.spyOn(bookmarksService, 'removeBookmark').mockImplementation((id) => store.remove(id));
    vi.spyOn(bookmarksService, 'getBookmarkChildren').mockImplementation((pid) => store.childrenOf(pid));
};

// Most organizer tests exercise the pre-existing manual path. Make that mode
// explicit now that the production constructor defaults new callers to inference.
const createOrganizerService = (...args) => {
    const constructorArgs = [...args];
    if (constructorArgs[11] === undefined) constructorArgs[11] = false;
    return new OrganizerService(...constructorArgs);
};

describe('FakeBookmarkStore', () => {
    it('FakeBookmarkStore move splices children and preserves dateAdded', async () => {
        const store = new FakeBookmarkStore()
        store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
        store.addFolder('2', 'f1', 'Target')
        await store.move('10', { parentId: 'f1' })
        expect(store.node('10').parentId).toBe('f1')
        expect(store.node('10').dateAdded).toBe(1500000000000)
        expect(store.childrenOf('1')).resolves.toHaveLength(0)
    })
})

describe('removeDuplicateUrls', () => {
    it('keeps the first bookmark for each exact URL', () => {
        const bookmarks = [
            { title: 'First', url: 'https://example.com' },
            { title: 'Second', url: 'https://example.com' },
            { title: 'Different', url: 'https://example.com/page' }
        ]

        expect(removeDuplicateUrls(bookmarks)).toEqual([
            { title: 'First', url: 'https://example.com' },
            { title: 'Different', url: 'https://example.com/page' }
        ])
    })
})

describe('buildUrlIndex and dedupeFromIndex', () => {
    const links = [
        { id: '10', url: 'https://a.com', title: 'A old',  dateAdded: 1500000000000 },
        { id: '11', url: 'https://a.com', title: 'A new',  dateAdded: 1700000000000 },
        { id: '9',  url: 'https://a.com', title: 'A tie',  dateAdded: 1500000000000 },
        { id: '20', url: 'https://b.com', title: 'B',      dateAdded: 1600000000000 }
    ]

    it('groups nodes by exact URL sorted oldest-first with numeric-id tie-break', () => {
        const index = buildUrlIndex(links)
        expect(index.get('https://a.com').map(g => g.id)).toEqual(['9', '10', '11'])
        expect(index.get('https://b.com').map(g => g.id)).toEqual(['20'])
    })

    it('keeps the group head as survivor and dooms the rest', () => {
        const { survivors, doomed, duplicatesRemoved } = dedupeFromIndex(links, buildUrlIndex(links))
        expect(survivors.map(l => l.id)).toEqual(['9', '20'])
        expect(doomed.map(l => l.id).sort()).toEqual(['10', '11'])
        expect(duplicatesRemoved).toBe(2)
    })

    it('keeps id-less entries as survivors (defensive: non-browser input)', () => {
        const idless = [{ url: 'https://a.com', title: 'no id', dateAdded: 1 }]
        const { survivors, doomed } = dedupeFromIndex(idless, buildUrlIndex(idless))
        expect(survivors).toHaveLength(1)
        expect(doomed).toHaveLength(0)
    })
})

describe('removeBrowserDuplicates', () => {
    afterEach(() => {
        delete global.chrome
        vi.restoreAllMocks()
    })

    it('returns zeroes when getBookmarks returns empty or null', async () => {
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue([])
        const result = await removeBrowserDuplicates()
        expect(result).toEqual({ totalScanned: 0, duplicatesRemoved: 0, failedCount: 0 })
    })

    it('returns zeroes removed when all links are unique', async () => {
        const fakeTree = [
            {
                id: '0',
                children: [
                    { id: '1', title: 'Site 1', url: 'https://site1.com', dateAdded: 100 },
                    { id: '2', title: 'Site 2', url: 'https://site2.com', dateAdded: 200 }
                ]
            }
        ]
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(fakeTree)
        const removeSpy = vi.spyOn(bookmarksService, 'removeBookmark').mockResolvedValue()
        const result = await removeBrowserDuplicates()
        expect(result).toEqual({ totalScanned: 2, duplicatesRemoved: 0, failedCount: 0 })
        expect(removeSpy).not.toHaveBeenCalled()
    })

    it('identifies duplicates, saves preWriteBackup snapshot, and deletes doomed nodes', async () => {
        const fakeTree = [
            {
                id: '0',
                children: [
                    { id: '1', title: 'Alpha Old', url: 'https://alpha.com', dateAdded: 1000 },
                    { id: '2', title: 'Alpha Dup 1', url: 'https://alpha.com', dateAdded: 2000 },
                    { id: '3', title: 'Alpha Dup 2', url: 'https://alpha.com', dateAdded: 3000 },
                    { id: '4', title: 'Beta Unique', url: 'https://beta.com', dateAdded: 1500 }
                ]
            }
        ]
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(fakeTree)
        const removeSpy = vi.spyOn(bookmarksService, 'removeBookmark').mockResolvedValue()

        const localSetSpy = vi.fn((data, cb) => cb && cb())
        global.chrome = {
            storage: {
                local: {
                    set: localSetSpy
                }
            }
        }

        const result = await removeBrowserDuplicates()
        expect(result).toEqual({ totalScanned: 4, duplicatesRemoved: 2, failedCount: 0 })

        // Pre-write backup was stored
        expect(localSetSpy).toHaveBeenCalledTimes(1)
        const savedPayload = localSetSpy.mock.calls[0][0]
        expect(savedPayload.preWriteBackup).toBeDefined()
        expect(savedPayload.preWriteBackup.count).toBe(4)

        // Oldest node (id: '1') survives, doomed nodes ('2' and '3') are removed
        expect(removeSpy).toHaveBeenCalledTimes(2)
        expect(removeSpy).toHaveBeenCalledWith('2')
        expect(removeSpy).toHaveBeenCalledWith('3')
        expect(removeSpy).not.toHaveBeenCalledWith('1')
        expect(removeSpy).not.toHaveBeenCalledWith('4')
    })

    it('tracks failed deletions and returns net duplicates removed', async () => {
        const fakeTree = [
            {
                id: '0',
                children: [
                    { id: '1', title: 'Site', url: 'https://site.com', dateAdded: 1000 },
                    { id: '2', title: 'Site Dup 1', url: 'https://site.com', dateAdded: 2000 },
                    { id: '3', title: 'Site Dup 2', url: 'https://site.com', dateAdded: 3000 }
                ]
            }
        ]
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(fakeTree)
        vi.spyOn(bookmarksService, 'removeBookmark').mockImplementation(async (id) => {
            if (id === '3') throw new Error('Permission denied')
            return
        })

        const result = await removeBrowserDuplicates({ snapshot: false })
        expect(result).toEqual({ totalScanned: 3, duplicatesRemoved: 1, failedCount: 1 })
    })
})

describe('checkUrlReachable', () => {
    it('returns false for invalid or non-http URLs', async () => {
        expect(await checkUrlReachable('')).toBe(false)
        expect(await checkUrlReachable(null)).toBe(false)
        expect(await checkUrlReachable('ftp://example.com')).toBe(false)
        expect(await checkUrlReachable('chrome://bookmarks')).toBe(false)
    })
})

describe('filterReachableBookmarks', () => {
    const originalFetch = global.fetch

    afterEach(() => {
        global.fetch = originalFetch
    })

    it('isolates dead links under Archive -> Broken Links', async () => {
        global.fetch = vi.fn(async (url) => {
            if (url.includes('dead-domain.com')) {
                throw new Error('DNS resolution failed')
            }
            return { ok: true }
        })

        const bookmarks = [
            { title: 'Working Link', url: 'https://example.com' },
            { title: 'Dead Link', url: 'https://dead-domain.com' }
        ]

        const progressCalls = []
        const onProgress = (msg) => progressCalls.push(msg)

        const { activeLinks, deadLinks } = await filterReachableBookmarks(
            bookmarks,
            onProgress,
            () => false
        )

        expect(activeLinks).toEqual([
            { title: 'Working Link', url: 'https://example.com' }
        ])
        expect(deadLinks).toEqual([
            {
                title: 'Dead Link',
                url: 'https://dead-domain.com',
                category: 'Archive',
                sub_category: 'Broken Links'
            }
        ])
    })
})

describe('OrganizerService adaptive batch sizes', () => {
    it('uses larger batch sizes up to 50 for faster processing with Flash models', () => {
        const service = createOrganizerService('test-key', [], () => {}, 'google/gemini-3.8-flash')

        expect(service.calculateAdaptiveBatchSize(30)).toBe(30)
        expect(service.calculateAdaptiveBatchSize(150)).toBe(45)
        expect(service.calculateAdaptiveBatchSize(600)).toBe(50)
    })
})

describe('classifyBatch cleanTitles option', () => {
    const originalFetch = global.fetch

    afterEach(() => {
        global.fetch = originalFetch
    })

    const sampleBookmarks = [
        { title: 'GitHub - Where software is built', url: 'https://github.com' },
        { title: 'Wikipedia, the free encyclopedia', url: 'https://wikipedia.org' },
        { title: 'Clean Blog', url: 'https://cleanblog.com' }
    ]

    const sampleSchema = {
        categories: [
            { name: 'Development', sub_categories: ['Tools'] },
            { name: 'Reference', sub_categories: ['General'] }
        ]
    }

    it('retains original titles when cleanTitles is false or omitted', async () => {
        let capturedBody = null
        global.fetch = vi.fn(async (url, options) => {
            capturedBody = JSON.parse(options.body)
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    classified: [
                                        { i: 0, category: 'Development', sub_category: 'Tools', clean_title: 'GitHub' },
                                        { i: 1, category: 'Reference', sub_category: 'General', clean_title: 'Wikipedia' },
                                        { i: 2, category: 'Other', sub_category: 'General', clean_title: 'Clean Blog' }
                                    ]
                                })
                            }
                        }
                    ]
                })
            }
        })

        // Test with cleanTitles omitted (default: false)
        const resultDefault = await classifyBatch(sampleBookmarks, 'sk-or-test-key', sampleSchema)
        expect(resultDefault[0].title).toBe('GitHub - Where software is built')
        expect(resultDefault[1].title).toBe('Wikipedia, the free encyclopedia')
        expect(resultDefault[2].title).toBe('Clean Blog')
        expect(capturedBody.messages[1].content).not.toContain('6. Title cleanup')
        expect(capturedBody.messages[1].content).toContain('{ "classified": [ { "i": 0, "category": "...", "sub_category": "..." } ] }')
        expect(capturedBody.messages[1].content).not.toContain('"clean_title"')

        // Test with cleanTitles explicitly false
        const resultFalse = await classifyBatch(sampleBookmarks, 'sk-or-test-key', sampleSchema, 'google/gemini-3.1-flash-lite', false)
        expect(resultFalse[0].title).toBe('GitHub - Where software is built')
        expect(resultFalse[1].title).toBe('Wikipedia, the free encyclopedia')
        expect(resultFalse[2].title).toBe('Clean Blog')
    })

    it('maps clean_title to title when cleanTitles is true and clean_title is non-empty string', async () => {
        let capturedBody = null
        global.fetch = vi.fn(async (url, options) => {
            capturedBody = JSON.parse(options.body)
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    classified: [
                                        { i: 0, category: 'Development', sub_category: 'Tools', clean_title: '  GitHub  ' },
                                        { i: 1, category: 'Reference', sub_category: 'General', clean_title: '   ' },
                                        { i: 2, category: 'Other', sub_category: 'General' }
                                    ]
                                })
                            }
                        }
                    ]
                })
            }
        })

        const result = await classifyBatch(sampleBookmarks, 'sk-or-test-key', sampleSchema, 'google/gemini-3.1-flash-lite', true)

        // Bookmark 0 has valid clean_title -> trimmed clean_title
        expect(result[0].title).toBe('GitHub')
        expect(result[0].category).toBe('Development')
        expect(result[0].sub_category).toBe('Tools')

        // Bookmark 1 has whitespace-only clean_title -> retains original title
        expect(result[1].title).toBe('Wikipedia, the free encyclopedia')
        expect(result[1].category).toBe('Reference')
        expect(result[1].sub_category).toBe('General')

        // Bookmark 2 has no clean_title -> retains original title
        expect(result[2].title).toBe('Clean Blog')
        expect(result[2].category).toBe('Development')
        expect(result[2].sub_category).toBe('General')

        // Verify prompt contains title cleanup instructions and updated example return schema
        expect(capturedBody.messages[1].content).toContain('7. Title cleanup: If clean_title is requested')
        expect(capturedBody.messages[1].content).toContain('{ "classified": [ { "i": 0, "category": "...", "sub_category": "...", "clean_title": "..." } ] }')
    })
})

describe('OrganizerService cleanTitles integration', () => {
    let originalFetch

    beforeEach(() => {
        originalFetch = global.fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
    })

    it('defaults cleanTitles to false when omitted', () => {
        const service = createOrganizerService('test-key', [], () => {})
        expect(service.cleanTitles).toBe(false)
    })

    it('stores cleanTitles as true when passed in constructor', () => {
        const service = createOrganizerService('test-key', [], () => {}, 'google/gemini-3.1-flash-lite', '5-10', true, true, true)
        expect(service.cleanTitles).toBe(true)
    })

    it('passes cleanTitles as false by default to classifyBatch during start()', async () => {
        global.fetch = vi.fn(async () => ({ ok: true }))

        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: ['Coding'] }]
        })
        const classifyBatchSpy = vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'Original Tech', url: 'https://example.com', category: 'Tech', sub_category: 'Coding' }
        ])

        const service = createOrganizerService('test-key', ['Tech'], () => {})

        const bookmarks = [{ title: 'Original Tech', url: 'https://example.com' }]
        await service.start(bookmarks)

        expect(classifyBatchSpy).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ url: 'https://example.com' })]),
            'test-key',
            expect.any(Object),
            'google/gemini-3.1-flash-lite',
            false,
            expect.any(Function),
            expect.any(Function)
        )
    })

    it('passes cleanTitles to classifyBatch during start() in main worker pass', async () => {
        global.fetch = vi.fn(async () => ({ ok: true }))

        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: ['Coding'] }]
        })
        const classifyBatchSpy = vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'Clean Tech', url: 'https://example.com', category: 'Tech', sub_category: 'Coding' }
        ])

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            true
        )

        const bookmarks = [{ title: 'Messy Tech Site', url: 'https://example.com' }]
        await service.start(bookmarks)

        expect(classifyBatchSpy).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ url: 'https://example.com' })]),
            'test-key',
            expect.any(Object),
            'google/gemini-3.1-flash-lite',
            true,
            expect.any(Function),
            expect.any(Function)
        )
    })

    it('passes cleanTitles to classifyBatch during retry pass for failed batches', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        global.fetch = vi.fn(async () => ({ ok: true }))

        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: ['Coding'] }]
        })
        // First call fails (triggering retry pass), second call succeeds
        const classifyBatchSpy = vi.spyOn(ai, 'classifyBatch')
            .mockRejectedValueOnce(new Error('Rate limit or network drop'))
            .mockResolvedValueOnce([
                { title: 'Clean Tech', url: 'https://example.com', category: 'Tech', sub_category: 'Coding' }
            ])

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            true
        )

        const bookmarks = [{ title: 'Messy Tech Site', url: 'https://example.com' }]
        await service.start(bookmarks)

        // classifyBatch should have been called twice: initial pass and retry pass
        expect(classifyBatchSpy).toHaveBeenCalledTimes(2)
        // Both calls must have received cleanTitles = true as the 5th argument
        expect(classifyBatchSpy).toHaveBeenNthCalledWith(
            1,
            expect.any(Array),
            'test-key',
            expect.any(Object),
            'google/gemini-3.1-flash-lite',
            true,
            expect.any(Function),
            expect.any(Function)
        )
        expect(classifyBatchSpy).toHaveBeenNthCalledWith(
            2,
            expect.any(Array),
            'test-key',
            expect.any(Object),
            'google/gemini-3.1-flash-lite',
            true,
            expect.any(Function),
            expect.any(Function)
        )
    })
})

describe('OrganizerService detail enrichment integration', () => {
    const links = Array.from({ length: 6 }, (_, i) => ({ title: `Link ${i}`, url: `https://detail.test/${i}` }))
    const schema = { categories: [{ name: 'Tech', sub_categories: ['Frontend'] }] }
    const classified = links.map((bookmark, i) => ({ ...bookmark, category: 'Tech', sub_category: 'Frontend', _i: i }))

    beforeEach(() => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue(schema)
        vi.spyOn(ai, 'generateInferredSchema').mockResolvedValue(schema)
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => batch.map((bookmark, i) => ({ ...bookmark, category: 'Tech', sub_category: 'Frontend', _i: i })))
    })

    afterEach(() => vi.restoreAllMocks())

    it('groups spacing and canonical parent variants into one detail group and schema lookup', () => {
        const classifiedVariants = Array.from({ length: 12 }, (_, index) => ({
            title: `Variant ${index}`,
            url: `https://detail.test/variant/${index}`,
            category: 'Tech',
            sub_category: index < 6 ? ' Web   Development ' : 'Web Developments',
            detail_category: index % 2 === 0 ? 'React' : 'Vue'
        }))

        const groups = groupEligibleDetailCandidates(classifiedVariants)
        expect(groups.size).toBe(1)
        expect([...groups.values()][0]).toHaveLength(12)

        const result = reconcileDetailCategories(classifiedVariants, new Map([
            ['tech\u0000web development', ['React', 'Vue']]
        ]))

        expect(result.summary).toEqual({
            detailFoldersKept: 2,
            detailedSubcategories: 1,
            groupsKeptAtTwoLevels: 0
        })
        expect(result.classified.filter(item => item.detail_category === 'React')).toHaveLength(6)
        expect(result.classified.filter(item => item.detail_category === 'Vue')).toHaveLength(6)
    })

    it('assigns detail folders through the real inferred OrganizerService run', async () => {
        vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map([['tech\u0000frontend', ['React', 'Vue']]]))
        vi.spyOn(ai, 'classifyDetailBatch').mockResolvedValue(classified.map((item, i) => ({ ...item, detail_category: i % 2 ? 'Vue' : 'React' })))
        const service = createOrganizerService('test-key', [], () => {}, undefined, '5-10', true, true, false, false, 'desc', undefined, true)
        const results = await service.start(links)
        expect(results.map(item => item.detail_category)).toEqual(['React', 'React', 'React', 'Vue', 'Vue', 'Vue'])
        expect(results.stats.detailFoldersCount).toBe(2)
        expect(results.stats.detailedSubcategories).toBe(1)
    })

    it('preserves manual selected top-level categories while enriching deeper levels', async () => {
        vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map([['tech\u0000frontend', ['React', 'Vue']]]))
        vi.spyOn(ai, 'classifyBatch').mockResolvedValue(classified.map(item => ({ ...item, category: 'tech', sub_category: 'Frontend' })))
        vi.spyOn(ai, 'classifyDetailBatch').mockResolvedValue(classified.map((item, i) => ({ ...item, detail_category: i % 2 ? 'Vue' : 'React' })))
        const service = createOrganizerService('test-key', ['Tech'], () => {}, undefined, '5-10', true, true, false, false, 'desc', undefined, false)
        const results = await service.start(links)
        expect(new Set(results.map(item => item.category))).toEqual(new Set(['Tech']))
        expect(results.every(item => item.sub_category === 'Frontend')).toBe(true)
        expect(new Set(results.map(item => item.detail_category))).toEqual(new Set(['React', 'Vue']))
    })

    it('keeps duplicate URLs scoped to their original parent group and bookmark id', async () => {
        const groupedLinks = [
            ...Array.from({ length: 6 }, (_, i) => ({
                id: `tech-${i}`,
                title: `Tech ${i}`,
                url: i === 0 ? 'https://shared.test/bookmark' : `https://tech.test/${i}`
            })),
            ...Array.from({ length: 6 }, (_, i) => ({
                id: `design-${i}`,
                title: `Design ${i}`,
                url: i === 0 ? 'https://shared.test/bookmark' : `https://design.test/${i}`
            }))
        ]
        const groupedSchema = {
            categories: [
                { name: 'Tech', sub_categories: ['Frontend'] },
                { name: 'Design', sub_categories: ['Systems'] }
            ]
        }

        vi.spyOn(ai, 'generateSchema').mockResolvedValue(groupedSchema)
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async batch => batch.map(bookmark => ({
            ...bookmark,
            category: bookmark.id.startsWith('tech-') ? 'Tech' : 'Design',
            sub_category: bookmark.id.startsWith('tech-') ? 'Frontend' : 'Systems'
        })))
        vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map([
            ['tech\u0000frontend', ['React', 'Vue']],
            ['design\u0000systems', ['Tokens', 'Components']]
        ]))
        vi.spyOn(ai, 'classifyDetailBatch').mockImplementation(async records => records.map((bookmark, index) => ({
            ...bookmark,
            detail_category: bookmark.category === 'Tech'
                ? (index < 3 ? 'React' : 'Vue')
                : (index < 3 ? 'Tokens' : 'Components')
        })))

        const service = createOrganizerService('test-key', ['Tech', 'Design'], () => {}, undefined, '5-10', true, false, false, false, 'desc', undefined, false)
        const results = await service.start(groupedLinks)

        expect(results.find(item => item.id === 'tech-0')).toMatchObject({
            category: 'Tech', sub_category: 'Frontend', detail_category: 'React'
        })
        expect(results.find(item => item.id === 'design-0')).toMatchObject({
            category: 'Design', sub_category: 'Systems', detail_category: 'Tokens'
        })
    })

    it('keeps same-parent ID-less duplicate URLs in their distinct detail folders', async () => {
        const duplicateLinks = Array.from({ length: 6 }, (_, index) => ({
            title: index === 0 ? 'React duplicate' : index === 3 ? 'Vue duplicate' : `Link ${index}`,
            url: index === 0 || index === 3 ? 'https://shared.test/bookmark' : `https://detail.test/${index}`
        }))
        vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map([['tech\u0000frontend', ['React', 'Vue']]]))
        vi.spyOn(ai, 'classifyDetailBatch').mockImplementation(async records => records.map((bookmark, index) => ({
            ...bookmark,
            detail_category: index < 3 ? 'React' : 'Vue'
        })))

        const service = createOrganizerService('test-key', ['Tech'], () => {}, undefined, '5-10', true, false, false, false, 'desc', undefined, false)
        const results = await service.start(duplicateLinks)

        expect(results.find(item => item.title === 'React duplicate')?.detail_category).toBe('React')
        expect(results.find(item => item.title === 'Vue duplicate')?.detail_category).toBe('Vue')
    })

    it('classifies a large detail parent in bounded chunks before reconciling all assignments', async () => {
        const largeGroup = Array.from({ length: 120 }, (_, index) => ({
            title: `Large detail ${index}`,
            url: `https://large-detail.test/${index}`
        }))
        const detailCalls = []
        vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map([['tech\u0000frontend', ['React', 'Vue']]]))
        vi.spyOn(ai, 'classifyDetailBatch').mockImplementation(async records => {
            detailCalls.push(records)
            return records.map(bookmark => ({
                ...bookmark,
                detail_category: Number(bookmark.title.replace('Large detail ', '')) % 2 === 0 ? 'React' : 'Vue'
            }))
        })

        const service = createOrganizerService('test-key', ['Tech'], () => {}, undefined, '5-10', true, false, false, false, 'desc', undefined, false)
        const results = await service.start(largeGroup)

        expect(detailCalls.map(records => records.length)).toEqual([50, 50, 20])
        expect(detailCalls.every(records => records.every(record => record.category === 'Tech' && record.sub_category === 'Frontend'))).toBe(true)
        expect(results.filter(item => item.detail_category === 'React')).toHaveLength(60)
        expect(results.filter(item => item.detail_category === 'Vue')).toHaveLength(60)
        expect(results.stats.detailFoldersCount).toBe(2)
    })

    it('summarizes detail progress and keeps valid siblings visible after a partial classification failure', async () => {
        const multiGroupLinks = Array.from({ length: 12 }, (_, index) => ({
            title: `Multi group ${index}`,
            url: `https://multi-detail.test/${index}`
        }))
        const multiGroupSchema = {
            categories: [{ name: 'Tech', sub_categories: ['Frontend', 'Backend'] }]
        }
        vi.spyOn(ai, 'generateSchema').mockResolvedValue(multiGroupSchema)
        vi.spyOn(ai, 'classifyBatch').mockResolvedValue(multiGroupLinks.map((bookmark, index) => ({
            ...bookmark,
            category: 'Tech',
            sub_category: index < 6 ? 'Frontend' : 'Backend'
        })))
        vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map([
            ['tech\u0000frontend', ['React', 'Vue']],
            ['tech\u0000backend', ['APIs', 'Servers']]
        ]))
        vi.spyOn(ai, 'classifyDetailBatch').mockImplementation(async (records) => {
            if (records[0].sub_category === 'Backend') throw new Error('detail classifier unavailable')
            return records.map((bookmark, index) => ({
                ...bookmark,
                detail_category: index < 3 ? 'React' : 'Vue'
            }))
        })
        const logs = []
        const service = createOrganizerService('test-key', ['Tech'], event => logs.push(event), undefined, '5-10', true, true, false, false, 'desc', undefined, false)

        const results = await service.start(multiGroupLinks)

        expect(results.filter(item => item.detail_category === 'React')).toHaveLength(3)
        expect(results.filter(item => item.detail_category === 'Vue')).toHaveLength(3)
        expect(results.filter(item => item.sub_category === 'Backend').every(item => item.detail_category === null)).toBe(true)
        expect(results.stats.detailFoldersCount).toBe(2)
        expect(results.stats.detailedSubcategories).toBe(1)
        expect(logs.some(event => event.message === 'Finding useful third-level groups for 2 eligible parent groups...')).toBe(true)
        expect(logs.some(event => event.message === 'Third-level enrichment summary: 2 eligible groups, 2 detail folders created, 1 detailed subcategory, 1 group kept at two levels.')).toBe(true)
        expect(logs.some(event => event.status === 'warning' && event.message.includes('tech/backend') && event.message.includes('detail classifier unavailable'))).toBe(true)
    })

    it('reports detail chunk retries with cancellation-aware callbacks', async () => {
        const retryEvents = []
        const cancellationChecks = []
        vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map([
            ['tech\u0000frontend', ['React', 'Vue']]
        ]))
        vi.spyOn(ai, 'classifyDetailBatch').mockImplementation(async (records, _apiKey, _names, _model, isCancelled, onRetry) => {
            cancellationChecks.push(isCancelled)
            onRetry({ delayMs: 8000, isRateLimit: true })
            retryEvents.push(true)
            return records.map((bookmark, index) => ({
                ...bookmark,
                detail_category: index < 3 ? 'React' : 'Vue'
            }))
        })
        const logs = []
        const service = createOrganizerService('test-key', ['Tech'], event => logs.push(event), undefined, '5-10', true, true, false, false, 'desc', undefined, false)

        const results = await service.start(links)

        expect(results.stats.detailFoldersCount).toBe(2)
        expect(retryEvents).toHaveLength(1)
        expect(cancellationChecks).toHaveLength(1)
        expect(cancellationChecks[0]()).toBe(false)
        expect(logs.some(event => event.message === 'Rate limit reached (429). Pausing for 8s before retrying detail chunk tech/frontend #1...')).toBe(true)
    })

    it('skips detail model calls when no group is eligible and bypasses them in flat mode', async () => {
        const detailSchemas = vi.spyOn(ai, 'generateDetailSchemas').mockResolvedValue(new Map())
        const detailClassifier = vi.spyOn(ai, 'classifyDetailBatch').mockResolvedValue([])
        detailSchemas.mockClear()
        detailClassifier.mockClear()
        const small = links.slice(0, 5)
        const service = createOrganizerService('test-key', ['Tech'], () => {}, undefined, '5-10', true, true, false, false, 'desc', undefined, false)
        await service.start(small)
        expect(detailSchemas).not.toHaveBeenCalled()
        expect(detailClassifier).not.toHaveBeenCalled()

        const flat = createOrganizerService('test-key', ['Tech'], () => {}, undefined, '5-10', true, true, false, true, 'desc', undefined, false)
        await flat.start(links)
        expect(detailSchemas).not.toHaveBeenCalled()
        expect(detailClassifier).not.toHaveBeenCalled()
    })

    it('keeps two-level output and warns when detail enrichment has no usable schemas, then returns cancellation', async () => {
        vi.spyOn(ai, 'generateDetailSchemas')
            .mockResolvedValueOnce(new Map())
            .mockResolvedValue(new Map([['tech\u0000frontend', ['React', 'Vue']]]))
        vi.spyOn(ai, 'classifyDetailBatch').mockResolvedValue(classified.map(item => ({ ...item, detail_category: 'React' })))
        const logs = []
        const sparse = createOrganizerService('test-key', ['Tech'], event => logs.push(event), undefined, '5-10', true, true, false, false, 'desc', undefined, false)
        const sparseResults = await sparse.start(links)
        expect(sparseResults.every(item => item.detail_category === null)).toBe(true)
        expect(logs.some(event => typeof event.message === 'string' && event.message.includes('Finding useful third-level groups'))).toBe(true)
        expect(logs).toContainEqual({
            status: 'warning',
            message: 'Third-level enrichment returned no usable folder schemas; keeping the two-level result.'
        })

        vi.spyOn(ai, 'classifyDetailBatch').mockImplementation(async (_records, _key, _names, _model, isCancelled) => {
            sparse.cancel()
            if (isCancelled()) { const error = new Error('Operation cancelled.'); error.isCancelled = true; throw error }
            return []
        })
        expect(await sparse.start(links)).toBeNull()
        expect(sparse.stats.detailFoldersCount).toBe(0)
        expect(sparse.stats.detailedSubcategories).toBe(0)
        expect(logs.some(event => event.status === 'warning' && event.message === 'Process cancelled.')).toBe(true)
    })
})

describe('withRetry resilient retry and cancellation', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('retries rate-limit errors up to 8 attempts with progressive backoff and caps at 60s', async () => {
        const rateLimitError = new Error('Resource exhausted / quota exceeded')
        rateLimitError.statusCode = 429

        const fn = vi.fn().mockRejectedValue(rateLimitError)
        const onRetry = vi.fn()

        const promise = withRetry(fn, 5, 1500, null, onRetry)
        const rejection = expect(promise).rejects.toThrow('Resource exhausted / quota exceeded')

        await vi.runAllTimersAsync()
        await rejection

        // 8 total attempts
        expect(fn).toHaveBeenCalledTimes(8)
        // 7 retry notifications
        expect(onRetry).toHaveBeenCalledTimes(7)

        for (let i = 0; i < 7; i++) {
            const call = onRetry.mock.calls[i][0]
            expect(call.attempt).toBe(i + 1)
            expect(call.isRateLimit).toBe(true)
            expect(call.error).toBe(rateLimitError)
            expect(call.delayMs).toBeLessThanOrEqual(60000)

            if (i === 0) {
                // 5000 * 1.8^0 * [0.8, 1.2] = 4000 to 6000
                expect(call.delayMs).toBeGreaterThanOrEqual(4000)
                expect(call.delayMs).toBeLessThanOrEqual(6000)
            }
        }
    })

    it('respects error.retryAfterMs when provided on rate-limit errors', async () => {
        const rateLimitError = new Error('Too many requests')
        rateLimitError.statusCode = 429
        rateLimitError.retryAfterMs = 12500

        const fn = vi.fn()
            .mockRejectedValueOnce(rateLimitError)
            .mockResolvedValueOnce({ success: true })
        const onRetry = vi.fn()

        const promise = withRetry(fn, 5, 1500, null, onRetry)
        await vi.runAllTimersAsync()
        const result = await promise

        expect(result).toEqual({ success: true })
        expect(fn).toHaveBeenCalledTimes(2)
        expect(onRetry).toHaveBeenCalledWith({
            attempt: 1,
            delayMs: 12500,
            error: rateLimitError,
            isRateLimit: true
        })
    })

    it('uses standard exponential backoff up to maxRetries (5) for other retryable errors', async () => {
        const serverError = new Error('Internal Server Error')
        serverError.statusCode = 500

        const fn = vi.fn().mockRejectedValue(serverError)
        const onRetry = vi.fn()

        const promise = withRetry(fn, 5, 1500, null, onRetry)
        const rejection = expect(promise).rejects.toThrow('Internal Server Error')

        await vi.runAllTimersAsync()
        await rejection

        expect(fn).toHaveBeenCalledTimes(5)
        expect(onRetry).toHaveBeenCalledTimes(4)
        onRetry.mock.calls.forEach(call => {
            expect(call[0].isRateLimit).toBe(false)
        })
    })

    it('throws immediately on non-retryable errors without retrying', async () => {
        const badRequestError = new Error('Bad Request')
        badRequestError.statusCode = 400

        const fn = vi.fn().mockRejectedValue(badRequestError)
        const onRetry = vi.fn()

        await expect(withRetry(fn, 5, 1500, null, onRetry)).rejects.toThrow('Bad Request')
        expect(fn).toHaveBeenCalledTimes(1)
        expect(onRetry).not.toHaveBeenCalled()
    })

    it('aborts backoff sleep immediately when isCancelled returns true', async () => {
        const error = new Error('Temporary gateway error')
        error.statusCode = 502

        let cancelled = false
        const isCancelled = () => cancelled

        const fn = vi.fn().mockRejectedValue(error)
        const onRetry = vi.fn(() => {
            // Cancel as soon as we enter the retry backoff
            cancelled = true
        })

        const promise = withRetry(fn, 5, 1500, isCancelled, onRetry)
        const rejection = expect(promise).rejects.toMatchObject({
            message: 'Operation cancelled.',
            isCancelled: true
        })

        // Advance only one 200ms sleep tick
        await vi.advanceTimersByTimeAsync(200)
        await rejection

        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('aborts immediately and tags isCancelled when cancelled during execution or retry', async () => {
        let callCount = 0
        const fn = vi.fn().mockImplementation(async () => {
            callCount++
            const err = new Error('Some retryable error')
            err.statusCode = 500
            throw err
        })

        const isCancelled = () => true

        const promise = withRetry(fn, 5, 1500, isCancelled)
        await expect(promise).rejects.toMatchObject({
            message: 'Operation cancelled.',
            isCancelled: true
        })
        expect(callCount).toBe(0)
    })

    it('immediately throws cancellation error if error caught has isCancelled true', async () => {
        const cancelErr = new Error('Operation cancelled.')
        cancelErr.isCancelled = true
        const fn = vi.fn().mockRejectedValue(cancelErr)

        const promise = withRetry(fn, 5, 1500, null)
        await expect(promise).rejects.toMatchObject({
            message: 'Operation cancelled.',
            isCancelled: true
        })
        expect(fn).toHaveBeenCalledTimes(1)
    })
})

describe('isNetworkError, isRateLimitError, and isRetryableError helpers', () => {
    it('accurately identifies network and timeout errors', () => {
        expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
        expect(isNetworkError(new Error('request timeout'))).toBe(true)
        expect(isNetworkError(new Error('NetworkError when attempting to fetch resource'))).toBe(true)
        expect(isNetworkError(new Error('connect ECONNRESET 127.0.0.1'))).toBe(true)
        expect(isNetworkError(new Error('getaddrinfo ENOTFOUND api.google.com'))).toBe(true)

        const abortError = new Error('The operation was aborted')
        abortError.name = 'AbortError'
        expect(isNetworkError(abortError)).toBe(true)

        const timeoutError = new Error('Timeout')
        timeoutError.name = 'TimeoutError'
        expect(isNetworkError(timeoutError)).toBe(true)

        const err502 = new Error('Bad Gateway')
        err502.statusCode = 502
        expect(isNetworkError(err502)).toBe(true)

        const err504 = new Error('Gateway Timeout')
        err504.statusCode = 504
        expect(isNetworkError(err504)).toBe(true)

        const err408 = new Error('Request Timeout')
        err408.statusCode = 408
        expect(isNetworkError(err408)).toBe(true)

        // Non-network errors
        expect(isNetworkError(new Error('model returned invalid JSON'))).toBe(false)
        expect(isNetworkError(new Error('model response was cut off at the max_tokens limit'))).toBe(false)
        const err401 = new Error('Unauthorized')
        err401.statusCode = 401
        expect(isNetworkError(err401)).toBe(false)
    })

    it('accurately identifies rate limit errors', () => {
        const err429 = new Error('Too Many Requests')
        err429.statusCode = 429
        expect(isRateLimitError(err429)).toBe(true)

        expect(isRateLimitError(new Error('Resource exhausted: quota exceeded'))).toBe(true)
        expect(isRateLimitError(new Error('rate limited — too many requests'))).toBe(true)

        expect(isRateLimitError(new Error('Internal Server Error'))).toBe(false)
        expect(isRateLimitError(new Error('Bad Request'))).toBe(false)
    })

    it('accurately identifies retryable errors', () => {
        const explicitRetryable = new Error('something failed')
        explicitRetryable.retryable = true
        expect(isRetryableError(explicitRetryable)).toBe(true)

        expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true)
        expect(isRetryableError(new Error('request timeout'))).toBe(true)

        const abortErr = new Error('Aborted')
        abortErr.name = 'AbortError'
        expect(isRetryableError(abortErr)).toBe(true)

        const err408 = new Error('Timeout')
        err408.statusCode = 408
        expect(isRetryableError(err408, 408)).toBe(true)

        const err500 = new Error('Server Error')
        err500.statusCode = 500
        expect(isRetryableError(err500, 500)).toBe(true)

        const err400 = new Error('Bad Request')
        err400.statusCode = 400
        expect(isRetryableError(err400, 400)).toBe(false)
    })
})

describe('classifyBatch and generateSchema default model and cancellation forwarding', () => {
    const originalFetch = global.fetch

    afterEach(() => {
        global.fetch = originalFetch
        vi.useRealTimers()
    })

    it('defaults model to google/gemini-3.1-flash-lite in classifyBatch', async () => {
        let capturedPayload = null
        global.fetch = vi.fn(async (url, options) => {
            capturedPayload = JSON.parse(options.body)
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    classified: [{ i: 0, category: 'Tech', sub_category: 'Code' }]
                                })
                            }
                        }
                    ]
                })
            }
        })

        const bookmarks = [{ title: 'Code Site', url: 'https://code.example.com' }]
        const schema = { categories: [{ name: 'Tech', sub_categories: ['Code'] }] }

        await classifyBatch(bookmarks, 'sk-or-test-key', schema)

        expect(capturedPayload.model).toBe('google/gemini-3.1-flash-lite')
    })

    it('defaults model to google/gemini-3.1-flash-lite in generateSchema', async () => {
        let capturedPayload = null
        global.fetch = vi.fn(async (url, options) => {
            capturedPayload = JSON.parse(options.body)
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    categories: [{ name: 'Tech', sub_categories: ['Coding'] }]
                                })
                            }
                        }
                    ]
                })
            }
        })

        const bookmarks = [{ title: 'Code Site', url: 'https://code.example.com' }]
        await generateSchema(bookmarks, 'sk-or-test-key', ['Tech'])

        expect(capturedPayload.model).toBe('google/gemini-3.1-flash-lite')
    })

    it('forwards isCancelled and onRetry from classifyBatch to withRetry', async () => {
        vi.useFakeTimers()

        global.fetch = vi.fn(async () => ({
            ok: false,
            status: 429,
            text: async () => 'Rate limit reached'
        }))

        let cancelled = false
        const retryEvents = []

        const bookmarks = [{ title: 'Example', url: 'https://example.com' }]
        const schema = { categories: [{ name: 'General', sub_categories: [] }] }

        const promise = classifyBatch(
            bookmarks,
            'sk-or-test-key',
            schema,
            'google/gemini-3.1-flash-lite',
            false,
            () => cancelled,
            (evt) => {
                retryEvents.push(evt)
                cancelled = true
            }
        )
        const rejection = expect(promise).rejects.toMatchObject({
            message: 'Operation cancelled.',
            isCancelled: true
        })

        await vi.advanceTimersByTimeAsync(200)
        await rejection

        expect(retryEvents.length).toBe(1)
        expect(retryEvents[0].isRateLimit).toBe(true)
    })
})

describe('OrganizerService resilient batch processing and sub-batch subdivision', () => {
    let originalFetch

    beforeEach(() => {
        originalFetch = global.fetch
        global.fetch = vi.fn(async () => ({ ok: true }))
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
    })

    it('defaults model to google/gemini-3.1-flash-lite in constructor', () => {
        const service = createOrganizerService('test-key', ['Tech'], () => {})
        expect(service.model).toBe('google/gemini-3.1-flash-lite')
    })

    it('subdivides failing batches in half recursively on retry until classification succeeds without dumping to Other -> General', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Engineering', sub_categories: ['Frontend', 'Backend'] }]
        })

        const bookmarks = Array.from({ length: 10 }, (_, i) => ({
            title: `Bookmark ${i + 1}`,
            url: `https://example.com/${i + 1}`
        }))

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        const classifyBatchSpy = vi.spyOn(ai, 'classifyBatch')
            // 1. Initial worker pass fails for all 10 items
            .mockRejectedValueOnce(new Error('Payload size limit or malformed output'))
            // 2. Retry pass on full 10 items fails again
            .mockRejectedValueOnce(new Error('Still failing with full batch'))
            // 3. Sub-batch 1 (items 1..5) succeeds
            .mockResolvedValueOnce(
                bookmarks.slice(0, 5).map(b => ({ ...b, category: 'Engineering', sub_category: 'Frontend' }))
            )
            // 4. Sub-batch 2 (items 6..10) succeeds
            .mockResolvedValueOnce(
                bookmarks.slice(5).map(b => ({ ...b, category: 'Engineering', sub_category: 'Backend' }))
            )

        const service = createOrganizerService('test-key', ['Engineering'], onProgress)
        const results = await service.start(bookmarks)

        // classifyBatch called 4 times: initial, retry-full, sub-batch 1, sub-batch 2
        expect(classifyBatchSpy).toHaveBeenCalledTimes(4)

        // Progress message logged sub-batch split
        const splitMsg = progressMessages.find(m => m.includes('Splitting batch 1 (10 items) into smaller chunks of 5'))
        expect(splitMsg).toBeDefined()

        // 100% of bookmarks classified cleanly — none dumped to Other -> General
        expect(results).toHaveLength(10)
        expect(results.every(b => b.category === 'Engineering')).toBe(true)
        expect(results.some(b => b.category === 'Other')).toBe(false)
        expect(results.some(b => b.sub_category === 'General')).toBe(false)
        expect(results.filter(b => b.sub_category === 'Frontend')).toHaveLength(5)
        expect(results.filter(b => b.sub_category === 'Backend')).toHaveLength(5)
    })

    it('falls back to the first selected category when batch size <= 5 and still fails on retry', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [
                { name: 'Engineering', sub_categories: [] },
                { name: 'Finance', sub_categories: [] }
            ]
        })

        const bookmarks = Array.from({ length: 4 }, (_, i) => ({
            title: `Bookmark ${i + 1}`,
            url: `https://example.com/${i + 1}`
        }))

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        // Both initial pass and retry pass fail
        vi.spyOn(ai, 'classifyBatch')
            .mockRejectedValueOnce(new Error('Unrecoverable parsing failure'))
            .mockRejectedValueOnce(new Error('Unrecoverable parsing failure'))

        const service = createOrganizerService('test-key', ['Engineering', 'Finance'], onProgress)
        const results = await service.start(bookmarks)

        expect(results).toHaveLength(4)
        // All 4 remain inside the selected hierarchy, under its deterministic
        // fallback category, so no unselected top-level folder is created.
        expect(results.every(b => b.category === 'Engineering' && b.sub_category === 'General')).toBe(true)

        const fallbackMsg = progressMessages.find(m => m.includes('Its 4 bookmarks were filed under Engineering → General so none are lost.'))
        expect(fallbackMsg).toBeDefined()
    })

    it('immediately stops processing and returns null when cancelled during schema generation', async () => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

        const progressEvents = []
        const onProgress = (evt) => progressEvents.push(evt)

        const service = createOrganizerService('test-key', ['Tech'], onProgress)

        vi.spyOn(ai, 'generateSchema').mockImplementation(async () => {
            service.cancel()
            const err = new Error('Operation cancelled.')
            err.isCancelled = true
            throw err
        })
        const classifyBatchSpy = vi.spyOn(ai, 'classifyBatch')

        const bookmarks = [{ title: 'Site', url: 'https://example.com' }]
        const result = await service.start(bookmarks)

        expect(result).toBeNull()
        expect(classifyBatchSpy).not.toHaveBeenCalled()
        expect(progressEvents).toContainEqual({ status: 'warning', message: 'Process cancelled.' })
    })

    it('immediately stops processing and returns null when cancelled during batch classification', async () => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: [] }]
        })

        const progressEvents = []
        const onProgress = (evt) => progressEvents.push(evt)

        const service = createOrganizerService('test-key', ['Tech'], onProgress)

        vi.spyOn(ai, 'classifyBatch').mockImplementation(async () => {
            service.cancel()
            return [{ title: 'Site', url: 'https://example.com', category: 'Tech', sub_category: 'General' }]
        })

        const bookmarks = [{ title: 'Site', url: 'https://example.com' }]
        const result = await service.start(bookmarks)

        expect(result).toBeNull()
        expect(bookmarksExport.downloadBookmarks).not.toHaveBeenCalled()
        expect(progressEvents).toContainEqual({ status: 'warning', message: 'Process cancelled.' })
    })

    it('reports rate limit and network retry notifications to onProgress callback', async () => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: [] }]
        })

        const progressEvents = []
        const onProgress = (evt) => progressEvents.push(evt)

        const service = createOrganizerService('test-key', ['Tech'], onProgress)

        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (b, key, sch, m, c, isCanc, onRetry) => {
            // Simulate rate-limit notification from withRetry
            onRetry({ attempt: 1, delayMs: 8000, isRateLimit: true, error: new Error('Rate limit') })
            // Simulate network issue notification
            onRetry({ attempt: 2, delayMs: 3000, isRateLimit: false, error: new Error('Network error') })
            return [{ title: 'Site', url: 'https://example.com', category: 'Tech', sub_category: 'General' }]
        })

        const bookmarks = [{ title: 'Site', url: 'https://example.com' }]
        await service.start(bookmarks)

        expect(progressEvents).toContainEqual({
            status: 'warning',
            message: 'Rate limit reached (429). Pausing for 8s before retrying batch 1...'
        })
        expect(progressEvents).toContainEqual({
            status: 'warning',
            message: 'Network issue on batch 1. Retrying in 3s...'
        })
    })

    it('does not recursively subdivide on permanent HTTP 404/401/403 errors', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Engineering', sub_categories: [] }]
        })

        const bookmarks = Array.from({ length: 20 }, (_, i) => ({
            title: `Bookmark ${i + 1}`,
            url: `https://example.com/${i + 1}`
        }))

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        const notFoundError = new Error('model not found — models/gemini-2.5-pro is no longer available')
        notFoundError.statusCode = 404

        vi.spyOn(ai, 'classifyBatch').mockRejectedValue(notFoundError)

        const service = createOrganizerService('test-key', ['Engineering'], onProgress)
        const results = await service.start(bookmarks)

        // It should NOT attempt to split 20 -> 10 -> 5
        expect(progressMessages.some(m => m.includes('Splitting batch'))).toBe(false)
        expect(results).toHaveLength(20)
        expect(results.every(b => b.category === 'Engineering' && b.sub_category === 'General')).toBe(true)
    })

    it('does not recursively subdivide on network errors or request timeouts', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Engineering', sub_categories: [] }]
        })

        const bookmarks = Array.from({ length: 20 }, (_, i) => ({
            title: `Bookmark ${i + 1}`,
            url: `https://example.com/${i + 1}`
        }))

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        const networkError = new TypeError('Failed to fetch')

        vi.spyOn(ai, 'classifyBatch').mockRejectedValue(networkError)

        const service = createOrganizerService('test-key', ['Engineering'], onProgress)
        const results = await service.start(bookmarks)

        // It should NOT attempt to split 20 -> 10 -> 5 when network fails
        expect(progressMessages.some(m => m.includes('Splitting batch'))).toBe(false)
        expect(results).toHaveLength(20)
        expect(results.every(b => b.category === 'Engineering' && b.sub_category === 'General')).toBe(true)
        const warningMsg = progressMessages.find(m => m.includes('Failed to fetch'))
        expect(warningMsg).toBeDefined()
    })

    it('does not recursively subdivide on 429 rate-limit errors or 5xx server errors', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Engineering', sub_categories: [] }]
        })

        const bookmarks = Array.from({ length: 20 }, (_, i) => ({
            title: `Bookmark ${i + 1}`,
            url: `https://example.com/${i + 1}`
        }))

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        const rateLimitErr = new Error('Resource exhausted / quota exceeded')
        rateLimitErr.statusCode = 429

        vi.spyOn(ai, 'classifyBatch').mockRejectedValue(rateLimitErr)

        const service = createOrganizerService('test-key', ['Engineering'], onProgress)
        const results = await service.start(bookmarks)

        // It should NOT attempt to split 20 -> 10 -> 5 on rate limits
        expect(progressMessages.some(m => m.includes('Splitting batch'))).toBe(false)
        expect(results).toHaveLength(20)
        expect(results.every(b => b.category === 'Engineering' && b.sub_category === 'General')).toBe(true)
    })

    it('aborts immediately and reports error when navigator.onLine is false for AI modes', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const originalOnLine = navigator.onLine
        Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

        try {
            const progressEvents = []
            const onProgress = (evt) => progressEvents.push(evt)

            const service = createOrganizerService('test-key', ['Tech'], onProgress)
            const bookmarks = [{ title: 'Site', url: 'https://example.com' }]
            const result = await service.start(bookmarks)

            expect(result).toBeNull()
            expect(progressEvents).toContainEqual({
                status: 'error',
                message: 'No internet connection detected. Please check your network and try again.'
            })
        } finally {
            Object.defineProperty(navigator, 'onLine', { value: originalOnLine, configurable: true })
        }
    })

    it('computes categoryBreakdown in stats and logs flat category tally to onProgress', async () => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [
                { name: 'Tech', sub_categories: [] },
                { name: 'News', sub_categories: [] }
            ]
        })

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'Site 1', url: 'https://site1.com', category: 'Tech', sub_category: 'Code' },
            { title: 'Site 2', url: 'https://site2.com', category: 'Tech', sub_category: 'Tools' },
            { title: 'Site 3', url: 'https://site3.com', category: 'News', sub_category: 'Daily' }
        ])

        const bookmarks = [
            { title: 'Site 1', url: 'https://site1.com' },
            { title: 'Site 2', url: 'https://site2.com' },
            { title: 'Site 3', url: 'https://site3.com' }
        ]

        const service = createOrganizerService('test-key', ['Tech', 'News'], onProgress)
        const results = await service.start(bookmarks)

        expect(service.stats.categoryBreakdown).toEqual({
            Tech: 2,
            News: 1
        })
        expect(results.stats.categoryBreakdown).toEqual({
            Tech: 2,
            News: 1
        })
        expect(progressMessages).toContain('Category breakdown:')
        expect(progressMessages).toContain('  • News: 1')
        expect(progressMessages).toContain('  • Tech: 2')
    })
})

describe('geminiModelId provider mapping and legacy model aliasing', () => {
    it('strips google/ prefix from standard model names', () => {
        expect(geminiModelId('google/gemini-3.1-flash-lite')).toBe('gemini-3.1-flash-lite')
        expect(geminiModelId('google/gemini-3.8-flash')).toBe('gemini-3.8-flash')
        expect(geminiModelId('google/gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview')
    })

    it('aliases deprecated gemini-2.5-pro to gemini-3.1-pro-preview', () => {
        expect(geminiModelId('google/gemini-2.5-pro')).toBe('gemini-3.1-pro-preview')
        expect(geminiModelId('gemini-2.5-pro')).toBe('gemini-3.1-pro-preview')
    })
})

describe('getBookmarkTimestamp', () => {
    it('normalizes Netscape epoch seconds to milliseconds', () => {
        expect(getBookmarkTimestamp({ add_date: '1609459200' })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ add_date: 1609459200 })).toBe(1609459200000)
    })

    it('preserves Chrome dateAdded milliseconds directly', () => {
        expect(getBookmarkTimestamp({ dateAdded: 1609459200000 })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ dateAdded: '1609459200000' })).toBe(1609459200000)
    })

    it('returns 0 for missing, null, or invalid dates', () => {
        expect(getBookmarkTimestamp(null)).toBe(0)
        expect(getBookmarkTimestamp({})).toBe(0)
        expect(getBookmarkTimestamp({ add_date: 'invalid' })).toBe(0)
        expect(getBookmarkTimestamp({ dateAdded: null })).toBe(0)
    })
})

describe('generateNetscapeHTML flat list generation', () => {
    it('generates a single flat list without DT/H3 folder headers when bookmarks have no category or isFlat is true', () => {
        const bookmarks = [
            { title: 'Alpha', url: 'https://alpha.com', add_date: '1600000000' },
            { title: 'Beta', url: 'https://beta.com', add_date: '1700000000' }
        ]
        bookmarks.isFlat = true

        const html = bookmarksExport.generateNetscapeHTML(bookmarks)
        expect(html).toContain('<TITLE>Bookmarks</TITLE>')
        expect(html).not.toContain('<H3')
        expect(html).toContain('<DT><A HREF="https://alpha.com" ADD_DATE="1600000000">Alpha</A>')
        expect(html).toContain('<DT><A HREF="https://beta.com" ADD_DATE="1700000000">Beta</A>')
    })
})

describe('OrganizerService flat chronological date sorting', () => {
    let downloadSpy

    beforeEach(() => {
        downloadSpy = vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        downloadSpy.mockClear()
    })

    it('uses the injected file download handler for uploaded bookmark files', async () => {
        const fileDownload = vi.fn()
        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '1-3',
            true,
            true,
            false,
            true,
            'desc',
            undefined,
            fileDownload
        )

        const results = await service.start([
            { title: 'Bookmark', url: 'https://example.com', add_date: '1700000000' }
        ])

        expect(fileDownload).toHaveBeenCalledWith(results)
        expect(bookmarksExport.downloadBookmarks).not.toHaveBeenCalled()
    })

    it('sorts bookmarks descending (newest first) and bypasses AI schema and classification', async () => {
        const schemaSpy = vi.spyOn(ai, 'generateSchema')
        const inferredSchemaSpy = vi.spyOn(ai, 'generateInferredSchema')
        const classifySpy = vi.spyOn(ai, 'classifyBatch')
        schemaSpy.mockClear()
        inferredSchemaSpy.mockClear()
        classifySpy.mockClear()

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt.message) progressMessages.push(evt.message)
        }

        const bookmarks = [
            { title: 'Oldest', url: 'https://oldest.com', add_date: '1500000000' },
            { title: 'Newest', url: 'https://newest.com', add_date: '1700000000' },
            { title: 'Middle', url: 'https://middle.com', add_date: '1600000000' }
        ]

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            onProgress,
            'google/gemini-3.1-flash-lite',
            '5-10',
            true, // sortAlphabetically
            true, // removeDuplicates
            false, // cleanTitles
            true, // flatDateSort
            'desc' // dateSortOrder (newest first)
        )

        const results = await service.start(bookmarks)

        expect(schemaSpy).not.toHaveBeenCalled()
        expect(inferredSchemaSpy).not.toHaveBeenCalled()
        expect(classifySpy).not.toHaveBeenCalled()

        expect(results.map(b => b.title)).toEqual(['Newest', 'Middle', 'Oldest'])
        expect(results.isFlat).toBe(true)
        expect(service.stats.isFlat).toBe(true)
        expect(service.stats.categoriesCount).toBe(0)
        expect(service.stats.categoryBreakdown).toEqual({})
        expect(service.stats.dateSpan).toBeTruthy()
        expect(progressMessages.some(m => m.includes('Sorting 3 bookmarks chronologically (Newest First)'))).toBe(true)
        expect(bookmarksExport.downloadBookmarks).toHaveBeenCalledWith(results)
    })

    it('sorts bookmarks ascending (oldest first)', async () => {
        const bookmarks = [
            { title: 'Newest', url: 'https://newest.com', add_date: '1700000000' },
            { title: 'Oldest', url: 'https://oldest.com', add_date: '1500000000' },
            { title: 'Middle', url: 'https://middle.com', add_date: '1600000000' }
        ]

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            false,
            true, // flatDateSort
            'asc' // dateSortOrder (oldest first)
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['Oldest', 'Middle', 'Newest'])
        expect(bookmarksExport.downloadBookmarks).toHaveBeenCalledWith(results)
    })

    it('cleans titles in flat mode when cleanTitles is enabled', async () => {
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => {
            return batch.map(b => ({
                ...b,
                title: b.title.replace(' - Site', '')
            }))
        })

        const bookmarks = [
            { title: 'Old Article - Site', url: 'https://old.com', add_date: '1500000000' },
            { title: 'New Article - Site', url: 'https://new.com', add_date: '1700000000' }
        ]

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            true, // cleanTitles enabled
            true, // flatDateSort
            'desc'
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['New Article', 'Old Article'])
        expect(results.every(b => b.category === null)).toBe(true)
        expect(bookmarksExport.downloadBookmarks).toHaveBeenCalledWith(results)
    })

    it('breaks timestamp ties alphabetically by title', async () => {
        const bookmarks = [
            { title: 'Zebra', url: 'https://zebra.com', add_date: '1600000000' },
            { title: 'Apple', url: 'https://apple.com', add_date: '1600000000' },
            { title: 'Mango', url: 'https://mango.com', add_date: '1600000000' }
        ]

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            false,
            true,
            'desc'
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['Apple', 'Mango', 'Zebra'])
    })

    it('removes duplicate URLs before chronological sorting when removeDuplicates is enabled', async () => {
        const bookmarks = [
            { title: 'First Copy', url: 'https://example.com', add_date: '1500000000' },
            { title: 'Second Copy', url: 'https://example.com', add_date: '1700000000' },
            { title: 'Unique Page', url: 'https://unique.com', add_date: '1600000000' }
        ]

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true, // removeDuplicates enabled
            false,
            true,
            'desc'
        )

        const results = await service.start(bookmarks)
        expect(results).toHaveLength(2)
        expect(service.stats.duplicatesRemoved).toBe(1)
        expect(results.map(b => b.url)).toEqual(['https://unique.com', 'https://example.com'])
    })

    it('moves existing browser nodes into the chronological folder instead of creating copies', async () => {
        const store = new FakeBookmarkStore()
        store.addFolder('2', 'chron-root-123', 'Chronological Bookmarks-2026-09-05')
        store.addUrl('1', '10', 'https://older.com', 'Older Link', 1500000000000)
        store.addUrl('1', '11', 'https://newer.com', 'Newer Link', 1700000000000)
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockResolvedValue({ id: 'chron-root-123', title: 'Chronological Bookmarks' })
        vi.spyOn(bookmarksService, 'createBookmark')
        wireStore(store)

        const service = createOrganizerService(
            'test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite',
            '5-10', true, true, false,
            true,  // flatDateSort
            'desc'
        )
        service.snapshotProvider = async () => {} // replaced by the real seam in Task 7; no-op keeps this test focused

        const results = await service.start(null)

        expect(results.map(b => b.title)).toEqual(['Newer Link', 'Older Link'])
        expect(bookmarksService.createBookmark).not.toHaveBeenCalled()
        expect(store.node('10').parentId).toBe('chron-root-123')
        expect(store.node('11').parentId).toBe('chron-root-123')
        expect(store.node('10').dateAdded).toBe(1500000000000)
    })

    it('collapses duplicate URLs by moving the oldest node and removing the rest', async () => {
        const store = new FakeBookmarkStore()
        store.addFolder('2', 'chron-root-123', 'Chronological Bookmarks')
        store.addUrl('1', '10', 'https://dupe.com', 'Dupe original', 1500000000000)
        store.addUrl('2', '12', 'https://dupe.com', 'Dupe mid', 1600000000000)
        store.addUrl('1', '13', 'https://dupe.com', 'Dupe newest', 1700000000000)
        store.addUrl('1', '14', 'https://unique.com', 'Unique', 1650000000000)
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockResolvedValue({ id: 'chron-root-123', title: 'Chronological Bookmarks' })
        wireStore(store)

        const service = createOrganizerService(
            'test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite',
            '5-10', true, true, false,
            true, 'desc'
        )
        service.snapshotProvider = async () => {}

        const results = await service.start(null)

        expect(service.stats.duplicatesRemoved).toBe(2)
        expect(store.node('12')).toBeUndefined()
        expect(store.node('13')).toBeUndefined()
        expect(store.node('10')).toBeDefined()
        expect(store.node('10').parentId).toBe('chron-root-123')
        expect(store.node('10').dateAdded).toBe(1500000000000)
        expect(results.map(b => b.url).sort()).toEqual(['https://dupe.com', 'https://unique.com'])
    })

    it('organizes browser bookmarks chronologically with labeled root folder and MECE Month & Year subfolders', async () => {
        const store = new FakeBookmarkStore();
        store.addFolder('2', 'other-root', 'Other Bookmarks');
        // November 2023
        store.addUrl('1', '101', 'https://nov2023.com', 'Nov 2023 Link', 1700000000000);
        // July 2017
        store.addUrl('1', '102', 'https://jul2017.com', 'Jul 2017 Link', 1500000000000);
        // Undated
        store.addUrl('1', '103', 'https://undated.com', 'Undated Link', 0);

        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree());

        const createdFolders = [];
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockImplementation(async (parentId, title) => {
            const id = `folder-${title}`;
            createdFolders.push({ parentId, title, id });
            store.addFolder(parentId, id, title);
            return { id, title };
        });
        wireStore(store);

        const service = createOrganizerService(
            'test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite',
            '5-10', true, false, false,
            true,  // flatDateSort
            'desc' // Newest First
        );
        service.snapshotProvider = async () => {};

        const results = await service.start(null);

        expect(results).toHaveLength(3);
        expect(service.stats.folderTitle).toMatch(/^\[Chronological - Newest First\] Bookmarks-\d{4}-\d{2}-\d{2}$/);
        expect(results.filename).toMatch(/^bookmarks_chronological_newest_\d{4}-\d{2}-\d{2}\.html$/);

        // Subfolders created inside root folder: November 2023, July 2017, Undated
        const rootFolder = createdFolders.find(f => f.title === service.stats.folderTitle);
        expect(rootFolder).toBeDefined();

        const subfolderTitles = createdFolders.filter(f => f.parentId === rootFolder.id).map(f => f.title);
        expect(subfolderTitles).toEqual(['November 2023', 'July 2017', 'Undated']);

        // Verify bookmark node parents in FakeBookmarkStore
        expect(store.node('101').parentId).toBe('folder-November 2023');
        expect(store.node('102').parentId).toBe('folder-July 2017');
        expect(store.node('103').parentId).toBe('folder-Undated');
    });

    it('organizes in AI categorized mode with standardized root folder title and filename', async () => {
        const store = new FakeBookmarkStore();
        store.addFolder('2', 'other-root', 'Other Bookmarks');
        store.addUrl('1', '201', 'https://tech.com', 'Tech Link', 1700000000000);

        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree());
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: [] }]
        });
        vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { id: '201', title: 'Tech Link', url: 'https://tech.com', category: 'Tech', sub_category: 'General' }
        ]);

        const createdFolders = [];
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockImplementation(async (parentId, title) => {
            const id = `folder-${title}`;
            createdFolders.push({ parentId, title, id });
            store.addFolder(parentId, id, title);
            return { id, title };
        });
        wireStore(store);

        const service = createOrganizerService(
            'test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite',
            '5-10', true, false, false,
            false, // AI Categorized mode
            'desc'
        );
        service.schemaSortOrder = 'date-desc';
        service.snapshotProvider = async () => {};

        const results = await service.start(null);

        expect(results).toHaveLength(1);
        expect(service.stats.folderTitle).toMatch(/^\[AI Categorized - Newest First\] Bookmarks-\d{4}-\d{2}-\d{2}$/);
        expect(results.filename).toMatch(/^bookmarks_ai_newest_\d{4}-\d{2}-\d{2}\.html$/);

        const rootFolder = createdFolders.find(f => f.title === service.stats.folderTitle);
        expect(rootFolder).toBeDefined();
    });

    it('post-write cancellation reports a partially reorganized state', async () => {
        const store = new FakeBookmarkStore()
        store.addFolder('2', 'chron-root-123', 'Chronological Bookmarks')
        for (let i = 0; i < 40; i++) {
            store.addUrl('1', String(100 + i), `https://site-${i}.com`, `Site ${i}`, 1500000000000 + i * 1000)
        }
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockResolvedValue({ id: 'chron-root-123', title: 'Chronological Bookmarks' })
        wireStore(store)
        // Throttle moves so cancel lands mid-write:
        let moves = 0
        bookmarksService.moveBookmark.mockImplementation(async (id, dest) => {
            if (++moves === 20) service.cancel()
            return store.move(id, dest)
        })

        const messages = []
        const service = createOrganizerService('test-key', ['Tech'], (d) => messages.push(d.message), 'google/gemini-3.1-flash-lite', '5-10', true, true, false, true, 'desc')
        service.snapshotProvider = async () => {}
        const results = await service.start(null)

        expect(results).toBeNull()
        expect(messages.some(m => m.includes('partially reorganized'))).toBe(true)
        expect(messages.some(m => m.includes('Run again to finish'))).toBe(true)
    })
})

describe('OrganizerService inferred category runs', () => {
    it('keeps saved manual categories dormant whenever inference is enabled', async () => {
        vi.clearAllMocks()
        const inferred = {
            categories: [{ name: 'Generated Topic', sub_categories: ['Generated Detail'] }]
        }
        const generateInferred = vi.spyOn(ai, 'generateInferredSchema').mockResolvedValue(inferred)
        const generateManual = vi.spyOn(ai, 'generateSchema')
        const classify = vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'Example', url: 'https://example.com', category: 'Generated Topic', sub_category: 'Generated Detail' }
        ])

        const service = createOrganizerService(
            'test-key', ['Saved Manual Category'], vi.fn(), undefined, undefined, undefined,
            undefined, undefined, false, undefined, undefined, true
        )
        await service.start([{ title: 'Example', url: 'https://example.com' }])

        expect(generateInferred).toHaveBeenCalled()
        expect(generateManual).not.toHaveBeenCalled()
        expect(classify.mock.calls[0][2]).toEqual(inferred)
    })

    it('reports full-collection analysis instead of sampled analysis in inference mode', async () => {
        vi.clearAllMocks()
        const inferred = {
            categories: [{ name: 'Generated Topic', sub_categories: ['Generated Detail'] }]
        }
        vi.spyOn(ai, 'generateInferredSchema').mockResolvedValue(inferred)
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async batch => batch.map(bookmark => ({
            ...bookmark,
            category: 'Generated Topic',
            sub_category: 'Generated Detail'
        })))
        const messages = []
        const bookmarks = Array.from({ length: 205 }, (_, index) => ({
            title: `Bookmark ${index + 1}`,
            url: `https://example.com/${index + 1}`
        }))
        const service = createOrganizerService(
            'test-key', ['Dormant Manual Category'], event => messages.push(event.message),
            undefined, undefined, undefined, undefined, undefined, false,
            undefined, undefined, true
        )

        await service.start(bookmarks)

        expect(messages).toContain('Large collection: analyzing all 205 bookmarks to infer the folder structure. All bookmarks will then be classified.')
        expect(messages.some(message => message?.includes('sample of 200'))).toBe(false)
    })

    it('classifies against the run-scoped inferred schema instead of replacing it with Other', async () => {
        vi.clearAllMocks()
        const inferred = {
            categories: [
                { name: 'Engineering', sub_categories: ['Frontend'] },
                { name: 'Research', sub_categories: ['Papers'] }
            ]
        }
        vi.spyOn(ai, 'generateInferredSchema').mockResolvedValue(inferred)
        const classify = vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'React', url: 'https://react.dev', category: 'Engineering', sub_category: 'Frontend' }
        ])

        const service = createOrganizerService(
            'test-key', [], vi.fn(), undefined, undefined, undefined,
            undefined, undefined, false, undefined, undefined, true
        )
        await service.start([{ title: 'React', url: 'https://react.dev' }])

        expect(classify.mock.calls[0][2]).toEqual(inferred)
        expect(classify.mock.calls[0][2].categories[0].name).not.toBe('Other')
    })

    it('stops when category inference fails instead of classifying against Other', async () => {
        vi.clearAllMocks()
        vi.spyOn(ai, 'generateInferredSchema').mockRejectedValue(new Error('invalid schema'))
        const classify = vi.spyOn(ai, 'classifyBatch')
        const progress = vi.fn()
        const service = createOrganizerService(
            'test-key', [], progress, undefined, undefined, undefined,
            undefined, undefined, false, undefined, undefined, true
        )

        await expect(service.start([{ title: 'React', url: 'https://react.dev' }]))
            .rejects.toThrow('invalid schema')

        expect(classify).not.toHaveBeenCalled()
        expect(progress).toHaveBeenCalledWith({
            status: 'error',
            message: 'Could not infer categories from your bookmarks: invalid schema'
        })
    })

    it('keeps selected categories authoritative in manual mode', async () => {
        vi.clearAllMocks()
        const generated = vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Unselected', sub_categories: ['Ignored'] }]
        })
        const inferred = vi.spyOn(ai, 'generateInferredSchema')
        const classify = vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'React', url: 'https://react.dev', category: 'Engineering', sub_category: 'Frontend' }
        ])
        const service = createOrganizerService(
            'test-key', ['Engineering'], vi.fn(), undefined, undefined, undefined,
            undefined, undefined, false, undefined, undefined, false
        )

        await service.start([{ title: 'React', url: 'https://react.dev' }])

        expect(generated).toHaveBeenCalled()
        expect(inferred).not.toHaveBeenCalled()
        expect(classify.mock.calls[0][2].categories.map(category => category.name)).toEqual(['Engineering'])
    })

    it('reports inferred categories in stats without persisting them through a storage API', async () => {
        vi.clearAllMocks()
        const inferred = {
            categories: [{ name: 'Engineering', sub_categories: ['Frontend'] }]
        }
        vi.spyOn(ai, 'generateInferredSchema').mockResolvedValue(inferred)
        vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'React', url: 'https://react.dev', category: 'Engineering', sub_category: 'Frontend' }
        ])
        const storageSet = vi.fn()
        const originalChrome = globalThis.chrome
        globalThis.chrome = { storage: { local: { set: storageSet } } }

        try {
            const service = createOrganizerService(
                'test-key', [], vi.fn(), undefined, undefined, undefined,
                undefined, undefined, false, undefined, undefined, true
            )
            const results = await service.start([{ title: 'React', url: 'https://react.dev' }])

            expect(results.stats.categoryBreakdown).toEqual({ Engineering: 1 })
            expect(results.stats.categoriesCount).toBe(1)
            expect(storageSet).not.toHaveBeenCalled()
        } finally {
            globalThis.chrome = originalChrome
        }
    })
})

describe('Category Presets and Suggestions', () => {
    it('orders Work & Career first and Tech & Development last in default categories', () => {
        expect(DEFAULT_CATEGORIES[0]).toBe('Work & Career')
        expect(DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1]).toBe('Tech & Development')
    })

    it('provides exactly 10 unique common suggested addable categories with no overlap in defaults', () => {
        expect(SUGGESTED_ADDABLE_CATEGORIES).toHaveLength(10)
        const uniqueSet = new Set(SUGGESTED_ADDABLE_CATEGORIES)
        expect(uniqueSet.size).toBe(10)
        for (const sug of SUGGESTED_ADDABLE_CATEGORIES) {
            expect(DEFAULT_CATEGORIES).not.toContain(sug)
        }
    })
})

describe('getBookmarkDomain', () => {
    it('extracts clean domain without leading www', () => {
        expect(getBookmarkDomain({ url: 'https://www.github.com/repo' })).toBe('github.com')
        expect(getBookmarkDomain({ url: 'http://www.google.com' })).toBe('google.com')
    })

    it('preserves subdomains other than www', () => {
        expect(getBookmarkDomain({ url: 'https://developer.mozilla.org/en-US/' })).toBe('developer.mozilla.org')
        expect(getBookmarkDomain({ url: 'https://api.v2.service.co.uk/test' })).toBe('api.v2.service.co.uk')
    })

    it('safely handles missing or malformed URLs', () => {
        expect(getBookmarkDomain(null)).toBe('')
        expect(getBookmarkDomain({})).toBe('')
        expect(getBookmarkDomain({ url: 'not-a-valid-url' })).toBe('')
    })
})

describe('SCHEMA_SORT_OPTIONS Configuration', () => {
    it('defines all 4 sorting strategies with valid metadata and icons', () => {
        expect(SCHEMA_SORT_OPTIONS).toHaveLength(4)
        const ids = SCHEMA_SORT_OPTIONS.map(o => o.id)
        expect(ids).toEqual(['alpha', 'date-desc', 'date-asc', 'domain'])
        for (const option of SCHEMA_SORT_OPTIONS) {
            expect(option.label).toBeTruthy()
            expect(option.badge).toBeTruthy()
            expect(option.desc).toBeTruthy()
            expect(option.icon).toBeDefined()
        }
    })
})

describe('Schema Folder Content Sorting (schemaSortOrder)', () => {
    beforeEach(() => {
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [
                { name: 'Tech', sub_categories: [] },
                { name: 'Design', sub_categories: [] }
            ]
        })

        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => {
            return batch.map(b => ({
                ...b,
                category: b.url.includes('design') ? 'Design' : 'Tech',
                sub_category: null
            }))
        })

        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('sorts bookmarks inside folders by Date Added (Newest First) when schemaSortOrder is date-desc', async () => {
        const bookmarks = [
            { title: 'Older Tech', url: 'https://tech.com/old', add_date: '1500000000' },
            { title: 'Newer Tech', url: 'https://tech.com/new', add_date: '1700000000' },
            { title: 'Oldest Design', url: 'https://design.com/oldest', add_date: '1400000000' },
            { title: 'Newest Design', url: 'https://design.com/newest', add_date: '1800000000' }
        ]

        const service = createOrganizerService(
            'test-key',
            ['Tech', 'Design'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            false, // sortAlphabetically
            true, // removeDuplicates
            false, // cleanTitles
            false, // flatDateSort
            'desc',
            'date-desc' // schemaSortOrder
        )

        const results = await service.start(bookmarks)

        // Selected category order is preserved, with newest first inside each.
        expect(results.map(b => b.title)).toEqual([
            'Newer Tech',
            'Older Tech',
            'Newest Design',
            'Oldest Design'
        ])
        expect(service.stats.schemaSortOrder).toBe('date-desc')
        expect(service.stats.isFlat).toBe(false)
    })

    it('sorts bookmarks inside folders by Date Added (Oldest First) when schemaSortOrder is date-asc', async () => {
        const bookmarks = [
            { title: 'Newer Tech', url: 'https://tech.com/new', add_date: '1700000000' },
            { title: 'Older Tech', url: 'https://tech.com/old', add_date: '1500000000' }
        ]

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            false,
            true,
            false,
            false,
            'desc',
            'date-asc'
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['Older Tech', 'Newer Tech'])
        expect(service.stats.schemaSortOrder).toBe('date-asc')
    })

    it('sorts bookmarks inside folders by Website Domain A-Z when schemaSortOrder is domain', async () => {
        const bookmarks = [
            { title: 'YouTube Video', url: 'https://www.youtube.com/watch?v=123' },
            { title: 'GitHub Repo B', url: 'https://github.com/repo-b' },
            { title: 'GitHub Repo A', url: 'https://github.com/repo-a' },
            { title: 'ArXiv Paper', url: 'https://arxiv.org/abs/1234' }
        ]

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            false,
            true,
            false,
            false,
            'desc',
            'domain'
        )

        const results = await service.start(bookmarks)
        // Domains: arxiv.org -> github.com -> youtube.com
        // Within github.com: tie-breaks by title A-Z
        expect(results.map(b => b.title)).toEqual([
            'ArXiv Paper',
            'GitHub Repo A',
            'GitHub Repo B',
            'YouTube Video'
        ])
        expect(service.stats.schemaSortOrder).toBe('domain')
    })

    it('sorts bookmarks inside folders alphabetically when schemaSortOrder is alpha', async () => {
        const bookmarks = [
            { title: 'Zeta Tech', url: 'https://tech.com/zeta' },
            { title: 'Alpha Tech', url: 'https://tech.com/alpha' },
            { title: 'Beta Tech', url: 'https://tech.com/beta' }
        ]

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            false,
            false,
            'desc',
            'alpha'
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['Alpha Tech', 'Beta Tech', 'Zeta Tech'])
        expect(service.stats.schemaSortOrder).toBe('alpha')
    })
})

describe('calculateDateSpan', () => {
    it('returns null for empty, null, or undated bookmark collections', () => {
        expect(calculateDateSpan(null)).toBeNull()
        expect(calculateDateSpan([])).toBeNull()
        expect(calculateDateSpan([{ title: 'No Date', url: 'https://example.com' }])).toBeNull()
        expect(calculateDateSpan([{ title: 'Zero Date', url: 'https://example.com', add_date: '0' }])).toBeNull()
    })

    it('keeps the oldest-to-newest range format when all bookmarks share the same day', () => {
        // 1609459200 = 2021-01-01T00:00:00.000Z
        const singleDayBookmarks = [
            { title: 'Morning', url: 'https://a.com', add_date: '1609459200' },
            { title: 'Noon', url: 'https://b.com', add_date: '1609470000' }
        ]
        const expectedDate = new Date(1609459200000).toLocaleDateString()
        expect(calculateDateSpan(singleDayBookmarks)).toBe(`${expectedDate} – ${expectedDate}`)
    })

    it('returns formatted oldest to newest range matching the oldest and newest bookmarks', () => {
        const bookmarks = [
            { title: 'Middle', url: 'https://b.com', add_date: '1600000000' }, // 2020-09-13
            { title: 'Oldest', url: 'https://a.com', add_date: '1500000000' }, // 2017-07-14
            { title: 'Newest', url: 'https://c.com', add_date: '1700000000' }  // 2023-11-14
        ]
        const oldestDate = new Date(1500000000000).toLocaleDateString()
        const newestDate = new Date(1700000000000).toLocaleDateString()
        expect(calculateDateSpan(bookmarks)).toBe(`${oldestDate} – ${newestDate}`)
    })

    it('handles large collections without stack overflow', () => {
        const largeList = Array.from({ length: 70000 }, (_, i) => ({
            title: `Item ${i}`,
            url: `https://example.com/${i}`,
            add_date: `${1500000000 + i}`
        }))
        const span = calculateDateSpan(largeList)
        const oldestDate = new Date(1500000000000).toLocaleDateString()
        const newestDate = new Date((1500000000 + 69999) * 1000).toLocaleDateString()
        expect(span).toBe(`${oldestDate} – ${newestDate}`)
    })
})

describe('total date range in categorized mode and oldest first sorting', () => {
    beforeEach(() => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
    })

    it('computes total date range (dateSpan) across all categorized bookmarks and logs it', async () => {
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: [] }]
        })
        vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'Oldest Link', url: 'https://old.com', add_date: '1500000000', category: 'Tech', sub_category: 'Code' },
            { title: 'Newest Link', url: 'https://new.com', add_date: '1700000000', category: 'Tech', sub_category: 'Code' }
        ])

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        const bookmarks = [
            { title: 'Oldest Link', url: 'https://old.com', add_date: '1500000000' },
            { title: 'Newest Link', url: 'https://new.com', add_date: '1700000000' }
        ]

        const service = createOrganizerService('test-key', ['Tech'], onProgress)
        const results = await service.start(bookmarks)

        const oldestDate = new Date(1500000000000).toLocaleDateString()
        const newestDate = new Date(1700000000000).toLocaleDateString()
        const expectedSpan = `${oldestDate} – ${newestDate}`

        expect(service.stats.dateSpan).toBe(expectedSpan)
        expect(results.stats.dateSpan).toBe(expectedSpan)
        expect(progressMessages.some(m => m.includes(`Total date range: ${expectedSpan}`))).toBe(true)
    })

    it('pushes undated bookmarks to the bottom in flat chronological ascending (oldest first) sort', async () => {
        const bookmarks = [
            { title: 'No Date Bookmark', url: 'https://nodate.com' },
            { title: 'Newer Bookmark', url: 'https://newer.com', add_date: '1700000000' },
            { title: 'Older Bookmark', url: 'https://older.com', add_date: '1500000000' }
        ]

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            false,
            true, // flatDateSort
            'asc' // dateSortOrder (oldest first)
        )

        const results = await service.start(bookmarks)
        // Older (1500000000) should be first, then Newer (1700000000), then No Date at bottom
        expect(results.map(b => b.title)).toEqual(['Older Bookmark', 'Newer Bookmark', 'No Date Bookmark'])
    })

    it('pushes undated bookmarks to the bottom inside folders for date-asc schemaSortOrder', async () => {
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: [] }]
        })
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => {
            return batch.map(b => ({ ...b, category: 'Tech', sub_category: 'General' }))
        })

        const bookmarks = [
            { title: 'Undated Tech', url: 'https://tech.com/undated' },
            { title: 'Newest Tech', url: 'https://tech.com/newest', add_date: '1700000000' },
            { title: 'Oldest Tech', url: 'https://tech.com/oldest', add_date: '1500000000' }
        ]

        const service = createOrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            false,
            true,
            false,
            false,
            'desc',
            'date-asc'
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['Oldest Tech', 'Newest Tech', 'Undated Tech'])
    })
})

describe('Netscape HTML export and timestamp parsing', () => {
    it('includes Date range in the Netscape HTML header comment when dateSpan is present', () => {
        const bookmarks = [
            { title: 'Old Link', url: 'https://old.com', add_date: '1500000000' },
            { title: 'New Link', url: 'https://new.com', add_date: '1700000000' }
        ]
        const html = bookmarksExport.generateNetscapeHTML(bookmarks)
        expect(html).toContain('<!-- This is an automatically generated file.')
        expect(html).toContain('Date range:')
        expect(html).toContain(calculateDateSpan(bookmarks))
    })

    it('getBookmarkTimestamp accurately parses milliseconds, seconds, and ISO strings across all field names', () => {
        expect(getBookmarkTimestamp({ dateAdded: 1609459200000 })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ dateAdded: 1609459200 })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ dateAdded: '1609459200000' })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ date_added: 1609459200000 })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ add_date: 1609459200 })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ ADD_DATE: '1609459200' })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ date: '2021-01-01T00:00:00.000Z' })).toBe(1609459200000)
        expect(getBookmarkTimestamp(null)).toBe(0)
        expect(getBookmarkTimestamp({})).toBe(0)
    })
})

describe('schema fallback path reporting', () => {
    let originalFetch

    const bookmarks = Array.from({ length: 300 }, (_, i) => ({
        title: `Bookmark ${i}`,
        url: `https://example.com/${i}`
    }))

    const healthySchema = {
        categories: [
            { name: 'Engineering', sub_categories: ['Frontend', 'Backend', 'Infra'] },
            { name: 'Finance', sub_categories: ['Trading', 'Crypto', 'Banking'] },
            { name: 'Travel', sub_categories: ['Flights', 'Hotels', 'Guides'] }
        ]
    }

    const run = async (generateSchemaImpl) => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) =>
            batch.map(b => ({ ...b, category: 'Engineering', sub_category: 'Frontend' }))
        )
        const spy = vi.spyOn(ai, 'generateSchema').mockImplementation(generateSchemaImpl)

        const events = []
        const service = createOrganizerService('test-key', ['Engineering', 'Finance', 'Travel'], (e) => events.push(e))
        await service.start(bookmarks)

        return { spy, events, messages: events.map(e => e.message).filter(Boolean) }
    }

    beforeEach(() => {
        originalFetch = global.fetch
        global.fetch = vi.fn(async () => ({ ok: true }))
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
    })

    it('hands the reduced-sample retry the whole collection and a halved sample limit', async () => {
        let call = 0
        const { spy } = await run(async () => {
            if (call++ === 0) throw new Error('token ceiling')
            return healthySchema
        })

        // Taking the head of a folder-grouped export would design the whole
        // structure from one corner of the collection; the spacing lives in
        // generateSchema, so it is handed everything plus a smaller limit.
        const [retryBookmarks, , , , , , , sampleLimit] = spy.mock.calls.at(-1)
        expect(retryBookmarks).toHaveLength(bookmarks.length)
        expect(sampleLimit).toBe(Math.floor(ai.SCHEMA_SAMPLE_LIMIT / 2))
    })

    it('describes the corrective round-trip instead of calling it a network issue', async () => {
        const { messages } = await run(async (...args) => {
            const onRetry = args[6]
            onRetry({ attempt: 1, delayMs: 0, error: new Error('the structure is flat overall'), isRateLimit: false, isSchemaCorrection: true })
            return healthySchema
        })

        expect(messages.some(m => m.includes('too flat (the structure is flat overall)'))).toBe(true)
        expect(messages.some(m => m.includes('Network issue during schema generation'))).toBe(false)
    })

    it('reports the curated fallback without flipping the run into a terminal error state', async () => {
        const { events, messages } = await run(async () => {
            const err = new Error('nope')
            err.statusCode = 400
            throw err
        })

        expect(messages.some(m => m.includes('used built-in default folders'))).toBe(true)
        // `status: 'error'` is a lifecycle signal: it would strand the panel on
        // a failure screen for the rest of a run that is still going.
        expect(events.some(e => e.status === 'error')).toBe(false)
        // M3: the shape of the degraded structure is logged here too.
        expect(messages.filter(m => m.startsWith('Schema:'))).toHaveLength(1)
    })
})

describe('fixed hierarchy placement and export', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('reorders reused category folders to the selected rank and leaves a repeated run unchanged', async () => {
        const store = new FakeBookmarkStore()
        const root = store.addFolder('2', 'organized', 'AI Organized Bookmarks-' + new Date().toISOString().slice(0, 10))
        store.addFolder(root.id, 'finance', 'Finance')
        store.addFolder(root.id, 'tech', 'Tech')
        store.addUrl('finance', '10', 'https://finance.example', 'Finance link', 1500000000000)
        store.addUrl('tech', '11', 'https://tech.example', 'Tech link', 1500000000001)
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({ categories: [
            { name: 'Tech', sub_categories: [] }, { name: 'Finance', sub_categories: [] }
        ] })
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async batch => batch.map(b => ({
            ...b, category: b.id === '10' ? 'Finance' : 'Tech', sub_category: 'General'
        })))
        wireStore(store)
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockImplementation(async (parentId, title) =>
            store.node(parentId).children.find(n => !n.url && n.title === title))
        const service = createOrganizerService('test-key', ['Tech', 'Finance'], () => {})
        service.snapshotProvider = async () => {}

        await service.start(null)
        expect(root.children.map(n => n.title)).toEqual(['Tech', 'Finance'])
        expect(store.ops).toEqual([['move', 'tech', { parentId: root.id, index: 0 }]])
        await service.start(null)
        expect(store.ops).toHaveLength(1)
    })

    it.each(['alpha', 'date-desc', 'date-asc', 'domain', 'none'].flatMap(sortOrder =>
        [['Tech', 'Finance'], ['20', '3']].map(selected => ({ sortOrder, selected }))
    ))('preserves $selected category rank in browser placement and export with $sortOrder sorting', async ({ sortOrder, selected }) => {
        const [firstCategory, secondCategory] = selected
        const store = new FakeBookmarkStore()
        const schema = { categories: [
            { name: secondCategory, sub_categories: ['Investing'] },
            { name: firstCategory, sub_categories: ['Zeta Tools', 'Alpha Tools'] }
        ] }
        const classifications = new Map()
        // Input and model category order both disagree with the selected rank.
        for (const [group, category, sub_category] of [[0, secondCategory, 'Investing'], [1, firstCategory, 'Zeta Tools'], [2, firstCategory, 'Alpha Tools']]) {
            for (const [i, title, domain, dateAdded] of [[0, 'Bravo', 'z.example', 1700000000000], [1, 'Charlie', 'a.example', 1500000000000], [2, 'Alpha', 'm.example', 1600000000000]]) {
                const id = String(10 + group * 3 + i)
                store.addUrl('1', id, `https://${domain}/${id}`, title, dateAdded)
                classifications.set(id, { category, sub_category })
            }
        }
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
        vi.spyOn(ai, 'generateSchema').mockResolvedValue(schema)
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async batch => batch.map(b => ({ ...b, ...classifications.get(b.id) })))
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        wireStore(store)
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockImplementation(async (parentId, title) => {
            const found = store.node(parentId).children.find(n => !n.url && n.title === title)
            return found || store.addFolder(parentId, `folder-${parentId}-${title}`, title)
        })

        const service = createOrganizerService('test-key', selected, () => {}, undefined, '5-10', false, true, false, false, 'desc', sortOrder)
        service.snapshotProvider = async () => {}
        const browserResults = await service.start(null)
        const fileResults = await service.start([...classifications.keys()].map(id => ({ ...store.node(id) })))
        const root = store.node('2').children.find(n => n.title.startsWith('AI Organized') || n.title.startsWith('[AI Categorized'))

        expect(root.children.map(n => n.title)).toEqual(selected)
        const tech = root.children[0]
        expect(tech.children.map(n => n.title)).toEqual(['Alpha Tools', 'Zeta Tools'])
        const expectedTitles = {
            alpha: ['Alpha', 'Bravo', 'Charlie'],
            'date-desc': ['Bravo', 'Alpha', 'Charlie'],
            'date-asc': ['Charlie', 'Alpha', 'Bravo'],
            domain: ['Charlie', 'Alpha', 'Bravo'],
            none: ['Bravo', 'Charlie', 'Alpha']
        }[sortOrder]
        expect(tech.children[0].children.map(n => n.title)).toEqual(expectedTitles)
        for (const results of [browserResults, fileResults]) {
            expect([...new Set(results.map(b => b.category))]).toEqual(selected)
            const html = bookmarksExport.generateNetscapeHTML(results)
            const doc = new DOMParser().parseFromString(html, 'text/html')
            expect([...doc.querySelectorAll('h3')].map(n => n.textContent)).toEqual([
                firstCategory, 'Alpha Tools', 'Zeta Tools', secondCategory, 'Investing'
            ])
            expect([...doc.querySelectorAll('a')].slice(0, 3).map(n => n.textContent)).toEqual(expectedTitles)
        }
        expect(bookmarksExport.downloadBookmarks).toHaveBeenLastCalledWith(fileResults)
    })

    it('blocks cross-category whitespace variants and preserves approved plurals through reconciliation and placement', async () => {
        const store = new FakeBookmarkStore()
        for (let i = 0; i < 6; i++) store.addUrl('1', String(10 + i), `https://example.com/${i}`, `Bookmark ${i}`, 1500000000000 + i)
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({ categories: [
            { name: 'Tech', sub_categories: ['Developer Tools'] },
            { name: 'Finance', sub_categories: ['Index Funds'] }
        ] })
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async batch => batch.map(b => ({
            ...b, category: 'Tech', sub_category: Number(b.id) < 13 ? 'Index  Funds' : 'Developer Tool', proposed: true
        })))
        wireStore(store)
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockImplementation(async (parentId, title) =>
            store.node(parentId).children.find(n => !n.url && n.title === title) || store.addFolder(parentId, `folder-${parentId}-${title}`, title))

        const service = createOrganizerService('test-key', ['Tech', 'Finance'], () => {})
        service.snapshotProvider = async () => {}
        const results = await service.start(null)
        const tech = [...store.nodes.values()].find(n => !n.url && n.title === 'Tech')
        expect(tech.children.filter(n => !n.url).map(n => n.title)).toEqual(['Developer Tools'])
        expect(['10', '11', '12'].every(id => store.node(id).parentId === tech.id)).toBe(true)
        expect(tech.children.find(n => n.title === 'Developer Tools').children.map(n => n.id)).toEqual(['13', '14', '15'])
        expect(results.every(b => !('proposed' in b))).toBe(true)
        const html = bookmarksExport.generateNetscapeHTML(results)
        expect(html).toContain('>Developer Tools</H3>')
        expect(html).not.toContain('>Index Funds</H3>')
        expect(html).not.toContain('>Index  Funds</H3>')
    })
})

describe('categorized browser write moves and isolates failures', () => {
    const arrangeCategorized = (store) => {
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
        vi.spyOn(bookmarksService, 'createBookmark')
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({ categories: [{ name: 'Tech', sub_categories: [] }] })
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => batch.map(b => ({ ...b, category: 'Tech', sub_category: 'General' })))
        wireStore(store)
    }

    it('categorized browser mode moves nodes into category folders, keeping dates', async () => {
        const store = new FakeBookmarkStore()
        store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
        arrangeCategorized(store)
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockImplementation(async (parentId, title) => {
            const found = [...store.nodes.values()].find(n => n.parentId === parentId && n.title === title && !n.url)
            if (found) return found
            const id = `folder-${title}`
            return store.addFolder(parentId, id, title)
        })

        const service = createOrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', false, true, false, false, 'desc', 'alpha')
        service.snapshotProvider = async () => {}
        const results = await service.start(null)

        expect(results).not.toBeNull()
        expect(bookmarksService.createBookmark).not.toHaveBeenCalled()
        expect(store.node('10').parentId).toBe('folder-Tech')
        expect(store.node('10').dateAdded).toBe(1500000000000)
    })

    it('places approved subcategories only beneath their selected category', async () => {
        const store = new FakeBookmarkStore()
        store.addUrl('1', '10', 'https://tech.example', 'Tech', 1500000000000)
        store.addUrl('1', '11', 'https://invented.example', 'Invented', 1500000000001)
        store.addUrl('1', '12', 'https://finance-1.example', 'Finance 1', 1500000000002)
        store.addUrl('1', '13', 'https://finance-2.example', 'Finance 2', 1500000000003)
        store.addUrl('1', '14', 'https://finance-3.example', 'Finance 3', 1500000000004)
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [
                { name: 'Tech', sub_categories: ['Developer Tools'] },
                { name: 'Finance', sub_categories: ['Investing'] }
            ]
        })
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => batch.map(bookmark => {
            if (bookmark.id === '10') return { ...bookmark, category: 'Tech', sub_category: 'Investing' }
            if (bookmark.id === '11') return { ...bookmark, category: 'Invented', sub_category: 'Developer Tools' }
            if (bookmark.id === '12') return { ...bookmark, category: 'Finance', sub_category: ' investing ' }
            if (bookmark.id === '13') return { ...bookmark, category: 'Finance', sub_category: 'INVESTING' }
            return { ...bookmark, category: 'Finance', sub_category: 'Investing' }
        }))
        wireStore(store)
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockImplementation(async (parentId, title) => {
            const found = [...store.nodes.values()].find(n => n.parentId === parentId && n.title === title && !n.url)
            if (found) return found
            return store.addFolder(parentId, `folder-${parentId}-${title}`, title)
        })

        const service = createOrganizerService('test-key', ['Tech', 'Finance'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', false, true, false, false, 'desc', 'alpha')
        service.snapshotProvider = async () => {}
        await service.start(null)

        const techFolder = [...store.nodes.values()].find(n => n.title === 'Tech' && (n.parentId.startsWith('folder-2-AI Organized') || n.parentId.startsWith('folder-2-[AI Categorized')))
        const financeFolder = [...store.nodes.values()].find(n => n.title === 'Finance' && (n.parentId.startsWith('folder-2-AI Organized') || n.parentId.startsWith('folder-2-[AI Categorized')))
        const investingFolder = [...store.nodes.values()].find(n => n.title === 'Investing' && n.parentId === financeFolder.id)

        expect(store.node('10').parentId).toBe(techFolder.id)
        expect(store.node('11').parentId).toBe(techFolder.id)
        expect(store.node('12').parentId).toBe(investingFolder.id)
        expect(store.node('13').parentId).toBe(investingFolder.id)
        expect(store.node('14').parentId).toBe(investingFolder.id)
        expect([...store.nodes.values()].some(n => n.title === 'Invented' && !n.url)).toBe(false)
        expect([...store.nodes.values()].some(n => n.title === 'Investing' && n.parentId === techFolder.id)).toBe(false)
        expect([...store.nodes.values()].filter(n => n.parentId === financeFolder.id && !n.url).map(n => n.title)).toEqual(['Investing'])
    })

    it('a category-folder failure fails only that item and records it', async () => {
        const store = new FakeBookmarkStore()
        store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
        arrangeCategorized(store)
        // First call creates the root; the category folder then fails.
        vi.spyOn(bookmarksService, 'findOrCreateFolder')
            .mockResolvedValueOnce(store.addFolder('2', 'org-root-1', 'AI Organized Bookmarks-2026-09-05'))
            .mockRejectedValue(new Error('quota exceeded'))

        const service = createOrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', false, true, false, false, 'desc', 'alpha')
        service.snapshotProvider = async () => {}
        const results = await service.start(null)

        expect(results).not.toBeNull()
        expect(service.failedMoves).toEqual([{ title: 'A', reason: 'quota exceeded' }])
        expect(store.node('10').parentId).toBe('1') // untouched
    })

    it('a failed move records failedMoves but does not abort the run', async () => {
        const store = new FakeBookmarkStore()
        store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
        store.addUrl('1', '11', 'https://b.com', 'B', 1600000000000)
        arrangeCategorized(store)
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockImplementation(async (parentId, title) => {
            const found = [...store.nodes.values()].find(n => n.parentId === parentId && n.title === title && !n.url)
            if (found) return found
            const id = `folder-${title}`
            return store.addFolder(parentId, id, title)
        })
        bookmarksService.moveBookmark.mockImplementation(async (id, dest) => {
            if (id === '10') throw new Error('node not found')
            return store.move(id, dest)
        })

        const service = createOrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', false, true, false, false, 'desc', 'alpha')
        service.snapshotProvider = async () => {}
        const results = await service.start(null)

        expect(results).not.toBeNull()
        expect(service.failedMoves).toEqual([{ title: 'A', reason: 'node not found' }])
        expect(store.node('11').parentId).toBe('folder-Tech') // the healthy sibling still moved
        expect(store.node('10').parentId).toBe('1')
    })

    it('reports failedMoves in stats and logs the count', async () => {
        const logs = []
        const store = new FakeBookmarkStore()
        store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
        arrangeCategorized(store)
        vi.spyOn(bookmarksService, 'findOrCreateFolder')
            .mockResolvedValueOnce(store.addFolder('2', 'org-root-1', 'AI Organized Bookmarks-2026-09-05'))
            .mockRejectedValue(new Error('quota exceeded'))

        const service = createOrganizerService('test-key', ['Tech'], (d) => d.message && logs.push(d.message), 'google/gemini-3.1-flash-lite', '5-10', false, true, false, false, 'desc', 'alpha')
        service.snapshotProvider = async () => {}
        await service.start(null)

        expect(service.stats.failedMoves).toEqual([{ title: 'A', reason: 'quota exceeded' }])
        expect(logs.some(m => m.includes('1 move failed'))).toBe(true)
    })
})

describe('Phase B reorder pass and idempotency', () => {
    it('reorders only misplaced nodes in a folder', async () => {
        const store = new FakeBookmarkStore()
        // children in wrong order: 12, 10, 11; expected: 10, 11, 12
        store.addFolder('2', 'f1', 'Folder')
        store.addUrl('f1', '12', 'https://c.com', 'C', 1700000000000)
        store.addUrl('f1', '10', 'https://a.com', 'A', 1500000000000)
        store.addUrl('f1', '11', 'https://b.com', 'B', 1600000000000)
        wireStore(store)

        const service = createOrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite')
        await service.reorderFolder('f1', ['10', '11', '12'])

        const childIds = (await store.childrenOf('f1')).map(c => c.id)
        expect(childIds).toEqual(['10', '11', '12'])
        expect(store.ops.filter(([op]) => op === 'move')).toHaveLength(2) // 10 and 11 moved; 12 already home
    })

    it('a second identical organize run issues zero moves and zero removes (idempotency)', async () => {
        // Same arrangement as Task 4's move test, run twice:
        const store = new FakeBookmarkStore()
        store.addFolder('2', 'chron-root-123', 'Chronological Bookmarks')
        store.addUrl('1', '10', 'https://older.com', 'Older Link', 1500000000000)
        store.addUrl('1', '11', 'https://newer.com', 'Newer Link', 1700000000000)
        // rootTree() wraps the LIVE root node, so run 2 reads run 1's mutations
        // through this same mock — no fixture rebuild, and never re-add the folder.
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockResolvedValue({ id: 'chron-root-123', title: 'Chronological Bookmarks' })
        wireStore(store)
        const service = createOrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', true, true, false, true, 'desc')
        service.snapshotProvider = async () => {} // installed for real in Task 7

        await service.start(null)
        const opsAfterFirst = store.ops.length
        expect(opsAfterFirst).toBeGreaterThan(0)

        const service2 = createOrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', true, true, false, true, 'desc')
        service2.snapshotProvider = async () => {}
        await service2.start(null)

        expect(store.ops.slice(opsAfterFirst)).toEqual([]) // zero ops on the second run
    })
})

describe('pre-write snapshot gate (mandatory before browser mutation)', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('browser mode snapshots survivors plus doomed duplicates before any mutation', async () => {
        const store = new FakeBookmarkStore()
        store.addFolder('2', 'chron-root-123', 'Chronological Bookmarks')
        store.addUrl('1', '10', 'https://dupe.com', 'Dupe original', 1500000000000)
        store.addUrl('2', '12', 'https://dupe.com', 'Dupe mid', 1600000000000)
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockResolvedValue({ id: 'chron-root-123', title: 'Chronological Bookmarks' })
        wireStore(store)
        const downloadSpy = vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

        const service = createOrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', true, true, false, true, 'desc')
        await service.start(null)

        expect(downloadSpy).toHaveBeenCalledTimes(1)
        const [exported, filename] = downloadSpy.mock.calls[0]
        expect(exported.map(b => b.id).sort()).toEqual(['10', '12']) // survivor + doomed, both present
        expect(filename).toBeUndefined() // exporter default: organized_bookmarks.html (spec §8)
    })

    it('refuses to mutate when the snapshot provider throws', async () => {
        const store = new FakeBookmarkStore()
        store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
        wireStore(store)

        const service = createOrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', true, true, false, true, 'desc')
        service.snapshotProvider = async () => { throw new Error('disk full') }
        const results = await service.start(null)

        expect(results).toBeNull()
        expect(store.ops).toEqual([]) // zero mutations
    })
})
