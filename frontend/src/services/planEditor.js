// Pure editing model for the folder plan: { categories: [{ name, sub_categories: [string] }] }.
// Every function returns { plan } or { error } and never mutates its input.
import { canonicalKey } from './subcategoryIdentity';
import { SINK_NAMES } from './subcategoryPredicates';

const copy = (plan) => ({
    ...plan,
    categories: plan.categories.map(category => ({ ...category, sub_categories: [...category.sub_categories] }))
});

const findCategory = (plan, name) => plan.categories.find(category => category.name === name);

// Returns an error string, or null when `name` is acceptable among `siblings`.
// `parent` is the category name when naming a subfolder.
export function checkName(name, siblings, parent = null) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return 'A name cannot be empty.';
    if (/[\\/]/.test(trimmed)) return 'A name cannot contain slashes.';
    if (parent !== null) {
        if (SINK_NAMES.has(trimmed.toLowerCase())) return `"${trimmed}" is reserved for bookmarks that fit nowhere.`;
        if (canonicalKey(trimmed) === canonicalKey(parent)) return 'A subfolder cannot be named like its category.';
    }
    const clash = siblings.find(sibling => canonicalKey(sibling) === canonicalKey(trimmed));
    if (clash !== undefined) return `"${clash}" already exists here.`;
    return null;
}

export function summarize(plan) {
    return {
        categories: plan.categories.length,
        subfolders: plan.categories.reduce((total, category) => total + category.sub_categories.length, 0)
    };
}

export function renameCategory(plan, name, to) {
    const category = findCategory(plan, name);
    if (!category) return { error: `Category "${name}" was not found.` };
    const error = checkName(to, plan.categories.filter(c => c !== category).map(c => c.name));
    if (error) return { error };
    // A subfolder that now echoes its renamed category would add no structure.
    if (category.sub_categories.some(sub => canonicalKey(sub) === canonicalKey(to.trim()))) {
        return { error: 'A subfolder in this category already has that name.' };
    }
    const next = copy(plan);
    findCategory(next, name).name = to.trim();
    return { plan: next };
}

export function renameSubfolder(plan, categoryName, name, to) {
    const category = findCategory(plan, categoryName);
    if (!category || !category.sub_categories.includes(name)) return { error: `Subfolder "${name}" was not found.` };
    const error = checkName(to, category.sub_categories.filter(sub => sub !== name), category.name);
    if (error) return { error };
    const next = copy(plan);
    const subs = findCategory(next, categoryName).sub_categories;
    subs[subs.indexOf(name)] = to.trim();
    return { plan: next };
}

export function addCategory(plan, name) {
    const error = checkName(name, plan.categories.map(c => c.name));
    if (error) return { error };
    const next = copy(plan);
    next.categories.push({ name: name.trim(), sub_categories: [] });
    return { plan: next };
}

export function addSubfolder(plan, categoryName, name) {
    const category = findCategory(plan, categoryName);
    if (!category) return { error: `Category "${categoryName}" was not found.` };
    const error = checkName(name, category.sub_categories, category.name);
    if (error) return { error };
    const next = copy(plan);
    findCategory(next, categoryName).sub_categories.push(name.trim());
    return { plan: next };
}

export function removeCategory(plan, name) {
    if (!findCategory(plan, name)) return { error: `Category "${name}" was not found.` };
    if (plan.categories.length === 1) return { error: 'A plan needs at least one category.' };
    const next = copy(plan);
    next.categories = next.categories.filter(category => category.name !== name);
    return { plan: next };
}

export function removeSubfolder(plan, categoryName, name) {
    const category = findCategory(plan, categoryName);
    if (!category || !category.sub_categories.includes(name)) return { error: `Subfolder "${name}" was not found.` };
    const next = copy(plan);
    const target = findCategory(next, categoryName);
    target.sub_categories = target.sub_categories.filter(sub => sub !== name);
    return { plan: next };
}

export function moveSubfolder(plan, fromCategory, name, toCategory) {
    const source = findCategory(plan, fromCategory);
    const destination = findCategory(plan, toCategory);
    if (!source || !source.sub_categories.includes(name)) return { error: `Subfolder "${name}" was not found.` };
    if (!destination) return { error: `Category "${toCategory}" was not found.` };
    if (source === destination) return { error: 'The subfolder is already in that category.' };
    const error = checkName(name, destination.sub_categories, destination.name);
    if (error) return { error };
    const next = copy(plan);
    const from = findCategory(next, fromCategory);
    from.sub_categories = from.sub_categories.filter(sub => sub !== name);
    findCategory(next, toCategory).sub_categories.push(name);
    return { plan: next };
}

