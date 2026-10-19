import { useMemo, useState } from 'react'
import EditorDialog from './EditorDialog'
import FolderTree from './FolderTree'
import {
    addCategory, addSubfolder, mergeCategories, mergeSubfolders, moveSubfolder, nestCategory, nestPreview, promoteSubfolder,
    removeCategory, removeSubfolder, renameCategory, renameSubfolder, reorderCategory, reorderSubfolder, summarize
} from '../services/planEditor'

const toNodes = (plan) => plan.categories.map(category => ({
    name: category.name,
    path: [category.name],
    children: category.sub_categories.map(sub => ({ name: sub, path: [category.name, sub], children: [] }))
}))

// Edit the AI's proposed plan ({ categories: [{ name, sub_categories }] }) before any bookmark is filed.
export default function PlanEditor({ plan, onSave, onDiscard }) {
    const [draft, setDraft] = useState(plan)
    const [history, setHistory] = useState([]) // earlier drafts, newest last
    const [error, setError] = useState('')
    const nodes = useMemo(() => toNodes(draft), [draft])
    const { categories, subfolders } = summarize(draft)

    // Applies an edit; returns the error text (shown on the row) or null.
    const apply = (result) => {
        if (result.error) { setError(result.error); return result.error }
        setError('')
        setHistory(previous => [...previous, draft])
        setDraft(result.plan)
        return null
    }

    const undo = () => {
        if (history.length === 0) return
        setError('')
        setDraft(history[history.length - 1])
        setHistory(previous => previous.slice(0, -1))
    }

    // Folder order follows the plan's array order, so a drop between rows reorders there.
    // Dropping past a row of another category moves the subfolder first, then places it;
    // dropping a subfolder between categories promotes it to a category at that spot.
    const reorder = (node, targetPath, position) => {
        if (node.path.length === 2 && targetPath.length === 1) {
            const at = draft.categories.findIndex(c => c.name === targetPath[0]) + (position === 'after' ? 1 : 0)
            return apply(promoteSubfolder(draft, node.path[0], node.path[1], at))
        }
        if (node.path.length === 1) {
            const from = draft.categories.findIndex(c => c.name === node.path[0])
            const to = draft.categories.findIndex(c => c.name === targetPath[0])
            const shift = from < to ? (position === 'before' ? -1 : 0) : (position === 'before' ? 0 : 1)
            return apply(reorderCategory(draft, from, to + shift))
        }
        const fromCategory = node.path[0]
        if (fromCategory !== targetPath[0]) {
            const moved = moveSubfolder(draft, fromCategory, node.path[1], targetPath[0])
            if (moved.error) return apply(moved)
            const target = moved.plan.categories.find(c => c.name === targetPath[0])
            let to = target.sub_categories.indexOf(targetPath[1])
            if (position === 'after') to += 1
            return apply(reorderSubfolder(moved.plan, targetPath[0], target.sub_categories.length - 1, to))
        }
        const subs = draft.categories.find(c => c.name === fromCategory).sub_categories
        const from = subs.indexOf(node.path[1])
        const to = subs.indexOf(targetPath[1])
        const shift = from < to ? (position === 'before' ? -1 : 0) : (position === 'before' ? 0 : 1)
        return apply(reorderSubfolder(draft, fromCategory, from, to + shift))
    }

    return (
        <EditorDialog
            title="Edit folder plan"
            summary={`${categories} categor${categories === 1 ? 'y' : 'ies'} · ${subfolders} subfolder${subfolders === 1 ? '' : 's'}`}
            dirty={JSON.stringify(draft) !== JSON.stringify(plan)}
            saveDisabled={categories === 0}
            onUndo={undo}
            canUndo={history.length > 0}
            error={error}
            onSave={() => onSave(draft)}
            onDiscard={onDiscard}
        >
            <FolderTree
                nodes={nodes}
                defaultExpanded
                onReorder={reorder}
                onNest={(node, target, options) => apply(nestCategory(draft, node.path[0], target[0], options))}
                nestPreview={(node, target) => nestPreview(draft, node.path[0], target[0])}
                actionsFor={(node) => (node.path.length === 1 ? ['rename', 'add', 'nest', 'delete', 'merge'] : ['rename', 'delete', 'move', 'merge'])}
                onRename={(node, name) => apply(node.path.length === 1
                    ? renameCategory(draft, node.path[0], name)
                    : renameSubfolder(draft, node.path[0], node.path[1], name))}
                onAdd={(node, name) => apply(addSubfolder(draft, node.path[0], name))}
                onAddRoot={(name) => apply(addCategory(draft, name))}
                onDelete={(node) => apply(node.path.length === 1
                    ? removeCategory(draft, node.path[0])
                    : removeSubfolder(draft, node.path[0], node.path[1]))}
                deleteMessage={(node) => `Delete ${node.name} and its ${node.children.length} subfolder${node.children.length === 1 ? '' : 's'}?`}
                moveTargets={(node) => [
                    ...(node.path.length === 2 ? [{ path: [], label: 'Top level (new category)' }] : []),
                    ...draft.categories
                        .filter(category => category.name !== node.path[0])
                        .map(category => ({ path: [category.name], label: category.name }))
                ]}
                mergeTargets={(node) => (node.path.length === 1
                    ? draft.categories.filter(category => category.name !== node.path[0]).map(category => ({ path: [category.name], label: category.name }))
                    : draft.categories.flatMap(category => category.sub_categories
                        .filter(sub => !(category.name === node.path[0] && sub === node.path[1]))
                        .map(sub => ({ path: [category.name, sub], label: `${category.name} / ${sub}` }))))}
                onMove={(node, target) => apply(target.length === 0
                    ? promoteSubfolder(draft, node.path[0], node.path[1], draft.categories.length)
                    : moveSubfolder(draft, node.path[0], node.path[1], target[0]))}
                onMerge={(node, target) => apply(node.path.length === 1
                    ? mergeCategories(draft, node.path[0], target[0])
                    : mergeSubfolders(draft, { category: node.path[0], name: node.path[1] }, { category: target[0], name: target[1] }))}
            />
        </EditorDialog>
    )
}
