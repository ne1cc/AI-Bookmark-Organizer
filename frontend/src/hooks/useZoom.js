import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'uiZoom'
const DEFAULT_ZOOM = 100
const MIN_ZOOM = 90
const MAX_ZOOM = 140
const STEP = 10

const clampZoom = (value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))

function readStoredZoom() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY)
        if (stored === null) return DEFAULT_ZOOM
        const value = Number(stored)
        return Number.isFinite(value) ? clampZoom(value) : DEFAULT_ZOOM
    } catch {
        return DEFAULT_ZOOM
    }
}

function applyZoom(zoom) {
    document.documentElement.style.setProperty('--ui-scale', String(zoom / 100))
}

export function useZoom() {
    const [zoom, setZoom] = useState(readStoredZoom)

    useEffect(() => {
        applyZoom(zoom)
        try { localStorage.setItem(STORAGE_KEY, String(zoom)) } catch { /* ignore */ }
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            chrome.storage.local.set({ [STORAGE_KEY]: zoom })
        }
    }, [zoom])

    useEffect(() => {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) return
        chrome.storage.local.get([STORAGE_KEY], (result) => {
            if (Number.isFinite(result?.[STORAGE_KEY])) {
                setZoom(clampZoom(result[STORAGE_KEY]))
            }
        })
    }, [])

    const increase = useCallback(() => setZoom((value) => clampZoom(value + STEP)), [])
    const decrease = useCallback(() => setZoom((value) => clampZoom(value - STEP)), [])
    const reset = useCallback(() => setZoom(DEFAULT_ZOOM), [])

    return { zoom, increase, decrease, reset }
}
