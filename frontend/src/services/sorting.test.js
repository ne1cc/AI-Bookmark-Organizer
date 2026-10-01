import { describe, expect, it } from 'vitest'
import {
    compareDates, compareFlatAlpha, getBookmarkDomain, isAlphaDescOrder, isAlphaOrder, sortFlat, sortWithinFolders
} from './sorting'

const bm = (title, extra = {}) => ({ title, url: `https://${title}.test`, ...extra })
const titles = (list) => list.map(b => b.title)

describe('isAlphaOrder / isAlphaDescOrder', () => {
    it.each(['alpha', 'alpha-asc', 'a-z', 'alpha-desc', 'z-a'])('%s is alphabetical', (o) => {
        expect(isAlphaOrder(o)).toBe(true)
    })
    it.each(['desc', 'asc', undefined])('%s is not alphabetical', (o) => {
        expect(isAlphaOrder(o)).toBe(false)
    })
    it('only alpha-desc and z-a are descending', () => {
        expect(isAlphaDescOrder('alpha-desc')).toBe(true)
        expect(isAlphaDescOrder('z-a')).toBe(true)
        expect(isAlphaDescOrder('alpha-asc')).toBe(false)
        expect(isAlphaDescOrder('alpha')).toBe(false)
    })
})

describe('getBookmarkDomain', () => {
    it('lowercases and strips www', () => {
        expect(getBookmarkDomain({ url: 'https://WWW.Example.com/x' })).toBe('example.com')
    })
    it('returns empty string for missing or invalid urls', () => {
        expect(getBookmarkDomain(undefined)).toBe('')
        expect(getBookmarkDomain({})).toBe('')
        expect(getBookmarkDomain({ url: 'not a url' })).toBe('')
    })
})

describe('compareFlatAlpha', () => {
    it('ignores case, compares numerically, ties by _origIndex ascending in both directions', () => {
        const items = [
            bm('b', { _origIndex: 0 }), bm('A', { _origIndex: 1 }), bm('a', { _origIndex: 2 }),
            bm('item 10', { _origIndex: 3 }), bm('item 2', { _origIndex: 4 })
        ]
        expect(titles([...items].sort(compareFlatAlpha(false)))).toEqual(['A', 'a', 'b', 'item 2', 'item 10'])
        expect(titles([...items].sort(compareFlatAlpha(true)))).toEqual(['item 10', 'item 2', 'b', 'A', 'a'])
    })
    it('falls back to url when title is missing', () => {
        const items = [{ url: 'https://zzz.test', _origIndex: 0 }, { title: 'aaa', url: 'https://x.test', _origIndex: 1 }]
        expect(items.sort(compareFlatAlpha(false)).map(b => b.url)).toEqual(['https://x.test', 'https://zzz.test'])
    })
})

describe('compareDates', () => {
    const items = () => [
        bm('A', { add_date: '1600000000', k: 0 }), bm('B', { add_date: '1600000000', k: 1 }),
        bm('C', { add_date: '1700000000', k: 2 }), bm('D', { k: 3 }), bm('E', { k: 4 })
    ]
    const byK = (a, b) => a.k - b.k
    it('desc: newest first, equal timestamps in reverse tieKey order, missing last via fallback', () => {
        const sorted = items().sort(compareDates({ desc: true, tieKey: 'k', missingFallback: byK }))
        expect(titles(sorted)).toEqual(['C', 'B', 'A', 'D', 'E'])
    })
    it('asc: oldest first, equal timestamps in tieKey order, missing last via fallback', () => {
        const sorted = items().sort(compareDates({ desc: false, tieKey: 'k', missingFallback: byK }))
        expect(titles(sorted)).toEqual(['A', 'B', 'C', 'D', 'E'])
    })
    it('treats an absent tieKey as 0', () => {
        const a = bm('A', { add_date: '1600000000' })
        const b = bm('B', { add_date: '1600000000' })
        expect(Math.abs(compareDates({ desc: true, tieKey: 'k', missingFallback: byK })(a, b))).toBe(0)
    })
})

