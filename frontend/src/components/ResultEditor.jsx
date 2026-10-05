import { useMemo, useState } from 'react'
import EditorDialog from './EditorDialog'
import FolderTree from './FolderTree'
import { applyOps, buildTree } from '../services/resultEditor'

const flatten = (nodes) => nodes.flatMap(node => [node, ...flatten(node.children)])

// Edit the finished structure. `rows` are the folder paths with bookmark counts from the worker
// (see buildRows); edits are recorded as an operation list the worker replays on the real bookmarks.
export default function ResultEditor({ rows, initialOps = [], onSave, onDiscard }) {
    const [ops, setOps] = useState(initialOps)
    const [error, setError] = useState('')
    const current = useMemo(() => applyOps(rows, ops).records || rows, [rows, ops])
    const nodes = useMemo(() => buildTree(current), [current])
    const all = useMemo(() => flatten(nodes), [nodes])
    const total = current.reduce((sum, row) => sum + row.count, 0)

    const record = (op) => {
        const result = applyOps(rows, [...ops, op])
        if (result.error) { setError(result.error); return result.error }
        setError('')
        setOps([...ops, op])
        return null
    }

    const sameLevel = (node) => all.filter(other => other.path.length === node.path.length && other.path.join('\u0000') !== node.path.join('\u0000'))

    return (
        <EditorDialog
            title="Edit organized folders"
            summary={`${total.toLocaleString()} bookmarks · ${nodes.length} categor${nodes.length === 1 ? 'y' : 'ies'} · ${ops.length} edit${ops.length === 1 ? '' : 's'}`}
            dirty={ops.length > 0 && JSON.stringify(ops) !== JSON.stringify(initialOps)}
            saveLabel="Save edits"
            error={error}
            onSave={() => onSave(ops)}
            onDiscard={onDiscard}
        >
            <FolderTree
                nodes={nodes}
                actionsFor={(node) => (node.path.length === 1 ? ['rename', 'merge'] : ['rename', 'delete', 'move', 'merge'])}
                onRename={(node, name) => record({ op: 'rename', path: node.path, to: name })}
                onDelete={(node) => record({ op: 'delete', path: node.path })}
                deleteMessage={(node) => `Delete ${node.name}? Its ${node.count.toLocaleString()} bookmarks move up one level.`}
                moveTargets={(node) => all
                    .filter(other => other.path.length === node.path.length - 1 && other.path.join('\u0000') !== node.path.slice(0, -1).join('\u0000'))
                    .map(other => ({ path: other.path, label: other.path.join(' / ') }))}
                mergeTargets={(node) => sameLevel(node).map(other => ({ path: other.path, label: other.path.join(' / ') }))}
                onMove={(node, target) => record({ op: 'move', path: node.path, to: target })}
                onMerge={(node, target) => record({ op: 'merge', path: node.path, to: target })}
            />
        </EditorDialog>
    )
}
