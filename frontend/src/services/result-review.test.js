import { describe, expect, it, vi } from 'vitest'
import { OrganizerService } from './organizer'
import { applyOps, buildRows } from './resultEditor'

// The real applyOps, wrapped so a test can make it throw once.
vi.mock('./resultEditor', async (importOriginal) => {
    const actual = await importOriginal()
    return { ...actual, applyOps: vi.fn(actual.applyOps) }
})

const bm = (n, category, sub_category, detail_category = null) => ({
    title: `B${n}`, url: `https://example.com/${n}`, category, sub_category, detail_category
})

const items = () => [
    bm(1, 'Tech', 'Web', 'Frameworks'), bm(2, 'Tech', 'Web', 'Frameworks'), bm(3, 'Tech', 'Web', 'Tooling'),
    bm(4, 'Tech', 'Data'), bm(5, 'Travel', 'Flights')
]

// reviewResult only touches these members, so exercise it on a minimal stand-in.
const harness = (answers) => {
    const fake = {
        isCancelled: false,
        onProgress: vi.fn(),
        cancelled: vi.fn(() => null),
        stats: { detailFoldersCount: 2, detailedSubcategories: 1 },
        categoryAliases: new Map(),
        resultReviewer: vi.fn(async () => answers.shift())
    }
    return { fake, review: (classified) => OrganizerService.prototype.reviewResult.call(fake, classified) }
}

describe('reviewResult (phase 2 gate)', () => {
    it('passes the records straight through when no reviewer is set', async () => {
        const { fake, review } = harness([])
        fake.resultReviewer = null
        const input = items()

        expect(await review(input)).toBe(input)
    })

    it('shows the grouped folder rows and returns the records untouched when saved without edits', async () => {
        const { fake, review } = harness([{ decision: 'approve' }])
        const input = items()

        expect(await review(input)).toBe(input)
        expect(fake.resultReviewer).toHaveBeenCalledWith(buildRows(input), null)
    })

    it('applies the edits to the real bookmarks and recomputes the third-level counts', async () => {
        const { fake, review } = harness([{ decision: 'approve', ops: [{ op: 'delete', path: ['Tech', 'Web', 'Tooling'] }] }])

        const out = await review(items())

        expect(out.find(b => b.title === 'B3')).toMatchObject({ url: 'https://example.com/3', category: 'Tech', sub_category: 'Web', detail_category: null })
        expect(fake.stats).toEqual({ detailFoldersCount: 1, detailedSubcategories: 1 })
    })

    it('asks again with the reason when an edit cannot be applied, then accepts a good answer', async () => {
        const { fake, review } = harness([
            { decision: 'approve', ops: [{ op: 'rename', path: ['Nope'], to: 'X' }] },
            { decision: 'approve', ops: [{ op: 'rename', path: ['Travel'], to: 'Trips' }] }
        ])
        const input = items()

        const out = await review(input)

        expect(fake.resultReviewer).toHaveBeenNthCalledWith(2, buildRows(input), expect.stringMatching(/no longer exists/i))
        expect(out.find(b => b.title === 'B5').category).toBe('Trips')
    })

    it('cancels the run when the user cancels', async () => {
        const { fake, review } = harness([{ decision: 'cancel' }])

        expect(await review(items())).toBeNull()
        expect(fake.cancelled).toHaveBeenCalled()
    })

    it('asks again instead of crashing when applying the edits throws', async () => {
        applyOps.mockImplementationOnce(() => { throw new Error('boom') })
        const { fake, review } = harness([
            { decision: 'approve', ops: [{ op: 'rename', path: ['Travel'], to: 'Trips' }] },
            { decision: 'approve', ops: [{ op: 'rename', path: ['Travel'], to: 'Trips' }] }
        ])
        const input = items()

        const out = await review(input)

        expect(fake.resultReviewer).toHaveBeenNthCalledWith(2, buildRows(input), expect.stringMatching(/could not be applied/i))
        expect(out.find(b => b.title === 'B5').category).toBe('Trips')
    })

    it.each([
        ['no answer', undefined],
        ['null', null],
        ['a bare string', 'approve'],
        ['an unknown decision', { decision: 'regenerate' }],
        ['a missing decision', { ops: [] }]
    ])('fails closed and cancels on %s', async (_label, answer) => {
        const { fake, review } = harness([answer])

        expect(await review(items())).toBeNull()
        expect(fake.cancelled).toHaveBeenCalled()
    })

    it('records how category names changed so renamed categories keep their place', async () => {
        const { fake, review } = harness([{
            decision: 'approve',
            ops: [
                { op: 'rename', path: ['Tech'], to: 'Technology' },
                { op: 'rename', path: ['Technology'], to: 'Computing' },
                { op: 'rename', path: ['Travel'], to: 'Trips' },
                { op: 'merge', path: ['Trips'], to: ['Computing'] }
            ]
        }])

        await review(items())

        expect([...fake.categoryAliases]).toEqual([['Computing', 'Tech']])
    })

    it('leaves the alias map empty when saved without edits', async () => {
        const { fake, review } = harness([{ decision: 'approve' }])

        await review(items())

        expect(fake.categoryAliases.size).toBe(0)
    })
})

