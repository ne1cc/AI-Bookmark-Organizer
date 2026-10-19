import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import FolderTree from './FolderTree'

const nodes = [
    { name: 'Tech', path: ['Tech'], children: [{ name: 'Web', path: ['Tech', 'Web'], children: [] }] },
    { name: 'Travel', path: ['Travel'], children: [] }
]

const setup = (overrides = {}) => {
    const handlers = {
        onMove: vi.fn(), onMerge: vi.fn(), onReorder: vi.fn(),
        ...overrides
    }
    render(
        <FolderTree
            nodes={nodes}
            defaultExpanded
            actionsFor={(node) => (node.path.length === 1 ? ['rename', 'merge', 'delete'] : ['rename', 'move', 'merge', 'delete'])}
            moveTargets={() => [{ path: ['Travel'], label: 'Travel' }]}
            mergeTargets={(node) => (node.path.length === 1 ? [{ path: ['Travel'], label: 'Travel' }] : [{ path: ['Travel'], label: 'Travel' }])}
            {...handlers}
        />
    )
    return handlers
}

const rowOf = (name) => screen.getByRole('treeitem', { name }).querySelector('div[tabindex]')
const dragFrom = (name) => fireEvent.dragStart(rowOf(name))
const dropOn = (name, init) => fireEvent.drop(rowOf(name), init)
const openMenu = (name) => fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }))
// jsdom has no DragEvent, so clientY has to be defined on a hand-built event for edge drops.
const dragOverAt = (name, clientY) => {
    const evt = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(evt, 'clientY', { value: clientY })
    fireEvent(rowOf(name), evt)
}

beforeAll(() => {
    // jsdom reports zero-height boxes; give rows a stable height so edge math (before/onto/after) works.
    vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, width: 100, height: 100 })
})

afterEach(cleanup)

describe('FolderTree renaming', () => {
    it('starts renaming on double-click and commits on Enter', () => {
        const onRename = vi.fn()
        setup({ onRename })

        fireEvent.doubleClick(screen.getByText('Tech'))
        const input = screen.getByRole('textbox', { name: 'New name for Tech' })
        fireEvent.change(input, { target: { value: 'Technology' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(onRename).toHaveBeenCalledWith(nodes[0], 'Technology')
    })

    it('starts renaming with F2 on a focused row and cancels with Escape', () => {
        const onRename = vi.fn()
        setup({ onRename })

        fireEvent.keyDown(rowOf('Tech'), { key: 'F2' })
        const input = screen.getByRole('textbox', { name: 'New name for Tech' })
        fireEvent.keyDown(input, { key: 'Escape' })

        expect(onRename).not.toHaveBeenCalled()
        expect(screen.queryByRole('textbox')).toBeNull()
    })
})

describe('FolderTree drag and drop', () => {
    it('moves a subfolder by dropping it on another category', () => {
        const { onMove } = setup()

        dragFrom('Web')
        fireEvent.dragOver(rowOf('Travel'))
        dropOn('Travel')

        expect(onMove).toHaveBeenCalledWith(nodes[0].children[0], ['Travel'])
    })

    it('ignores dropping a subfolder back on its own category', () => {
        const { onMove } = setup()

        dragFrom('Web')
        fireEvent.dragOver(rowOf('Tech'))
        dropOn('Tech')

        expect(onMove).not.toHaveBeenCalled()
    })

    it('asks before merging a category dropped on a sibling, and cancels cleanly', () => {
        const { onMerge } = setup()

        dragFrom('Tech')
        fireEvent.dragOver(rowOf('Travel'))
        dropOn('Travel')
        expect(onMerge).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(onMerge).not.toHaveBeenCalled()

        dragFrom('Tech')
        fireEvent.dragOver(rowOf('Travel'))
        dropOn('Travel')
        expect(screen.getByRole('alertdialog').textContent).toMatch(/Merge “Tech” into “Travel”\?/)
        fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
        expect(onMerge).toHaveBeenCalledWith(nodes[0], ['Travel'])
    })

    it('reorders when dragged between rows and onReorder is provided', () => {
        const { onReorder } = setup()

        dragFrom('Travel')
        dragOverAt('Tech', 10)
        dropOn('Tech')

        expect(onReorder).toHaveBeenCalledWith(nodes[1], ['Tech'], 'before')
    })

    it('treats an edge drop as a merge when reordering is not available', () => {
        const { onReorder, onMerge } = setup({ onReorder: undefined })

        dragFrom('Travel')
        dragOverAt('Tech', 10)
        dropOn('Tech')

        expect(onReorder).toBeUndefined()
        expect(onMerge).not.toHaveBeenCalled()
        expect(screen.getByRole('alertdialog').textContent).toMatch(/Merge “Travel” into “Tech”\?/)
    })

    it('does nothing when a category is dropped on a subfolder', () => {
        const { onMove, onMerge, onReorder } = setup()

        dragFrom('Travel')
        fireEvent.dragOver(rowOf('Web'))
        dropOn('Web')

        expect(onMove).not.toHaveBeenCalled()
        expect(onMerge).not.toHaveBeenCalled()
        expect(onReorder).not.toHaveBeenCalled()
    })
})

describe('FolderTree actions menu', () => {
    it('opens from the ⋯ button and from right-click, and moves after select + confirm', () => {
        const { onMove } = setup()

        openMenu('Web')
        expect(screen.getByRole('group', { name: 'Actions for Web' })).toBeTruthy()
        fireEvent.keyDown(screen.getByRole('group', { name: 'Actions for Web' }), { key: 'Escape' })
        expect(screen.queryByRole('group', { name: 'Actions for Web' })).toBeNull()

        fireEvent.contextMenu(rowOf('Web'))
        fireEvent.click(screen.getByRole('button', { name: 'Move Web' }))
        fireEvent.change(screen.getByRole('combobox', { name: 'Move Web to' }), { target: { value: JSON.stringify(['Travel']) } })
        fireEvent.click(screen.getByRole('button', { name: 'Confirm move of Web to Travel' }))

        expect(onMove).toHaveBeenCalledWith(nodes[0].children[0], ['Travel'])
    })

    it('renames from the menu and deletes folders with children only after confirm', () => {
        const onRename = vi.fn()
        const onDelete = vi.fn()
        setup({ onRename, onDelete })

        openMenu('Tech')
        fireEvent.click(screen.getByRole('button', { name: 'Rename Tech' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'New name for Tech' }), { target: { value: 'Technology' } })
        fireEvent.keyDown(screen.getByRole('textbox', { name: 'New name for Tech' }), { key: 'Enter' })
        expect(onRename).toHaveBeenCalledWith(nodes[0], 'Technology')

        openMenu('Tech')
        fireEvent.click(screen.getByRole('button', { name: 'Delete Tech' }))
        expect(screen.getByRole('alertdialog').textContent).toMatch(/Delete Tech/)
        fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
        expect(onDelete).toHaveBeenCalledWith(nodes[0])
    })
})
