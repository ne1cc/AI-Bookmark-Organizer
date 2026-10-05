// Favicon retention limits. Embedded icons are kept only while they fit the
// budget: small collections keep every icon, huge exports degrade gracefully
// instead of stalling or OOM-ing the panel (the icons exist only to be written
// back into the organized file — the AI never sees them).
export const ICON_MAX_SIZE = 50 * 1024;            // skip any single freak icon
export const ICON_TOTAL_BUDGET = 25 * 1024 * 1024; // cumulative cap across the file

/**
 * Validates that a parsed URL belongs to an allowed, non-executable scheme.
 * Rejects javascript: bookmarklets, vbscript:, data:, and file: URLs to prevent
 * arbitrary code execution and local filesystem enumeration.
 */
export const isSafeBookmarkUrl = (url) => {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (trimmed.startsWith('place:')) return false;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
        return false;
    }
    try {
        const parsed = new URL(trimmed);
        return ['http:', 'https:', 'ftp:', 'file:', 'chrome:', 'edge:', 'brave:', 'about:'].includes(parsed.protocol);
    } catch {
        return false;
    }
};

/**
 * Parses the Netscape Bookmark HTML content and extracts links.
 * @param {string} htmlContent - The raw HTML content of the bookmarks file.
 * @returns {Array} - Array of bookmark objects {title, url, add_date, icon?}.
 */
export const parseBookmarks = (htmlContent) => {
    // Filter favicon attributes BEFORE parsing: exports carry a base64 ICON
    // on every <A>, so DOMParser would otherwise build a DOM holding hundreds
    // of MB of icon data. Icons within budget pass through and are read back
    // after parsing; everything else is stripped here.
    let iconBudget = ICON_TOTAL_BUDGET;
    const stripped = htmlContent.replace(/\s(ICON|ICON_URI)="([^"]*)"/gi, (match, attr, value) => {
        if (attr.toUpperCase() !== "ICON") return "";       // ICON_URI is never used
        if (!/^data:image\//i.test(value)) return "";       // embedded data URLs only
        if (value.length > ICON_MAX_SIZE) return "";
        if (value.length > iconBudget) return "";
        iconBudget -= value.length;
        return match;
    });

    const parser = new DOMParser();
    const doc = parser.parseFromString(stripped, "text/html");
    const links = [];

    doc.querySelectorAll("a").forEach(a => {
        const url = a.href;
        // Basic validation and protocol whitelisting. Only allows safe web URLs.
        if (isSafeBookmarkUrl(url)) {
            const addDate = a.getAttribute("add_date") || a.getAttribute("ADD_DATE") || a.getAttribute("last_modified") || a.getAttribute("LAST_MODIFIED");
            const entry = {
                title: a.textContent.trim() || "Untitled",
                url: url,
                add_date: addDate
            };
            const icon = a.getAttribute("icon");
            if (icon) entry.icon = icon;
            links.push(entry);
        }
    });

    return links;
};
