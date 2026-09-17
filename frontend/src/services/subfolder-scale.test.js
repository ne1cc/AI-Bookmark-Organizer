import { describe, expect, it, vi, afterEach } from 'vitest'
import {
    SUBFOLDER_TIERS,
    adaptiveSubfolderAsk,
    buildCategoryBands,
    censusShares,
    collectionSpread,
    normalizeSubfolderTarget,
    requiredSubfolderMin
} from './ai'

describe('normalizeSubfolderTarget', () => {
    it('passes current tier ids through unchanged', () => {
        for (const id of Object.keys(SUBFOLDER_TIERS)) {
            expect(normalizeSubfolderTarget(id)).toBe(id)
        }
    })

    it('maps every retired granularity id onto its closest tier', () => {
        expect(normalizeSubfolderTarget('1-3')).toBe('3-5')
        expect(normalizeSubfolderTarget('0-5')).toBe('3-5')
        expect(normalizeSubfolderTarget('3-6')).toBe('5-8')
        expect(normalizeSubfolderTarget('5-10')).toBe('5-8')
        expect(normalizeSubfolderTarget('6-10')).toBe('8-12')
        expect(normalizeSubfolderTarget('10+')).toBe('8-12')
    })

    it('falls back to Compact for unknown or missing values', () => {
        expect(normalizeSubfolderTarget('nonsense')).toBe('3-5')
        expect(normalizeSubfolderTarget(undefined)).toBe('3-5')
        expect(normalizeSubfolderTarget(null)).toBe('3-5')
    })
})

describe('adaptiveSubfolderAsk', () => {
    it('compresses the top of the band to the tier floor for small collections', () => {
        expect(adaptiveSubfolderAsk('3-5', 50).ask).toEqual([3, 3])
        expect(adaptiveSubfolderAsk('5-8', 50).ask).toEqual([5, 5])
        expect(adaptiveSubfolderAsk('8-12', 50).ask).toEqual([8, 8])
    })

    it('opens the full band for very large collections', () => {
        expect(adaptiveSubfolderAsk('3-5', 4000).ask).toEqual([3, 5])
        expect(adaptiveSubfolderAsk('5-8', 4000).ask).toEqual([5, 8])
        expect(adaptiveSubfolderAsk('8-12', 4000).ask).toEqual([8, 12])
    })

    it('scales monotonically with collection size and never dips below the tier floor', () => {
        for (const id of Object.keys(SUBFOLDER_TIERS)) {
            const [lo, hi] = SUBFOLDER_TIERS[id].ask
            let previous = -1
            for (const count of [150, 300, 600, 1200, 2500, 5000]) {
                const { ask: [askMin, askMax] } = adaptiveSubfolderAsk(id, count)
                expect(askMin).toBe(lo)
                expect(askMax).toBeGreaterThanOrEqual(lo)
                expect(askMax).toBeLessThanOrEqual(hi)
                expect(askMax).toBeGreaterThanOrEqual(previous)
                previous = askMax
            }
        }
    })

    it('mid-size collections land inside the band, not at either edge', () => {
        // 1000 bookmarks sits ~63% of the way up the log scale.
        expect(adaptiveSubfolderAsk('3-5', 1000).ask).toEqual([3, 4])
        expect(adaptiveSubfolderAsk('5-8', 1000).ask).toEqual([5, 7])
        expect(adaptiveSubfolderAsk('8-12', 1000).ask).toEqual([8, 11])
    })

    it('relaxes the whole band for tiny collections', () => {
        expect(adaptiveSubfolderAsk('3-5', 30).ask).toEqual([1, 3])
        expect(adaptiveSubfolderAsk('8-12', 30).ask).toEqual([1, 8])
    })

    it('carries the tier identity and policy fields through', () => {
        expect(adaptiveSubfolderAsk('5-8', 900)).toMatchObject({
            id: '5-8',
            label: 'Balanced',
            min: 3,
            max: 8,
            minCount: 3
        })
    })

    it('treats a missing count as a small collection', () => {
        expect(adaptiveSubfolderAsk('3-5').ask).toEqual([3, 3])
    })
})

