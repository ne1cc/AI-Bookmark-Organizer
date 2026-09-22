import { describe, expect, it, vi, afterEach } from 'vitest'
import {
    SUBFOLDER_TIERS,
    categorySubfolderPlan,
    censusShares,
    dedupeCategoryNames,
    naturalGroupCount,
    normalizeSubfolderTarget,
    subfolderTier
} from './ai'

describe('normalizeSubfolderTarget', () => {
    it('passes current tier ids through unchanged', () => {
        for (const id of Object.keys(SUBFOLDER_TIERS)) {
            expect(normalizeSubfolderTarget(id)).toBe(id)
        }
    })

    it('maps every retired granularity id onto its closest tier', () => {
        expect(normalizeSubfolderTarget('1-3')).toBe('compact')
        expect(normalizeSubfolderTarget('0-5')).toBe('compact')
        expect(normalizeSubfolderTarget('3-5')).toBe('compact')
        expect(normalizeSubfolderTarget('3-6')).toBe('medium')
        expect(normalizeSubfolderTarget('5-8')).toBe('medium')
        expect(normalizeSubfolderTarget('5-10')).toBe('medium')
        expect(normalizeSubfolderTarget('6-10')).toBe('detailed')
        expect(normalizeSubfolderTarget('8-12')).toBe('detailed')
        expect(normalizeSubfolderTarget('10+')).toBe('detailed')
    })

    it('falls back to Compact for unknown or missing values', () => {
        expect(normalizeSubfolderTarget('nonsense')).toBe('compact')
        expect(normalizeSubfolderTarget(undefined)).toBe('compact')
        expect(normalizeSubfolderTarget(null)).toBe('compact')
    })
})

describe('subfolderTier', () => {
    it('carries a relative weight and folder-size floor, not count cutoffs', () => {
        expect(subfolderTier('compact')).toMatchObject({ id: 'compact', weight: 0.5, minCount: 3 })
        expect(subfolderTier('medium')).toMatchObject({ id: 'medium', weight: 0.7, minCount: 3 })
        expect(subfolderTier('detailed')).toMatchObject({ id: 'detailed', weight: 1, minCount: 2 })
        expect(subfolderTier('5-10')).toEqual(subfolderTier('medium'))
    })
})

describe('dedupeCategoryNames', () => {
    it('drops empties and case duplicates while preserving first spelling', () => {
        expect(dedupeCategoryNames(['Finance', ' finance ', '', null, 'HEALTH', 'Health'])).toEqual(['Finance', 'HEALTH'])
        expect(dedupeCategoryNames(undefined)).toEqual([])
    })
})

describe('naturalGroupCount', () => {
    it('follows the damped natural-scale curve, open-ended but slow at the top', () => {
        // √-like growth in the typical range…
        expect(naturalGroupCount(25, 1)).toBe(4)
        expect(naturalGroupCount(100, 1)).toBe(6)
        // …logarithmic damping where √ would explode (a 40k-bookmark
        // dominant category must not ask for ~50 folders per category).
        expect(naturalGroupCount(4000, 1)).toBe(17)
        expect(naturalGroupCount(40000, 1)).toBe(26)
        expect(naturalGroupCount(0, 1)).toBe(1)
    })

    it('holds the fuzzy tier zones over realistic population ranges', () => {
        // Medium ~4-8 from ~70 to ~650 bookmarks.
        expect(naturalGroupCount(70, 0.7)).toBe(4)
        expect(naturalGroupCount(100, 0.7)).toBe(5)
        expect(naturalGroupCount(400, 0.7)).toBe(7)
        expect(naturalGroupCount(650, 0.7)).toBe(8)
        // Detailed 8+ above ~190, Compact ~1-5 up to a few hundred.
        expect(naturalGroupCount(200, 1)).toBe(8)
        expect(naturalGroupCount(400, 0.5)).toBe(5)
        expect(naturalGroupCount(100, 0.5)).toBe(3)
    })
})

describe('categorySubfolderPlan', () => {
    it('derives the ask from the category population, tier-weighted', () => {
        expect(categorySubfolderPlan([1], 4000, 'medium')[0]).toEqual({ lower: 10, upper: 14 })
        expect(categorySubfolderPlan([1], 4000, 'compact')[0]).toEqual({ lower: 7, upper: 11 })
        expect(categorySubfolderPlan([1], 4000, 'detailed')[0]).toEqual({ lower: 15, upper: 19 })
    })

    it('scales monotonically with population and tier weight', () => {
        let previousUpper = 0
        for (const count of [25, 100, 400, 1000]) {
            const upper = categorySubfolderPlan([1], count, 'medium')[0].upper
            expect(upper).toBeGreaterThan(previousUpper)
            previousUpper = upper
        }
        const shares = [0.9, 0.1]
        const tiers = ['compact', 'medium', 'detailed'].map(t => categorySubfolderPlan(shares, 2000, t)[0].upper)
        expect(tiers[0]).toBeLessThanOrEqual(tiers[1])
        expect(tiers[1]).toBeLessThanOrEqual(tiers[2])
    })

    it('collapses to minimal structure when the population cannot fill a folder', () => {
        // 4 bookmarks at minCount 3 support a single folder; a zero share
        // supports none but still asks for one so the category has a home.
        expect(categorySubfolderPlan([0.999, 0.001], 4000, 'medium')[1]).toEqual({ lower: 1, upper: 1 })
        expect(categorySubfolderPlan([1, 0], 100, 'detailed')[1]).toEqual({ lower: 1, upper: 1 })
    })

    it('never asks beyond what the population can fill', () => {
        const plan = categorySubfolderPlan([0.5, 0.5], 19, 'detailed')[0]
        // 9.5 bookmarks per category, minCount 2 → at most 4 folders.
        expect(plan.upper).toBeLessThanOrEqual(Math.floor(9.5 / 2))
        expect(plan.lower).toBeGreaterThanOrEqual(1)
    })

    it('returns null when no shares are available', () => {
        expect(categorySubfolderPlan(null, 4000, 'medium')).toBeNull()
        expect(categorySubfolderPlan([], 4000, 'medium')).toBeNull()
    })

    it('treats a non-numeric share as zero material', () => {
        const bands = categorySubfolderPlan([1, NaN, undefined], 3000, 'medium')
        expect(bands[1]).toEqual({ lower: 1, upper: 1 })
        expect(bands[2]).toEqual({ lower: 1, upper: 1 })
        expect(bands[0].upper).toBeGreaterThan(3)
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
