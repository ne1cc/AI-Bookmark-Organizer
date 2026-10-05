import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { generateNetscapeHTML, downloadBookmarks, sanitizeFilename, sanitizeAddDate, escapeHtml, sanitizeUrl } from './bookmarks_export'

// Folder and link names are HTML-escaped in the output; decode them so the
// assertions read as the folder names a user would actually see.
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"')

// Lists folder headings by name, so a test can assert a folder is absent
// rather than merely that some substring does not appear.
const folderNames = (html) =>
    [...html.matchAll(/<H3[^>]*>([^<]*)<\/H3>/g)].map(m => decode(m[1]))

const linkTitles = (html) =>
    [...html.matchAll(/<A HREF="[^"]*"[^>]*>([^<]*)<\/A>/g)].map(m => decode(m[1]))

describe('generateNetscapeHTML subfolder alignment with browser writes', () => {
    it('does not emit a General folder — those bookmarks sit directly under the category', () => {
        const html = generateNetscapeHTML([
            { title: 'Bloomberg', url: 'https://bloomberg.com', category: 'Finance & Crypto', sub_category: 'General' },
            { title: 'Benzinga', url: 'https://benzinga.com', category: 'Finance & Crypto', sub_category: 'General' }
        ])

        expect(folderNames(html)).toEqual(['Finance & Crypto'])
        expect(html).not.toContain('>General<')
        expect(linkTitles(html)).toEqual(['Bloomberg', 'Benzinga'])
    })

    it('treats every name shouldCreateSubFolder rejects as no subfolder', () => {
        const html = generateNetscapeHTML([
            { title: 'A', url: 'https://a.example.com', category: 'Tech', sub_category: 'General' },
            { title: 'B', url: 'https://b.example.com', category: 'Tech', sub_category: 'none' },
            { title: 'C', url: 'https://c.example.com', category: 'Tech', sub_category: 'Uncategorized' },
            { title: 'D', url: 'https://d.example.com', category: 'Tech', sub_category: '' },
            { title: 'E', url: 'https://e.example.com', category: 'Tech', sub_category: null },
            { title: 'F', url: 'https://f.example.com', category: 'Tech' },
            // A subcategory echoing its own parent is also not a real folder.
            { title: 'G', url: 'https://g.example.com', category: 'Tech', sub_category: 'tech' }
        ])

        expect(folderNames(html)).toEqual(['Tech'])
        expect(linkTitles(html)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    })

    it('still nests genuine subcategories', () => {
        const html = generateNetscapeHTML([
            { title: 'MDN', url: 'https://developer.mozilla.org', category: 'Tech', sub_category: 'Web Development' },
            { title: 'PyTorch', url: 'https://pytorch.org', category: 'Tech', sub_category: 'AI & Machine Learning' }
        ])

        expect(folderNames(html)).toEqual(['Tech', 'Web Development', 'AI & Machine Learning'])
        // Folder names stay HTML-escaped in the emitted markup.
        expect(html).toContain('AI &amp; Machine Learning')
    })

    it('mixes nested subcategories and category-root bookmarks in one category', () => {
        const html = generateNetscapeHTML([
            { title: 'MDN', url: 'https://developer.mozilla.org', category: 'Tech', sub_category: 'Web Development' },
            { title: 'Odd One', url: 'https://odd.example.com', category: 'Tech', sub_category: 'General' }
        ])

        expect(folderNames(html)).toEqual(['Tech', 'Web Development'])

        // The nested folder closes before the category-root link is written, so
        // the loose bookmark is a child of the category, not of Web Development.
        const subFolderEnd = html.indexOf('</DL><p>')
        expect(html.indexOf('Odd One')).toBeGreaterThan(subFolderEnd)
        expect(linkTitles(html)).toEqual(['MDN', 'Odd One'])
    })

    it('keeps identically named subcategories separate across categories', () => {
        const html = generateNetscapeHTML([
            { title: 'Design News', url: 'https://d.example.com', category: 'Design & Media', sub_category: 'News' },
            { title: 'Tech News', url: 'https://t.example.com', category: 'Tech', sub_category: 'News' }
        ])

        expect(folderNames(html).filter(n => n === 'News')).toHaveLength(2)
    })

    it('emits nested detail folders, keeps invalid details at the subcategory, and isolates same-named details by parent', () => {
        const html = generateNetscapeHTML([
            { title: 'React docs', url: 'https://react.dev', category: 'Tech', sub_category: 'Frontend', detail_category: 'React' },
            { title: 'Frontend overview', url: 'https://frontend.example', category: 'Tech', sub_category: 'Frontend', detail_category: 'General' },
            { title: 'React tools', url: 'https://tools.example', category: 'Tech', sub_category: 'Backend', detail_category: 'React' }
        ])

        expect(folderNames(html)).toEqual(['Tech', 'Frontend', 'React', 'Backend', 'React'])
        expect(html).not.toContain('>General<')
        expect(linkTitles(html)).toEqual(['React docs', 'Frontend overview', 'React tools'])

        const frontendStart = html.indexOf('>Frontend</H3>')
        const frontendDetailEnd = html.indexOf('\n            </DL><p>', frontendStart)
        const frontendEnd = html.indexOf('\n        </DL><p>', frontendDetailEnd)
        const frontendSection = html.slice(frontendStart, frontendEnd)
        expect(frontendSection).toContain('>React</H3>')
        expect(frontendSection).toContain('Frontend overview')
        expect(frontendSection.indexOf('Frontend overview')).toBeGreaterThan(frontendDetailEnd - frontendStart)

        const reactFolderOccurrences = html.match(/>React<\/H3>/g)
        expect(reactFolderOccurrences).toHaveLength(2)
    })

    it('leaves the flat chronological export untouched when items have no category', () => {
        const bookmarks = [
            { title: 'One', url: 'https://one.example.com', category: null, sub_category: null },
            { title: 'Two', url: 'https://two.example.com', category: null, sub_category: null }
        ]
        bookmarks.isFlat = true

        const html = generateNetscapeHTML(bookmarks)

        expect(folderNames(html)).toEqual([])
        expect(linkTitles(html)).toEqual(['One', 'Two'])
    })

    it('generates month-year tier folders for chronological bookmarks with categories', () => {
        const bookmarks = [
            { title: 'New Item', url: 'https://new.com', category: 'September 2026' },
            { title: 'Old Item', url: 'https://old.com', category: 'July 2024' }
        ]
        bookmarks.isFlat = true

        const html = generateNetscapeHTML(bookmarks)

        expect(folderNames(html)).toEqual(['September 2026', 'July 2024'])
        expect(linkTitles(html)).toEqual(['New Item', 'Old Item'])
    })
})

describe('generateNetscapeHTML grouping is prototype-safe', () => {
    it('exports a category and subcategory named after Object.prototype members', () => {
        // A proposed sub_category is any Title-Case string the model chose, so
        // "constructor" would read as already-present via the prototype chain,
        // skip its array initialisation and throw on push — losing the whole
        // export to the caller's catch.
        const html = generateNetscapeHTML([
            { title: 'A', url: 'https://a.example.com', category: 'Tech', sub_category: 'constructor' },
            { title: 'B', url: 'https://b.example.com', category: 'Tech', sub_category: 'toString' },
            { title: 'C', url: 'https://c.example.com', category: '__proto__', sub_category: 'Web Dev' }
        ])

        expect(folderNames(html)).toEqual(
            expect.arrayContaining(['Tech', 'constructor', 'toString', '__proto__', 'Web Dev'])
        )
        expect(linkTitles(html)).toEqual(['A', 'B', 'C'])
    })
})

describe('downloadBookmarks Save As', () => {
    const items = [{ title: 'A', url: 'https://a.example.com', category: 'Tech', sub_category: 'Web' }]
    let originalChrome
    let originalPicker

    const pickerReturning = (handleOrError) => {
        const write = vi.fn(async () => {})
        const close = vi.fn(async () => {})
        const picker = vi.fn(async () => {
            if (handleOrError instanceof Error) throw handleOrError
            return { name: handleOrError ?? 'chosen.html', createWritable: async () => ({ write, close }) }
        })
        window.showSaveFilePicker = picker
        return { picker, write, close }
    }

    beforeEach(() => {
        originalChrome = global.chrome
        originalPicker = window.showSaveFilePicker
        global.chrome = { downloads: { download: vi.fn() }, runtime: {} }
        URL.createObjectURL = vi.fn(() => 'blob:test')
    })

    afterEach(() => {
        global.chrome = originalChrome
        if (originalPicker) window.showSaveFilePicker = originalPicker
        else delete window.showSaveFilePicker
    })

    it('opens the browser Save As picker with the suggested name and writes the file there', async () => {
        const { picker, write, close } = pickerReturning('my-copy.html')

        const result = await downloadBookmarks(items, 'bookmarks_ai_alpha_2026-10-02.html')

        expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'bookmarks_ai_alpha_2026-10-02.html' }))
        expect(write).toHaveBeenCalledTimes(1)
        expect(write.mock.calls[0][0]).toContain('<DT><A HREF="https://a.example.com"')
        expect(close).toHaveBeenCalledTimes(1)
        expect(global.chrome.downloads.download).not.toHaveBeenCalled()
        expect(result).toEqual({ status: 'saved', method: 'picker', name: 'my-copy.html' })
    })

    it('does nothing further when the user cancels the picker', async () => {
        const { write } = pickerReturning(Object.assign(new Error('cancelled'), { name: 'AbortError' }))

        const result = await downloadBookmarks(items)

        expect(result).toEqual({ status: 'cancelled' })
        expect(write).not.toHaveBeenCalled()
        expect(global.chrome.downloads.download).not.toHaveBeenCalled()
    })

    it('falls back to chrome.downloads with saveAs when the picker is refused', async () => {
        pickerReturning(Object.assign(new Error('needs user gesture'), { name: 'SecurityError' }))

        const result = await downloadBookmarks(items, 'out.html')

        expect(global.chrome.downloads.download).toHaveBeenCalledWith(
            expect.objectContaining({ filename: 'out.html', saveAs: true }),
            expect.any(Function)
        )
        expect(result).toEqual({ status: 'started', method: 'downloads' })
    })

    it('uses chrome.downloads with saveAs when there is no picker (service worker)', async () => {
        delete window.showSaveFilePicker

        const result = await downloadBookmarks(items, 'out.html')

        expect(global.chrome.downloads.download).toHaveBeenCalledWith(
            expect.objectContaining({ filename: 'out.html', saveAs: true }),
            expect.any(Function)
        )
        expect(result).toEqual({ status: 'started', method: 'downloads' })
    })

    it('skips the picker when saveAs is switched off', async () => {
        const { picker } = pickerReturning('x.html')

        await downloadBookmarks(items, 'out.html', { saveAs: false })

        expect(picker).not.toHaveBeenCalled()
        expect(global.chrome.downloads.download).toHaveBeenCalledWith(
            expect.objectContaining({ saveAs: false }),
            expect.any(Function)
        )
    })
})

