import { shouldCreateDetailFolder } from './subcategoryIdentity';
import { shouldCreateSubFolder } from './subcategoryPredicates';

export { shouldCreateSubFolder } from './subcategoryPredicates';

function getBookmarksApi() {
    return (typeof chrome !== 'undefined' && chrome.bookmarks) || (typeof browser !== 'undefined' && browser.bookmarks);
}

export function detectOtherBookmarksFolderId(tree) {
    if (!tree || !Array.isArray(tree) || tree.length === 0) return '2';
    const rootNode = tree[0];
    const rootChildren = rootNode?.children || tree;

    // 1. Check for Firefox unfiled root
    const firefoxUnfiled = rootChildren.find(c => c && c.id === 'unfiled_____');
    if (firefoxUnfiled) return 'unfiled_____';

    // 2. Check for Chrome standard '2'
    const chromeOther = rootChildren.find(c => c && c.id === '2');
    if (chromeOther) return '2';

    // 3. Match by title (e.g. "Other Bookmarks", "Unfiled Bookmarks")
    const titleMatch = rootChildren.find(c => {
        if (!c || !c.title) return false;
        const title = c.title.trim().toLowerCase();
        return title.includes('unfiled') || title.includes('other bookmarks') || title === 'other';
    });
    if (titleMatch) return titleMatch.id;

    return '2';
}

export async function getOtherBookmarksRootId() {
    try {
        const tree = await getBookmarks();
        return detectOtherBookmarksFolderId(tree);
    } catch {
        return '2';
    }
}

export async function getBookmarks() {
    return new Promise((resolve) => {
        const api = getBookmarksApi();
        if (!api) {
            resolve([]);
            return;
        }
        api.getTree((tree) => {
            resolve(tree || []);
        });
    });
}

export function flattenBookmarks(tree) {
    const flattened = [];
    const traverse = (node) => {
        if (node.url) {
            flattened.push({
                id: node.id,
                title: node.title,
                url: node.url,
                parentId: node.parentId,
                dateAdded: node.dateAdded
            });
        }
        if (node.children) {
            node.children.forEach(traverse);
        }
    };
    tree.forEach(traverse);
    return flattened;
}

function compareBookmarkAge(a, b) {
    const dateDifference = Number(a.dateAdded || 0) - Number(b.dateAdded || 0);
    if (dateDifference !== 0) return dateDifference;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
}

/**
 * Finds exact-URL duplicates in a bookmark tree. The oldest bookmark in each
 * URL group is retained; newer copies are returned for optional deletion.
 */
export function findDuplicateBookmarks(tree) {
    const groups = new Map();
    const bookmarks = flattenBookmarks(tree || []);

    for (const bookmark of bookmarks) {
        if (!bookmark.url) continue;
        if (!groups.has(bookmark.url)) groups.set(bookmark.url, []);
        groups.get(bookmark.url).push(bookmark);
    }

    const duplicates = [];
    for (const group of groups.values()) {
        const sorted = [...group].sort(compareBookmarkAge);
        duplicates.push(...sorted.slice(1));
    }

    return {
        duplicates,
        duplicateCount: duplicates.length,
        totalBookmarks: bookmarks.length
    };
}

/**
 * Removes duplicate URL entries from the live browser bookmark tree.
 * Failures are collected so one problematic node does not abort the cleanup.
 */
export async function removeDuplicateBookmarksFromBrowser() {
    const result = findDuplicateBookmarks(await getBookmarks());
    const failed = [];
    let removedCount = 0;

    for (const bookmark of result.duplicates) {
        try {
            await removeBookmark(bookmark.id);
            removedCount += 1;
        } catch (error) {
            failed.push({
                id: bookmark.id,
                url: bookmark.url,
                reason: error?.message || String(error)
            });
        }
    }

    return { ...result, removedCount, failed };
}

export async function createFolder(parentId, title, index) {
    return new Promise((resolve, reject) => {
        const createData = { parentId: parentId, title: title };
        if (typeof index === 'number') {
            createData.index = index;
        }
        chrome.bookmarks.create(createData, (result) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(result);
            }
        });
    });
}

export async function createBookmark(parentId, title, url, index) {
    return new Promise((resolve, reject) => {
        const createData = { parentId: parentId, title: title, url: url };
        if (typeof index === 'number') {
            createData.index = index;
        }
        chrome.bookmarks.create(createData, (result) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(result);
            }
        });
    });
}

export async function moveBookmark(id, destination) {
    return new Promise((resolve, reject) => {
        chrome.bookmarks.move(id, destination, (result) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(result);
            }
        });
    });
}

export async function removeBookmark(id) {
    return new Promise((resolve, reject) => {
        const api = getBookmarksApi();
        if (!api?.remove) {
            reject(new Error('Bookmarks API is unavailable.'));
            return;
        }
        api.remove(id, () => {
            const runtime = typeof chrome !== 'undefined' ? chrome.runtime : typeof browser !== 'undefined' ? browser.runtime : null;
            if (runtime?.lastError) {
                reject(new Error(runtime.lastError.message));
            } else {
                resolve();
            }
        });
    });
}

