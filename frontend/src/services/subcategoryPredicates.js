export const SINK_NAMES = new Set([
    'general',
    'other',
    'none',
    'uncategorized',
    'misc',
    'miscellaneous',
    'various',
    ''
]);

export function shouldCreateSubFolder(category, subCategory) {
    if (!subCategory) return false;
    const sub = subCategory.trim().toLowerCase();
    const cat = category.trim().toLowerCase();
    return !SINK_NAMES.has(sub) && sub !== cat;
}
