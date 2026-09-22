import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
    validateSchema,
    subfolderTier,
    salvagePartialJson,
    generateSchema,
    generateInferredSchema,
    classifyBatch,
    SCHEMA_MAX_TOKENS,
    validateDetailSchema,
    buildDetailSchemaPrompt,
    generateDetailSchemas,
    DETAIL_SCHEMA_GROUP_LIMIT,
    DETAIL_SCHEMA_SAMPLE_LIMIT,
    DETAIL_MIN_BOOKMARKS,
    DETAIL_MIN_FOLDER_SIZE,
    DETAIL_MAX_FOLDERS
} from './ai'

// Builds an OpenRouter-shaped success response carrying `content` verbatim.
const orResponse = (content, finishReason = 'stop') => ({
    ok: true,
    status: 200,
    json: async () => ({
        choices: [{ finish_reason: finishReason, message: { content } }]
    })
})

// Five subcategories per category so the same fixture satisfies every
// granularity floor, including the strictest (the Detailed tier requires 3);
// three categories so it also clears the breadth floor a narrowed (e.g. salvaged)
// response fails.
const healthySchema = {
    categories: [
        { name: 'Finance & Crypto', sub_categories: ['Trading & Markets', 'Crypto & Blockchain', 'Investing & Wealth', 'Banking & Payments', 'Tax & Economics'] },
        { name: 'Tech & Development', sub_categories: ['Web Development', 'AI & Machine Learning', 'DevOps & Cloud', 'Databases', 'Security'] },
        { name: 'Work & Career', sub_categories: ['Job Search', 'Resume & Interviews', 'Industry Research', 'Networking', 'Learning & Courses'] }
    ]
}

// Builds a native Gemini generateContent response. `parts` is spread across
// `content.parts` verbatim, which is how the API streams a long answer back.
const geminiResponse = (parts, finishReason = 'STOP') => ({
    ok: true,
    status: 200,
    json: async () => ({
        candidates: [{ finishReason, content: { parts: parts.map(text => ({ text })) } }]
    })
})

// Google AI Studio keys select the native Gemini path.
const GEMINI_KEY = 'AIzaSyTestKey'

// Enough bookmarks to clear TINY_COLLECTION_THRESHOLD (40) so the strict floors apply.
const manyBookmarks = Array.from({ length: 50 }, (_, i) => ({
    title: `Bookmark ${i}`,
    url: `https://example.com/${i}`
}))

// Answers the census pre-call that precedes schema generation for multi-category
// runs: every sample bookmark lands in category 0, which reproduces a single
// dominant category (and therefore the full tier band for it).
const censusAllInFirst = () => orResponse(JSON.stringify({ assignments: Array(manyBookmarks.length).fill(0) }))

describe('subfolderTier', () => {
    it('defines three relative-pressure tiers, not count contracts', () => {
        expect(subfolderTier('compact')).toEqual({ id: 'compact', label: 'Compact', weight: 0.5, minCount: 3 })
        expect(subfolderTier('medium')).toEqual({ id: 'medium', label: 'Medium', weight: 0.7, minCount: 3 })
        expect(subfolderTier('detailed')).toEqual({ id: 'detailed', label: 'Detailed', weight: 1, minCount: 2 })
    })

    it('maps retired granularity ids onto the closest current tier', () => {
        expect(subfolderTier('1-3')).toEqual(subfolderTier('compact'))
        expect(subfolderTier('0-5')).toEqual(subfolderTier('compact'))
        expect(subfolderTier('3-6')).toEqual(subfolderTier('medium'))
        expect(subfolderTier('5-10')).toEqual(subfolderTier('medium'))
        expect(subfolderTier('6-10')).toEqual(subfolderTier('detailed'))
        expect(subfolderTier('10+')).toEqual(subfolderTier('detailed'))
    })

    it('falls back to the compact tier for unknown or missing values', () => {
        expect(subfolderTier(undefined)).toEqual(subfolderTier('compact'))
        expect(subfolderTier('nonsense')).toEqual(subfolderTier('compact'))
    })
})

