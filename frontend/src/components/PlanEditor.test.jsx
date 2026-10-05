import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import PlanEditor from './PlanEditor'

const plan = () => ({
    categories: [
        { name: 'Tech', sub_categories: ['Web', 'Data'] },
        { name: 'Travel', sub_categories: ['Flights'] }
    ]
})

const setup = () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    render(<PlanEditor plan={plan()} onSave={onSave} onDiscard={onDiscard} />)
    return { onSave, onDiscard }
}

const rename = (from, to) => {
    fireEvent.click(screen.getByRole('button', { name: `Rename ${from}` }))
    const input = screen.getByRole('textbox', { name: `New name for ${from}` })
    fireEvent.change(input, { target: { value: to } })
    fireEvent.keyDown(input, { key: 'Enter' })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('PlanEditor', () => {
    it('is a labelled modal dialog that shows the live counts', () => {
        setup()

        const dialog = screen.getByRole('dialog', { name: 'Edit folder plan' })
        expect(dialog.getAttribute('aria-modal')).toBe('true')
        expect(within(dialog).getByText('2 categories · 3 subfolders')).toBeDefined()
    })

    it('renames a subfolder and saves the edited plan', () => {
        const { onSave } = setup()

        rename('Web', 'Frontend')
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(onSave).toHaveBeenCalledWith({
            categories: [
                { name: 'Tech', sub_categories: ['Frontend', 'Data'] },
                { name: 'Travel', sub_categories: ['Flights'] }
            ]
        })
    })

    it('shows an inline reason and keeps editing when a name is not allowed', () => {
        const { onSave } = setup()

        rename('Web', 'Data')

        expect(screen.getByRole('textbox', { name: 'New name for Web' })).toBeDefined()
        expect(screen.getAllByRole('alert')[0].textContent).toMatch(/already exists/i)
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(onSave.mock.calls[0][0].categories[0].sub_categories).toEqual(['Web', 'Data'])
    })

    it('adds a category and a subfolder under it', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: '+ Add category' }))
        const root = screen.getByRole('textbox', { name: /new category/i })
        fireEvent.change(root, { target: { value: 'Reading' } })
        fireEvent.keyDown(root, { key: 'Enter' })
        fireEvent.click(screen.getByRole('button', { name: 'Add subfolder to Reading' }))
        const sub = screen.getByRole('textbox', { name: 'Name for the new subfolder in Reading' })
        fireEvent.change(sub, { target: { value: 'Blogs' } })
        fireEvent.keyDown(sub, { key: 'Enter' })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(onSave.mock.calls[0][0].categories.at(-1)).toEqual({ name: 'Reading', sub_categories: ['Blogs'] })
    })

    it('asks before deleting a category that has subfolders, with the count', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Delete Tech' }))
        expect(screen.getByRole('alertdialog').textContent).toMatch(/Delete Tech and its 2 subfolders\?/)
        fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(onSave.mock.calls[0][0].categories.map(c => c.name)).toEqual(['Travel'])
    })

    it('deletes a subfolder without asking, and refuses to delete the last category', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Delete Web' }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete Travel' }))
        fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete Tech' }))
        fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

        expect(screen.getByRole('status').textContent).toMatch(/at least one category/i)
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(onSave.mock.calls[0][0]).toEqual({ categories: [{ name: 'Tech', sub_categories: ['Data'] }] })
    })

    it('moves a subfolder to another category', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Move Web' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'Move Web to' }), { target: { value: JSON.stringify(['Travel']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Confirm move of Web to Travel' }))
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(onSave.mock.calls[0][0].categories).toEqual([
            { name: 'Tech', sub_categories: ['Data'] },
            { name: 'Travel', sub_categories: ['Flights', 'Web'] }
        ])
    })

    it('merges a subfolder into another folder and a category into another category', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Merge Web' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'Merge Web into' }), { target: { value: JSON.stringify(['Travel', 'Flights']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Confirm merge of Web into Travel / Flights' }))
        fireEvent.click(screen.getByRole('button', { name: 'Merge Travel' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'Merge Travel into' }), { target: { value: JSON.stringify(['Tech']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Confirm merge of Travel into Tech' }))
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(onSave.mock.calls[0][0]).toEqual({ categories: [{ name: 'Tech', sub_categories: ['Data', 'Flights'] }] })
    })

    it('discards without asking when nothing changed, and asks once when something did', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
        const { onDiscard } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
        expect(onDiscard).toHaveBeenCalledTimes(1)
        expect(confirm).not.toHaveBeenCalled()

        rename('Web', 'Frontend')
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(onDiscard).toHaveBeenCalledTimes(1)

        confirm.mockReturnValue(true)
        fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
        expect(onDiscard).toHaveBeenCalledTimes(2)
    })

    it('moves focus into the dialog and returns it to the opener on close', () => {
        const opener = document.createElement('button')
        document.body.appendChild(opener)
        opener.focus()

        const { unmount } = render(<PlanEditor plan={plan()} onSave={() => {}} onDiscard={() => {}} />)
        expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)

        unmount()
        expect(document.activeElement).toBe(opener)
        opener.remove()
    })

    it('Tab on the last focusable wraps to the first', () => {
        setup()
        const dialog = screen.getByRole('dialog')
        const buttons = dialog.querySelectorAll('button:not([disabled]), input, select')
        const last = buttons[buttons.length - 1]
        const first = buttons[0]
        last.focus()

        const proceeded = fireEvent.keyDown(document.activeElement, { key: 'Tab' })

        expect(proceeded).toBe(false)
        expect(document.activeElement).toBe(first)
    })

    it('Shift+Tab on the first focusable wraps to the last', () => {
        setup()
        const dialog = screen.getByRole('dialog')
        const buttons = dialog.querySelectorAll('button:not([disabled]), input, select')
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        first.focus()

        const proceeded = fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true })

        expect(proceeded).toBe(false)
        expect(document.activeElement).toBe(last)
    })

    it('Focus lost to body is pulled back in', () => {
        setup()
        const dialog = screen.getByRole('dialog')

        fireEvent.click(screen.getByRole('button', { name: 'Delete Web' }))
        document.activeElement.blur()
        expect(document.activeElement).toBe(document.body)

        fireEvent.keyDown(document.body, { key: 'Tab' })

        expect(dialog.contains(document.activeElement)).toBe(true)
    })

    it('Escape with focus on body still asks to discard when dirty', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
        const { onDiscard } = setup()

        rename('Web', 'Frontend')
        document.activeElement.blur()
        expect(document.activeElement).toBe(document.body)

        fireEvent.keyDown(document.body, { key: 'Escape' })

        expect(confirm).toHaveBeenCalledTimes(1)
        expect(onDiscard).not.toHaveBeenCalled()
    })
})
