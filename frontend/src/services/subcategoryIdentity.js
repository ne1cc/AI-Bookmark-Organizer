// Shared identity for schema validation, classification and reconciliation.
// Independent batches vary casing, whitespace and trailing singular/plural s.
import { shouldCreateSubFolder } from './bookmarks';

const DETAIL_SINK_NAMES = new Set([
    'general',
    'other',
    'none',
    'uncategorized',
    'misc',
    'miscellaneous',
    'various',
    ''
]);

export function canonicalKey(name) {
    return name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/s$/, '');
}

/**
 * Returns whether a detail name can be written as a folder beneath a
 * category/subcategory pair.
 */
export function shouldCreateDetailFolder(category, subCategory, detailCategory) {
    if (typeof category !== 'string' || typeof subCategory !== 'string' || typeof detailCategory !== 'string') {
        return false;
    }

    const categoryName = category.trim();
    const subCategoryName = subCategory.trim();
    const detailName = detailCategory.trim();
    const categoryKey = categoryName.toLowerCase();
    const subCategoryKey = subCategoryName.toLowerCase();
    const detailKey = detailName.toLowerCase();

    if (!categoryName || !subCategoryName || !detailName) return false;
    if (!shouldCreateSubFolder(categoryName, subCategoryName)) return false;
    if (DETAIL_SINK_NAMES.has(detailKey)) return false;
    if (detailKey === categoryKey || detailKey === subCategoryKey) return false;
    if (detailName.includes('/') || detailName.includes('\\')) return false;

    return true;
}