describe('requiredSubfolderMin', () => {
    it('enforces the tier minimum for normal collections', () => {
        expect(requiredSubfolderMin('3-5', 500)).toBe(2)
        expect(requiredSubfolderMin('5-8', 500)).toBe(3)
        expect(requiredSubfolderMin('8-12', 500)).toBe(3)
    })

    it('relaxes to one for tiny collections', () => {
        expect(requiredSubfolderMin('8-12', 12)).toBe(1)
        expect(requiredSubfolderMin('3-5', 12)).toBe(1)
    })
})

describe('collectionSpread', () => {
    it('maps the log-scale collection size onto 0..1', () => {
        expect(collectionSpread(0)).toBe(0)
        expect(collectionSpread(150)).toBe(0)
        expect(collectionSpread(3000)).toBe(1)
        expect(collectionSpread(5000)).toBe(1)
        expect(collectionSpread(1000)).toBeGreaterThan(0.5)
        expect(collectionSpread(1000)).toBeLessThan(1)
    })
})

describe('buildCategoryBands', () => {
    it('gives a dominant category the full tier band and shrinks sparse ones', () => {
        const bands = buildCategoryBands([0.9, 0.05, 0.05], 4000, '5-8')
        expect(bands[0]).toEqual({ lower: 5, upper: 8 })
        // 200 bookmarks each for the small categories: still healthy.
        expect(bands[1]).toEqual({ lower: 5, upper: 8 })
    })

    it('collapses to minimal structure when a category cannot support the tier floor', () => {
        // 5 bookmarks at minCount 3 supports a single folder.
        const bands = buildCategoryBands([0.9, 0.05, 0.05], 4000, '5-8')
        const tiny = buildCategoryBands([0.99875, 0.000625, 0.000625], 4000, '5-8')
        expect(tiny[1]).toEqual({ lower: 1, upper: 1 })
        expect(tiny[1].upper).toBeLessThan(bands[1].lower)
    })

    it('scales the top of a healthy band with collection size, never below the floor', () => {
        const small = buildCategoryBands([1], 200, '3-5')
        const large = buildCategoryBands([1], 4000, '3-5')
        expect(small[0]).toEqual({ lower: 3, upper: 3 })
        expect(large[0]).toEqual({ lower: 3, upper: 5 })
    })

    it('returns null when no shares are available', () => {
        expect(buildCategoryBands(null, 4000, '5-8')).toBeNull()
        expect(buildCategoryBands([], 4000, '5-8')).toBeNull()
    })

    it('treats a non-numeric share as zero material', () => {
        const bands = buildCategoryBands([1, NaN, undefined], 3000, '3-5')
        expect(bands[0]).toEqual({ lower: 3, upper: 5 })
        expect(bands[1]).toEqual({ lower: 1, upper: 1 })
        expect(bands[2]).toEqual({ lower: 1, upper: 1 })
    })
})

describe('censusShares', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    const sample = Array.from({ length: 10 }, (_, i) => ({
        title: `Bookmark ${i}`,
        url: `https://example.com/${i}`
    }))

    const orResponse = (content) => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] })
    })

    it('measures shares from the model assignments and dedupes category names', async () => {
        global.fetch = vi.fn(async () => orResponse(JSON.stringify({ assignments: [0, 0, 0, 0, 0, 0, 1, 1, 2, '1'] })))

        const census = await censusShares(sample, ['Finance', 'finance', 'Health', 'Travel'], 'sk-or-test-key')

        expect(census.names).toEqual(['Finance', 'Health', 'Travel'])
        expect(census.shares).toEqual([0.6, 0.3, 0.1])
    })

    it('returns null when the response does not cover every sample bookmark', async () => {
        global.fetch = vi.fn(async () => orResponse(JSON.stringify({ assignments: [0, 1] })))

        expect(await censusShares(sample, ['Finance', 'Health'], 'sk-or-test-key')).toBeNull()
    })

    it('returns null on an invalid category index instead of miscounting', async () => {
        global.fetch = vi.fn(async () => orResponse(JSON.stringify({ assignments: Array(9).fill(0).concat([7]) })))

        expect(await censusShares(sample, ['Finance', 'Health'], 'sk-or-test-key')).toBeNull()
    })

    it('skips the call entirely for single-category runs', async () => {
        global.fetch = vi.fn()

        expect(await censusShares(sample, ['Only Category'], 'sk-or-test-key')).toBeNull()
        expect(global.fetch).not.toHaveBeenCalled()
    })
})
