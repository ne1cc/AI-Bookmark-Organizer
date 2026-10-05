import { describe, expect, it } from 'vitest'
import { detectProvider } from './ai'

describe('detectProvider', () => {
    it.each([
        ['AIzaSyLegacyGoogleKey'],
        ['AQ.Ab8RN6NewFormatGoogleKey'],
        ['  AQ.Ab8RN6PaddedGoogleKey  ']
    ])('routes Google AI Studio key %s to gemini', key => {
        expect(detectProvider(key)).toBe('gemini')
    })

    it.each([
        ['sk-or-v1-abc123'],
        ['sk-proj-openaiStyleKey'],
        ['  sk-or-v1-padded  ']
    ])('routes OpenRouter-style key %s to openrouter', key => {
        expect(detectProvider(key)).toBe('openrouter')
    })

    it('defaults to openrouter when no key is set', () => {
        expect(detectProvider('')).toBe('openrouter')
        expect(detectProvider(undefined)).toBe('openrouter')
    })
})
