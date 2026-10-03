import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rotateRuns, deleteRun, clearHistory, saveRun, loadHistory, loadRunData, loadLatestRun } from './runHistory'

// In-memory stand-in for one chrome.storage area (callback style, like the real API).
const fakeArea = () => {
    const data = new Map()
    return {
        data,
        get: (keys, cb) => cb(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => data.has(k)).map(k => [k, structuredClone(data.get(k))]))),
        set: (obj, cb) => { for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v)); cb && cb() },
        remove: (keys, cb) => { for (const k of (Array.isArray(keys) ? keys : [keys])) data.delete(k); cb && cb() }
    }
}

const run = (n) => ({
    results: [{ title: `Run ${n}`, url: `https://run${n}.example.com`, category: 'Tech', sub_category: 'Web' }],
    meta: { count: 1, savedAt: 1000 * n, mode: 'browser', stats: { dateSpan: `span ${n}` } }
})

describe('rotateRuns', () => {
    it('keeps no older runs after the very first run', () => {
        expect(rotateRuns([], null)).toEqual([])
    })

    it('moves the previous latest to the front of the older runs, tagged with an id', () => {
        expect(rotateRuns([], run(1).meta)).toEqual([{ ...run(1).meta, id: '1000' }])
    })

    it('keeps every older run, newest first', () => {
        const older = [{ ...run(3).meta, id: '3000' }, { ...run(2).meta, id: '2000' }, { ...run(1).meta, id: '1000' }]

        const entries = rotateRuns(older, run(4).meta)

        expect(entries.map(e => e.id)).toEqual(['4000', '3000', '2000', '1000'])
    })

    it('never lists the same run twice', () => {
        const older = [{ ...run(1).meta, id: '1000' }]

        const entries = rotateRuns(older, run(1).meta)

        expect(entries.map(e => e.id)).toEqual(['1000'])
    })
})

describe('saved run history', () => {
    let local
    let session

    beforeEach(() => {
        local = fakeArea()
        session = fakeArea()
        global.chrome = { runtime: {}, storage: { local, session } }
    })

    afterEach(() => { delete global.chrome })

    it('stores the newest run as the latest, on disk and mirrored to session', async () => {
        const { results, meta } = run(1)

        await saveRun(results, meta)

        expect(local.data.get('organizedMeta')).toEqual(meta)
        expect(local.data.get('organizedData')).toEqual(results)
        expect(session.data.get('organizedData')).toEqual(results)
        expect(await loadHistory()).toEqual([])
    })

    it('keeps every run downloadable, however many there are', async () => {
        const count = 12
        for (let n = 1; n <= count; n++) await saveRun(run(n).results, run(n).meta)

        // Latest is run 12; runs 11 down to 1 are the older ones, none discarded.
        expect(local.data.get('organizedData')).toEqual(run(count).results)
        expect((await loadHistory()).map(e => e.id)).toEqual(
            Array.from({ length: count - 1 }, (_, i) => String((count - 1 - i) * 1000))
        )
        for (let n = 1; n < count; n++) expect(await loadRunData(String(n * 1000))).toEqual(run(n).results)
        expect([...local.data.keys()].filter(k => k.startsWith('organizedRun:'))).toHaveLength(count - 1)
    })

    it('deletes one older run and its data, leaving the others and the latest', async () => {
        for (const n of [1, 2, 3, 4]) await saveRun(run(n).results, run(n).meta)

        const remaining = await deleteRun('2000')

        expect(remaining.map(e => e.id)).toEqual(['3000', '1000'])
        expect((await loadHistory()).map(e => e.id)).toEqual(['3000', '1000'])
        expect(await loadRunData('2000')).toBeNull()
        expect(await loadRunData('1000')).toEqual(run(1).results)
        expect(local.data.get('organizedData')).toEqual(run(4).results)
    })

    it('clears every older run but keeps the latest', async () => {
        for (const n of [1, 2, 3, 4]) await saveRun(run(n).results, run(n).meta)

        await clearHistory()

        expect(await loadHistory()).toEqual([])
        expect([...local.data.keys()].filter(k => k.startsWith('organizedRun:'))).toEqual([])
        expect(local.data.get('organizedData')).toEqual(run(4).results)
    })

    it('does not turn a previous run without stored data into a history entry', async () => {
        local.data.set('organizedMeta', run(1).meta) // metadata only, as older builds left it

        await saveRun(run(2).results, run(2).meta)

        expect(await loadHistory()).toEqual([])
    })

    it('loads the latest run with its metadata, or null when nothing usable is saved', async () => {
        expect(await loadLatestRun()).toBeNull()

        local.data.set('organizedMeta', run(1).meta) // metadata without data is not downloadable
        expect(await loadLatestRun()).toBeNull()

        await saveRun(run(2).results, run(2).meta)
        expect(await loadLatestRun()).toEqual({ results: run(2).results, meta: run(2).meta })
    })

    it('still saves when session storage is unavailable', async () => {
        delete global.chrome.storage.session

        await saveRun(run(1).results, run(1).meta)

        expect(local.data.get('organizedData')).toEqual(run(1).results)
    })
})
