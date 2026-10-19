import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

// Window-style sheet over the side panel: labelled dialog, trapped focus, focus returns to
// whatever opened it, and Escape / Discard ask once before throwing unsaved edits away.
// With `onUndo`, an Undo button and ⌘Z / Ctrl+Z step back (text fields keep their own undo).
export default function EditorDialog({ title, summary, dirty, saveLabel = 'Save', saveDisabled = false, error, onSave, onDiscard, onUndo, canUndo = false, children }) {
    const dialogRef = useRef(null)
    const discardRef = useRef()
    const undoRef = useRef(null)

    const requestDiscard = useCallback(() => {
        if (dirty && !window.confirm('Discard your changes?')) return
        onDiscard()
    }, [dirty, onDiscard])

    useEffect(() => {
        discardRef.current = requestDiscard
        undoRef.current = onUndo && canUndo ? onUndo : null
    }, [requestDiscard, onUndo, canUndo])

    useEffect(() => {
        const opener = document.activeElement
        const first = dialogRef.current?.querySelector(FOCUSABLE)
        if (first) first.focus()
        return () => { if (opener && typeof opener.focus === 'function') opener.focus() }
    }, [])

    useEffect(() => {
        const onDocumentKeyDown = (event) => {
            const dialog = dialogRef.current
            if (!dialog) return
            if (event.key === 'Escape') {
                event.preventDefault()
                discardRef.current()
                return
            }
            if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
                if (!undoRef.current || event.target.closest?.('input, textarea')) return
                event.preventDefault()
                undoRef.current()
                return
            }
            if (event.key !== 'Tab') return
            const focusable = [...dialog.querySelectorAll(FOCUSABLE)]
            if (focusable.length === 0) return
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            if (!dialog.contains(document.activeElement)) {
                event.preventDefault()
                ;(event.shiftKey ? last : first).focus()
            } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
            }
        }
        document.addEventListener('keydown', onDocumentKeyDown)
        return () => document.removeEventListener('keydown', onDocumentKeyDown)
    }, [])

    // Portaled to <body> so app descendant rules (e.g. `.action-button-container button { width: 100% }`) can't reach in.
    return createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'stretch', justifyContent: 'center' }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: '640px', margin: '0.5rem', background: 'var(--surface-solid)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}
            >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
                    <div>
                        <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{summary}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        {onUndo && <button type="button" onClick={onUndo} disabled={!canUndo} aria-keyshortcuts="Meta+Z Control+Z" style={{ padding: '0.4rem 0.8rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--surface-solid)', color: 'var(--text-secondary)', cursor: canUndo ? 'pointer' : 'default', opacity: canUndo ? 1 : 0.5 }}>Undo</button>}
                        <button type="button" onClick={requestDiscard} style={{ padding: '0.4rem 0.8rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--surface-solid)', color: 'var(--text-secondary)', cursor: 'pointer' }}>Discard</button>
                        <button type="button" className="btn-primary" onClick={onSave} disabled={saveDisabled} style={{ padding: '0.4rem 0.8rem' }}>{saveLabel}</button>
                    </div>
                </div>
                <div aria-live="polite" role="status" style={{ minHeight: error ? 'auto' : 0, padding: error ? '0.5rem 1rem' : 0, color: 'var(--error)', fontSize: '0.8rem' }}>{error}</div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1rem' }}>{children}</div>
            </div>
        </div>,
        document.body
    )
}