describe('validateSchema', () => {
    it.each([1, 2])('accepts %i selected categories for large collections while enforcing depth', (count) => {
        const categories = healthySchema.categories.slice(0, count)
        const expectedCategories = categories.map(c => c.name)
        for (const subfolderTarget of ['compact', 'medium', 'detailed']) {
            const options = { expectedCategories, subfolderTarget, bookmarkCount: 40 }
            expect(validateSchema({ categories }, options).issues).toEqual([])
            const thin = { categories: categories.map(c => ({ ...c, sub_categories: ['General', 'One Topic'] })) }
            const result = validateSchema(thin, options)
            expect(result.ok).toBe(false)
            expect(result.issues.join(' ')).toMatch(/subcategories/)
            expect(result.issues.join(' ')).not.toContain('covered only')
        }
    })

    it('counts spacing and plural variants as one subcategory when validating depth', () => {
        const result = validateSchema({ categories: [{
            name: 'Tech', sub_categories: ['Developer Tools', 'Developer Tool', 'Developer  Tools']
        }] }, { expectedCategories: ['Tech'], bookmarkCount: 40, subfolderTarget: 'medium' })

        expect(result.schema.categories[0].sub_categories).toEqual(['Developer Tools'])
        expect(result.ok).toBe(false)
        // Rejection now comes from flatness (one subcategory for the category),
        // not from a per-tier depth floor.
        expect(result.issues.join(' ')).toMatch(/flat overall/)
    })

    it('accepts a schema meeting the granularity floor', () => {
        const result = validateSchema(healthySchema, { subfolderTarget: 'medium', bookmarkCount: 500 })

        expect(result.ok).toBe(true)
        expect(result.issues).toEqual([])
        expect(result.schema.categories).toHaveLength(3)
    })

    it('rejects a response that covers too few of the configured categories', () => {
        // The exact shape a MAX_TOKENS salvage produces: structurally fine, but
        // omitted selected categories would receive only their General fallback
        // instead of useful topical subcategories.
        const narrow = { categories: healthySchema.categories.slice(0, 2) }
        const expectedCategories = ['Finance & Crypto', 'Tech & Development', 'Work & Career', 'Design & Media', 'Travel & Lifestyle', 'Shopping & Tools']

        const result = validateSchema(narrow, { subfolderTarget: 'medium', bookmarkCount: 4000, expectedCategories })

        expect(result.ok).toBe(false)
        expect(result.issues.join(' ')).toMatch(/covered only 2 categories; at least 3 are needed/)
    })

    it('scales the breadth floor to half the configured category list', () => {
        const narrow = { categories: healthySchema.categories }
        const tenCategories = Array.from({ length: 10 }, (_, i) => `Category ${i}`)

        const result = validateSchema(narrow, { subfolderTarget: 'medium', bookmarkCount: 4000, expectedCategories: tenCategories })

        expect(result.ok).toBe(false)
        expect(result.issues.join(' ')).toMatch(/at least 5 are needed/)
    })

    it('exempts a tiny collection from the breadth floor', () => {
        const oneCategory = { categories: [healthySchema.categories[0]] }

        expect(validateSchema(oneCategory, { subfolderTarget: 'medium', bookmarkCount: 12 }).ok).toBe(true)
        expect(validateSchema(oneCategory, { subfolderTarget: 'medium', bookmarkCount: 4000 }).ok).toBe(false)
    })

    it('rejects a response with no categories at all', () => {
        expect(validateSchema(null).ok).toBe(false)
        expect(validateSchema({}).ok).toBe(false)
        expect(validateSchema({ categories: [] }).ok).toBe(false)
        expect(validateSchema({ categories: [] }).issues[0]).toMatch(/no categories/i)
    })

    it('rejects the empty-subcategory schema that caused the original bug', () => {
        const flat = {
            categories: [
                { name: 'Work & Career', sub_categories: [] },
                { name: 'Finance & Crypto', sub_categories: [] }
            ]
        }

        const result = validateSchema(flat, { subfolderTarget: 'medium', bookmarkCount: 3000 })

        expect(result.ok).toBe(false)
        expect(result.issues.join(' ')).toMatch(/every category needs at least one distinct, specific subcategory/)
        expect(result.issues.join(' ')).toMatch(/"Work & Career" has 0/)
    })

    it('treats a schema of nothing but filler names as flat', () => {
        const filler = {
            categories: [
                { name: 'Work & Career', sub_categories: ['General'] },
                { name: 'Finance & Crypto', sub_categories: ['Misc', 'Other'] }
            ]
        }

        const result = validateSchema(filler, { subfolderTarget: 'medium', bookmarkCount: 3000 })

        expect(result.ok).toBe(false)
        // Filler names are stripped, so both categories read as empty.
        expect(result.schema.categories.every(c => c.sub_categories.length === 0)).toBe(true)
    })

    it('accepts a thin-but-alive schema at every tier — the ask is pressure, not a gate', () => {
        const twoSubs = {
            categories: [
                { name: 'Tech', sub_categories: ['Web Dev', 'AI'] },
                { name: 'Finance', sub_categories: ['Trading', 'Crypto'] },
                { name: 'Travel', sub_categories: ['Flights', 'Hotels'] }
            ]
        }

        expect(validateSchema(twoSubs, { subfolderTarget: 'compact', bookmarkCount: 3000 }).ok).toBe(true)
        expect(validateSchema(twoSubs, { subfolderTarget: 'medium', bookmarkCount: 3000 }).ok).toBe(true)
        expect(validateSchema(twoSubs, { subfolderTarget: 'detailed', bookmarkCount: 3000 }).ok).toBe(true)
    })

    it('relaxes the floor and the flatness check for tiny collections', () => {
        const oneSub = { categories: [{ name: 'Tech', sub_categories: ['Coding'] }] }

        expect(validateSchema(oneSub, { subfolderTarget: 'detailed', bookmarkCount: 12 }).ok).toBe(true)
        expect(validateSchema(oneSub, { subfolderTarget: 'detailed', bookmarkCount: 3000 }).ok).toBe(false)
    })

    it('exempts catch-all categories from the subcategory floor', () => {
        const withCatchAll = {
            categories: [
                ...healthySchema.categories,
                { name: 'Other', sub_categories: [] },
                { name: 'Archive', sub_categories: [] }
            ]
        }

        const result = validateSchema(withCatchAll, {
            subfolderTarget: 'medium',
            bookmarkCount: 3000,
            expectedCategories: withCatchAll.categories.map(category => category.name)
        })

        expect(result.ok).toBe(true)
        expect(result.schema.categories.map(c => c.name)).toContain('Other')
    })

    it('rejects an inferred schema whose only top-level category is Other', () => {
        const result = validateSchema(
            { categories: [{ name: 'Other', sub_categories: [] }] },
            { bookmarkCount: 12, expectedCategories: null }
        )

        expect(result.ok).toBe(false)
        expect(result.issues.join(' ')).toMatch(/catch-all.*Other/i)
    })

    it('rejects catch-all top-level entries mixed into an inferred schema', () => {
        const result = validateSchema(
            {
                categories: [
                    ...healthySchema.categories,
                    { name: 'Archive', sub_categories: [] }
                ]
            },
            { subfolderTarget: 'medium', bookmarkCount: 3000, expectedCategories: null }
        )

        expect(result.ok).toBe(false)
        expect(result.issues.join(' ')).toMatch(/catch-all.*Archive/i)
    })

    it.each([
        'Misc',
        'Misc.',
        'Miscellaneous',
        'Miscellaneous Items',
        'Miscellaneous Resources',
        'Various',
        'Various Topics',
        'Various Resources',
        'Assorted',
        'Assorted Links',
        'Everything Else',
        'Other Stuff',
        'Other Resources',
        'Others',
        'Catch-All',
        'Uncategorized Links',
        'General Items',
        'Unsorted',
        'Unclassified',
        'None'
    ])('rejects inferred filler top-level category "%s"', (fillerName) => {
        const result = validateSchema(
            {
                categories: [
                    ...healthySchema.categories,
                    {
                        name: fillerName,
                        sub_categories: ['Fallback One', 'Fallback Two', 'Fallback Three']
                    }
                ]
            },
            { subfolderTarget: 'medium', bookmarkCount: 3000, expectedCategories: null }
        )

        expect(result.ok).toBe(false)
        expect(result.issues.join(' ')).toContain(fillerName)
    })

    it.each([
        'Miscellaneous',
        'Other Resources',
        'Uncategorized Links',
        'General Items'
    ])('does not apply inferred filler-name rejection to explicit manual category "%s"', (categoryName) => {
        const manualSchema = {
            categories: [
                ...healthySchema.categories,
                {
                    name: categoryName,
                    sub_categories: ['Household Records', 'Reference Links', 'Saved Reading']
                }
            ]
        }

        const result = validateSchema(manualSchema, {
            subfolderTarget: 'medium',
            bookmarkCount: 3000,
            expectedCategories: manualSchema.categories.map(category => category.name)
        })

        expect(result.ok).toBe(true)
    })

    it.each([
        'Developer Resources',
        'Learning Resources',
        'General Aviation',
        'Other Languages'
    ])('accepts topical inferred category "%s"', (categoryName) => {
        const schema = {
            categories: [
                ...healthySchema.categories,
                {
                    name: categoryName,
                    sub_categories: ['Guides', 'Reference', 'News']
                }
            ]
        }

        expect(validateSchema(schema, { bookmarkCount: 100 }).ok).toBe(true)
    })

    it('flags a structure that is flat on average even when each category clears the floor', () => {
        const spread = {
            categories: [
                { name: 'A', sub_categories: ['A1'] },
                { name: 'B', sub_categories: ['B1'] },
                { name: 'C', sub_categories: ['C1'] }
            ]
        }

        const result = validateSchema(spread, { subfolderTarget: 'compact', bookmarkCount: 3000 })

        expect(result.ok).toBe(false)
        expect(result.issues.join(' ')).toMatch(/flat overall/)
    })

    it('accepts an under-ask schema without rejection — the ask is not a gate', () => {
        // A sparse category returning one subcategory where richer ones return
        // five is a legitimate answer; demanding tier depth from it is exactly
        // what manufactures padded near-duplicate folders.
        const sparse = {
            categories: [
                ...healthySchema.categories,
                { name: 'Health', sub_categories: ['Fitness'] }
            ]
        }

        expect(validateSchema(sparse, { subfolderTarget: 'medium', bookmarkCount: 3000 }).ok).toBe(true)
    })

    it('normalizes names, drops duplicates and drops a subcategory echoing its parent', () => {
        const messy = {
            categories: [
                {
                    name: '  Tech & Development  ',
                    sub_categories: ['Web Dev', '  web dev ', 'Tech & Development', 'AI', '', null, 42, 'DevOps']
                },
                { name: 'Tech & Development', sub_categories: ['Duplicate Category'] },
                { name: '   ', sub_categories: ['Ignored'] }
            ]
        }

        const result = validateSchema(messy, { subfolderTarget: 'compact', bookmarkCount: 3000 })

        expect(result.schema.categories).toHaveLength(1)
        expect(result.schema.categories[0].name).toBe('Tech & Development')
        expect(result.schema.categories[0].sub_categories).toEqual(['Web Dev', 'AI', 'DevOps'])
    })

})

