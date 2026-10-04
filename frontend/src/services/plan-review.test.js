import { describe, expect, it, vi } from 'vitest'
import { OrganizerService } from './organizer'

// reviewPlan only touches these members, so exercise it on a minimal stand-in.
const harness = (decisions, designs = []) => {
    const fake = {
        isCancelled: false,
        onProgress: vi.fn(),
        cancelled: vi.fn(() => null),
        designSchema: vi.fn(async () => designs.shift()),
        planReviewer: vi.fn(async () => decisions.shift())
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

    it('returns the proposed schema once approved, without designing again', async () => {
        const { fake, review } = harness(['approve'])

        expect(await review(plan('Tech'))).toEqual(plan('Tech'))
        expect(fake.designSchema).not.toHaveBeenCalled()
    })

    it('designs a new plan on regenerate and asks about the new one', async () => {
        const { fake, review } = harness(['regenerate', 'approve'], [plan('Reading')])

        expect(await review(plan('Tech'))).toEqual(plan('Reading'))
        expect(fake.designSchema).toHaveBeenCalledTimes(1)
        expect(fake.planReviewer).toHaveBeenNthCalledWith(2, plan('Reading'))
    })

    it('cancels the run when the user cancels', async () => {
        const { fake, review } = harness(['cancel'])

        expect(await review(plan('Tech'))).toBeNull()
        expect(fake.cancelled).toHaveBeenCalled()
    })

    it('stops when the design pass is cancelled while regenerating', async () => {
        const { review } = harness(['regenerate'], [null])

        expect(await review(plan('Tech'))).toBeNull()
    })
})
