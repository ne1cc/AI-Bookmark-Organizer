import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import App from './App'

vi.mock('./components/Organizer', () => ({
    default: () => <div data-testid="mock-organizer">Organizer Component</div>
}))

describe('App Component Layout', () => {
    beforeEach(() => {
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
        delete global.chrome
        vi.restoreAllMocks()
    })

    it('renders the top bar with Clear duplicates button on the left and ThemeToggle / close button on the right', () => {
        const { container } = render(<App />)

        const headerTopLeft = container.querySelector('.header-top-left')
        const headerTopRight = container.querySelector('.header-top-right')

        expect(headerTopLeft).toBeDefined()
        expect(headerTopRight).toBeDefined()

        // Clear duplicates button is located inside header-top-left
        const clearDupesBtn = headerTopLeft.querySelector('.remove-duplicates-btn')
        expect(clearDupesBtn).toBeDefined()
        expect(clearDupesBtn.textContent).toContain('Clear duplicates')

        // Close button and theme toggle are inside header-top-right
        const closeBtn = headerTopRight.querySelector('.header-close-btn')
        expect(closeBtn).toBeDefined()
    })

    it('shows a gentle close reminder without closing the app', () => {
        const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
        const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})

        render(<App />)
        const closeBtn = screen.getByRole('button', { name: /close extension/i })
        fireEvent.click(closeBtn)

        expect(screen.getByRole('dialog').textContent).toContain('Close the app? This will stop any current runs and clear their data.')
        expect(dispatchSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'extension-close-requested' }))
        expect(closeSpy).not.toHaveBeenCalled()
    })

    it('keeps the app open when the close reminder is cancelled', () => {
        const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
        const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})

        render(<App />)
        fireEvent.click(screen.getByRole('button', { name: /close extension/i }))
        fireEvent.click(screen.getByRole('button', { name: /keep working/i }))

        expect(screen.queryByRole('dialog')).toBeNull()
        expect(dispatchSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'extension-close-requested' }))
        expect(closeSpy).not.toHaveBeenCalled()
    })

    it('closes the app after the close reminder is accepted', () => {
        const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
        const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})

        render(<App />)
        fireEvent.click(screen.getByRole('button', { name: /close extension/i }))
        fireEvent.click(screen.getByRole('button', { name: /close app/i }))

        expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension-close-requested' }))
        expect(closeSpy).toHaveBeenCalledTimes(1)
    })
})