describe('salvagePartialJson', () => {
    it('closes brackets left open by a response cut off mid-array', () => {
        const truncated = '{"categories":[{"name":"Tech","sub_categories":["Web Dev","AI"'

        expect(salvagePartialJson(truncated)).toEqual({
            categories: [{ name: 'Tech', sub_categories: ['Web Dev', 'AI'] }]
        })
    })

    it('rewinds past a string that was cut off mid-token', () => {
        const truncated = '{"categories":[{"name":"Tech","sub_categories":["Web Dev","Machine Lear'

        expect(salvagePartialJson(truncated)).toEqual({
            categories: [{ name: 'Tech', sub_categories: ['Web Dev'] }]
        })
    })

    it('drops a trailing element that was only partially written', () => {
        const truncated = '{"categories":[{"name":"Tech","sub_categories":["AI"]},{"name":"Fin'

        expect(salvagePartialJson(truncated)).toEqual({
            categories: [{ name: 'Tech', sub_categories: ['AI'] }]
        })
    })

    it('strips markdown fences before repairing', () => {
        const truncated = '```json\n{"categories":[{"name":"Tech","sub_categories":["AI"'

        expect(salvagePartialJson(truncated)).toEqual({
            categories: [{ name: 'Tech', sub_categories: ['AI'] }]
        })
    })

    it('returns null when there is nothing recoverable', () => {
        expect(salvagePartialJson('')).toBeNull()
        expect(salvagePartialJson(null)).toBeNull()
        expect(salvagePartialJson('no json here at all')).toBeNull()
        expect(salvagePartialJson('{')).toBeNull()
    })
})

