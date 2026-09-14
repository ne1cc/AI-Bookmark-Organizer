import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import RemoveDuplicatesButton from './RemoveDuplicatesButton'
import * as organizerService from '../services/organizer'

describe('RemoveDuplicatesButton Component', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        global.chrome = {
            storage: {
                session: {
                    get: vi.fn((keys, cb) => cb({ activeJobState: { status: 'idle' } }))
                },
                onChanged: {
                    addListener: vi.fn(),
                    removeListener: vi.fn()
                }
            }
        }
    })

    afterEach(() => {
        cleanup()
        vi.runOnlyPendingTimers()
        vi.useRealTimers()
        delete global.chrome
        vi.restoreAllMocks()
    })

    it('renders the initial idle button in top left corner with Clear duplicates label', () => {
        render(<RemoveDuplicatesButton />)
        const btn = screen.getByRole('button', { name: /clear duplicate bookmarks/i })
        expect(btn).toBeDefined()
        expect(btn.textContent).toContain('Clear duplicates')
        expect(btn.disabled).toBe(false)
    })

    it('handles removal click, displays success message when duplicates are cleaned, and resets after timeout', async () => {
        const removeSpy = vi.spyOn(organizerService, 'removeBrowserDuplicates').mockResolvedValue({
            totalScanned: 10,
            duplicatesRemoved: 3,
            failedCount: 0
        })

        const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

        render(<RemoveDuplicatesButton />)
        const btn = screen.getByRole('button', { name: /clear duplicate bookmarks/i })

        await act(async () => {
            fireEvent.click(btn)
        })

        expect(removeSpy).toHaveBeenCalledTimes(1)
        expect(btn.textContent).toContain('Cleared 3 duplicates')
        expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'bookmarks-cleaned' }))

        // Fast-forward past reset timer
        act(() => {
            vi.advanceTimersByTime(3600)
        })

        expect(btn.textContent).toContain('Clear duplicates')
    })

    it('handles clean scan where no duplicates are found', async () => {
        vi.spyOn(organizerService, 'removeBrowserDuplicates').mockResolvedValue({
            totalScanned: 10,
            duplicatesRemoved: 0,
            failedCount: 0
        })

        render(<RemoveDuplicatesButton />)
        const btn = screen.getByRole('button', { name: /clear duplicate bookmarks/i })

        await act(async () => {
            fireEvent.click(btn)
        })

        expect(btn.textContent).toContain('No duplicates found')
    })

    it('handles errors gracefully and shows error message before resetting', async () => {
        vi.spyOn(organizerService, 'removeBrowserDuplicates').mockRejectedValue(new Error('Storage failure'))

        render(<RemoveDuplicatesButton />)
        const btn = screen.getByRole('button', { name: /clear duplicate bookmarks/i })

        await act(async () => {
            fireEvent.click(btn)
        })

        expect(btn.textContent).toContain('Failed to clear duplicates')

        act(() => {
            vi.advanceTimersByTime(3600)
        })

        expect(btn.textContent).toContain('Clear duplicates')
    })

    it('disables the button when an organization job is running', () => {
        global.chrome.storage.session.get = vi.fn((keys, cb) => {
            cb({ activeJobState: { status: 'processing' } })
        })

        render(<RemoveDuplicatesButton />)
        const btn = screen.getByRole('button', { name: /clear duplicate bookmarks/i })
        expect(btn.disabled).toBe(true)
        expect(btn.getAttribute('title')).toContain('Disabled while bookmark organization is running')
    })
})
