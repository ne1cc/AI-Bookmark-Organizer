/**
 * Utility functions for extracting bookmark timestamps, calculating date ranges,
 * formatting MECE month-year tiers, and standardizing output folder & file names.
 */

export const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

function parseTimestampValue(val) {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'number') {
        if (isNaN(val) || val <= 0) return 0;
        return val < 1e11 ? Math.floor(val * 1000) : Math.floor(val);
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed || trimmed === '0' || trimmed === 'NaN') return 0;
        if (/^\d+(\.\d+)?$/.test(trimmed)) {
            const num = Number(trimmed);
            if (isNaN(num) || num <= 0) return 0;
            return num < 1e11 ? Math.floor(num * 1000) : Math.floor(num);
        }
        const parsed = Date.parse(trimmed);
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 0;
}

// Normalizes Chrome API dateAdded (milliseconds), Netscape add_date (seconds), and ISO date strings to epoch milliseconds.
export function getBookmarkTimestamp(bookmark) {
    if (!bookmark || typeof bookmark !== 'object') return 0;

    const primaryKeys = ['dateAdded', 'date_added', 'date', 'add_date', 'ADD_DATE'];
    for (const key of primaryKeys) {
        if (bookmark[key] !== undefined && bookmark[key] !== null) {
            const ts = parseTimestampValue(bookmark[key]);
            if (ts > 0) return ts;
        }
    }

    const fallbackKeys = ['last_modified', 'LAST_MODIFIED', 'date_modified', 'modified', 'created', 'createdAt', 'time_added'];
    for (const key of fallbackKeys) {
        if (bookmark[key] !== undefined && bookmark[key] !== null) {
            const ts = parseTimestampValue(bookmark[key]);
            if (ts > 0) return ts;
        }
    }

    return 0;
}

/**
 * Calculates the formatted date range (oldest date to newest date) from an array of bookmarks.
 * Returns null if no valid timestamps exist.
 * Always returns `${oldestDate} – ${newestDate}`, even when both fall on the same day:
 * a lone date is indistinguishable from a run timestamp in the stats display.
 */
export function calculateDateSpan(bookmarks) {
    if (!bookmarks) return null;
    if (bookmarks.stats?.dateSpan) return bookmarks.stats.dateSpan;
    if (bookmarks.dateSpan) return bookmarks.dateSpan;

    const list = Array.isArray(bookmarks)
        ? bookmarks
        : (Array.isArray(bookmarks.bookmarks) ? bookmarks.bookmarks : null);

    if (!list || list.length === 0) return null;

    let minTime = Infinity;
    let maxTime = -Infinity;

    for (let i = 0; i < list.length; i++) {
        const t = getBookmarkTimestamp(list[i]);
        if (t > 0) {
            if (t < minTime) minTime = t;
            if (t > maxTime) maxTime = t;
        }
    }

    if (minTime === Infinity || maxTime === -Infinity) return null;

    const minDate = new Date(minTime).toLocaleDateString();
    const maxDate = new Date(maxTime).toLocaleDateString();
    return `${minDate} – ${maxDate}`;
}

/**
 * Maps a bookmark or timestamp to a MECE Month & Year tier string (e.g. "September 2026").
 * Any missing, negative, or invalid date maps to "Undated".
 */
export function getMonthYearBucket(bookmarkOrTimestamp) {
    const ts = (typeof bookmarkOrTimestamp === 'object' && bookmarkOrTimestamp !== null)
        ? getBookmarkTimestamp(bookmarkOrTimestamp)
        : Number(bookmarkOrTimestamp);

    if (!ts || isNaN(ts) || ts <= 0) {
        return 'Undated';
    }

    const d = new Date(ts);
    if (isNaN(d.getTime())) return 'Undated';

    const month = MONTH_NAMES[d.getMonth()];
    const year = d.getFullYear();
    return `${month} ${year}`;
}

/**
 * Sorts an array of Month & Year bucket names chronologically.
 * "Undated" is always placed at the end.
 * @param {string[]} bucketNames
 * @param {boolean} isDesc - true for newest first, false for oldest first
 */
export function sortMonthYearBuckets(bucketNames, isDesc = true) {
    return [...bucketNames].sort((a, b) => {
        if (a === 'Undated' && b === 'Undated') return 0;
        if (a === 'Undated') return 1;
        if (b === 'Undated') return -1;

        const [monthA, yearA] = a.split(' ');
        const [monthB, yearB] = b.split(' ');
        const yA = parseInt(yearA, 10);
        const yB = parseInt(yearB, 10);
        if (yA !== yB) {
            return isDesc ? yB - yA : yA - yB;
        }

        const mA = MONTH_NAMES.indexOf(monthA);
        const mB = MONTH_NAMES.indexOf(monthB);
        return isDesc ? mB - mA : mA - mB;
    });
}

/**
 * Generates standardized, MECE output folder names, export filenames, and UI labels.
 */
export function getStandardizedOutputLabel(options = {}) {
    const {
        flatDateSort = false,
        dateSortOrder = 'desc',
        schemaSortOrder = 'alpha',
        date = new Date()
    } = options;

    const isoDate = (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 10);

    if (flatDateSort) {
        const isDesc = dateSortOrder !== 'asc';
        const dirLabel = isDesc ? 'Newest First' : 'Oldest First';
        const fileKey = isDesc ? 'newest' : 'oldest';
        return {
            rootFolderTitle: `[Chronological - ${dirLabel}] Bookmarks-${isoDate}`,
            legacyFolderTitle: `Chronological Bookmarks-${isoDate}`,
            downloadFilename: `bookmarks_chronological_${fileKey}_${isoDate}.html`,
            displayLabel: `Chronological (${dirLabel})`,
            tierLabel: 'Month & Year',
            badge: dirLabel
        };
    }

    const schemaMap = {
        'alpha': { titleKey: 'Alphabetical', fileKey: 'alpha', badge: 'A–Z' },
        'date-desc': { titleKey: 'Newest First', fileKey: 'newest', badge: 'Newest' },
        'date-asc': { titleKey: 'Oldest First', fileKey: 'oldest', badge: 'Oldest' },
        'domain': { titleKey: 'Domain A–Z', fileKey: 'domain', badge: 'Domain' }
    };

    const schemaInfo = schemaMap[schemaSortOrder] || schemaMap['alpha'];

    return {
        rootFolderTitle: `[AI Categorized - ${schemaInfo.titleKey}] Bookmarks-${isoDate}`,
        legacyFolderTitle: `AI Organized Bookmarks-${isoDate}`,
        downloadFilename: `bookmarks_ai_${schemaInfo.fileKey}_${isoDate}.html`,
        displayLabel: `AI Categorized (${schemaInfo.titleKey})`,
        tierLabel: 'Categories & Subcategories',
        badge: schemaInfo.badge
    };
}