describe('generateSchema validation and corrective retry', () => {
    let originalFetch

    beforeEach(() => {
        originalFetch = global.fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
        vi.useRealTimers()
    })

    it.each([1, 2])('accepts a healthy %i-category selected schema without corrective retries', async (count) => {
        const candidate = { categories: healthySchema.categories.slice(0, count) }
        // Multi-category runs start with a census call; single-category runs skip it.
        global.fetch = count > 1
            ? vi.fn()
                .mockImplementationOnce(async () => censusAllInFirst())
                .mockImplementationOnce(async () => orResponse(JSON.stringify(candidate)))
            : vi.fn(async () => orResponse(JSON.stringify(candidate)))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', candidate.categories.map(c => c.name))

        expect(schema).toEqual(candidate)
        expect(global.fetch).toHaveBeenCalledTimes(count > 1 ? 2 : 1)
    })

    it('returns the schema unchanged when the first response is already valid', async () => {
        global.fetch = vi.fn()
            .mockImplementationOnce(async () => censusAllInFirst())
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', healthySchema.categories.map(c => c.name), undefined, 'medium')

        expect(global.fetch).toHaveBeenCalledTimes(2)
        expect(schema.categories).toHaveLength(3)
        expect(schema.categories[0].sub_categories).toContain('Trading & Markets')
    })

    it('uses the selected category names verbatim and ignores model-invented top-level categories', async () => {
        const selected = ['Finance & CRYPTO', 'Tech & Development', 'Personal Research']
        global.fetch = vi.fn(async () => orResponse(JSON.stringify({
            categories: [
                { name: 'finance & crypto', sub_categories: ['Trading & Markets', 'Crypto & Blockchain', 'Investing & Wealth'] },
                { name: 'Tech & Development', sub_categories: ['Web Development', 'DevOps & Cloud', 'Security'] },
                { name: 'Invented Category', sub_categories: ['One', 'Two', 'Three'] }
            ]
        })))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', selected, undefined, 'medium')

        expect(schema.categories.map(c => c.name)).toEqual(selected)
        expect(schema.categories[0].sub_categories).toEqual(['Trading & Markets', 'Crypto & Blockchain', 'Investing & Wealth'])
        expect(schema.categories[2].sub_categories).toEqual(['General'])
    })

    it('re-prompts once when the model returns a flat schema, and accepts the correction', async () => {
        const flat = { categories: [{ name: 'Tech', sub_categories: [] }, { name: 'Finance', sub_categories: [] }] }
        global.fetch = vi.fn()
            .mockImplementationOnce(async () => censusAllInFirst())
            .mockImplementationOnce(async () => orResponse(JSON.stringify(flat)))
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', healthySchema.categories.map(c => c.name), undefined, 'medium')

        expect(global.fetch).toHaveBeenCalledTimes(3)
        expect(schema.categories).toHaveLength(3)

        const correctionPrompt = JSON.parse(global.fetch.mock.calls[2][1].body).messages[1].content
        expect(correctionPrompt).toContain('CORRECTION REQUIRED')
        expect(correctionPrompt).toContain('PER-CATEGORY SUBFOLDER RANGES')
        expect(correctionPrompt).toMatch(/at least the minimum of its own range/)
    })

    it('reports the correction attempt through onRetry', async () => {
        const flat = { categories: [{ name: 'Tech', sub_categories: [] }] }
        global.fetch = vi.fn()
            .mockImplementationOnce(async () => orResponse(JSON.stringify(flat)))
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const events = []
        await generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'], undefined, 'medium', null, (e) => events.push(e))

        expect(events).toHaveLength(1)
        expect(events[0].isSchemaCorrection).toBe(true)
        expect(events[0].isRateLimit).toBe(false)
    })

    it('throws a schemaInvalid error carrying the partial schema when the correction also fails', async () => {
        const flat = { categories: [{ name: 'Tech', sub_categories: [] }, { name: 'Finance', sub_categories: [] }] }
        global.fetch = vi.fn(async () => orResponse(JSON.stringify(flat)))

        await expect(
            generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'], undefined, 'medium')
        ).rejects.toMatchObject({
            schemaInvalid: true,
            partialSchema: { categories: [{ name: 'Tech', sub_categories: [] }, { name: 'Finance', sub_categories: [] }] }
        })

        expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('names a per-category range even without a census (uniform shares)', async () => {
        // Single-category runs skip the census; the plan then treats the whole
        // collection as one category's population on the damped natural-scale
        // curve: at N=50 → compact k=3 [1,5], medium k=4 [2,6], detailed k=5
        // [3,7]; at N=4000 → compact k=9 [7,11].
        const cases = [
            ['compact', 50, 'Tech: 1-5'],
            ['medium', 50, 'Tech: 2-6'],
            ['detailed', 50, 'Tech: 3-7'],
            ['compact', 4000, 'Tech: 7-11']
        ]

        for (const [target, count, expected] of cases) {
            const bookmarks = Array.from({ length: count }, (_, i) => ({
                title: `Bookmark ${i}`,
                url: `https://example.com/${i}`
            }))
            global.fetch = vi.fn(async () => orResponse(JSON.stringify(healthySchema)))
            await generateSchema(bookmarks, 'sk-or-test-key', ['Tech'], undefined, target)

            const prompt = JSON.parse(global.fetch.mock.calls[0][1].body).messages[1].content
            expect(prompt).toContain('PER-CATEGORY SUBFOLDER RANGES')
            expect(prompt).toContain(expected)
            expect(prompt).toContain("within that category's own range")
            expect(prompt).toContain('bands, not quotas')
            expect(prompt).toContain('is INVALID and will be rejected')
            expect(prompt).toMatch(/Never use "General", "Other", "Misc" or "Various" as a subcategory name/)
        }
    })

    it('shapes the per-category ask from measured census shares when the collection is lopsided', async () => {
        // 3990 of 4000 bookmarks in Finance; Health and Travel hold 5 each.
        // The dominant category earns the full band, the near-empty ones are
        // asked for minimal structure instead of padded near-duplicates.
        const hugeBookmarks = Array.from({ length: 4000 }, (_, i) => ({
            title: `Bookmark ${i}`,
            url: `https://example.com/${i}`
        }))
        const names = ['Finance & Crypto', 'Health & Fitness', 'Travel']

        global.fetch = vi.fn()
            .mockImplementationOnce(async (url, options) => {
                const prompt = JSON.parse(options.body).messages[1].content
                const marker = 'BOOKMARKS (in order):'
                const sample = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length, prompt.lastIndexOf(']') + 1).trim())
                const assignments = sample.map(({ url: bookmarkUrl }) => {
                    const i = Number(bookmarkUrl.split('/').pop())
                    return i < 3997 ? 0 : i % 2 === 0 ? 1 : 2
                })
                return orResponse(JSON.stringify({ assignments }))
            })
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        await generateSchema(hugeBookmarks, 'sk-or-test-key', names, undefined, 'medium')

        const prompt = JSON.parse(global.fetch.mock.calls[1][1].body).messages[1].content
        expect(prompt).toContain('PER-CATEGORY SUBFOLDER RANGES')
        // Damped natural scale: medium target 12, band ±2.
        expect(prompt).toContain('Finance & Crypto: 10-14')
        // Zero sample presence → zero material → minimal structure.
        expect(prompt).toContain("Health & Fitness: exactly 1")
        expect(prompt).toContain('Travel: exactly 1')
        expect(prompt).toContain("within that category's own range")
    })

    it('requests the raised schema token ceiling', async () => {
        global.fetch = vi.fn(async () => orResponse(JSON.stringify(healthySchema)))

        await generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'])

        expect(JSON.parse(global.fetch.mock.calls[0][1].body).max_tokens).toBe(SCHEMA_MAX_TOKENS)
        expect(SCHEMA_MAX_TOKENS).toBe(16000)
    })
})

