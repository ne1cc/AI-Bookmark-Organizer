import { describe, expect, it } from 'vitest'
import { normalizeSchema, validateSchema } from './ai'

describe('normalizeSchema', () => {
    it('trims, drops case-duplicate categories, filler subfolders and parent echoes, and dedupes subfolders', () => {
        const result = normalizeSchema({
            categories: [
                { name: ' Tech ', sub_categories: ['Web', 'web ', 'Webs', 'General', 'Tech', '', 7] },
                { name: 'tech', sub_categories: ['Ignored'] },
                { name: 'Travel' },
                { name: '   ', sub_categories: ['Nothing'] }
            ]
        })

        expect(result).toEqual({
            categories: [
                { name: 'Tech', sub_categories: ['Web'] },
                { name: 'Travel', sub_categories: [] }
            ]
        })
    })

    it('makes no quality judgement: two categories and a catch-all name are fine', () => {
        const result = normalizeSchema({ categories: [{ name: 'Misc', sub_categories: [] }, { name: 'Tech', sub_categories: [] }] })

        expect(result.categories.map(c => c.name)).toEqual(['Misc', 'Tech'])
    })

    it('returns no categories for a missing or empty schema, and ignores extra fields', () => {
        expect(normalizeSchema(null)).toEqual({ categories: [] })
        expect(normalizeSchema({ categories: 'nope' })).toEqual({ categories: [] })
        expect(normalizeSchema({ binding: true, categories: [{ name: 'A', sub_categories: [] }] })).toEqual({ categories: [{ name: 'A', sub_categories: [] }] })
    })

    it('is what validateSchema cleans with', () => {
        const raw = { categories: [{ name: 'Tech', sub_categories: ['Web', 'web', 'General'] }, { name: 'Travel', sub_categories: ['Flights'] }, { name: 'Finance', sub_categories: ['Tax'] }] }

        expect(validateSchema(raw, { bookmarkCount: 10 }).schema).toEqual(normalizeSchema(raw))
    })
})
