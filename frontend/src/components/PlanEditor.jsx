import { useMemo, useState } from 'react'
import EditorDialog from './EditorDialog'
import FolderTree from './FolderTree'
import {
    addCategory, addSubfolder, mergeCategories, mergeSubfolders, moveSubfolder,
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
    const [error, setError] = useState('')
    const nodes = useMemo(() => toNodes(draft), [draft])
    const { categories, subfolders } = summarize(draft)

    // Applies an edit; returns the error text (shown on the row) or null.
    const apply = (result) => {
        if (result.error) { setError(result.error); return result.error }
        setError('')
        setDraft(result.plan)
        return null
    }

    // Folder order follows the plan's array order, so a drop between rows reorders there.
    // Dropping past a row of another category moves the subfolder first, then places it.
    const reorder = (node, targetPath, position) => {
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
            error={error}
            onSave={() => onSave(draft)}
            onDiscard={onDiscard}
        >
            <FolderTree
                nodes={nodes}
                defaultExpanded
                onReorder={reorder}
                actionsFor={(node) => (node.path.length === 1 ? ['rename', 'add', 'delete', 'merge'] : ['rename', 'delete', 'move', 'merge'])}
                onRename={(node, name) => apply(node.path.length === 1
                    ? renameCategory(draft, node.path[0], name)
                    : renameSubfolder(draft, node.path[0], node.path[1], name))}
                onAdd={(node, name) => apply(addSubfolder(draft, node.path[0], name))}
                onAddRoot={(name) => apply(addCategory(draft, name))}
                onDelete={(node) => apply(node.path.length === 1
                    ? removeCategory(draft, node.path[0])
                    : removeSubfolder(draft, node.path[0], node.path[1]))}
                deleteMessage={(node) => `Delete ${node.name} and its ${node.children.length} subfolder${node.children.length === 1 ? '' : 's'}?`}
                moveTargets={(node) => draft.categories
                    .filter(category => category.name !== node.path[0])
                    .map(category => ({ path: [category.name], label: category.name }))}
                mergeTargets={(node) => (node.path.length === 1
                    ? draft.categories.filter(category => category.name !== node.path[0]).map(category => ({ path: [category.name], label: category.name }))
                    : draft.categories.flatMap(category => category.sub_categories
                        .filter(sub => !(category.name === node.path[0] && sub === node.path[1]))
                        .map(sub => ({ path: [category.name, sub], label: `${category.name} / ${sub}` }))))}
                onMove={(node, target) => apply(moveSubfolder(draft, node.path[0], node.path[1], target[0]))}
                onMerge={(node, target) => apply(node.path.length === 1
                    ? mergeCategories(draft, node.path[0], target[0])
                    : mergeSubfolders(draft, { category: node.path[0], name: node.path[1] }, { category: target[0], name: target[1] }))}
            />
        </EditorDialog>
    )
}