describe('detail schema validation', () => {
    const records = (category, sub_category, count) => Array.from({ length: count }, (_, i) => ({
        title: `${sub_category} Bookmark ${i + 1}`,
        url: `https://example.test/${category}/${sub_category}/${i + 1}`,
        category,
        sub_category
    }))

    it('accepts valid names, normalizes duplicates, rejects invalid names, and caps folders by group size', () => {
        const requested = new Map([
            ['tech\u0000frontend', records('Tech', 'Frontend', 6)],
            ['finance\u0000markets', records('Finance', 'Markets', 12)]
        ])

        const result = validateDetailSchema({ groups: [
            {
                category: 'Tech',
                sub_category: 'Frontend',
                detail_categories: [
                    '  React  ', 'react', 'CSS', 'Frontend', 'General', 'Other',
                    'Docs / Guides', '', 'Components'
                ]
            },
            {
                category: 'Finance',
                sub_category: 'Markets',
                detail_categories: ['Stocks', 'Options', 'Crypto', 'Investing', 'Trading']
            }
        ] }, requested)

        expect(result.ok).toBe(true)
        expect(result.schemas.get('tech\u0000frontend')).toEqual(['React', 'CSS', 'Components'])
        expect(result.schemas.get('finance\u0000markets')).toEqual(['Stocks', 'Options', 'Crypto', 'Investing'])
        expect(result.schemas.has('unknown\u0000parent')).toBe(false)
    })

    it('isolates unknown parent pairs and omits groups with fewer than two valid names', () => {
        const requested = new Map([
            ['tech\u0000frontend', records('Tech', 'Frontend', 6)],
            ['design\u0000systems', records('Design', 'Systems', 6)]
        ])

        const result = validateDetailSchema({ groups: [
            { category: 'Unknown', sub_category: 'Parent', detail_categories: ['One', 'Two'] },
            { category: 'Tech', sub_category: 'Frontend', detail_categories: ['Frameworks', 'General'] },
            { category: 'Design', sub_category: 'Systems', detail_categories: ['One Valid', 'Systems', 'Docs / Guides'] }
        ] }, requested)

        expect(result.ok).toBe(false)
        expect(result.schemas.size).toBe(0)
        expect(result.issues.join(' ')).toMatch(/usable|valid/i)
    })

    it('returns false only when every requested group is unusable', () => {
        const requested = new Map([
            ['tech\u0000frontend', records('Tech', 'Frontend', 6)],
            ['design\u0000systems', records('Design', 'Systems', 6)]
        ])

        const result = validateDetailSchema({ groups: [
            { category: 'Unknown', sub_category: 'Parent', detail_categories: ['One', 'Two'] },
            { category: 'Tech', sub_category: 'Frontend', detail_categories: ['Frameworks', 'Libraries'] },
            { category: 'Design', sub_category: 'Systems', detail_categories: ['General', 'Systems'] }
        ] }, requested)

        expect(result.ok).toBe(true)
        expect([...result.schemas.entries()]).toEqual([
            ['tech\u0000frontend', ['Frameworks', 'Libraries']]
        ])
    })

    it('builds a bounded, evenly sampled prompt with the required detail JSON contract', () => {
        const requested = new Map(Array.from({ length: 13 }, (_, groupIndex) => {
            const category = `Category ${groupIndex + 1}`
            const sub_category = `Topic ${groupIndex + 1}`
            return [`${category.toLowerCase()}\u0000${sub_category.toLowerCase()}`, records(category, sub_category, 70)]
        }))

        const prompt = buildDetailSchemaPrompt(requested)
        const encoded = prompt.slice(prompt.indexOf('BOOKMARK GROUPS:') + 'BOOKMARK GROUPS:'.length).trim()
        const groups = JSON.parse(encoded)

        expect(groups).toHaveLength(DETAIL_SCHEMA_GROUP_LIMIT)
        expect(groups[0].bookmarks).toHaveLength(DETAIL_SCHEMA_SAMPLE_LIMIT)
        expect(groups[0].bookmarks[0]).toMatchObject({ title: 'Topic 1 Bookmark 1', url: expect.any(String), i: 0 })
        expect(groups[0].bookmarks.at(-1).i).toBe(59)
        expect(prompt).toContain('{ "groups": [{ "category": "...", "sub_category": "...", "detail_categories": ["..."] }] }')
        expect(prompt).toMatch(/Title Case|at least 2|meaningful/i)
        expect(prompt).toMatch(/no filler|path/i)
    })

    it('exports the exact detail limits used by validation and prompting', () => {
        expect(DETAIL_SCHEMA_GROUP_LIMIT).toBe(12)
        expect(DETAIL_SCHEMA_SAMPLE_LIMIT).toBe(60)
        expect(DETAIL_MIN_BOOKMARKS).toBe(6)
        expect(DETAIL_MIN_FOLDER_SIZE).toBe(2)
        expect(DETAIL_MAX_FOLDERS).toBe(4)
    })
})

