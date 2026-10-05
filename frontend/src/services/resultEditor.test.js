import { describe, expect, it } from 'vitest'
import { applyOps, buildRows, buildTree, detailStats, recordPath } from './resultEditor'

const bm = (n, category, sub_category, detail_category = null) => ({
    title: `B${n}`, url: `https://example.com/${n}`, category, sub_category, detail_category
})

// Tech/Web (3, with details Frameworks x2 and Tooling x1), Tech/Data (2), Tech directly (1 via General),
// Travel/Flights (2), Travel/Hotels (1)
const items = () => [
    bm(1, 'Tech', 'Web', 'Frameworks'), bm(2, 'Tech', 'Web', 'Frameworks'), bm(3, 'Tech', 'Web', 'Tooling'),
    bm(4, 'Tech', 'Data'), bm(5, 'Tech', 'Data'),
    bm(6, 'Tech', 'General'),
    bm(7, 'Travel', 'Flights'), bm(8, 'Travel', 'Flights'),
    bm(9, 'Travel', 'Hotels')
]

const names = (nodes) => nodes.map(n => n.name)
const find = (nodes, ...path) => path.reduce((level, name) => level.children.find(n => n.name === name), { children: nodes })

describe('recordPath', () => {
    it('stops at the deepest real folder', () => {
        expect(recordPath(bm(1, 'Tech', 'Web', 'Frameworks'))).toEqual(['Tech', 'Web', 'Frameworks'])
        expect(recordPath(bm(1, 'Tech', 'Web'))).toEqual(['Tech', 'Web'])
        expect(recordPath(bm(1, 'Tech', 'General'))).toEqual(['Tech'])
        expect(recordPath(bm(1, 'Tech', 'Web', 'Web'))).toEqual(['Tech', 'Web'])
    })
})

describe('buildRows and buildTree', () => {
    it('groups bookmarks into one row per folder path with counts', () => {
        const rows = buildRows(items())
        expect(rows).toHaveLength(6)
        expect(rows.find(r => r.sub_category === 'Web' && r.detail_category === 'Frameworks').count).toBe(2)
        expect(rows.find(r => r.category === 'Tech' && r.sub_category === 'General').count).toBe(1)
    })

    it('builds the nested tree with totals and directly-filed counts', () => {
        const tree = buildTree(items())
        expect(names(tree)).toEqual(['Tech', 'Travel'])
        expect(find(tree, 'Tech').count).toBe(6)
        expect(find(tree, 'Tech').direct).toBe(1)
        expect(find(tree, 'Tech', 'Web').count).toBe(3)
        expect(find(tree, 'Tech', 'Web').direct).toBe(0)
        expect(find(tree, 'Tech', 'Web', 'Frameworks').count).toBe(2)
        expect(find(tree, 'Tech', 'Web', 'Frameworks').path).toEqual(['Tech', 'Web', 'Frameworks'])
    })

    it('gives the same tree from rows as from bookmarks', () => {
        expect(buildTree(buildRows(items()))).toEqual(buildTree(items()))
    })
})

describe('detailStats', () => {
    it('counts third-level folders and the subfolders that hold them', () => {
        expect(detailStats(items())).toEqual({ detailFolders: 2, detailedSubcategories: 1 })
        expect(detailStats(applyOps(items(), [{ op: 'delete', path: ['Tech', 'Web', 'Tooling'] }]).records))
            .toEqual({ detailFolders: 1, detailedSubcategories: 1 })
        expect(detailStats([])).toEqual({ detailFolders: 0, detailedSubcategories: 0 })
    })
})

describe('rename', () => {
    it('relabels a category, a subfolder and a third-level folder', () => {
        const { records } = applyOps(items(), [
            { op: 'rename', path: ['Tech'], to: 'Technology' },
            { op: 'rename', path: ['Technology', 'Web'], to: 'Frontend' },
            { op: 'rename', path: ['Technology', 'Frontend', 'Frameworks'], to: 'Libraries' }
        ])
        const tree = buildTree(records)
        expect(names(tree)).toEqual(['Technology', 'Travel'])
        expect(find(tree, 'Technology', 'Frontend', 'Libraries').count).toBe(2)
    })

    it('refuses empty, reserved, duplicate, parent-echo and missing targets', () => {
        const run = (op) => applyOps(items(), [op]).error
        expect(run({ op: 'rename', path: ['Tech'], to: ' ' })).toMatch(/empty/i)
        expect(run({ op: 'rename', path: ['Tech', 'Web'], to: 'General' })).toMatch(/reserved/i)
        expect(run({ op: 'rename', path: ['Tech', 'Web'], to: 'Data' })).toMatch(/already exists/i)
        expect(run({ op: 'rename', path: ['Tech', 'Web'], to: 'Tech' })).toMatch(/like its category/i)
        expect(run({ op: 'rename', path: ['Tech', 'Web', 'Tooling'], to: 'Tech' })).toMatch(/like its category/i)
        expect(run({ op: 'rename', path: ['Nope'], to: 'X' })).toMatch(/no longer exists/i)
    })
})

