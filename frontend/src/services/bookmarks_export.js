import { calculateDateSpan } from '../utils/dates';
import { shouldCreateSubFolder } from './bookmarks';
import { shouldCreateDetailFolder } from './subcategoryIdentity';

// HTML escape function to prevent XSS
function escapeHtml(text) {
    if (!text) return '';
    if (typeof document !== 'undefined' && document.createElement) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Embed a favicon only when it is a pure base64 image data URL: the strict
// charset (no quotes, angle brackets or ampersands) guarantees the value
// cannot break out of the quoted attribute.
function iconAttribute(icon) {
    if (typeof icon === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/i.test(icon)) {
        return ` ICON="${icon}"`;
    }
    return '';
}

// URL sanitization - only allow http/https protocols
function sanitizeUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return escapeHtml(url);
        }
        return '';
    } catch {
        return '';
    }
}

export function generateNetscapeHTML(bookmarks, options = {}) {
    const now = Math.floor(Date.now() / 1000);
    const dateSpan = bookmarks?.stats?.dateSpan || bookmarks?.dateSpan || calculateDateSpan(bookmarks);
    let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
${dateSpan ? `     Date range: ${dateSpan}\n` : ''}     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

    const hasCategories = Array.isArray(bookmarks) && bookmarks.some(b => Boolean(b.category));
    const isFlat = Boolean(options?.isFlat) || Boolean(bookmarks?.isBare) || (!hasCategories && Boolean(bookmarks?.isFlat)) || (Array.isArray(bookmarks) && bookmarks.length > 0 && !hasCategories);

    if (isFlat) {
        bookmarks.forEach(item => {
            const safeTitle = escapeHtml(item.title);
            const safeUrl = sanitizeUrl(item.url);
            const itemAddDate = item.add_date || (item.dateAdded ? Math.floor(item.dateAdded / 1000) : now);
            if (safeUrl) {
                html += `    <DT><A HREF="${safeUrl}" ADD_DATE="${itemAddDate}"${iconAttribute(item.icon)}>${safeTitle}</A>\n`;
            }
        });
        html += `</DL><p>`;
        return html;
    }

    // Maps preserve insertion order and keep every level safe for arbitrary
    // model-proposed names, including Object.prototype members.
    const structured = new Map();

    bookmarks.forEach(b => {
        const cat = b.category || "Uncategorized";
        const sub = b.sub_category;

        if (!structured.has(cat)) structured.set(cat, { root: [], subcategories: new Map() });
        const content = structured.get(cat);

        // Mirror the browser-write path exactly: `shouldCreateSubFolder` rejects
        // "General", "None", "Uncategorized" and a subcategory echoing its own
        // parent. Treating those as real folders here is what produced a literal
        // "General" folder under every category on HTML import, while the same
        // run in browser mode filed them directly under the category.
        if (shouldCreateSubFolder(cat, sub)) {
            if (!content.subcategories.has(sub)) {
                content.subcategories.set(sub, { root: [], details: new Map() });
            }
            const subContent = content.subcategories.get(sub);
            if (shouldCreateDetailFolder(cat, sub, b.detail_category)) {
                if (!subContent.details.has(b.detail_category)) subContent.details.set(b.detail_category, []);
                subContent.details.get(b.detail_category).push(b);
            } else {
                subContent.root.push(b);
            }
        } else {
            content.root.push(b);
        }
    });

    for (const [category, content] of structured) {
        const safeCategory = escapeHtml(category);
        html += `    <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">${safeCategory}</H3>\n`;
        html += `    <DL><p>\n`;

        // Subcategories and their optional detail folders
        for (const [sub, subContent] of content.subcategories) {
            const safeSub = escapeHtml(sub);
            html += `        <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">${safeSub}</H3>\n`;
            html += `        <DL><p>\n`;

            for (const [detail, items] of subContent.details) {
                const safeDetail = escapeHtml(detail);
                html += `            <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">${safeDetail}</H3>\n`;
                html += `            <DL><p>\n`;
                items.forEach(item => {
                    const safeTitle = escapeHtml(item.title);
                    const safeUrl = sanitizeUrl(item.url);
                    const itemAddDate = item.add_date || (item.dateAdded ? Math.floor(item.dateAdded / 1000) : now);
                    if (safeUrl) {
                        html += `                <DT><A HREF="${safeUrl}" ADD_DATE="${itemAddDate}"${iconAttribute(item.icon)}>${safeTitle}</A>\n`;
                    }
                });
                html += `            </DL><p>\n`;
            }

            subContent.root.forEach(item => {
                const safeTitle = escapeHtml(item.title);
                const safeUrl = sanitizeUrl(item.url);
                const itemAddDate = item.add_date || (item.dateAdded ? Math.floor(item.dateAdded / 1000) : now);
                if (safeUrl) {
                    html += `            <DT><A HREF="${safeUrl}" ADD_DATE="${itemAddDate}"${iconAttribute(item.icon)}>${safeTitle}</A>\n`;
                }
            });

            html += `        </DL><p>\n`;
        }

        // Root items in category
        if (content.root.length > 0) {
            content.root.forEach(item => {
                const safeTitle = escapeHtml(item.title);
                const safeUrl = sanitizeUrl(item.url);
                const itemAddDate = item.add_date || (item.dateAdded ? Math.floor(item.dateAdded / 1000) : now);
                if (safeUrl) {
                    html += `        <DT><A HREF="${safeUrl}" ADD_DATE="${itemAddDate}"${iconAttribute(item.icon)}>${safeTitle}</A>\n`;
                }
            });
        }

        html += `    </DL><p>\n`;
    }

    html += `</DL><p>`;
    return html;
}