describe('generate detail schemas', () => {
    const group = (category, sub_category, count = 6) => Array.from({ length: count }, (_, i) => ({
        title: `${category} ${sub_category} ${i + 1}`,
        url: `https://example.test/${category}/${sub_category}/${i + 1}`,
        category,
        sub_category
    }))

    it('retries one invalid response for correction and returns its usable schemas', async () => {
        const requested = new Map([['tech\u0000frontend', group('Tech', 'Frontend')]])
        global.fetch = vi.fn()
            .mockImplementationOnce(async () => orResponse(JSON.stringify({ groups: [] })))
            .mockImplementationOnce(async () => orResponse(JSON.stringify({ groups: [
                { category: 'Tech', sub_category: 'Frontend', detail_categories: ['Frameworks', 'Styling'] }
            ] })))

        const events = []
        const result = await generateDetailSchemas(requested, 'sk-or-test-key', undefined, null, (event) => events.push(event))

        expect(result.get('tech\u0000frontend')).toEqual(['Frameworks', 'Styling'])
        expect(global.fetch).toHaveBeenCalledTimes(2)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ isSchemaCorrection: true, isRateLimit: false })
        expect(JSON.parse(global.fetch.mock.calls[1][1].body).messages[1].content).toContain('CORRECTION REQUIRED')
    })

    it('keeps valid sibling batches when another batch remains unusable', async () => {
        const requested = new Map(Array.from({ length: 13 }, (_, i) => [
            `category ${i + 1}\u0000topic ${i + 1}`,
            group(`Category ${i + 1}`, `Topic ${i + 1}`)
        ]))
        // Content-dispatched mock: batches run concurrently, so responses
        // cannot depend on fetch call order.
        global.fetch = vi.fn(async (_url, options) => {
            const prompt = JSON.parse(options.body).messages[1].content
            if (prompt.includes('Category 13')) {
                return orResponse(JSON.stringify({ groups: [
                    { category: 'Category 13', sub_category: 'Topic 13', detail_categories: ['Alpha', 'Beta'] }
                ] }))
            }
            return orResponse(JSON.stringify({ groups: [] }))
        })

        const result = await generateDetailSchemas(requested, 'sk-or-test-key')

        expect(result.size).toBe(1)
        expect(result.get('category 13\u0000topic 13')).toEqual(['Alpha', 'Beta'])
        expect(global.fetch).toHaveBeenCalledTimes(3)
    })

    it('returns an empty map for a terminal detail-stage request failure', async () => {
        const requested = new Map([['tech\u0000frontend', group('Tech', 'Frontend')]])
        global.fetch = vi.fn(async () => ({
            ok: false,
            status: 400,
            text: async () => JSON.stringify({ error: { message: 'invalid request' } })
        }))

        const result = await generateDetailSchemas(requested, 'sk-or-test-key')

        expect(result).toEqual(new Map())
        expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it('preserves the existing cancellation path', async () => {
        const requested = new Map([['tech\u0000frontend', group('Tech', 'Frontend')]])
        const isCancelled = vi.fn(() => true)
        global.fetch = vi.fn()

        await expect(generateDetailSchemas(requested, 'sk-or-test-key', undefined, isCancelled))
            .rejects.toMatchObject({ isCancelled: true })
        expect(global.fetch).not.toHaveBeenCalled()
    })
})

describe('generateInferredSchema', () => {
    let originalFetch

    beforeEach(() => {
        originalFetch = global.fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
    })

    it('designs from an evenly spaced sample and permits model-generated top-level categories', async () => {
        const bookmarks = Array.from({ length: 1005 }, (_, index) => ({
            title: `Bookmark ${index + 1}`,
            url: `https://example.com/${index + 1}`
        }))
        let body
        global.fetch = vi.fn(async (url, options) => {
            body = JSON.parse(options.body)
            return orResponse(JSON.stringify({
                categories: [
                    { name: 'Engineering', sub_categories: ['Frontend', 'Backend'] },
                    { name: 'Research', sub_categories: ['Papers', 'Reference'] },
                    { name: 'Personal', sub_categories: ['Health', 'Travel'] }
                ]
            }))
        })

        const schema = await generateInferredSchema(bookmarks, 'sk-or-test-key')
        const prompt = body.messages[1].content

        // A 400-bookmark evenly spaced sample: includes the head of the
        // collection but never the unsampled tail, and tells the model it is
        // designing for the entire collection.
        expect(prompt).toContain('Bookmark 1')
        expect(prompt).not.toContain('Bookmark 1005')
        expect(prompt).toContain('representative sample of 1000 bookmarks drawn evenly')
        expect(prompt).toContain('ENTIRE collection of 1005')
        expect(prompt).not.toContain('FIXED TOP-LEVEL CATEGORIES')
        expect(schema.categories.map(category => category.name)).toEqual(['Engineering', 'Research', 'Personal'])
    })

    it('rejects two unusable inferred schemas with schemaInvalid', async () => {
        const flat = { categories: [{ name: 'Links', sub_categories: [] }] }
        global.fetch = vi.fn(async () => orResponse(JSON.stringify(flat)))

        await expect(generateInferredSchema(manyBookmarks, 'sk-or-test-key', undefined, 'medium'))
            .rejects.toMatchObject({ schemaInvalid: true })
        expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('reports inferred schema correction through onRetry', async () => {
        const flat = { categories: [{ name: 'Links', sub_categories: [] }] }
        global.fetch = vi.fn()
            .mockImplementationOnce(async () => orResponse(JSON.stringify(flat)))
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const events = []
        const schema = await generateInferredSchema(
            manyBookmarks,
            'sk-or-test-key',
            undefined,
            'medium',
            null,
            (event) => events.push(event)
        )

        expect(global.fetch).toHaveBeenCalledTimes(2)
        expect(schema).toEqual(healthySchema)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
            attempt: 1,
            delayMs: 0,
            isRateLimit: false,
            isSchemaCorrection: true
        })
        expect(events[0].error.message).toMatch(/subcategories|flat/i)
    })

    it('passes cancellation and retry callbacks through to inferred generation', async () => {
        const isCancelled = vi.fn(() => true)
        const onRetry = vi.fn()
        global.fetch = vi.fn()

        await expect(generateInferredSchema(manyBookmarks, 'sk-or-test-key', undefined, '1-3', isCancelled, onRetry))
            .rejects.toMatchObject({ isCancelled: true })

        expect(isCancelled).toHaveBeenCalled()
        expect(onRetry).not.toHaveBeenCalled()
        expect(global.fetch).not.toHaveBeenCalled()
    })
})

