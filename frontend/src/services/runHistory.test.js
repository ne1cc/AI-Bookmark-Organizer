import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { MAX_RUNS, rotateRuns, saveRun, loadHistory, loadRunData, loadLatestRun } from './runHistory'

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
        expect(rotateRuns([], null)).toEqual({ entries: [], dropped: [] })
    })

    it('moves the previous latest to the front of the older runs, tagged with an id', () => {
        const { entries, dropped } = rotateRuns([], run(1).meta)

        expect(entries).toEqual([{ ...run(1).meta, id: '1000' }])
        expect(dropped).toEqual([])
    })

    it('holds MAX_RUNS in total (latest included) and reports the oldest as dropped', () => {
        const older = [{ ...run(3).meta, id: '3000' }, { ...run(2).meta, id: '2000' }]

        const { entries, dropped } = rotateRuns(older, run(4).meta)

        expect(MAX_RUNS).toBe(3)
        expect(entries.map(e => e.id)).toEqual(['4000', '3000'])
        expect(dropped).toEqual(['2000'])
    })

    it('never lists the same run twice', () => {
        const older = [{ ...run(1).meta, id: '1000' }]

        const { entries } = rotateRuns(older, run(1).meta)

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

    it('keeps the three most recent runs downloadable and discards the rest', async () => {
        for (const n of [1, 2, 3, 4]) await saveRun(run(n).results, run(n).meta)

        // Latest is run 4; runs 3 and 2 are the older ones; run 1 is gone.
        expect(local.data.get('organizedData')).toEqual(run(4).results)
        expect((await loadHistory()).map(e => e.id)).toEqual(['3000', '2000'])
        expect(await loadRunData('3000')).toEqual(run(3).results)
        expect(await loadRunData('2000')).toEqual(run(2).results)
        expect(await loadRunData('1000')).toBeNull()
        expect([...local.data.keys()].filter(k => k.startsWith('organizedRun:')).sort())
            .toEqual(['organizedRun:2000', 'organizedRun:3000'])
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
