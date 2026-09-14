import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ThemeToggle from './ThemeToggle'

describe('ThemeToggle Component', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders all 4 theme options: Light, Dark, Minimal, System', () => {
        const setTheme = vi.fn()
        render(<ThemeToggle theme="light" setTheme={setTheme} />)

        expect(screen.getByRole('radio', { name: 'Light' })).toBeDefined()
        expect(screen.getByRole('radio', { name: 'Dark' })).toBeDefined()
        expect(screen.getByRole('radio', { name: 'Extra Minimal' })).toBeDefined()
        expect(screen.getByRole('radio', { name: 'System' })).toBeDefined()
    })

    it('marks the active theme correctly with aria-checked', () => {
        const setTheme = vi.fn()
        const { rerender } = render(<ThemeToggle theme="light" setTheme={setTheme} />)

        expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')
        expect(screen.getByRole('radio', { name: 'Extra Minimal' }).getAttribute('aria-checked')).toBe('false')

        rerender(<ThemeToggle theme="minimal" setTheme={setTheme} />)
        expect(screen.getByRole('radio', { name: 'Extra Minimal' }).getAttribute('aria-checked')).toBe('true')
        expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('false')
    })

    it('invokes setTheme with minimal when clicking the minimal option', () => {
        const setTheme = vi.fn()
        render(<ThemeToggle theme="light" setTheme={setTheme} />)

        const minimalBtn = screen.getByRole('radio', { name: 'Extra Minimal' })
        fireEvent.click(minimalBtn)

        expect(setTheme).toHaveBeenCalledWith('minimal')
    })
})
