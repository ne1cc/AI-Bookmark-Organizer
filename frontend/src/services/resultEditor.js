// Pure editing model for the finished folder structure. It works on "records":
// bookmarks ({ category, sub_category, detail_category, ... }) in the worker, or
// grouped rows ({ category, sub_category, detail_category, count }) in the panel.
// Both run the same operations, so the panel's counts always match the worker's result.
// Functions never mutate their input.
import { canonicalKey, shouldCreateDetailFolder } from './subcategoryIdentity';
import { shouldCreateSubFolder } from './subcategoryPredicates';
import { checkName } from './planEditor';

const SINK = 'General';

const weight = (record) => (Number.isFinite(record.count) ? record.count : 1);
const startsWith = (path, prefix) => path.length >= prefix.length && prefix.every((name, i) => path[i] === name);

// [category], [category, sub] or [category, sub, detail]: the folders a record is written into.
export function recordPath(record) {
    const { category, sub_category: sub, detail_category: detail } = record;
    if (!shouldCreateSubFolder(category, sub)) return [category];
    if (!shouldCreateDetailFolder(category, sub, detail)) return [category, sub];
    return [category, sub, detail];
}

// One row per distinct folder path, with how many bookmarks it holds directly.
export function buildRows(items) {
    const rows = new Map();
    for (const item of items) {
        const path = recordPath(item);
        const key = JSON.stringify(path);
        if (!rows.has(key)) {
            rows.set(key, { category: path[0], sub_category: path[1] ?? SINK, detail_category: path[2] ?? null, count: 0 });
        }
        rows.get(key).count += weight(item);
    }
    return [...rows.values()];
}

