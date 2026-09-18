import { describe, expect, it } from 'vitest'
import { reconcileSubcategories, canonicalKey } from './reconcile'

// Builds `count` bookmarks sharing one category/sub_category pair.
const items = (category, sub_category, count, opts = {}) =>
    Array.from({ length: count }, (_, i) => ({
        title: `${sub_category} ${i}`,
        url: `https://example.com/${encodeURIComponent(sub_category)}/${i}`,
        category,
        sub_category,
        ...opts
    }))

const schema = {
    categories: [
        { name: 'Tech', sub_categories: ['Web Development', 'Databases'] },
        { name: 'Finance', sub_categories: ['Trading'] }
    ]
}

const subsIn = (result, category) =>
    result.classified.filter(b => b.category === category).map(b => b.sub_category)

describe('canonicalKey', () => {
    it('collapses case, spacing and a trailing plural', () => {
        expect(canonicalKey('AI Tools')).toBe(canonicalKey('ai tool'))
        expect(canonicalKey('  Web   Development ')).toBe('web development')
    })
})

describe('reconcileSubcategories', () => {
    it.each([0, 1])('prefers the approved spelling even when it appears only %i times', (approvedCount) => {
        const classified = [
            ...items('Tech', 'Developer Tool', 4, { proposed: true }),
            ...items('Tech', 'developer  tools', 2, { proposed: true }),
            ...items('Tech', 'Developer Tools', approvedCount)
        ]
        const approved = { categories: [{ name: 'Tech', sub_categories: ['Developer Tools'] }] }

        const result = reconcileSubcategories(classified, approved)

        expect(new Set(subsIn(result, 'Tech'))).toEqual(new Set(['Developer Tools']))
        expect(result.summary.proposedKept).toBe(0)
    })

    it('is a no-op on empty or non-array input', () => {
        expect(reconcileSubcategories([], schema).classified).toEqual([])
        expect(reconcileSubcategories(null, schema).classified).toEqual([])
        expect(reconcileSubcategories(undefined, schema).summary.merged).toBe(0)
    })

    it('merges spelling variants onto the most frequent spelling', () => {
        const classified = [
            ...items('Tech', 'AI Tools', 4, { proposed: true }),
            ...items('Tech', 'ai tools', 2, { proposed: true }),
            ...items('Tech', 'AI Tool', 1, { proposed: true })
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: 'medium' })

        expect(new Set(subsIn(result, 'Tech'))).toEqual(new Set(['AI Tools']))
        expect(result.summary.merged).toBe(2)
        expect(result.summary.proposedKept).toBe(1)
    })

    it('keeps identically named subcategories separate across categories', () => {
        const classified = [
            ...items('Tech', 'News', 5),
            ...items('Finance', 'News', 5)
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: 'medium' })

        expect(new Set(subsIn(result, 'Tech'))).toEqual(new Set(['News']))
        expect(new Set(subsIn(result, 'Finance'))).toEqual(new Set(['News']))
        expect(result.summary.orphansFolded).toBe(0)
    })

    it('folds an undersized subcategory into the nearest related sibling', () => {
        const classified = [
            ...items('Tech', 'Web Development', 6),
            ...items('Tech', 'Web Frameworks', 2, { proposed: true })
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: 'medium' })

        // "Web Frameworks" shares the token "web", so it joins Web Development
        // rather than being dumped in General.
        expect(new Set(subsIn(result, 'Tech'))).toEqual(new Set(['Web Development']))
        expect(result.summary.orphansFolded).toBe(1)
        expect(result.summary.proposedFolded).toBe(1)
    })

    it('sends an undersized subcategory with no related sibling to General', () => {
        const classified = [
            ...items('Tech', 'Web Development', 6),
            ...items('Tech', 'Knitting Patterns', 1, { proposed: true })
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: 'medium' })

        expect(subsIn(result, 'Tech').filter(s => s === 'General')).toHaveLength(1)
        expect(result.summary.orphansFolded).toBe(1)
    })

    it('never folds an orphan into another folder that is itself dissolving', () => {
        const classified = [
            ...items('Tech', 'Web Development', 6),
            ...items('Tech', 'Web Alpha', 1, { proposed: true }),
            ...items('Tech', 'Web Beta', 1, { proposed: true })
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: 'medium' })

        expect(new Set(subsIn(result, 'Tech'))).toEqual(new Set(['Web Development']))
        expect(result.summary.orphansFolded).toBe(2)
    })

    it('uses a lower orphan threshold at the finest granularity', () => {
        const classified = [
            ...items('Tech', 'Web Development', 6),
            ...items('Tech', 'Rust Ecosystem', 2, { proposed: true })
        ]

        const balanced = reconcileSubcategories(
            classified.map(b => ({ ...b })), schema, { subfolderTarget: 'medium' }
        )
        const detailed = reconcileSubcategories(
            classified.map(b => ({ ...b })), schema, { subfolderTarget: 'detailed' }
        )

        // minCount is 3 at 'medium' so the 2-item folder dissolves, but 2 at 'detailed'.
        expect(new Set(subsIn(balanced, 'Tech'))).not.toContain('Rust Ecosystem')
        expect(new Set(subsIn(detailed, 'Tech'))).toContain('Rust Ecosystem')
    })

    it('caps subcategories per category, folding the overflow into its nearest kin', () => {
        const classified = []
        // 26 distinct viable subcategories of 4 bookmarks each: population 104
        // → dynamic cap = 2 × round(0.7 × √104) = 14 for 'medium'.
        for (let i = 0; i < 26; i++) {
            classified.push(...items('Tech', `Topic ${String.fromCharCode(65 + i)}`, 4, { proposed: true }))
        }

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: 'medium' })

        const distinct = new Set(subsIn(result, 'Tech'))
        expect(distinct.size).toBe(14)
        expect(distinct).not.toContain('General')
        expect(distinct).toContain('Topic A')
        expect(distinct).not.toContain('Topic Z')
        expect(result.summary.cappedFolded).toBe(12)
    })

    it('sends capped overflow to General only when it shares no token with a survivor', () => {
        const classified = []
        // 20 topics of 4 bookmarks each plus Knitting Patterns (3): population
        // 83 → dynamic cap = 2 × round(0.7 × √83) = 12 for 'medium'. The cap
        // keeps the 12 largest groups; topics M–Z overflow but share the token
        // "topic" with a survivor, so they fold into it; Knitting Patterns
        // shares nothing and goes to General.
        for (let i = 0; i < 20; i++) {
            classified.push(...items('Tech', `Topic ${String.fromCharCode(65 + i)}`, 4, { proposed: true }))
        }
        classified.push(...items('Tech', 'Knitting Patterns', 3, { proposed: true }))

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: 'medium' })

        expect(subsIn(result, 'Tech').filter(s => s === 'General')).toHaveLength(3)
        expect(result.summary.cappedFolded).toBe(9)
    })

    it('never dissolves a whole category when no subcategory clears the floor', () => {
        // 4 categories x 2 subcategories x 2 bookmarks. Nothing reaches
        // minCount (3), which used to empty `kept` and rename every group to
        // General — the branch's own bug, one layer down. All 8 groups clear
        // the rescue floor of 2 and fit inside the tier ceiling.
        const classified = []
        const wideSchema = { categories: [] }
        for (let c = 0; c < 4; c++) {
            const category = `Category ${c}`
            const subs = [0, 1].map(s => `Topic ${c}${s}`)
            wideSchema.categories.push({ name: category, sub_categories: subs })
            subs.forEach(sub => classified.push(...items(category, sub, 2)))
        }

        const result = reconcileSubcategories(classified, wideSchema, { subfolderTarget: 'medium' })

        expect(result.classified).toHaveLength(16)
        expect(result.classified.filter(b => b.sub_category === 'General')).toHaveLength(0)
        expect(new Set(result.classified.map(b => b.sub_category)).size).toBe(8)
        expect(result.summary.orphansFolded).toBe(0)
    })

    it('still dissolves a category whose every subcategory holds a single bookmark', () => {
        // The rescue floor is deliberately 2: a one-bookmark folder is the
        // sprawl the schema prompt bans, so it stays folded.
        const classified = [
            ...items('Tech', 'Alpha', 1),
            ...items('Tech', 'Bravo', 1),
            ...items('Tech', 'Charlie', 1),
            ...items('Tech', 'Delta', 1)
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: 'medium' })

        expect(subsIn(result, 'Tech')).toEqual(['General', 'General', 'General', 'General'])
        expect(result.summary.orphansFolded).toBe(4)
    })

    it('does not engage the rescue when the normal survivor path already applies', () => {
        const classified = [
            ...items('Tech', 'Web Development', 5),
            ...items('Tech', 'Data Science', 5),
            ...items('Tech', 'Web Frameworks', 1, { proposed: true }),
            ...items('Tech', 'Web Tooling', 1, { proposed: true }),
            ...items('Tech', 'Data Pipelines', 1, { proposed: true })
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: 'medium' })

        expect(new Set(subsIn(result, 'Tech'))).toEqual(new Set(['Web Development', 'Data Science']))
        expect(result.summary.orphansFolded).toBe(3)
    })

    it('leaves General bookmarks and exempt categories untouched', () => {
        const classified = [
            ...items('Tech', 'General', 4),
            ...items('Archive', 'Broken Links', 1),
            ...items('Tech', 'Web Development', 5)
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: 'medium' })

        expect(subsIn(result, 'Tech').filter(s => s === 'General')).toHaveLength(4)
        expect(subsIn(result, 'Archive')).toEqual(['Broken Links'])
        expect(result.summary.orphansFolded).toBe(0)
    })

    it('strips the internal proposed flag from every bookmark', () => {
        const classified = [
            ...items('Tech', 'Rust Ecosystem', 5, { proposed: true }),
            ...items('Tech', 'Web Development', 5)
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: 'medium' })

        expect(result.classified.every(b => !('proposed' in b))).toBe(true)
    })

    it('is deterministic regardless of the order batches completed in', () => {
        const build = () => [
            ...items('Tech', 'AI Tools', 3, { proposed: true }),
            ...items('Tech', 'ai tools', 3, { proposed: true }),
            ...items('Tech', 'Web Development', 4)
        ]

        const forward = reconcileSubcategories(build(), schema, { subfolderTarget: 'medium' })
        const reversed = reconcileSubcategories(build().reverse(), schema, { subfolderTarget: 'medium' })

        expect(new Set(subsIn(forward, 'Tech'))).toEqual(new Set(subsIn(reversed, 'Tech')))
        expect(forward.summary).toEqual(reversed.summary)
    })
})