// The source disappears; the target keeps its name.
export function mergeSubfolders(plan, source, target) {
    const sourceCategory = findCategory(plan, source.category);
    const targetCategory = findCategory(plan, target.category);
    if (!sourceCategory || !sourceCategory.sub_categories.includes(source.name)) return { error: `Subfolder "${source.name}" was not found.` };
    if (!targetCategory || !targetCategory.sub_categories.includes(target.name)) return { error: `Subfolder "${target.name}" was not found.` };
    if (source.category === target.category && source.name === target.name) return { error: 'Choose a different folder to merge into.' };
    return removeSubfolder(plan, source.category, source.name);
}

// The source's subfolders move into the target (names already there are dropped); the source disappears.
export function mergeCategories(plan, sourceName, targetName) {
    const source = findCategory(plan, sourceName);
    const target = findCategory(plan, targetName);
    if (!source) return { error: `Category "${sourceName}" was not found.` };
    if (!target) return { error: `Category "${targetName}" was not found.` };
    if (source === target) return { error: 'Choose a different category to merge into.' };
    const next = copy(plan);
    const into = findCategory(next, targetName);
    const known = new Set(into.sub_categories.map(canonicalKey));
    for (const sub of source.sub_categories) {
        if (known.has(canonicalKey(sub)) || canonicalKey(sub) === canonicalKey(into.name)) continue;
        known.add(canonicalKey(sub));
        into.sub_categories.push(sub);
    }
    next.categories = next.categories.filter(category => category.name !== sourceName);
    return { plan: next };
}

// The source becomes a subfolder of the target. Plans are two levels deep, so the source's own
// subfolders land beside it (names the target already has are dropped).
export function nestCategory(plan, sourceName, targetName) {
    const source = findCategory(plan, sourceName);
    const target = findCategory(plan, targetName);
    if (!source) return { error: `Category "${sourceName}" was not found.` };
    if (!target) return { error: `Category "${targetName}" was not found.` };
    if (source === target) return { error: 'Choose a different category to nest inside.' };
    const error = checkName(source.name, target.sub_categories, target.name);
    if (error) return { error };
    const next = copy(plan);
    const into = findCategory(next, targetName);
    const known = new Set([...into.sub_categories, into.name].map(canonicalKey));
    for (const sub of [source.name, ...source.sub_categories]) {
        if (known.has(canonicalKey(sub))) continue;
        known.add(canonicalKey(sub));
        into.sub_categories.push(sub);
    }
    next.categories = next.categories.filter(category => category.name !== sourceName);
    return { plan: next };
}

// The subfolder becomes an empty category at `index` in the category list.
export function promoteSubfolder(plan, categoryName, name, index) {
    const category = findCategory(plan, categoryName);
    if (!category || !category.sub_categories.includes(name)) return { error: `Subfolder "${name}" was not found.` };
    if (!Number.isInteger(index) || index < 0 || index > plan.categories.length) return { error: 'That position is outside the plan.' };
    const error = checkName(name, plan.categories.map(c => c.name));
    if (error) return { error };
    const next = copy(plan);
    const from = findCategory(next, categoryName);
    from.sub_categories = from.sub_categories.filter(sub => sub !== name);
    next.categories.splice(index, 0, { name, sub_categories: [] });
    return { plan: next };
}

// Folder order follows the array order, so reordering is a plain index move.
export function reorderCategory(plan, from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0
        || from >= plan.categories.length || to >= plan.categories.length) {
        return { error: 'That position is outside the plan.' };
    }
    const next = copy(plan);
    const [moved] = next.categories.splice(from, 1);
    next.categories.splice(to, 0, moved);
    return { plan: next };
}

export function reorderSubfolder(plan, categoryName, from, to) {
    const category = findCategory(plan, categoryName);
    if (!category) return { error: `Category "${categoryName}" was not found.` };
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0
        || from >= category.sub_categories.length || to >= category.sub_categories.length) {
        return { error: 'That position is outside the category.' };
    }
    const next = copy(plan);
    const subs = findCategory(next, categoryName).sub_categories;
    const [moved] = subs.splice(from, 1);
    subs.splice(to, 0, moved);
    return { plan: next };
}