// Nested folders sorted by name: { name, path, count (all inside), direct (filed straight into it), children }.
export function buildTree(records) {
    const top = new Map();
    for (const record of records) {
        const path = recordPath(record);
        let level = top;
        let node = null;
        path.forEach((name, depth) => {
            if (!level.has(name)) level.set(name, { name, path: path.slice(0, depth + 1), count: 0, direct: 0, children: new Map() });
            node = level.get(name);
            node.count += weight(record);
            level = node.children;
        });
        node.direct += weight(record);
    }
    const flatten = (map) => [...map.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(node => ({ ...node, children: flatten(node.children) }));
    return flatten(top);
}

// Third-level folder counts for the run summary, recomputed after the user's edits.
export function detailStats(records) {
    const folders = new Set();
    const parents = new Set();
    for (const record of records) {
        const path = recordPath(record);
        if (path.length !== 3) continue;
        folders.add(JSON.stringify(path));
        parents.add(JSON.stringify(path.slice(0, 2)));
    }
    return { detailFolders: folders.size, detailedSubcategories: parents.size };
}

const within = (records, path) => records.filter(record => startsWith(recordPath(record), path));

// Distinct folder names directly under `parentPath`, optionally leaving one out.
function siblingNames(records, parentPath, leaveOut = null) {
    const names = new Set();
    for (const record of records) {
        const path = recordPath(record);
        if (path.length > parentPath.length && startsWith(path, parentPath)) names.add(path[parentPath.length]);
    }
    if (leaveOut !== null) names.delete(leaveOut);
    return [...names];
}

const missing = (path) => ({ error: `The folder "${path.join(' / ')}" no longer exists.` });

function rename(records, { path, to }) {
    if (!Array.isArray(path) || path.length === 0 || within(records, path).length === 0) return missing(path || []);
    const depth = path.length;
    const name = path[depth - 1];
    const error = checkName(to, siblingNames(records, path.slice(0, -1), name), depth === 1 ? null : path[depth - 2]);
    if (error) return { error };
    if (depth === 3 && canonicalKey(to) === canonicalKey(path[0])) return { error: 'A folder cannot be named like its category.' };
    const trimmed = to.trim();
    return {
        records: records.map(record => {
            if (!startsWith(recordPath(record), path)) return record;
            if (depth === 1) return { ...record, category: trimmed };
            if (depth === 2) return { ...record, sub_category: trimmed };
            return { ...record, detail_category: trimmed };
        })
    };
}

function remove(records, { path }) {
    if (!Array.isArray(path) || path.length === 0 || within(records, path).length === 0) return missing(path || []);
    if (path.length === 1) return { error: 'Remove a category by merging it into another one.' };
    return {
        records: records.map(record => {
            if (!startsWith(recordPath(record), path)) return record;
            if (path.length === 2) return { ...record, sub_category: SINK, detail_category: null };
            return { ...record, detail_category: null };
        })
    };
}

function move(records, { path, to }) {
    if (!Array.isArray(path) || within(records, path).length === 0) return missing(path || []);
    if (path.length === 1) return { error: 'Categories cannot be moved.' };
    if (!Array.isArray(to) || to.length !== path.length - 1) return { error: 'Choose where to move the folder.' };
    if (within(records, to).length === 0) return missing(to);
    if (to.every((name, i) => name === path[i])) return { error: 'The folder is already there.' };
    const name = path[path.length - 1];
    if (siblingNames(records, to).some(sibling => canonicalKey(sibling) === canonicalKey(name))) {
        return { error: `"${name}" already exists there.` };
    }
    if (path.length === 3 && to.some(parent => canonicalKey(parent) === canonicalKey(name))) {
        return { error: 'A folder cannot be named like its parent.' };
    }
    return {
        records: records.map(record => {
            if (!startsWith(recordPath(record), path)) return record;
            return path.length === 2
                ? { ...record, category: to[0] }
                : { ...record, category: to[0], sub_category: to[1] };
        })
    };
}

// Spellings already present under the destination win when moved bookmarks join it.
function merge(records, { path, to }) {
    if (!Array.isArray(path) || within(records, path).length === 0) return missing(path || []);
    if (!Array.isArray(to) || to.length !== path.length) return { error: 'Choose a folder at the same level to merge into.' };
    if (within(records, to).length === 0) return missing(to);
    if (to.every((name, i) => name === path[i])) return { error: 'Choose a different folder to merge into.' };

    const subSpelling = new Map();
    const detailSpelling = new Map();
    for (const record of within(records, [to[0]])) {
        const existing = recordPath(record);
        if (path.length === 1 && existing.length >= 2) subSpelling.set(canonicalKey(existing[1]), existing[1]);
        if (path.length <= 2 && existing.length === 3 && (path.length === 1 || existing[1] === to[1])) {
            detailSpelling.set(`${canonicalKey(existing[1])}\u0000${canonicalKey(existing[2])}`, existing[2]);
        }
    }

    return {
        records: records.map(record => {
            const original = recordPath(record);
            if (!startsWith(original, path)) return record;
            const next = { ...record, category: to[0] };
            if (path.length >= 2) next.sub_category = to[1];
            if (path.length === 3) next.detail_category = to[2];
            if (path.length === 1 && original.length >= 2 && subSpelling.has(canonicalKey(original[1]))) {
                next.sub_category = subSpelling.get(canonicalKey(original[1]));
            }
            if (path.length <= 2 && original.length === 3) {
                const sub = path.length === 1 ? next.sub_category : to[1];
                const found = detailSpelling.get(`${canonicalKey(sub)}\u0000${canonicalKey(original[2])}`);
                if (found !== undefined) next.detail_category = found;
            }
            return next;
        })
    };
}

const OPERATIONS = { rename, delete: remove, move, merge };

// ops: [{ op: 'rename' | 'delete' | 'move' | 'merge', path: [...], to?: ... }]
// Returns { records } with every op applied in order, or { error } with none applied.
export function applyOps(records, ops) {
    let current = records.map(record => ({ ...record }));
    for (const op of Array.isArray(ops) ? ops : []) {
        const apply = OPERATIONS[op?.op];
        if (!apply) return { error: `Unknown edit "${op?.op}".` };
        const result = apply(current, op);
        if (result.error) return { error: result.error };
        current = result.records;
    }
    return { records: current };
}
