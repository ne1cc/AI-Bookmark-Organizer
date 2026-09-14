import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import App from './App'

vi.mock('./components/Organizer', () => ({
    default: ({ isMinimal }) => (
        <div data-testid="organizer-stub" data-minimal={String(isMinimal)}>
            Organizer Component
        </div>
    )
}))

describe('App Component Layout & Theme Integration', () => {
    beforeEach(() => {
        localStorage.clear()
        document.documentElement.removeAttribute('data-theme')
        vi.clearAllMocks()
        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb?.({})),
                    set: vi.fn((obj, cb) => cb?.()),
                    remove: vi.fn((keys, cb) => cb?.()),
                },
                session: {
                    get: vi.fn((keys, cb) => cb?.({ activeJobState: { status: 'idle' } })),
                    set: vi.fn((obj, cb) => cb?.()),
                },
                onChanged: {
                    addListener: vi.fn(),
                    removeListener: vi.fn(),
                },
            },
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

    it('keeps the app open when the close confirmation is cancelled', () => {
        const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
        const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

        render(<App />)
        const closeBtn = screen.getByRole('button', { name: /close extension/i })
        fireEvent.click(closeBtn)

        expect(confirmSpy).toHaveBeenCalledWith('Close the app? This will stop any current runs and clear their data.')
        expect(dispatchSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'extension-close-requested' }))
        expect(closeSpy).not.toHaveBeenCalled()
    })

    it('closes the app after the close confirmation is accepted', () => {
        const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
        const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
        vi.spyOn(window, 'confirm').mockReturnValue(true)

        render(<App />)
        const closeBtn = screen.getByRole('button', { name: /close extension/i })
        fireEvent.click(closeBtn)

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

    it('renders the application with theme toggle and main title', () => {
        render(<App />)
        expect(screen.getByText('AI Bookmark Organizer')).toBeDefined()
        expect(screen.getByRole('radio', { name: 'Extra Minimal' })).toBeDefined()
        expect(document.documentElement.getAttribute('data-theme')).toBe('light')
        expect(screen.queryByText('MINIMAL')).toBeNull()

        const stub = screen.getByTestId('organizer-stub')
        expect(stub.getAttribute('data-minimal')).toBe('false')
    })

    it('switches to Extra Minimal theme when selected in ThemeToggle', () => {
        render(<App />)

        const minimalBtn = screen.getByRole('radio', { name: 'Extra Minimal' })
        fireEvent.click(minimalBtn)

        expect(document.documentElement.getAttribute('data-theme')).toBe('minimal')
        expect(screen.getByText('MINIMAL')).toBeDefined()
        expect(localStorage.getItem('themeMode')).toBe('minimal')

        const stub = screen.getByTestId('organizer-stub')
        expect(stub.getAttribute('data-minimal')).toBe('true')
    })

    it('removes minimal badge when switching back from Minimal to Dark or Light', () => {
        render(<App />)

        const minimalBtn = screen.getByRole('radio', { name: 'Extra Minimal' })
        fireEvent.click(minimalBtn)
        expect(screen.getByText('MINIMAL')).toBeDefined()

        const darkBtn = screen.getByRole('radio', { name: 'Dark' })
        fireEvent.click(darkBtn)
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
        expect(screen.queryByText('MINIMAL')).toBeNull()

        const stub = screen.getByTestId('organizer-stub')
        expect(stub.getAttribute('data-minimal')).toBe('false')
    })
})
