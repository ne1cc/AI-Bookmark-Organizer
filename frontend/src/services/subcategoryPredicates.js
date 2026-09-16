export function shouldCreateSubFolder(category, subCategory) {
    if (!subCategory) return false;
    const sub = subCategory.trim().toLowerCase();
    const cat = category.trim().toLowerCase();
    return sub !== '' && sub !== 'general' && sub !== 'none' && sub !== 'uncategorized' && sub !== cat;
}
