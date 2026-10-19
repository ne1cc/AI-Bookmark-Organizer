import { describe, expect, it } from 'vitest'
import {
    addCategory, addSubfolder, checkName, mergeCategories, mergeSubfolders, moveSubfolder,
    removeCategory, removeSubfolder, renameCategory, renameSubfolder, summarize
} from './planEditor'

const plan = () => ({
    categories: [
        { name: 'Tech', sub_categories: ['Web', 'Data'] },
        { name: 'Travel', sub_categories: ['Flights', 'Hotels'] },
        { name: 'Finance', sub_categories: [] }
    ]
})

describe('checkName', () => {
    it('accepts a fresh name', () => {
        expect(checkName('Recipes', ['Web'], 'Tech')).toBeNull()
    })

    it('rejects empty, slash, reserved, parent-echo and sibling-duplicate names', () => {
        expect(checkName('   ', [])).toMatch(/empty/i)
        expect(checkName('a/b', [])).toMatch(/slash/i)
        expect(checkName('General', [], 'Tech')).toMatch(/reserved/i)
        expect(checkName('Tech', [], 'Tech')).toMatch(/like its category/i)
        expect(checkName('web ', ['Web'], 'Tech')).toMatch(/already exists/i)
        expect(checkName('Webs', ['Web'], 'Tech')).toMatch(/already exists/i)
    })

    it('allows a reserved-looking name at the category level', () => {
        expect(checkName('Other', ['Tech'])).toBeNull()
    })
})

describe('summarize', () => {
    it('counts categories and subfolders', () => {
        expect(summarize(plan())).toEqual({ categories: 3, subfolders: 4 })
    })
})

describe('rename', () => {
    it('renames a category and keeps its subfolders', () => {
        const { plan: next } = renameCategory(plan(), 'Tech', 'Technology')
        expect(next.categories[0]).toEqual({ name: 'Technology', sub_categories: ['Web', 'Data'] })
    })

    it('refuses a category name that clashes with a sibling or one of its own subfolders', () => {
        expect(renameCategory(plan(), 'Tech', 'travel').error).toMatch(/already exists/i)
        expect(renameCategory(plan(), 'Tech', 'Web').error).toMatch(/subfolder/i)
        expect(renameCategory(plan(), 'Nope', 'X').error).toMatch(/not found/i)
    })

    it('renames a subfolder in place', () => {
        const { plan: next } = renameSubfolder(plan(), 'Tech', 'Web', 'Frontend')
        expect(next.categories[0].sub_categories).toEqual(['Frontend', 'Data'])
    })

    it('refuses an invalid subfolder name and reports a missing one', () => {
        expect(renameSubfolder(plan(), 'Tech', 'Web', 'Data').error).toMatch(/already exists/i)
        expect(renameSubfolder(plan(), 'Tech', 'Web', 'Misc').error).toMatch(/reserved/i)
        expect(renameSubfolder(plan(), 'Tech', 'Nope', 'X').error).toMatch(/not found/i)
    })

    it('allows renaming a subfolder to a different spelling of itself', () => {
        expect(renameSubfolder(plan(), 'Tech', 'Web', 'web').plan.categories[0].sub_categories[0]).toBe('web')
    })
})

describe('add', () => {
    it('adds a category with no subfolders and a subfolder at the end', () => {
        const added = addCategory(plan(), 'Reading').plan
        expect(added.categories.at(-1)).toEqual({ name: 'Reading', sub_categories: [] })
        expect(addSubfolder(added, 'Reading', 'Blogs').plan.categories.at(-1).sub_categories).toEqual(['Blogs'])
    })

    it('rejects duplicates and unknown parents', () => {
        expect(addCategory(plan(), 'tech').error).toMatch(/already exists/i)
        expect(addSubfolder(plan(), 'Tech', 'Web').error).toMatch(/already exists/i)
        expect(addSubfolder(plan(), 'Nope', 'X').error).toMatch(/not found/i)
    })
})