export async function getBookmarkChildren(parentId) {
    return new Promise((resolve, reject) => {
        chrome.bookmarks.getChildren(parentId, (children) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(children || []);
            }
        });
    });
}

let folderCache = {};

export function clearFolderCache() {
    folderCache = {};
}

export async function findOrCreateFolder(parentId, title, index) {
    const key = `${parentId}_${title}`;
    if (folderCache[key]) {
        return folderCache[key];
    }

    const promise = new Promise((resolve, reject) => {
        chrome.bookmarks.getChildren(parentId, async (children) => {
            if (chrome.runtime.lastError) {
                createFolder(parentId, title, index).then(resolve).catch(reject);
                return;
            }
            const existing = children?.find(c => c.title === title && !c.url);
            if (existing) {
                if (typeof index === 'number') {
                    try {
                        await moveBookmark(existing.id, { parentId, index });
                    } catch {
                        // ignore if move fails or unsupported
                    }
                }
                resolve(existing);
            } else {
                createFolder(parentId, title, index).then(resolve).catch(reject);
            }
        });
    });

    folderCache[key] = promise;
    return promise;
}

/**
 * Imports an array of organized bookmark items directly into the browser's
 * "Other Bookmarks" folder positioned at index 0 (top of the list).
 */
export async function importBookmarksToBrowser(items, options = {}) {
    const {
        isFlat = false,
        folderTitle,
        onProgress,
        isCancelled = () => false
    } = options;

    if (!items || !Array.isArray(items) || items.length === 0) {
        return { rootFolder: null, importedCount: 0, failed: [] };
    }

    const rootId = await getOtherBookmarksRootId();
    const title = folderTitle || (isFlat
        ? `Chronological Bookmarks-${new Date().toISOString().slice(0, 10)}`
        : `AI Organized Bookmarks-${new Date().toISOString().slice(0, 10)}`);

    // Create or find root folder at index 0 (top of Other Bookmarks)
    const rootFolder = await findOrCreateFolder(rootId, title, 0);
    try {
        await moveBookmark(rootFolder.id, { parentId: rootId, index: 0 });
    } catch {
        // ignore if move unsupported or already at index 0
    }

    const imported = [];
    const failed = [];
    const total = items.length;

    if (isFlat) {
        for (let i = 0; i < items.length; i++) {
            if (isCancelled()) break;
            const item = items[i];
            try {
                const created = await createBookmark(rootFolder.id, item.title || 'Untitled', item.url);
                imported.push(created);
            } catch (err) {
                failed.push({ title: item.title, reason: err?.message || String(err) });
            }
            if (onProgress && (i % 25 === 0 || i === total - 1)) {
                onProgress({ current: i + 1, total });
            }
        }
    } else {
        const createdFolders = {};
        // Pre-create category folders sorted alphabetically
        const categories = Array.from(new Set(items.map(it => it.category || 'Uncategorized'))).sort((a, b) => a.localeCompare(b));
        for (const cat of categories) {
            if (isCancelled()) break;
            try {
                createdFolders[cat] = await findOrCreateFolder(rootFolder.id, cat);
            } catch {
                // will attempt on-demand
            }
        }

        for (let i = 0; i < items.length; i++) {
            if (isCancelled()) break;
            const item = items[i];
            const category = item.category || 'Uncategorized';
            let targetParentId = rootFolder.id;
            try {
                let catFolder = createdFolders[category];
                if (!catFolder) {
                    catFolder = await findOrCreateFolder(rootFolder.id, category);
                    createdFolders[category] = catFolder;
                }
                targetParentId = catFolder.id;

                const subCategory = item.sub_category;
                if (shouldCreateSubFolder(category, subCategory)) {
                    const subPath = `${category}/${subCategory}`;
                    let subFolder = createdFolders[subPath];
                    if (!subFolder) {
                        subFolder = await findOrCreateFolder(catFolder.id, subCategory);
                        createdFolders[subPath] = subFolder;
                    }
                    targetParentId = subFolder.id;

                    const detailCategory = item.detail_category;
                    if (shouldCreateDetailFolder(category, subCategory, detailCategory)) {
                        const detailPath = `${subFolder.id}\u0000${detailCategory}`;
                        let detailFolder = createdFolders[detailPath];
                        if (!detailFolder) {
                            detailFolder = await findOrCreateFolder(subFolder.id, detailCategory);
                            createdFolders[detailPath] = detailFolder;
                        }
                        targetParentId = detailFolder.id;
                    }
                }

                const created = await createBookmark(targetParentId, item.title || 'Untitled', item.url);
                imported.push(created);
            } catch (err) {
                failed.push({ title: item.title, reason: err?.message || String(err) });
            }
            if (onProgress && (i % 25 === 0 || i === total - 1)) {
                onProgress({ current: i + 1, total });
            }
        }
    }

    return { rootFolder, importedCount: imported.length, failed };
}
