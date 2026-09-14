import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    detectOtherBookmarksFolderId,
    getOtherBookmarksRootId,
    shouldCreateSubFolder,
    flattenBookmarks,
    moveBookmark,
    removeBookmark,
    getBookmarkChildren,
    createFolder,
    createBookmark,
    importBookmarksToBrowser,
    findDuplicateBookmarks,
    removeDuplicateBookmarksFromBrowser
} from './bookmarks';

describe('bookmarks service', () => {
    describe('findDuplicateBookmarks', () => {
        it('keeps the oldest bookmark for each exact URL and returns newer copies', () => {
            const tree = [{
                id: 'root',
                children: [
                    { id: 'newer', url: 'https://example.com', title: 'Newer', dateAdded: 300 },
                    { id: 'other', url: 'https://other.com', title: 'Other', dateAdded: 200 },
                    { id: 'oldest', url: 'https://example.com', title: 'Oldest', dateAdded: 100 },
                    { id: '11', url: 'https://third.com', title: 'High', dateAdded: 400 },
                    { id: '10', url: 'https://third.com', title: 'Low', dateAdded: 400 }
                ]
            }];

            expect(findDuplicateBookmarks(tree)).toEqual({
                duplicates: [
                    expect.objectContaining({ id: 'newer' }),
                    expect.objectContaining({ id: '11' })
                ],
                duplicateCount: 2,
                totalBookmarks: 5
            });
        });
    });

    describe('detectOtherBookmarksFolderId', () => {
        it('detects Chrome bookmarks root ID 2', () => {
            const chromeTree = [
                {
                    id: '0',
                    title: 'root',
                    children: [
                        { id: '1', title: 'Bookmarks bar' },
                        { id: '2', title: 'Other bookmarks' },
                        { id: '3', title: 'Mobile bookmarks' }
                    ]
                }
            ];
            expect(detectOtherBookmarksFolderId(chromeTree)).toBe('2');
        });

        it('detects Firefox unfiled bookmarks root ID unfiled_____', () => {
            const firefoxTree = [
                {
                    id: 'root________',
                    title: '',
                    children: [
                        { id: 'menu________', title: 'Bookmarks Menu' },
                        { id: 'toolbar_____', title: 'Bookmarks Toolbar' },
                        { id: 'unfiled_____', title: 'Other Bookmarks' },
                        { id: 'mobile______', title: 'Mobile Bookmarks' }
                    ]
                }
            ];
            expect(detectOtherBookmarksFolderId(firefoxTree)).toBe('unfiled_____');
        });

        it('detects unfiled folder when tree is passed as children array directly', () => {
            const children = [
                { id: 'menu________', title: 'Bookmarks Menu' },
                { id: 'toolbar_____', title: 'Bookmarks Toolbar' },
                { id: 'unfiled_____', title: 'Unfiled Bookmarks' }
            ];
            expect(detectOtherBookmarksFolderId(children)).toBe('unfiled_____');
        });

        it('matches by title containing unfiled or other bookmarks if IDs differ', () => {
            const customTree = [
                {
                    id: 'root',
                    children: [
                        { id: 'favs', title: 'My Favorites' },
                        { id: 'custom-unfiled', title: 'Other Bookmarks' }
                    ]
                }
            ];
            expect(detectOtherBookmarksFolderId(customTree)).toBe('custom-unfiled');
        });

        it('falls back to 2 when tree is empty or invalid', () => {
            expect(detectOtherBookmarksFolderId([])).toBe('2');
            expect(detectOtherBookmarksFolderId(null)).toBe('2');
            expect(detectOtherBookmarksFolderId(undefined)).toBe('2');
            expect(detectOtherBookmarksFolderId([{ id: 'root', children: [] }])).toBe('2');
        });
    });

    describe('getOtherBookmarksRootId', () => {
        it('resolves root ID cleanly in mock environment', async () => {
            const rootId = await getOtherBookmarksRootId();
            expect(typeof rootId).toBe('string');
            expect(rootId).toBeTruthy();
        });
    });

    describe('shouldCreateSubFolder', () => {
        it('returns false for empty or general/uncategorized', () => {
            expect(shouldCreateSubFolder('Tech', '')).toBe(false);
            expect(shouldCreateSubFolder('Tech', 'General')).toBe(false);
            expect(shouldCreateSubFolder('Tech', 'None')).toBe(false);
            expect(shouldCreateSubFolder('Tech', 'Uncategorized')).toBe(false);
            expect(shouldCreateSubFolder('Tech', 'Tech')).toBe(false);
        });

        it('returns true for distinct subcategories', () => {
            expect(shouldCreateSubFolder('Technology', 'JavaScript')).toBe(true);
            expect(shouldCreateSubFolder('News', 'Politics')).toBe(true);
        });
    });

    describe('flattenBookmarks', () => {
        it('flattens nested bookmark tree into array of links', () => {
            const tree = [
                {
                    id: '1',
                    title: 'Folder 1',
                    children: [
                        { id: '2', title: 'Google', url: 'https://google.com', parentId: '1', dateAdded: 100 },
                        {
                            id: '3',
                            title: 'Subfolder',
                            children: [
                                { id: '4', title: 'GitHub', url: 'https://github.com', parentId: '3', dateAdded: 200 }
                            ]
                        }
                    ]
                }
            ];
            const flattened = flattenBookmarks(tree);
            expect(flattened).toHaveLength(2);
            expect(flattened[0].url).toBe('https://google.com');
            expect(flattened[1].url).toBe('https://github.com');
        });
    });
});

