import { describe, expect, it, vi } from 'vitest'
import { OrganizerService } from './organizer'
import { buildRows } from './resultEditor'

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