describe('remove', () => {
    it('removes a subfolder and a category', () => {
        expect(removeSubfolder(plan(), 'Tech', 'Web').plan.categories[0].sub_categories).toEqual(['Data'])
        expect(removeCategory(plan(), 'Travel').plan.categories.map(c => c.name)).toEqual(['Tech', 'Finance'])
    })

    it('refuses to remove the last category', () => {
        const single = { categories: [{ name: 'Tech', sub_categories: [] }] }
        expect(removeCategory(single, 'Tech').error).toMatch(/at least one category/i)
    })
})

describe('move', () => {
    it('re-parents a subfolder', () => {
        const next = moveSubfolder(plan(), 'Travel', 'Hotels', 'Tech').plan
        expect(next.categories[0].sub_categories).toEqual(['Web', 'Data', 'Hotels'])
        expect(next.categories[1].sub_categories).toEqual(['Flights'])
    })

    it('refuses a clash, the same category, and missing nodes', () => {
        const clash = addSubfolder(plan(), 'Travel', 'Data').plan
        expect(moveSubfolder(clash, 'Travel', 'Data', 'Tech').error).toMatch(/already exists/i)
        expect(moveSubfolder(plan(), 'Tech', 'Web', 'Tech').error).toMatch(/already in/i)
        expect(moveSubfolder(plan(), 'Tech', 'Nope', 'Travel').error).toMatch(/not found/i)
        expect(moveSubfolder(plan(), 'Tech', 'Web', 'Nope').error).toMatch(/not found/i)
    })
})

describe('merge', () => {
    it('merges a subfolder into another, even across categories; the target keeps its name', () => {
        const next = mergeSubfolders(plan(), { category: 'Travel', name: 'Hotels' }, { category: 'Tech', name: 'Web' }).plan
        expect(next.categories[1].sub_categories).toEqual(['Flights'])
        expect(next.categories[0].sub_categories).toEqual(['Web', 'Data'])
    })

    it('refuses to merge a subfolder into itself', () => {
        const same = { category: 'Tech', name: 'Web' }
        expect(mergeSubfolders(plan(), same, same).error).toMatch(/different/i)
    })

    it('merges categories: subfolders move over, duplicates are dropped, the source disappears', () => {
        const start = addSubfolder(plan(), 'Finance', 'Data').plan
        const next = mergeCategories(start, 'Finance', 'Tech').plan
        expect(next.categories.map(c => c.name)).toEqual(['Tech', 'Travel'])
        expect(next.categories[0].sub_categories).toEqual(['Web', 'Data'])
        const withSubs = mergeCategories(plan(), 'Travel', 'Tech').plan
        expect(withSubs.categories[0].sub_categories).toEqual(['Web', 'Data', 'Flights', 'Hotels'])
    })

    it('refuses category merges into itself or unknown categories', () => {
        expect(mergeCategories(plan(), 'Tech', 'Tech').error).toMatch(/different/i)
        expect(mergeCategories(plan(), 'Nope', 'Tech').error).toMatch(/not found/i)
    })
})

describe('immutability', () => {
    it('never mutates the input plan', () => {
        const original = plan()
        const frozen = JSON.parse(JSON.stringify(original))
        renameCategory(original, 'Tech', 'T')
        renameSubfolder(original, 'Tech', 'Web', 'W')
        addCategory(original, 'New')
        addSubfolder(original, 'Tech', 'New')
        removeCategory(original, 'Travel')
        removeSubfolder(original, 'Tech', 'Web')
        moveSubfolder(original, 'Travel', 'Hotels', 'Tech')
        mergeSubfolders(original, { category: 'Travel', name: 'Hotels' }, { category: 'Tech', name: 'Web' })
        mergeCategories(original, 'Travel', 'Tech')
        expect(original).toEqual(frozen)
    })
})