describe('delete', () => {
    it('moves a subfolder\'s bookmarks up into its category', () => {
        const { records } = applyOps(items(), [{ op: 'delete', path: ['Tech', 'Web'] }])
        const tree = buildTree(records)
        expect(find(tree, 'Tech', 'Web')).toBeUndefined()
        expect(find(tree, 'Tech').direct).toBe(4)
    })

    it('moves a third-level folder\'s bookmarks up into its subfolder', () => {
        const { records } = applyOps(items(), [{ op: 'delete', path: ['Tech', 'Web', 'Frameworks'] }])
        const web = find(buildTree(records), 'Tech', 'Web')
        expect(web.direct).toBe(2)
        expect(names(web.children)).toEqual(['Tooling'])
    })

    it('refuses to delete a category', () => {
        expect(applyOps(items(), [{ op: 'delete', path: ['Tech'] }]).error).toMatch(/merging/i)
    })
})

describe('move', () => {
    it('moves a subfolder, with its third-level folders, to another category', () => {
        const { records } = applyOps(items(), [{ op: 'move', path: ['Tech', 'Web'], to: ['Travel'] }])
        const tree = buildTree(records)
        expect(find(tree, 'Travel', 'Web', 'Frameworks').count).toBe(2)
        expect(find(tree, 'Tech', 'Web')).toBeUndefined()
    })

    it('moves a third-level folder to another subfolder', () => {
        const { records } = applyOps(items(), [{ op: 'move', path: ['Tech', 'Web', 'Tooling'], to: ['Tech', 'Data'] }])
        expect(find(buildTree(records), 'Tech', 'Data', 'Tooling').count).toBe(1)
    })

    it('refuses categories, clashes, the same parent and missing destinations', () => {
        const run = (op) => applyOps(items(), [op]).error
        expect(run({ op: 'move', path: ['Tech'], to: [] })).toMatch(/cannot be moved/i)
        expect(run({ op: 'move', path: ['Tech', 'Data'], to: ['Tech'] })).toMatch(/already there/i)
        expect(run({ op: 'move', path: ['Tech', 'Web'], to: ['Nope'] })).toMatch(/no longer exists/i)
        const clash = [...items(), bm(10, 'Travel', 'Web')]
        expect(applyOps(clash, [{ op: 'move', path: ['Tech', 'Web'], to: ['Travel'] }]).error).toMatch(/already exists/i)
    })
})

describe('merge', () => {
    it('merges a subfolder into another in a different category, the target keeping its name', () => {
        const { records } = applyOps(items(), [{ op: 'merge', path: ['Travel', 'Hotels'], to: ['Tech', 'Data'] }])
        const tree = buildTree(records)
        expect(find(tree, 'Tech', 'Data').count).toBe(3)
        expect(find(tree, 'Travel', 'Hotels')).toBeUndefined()
    })

    it('merges a category: its folders join the target and matching names unify on the target spelling', () => {
        const data = [...items(), bm(11, 'Learning', 'web', 'frameworks'), bm(12, 'Learning', 'web', 'frameworks'), bm(13, 'Learning', 'Notes')]
        const { records } = applyOps(data, [{ op: 'merge', path: ['Learning'], to: ['Tech'] }])
        const tree = buildTree(records)
        expect(names(tree)).toEqual(['Tech', 'Travel'])
        expect(find(tree, 'Tech', 'Web', 'Frameworks').count).toBe(4)
        expect(find(tree, 'Tech', 'Notes').count).toBe(1)
    })

    it('merges third-level folders', () => {
        const { records } = applyOps(items(), [{ op: 'merge', path: ['Tech', 'Web', 'Tooling'], to: ['Tech', 'Web', 'Frameworks'] }])
        const web = find(buildTree(records), 'Tech', 'Web')
        expect(names(web.children)).toEqual(['Frameworks'])
        expect(web.children[0].count).toBe(3)
    })

    it('refuses a different level, itself and a missing folder', () => {
        const run = (op) => applyOps(items(), [op]).error
        expect(run({ op: 'merge', path: ['Tech', 'Web'], to: ['Travel'] })).toMatch(/same level/i)
        expect(run({ op: 'merge', path: ['Tech', 'Web'], to: ['Tech', 'Web'] })).toMatch(/different/i)
        expect(run({ op: 'merge', path: ['Tech', 'Web'], to: ['Tech', 'Nope'] })).toMatch(/no longer exists/i)
    })
})

