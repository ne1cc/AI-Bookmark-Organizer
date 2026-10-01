import { getBookmarkTimestamp } from '../utils/dates';

// Normalizes and extracts hostname/domain from bookmark URL
export function getBookmarkDomain(bookmark) {
    if (!bookmark || !bookmark.url) return '';
    try {
        const hostname = new URL(bookmark.url).hostname.toLowerCase();
        return hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

const ALPHA_ORDERS = ['alpha-asc', 'alpha-desc', 'a-z', 'z-a', 'alpha'];

export const isAlphaOrder = (order) => ALPHA_ORDERS.includes(order);
export const isAlphaDescOrder = (order) => order === 'alpha-desc' || order === 'z-a';

const byKey = (key) => (a, b) => (a[key] ?? 0) - (b[key] ?? 0);
const compareTitle = (a, b) => (a.title || '').localeCompare(b.title || '');

// Flat alphabetical sort: falls back to url for untitled bookmarks, ignores
// case, orders digits numerically, and always ties by original order
// (ascending, even when the sort itself is descending).
export const compareFlatAlpha = (desc) => (a, b) => {
    const titleA = (a.title || a.url || '').trim();
    const titleB = (b.title || b.url || '').trim();
    const diff = titleA.localeCompare(titleB, undefined, { sensitivity: 'base', numeric: true });
    if (diff !== 0) return desc ? -diff : diff;
    return byKey('_origIndex')(a, b);
};

// Dated bookmarks sort before undated ones. Equal timestamps (common with
// second-precision Netscape add_date on batch imports) fall back to `tieKey`
// order, reversed when `desc`, a closer proxy for true add order than title.
// Undated bookmarks fall back to `missingFallback`.
export const compareDates = ({ desc, tieKey, missingFallback }) => (a, b) => {
    const timeA = getBookmarkTimestamp(a);
    const timeB = getBookmarkTimestamp(b);
    if (timeA > 0 && timeB > 0) {
        if (timeA !== timeB) return desc ? timeB - timeA : timeA - timeB;
        const tieDiff = byKey(tieKey)(a, b);
        return desc ? -tieDiff : tieDiff;
    }
    if (timeA > 0) return -1; // Valid timestamp comes before missing timestamp
    if (timeB > 0) return 1;  // Missing timestamp goes to bottom
    return missingFallback(a, b);
};

export function sortFlat(results, order) {
    if (isAlphaOrder(order)) {
        return results.sort(compareFlatAlpha(isAlphaDescOrder(order)));
    }
    return results.sort(compareDates({
        desc: order !== 'asc', // default 'desc' (newest first)
        tieKey: '_origIndex',
        missingFallback: byKey('_origIndex')
    }));
}

const contentComparator = (schemaSortOrder) => {
    switch (schemaSortOrder) {
        case 'date-desc':
            return compareDates({ desc: true, tieKey: '_detailRunOrdinal', missingFallback: compareTitle });
        case 'date-asc':
            return compareDates({ desc: false, tieKey: '_detailRunOrdinal', missingFallback: compareTitle });
        case 'domain':
            return (a, b) => getBookmarkDomain(a).localeCompare(getBookmarkDomain(b)) || compareTitle(a, b);
        case 'alpha':
        default:
            return compareTitle;
    }
};

// Creation order determines display order in the browser, so this controls the
// order of folders and of bookmarks inside them. Selected category order
// applies even when content sorting is off ('none' / unset).
export function sortWithinFolders(results, { categoryRank, schemaSortOrder }) {
    const sortContents = schemaSortOrder && schemaSortOrder !== 'none';
    const compareContents = sortContents ? contentComparator(schemaSortOrder) : () => 0;
    return results.sort((a, b) => {
        const catDiff = (categoryRank.get(a.category) ?? categoryRank.size)
            - (categoryRank.get(b.category) ?? categoryRank.size);
        if (catDiff !== 0) return catDiff;
        const subDiff = (a.sub_category || '').localeCompare(b.sub_category || '');
        if (subDiff !== 0) return subDiff;
        const detailDiff = (a.detail_category || '').localeCompare(b.detail_category || '');
        if (detailDiff !== 0) return detailDiff;
        return compareContents(a, b);
    });
}