describe('sortFlat', () => {
    const dated = () => [
        bm('A', { add_date: '1600000000', _origIndex: 0 }), bm('B', { add_date: '1600000000', _origIndex: 1 }),
        bm('C', { add_date: '1700000000', _origIndex: 2 }), bm('D', { _origIndex: 3 }), bm('E', { _origIndex: 4 })
    ]
    it('chronological desc breaks ties newest-added (highest _origIndex) first; undated keep original order', () => {
        expect(titles(sortFlat(dated(), 'desc'))).toEqual(['C', 'B', 'A', 'D', 'E'])
    })
    it('chronological asc breaks ties oldest-added first', () => {
        expect(titles(sortFlat(dated(), 'asc'))).toEqual(['A', 'B', 'C', 'D', 'E'])
    })
    it('unknown order values behave like desc', () => {
        expect(titles(sortFlat(dated(), undefined))).toEqual(['C', 'B', 'A', 'D', 'E'])
    })
    it('alpha-asc and alpha-desc dispatch to the alphabetical comparator', () => {
        const list = () => [bm('b', { _origIndex: 0 }), bm('a', { _origIndex: 1 }), bm('c', { _origIndex: 2 })]
        expect(titles(sortFlat(list(), 'alpha-asc'))).toEqual(['a', 'b', 'c'])
        expect(titles(sortFlat(list(), 'z-a'))).toEqual(['c', 'b', 'a'])
    })
    it('sorts in place and returns the same array', () => {
        const list = dated()
        expect(sortFlat(list, 'asc')).toBe(list)
    })
})

describe('sortWithinFolders', () => {
    const rank = new Map([['Tech', 0], ['Finance', 1]])
    const folderItems = () => [
        bm('Zed', { category: 'Finance', sub_category: 'Investing' }),
        bm('Beta', { category: 'Tech', sub_category: 'Tools' }),
        bm('Alpha', { category: 'Tech', sub_category: 'Tools' }),
        bm('Q', { category: 'Unknown', sub_category: 'x' }),
        bm('Mid', { category: 'Tech', sub_category: 'AI' })
    ]
    it('orders by category rank, then sub_category, then title; unknown categories last', () => {
        const sorted = sortWithinFolders(folderItems(), { categoryRank: rank, schemaSortOrder: 'alpha' })
        expect(titles(sorted)).toEqual(['Mid', 'Alpha', 'Beta', 'Zed', 'Q'])
    })
    it("'none' keeps input order inside a folder but still groups by category/sub_category", () => {
        const sorted = sortWithinFolders(folderItems(), { categoryRank: rank, schemaSortOrder: 'none' })
        expect(titles(sorted)).toEqual(['Mid', 'Beta', 'Alpha', 'Zed', 'Q'])
    })
    it('orders by detail_category before content sort', () => {
        const list = [
            bm('A', { category: 'Tech', sub_category: 'x', detail_category: 'Vue' }),
            bm('B', { category: 'Tech', sub_category: 'x', detail_category: 'React' })
        ]
        expect(titles(sortWithinFolders(list, { categoryRank: rank, schemaSortOrder: 'alpha' }))).toEqual(['B', 'A'])
    })

    const sameFolder = () => [
        bm('A', { category: 'Tech', sub_category: 'x', add_date: '1600000000', _detailRunOrdinal: 0 }),
        bm('B', { category: 'Tech', sub_category: 'x', add_date: '1600000000', _detailRunOrdinal: 1 }),
        bm('C', { category: 'Tech', sub_category: 'x', add_date: '1700000000', _detailRunOrdinal: 2 }),
        bm('Zed', { category: 'Tech', sub_category: 'x', _detailRunOrdinal: 3 }),
        bm('Amy', { category: 'Tech', sub_category: 'x', _detailRunOrdinal: 4 })
    ]
    it('date-desc: ties by _detailRunOrdinal descending; undated by title', () => {
        expect(titles(sortWithinFolders(sameFolder(), { categoryRank: rank, schemaSortOrder: 'date-desc' })))
            .toEqual(['C', 'B', 'A', 'Amy', 'Zed'])
    })
    it('date-asc: ties by _detailRunOrdinal ascending; undated by title', () => {
        expect(titles(sortWithinFolders(sameFolder(), { categoryRank: rank, schemaSortOrder: 'date-asc' })))
            .toEqual(['A', 'B', 'C', 'Amy', 'Zed'])
    })
    it('domain: by normalized domain then title', () => {
        const list = [
            { title: '1', url: 'https://www.b.com/x', category: 'Tech', sub_category: 'x' },
            { title: '2', url: 'https://a.com', category: 'Tech', sub_category: 'x' },
            { title: '3', url: 'https://b.com/y', category: 'Tech', sub_category: 'x' }
        ]
        expect(titles(sortWithinFolders(list, { categoryRank: rank, schemaSortOrder: 'domain' }))).toEqual(['2', '1', '3'])
    })
})
