import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTheme } from './useTheme'

describe('useTheme hook', () => {
    beforeEach(() => {
        localStorage.clear()
        document.documentElement.removeAttribute('data-theme')
        vi.clearAllMocks()
        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({})),
                    set: vi.fn(),
                }
            }
        }
    })

    afterEach(() => {
        delete global.chrome
    })

    it('defaults to light theme when no storage exists', () => {
        const { result } = renderHook(() => useTheme())
        expect(result.current.theme).toBe('light')
        expect(result.current.resolved).toBe('light')
        expect(result.current.isMinimal).toBe(false)
        expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    })

    it('supports switching to minimal theme mode', () => {
        const { result } = renderHook(() => useTheme())

        act(() => {
            result.current.setTheme('minimal')
        })

        expect(result.current.theme).toBe('minimal')
        expect(result.current.resolved).toBe('minimal')
        expect(result.current.isMinimal).toBe(true)
        expect(document.documentElement.getAttribute('data-theme')).toBe('minimal')
        expect(localStorage.getItem('themeMode')).toBe('minimal')
        expect(global.chrome.storage.local.set).toHaveBeenCalledWith({ themeMode: 'minimal' })
    })

    it('supports switching back to dark and light from minimal', () => {
        const { result } = renderHook(() => useTheme())

        act(() => {
            result.current.setTheme('minimal')
        })
        expect(result.current.isMinimal).toBe(true)

        act(() => {
            result.current.setTheme('dark')
        })
        expect(result.current.theme).toBe('dark')
        expect(result.current.resolved).toBe('dark')
        expect(result.current.isMinimal).toBe(false)
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

        act(() => {
            result.current.setTheme('light')
        })
        expect(result.current.theme).toBe('light')
        expect(result.current.isMinimal).toBe(false)
        expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    })

    it('loads initial minimal theme from localStorage', () => {
        localStorage.setItem('themeMode', 'minimal')
        const { result } = renderHook(() => useTheme())

        expect(result.current.theme).toBe('minimal')
        expect(result.current.isMinimal).toBe(true)
        expect(document.documentElement.getAttribute('data-theme')).toBe('minimal')
    })
})
