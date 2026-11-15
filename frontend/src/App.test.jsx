import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import App from './App'

vi.mock('./components/Organizer', () => ({
    default: () => <div data-testid="mock-organizer">Organizer Component</div>
}))

describe('App Component Layout', () => {
    beforeEach(() => {
        localStorage.clear()
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

    it('renders a single-line header with the title and the zoom / theme / close tools', () => {
        const { container } = render(<App />)

        const header = container.querySelector('.app-header')
        expect(header.querySelector('h1.app-title').textContent).toBe('AI Bookmark Organizer')
        expect(header.querySelector('.header-tools .header-close-btn')).not.toBeNull()

        // "Clear duplicates" moved into Organizer's Options group; Organizer is
        // mocked in this file, so its presence is covered by the Organizer tests.
        expect(header.querySelector('.remove-duplicates-btn')).toBeNull()
    })

    it('defaults to light mode when no theme preference is saved', () => {
        render(<App />)

        expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')
        expect(document.documentElement.getAttribute('data-theme')).toBe('light')
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

    it('lets people increase, decrease, and reset the interface zoom', () => {
        render(<App />)

        const increase = screen.getByRole('button', { name: /increase zoom/i })
        const decrease = screen.getByRole('button', { name: /decrease zoom/i })
        const reset = screen.getByRole('button', { name: /reset zoom/i })

        expect(reset.textContent).toBe('100%')

        fireEvent.click(increase)
        expect(reset.textContent).toBe('110%')
        expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.1')

        fireEvent.click(decrease)
        fireEvent.click(decrease)
        expect(reset.textContent).toBe('90%')

        fireEvent.click(reset)
        expect(reset.textContent).toBe('100%')
    })
})
