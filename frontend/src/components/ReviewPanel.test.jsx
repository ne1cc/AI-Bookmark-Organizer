import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import ReviewPanel from './ReviewPanel'

const plan = (extra = {}) => ({
    categories: [
        { name: 'Tech', sub_categories: ['Web', 'Data'] },
        { name: 'Travel', sub_categories: ['Flights'] }
    ],
    ...extra
})

const rows = () => [
    { category: 'Tech', sub_category: 'Web', detail_category: 'Frameworks', count: 2 },
    { category: 'Tech', sub_category: 'Web', detail_category: 'Tooling', count: 1 },
    { category: 'Tech', sub_category: 'Data', detail_category: null, count: 2 },
    { category: 'Travel', sub_category: 'Flights', detail_category: null, count: 3 }
]

let session

beforeEach(() => {
    session = { data: {} }
    global.chrome = {
        storage: {
            session: {
                get: vi.fn((keys, cb) => cb({ ...session.data })),
                set: vi.fn((obj) => { Object.assign(session.data, obj) })
            }
        }
    }
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete global.chrome })

const renamePlanFolder = async (from, to) => {
    fireEvent.click(await screen.findByRole('button', { name: `Rename ${from}` }))
    const input = screen.getByRole('textbox', { name: `New name for ${from}` })
    fireEvent.change(input, { target: { value: to } })
    fireEvent.keyDown(input, { key: 'Enter' })
}

