import { describe, expect, it, vi, afterEach } from 'vitest'
import {
    SUBFOLDER_TIERS,
    categorySubfolderPlan,
    censusShares,
    dedupeCategoryNames,
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

describe('categorySubfolderPlan', () => {
    it('derives the ask from the category population, tier-weighted', () => {
        // sqrt(4000) ≈ 63.2: medium asks for ~44 folders on a category that
        // dominates a 4000-bookmark collection, compact for ~32.
        expect(categorySubfolderPlan([1], 4000, 'medium')[0]).toEqual({ lower: 42, upper: 46 })
        expect(categorySubfolderPlan([1], 4000, 'compact')[0]).toEqual({ lower: 30, upper: 34 })
        expect(categorySubfolderPlan([1], 4000, 'detailed')[0]).toEqual({ lower: 61, upper: 65 })
    })

    it('lands typical categories in the fuzzy tier spirit (~1-5 / ~4-8 / ~8+)', () => {
        const mid = (n, tier) => {
            const { lower, upper } = categorySubfolderPlan([1], n, tier)[0]
            return (lower + upper) / 2
        }
        // n=64: sqrt = 8 — the tier weights put the target near 4 / 6 / 8.
        expect(mid(64, 'compact')).toBeLessThanOrEqual(5)
        expect(mid(64, 'medium')).toBeGreaterThanOrEqual(4)
        expect(mid(64, 'medium')).toBeLessThanOrEqual(8)
        expect(mid(64, 'detailed')).toBeGreaterThanOrEqual(8)
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
