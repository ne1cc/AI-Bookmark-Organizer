import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FolderTree from './FolderTree'

const nodes = [
    { name: 'Tech', path: ['Tech'], children: [{ name: 'Web', path: ['Tech', 'Web'], children: [] }] },
    { name: 'Travel', path: ['Travel'], children: [] }
]

const setup = () => {
    const onMove = vi.fn()
    const onMerge = vi.fn()
    render(
        <FolderTree
            nodes={nodes}
            defaultExpanded
            actionsFor={(node) => (node.path.length === 1 ? ['merge'] : ['move', 'merge'])}
            onMove={onMove}
            onMerge={onMerge}
            moveTargets={() => [{ path: ['Travel'], label: 'Travel' }]}
            mergeTargets={(node) => (node.path.length === 1 ? [{ path: ['Travel'], label: 'Travel' }] : [])}
        />
    )
    return { onMove, onMerge }
}

const choose = (name, path) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value: JSON.stringify(path) } })

afterEach(cleanup)

describe('FolderTree move and merge', () => {
    it('does not move when a target is only selected (arrowing a closed select fires change)', () => {
        const { onMove } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Move Web' }))
        choose('Move Web to', ['Travel'])

        expect(onMove).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Confirm move of Web to Travel' }))
        expect(onMove).toHaveBeenCalledWith(nodes[0].children[0], ['Travel'])
        expect(screen.queryByRole('combobox')).toBeNull()
    })

    it('does not merge when a target is only selected, and merges once confirmed', () => {
        const { onMerge } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Merge Tech' }))
        choose('Merge Tech into', ['Travel'])

        expect(onMerge).not.toHaveBeenCalled()
        const confirm = screen.getByRole('button', { name: 'Confirm merge of Tech into Travel' })
        expect(confirm.textContent).toBe('Merge')
        fireEvent.click(confirm)
        expect(onMerge).toHaveBeenCalledWith(nodes[0], ['Travel'])
    })

    it('shows no confirm button until a target is chosen, and hides it again for the placeholder', () => {
        setup()

        fireEvent.click(screen.getByRole('button', { name: 'Move Web' }))
        expect(screen.queryByRole('button', { name: /^Confirm move/ })).toBeNull()
        choose('Move Web to', ['Travel'])
        expect(screen.getByRole('button', { name: /^Confirm move/ }).textContent).toBe('Move')
        fireEvent.change(screen.getByRole('combobox', { name: 'Move Web to' }), { target: { value: '' } })
        expect(screen.queryByRole('button', { name: /^Confirm move/ })).toBeNull()
    })

    it('cancels with Escape from the select or the confirm button', () => {
        const { onMove } = setup()

        fireEvent.click(screen.getByRole('button', { name: 'Move Web' }))
        choose('Move Web to', ['Travel'])
        fireEvent.keyDown(screen.getByRole('combobox', { name: 'Move Web to' }), { key: 'Escape' })
        expect(screen.queryByRole('combobox')).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Move Web' }))
        choose('Move Web to', ['Travel'])
        fireEvent.keyDown(screen.getByRole('button', { name: 'Confirm move of Web to Travel' }), { key: 'Escape' })
        expect(screen.queryByRole('combobox')).toBeNull()
        expect(onMove).not.toHaveBeenCalled()
    })
})
