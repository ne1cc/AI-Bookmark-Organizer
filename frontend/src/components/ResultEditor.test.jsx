import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import ResultEditor from './ResultEditor'

// Tech/Web/Frameworks x2, Tech/Web/Tooling x1, Tech/Data x2, Tech directly x1, Travel/Flights x2, Travel/Hotels x1
const rows = () => [
    { category: 'Tech', sub_category: 'Web', detail_category: 'Frameworks', count: 2 },
    { category: 'Tech', sub_category: 'Web', detail_category: 'Tooling', count: 1 },
    { category: 'Tech', sub_category: 'Data', detail_category: null, count: 2 },
    { category: 'Tech', sub_category: 'General', detail_category: null, count: 1 },
    { category: 'Travel', sub_category: 'Flights', detail_category: null, count: 2 },
    { category: 'Travel', sub_category: 'Hotels', detail_category: null, count: 1 }
]

const setup = (props = {}) => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    render(<ResultEditor rows={rows()} onSave={onSave} onDiscard={onDiscard} {...props} />)
    return { onSave, onDiscard }
}

const expand = (name) => fireEvent.click(screen.getByRole('button', { name: `Expand ${name}` }))

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ResultEditor', () => {
    it('starts collapsed, shows counts, and reveals levels two and three on demand', () => {
        setup()

        const dialog = screen.getByRole('dialog', { name: 'Edit organized folders' })
        expect(within(dialog).getByText('9 bookmarks · 2 categories · 0 edits')).toBeDefined()
        expect(screen.queryByText('Web')).toBeNull()
        expand('Tech')
        expect(screen.getByText('Web')).toBeDefined()
        expect(screen.queryByText('Frameworks')).toBeNull()
        expand('Web')
        expect(screen.getByText('Frameworks')).toBeDefined()
        expect(screen.getByText('(1 directly here)', { exact: false })).toBeDefined()
    })

    it('records a rename as an operation and updates the tree', () => {
        const { onSave } = setup()
        expand('Tech')

        fireEvent.click(screen.getByRole('button', { name: 'Rename Web' }))
        const input = screen.getByRole('textbox', { name: 'New name for Web' })
        fireEvent.change(input, { target: { value: 'Frontend' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(screen.getByText('Frontend')).toBeDefined()
        expect(screen.getByText(/1 edit$/)).toBeDefined()
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))
        expect(onSave).toHaveBeenCalledWith([{ op: 'rename', path: ['Tech', 'Web'], to: 'Frontend' }])
    })

    it('rejects a bad edit inline without recording it', () => {
        const { onSave } = setup()
        expand('Tech')

        fireEvent.click(screen.getByRole('button', { name: 'Rename Web' }))
        const input = screen.getByRole('textbox', { name: 'New name for Web' })
        fireEvent.change(input, { target: { value: 'Data' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(screen.getAllByRole('alert')[0].textContent).toMatch(/already exists/i)
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))
        expect(onSave).toHaveBeenCalledWith([])
    })

    it('does not offer delete on categories or add anywhere', () => {
        setup()

        expect(screen.queryByRole('button', { name: 'Delete Tech' })).toBeNull()
        expect(screen.queryByRole('button', { name: /^Add subfolder/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Add category/ })).toBeNull()
    })

    it('deletes a subfolder after confirming how many bookmarks move up', () => {
        const { onSave } = setup()
        expand('Tech')

        fireEvent.click(screen.getByRole('button', { name: 'Delete Web' }))
        expect(screen.getByRole('alertdialog').textContent).toMatch(/Delete Web\? Its 3 bookmarks move up one level\./)
        fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))

        expect(onSave).toHaveBeenCalledWith([{ op: 'delete', path: ['Tech', 'Web'] }])
    })

    it('moves a subfolder to another category and a third-level folder to another subfolder', () => {
        const { onSave } = setup()
        expand('Tech')
        expand('Web')

        fireEvent.click(screen.getByRole('button', { name: 'Move Data' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'Move Data to' }), { target: { value: JSON.stringify(['Travel']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Move Tooling' }))
        const options = within(screen.getByRole('combobox', { name: 'Move Tooling to' })).getAllByRole('option').map(o => o.textContent)
        expect(options).not.toContain('Tech / Web')
        expect(options).toContain('Travel / Flights')
        fireEvent.change(screen.getByRole('combobox', { name: 'Move Tooling to' }), { target: { value: JSON.stringify(['Travel', 'Flights']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))

        expect(onSave).toHaveBeenCalledWith([
            { op: 'move', path: ['Tech', 'Data'], to: ['Travel'] },
            { op: 'move', path: ['Tech', 'Web', 'Tooling'], to: ['Travel', 'Flights'] }
        ])
    })

    it('merges at the same level only', () => {
        const { onSave } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Merge Travel' }))
        const options = within(screen.getByRole('combobox', { name: 'Merge Travel into' })).getAllByRole('option').map(o => o.textContent)
        expect(options).toEqual(['Merge into…', 'Tech'])
        fireEvent.change(screen.getByRole('combobox', { name: 'Merge Travel into' }), { target: { value: JSON.stringify(['Tech']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Save edits' }))

        expect(onSave).toHaveBeenCalledWith([{ op: 'merge', path: ['Travel'], to: ['Tech'] }])
    })

    it('restores previously saved edits', () => {
        setup({ initialOps: [{ op: 'rename', path: ['Travel'], to: 'Trips' }] })

        expect(screen.getByText('Trips')).toBeDefined()
        expect(screen.getByText(/1 edit$/)).toBeDefined()
    })

    it('asks before discarding edits', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
        const { onDiscard } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Rename Travel' }))
        const input = screen.getByRole('textbox', { name: 'New name for Travel' })
        fireEvent.change(input, { target: { value: 'Trips' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

        expect(confirm).toHaveBeenCalledTimes(1)
        expect(onDiscard).not.toHaveBeenCalled()
    })
})
