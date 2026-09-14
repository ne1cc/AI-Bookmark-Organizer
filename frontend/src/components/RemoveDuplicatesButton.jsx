import { useState, useEffect, useRef } from 'react'
import { CopySlash, Loader2, Check, AlertCircle } from 'lucide-react'
import { removeBrowserDuplicates } from '../services/organizer'

/**
 * Standalone one-click "Clear duplicates" button positioned in the top-left corner of the app.
 * Immediately scans browser bookmarks, saves a pre-write backup to storage, and removes doomed duplicates.
 */
export default function RemoveDuplicatesButton() {
    const [status, setStatus] = useState('idle') // 'idle' | 'running' | 'success' | 'error'
    const [message, setMessage] = useState('')
    const [isJobRunning, setIsJobRunning] = useState(false)
    const resetTimerRef = useRef(null)

    // Check if background organization job is currently active
    useEffect(() => {
        const checkJobStatus = () => {
            if (typeof chrome !== 'undefined' && chrome?.storage?.session) {
                chrome.storage.session.get(['activeJobState'], (res) => {
                    const jobStatus = res?.activeJobState?.status
                    setIsJobRunning(jobStatus === 'processing')
                })
            }
        }

        checkJobStatus()

        const handleStorageChange = (changes, areaName) => {
            if (areaName === 'session' && changes.activeJobState) {
                const jobStatus = changes.activeJobState.newValue?.status
                setIsJobRunning(jobStatus === 'processing')
            }
        }

        if (typeof chrome !== 'undefined' && chrome?.storage?.onChanged) {
            chrome.storage.onChanged.addListener(handleStorageChange)
            return () => {
                chrome.storage.onChanged.removeListener(handleStorageChange)
            }
        }
    }, [])

    // Clear any reset timer on unmount
    useEffect(() => {
        return () => {
            if (resetTimerRef.current) {
                clearTimeout(resetTimerRef.current)
            }
        }
    }, [])

    const handleClearDuplicates = async () => {
        if (status === 'running' || isJobRunning) return

        if (resetTimerRef.current) {
            clearTimeout(resetTimerRef.current)
        }

        setStatus('running')
        setMessage('Scanning...')

        try {
            const result = await removeBrowserDuplicates()
            const removed = result?.duplicatesRemoved || 0

            if (removed > 0) {
                setMessage(`Cleared ${removed} duplicate${removed === 1 ? '' : 's'}`)
            } else {
                setMessage('No duplicates found')
            }

            setStatus('success')
            try {
                window.dispatchEvent(new CustomEvent('bookmarks-cleaned', { detail: result }))
            } catch {}

            resetTimerRef.current = setTimeout(() => {
                setStatus('idle')
                setMessage('')
            }, 3500)
        } catch {
            setStatus('error')
            setMessage('Failed to clear duplicates')
            resetTimerRef.current = setTimeout(() => {
                setStatus('idle')
                setMessage('')
            }, 3500)
        }
    }

    const disabled = status === 'running' || isJobRunning
    const title = isJobRunning
        ? 'Disabled while bookmark organization is running'
        : 'Clear duplicate bookmarks from browser'

    return (
        <button
            type="button"
            className={`remove-duplicates-btn ${status === 'success' ? 'is-success' : ''} ${status === 'error' ? 'is-error' : ''}`}
            onClick={handleClearDuplicates}
            disabled={disabled}
            title={title}
            aria-label={status === 'idle' ? 'Clear duplicate bookmarks' : message || 'Clear duplicate bookmarks'}
        >
            {status === 'idle' && (
                <>
                    <CopySlash size={15} style={{ flexShrink: 0 }} />
                    <span>Clear duplicates</span>
                </>
            )}
            {status === 'running' && (
                <>
                    <Loader2 size={15} className="spin-icon" style={{ flexShrink: 0 }} />
                    <span>{message || 'Scanning...'}</span>
                </>
            )}
            {status === 'success' && (
                <>
                    <Check size={15} style={{ flexShrink: 0 }} />
                    <span>{message}</span>
                </>
            )}
            {status === 'error' && (
                <>
                    <AlertCircle size={15} style={{ flexShrink: 0 }} />
                    <span>{message}</span>
                </>
            )}
        </button>
    )
}
