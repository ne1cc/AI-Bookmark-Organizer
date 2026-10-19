import { useRef, useState } from 'react'

const smallButton = { padding: '0.15rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface-solid)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.72rem' }
// Finder list rows: everything packed left, one line per folder, the actions dot at the far right.
const rowStyle = { display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'nowrap', padding: '0.2rem 0.3rem', borderRadius: '6px' }
const ontoStyle = { ...rowStyle, background: 'var(--surface-alt)', outline: '2px solid var(--accent, #4c8dff)', outlineOffset: '-2px' }
const chevronStyle = { ...smallButton, border: 'none', background: 'transparent', flexShrink: 0, width: '1.4rem', padding: 0 }
const nameStyle = (depth) => ({
    color: 'var(--text-primary)', fontSize: '0.88rem', fontWeight: depth === 1 ? 600 : 400, cursor: 'default',
    flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    textAlign: 'left'
})

const keyOf = (path) => JSON.stringify(path)

// Shared folder tree for both editors, with Finder-style interactions: double-click a name to
// rename it, drag a folder to move, merge into a sibling (with a confirm), and drag between rows
// to reorder (only when `onReorder` is provided — the result editor's folder order is decided by
// the run's sort settings, so it declines). Right-click or the row's ⋯ button opens the same
// actions as a menu, so nothing is reachable only by dragging. It owns only transient UI state;
// the editors own the data.
//
// nodes: [{ name, path, count?, direct?, children: [...] }]
// actionsFor(node): any of 'rename' | 'add' | 'delete' | 'move' | 'merge'
// onRename(node, name) / onAdd(node, name) / onAddRoot(name): return an error string, or null on success
// onDelete(node), onMove(node, targetPath), onMerge(node, targetPath)
// onReorder(node, targetPath, 'before' | 'after'): optional; omit when order is not editable
// moveTargets(node) / mergeTargets(node): [{ path, label }] for the menu path to move/merge
// deleteMessage(node): confirm text, asked only for folders that have children
export default function FolderTree({
    nodes, actionsFor, onRename, onAdd, onAddRoot, onDelete, onMove, onMerge, onReorder,
    moveTargets = () => [], mergeTargets = () => [], deleteMessage = (node) => `Delete ${node.name}?`,
    rootAddLabel = 'Add category', defaultExpanded = false
}) {
    const [expanded, setExpanded] = useState(() => new Set())
    const [editing, setEditing] = useState(null) // { key, mode: 'rename' | 'add' | 'root', value }
    const [menu, setMenu] = useState(null) // { key, kind: 'actions' | 'move' | 'merge', target?: chosen path key }
    const [confirming, setConfirming] = useState(null) // key of a row awaiting a delete confirm
    const [mergeAsk, setMergeAsk] = useState(null) // { source, target } awaiting a merge confirm from a drop
    const [hover, setHover] = useState(null) // { key, mode: 'onto' | 'before' | 'after' }
    const [rowError, setRowError] = useState({}) // key -> message
    const dragged = useRef(null) // { path } of the row being dragged; dataTransfer is cosmetic only

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

    const startRename = (node) => { setMenu(null); clear(keyOf(node.path)); setEditing({ key: keyOf(node.path), mode: 'rename', value: node.name }) }

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
            onBlur={() => { clear(editing.key); setEditing(null) }}
            style={{ flex: '1 1 auto', minWidth: 0, padding: '0.2rem 0.4rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface-alt)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
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
                style={{ padding: '0.2rem 0 0.2rem 1.5rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}
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

    // The ⋯ (or right-click) action strip: every drag gesture also lives here for keyboard users.
    const renderActions = (node) => {
        const actions = actionsFor(node)
        return (
            <div
                role="group"
                aria-label={`Actions for ${node.name}`}
                onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null) } }}
                style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.15rem 0 0.15rem 1.5rem' }}
            >
                {actions.includes('rename') && <button type="button" style={smallButton} aria-label={`Rename ${node.name}`} onClick={() => startRename(node)}>Rename</button>}
                {actions.includes('add') && <button type="button" style={smallButton} aria-label={`Add subfolder to ${node.name}`} onClick={() => { setMenu(null); clear(keyOf(node.path)); setEditing({ key: keyOf(node.path), mode: 'add', value: '' }) }}>+ Subfolder</button>}
                {actions.includes('move') && <button type="button" style={smallButton} aria-label={`Move ${node.name}`} onClick={() => setMenu({ key: keyOf(node.path), kind: 'move', target: null })}>Move to…</button>}
                {actions.includes('merge') && <button type="button" style={smallButton} aria-label={`Merge ${node.name}`} onClick={() => setMenu({ key: keyOf(node.path), kind: 'merge', target: null })}>Merge into…</button>}
                {actions.includes('delete') && <button type="button" style={smallButton} aria-label={`Delete ${node.name}`} onClick={() => { setMenu(null); if (node.children.length > 0) setConfirming(keyOf(node.path)); else onDelete(node) }}>Delete</button>}
            </div>
        )
    }

    // A merge only ever happens after an explicit confirm, whether it started from a drop or the menu.
    const renderMergeAsk = () => (
        <div role="alertdialog" aria-label={`Confirm merge of ${mergeAsk.source.name} into ${mergeAsk.target.name}`} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', padding: '0.3rem 0 0.3rem 1.5rem', fontSize: '0.8rem' }}>
            <span>Merge “{mergeAsk.source.name}” into “{mergeAsk.target.name}”?</span>
            <button type="button" style={{ ...smallButton, background: 'var(--accent, #4c8dff)', color: '#fff', borderColor: 'transparent' }} onClick={() => { const { source, target } = mergeAsk; setMergeAsk(null); onMerge(source, target.path) }}>Merge</button>
            <button type="button" style={smallButton} onClick={() => setMergeAsk(null)}>Cancel</button>
        </div>
    )

    // Drop legality: categories accept merges and (when order is editable) reorders; subfolders
    // accept moves (drop on a category), merges (drop on a sibling) and reorders.
    const dropMode = (draggedPath, node, mode) => {
        if (!draggedPath) return null
        const draggingCategory = draggedPath.length === 1
        const targetCategory = node.path.length === 1
        if (mode === 'onto') {
            if (draggingCategory) return targetCategory && node.path.join() !== draggedPath.join() ? 'onto' : null
            if (targetCategory) return 'onto'
            return node.path.join() !== draggedPath.join() ? 'onto' : null
        }
        return onReorder ? mode : null
    }

    const onRowDragOver = (node) => (event) => {
        if (!dragged.current) return
        const rect = event.currentTarget.getBoundingClientRect()
        const y = Number.isFinite(event.clientY) ? event.clientY - rect.top : rect.height / 2
        const edge = rect.height > 0 ? y / rect.height : 0.5
        const mode = edge < 0.25 ? 'before' : edge > 0.75 ? 'after' : 'onto'
        if (!dropMode(dragged.current.path, node, mode)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        setHover({ key: keyOf(node.path), mode })
    }

    const onRowDrop = (node) => (event) => {
        event.preventDefault()
        const source = dragged.current
        const active = hover?.key === keyOf(node.path) ? hover.mode : 'onto'
        dragged.current = null
        setHover(null)
        if (!source) return
        const mode = dropMode(source.path, node, active)
        if (!mode) return
        if (mode === 'onto') {
            if (node.path.length === 1 && source.path.length === 2) {
                if (source.path[0] !== node.path[0]) onMove(source.node, node.path)
                return
            }
            setMergeAsk({ source: source.node, target: node })
            return
        }
        const outcome = onReorder(source.node, node.path, mode)
        if (outcome) fail(keyOf(source.path), outcome)
    }

    const renderNode = (node) => {
        const key = keyOf(node.path)
        const actions = actionsFor(node)
        const open = node.children.length > 0 && isOpen(key)
        const renaming = editing?.key === key && editing.mode === 'rename'
        const adding = editing?.key === key && editing.mode === 'add'
        const hovered = hover?.key === key
        const rowVisual = hovered && hover.mode === 'onto' ? ontoStyle : rowStyle
        return (
            <li key={key} role="treeitem" aria-level={node.path.length} aria-expanded={node.children.length > 0 ? open : undefined} aria-label={node.name} style={{ listStyle: 'none', margin: 0 }}>
                {hovered && (hover.mode === 'before' || hover.mode === 'after') && (
                    <div aria-hidden="true" style={{ height: 0, borderTop: '2px solid var(--accent, #4c8dff)', marginLeft: `${(node.path.length - 1) * 1.1}rem` }} />
                )}
                <div
                    tabIndex={0}
                    draggable={!renaming && !adding}
                    onDragStart={(event) => { dragged.current = { path: node.path, node }; if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; try { event.dataTransfer.setData('text/plain', node.name) } catch { /* jsdom */ } } }}
                    onDragEnd={() => { dragged.current = null; setHover(null) }}
                    onDragOver={onRowDragOver(node)}
                    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHover(null) }}
                    onDrop={onRowDrop(node)}
                    onContextMenu={(event) => { event.preventDefault(); setMenu({ key, kind: 'actions', target: null }) }}
                    onKeyDown={(event) => {
                        if ((event.key === 'Enter' || event.key === 'F2') && actions.includes('rename') && !renaming) { event.preventDefault(); startRename(node) }
                    }}
                    style={{ ...rowVisual, paddingLeft: `${(node.path.length - 1) * 1.1 + 0.3}rem` }}
                >
                    {node.children.length > 0 ? (
                        <button type="button" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => toggle(key)} style={chevronStyle}>{open ? '▾' : '▸'}</button>
                    ) : <span aria-hidden="true" style={{ width: '1.4rem', flexShrink: 0 }} />}
                    {renaming ? nameInput(node, `New name for ${node.name}`) : (
                        <span onDoubleClick={() => actions.includes('rename') && startRename(node)} style={nameStyle(node.path.length)} title={node.name}>{node.name}</span>
                    )}
                    {Number.isFinite(node.count) && <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', flexShrink: 0 }}>{node.count.toLocaleString()}{node.direct > 0 && node.children.length > 0 ? ` (${node.direct.toLocaleString()} directly here)` : ''}</span>}
                    <button
                        type="button"
                        aria-haspopup="menu"
                        aria-label={`Actions for ${node.name}`}
                        onClick={() => setMenu(menu?.key === key && menu.kind === 'actions' ? null : { key, kind: 'actions', target: null })}
                        style={{ ...smallButton, border: 'none', background: 'transparent', color: 'var(--text-muted)', flexShrink: 0 }}
                    >⋯</button>
                </div>
                {adding && <div style={{ paddingLeft: `${node.path.length * 1.1}rem`, padding: '0.2rem 0 0.2rem 1.5rem' }}>{nameInput(node, `Name for the new subfolder in ${node.name}`)}</div>}
                {menu?.key === key && (menu.kind === 'actions' ? renderActions(node) : renderMenu(node))}
                {confirming === key && (
                    <div role="alertdialog" aria-label={`Confirm delete ${node.name}`} style={{ padding: '0.3rem 0 0.3rem 1.5rem', fontSize: '0.8rem', color: 'var(--error)' }}>
                        {deleteMessage(node)}{' '}
                        <button type="button" style={smallButton} onClick={() => { setConfirming(null); onDelete(node) }}>Delete</button>{' '}
                        <button type="button" style={smallButton} onClick={() => setConfirming(null)}>Keep</button>
                    </div>
                )}
                {mergeAsk?.target.path.join() === node.path.join() && renderMergeAsk()}
                {rowError[key] && <div role="alert" style={{ paddingLeft: '1.5rem', color: 'var(--error)', fontSize: '0.78rem' }}>{rowError[key]}</div>}
                {open && <ul role="group" style={{ margin: 0, padding: 0 }}>{node.children.map(renderNode)}</ul>}
            </li>
        )
    }

    const rootKey = '"root"'
    return (
        <div role="tree" aria-label="Folder structure">
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