describe('bookmarks write wrappers', () => {
    afterEach(() => { delete global.chrome })

    it('moveBookmark forwards a destination object with parentId and optional index', async () => {
        global.chrome = { runtime: {}, bookmarks: { move: vi.fn((id, dest, cb) => cb({ id })) } }
        await moveBookmark('7', { parentId: '2', index: 3 })
        expect(global.chrome.bookmarks.move).toHaveBeenCalledWith('7', { parentId: '2', index: 3 }, expect.any(Function))
    })

    it('moveBookmark rejects on runtime lastError', async () => {
        global.chrome = { runtime: { lastError: { message: 'node not found' } }, bookmarks: { move: vi.fn((id, dest, cb) => cb()) } }
        await expect(moveBookmark('7', { parentId: '2' })).rejects.toThrow('node not found')
    })

    it('removeBookmark resolves and rejects correctly', async () => {
        global.chrome = { runtime: {}, bookmarks: { remove: vi.fn((id, cb) => cb()) } }
        await expect(removeBookmark('9')).resolves.toBeUndefined()
        global.chrome.runtime.lastError = { message: 'cannot remove' }
        global.chrome.bookmarks.remove = vi.fn((id, cb) => cb())
        await expect(removeBookmark('9')).rejects.toThrow('cannot remove')
    })

    it('removes each duplicate bookmark and reports the removal count', async () => {
        const removedIds = []
        global.chrome = {
            runtime: {},
            bookmarks: {
                getTree: vi.fn((cb) => cb([{
                    id: 'root',
                    children: [
                        { id: 'old', url: 'https://example.com', dateAdded: 100 },
                        { id: 'new', url: 'https://example.com', dateAdded: 200 },
                        { id: 'unique', url: 'https://unique.com', dateAdded: 300 }
                    ]
                }])),
                remove: vi.fn((id, cb) => {
                    removedIds.push(id)
                    cb()
                })
            }
        }

        await expect(removeDuplicateBookmarksFromBrowser()).resolves.toMatchObject({
            totalBookmarks: 3,
            duplicateCount: 1,
            removedCount: 1,
            failed: []
        })
        expect(removedIds).toEqual(['new'])
    })

    it('getBookmarkChildren resolves the children array', async () => {
        global.chrome = { runtime: {}, bookmarks: { getChildren: vi.fn((pid, cb) => cb([{ id: '10' }, { id: '11' }])) } }
        await expect(getBookmarkChildren('2')).resolves.toEqual([{ id: '10' }, { id: '11' }])
    })
    it('createFolder passes index when provided', async () => {
        global.chrome = {
            runtime: {},
            bookmarks: {
                create: vi.fn((data, cb) => cb({ id: 'folder-1', ...data }))
            }
        }
        const res = await createFolder('2', 'New Folder', 0)
        expect(global.chrome.bookmarks.create).toHaveBeenCalledWith({ parentId: '2', title: 'New Folder', index: 0 }, expect.any(Function))
        expect(res.id).toBe('folder-1')
    })

    it('createBookmark passes index when provided', async () => {
        global.chrome = {
            runtime: {},
            bookmarks: {
                create: vi.fn((data, cb) => cb({ id: 'bm-1', ...data }))
            }
        }
        const res = await createBookmark('2', 'My Link', 'https://example.com', 0)
        expect(global.chrome.bookmarks.create).toHaveBeenCalledWith({ parentId: '2', title: 'My Link', url: 'https://example.com', index: 0 }, expect.any(Function))
        expect(res.id).toBe('bm-1')
    })

    it('importBookmarksToBrowser creates root folder at index 0 and imports flat items', async () => {
        const createdNodes = []
        global.chrome = {
            runtime: {},
            bookmarks: {
                getTree: vi.fn((cb) => cb([{ id: '0', children: [{ id: '1', title: 'Bar' }, { id: '2', title: 'Other Bookmarks' }] }])),
                getChildren: vi.fn((pid, cb) => cb([])),
                create: vi.fn((data, cb) => {
                    const node = { id: `node-${createdNodes.length + 1}`, ...data }
                    createdNodes.push(node)
                    cb(node)
                }),
                move: vi.fn((id, dest, cb) => cb({ id, ...dest }))
            }
        }

        const items = [
            { title: 'Item 1', url: 'https://item1.com' },
            { title: 'Item 2', url: 'https://item2.com' }
        ]

        const res = await importBookmarksToBrowser(items, { isFlat: true, folderTitle: 'Test Flat Chronological' })
        expect(res.importedCount).toBe(2)
        expect(createdNodes[0]).toMatchObject({ parentId: '2', title: 'Test Flat Chronological', index: 0 })
        expect(createdNodes[1]).toMatchObject({ parentId: createdNodes[0].id, title: 'Item 1', url: 'https://item1.com' })
        expect(createdNodes[2]).toMatchObject({ parentId: createdNodes[0].id, title: 'Item 2', url: 'https://item2.com' })
    })

    it('importBookmarksToBrowser creates categories and subcategories at top of Other Bookmarks', async () => {
        const createdNodes = []
        global.chrome = {
            runtime: {},
            bookmarks: {
                getTree: vi.fn((cb) => cb([{ id: '0', children: [{ id: '2', title: 'Other Bookmarks' }] }])),
                getChildren: vi.fn((pid, cb) => cb([])),
                create: vi.fn((data, cb) => {
                    const node = { id: `node-${createdNodes.length + 1}`, ...data }
                    createdNodes.push(node)
                    cb(node)
                }),
                move: vi.fn((id, dest, cb) => cb({ id, ...dest }))
            }
        }

        const items = [
            { title: 'React Docs', url: 'https://react.dev', category: 'Tech', sub_category: 'Frontend' },
            { title: 'Python Docs', url: 'https://python.org', category: 'Tech', sub_category: 'Backend' }
        ]

        const res = await importBookmarksToBrowser(items, { isFlat: false, folderTitle: 'Test Categorized' })
        expect(res.importedCount).toBe(2)
        expect(createdNodes[0].title).toBe('Test Categorized')
        expect(createdNodes[0].index).toBe(0)
    })

})