describe('classifyBatch hybrid subcategory proposals', () => {
    let originalFetch

    const classifyResponse = (classified) =>
        orResponse(JSON.stringify({ classified }))

    const threeBookmarks = [
        { title: 'A', url: 'https://a.example.com' },
        { title: 'B', url: 'https://b.example.com' },
        { title: 'C', url: 'https://c.example.com' }
    ]

    beforeEach(() => {
        originalFetch = global.fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
    })

    it.each(['Index  Funds', 'index fund', ' Index\tFund '])('rejects another category\'s subfolder variant %j', async (sub_category) => {
        const schema = { categories: [
            { name: 'Tech', sub_categories: ['Developer Tools'] },
            { name: 'Finance', sub_categories: ['Index Funds'] }
        ] }
        global.fetch = vi.fn(async () => classifyResponse(threeBookmarks.map((_, i) => ({ i, category: 'Tech', sub_category }))))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', schema)

        expect(result.every(r => r.category === 'Tech' && r.sub_category === 'General' && !r.proposed)).toBe(true)
    })

    it('canonicalizes approved plural and spacing variants, including names shared by categories', async () => {
        const schema = { categories: [
            { name: 'Tech', sub_categories: ['Developer Tools', 'News Feeds'] },
            { name: 'Finance', sub_categories: ['News Feeds'] }
        ] }
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Tech', sub_category: 'Developer Tool' },
            { i: 1, category: 'Tech', sub_category: 'Developer  Tools' },
            { i: 2, category: 'Finance', sub_category: 'News Feed' }
        ]))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', schema)

        expect(result.map(r => r.sub_category)).toEqual(['Developer Tools', 'Developer Tools', 'News Feeds'])
        expect(result.every(r => !r.proposed)).toBe(true)
    })

    it('keeps a sub_category absent from the schema and flags it as proposed', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Tech & Development', sub_category: 'Web Development' },
            { i: 1, category: 'Tech & Development', sub_category: 'Rust Ecosystem' },
            { i: 2, category: 'Tech & Development', sub_category: 'Rust Ecosystem' }
        ]))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        expect(result[0].sub_category).toBe('Web Development')
        expect(result[0].proposed).toBeUndefined()

        expect(result[1].sub_category).toBe('Rust Ecosystem')
        expect(result[1].proposed).toBe(true)
        expect(result[2].proposed).toBe(true)
    })

    it('matches schema sub-categories case-insensitively rather than calling them proposed', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Tech & Development', sub_category: '  web development  ' },
            { i: 1, category: 'tech & development', sub_category: 'Databases' },
            { i: 2, category: 'Tech & Development', sub_category: 'Security' }
        ]))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        expect(result.every(r => r.proposed === undefined)).toBe(true)
        expect(result[0].sub_category).toBe('Web Development')
    })

    it('emits the schema spelling of a category the model wrote in another casing', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Tech & Development', sub_category: 'Databases' },
            { i: 1, category: 'tech & development', sub_category: 'Databases' },
            { i: 2, category: 'TECH & DEVELOPMENT', sub_category: 'Security' }
        ]))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        // Two spellings of one category would otherwise become two sibling
        // top-level folders, each holding a partial set of the bookmarks.
        expect(new Set(result.map(r => r.category))).toEqual(new Set(['Tech & Development']))
    })

    it('coerces invented and omitted categories to the first approved category', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Totally Made Up', sub_category: 'Something' },
            { i: 1, category: 'Tech & Development', sub_category: 'Databases' },
            { i: 2, category: 'Tech & Development', sub_category: 'Security' }
        ]))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        expect(result[0].category).toBe('Finance & Crypto')
        expect(result[0].sub_category).toBe('General')
        expect(result[0].proposed).toBeUndefined()
    })

    it('never marks General as proposed, and fills in missing entries', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Tech & Development', sub_category: 'General' }
            // indexes 1 and 2 omitted entirely by the model
        ]))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        expect(result).toHaveLength(3)
        expect(result[0]).toMatchObject({ category: 'Tech & Development', sub_category: 'General' })
        expect(result[0].proposed).toBeUndefined()
        expect(result[1]).toMatchObject({ category: 'Finance & Crypto', sub_category: 'General' })
        expect(result[2]).toMatchObject({ category: 'Finance & Crypto', sub_category: 'General' })
    })

    it('preserves clean titles and source fields alongside a proposed subcategory', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Finance & Crypto', sub_category: 'Options Trading', clean_title: '  Barchart Options  ' }
        ]))

        const source = [{ title: 'Barchart Options Screener | barchart.com', url: 'https://barchart.com', icon: 'data:image/png;base64,AA', add_date: '1700000000' }]
        const result = await classifyBatch(source, 'sk-or-test-key', healthySchema, undefined, true)

        expect(result[0]).toMatchObject({
            title: 'Barchart Options',
            url: 'https://barchart.com',
            icon: 'data:image/png;base64,AA',
            add_date: '1700000000',
            category: 'Finance & Crypto',
            sub_category: 'Options Trading',
            proposed: true
        })
    })

    it('instructs the model that categories are fixed but sub-categories may be proposed', async () => {
        global.fetch = vi.fn(async () => classifyResponse([]))

        await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        const prompt = JSON.parse(global.fetch.mock.calls[0][1].body).messages[1].content
        expect(prompt).toContain('CATEGORY is fixed')
        expect(prompt).toContain('Never invent a new category')
        expect(prompt).toMatch(/at least 3 bookmarks in THIS batch share a clear, specific theme/)
        expect(prompt).toMatch(/Use "General" as the sub_category ONLY when/)
    })
})