describe('runAI with the result review', () => {
    const stub = (order, reviewResult) => ({
        isCancelled: false,
        categories: [],
        dateSpan: null,
        schemaSortOrder: 'alpha',
        designSchema: vi.fn(async () => { order.push('design'); return { categories: [{ name: 'Tech', sub_categories: ['Web'] }] } }),
        reviewPlan: vi.fn(async (links, schema) => { order.push('reviewPlan'); return schema }),
        classifyAll: vi.fn(async () => { order.push('classify'); return items() }),
        reconcileClassified: vi.fn((classified) => { order.push('reconcile'); return classified }),
        rehomeLoose: vi.fn(async (classified) => { order.push('rehome'); return classified }),
        enrichDetails: vi.fn(async (classified) => { order.push('enrich'); return classified }),
        categoryAliases: new Map(),
        reviewResult: vi.fn(reviewResult),
        sortAndStrip: vi.fn((classified) => { order.push('sort'); return classified }),
        writeFile: vi.fn(() => { order.push('write') }),
        finishAI: vi.fn((finalResults) => { order.push('finish'); return finalResults })
    })

    it('pauses for the result review after the third level is built and before sorting and writing', async () => {
        const order = []
        const fake = stub(order, async (classified) => { order.push('reviewResult'); return classified })

        await OrganizerService.prototype.runAI.call(fake, { links: [{}], duplicatesRemoved: 0, isBrowserMode: false })

        expect(order).toEqual(['design', 'reviewPlan', 'classify', 'reconcile', 'rehome', 'enrich', 'reviewResult', 'sort', 'write', 'finish'])
    })

    it('stops before sorting when the result review is cancelled', async () => {
        const order = []
        const fake = stub(order, async () => { order.push('reviewResult'); return null })

        const out = await OrganizerService.prototype.runAI.call(fake, { links: [{}], duplicatesRemoved: 0, isBrowserMode: false })

        expect(out).toBeNull()
        expect(order).not.toContain('sort')
        expect(order).not.toContain('write')
    })
})

describe('category order after the result review', () => {
    // Schema order Tech, Travel, Food (not alphabetical); the real reviewResult and sortAndStrip run.
    const run = async (answer) => {
        const fake = {
            isCancelled: false,
            categories: [],
            dateSpan: null,
            schemaSortOrder: 'alpha',
            stats: { detailFoldersCount: 0, detailedSubcategories: 0 },
            categoryAliases: new Map(),
            onProgress: vi.fn(),
            cancelled: vi.fn(() => null),
            resultReviewer: vi.fn(async () => answer),
            designSchema: vi.fn(async () => ({ categories: [{ name: 'Tech', sub_categories: [] }, { name: 'Travel', sub_categories: [] }, { name: 'Food', sub_categories: [] }] })),
            reviewPlan: vi.fn(async (links, schema) => schema),
            classifyAll: vi.fn(async () => [...items(), bm(6, 'Food', 'Recipes')]),
            reconcileClassified: vi.fn((classified) => classified),
            rehomeLoose: vi.fn(async (classified) => classified),
            enrichDetails: vi.fn(async (classified) => classified),
            reviewResult: OrganizerService.prototype.reviewResult,
            sortAndStrip: vi.fn(OrganizerService.prototype.sortAndStrip),
            writeFile: vi.fn(),
            finishAI: vi.fn((finalResults) => finalResults)
        }
        const out = await OrganizerService.prototype.runAI.call(fake, { links: [{}], duplicatesRemoved: 0, isBrowserMode: false })
        const rank = fake.sortAndStrip.mock.calls[0][1]
        const written = [...new Set(out.map(b => b.category))]
        const rankedPresent = [...rank.keys()].filter(name => written.includes(name))
        return { rank, written, rankedPresent }
    }

    it('keeps a renamed first category first, in the sort and in the folder order', async () => {
        const { rank, written, rankedPresent } = await run({ decision: 'approve', ops: [{ op: 'rename', path: ['Tech'], to: 'Zeta' }] })

        expect(rank.get('Zeta')).toBe(rank.get('Tech'))
        expect(written).toEqual(['Zeta', 'Travel', 'Food'])
        expect(rankedPresent).toEqual(['Zeta', 'Travel', 'Food'])
    })

    it('removes a merged category and keeps the target where it was', async () => {
        const { written, rankedPresent } = await run({ decision: 'approve', ops: [
            { op: 'rename', path: ['Travel'], to: 'Trips' },
            { op: 'merge', path: ['Tech'], to: ['Trips'] }
        ] })

        expect(written).toEqual(['Trips', 'Food'])
        expect(rankedPresent).toEqual(['Trips', 'Food'])
    })

    it('leaves the schema order untouched when saved without edits', async () => {
        const { rank, written } = await run({ decision: 'approve' })

        expect([...rank]).toEqual([['Tech', 0], ['Travel', 1], ['Food', 2]])
        expect(written).toEqual(['Tech', 'Travel', 'Food'])
    })
})
