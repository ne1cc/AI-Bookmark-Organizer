import { describe, expect, it } from 'vitest'
import { buildAuthoritativeSchema, buildFallbackSchema, curatedSubcategories } from './defaultSchema'
import { DEFAULT_CATEGORIES, SUGGESTED_ADDABLE_CATEGORIES } from '../components/Organizer'

const find = (schema, name) => schema.categories.find(c => c.name === name)

describe('curatedSubcategories', () => {
    it('covers every category the extension ships with', () => {
        for (const category of [...DEFAULT_CATEGORIES, ...SUGGESTED_ADDABLE_CATEGORIES]) {
            expect(curatedSubcategories(category), `missing curated folders for ${category}`).not.toBeNull()
            expect(curatedSubcategories(category).length).toBeGreaterThanOrEqual(5)
        }
    })

    it('matches regardless of casing and surrounding whitespace', () => {
        expect(curatedSubcategories('  finance & CRYPTO ')).toEqual(curatedSubcategories('Finance & Crypto'))
    })

    it('returns null for a category it does not know', () => {
        expect(curatedSubcategories('My Stuff')).toBeNull()
        expect(curatedSubcategories('')).toBeNull()
        expect(curatedSubcategories(undefined)).toBeNull()
    })
})

describe('buildFallbackSchema', () => {
    it('gives every known category real subfolders instead of an empty array', () => {
        const { schema, curatedCount } = buildFallbackSchema(DEFAULT_CATEGORIES)

        expect(curatedCount).toBe(DEFAULT_CATEGORIES.length)
        expect(find(schema, 'Finance & Crypto').sub_categories.length).toBeGreaterThanOrEqual(5)

        // The exact failure mode this fallback exists to prevent.
        expect(schema.categories.every(c => c.sub_categories.length === 0)).toBe(false)
    })

    it('prefers subcategories salvaged from the failed AI response', () => {
        const partial = { categories: [{ name: 'Finance & Crypto', sub_categories: ['Options Flow', 'Macro Research'] }] }

        const { schema, curatedCount, carriedCount } = buildFallbackSchema(DEFAULT_CATEGORIES, partial)

        expect(carriedCount).toBe(1)
        expect(curatedCount).toBe(DEFAULT_CATEGORIES.length - 1)
        expect(find(schema, 'Finance & Crypto').sub_categories).toEqual(['Options Flow', 'Macro Research'])
    })

    it('ignores salvaged categories that are themselves empty', () => {
        const partial = { categories: [{ name: 'Finance & Crypto', sub_categories: [] }] }

        const { schema, carriedCount } = buildFallbackSchema(DEFAULT_CATEGORIES, partial)

        expect(carriedCount).toBe(0)
        expect(find(schema, 'Finance & Crypto').sub_categories).toEqual(curatedSubcategories('Finance & Crypto'))
    })

    it('leaves an unknown custom category without invented subfolders', () => {
        const { schema, curatedCount } = buildFallbackSchema(['My Stuff', 'Finance & Crypto'])

        expect(curatedCount).toBe(1)
        expect(find(schema, 'My Stuff').sub_categories).toEqual(['General'])
    })

    it('preserves the selected category list exactly without appending a top-level category', () => {
        const selected = ['Finance & Crypto', 'My Personal Research']
        const { schema } = buildFallbackSchema(selected)

        expect(schema.categories.map(c => c.name)).toEqual(selected)
        expect(find(schema, 'My Personal Research').sub_categories).toEqual(['General'])
    })

    it('uses Other as the sole safe catch-all for an empty selected list', () => {
        expect(buildFallbackSchema([]).schema.categories).toEqual([{ name: 'Other', sub_categories: [] }])
        expect(buildFallbackSchema(null).schema.categories).toEqual([{ name: 'Other', sub_categories: [] }])
    })
})

describe('empty manual category compatibility', () => {
    it('keeps Other as the direct-call fallback for both manual schema helpers', () => {
        expect(buildAuthoritativeSchema([]).categories).toEqual([{ name: 'Other', sub_categories: [] }])
        expect(buildFallbackSchema([]).schema.categories).toEqual([{ name: 'Other', sub_categories: [] }])
    })
})
