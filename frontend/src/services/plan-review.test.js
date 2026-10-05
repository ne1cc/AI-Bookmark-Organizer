import { describe, expect, it, vi } from 'vitest'
import { OrganizerService } from './organizer'

// reviewPlan only touches these members, so exercise it on a minimal stand-in.
const harness = (answers, designs = []) => {
    const fake = {
        isCancelled: false,
        onProgress: vi.fn(),
        cancelled: vi.fn(() => null),
        designSchema: vi.fn(async () => designs.shift()),
        planReviewer: vi.fn(async () => answers.shift())
    }
    return { fake, review: (schema) => OrganizerService.prototype.reviewPlan.call(fake, ['link'], schema) }
}

const plan = (name) => ({ categories: [{ name, sub_categories: ['A'] }] })

describe('reviewPlan (phase 1 gate)', () => {
    it('passes the schema straight through when no reviewer is set', async () => {
        const { fake, review } = harness([])
        fake.planReviewer = null

        expect(await review(plan('Tech'))).toEqual(plan('Tech'))
    })

    it('returns the proposed schema, marked binding, once approved without designing again', async () => {
        const { fake, review } = harness([{ decision: 'approve' }])

        expect(await review(plan('Tech'))).toEqual({ ...plan('Tech'), binding: true })
        expect(fake.designSchema).not.toHaveBeenCalled()
        expect(fake.planReviewer).toHaveBeenCalledWith(plan('Tech'), null)
    })

    it('uses the normalized edited plan when the answer carries one', async () => {
        const edited = { categories: [{ name: ' Reading ', sub_categories: ['News', 'news', 'General'] }] }
        const { review } = harness([{ decision: 'approve', plan: edited }])

        expect(await review(plan('Tech'))).toEqual({ categories: [{ name: 'Reading', sub_categories: ['News'] }], binding: true })
    })

    it('asks again, with the reason, when the edited plan has no usable category', async () => {
        const { fake, review } = harness([
            { decision: 'approve', plan: { categories: [{ name: '   ', sub_categories: [] }] } },
            { decision: 'approve' }
        ])

        expect(await review(plan('Tech'))).toEqual({ ...plan('Tech'), binding: true })
        expect(fake.planReviewer).toHaveBeenNthCalledWith(2, plan('Tech'), expect.stringMatching(/at least one category/i))
    })

    it('designs a new plan on regenerate and asks about the new one', async () => {
        const { fake, review } = harness([{ decision: 'regenerate' }, { decision: 'approve' }], [plan('Reading')])

        expect(await review(plan('Tech'))).toEqual({ ...plan('Reading'), binding: true })
        expect(fake.designSchema).toHaveBeenCalledTimes(1)
        expect(fake.planReviewer).toHaveBeenNthCalledWith(2, plan('Reading'), null)
    })

    it('cancels the run when the user cancels', async () => {
        const { fake, review } = harness([{ decision: 'cancel' }])

        expect(await review(plan('Tech'))).toBeNull()
        expect(fake.cancelled).toHaveBeenCalled()
    })

    it.each([
        ['no answer', undefined],
        ['null', null],
        ['a bare string', 'approve'],
        ['an unknown decision', { decision: 'save' }],
        ['a missing decision', { plan: plan('Reading') }]
    ])('fails closed and cancels on %s', async (_label, answer) => {
        const { fake, review } = harness([answer])

        expect(await review(plan('Tech'))).toBeNull()
        expect(fake.cancelled).toHaveBeenCalled()
        expect(fake.designSchema).not.toHaveBeenCalled()
    })

    it('stops when the design pass is cancelled while regenerating', async () => {
        const { review } = harness([{ decision: 'regenerate' }], [null])

        expect(await review(plan('Tech'))).toBeNull()
    })
})