describe('applyOps', () => {
    it('applies ops in order and applies none if any fails', () => {
        const ok = applyOps(items(), [
            { op: 'rename', path: ['Tech', 'Data'], to: 'Datasets' },
            { op: 'move', path: ['Tech', 'Datasets'], to: ['Travel'] }
        ])
        expect(find(buildTree(ok.records), 'Travel', 'Datasets').count).toBe(2)

        const bad = applyOps(items(), [
            { op: 'rename', path: ['Tech', 'Data'], to: 'Datasets' },
            { op: 'rename', path: ['Tech', 'Data'], to: 'Again' }
        ])
        expect(bad.error).toMatch(/no longer exists/i)
        expect(bad.records).toBeUndefined()
    })

    it('rejects unknown operations', () => {
        expect(applyOps(items(), [{ op: 'explode', path: ['Tech'] }]).error).toMatch(/unknown edit/i)
    })

    it('rejects operation names that only exist on the object prototype', () => {
        for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
            const out = applyOps(items(), [{ op: name, path: ['Tech'], to: 'X' }])
            expect(out.error).toMatch(/unknown edit/i)
            expect(out.records).toBeUndefined()
        }
    })

    it('rejects malformed edits without throwing', () => {
        const hostile = [
            null,
            undefined,
            'rename',
            42,
            { op: 'rename', path: 'Tech', to: 'X' },
            { op: 'rename', path: { 0: 'Tech', length: 1 }, to: 'X' },
            { op: 'rename', path: [], to: 'X' },
            { op: 'rename', path: ['Tech', 'Web', 'Frameworks', 'More'], to: 'X' },
            { op: 'rename', path: ['Tech', 7], to: 'X' },
            { op: 'delete' },
            { op: 'rename', path: ['Tech'], to: ['X'] },
            { op: 'rename', path: ['Tech'], to: { name: 'X' } },
            { op: 'move', path: ['Tech', 'Web'], to: 'Travel' },
            { op: 'move', path: ['Tech', 'Web'], to: [{}] },
            { op: 'merge', path: ['Tech', 'Web'], to: 'Tech/Data' },
            { op: 'merge', path: ['Tech', 'Web'], to: ['Tech', null] }
        ]
        for (const op of hostile) {
            let out
            expect(() => { out = applyOps(items(), [op]) }).not.toThrow()
            expect(out.error).toBe('That edit is not valid.')
            expect(out.records).toBeUndefined()
        }
    })

    it('rejects a sparse op list without throwing', () => {
        // eslint-disable-next-line no-sparse-arrays
        expect(applyOps(items(), [, { op: 'rename', path: ['Tech'], to: 'X' }]).error).toBe('That edit is not valid.')
    })

    it('never mutates the input and keeps every other field', () => {
        const input = items()
        const frozen = JSON.parse(JSON.stringify(input))
        const { records } = applyOps(input, [{ op: 'rename', path: ['Travel'], to: 'Trips' }])
        expect(input).toEqual(frozen)
        expect(records.find(r => r.title === 'B7')).toMatchObject({ url: 'https://example.com/7', category: 'Trips' })
    })

    it('gives the same tree whether the ops run on bookmarks (worker) or on grouped rows (panel)', () => {
        const ops = [
            { op: 'rename', path: ['Tech', 'Web'], to: 'Frontend' },
            { op: 'move', path: ['Tech', 'Data'], to: ['Travel'] },
            { op: 'delete', path: ['Tech', 'Frontend', 'Tooling'] },
            { op: 'merge', path: ['Travel', 'Hotels'], to: ['Travel', 'Flights'] },
            { op: 'merge', path: ['Travel'], to: ['Tech'] }
        ]
        const fromItems = applyOps(items(), ops)
        const fromRows = applyOps(buildRows(items()), ops)
        expect(fromItems.error).toBeUndefined()
        expect(buildTree(fromRows.records)).toEqual(buildTree(fromItems.records))
    })

    it('canonicalizes echoing folder names so rows and bookmarks stay in parity', () => {
        const data = [...items(), bm(10, 'Tech', 'Tech'), bm(11, 'Tech', 'Web', 'Web')]
        const ops = [
            { op: 'rename', path: ['Tech'], to: 'Technology' },
            { op: 'rename', path: ['Technology', 'Web'], to: 'Frontend' }
        ]
        const fromItems = applyOps(data, ops)
        const fromRows = applyOps(buildRows(data), ops)
        expect(fromItems.error).toBeUndefined()
        expect(fromRows.error).toBeUndefined()
        const treeItems = buildTree(fromItems.records)
        const treeRows = buildTree(fromRows.records)
        expect(treeRows).toEqual(treeItems)
        expect(find(treeItems, 'Technology', 'Tech')).toBeUndefined()
        expect(find(treeItems, 'Technology', 'Frontend', 'Web')).toBeUndefined()
    })

    it('refuses to move a subfolder into a category with that name', () => {
        const data = [...items(), bm(12, 'Data', 'Misc')]
        expect(applyOps(data, [{ op: 'move', path: ['Tech', 'Data'], to: ['Data'] }]).error).toMatch(/like its parent/i)
    })

    it('refuses to rename a category to match an existing subfolder name', () => {
        expect(applyOps(items(), [{ op: 'rename', path: ['Tech'], to: 'Web' }]).error).toMatch(/subfolder/i)
    })
})
