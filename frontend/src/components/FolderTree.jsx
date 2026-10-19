import { useState } from 'react'

const smallButton = { padding: '0.15rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface-solid)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.72rem' }

const keyOf = (path) => JSON.stringify(path)

// Shared folder tree for both editors. It owns only transient UI state (which row is being
// renamed, which menu is open, which rows are expanded); the editors own the data.
//
// nodes: [{ name, path, count?, direct?, children: [...] }]
// actionsFor(node): any of 'rename' | 'add' | 'delete' | 'move' | 'merge'
// onRename(node, name) / onAdd(node, name) / onAddRoot(name): return an error string, or null on success
// onDelete(node), onMove(node, targetPath), onMerge(node, targetPath)
// moveTargets(node) / mergeTargets(node): [{ path, label }]
// deleteMessage(node): confirm text, asked only for folders that have children
export default function FolderTree({
    nodes, actionsFor, onRename, onAdd, onAddRoot, onDelete, onMove, onMerge,
    moveTargets = () => [], mergeTargets = () => [], deleteMessage = (node) => `Delete ${node.name}?`,
    rootAddLabel = 'Add category', defaultExpanded = false
}) {
    const [expanded, setExpanded] = useState(() => new Set())
    const [editing, setEditing] = useState(null) // { key, mode: 'rename' | 'add' | 'root', value }
    const [menu, setMenu] = useState(null) // { key, kind: 'move' | 'merge', target?: chosen path key }
    const [confirming, setConfirming] = useState(null)
    const [rowError, setRowError] = useState({}) // key -> message

    const isOpen = (key) => (defaultExpanded ? !expanded.has(key) : expanded.has(key))
    const toggle = (key) => setExpanded(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    })
    const fail = (key, message) => setRowError(prev => ({ ...prev, [key]: message }))
    const clear = (key) => setRowError(prev => { const { [key]: _gone, ...rest } = prev; return rest })

    const commit = (node) => {
        const key = editing.key
        const outcome = editing.mode === 'rename' ? onRename(node, editing.value)
            : editing.mode === 'add' ? onAdd(node, editing.value)
                : onAddRoot(editing.value)
        if (outcome) { fail(key, outcome); return }
        clear(key)
        if (editing.mode === 'add') setExpanded(prev => { const next = new Set(prev); if (defaultExpanded) next.delete(key); else next.add(key); return next })
        setEditing(null)
    }

    const nameInput = (node, label) => (
        <input
            autoFocus
            aria-label={label}
            value={editing.value}
            onChange={(event) => setEditing({ ...editing, value: event.target.value })}
            onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); commit(node) }
                if (event.key === 'Escape') { event.stopPropagation(); clear(editing.key); setEditing(null) }
            }}
            style={{ padding: '0.2rem 0.4rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface-alt)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
        />
    )

    // Choosing a target only selects it: arrowing through a closed select fires change on some
    // platforms, so the move or merge happens on the explicit confirm button.
    const renderMenu = (node) => {
        const moving = menu.kind === 'move'
        const targets = moving ? moveTargets(node) : mergeTargets(node)
        const chosen = targets.find(target => keyOf(target.path) === menu.target)
        return (
            <div
                onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null) } }}
                style={{ paddingLeft: `${node.path.length * 1.1}rem`, padding: '0.2rem 0 0.2rem 1.5rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}
            >
                <select
                    autoFocus
                    aria-label={`${moving ? 'Move' : 'Merge'} ${node.name} ${moving ? 'to' : 'into'}`}
                    value={chosen ? menu.target : ''}
                    onChange={(event) => setMenu({ ...menu, target: event.target.value || null })}
                >
                    <option value="">{moving ? 'Move to…' : 'Merge into…'}</option>
                    {targets.map(target => (
                        <option key={keyOf(target.path)} value={keyOf(target.path)}>{target.label}</option>
                    ))}
                </select>
                {chosen && (
                    <button
                        type="button"
                        style={smallButton}
                        aria-label={moving ? `Confirm move of ${node.name} to ${chosen.label}` : `Confirm merge of ${node.name} into ${chosen.label}`}
                        onClick={() => {
                            setMenu(null)
                            if (moving) onMove(node, chosen.path)
                            else onMerge(node, chosen.path)
                        }}
                    >
                        {moving ? 'Move' : 'Merge'}
                    </button>
                )}
            </div>
        )
    }

    const renderNode = (node) => {
        const key = keyOf(node.path)
        const actions = actionsFor(node)
        const open = node.children.length > 0 && isOpen(key)
        const renaming = editing?.key === key && editing.mode === 'rename'
        const adding = editing?.key === key && editing.mode === 'add'
        return (
            <li key={key} style={{ listStyle: 'none', margin: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', padding: '0.2rem 0', paddingLeft: `${(node.path.length - 1) * 1.1}rem` }}>
                    {node.children.length > 0 ? (
                        <button type="button" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => toggle(key)} style={{ ...smallButton, border: 'none', background: 'transparent' }}>{open ? '▾' : '▸'}</button>
                    ) : <span style={{ width: '1.4rem' }} />}
                    {renaming ? nameInput(node, `New name for ${node.name}`) : <span style={{ color: 'var(--text-primary)', fontSize: '0.88rem', fontWeight: node.path.length === 1 ? 600 : 400 }}>{node.name}</span>}
                    {Number.isFinite(node.count) && <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{node.count.toLocaleString()}{node.direct > 0 && node.children.length > 0 ? ` (${node.direct.toLocaleString()} directly here)` : ''}</span>}
                    {actions.includes('rename') && !renaming && <button type="button" style={smallButton} aria-label={`Rename ${node.name}`} onClick={() => { clear(key); setEditing({ key, mode: 'rename', value: node.name }) }}>Rename</button>}
                    {actions.includes('add') && !adding && <button type="button" style={smallButton} aria-label={`Add subfolder to ${node.name}`} onClick={() => { clear(key); setEditing({ key, mode: 'add', value: '' }) }}>+ Subfolder</button>}
                    {actions.includes('move') && <button type="button" style={smallButton} aria-label={`Move ${node.name}`} onClick={() => setMenu({ key, kind: 'move' })}>Move to…</button>}
                    {actions.includes('merge') && <button type="button" style={smallButton} aria-label={`Merge ${node.name}`} onClick={() => setMenu({ key, kind: 'merge' })}>Merge into…</button>}
                    {actions.includes('delete') && <button type="button" style={smallButton} aria-label={`Delete ${node.name}`} onClick={() => (node.children.length > 0 ? setConfirming(key) : onDelete(node))}>Delete</button>}
                </div>
                {adding && <div style={{ paddingLeft: `${node.path.length * 1.1}rem`, padding: '0.2rem 0 0.2rem 1.5rem' }}>{nameInput(node, `Name for the new subfolder in ${node.name}`)}</div>}
                {menu?.key === key && renderMenu(node)}
                {confirming === key && (
                    <div role="alertdialog" aria-label={`Confirm delete ${node.name}`} style={{ padding: '0.3rem 0 0.3rem 1.5rem', fontSize: '0.8rem', color: 'var(--error)' }}>
                        {deleteMessage(node)}{' '}
                        <button type="button" style={smallButton} onClick={() => { setConfirming(null); onDelete(node) }}>Delete</button>{' '}
                        <button type="button" style={smallButton} onClick={() => setConfirming(null)}>Keep</button>
                    </div>
                )}
                {rowError[key] && <div role="alert" style={{ paddingLeft: '1.5rem', color: 'var(--error)', fontSize: '0.78rem' }}>{rowError[key]}</div>}
                {open && <ul style={{ margin: 0, padding: 0 }}>{node.children.map(renderNode)}</ul>}
            </li>
        )
    }

    const rootKey = '"root"'
    return (
        <div>
            <ul style={{ margin: 0, padding: 0 }}>{nodes.map(renderNode)}</ul>
            {onAddRoot && (
                <div style={{ marginTop: '0.6rem' }}>
                    {editing?.key === rootKey ? nameInput(null, `Name for the new ${rootAddLabel.replace(/^Add /, '')}`) : (
                        <button type="button" style={smallButton} onClick={() => { clear(rootKey); setEditing({ key: rootKey, mode: 'root', value: '' }) }}>+ {rootAddLabel}</button>
                    )}
                    {rowError[rootKey] && <div role="alert" style={{ color: 'var(--error)', fontSize: '0.78rem' }}>{rowError[rootKey]}</div>}
                </div>
            )}
        </div>
    )
}