describe('ReviewPanel: plan review', () => {
    it('lists the proposed folders and approves them unchanged', () => {
        const onDecide = vi.fn()
        render(<ReviewPanel plan={plan()} result={null} onDecide={onDecide} />)

        const card = screen.getByRole('region', { name: 'Proposed folder plan' })
        expect(within(card).getByText('Tech')).toBeDefined()
        expect(within(card).getByText(/Web, Data/)).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: /Approve & organize/ }))

        expect(onDecide).toHaveBeenCalledWith('plan', 'approve', {})
    })

    it('edits the plan in the editor, shows it as edited, and approves with the edited plan', async () => {
        const onDecide = vi.fn()
        render(<ReviewPanel plan={plan()} result={null} onDecide={onDecide} />)

        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        await renamePlanFolder('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(screen.queryByRole('dialog')).toBeNull()
        const card = screen.getByRole('region', { name: 'Proposed folder plan' })
        expect(within(card).getByText('Edited')).toBeDefined()
        expect(within(card).getByText(/Frontend, Data/)).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: /Approve & organize/ }))

        expect(onDecide).toHaveBeenCalledWith('plan', 'approve', {
            plan: { categories: [{ name: 'Tech', sub_categories: ['Frontend', 'Data'] }, { name: 'Travel', sub_categories: ['Flights'] }] }
        })
    })

    it('treats a saved plan identical to the original as no edit', async () => {
        const onDecide = vi.fn()
        render(<ReviewPanel plan={plan()} result={null} onDecide={onDecide} />)

        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
        fireEvent.click(screen.getByRole('button', { name: /Approve & organize/ }))

        expect(onDecide).toHaveBeenCalledWith('plan', 'approve', {})
    })

    it('asks before a regenerate throws edits away, and not when there are none', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true)
        const onDecide = vi.fn()
        render(<ReviewPanel plan={plan()} result={null} onDecide={onDecide} />)

        fireEvent.click(screen.getByRole('button', { name: 'Regenerate plan' }))
        expect(confirm).not.toHaveBeenCalled()
        expect(onDecide).toHaveBeenCalledWith('plan', 'regenerate')

        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        await renamePlanFolder('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        onDecide.mockClear()

        fireEvent.click(screen.getByRole('button', { name: 'Regenerate plan' }))
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(onDecide).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate plan' }))
        expect(onDecide).toHaveBeenCalledWith('plan', 'regenerate')
    })

    it('shows the reason when the worker rejected the plan, keeping the edits', async () => {
        const { rerender } = render(<ReviewPanel plan={plan()} result={null} onDecide={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        await renamePlanFolder('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        rerender(<ReviewPanel plan={plan({ error: 'The plan needs at least one category.' })} result={null} onDecide={() => {}} />)

        expect(screen.getByRole('alert').textContent).toMatch(/at least one category/i)
        expect(screen.getByText('Edited')).toBeDefined()
    })

    it('drops edits that were made against a different plan', async () => {
        const { rerender } = render(<ReviewPanel plan={plan()} result={null} onDecide={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        await renamePlanFolder('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        rerender(<ReviewPanel plan={{ categories: [{ name: 'Reading', sub_categories: ['News'] }] }} result={null} onDecide={() => {}} />)

        expect(screen.queryByText('Edited')).toBeNull()
        expect(screen.getByText('Reading')).toBeDefined()
    })

    it('mirrors saved edits to session storage and restores them after a reopen', async () => {
        const first = render(<ReviewPanel plan={plan()} result={null} onDecide={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        await renamePlanFolder('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(global.chrome.storage.session.set).toHaveBeenCalledWith({ reviewDraft: expect.objectContaining({ planEdit: expect.objectContaining({ plan: expect.anything() }) }) })
        first.unmount()

        render(<ReviewPanel plan={plan()} result={null} onDecide={() => {}} />)

        expect(await screen.findByText('Edited')).toBeDefined()
        expect(screen.getByText(/Frontend, Data/)).toBeDefined()
    })
})

describe('ReviewPanel: result review', () => {
    it('summarises the organized folders and saves them unchanged', () => {
        const onDecide = vi.fn()
        render(<ReviewPanel plan={null} result={{ rows: rows() }} onDecide={onDecide} />)

        const card = screen.getByRole('region', { name: 'Organized folders ready for review' })
        expect(within(card).getByText(/5 bookmarks/)).toBeDefined()
        expect(within(card).getByText(/3 bookmarks/)).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: 'Save results' }))

        expect(onDecide).toHaveBeenCalledWith('result', 'approve', {})
    })

    it('edits the folders and saves the results with the recorded operations', async () => {
        const onDecide = vi.fn()
        render(<ReviewPanel plan={null} result={{ rows: rows() }} onDecide={onDecide} />)

        fireEvent.click(screen.getByRole('button', { name: 'Edit folders' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Rename Travel' }))
        const input = screen.getByRole('textbox', { name: 'New name for Travel' })
        fireEvent.change(input, { target: { value: 'Trips' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))

        expect(screen.queryByRole('dialog')).toBeNull()
        expect(screen.getByText('1 edit')).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: 'Save results' }))

        expect(onDecide).toHaveBeenCalledWith('result', 'approve', { ops: [{ op: 'rename', path: ['Travel'], to: 'Trips' }] })
    })

    it('shows the reason when the worker rejected the edits', () => {
        render(<ReviewPanel plan={null} result={{ rows: rows(), error: 'The folder "Tech / Web" no longer exists.' }} onDecide={() => {}} />)

        expect(screen.getByRole('alert').textContent).toMatch(/no longer exists/i)
    })
})

describe('ReviewPanel: draft persistence and recovery', () => {
    it('confirmed regenerate clears the edit and updates storage', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true)
        const onDecide = vi.fn()
        const { rerender } = render(<ReviewPanel plan={plan()} result={null} onDecide={onDecide} />)

        fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
        await renamePlanFolder('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        global.chrome.storage.session.set.mockClear()

        fireEvent.click(screen.getByRole('button', { name: 'Regenerate plan' }))

        expect(global.chrome.storage.session.set).toHaveBeenCalledWith({ reviewDraft: expect.objectContaining({ planEdit: null }) })
        expect(onDecide).toHaveBeenCalledWith('plan', 'regenerate')

        rerender(<ReviewPanel plan={plan()} result={null} onDecide={onDecide} />)

        expect(screen.queryByText('Edited')).toBeNull()
    })

    it('ignores a draft from session storage whose base does not match the current plan', () => {
        session.data.reviewDraft = {
            planEdit: { base: '[]', plan: { categories: [{ name: 'Old', sub_categories: [] }] } },
            resultEdit: null
        }
        render(<ReviewPanel plan={plan()} result={null} onDecide={() => {}} />)

        expect(screen.queryByText('Edited')).toBeNull()
        expect(screen.getByText('Tech')).toBeDefined()
    })

    it('restores and persists resultEdit across unmount and remount', async () => {
        const first = render(<ReviewPanel plan={null} result={{ rows: rows() }} onDecide={() => {}} />)

        fireEvent.click(screen.getByRole('button', { name: 'Edit folders' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Rename Travel' }))
        const input = screen.getByRole('textbox', { name: 'New name for Travel' })
        fireEvent.change(input, { target: { value: 'Trips' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))

        expect(global.chrome.storage.session.set).toHaveBeenCalledWith({ reviewDraft: expect.objectContaining({ resultEdit: expect.objectContaining({ ops: expect.arrayContaining([expect.anything()]) }) }) })
        first.unmount()

        render(<ReviewPanel plan={null} result={{ rows: rows() }} onDecide={() => {}} />)

        expect(await screen.findByText('1 edit')).toBeDefined()
    })
})