// Hands the file to the browser's download manager. With saveAs the manager is
// asked for a Save As dialog, but some Chromium builds save straight to the
// Downloads folder anyway, which is why a button click prefers the picker below.
function startBrowserDownload(html, filename, saveAs) {
    let url;
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        try {
            const blob = new Blob([html], { type: "text/html" });
            url = URL.createObjectURL(blob);
        } catch {
            url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
        }
    } else {
        url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    }

    if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
        chrome.downloads.download({ url, filename, saveAs }, () => {
            if (chrome.runtime?.lastError) console.warn('[Export] Download rejected:', chrome.runtime.lastError.message);
        });
    } else if (typeof document !== 'undefined' && document.createElement) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
    return { status: 'started', method: 'downloads' };
}

async function saveWithPicker(html, filename) {
    // Must be requested synchronously from the click that started the download.
    const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Bookmarks HTML', accept: { 'text/html': ['.html'] } }]
    });
    const writable = await handle.createWritable();
    await writable.write(html);
    await writable.close();
    return { status: 'saved', method: 'picker', name: handle.name };
}

/**
 * Saves an HTML file. A page with a user click always gets the browser's Save
 * As picker; the download manager is the fallback for contexts that cannot open
 * it (service worker, no click behind the call).
 * Resolves to `{ status: 'saved' | 'started' | 'cancelled', ... }`.
 */
export function saveHtmlFile(html, filename, { saveAs = true } = {}) {
    if (saveAs && typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
        return saveWithPicker(html, filename).catch((err) => {
            if (err?.name === 'AbortError') return { status: 'cancelled' };
            return startBrowserDownload(html, filename, saveAs);
        });
    }
    return Promise.resolve(startBrowserDownload(html, filename, saveAs));
}

export function downloadBookmarks(bookmarks, filename = "organized_bookmarks.html", options = {}) {
    const { saveAs = true } = options;
    const isFlat = Boolean(options?.isFlat || bookmarks?.isFlat || bookmarks?.isBare);
    const defaultName = bookmarks?.filename || (isFlat ? "chronological_bookmarks.html" : "organized_bookmarks.html");
    const actualFilename = (filename === "organized_bookmarks.html" && bookmarks?.filename) ? bookmarks.filename : (filename === "organized_bookmarks.html" ? defaultName : filename);
    return saveHtmlFile(generateNetscapeHTML(bookmarks, options), actualFilename, { saveAs });
}