describe('truncation handling differs between schema design and classification', () => {
    let originalFetch

    beforeEach(() => {
        originalFetch = global.fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
        vi.useRealTimers()
    })

    it('salvages a truncated schema response instead of burning retries on it', async () => {
        const truncated = '{"categories":[{"name":"Finance","sub_categories":["Trading","Crypto","Investing"]},'
            + '{"name":"Tech","sub_categories":["Web Dev","AI","DevOps"]},'
            + '{"name":"Travel","sub_categories":["Flights","Hotels","Guides"]},'
            + '{"name":"Heal'
        global.fetch = vi.fn(async () => orResponse(truncated, 'length'))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', ['Finance'], undefined, 'compact')

        expect(global.fetch).toHaveBeenCalledTimes(1)
        expect(schema.categories.map(c => c.name)).toEqual(['Finance'])
    })

    it('re-prompts when a salvaged schema is too narrow to classify the collection against', async () => {
        // Cut off after category 2 of a 6-category ask: structurally valid, but
        // omitted selected categories would have only their General fallback.
        const truncated = '{"categories":[{"name":"Finance","sub_categories":["Trading","Crypto","Investing"]},'
            + '{"name":"Tech","sub_categories":["Web Dev","AI","DevOp'
        const sixCategories = ['Finance', 'Tech', 'Travel', 'Health', 'Design', 'Shopping']

        global.fetch = vi.fn()
            .mockImplementationOnce(async () => censusAllInFirst())
            .mockImplementationOnce(async () => orResponse(truncated, 'length'))
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', sixCategories, undefined, 'compact')

        expect(global.fetch).toHaveBeenCalledTimes(3)
        expect(JSON.parse(global.fetch.mock.calls[2][1].body).messages[1].content)
            .toMatch(/covered only 2 categories; at least 3 are needed/)
        expect(schema.categories.map(c => c.name)).toEqual(sixCategories)
    })

    it('still retries a truncated schema when nothing can be recovered', async () => {
        global.fetch = vi.fn()
            .mockImplementationOnce(async () => orResponse('totally unparseable', 'length'))
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'], undefined, 'medium')

        expect(global.fetch).toHaveBeenCalledTimes(2)
        expect(schema.categories.map(c => c.name)).toEqual(['Tech'])
    })

    it('never salvages a truncated classification batch, since the tail would be lost bookmarks', async () => {
        vi.useFakeTimers()

        const truncated = '{"classified":[{"i":0,"category":"Tech","sub_category":"Web Dev"'
        global.fetch = vi.fn(async () => orResponse(truncated, 'length'))

        let cancelled = false
        const retryEvents = []

        const promise = classifyBatch(
            [{ title: 'Example', url: 'https://example.com' }],
            'sk-or-test-key',
            healthySchema,
            'google/gemini-3.1-flash-lite',
            false,
            () => cancelled,
            (evt) => {
                retryEvents.push(evt)
                cancelled = true
            }
        )
        const rejection = expect(promise).rejects.toMatchObject({ isCancelled: true })

        await vi.advanceTimersByTimeAsync(200)
        await rejection

        // A retry was scheduled, proving the truncated body was rejected rather than salvaged.
        expect(retryEvents).toHaveLength(1)
        expect(retryEvents[0].error.message).toMatch(/cut off/)
    })
})

describe('native Gemini response path', () => {
    let originalFetch

    const geminiBody = (call) => JSON.parse(call[1].body)

    beforeEach(() => {
        originalFetch = global.fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
        vi.useRealTimers()
    })

    it('salvages a schema cut off at MAX_TOKENS rather than burning a retry', async () => {
        const truncated = '{"categories":[{"name":"Finance","sub_categories":["Trading","Crypto","Investing"]},'
            + '{"name":"Tech","sub_categories":["Web Dev","AI","DevOps"]},'
            + '{"name":"Travel","sub_categories":["Flights","Hotels","Guides"]},'
            + '{"name":"Heal'
        global.fetch = vi.fn(async () => geminiResponse([truncated], 'MAX_TOKENS'))

        const schema = await generateSchema(manyBookmarks, GEMINI_KEY, ['Finance'], undefined, 'compact')

        expect(global.fetch).toHaveBeenCalledTimes(1)
        expect(schema.categories.map(c => c.name)).toEqual(['Finance'])
    })

    it('reassembles a response split across several content parts', async () => {
        const whole = JSON.stringify(healthySchema)
        const parts = [whole.slice(0, 40), whole.slice(40, 200), whole.slice(200)]
        global.fetch = vi.fn(async () => geminiResponse(parts))

        const schema = await generateSchema(manyBookmarks, GEMINI_KEY, ['Tech'], undefined, 'medium')

        expect(global.fetch).toHaveBeenCalledTimes(1)
        expect(schema.categories.map(c => c.name)).toEqual(['Tech'])
    })

    it('treats a safety block as permanent and does not retry it', async () => {
        global.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } })
        }))

        await expect(
            generateSchema(manyBookmarks, GEMINI_KEY, ['Tech'], undefined, 'medium')
        ).rejects.toThrow(/Gemini blocked the request \(SAFETY\)/)

        expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it('sends the bare model id and a JSON generationConfig', async () => {
        global.fetch = vi.fn(async () => geminiResponse([JSON.stringify(healthySchema)]))

        await generateSchema(manyBookmarks, GEMINI_KEY, ['Tech'], 'google/gemini-3.1-flash-lite', 'medium')

        const [url, options] = global.fetch.mock.calls[0]
        expect(url).toContain('/v1beta/models/gemini-3.1-flash-lite:generateContent')
        expect(options.headers).not.toHaveProperty('Authorization')

        const body = geminiBody(global.fetch.mock.calls[0])
        expect(body.generationConfig).toMatchObject({
            maxOutputTokens: SCHEMA_MAX_TOKENS,
            responseMimeType: 'application/json'
        })
        expect(body.system_instruction.parts[0].text).toMatch(/information architect/)
    })

    it('never salvages a classification batch cut off at MAX_TOKENS', async () => {
        vi.useFakeTimers()

        const truncated = '{"classified":[{"i":0,"category":"Tech & Development","sub_category":"Web Development"'
        global.fetch = vi.fn(async () => geminiResponse([truncated], 'MAX_TOKENS'))

        let cancelled = false
        const retryEvents = []

        const promise = classifyBatch(
            [{ title: 'Example', url: 'https://example.com' }],
            GEMINI_KEY,
            healthySchema,
            'google/gemini-3.1-flash-lite',
            false,
            () => cancelled,
            (evt) => {
                retryEvents.push(evt)
                cancelled = true
            }
        )
        const rejection = expect(promise).rejects.toMatchObject({ isCancelled: true })

        await vi.advanceTimersByTimeAsync(200)
        await rejection

        expect(retryEvents).toHaveLength(1)
        expect(retryEvents[0].error.message).toMatch(/cut off/)
    })
})
