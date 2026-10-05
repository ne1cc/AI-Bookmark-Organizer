import { useCallback, useEffect, useRef } from 'react'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

// Window-style sheet over the side panel: labelled dialog, trapped focus, focus returns to
// whatever opened it, and Escape / Discard ask once before throwing unsaved edits away.
export default function EditorDialog({ title, summary, dirty, saveLabel = 'Save', saveDisabled = false, error, onSave, onDiscard, children }) {
    const dialogRef = useRef(null)

    const requestDiscard = useCallback(() => {
        if (dirty && !window.confirm('Discard your changes?')) return
        onDiscard()
    }, [dirty, onDiscard])

    useEffect(() => {
        const opener = document.activeElement
        const first = dialogRef.current?.querySelector(FOCUSABLE)
        if (first) first.focus()
        return () => { if (opener && typeof opener.focus === 'function') opener.focus() }
    }, [])

    const onKeyDown = (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation()
            requestDiscard()
            return
        }
        if (event.key !== 'Tab') return
        const focusable = [...dialogRef.current.querySelectorAll(FOCUSABLE)]
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
        }
    }

    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'stretch', justifyContent: 'center' }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onKeyDown={onKeyDown}
                style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: '640px', margin: '0.5rem', background: 'var(--surface-solid)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}
            >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
                    <div>
                        <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{summary}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button type="button" onClick={requestDiscard} style={{ padding: '0.4rem 0.8rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--surface-solid)', color: 'var(--text-secondary)', cursor: 'pointer' }}>Discard</button>
                        <button type="button" className="btn-primary" onClick={onSave} disabled={saveDisabled} style={{ padding: '0.4rem 0.8rem' }}>{saveLabel}</button>
                    </div>
                </div>
                <div aria-live="polite" role="status" style={{ minHeight: error ? 'auto' : 0, padding: error ? '0.5rem 1rem' : 0, color: 'var(--error)', fontSize: '0.8rem' }}>{error}</div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1rem' }}>{children}</div>
            </div>
        </div>
    )
}