describe('bookmarks_export security hardening (SEC-01, SEC-07, SEC-08)', () => {
    it('escapes quotes and HTML tags across titles, categories, and attributes', () => {
        const payload = [
            {
                title: '"><script>alert(1)</script><a href="',
                url: 'https://example.com/safe',
                category: '"><img src=x onerror=alert(1)>',
                sub_category: '"><svg onload=alert(1)>',
                add_date: '1700000000" onclick="alert(1)'
            }
        ];
        const html = generateNetscapeHTML(payload);
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img src=x');
        expect(html).not.toContain('<svg onload');
        expect(html).not.toContain('onclick="alert(1)"');
        expect(html).toContain('&quot;&gt;&lt;script&gt;');
    });

    it('sanitizeFilename strips path traversal and invalid characters', () => {
        expect(sanitizeFilename('../../../evil.html')).toBe('evil.html');
        expect(sanitizeFilename('..\\..\\evil.html')).toBe('evil.html');
        expect(sanitizeFilename('bad:name*?.html')).toBe('bad_name__.html');
        expect(sanitizeFilename('../')).toBe('organized_bookmarks.html');
        expect(sanitizeFilename('')).toBe('organized_bookmarks.html');
    });

    it('sanitizeAddDate constrains timestamps strictly to non-negative integers', () => {
        expect(sanitizeAddDate(1700000000.85, 0)).toBe(1700000000);
        expect(sanitizeAddDate('1700000000', 0)).toBe(1700000000);
        expect(sanitizeAddDate(-500, 0)).toBe(0);
        expect(sanitizeAddDate('invalid', 0)).toBe(0);
        expect(sanitizeAddDate('1700000000" onclick="alert(1)', 123)).toBe(123);
    });

    it('escapeHtml preserves numeric zero and empty falsy values correctly', () => {
        expect(escapeHtml(0)).toBe('0');
        expect(escapeHtml('0')).toBe('0');
        expect(escapeHtml('')).toBe('');
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    it('sanitizeUrl supports valid browser schemes and rejects dangerous schemes', () => {
        expect(sanitizeUrl('https://example.com')).toBe('https://example.com');
        expect(sanitizeUrl('http://example.com')).toBe('http://example.com');
        expect(sanitizeUrl('chrome://bookmarks/')).toBe('chrome://bookmarks/');
        expect(sanitizeUrl('edge://settings/')).toBe('edge://settings/');
        expect(sanitizeUrl('about:blank')).toBe('about:blank');
        expect(sanitizeUrl('file:///path/to/doc.pdf')).toBe('file:///path/to/doc.pdf');
        expect(sanitizeUrl('javascript:alert(1)')).toBe('');
        expect(sanitizeUrl('data:text/html,bad')).toBe('');
        expect(sanitizeUrl('vbscript:msgbox(1)')).toBe('');
    });
});
