import { lazy, Suspense, useEffect, useState } from 'react'
import { buildTree } from '../services/resultEditor'

// The editors only load when a review is actually opened, keeping them out of the startup chunk.
const PlanEditor = lazy(() => import('./PlanEditor'))
const ResultEditor = lazy(() => import('./ResultEditor'))

const DRAFT_KEY = 'reviewDraft'
const secondary = { padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--surface-solid)', color: 'var(--text-secondary)', cursor: 'pointer' }
const chip = { fontSize: '0.68rem', padding: '0.1rem 0.45rem', borderRadius: '10px', background: 'var(--accent-soft)', color: 'var(--accent)', marginLeft: '0.5rem' }

// The two review pauses: the proposed folder plan (before any bookmark is filed) and the
// finished folders (before anything is written). The worker owns the run; this component
// owns only the user's unsaved-to-the-run edits, which it mirrors to session storage so a
// reopened panel can restore them.
//
// plan:   { categories: [{ name, sub_categories }], error? } | null
// result: { rows: [{ category, sub_category, detail_category, count }], error? } | null
// onDecide(kind: 'plan' | 'result', decision: 'approve' | 'regenerate', data?: { plan } | { ops })
export default function ReviewPanel({ plan, result, onDecide }) {
    const [planEdit, setPlanEdit] = useState(null) // { base, plan }
    const [resultEdit, setResultEdit] = useState(null) // { base, ops }
    const [editor, setEditor] = useState(null) // 'plan' | 'result' | null

    useEffect(() => {
        if (typeof chrome === 'undefined' || !chrome.storage?.session) return
        chrome.storage.session.get([DRAFT_KEY], (res) => {
            const draft = res?.[DRAFT_KEY]
            if (draft?.planEdit) setPlanEdit(prev => prev ?? draft.planEdit)
            if (draft?.resultEdit) setResultEdit(prev => prev ?? draft.resultEdit)
        })
    }, [])

    // An edit only applies to the exact plan or result it was made against, so a regenerated
    // plan (or a stale draft from an earlier run) can never be mistaken for the current one.
    const planBase = plan ? JSON.stringify(plan.categories) : null
    const resultBase = result ? JSON.stringify(result.rows) : null
    const activePlan = planEdit && planEdit.base === planBase ? planEdit.plan : null
    const activeOps = resultEdit && resultEdit.base === resultBase ? resultEdit.ops : []

    const persist = (next) => {
        try { Promise.resolve(chrome.storage?.session?.set({ [DRAFT_KEY]: next })).catch(() => {}) } catch { /* the edit still works in memory */ }
    }

    const savePlan = (edited) => {
        const next = JSON.stringify(edited.categories) === planBase ? null : { base: planBase, plan: edited }
        setPlanEdit(next)
        persist({ planEdit: next, resultEdit })
        setEditor(null)
    }

    const saveOps = (ops) => {
        const next = ops.length > 0 ? { base: resultBase, ops } : null
        setResultEdit(next)
        persist({ planEdit, resultEdit: next })
        setEditor(null)
    }

    // Always lets the user drop an edit list the worker rejected without cancelling the run.
    const clearOps = () => {
        setResultEdit(null)
        persist({ planEdit, resultEdit: null })
    }

    const regenerate = () => {
        if (activePlan && !window.confirm('Regenerating throws away your edits to this plan. Continue?')) return
        setPlanEdit(null)
        persist({ planEdit: null, resultEdit })
        onDecide('plan', 'regenerate')
    }

    const shownPlan = activePlan || (plan ? { categories: plan.categories } : null)
    const tree = result ? buildTree(result.rows) : []

    return (
        <>
            {plan && (
                <div className="card-panel plan-review" role="region" aria-label="Proposed folder plan" style={{ width: '100%', textAlign: 'left' }}>
                    <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Proposed folder plan{activePlan && <span style={chip}>Edited</span>}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.25rem 0 0.6rem' }}>
                        No bookmark has been filed yet. Edit the folders if you like, then approve to organize into them.
                    </div>
                    {plan.error && <div role="alert" style={{ color: 'var(--error)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{plan.error}</div>}
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '220px', overflowY: 'auto', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                        {shownPlan.categories.map((category) => (
                            <li key={category.name} style={{ padding: '0.15rem 0' }}>
                                <strong style={{ color: 'var(--text-primary)' }}>{category.name}</strong>
                                {category.sub_categories.length > 0 && <span> — {category.sub_categories.join(', ')}</span>}
                            </li>
                        ))}
                    </ul>
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                        <button type="button" className="btn-primary" onClick={() => onDecide('plan', 'approve', activePlan ? { plan: activePlan } : {})}>Approve &amp; organize</button>
                        <button type="button" style={secondary} onClick={() => setEditor('plan')}>Edit plan</button>
                        <button type="button" style={secondary} onClick={regenerate}>Regenerate plan</button>
                    </div>
                </div>
            )}

            {result && (
                <div className="card-panel result-review" role="region" aria-label="Organized folders ready for review" style={{ width: '100%', textAlign: 'left' }}>
                    <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Organized folders{activeOps.length > 0 && <span style={chip}>{activeOps.length} edit{activeOps.length === 1 ? '' : 's'}</span>}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.25rem 0 0.6rem' }}>
                        Every bookmark is sorted. Nothing has been saved yet: edit the folders if you like, then save the results.
                    </div>
                    {result.error && <div role="alert" style={{ color: 'var(--error)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{result.error}</div>}
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '220px', overflowY: 'auto', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                        {tree.map((category) => (
                            <li key={category.name} style={{ padding: '0.15rem 0' }}>
                                <strong style={{ color: 'var(--text-primary)' }}>{category.name}</strong>
                                <span> — {category.count.toLocaleString()} bookmark{category.count === 1 ? '' : 's'}</span>
                            </li>
                        ))}
                    </ul>
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                        <button type="button" className="btn-primary" onClick={() => onDecide('result', 'approve', activeOps.length > 0 ? { ops: activeOps } : {})}>Save results</button>
                        <button type="button" style={secondary} onClick={() => setEditor('result')}>Edit folders</button>
                        {activeOps.length > 0 && <button type="button" style={secondary} onClick={clearOps}>Clear edits</button>}
                    </div>
                </div>
            )}

            {editor === 'plan' && plan && (
                <Suspense fallback={null}>
                    <PlanEditor plan={shownPlan} onSave={savePlan} onDiscard={() => setEditor(null)} />
                </Suspense>
            )}
            {editor === 'result' && result && (
                <Suspense fallback={null}>
                    <ResultEditor rows={result.rows} initialOps={activeOps} onSave={saveOps} onDiscard={() => setEditor(null)} />
                </Suspense>
            )}
        </>
    )
}
