import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyBatch, generateInferredSchema } from './ai'

// fetch that never answers, so only the abort signal can end it.
const hangingFetch = () => vi.fn((url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
}))

describe('request timeouts', () => {
    let cancelled
    beforeEach(() => {
        vi.useFakeTimers()
        cancelled = false
        global.fetch = hangingFetch()
    })
    afterEach(async () => {
        cancelled = true
        await vi.advanceTimersByTimeAsync(1000)
        vi.useRealTimers()
        delete global.fetch
    })

    it('lets a schema request run past 30s', async () => {
        generateInferredSchema([{ title: 'A', url: 'https://a.com' }], 'sk-test', undefined, 'medium', () => cancelled).catch(() => {})
        await vi.advanceTimersByTimeAsync(31000)
        expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(false)
    })

    it('still aborts a classification request at 30s', async () => {
        classifyBatch([{ title: 'A', url: 'https://a.com' }], 'sk-test', { categories: [] }, undefined, false, () => cancelled).catch(() => {})
        await vi.advanceTimersByTimeAsync(31000)
        expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true)
    })
})

describe('classifyBatch unassignedCount', () => {
    afterEach(() => { delete global.fetch })

    it('counts indexes the model omitted and still returns every bookmark', async () => {
        const content = JSON.stringify({ classified: [{ i: 0, category: 'Tech', sub_category: 'Web' }] })
        global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) }))
        const schema = { categories: [{ name: 'Tech', sub_categories: ['Web'] }] }
        const result = await classifyBatch([{ title: 'A', url: 'https://a.com' }, { title: 'B', url: 'https://b.com' }], 'sk-test', schema)
        expect(result).toHaveLength(2)
        expect(result.unassignedCount).toBe(1)
    })
})
