import { describe, it, expect } from 'vitest'
import {
    getBookmarkTimestamp,
    calculateDateSpan,
    getMonthYearBucket,
    sortMonthYearBuckets,
    getStandardizedOutputLabel
} from './dates'

describe('getBookmarkTimestamp', () => {
    describe('edge cases and invalid inputs', () => {
        it('returns 0 for null or undefined', () => {
            expect(getBookmarkTimestamp(null)).toBe(0)
            expect(getBookmarkTimestamp(undefined)).toBe(0)
        })

        it('returns 0 for non-object primitives', () => {
            expect(getBookmarkTimestamp(0)).toBe(0)
            expect(getBookmarkTimestamp('invalid')).toBe(0)
            expect(getBookmarkTimestamp(true)).toBe(0)
        })

        it('returns 0 for empty object or object without date properties', () => {
            expect(getBookmarkTimestamp({})).toBe(0)
            expect(getBookmarkTimestamp({ title: 'Google', url: 'https://google.com' })).toBe(0)
        })

        it('returns 0 for zero or negative values', () => {
            expect(getBookmarkTimestamp({ dateAdded: 0 })).toBe(0)
            expect(getBookmarkTimestamp({ dateAdded: -1000 })).toBe(0)
            expect(getBookmarkTimestamp({ dateAdded: '0' })).toBe(0)
            expect(getBookmarkTimestamp({ add_date: 0 })).toBe(0)
            expect(getBookmarkTimestamp({ add_date: '0' })).toBe(0)
            expect(getBookmarkTimestamp({ ADD_DATE: '0' })).toBe(0)
        })

        it('returns 0 for unparseable strings', () => {
            expect(getBookmarkTimestamp({ dateAdded: 'not-a-date' })).toBe(0)
            expect(getBookmarkTimestamp({ date: 'xyz-invalid' })).toBe(0)
            expect(getBookmarkTimestamp({ add_date: 'garbage' })).toBe(0)
            expect(getBookmarkTimestamp({ ADD_DATE: 'NaN' })).toBe(0)
        })

        it('returns 0 for NaN, null, or undefined date property values', () => {
            expect(getBookmarkTimestamp({ dateAdded: NaN })).toBe(0)
            expect(getBookmarkTimestamp({ dateAdded: null })).toBe(0)
            expect(getBookmarkTimestamp({ dateAdded: undefined })).toBe(0)
            expect(getBookmarkTimestamp({ add_date: NaN })).toBe(0)
            expect(getBookmarkTimestamp({ add_date: null })).toBe(0)
        })
    })

    describe('Chrome API dateAdded format', () => {
        it('parses numeric epoch milliseconds (>= 1e11)', () => {
            const ms = 1609459200000 // 2021-01-01T00:00:00.000Z
            expect(getBookmarkTimestamp({ dateAdded: ms })).toBe(ms)
        })

        it('converts numeric epoch seconds (< 1e11) to milliseconds', () => {
            const sec = 1609459200
            expect(getBookmarkTimestamp({ dateAdded: sec })).toBe(sec * 1000)
        })

        it('parses numeric strings in milliseconds', () => {
            expect(getBookmarkTimestamp({ dateAdded: '1609459200000' })).toBe(1609459200000)
        })

        it('parses numeric strings in seconds (< 1e11) to milliseconds', () => {
            expect(getBookmarkTimestamp({ dateAdded: '1609459200' })).toBe(1609459200000)
        })

        it('parses ISO 8601 date strings', () => {
            const iso = '2021-01-01T00:00:00.000Z'
            expect(getBookmarkTimestamp({ dateAdded: iso })).toBe(1609459200000)
        })

        it('falls back to date_added property name', () => {
            expect(getBookmarkTimestamp({ date_added: 1609459200000 })).toBe(1609459200000)
        })

        it('falls back to date property name', () => {
            expect(getBookmarkTimestamp({ date: 1609459200000 })).toBe(1609459200000)
        })
    })

    describe('Netscape HTML add_date format', () => {
        it('parses numeric epoch seconds and converts to milliseconds', () => {
            expect(getBookmarkTimestamp({ add_date: 1609459200 })).toBe(1609459200000)
        })

        it('parses string epoch seconds and converts to milliseconds', () => {
            expect(getBookmarkTimestamp({ add_date: '1609459200' })).toBe(1609459200000)
        })

        it('handles numeric milliseconds in add_date', () => {
            expect(getBookmarkTimestamp({ add_date: 1609459200000 })).toBe(1609459200000)
        })

        it('handles uppercase ADD_DATE property', () => {
            expect(getBookmarkTimestamp({ ADD_DATE: '1609459200' })).toBe(1609459200000)
        })

        it('parses ISO date strings in add_date', () => {
            expect(getBookmarkTimestamp({ add_date: '2021-01-01T00:00:00.000Z' })).toBe(1609459200000)
        })
    })

    describe('precedence order', () => {
        it('prefers dateAdded over add_date when both are present and valid', () => {
            const bookmark = {
                dateAdded: 1609459200000, // 2021
                add_date: '1500000000'    // 2017
            }
            expect(getBookmarkTimestamp(bookmark)).toBe(1609459200000)
        })

        it('falls back to add_date when dateAdded is missing or zero', () => {
            expect(getBookmarkTimestamp({ dateAdded: 0, add_date: '1500000000' })).toBe(1500000000000)
            expect(getBookmarkTimestamp({ add_date: '1500000000' })).toBe(1500000000000)
        })
    })
})

describe('calculateDateSpan', () => {
    describe('falsy, empty, and undated inputs', () => {
        it('returns null for null or undefined', () => {
            expect(calculateDateSpan(null)).toBeNull()
            expect(calculateDateSpan(undefined)).toBeNull()
        })

        it('returns null for non-array/empty object', () => {
            expect(calculateDateSpan({})).toBeNull()
            expect(calculateDateSpan([])).toBeNull()
            expect(calculateDateSpan({ bookmarks: [] })).toBeNull()
            expect(calculateDateSpan({ bookmarks: null })).toBeNull()
        })

        it('returns null when all bookmarks lack valid dates', () => {
            const list = [
                { title: 'A', url: 'https://a.com' },
                { title: 'B', url: 'https://b.com', dateAdded: 0 },
                { title: 'C', url: 'https://c.com', add_date: 'invalid' }
            ]
            expect(calculateDateSpan(list)).toBeNull()
            expect(calculateDateSpan({ bookmarks: list })).toBeNull()
        })
    })

    describe('cached dateSpan passthrough', () => {
        it('returns bookmarks.stats.dateSpan if already present', () => {
            const obj = {
                stats: { dateSpan: '1/1/2021 – 12/31/2023' },
                bookmarks: [{ title: 'A', dateAdded: 1000 }]
            }
            expect(calculateDateSpan(obj)).toBe('1/1/2021 – 12/31/2023')
        })

        it('returns bookmarks.dateSpan if already present', () => {
            const obj = {
                dateSpan: '5/1/2020 – 6/1/2020',
                bookmarks: [{ title: 'A', dateAdded: 1000 }]
            }
            expect(calculateDateSpan(obj)).toBe('5/1/2020 – 6/1/2020')
        })
    })

    describe('range calculation from bookmark arrays', () => {
        it('formats single bookmark as oldest – newest on the same date', () => {
            const timestamp = 1609459200000 // 2021-01-01
            const expectedDate = new Date(timestamp).toLocaleDateString()
            const list = [{ title: 'Single', dateAdded: timestamp }]
            expect(calculateDateSpan(list)).toBe(`${expectedDate} – ${expectedDate}`)
        })

        it('formats same-day bookmarks as full date range', () => {
            const list = [
                { title: 'Morning', dateAdded: 1609459200000 },
                { title: 'Afternoon', dateAdded: 1609470000000 }
            ]
            const expectedDate = new Date(1609459200000).toLocaleDateString()
            expect(calculateDateSpan(list)).toBe(`${expectedDate} – ${expectedDate}`)
        })

        it('correctly determines min and max regardless of array ordering', () => {
            const bookmarks = [
                { title: 'Middle', dateAdded: 1600000000000 }, // 2020-09-13
                { title: 'Oldest', dateAdded: 1500000000000 }, // 2017-07-14
                { title: 'Newest', dateAdded: 1700000000000 }  // 2023-11-14
            ]
            const oldest = new Date(1500000000000).toLocaleDateString()
            const newest = new Date(1700000000000).toLocaleDateString()
            expect(calculateDateSpan(bookmarks)).toBe(`${oldest} – ${newest}`)
        })

        it('ignores undated bookmarks mixed with dated bookmarks', () => {
            const bookmarks = [
                { title: 'No Date 1', url: 'https://1.com' },
                { title: 'Oldest', dateAdded: 1500000000000 },
                { title: 'No Date 2', add_date: '0' },
                { title: 'Newest', dateAdded: 1700000000000 },
                { title: 'Invalid', dateAdded: 'invalid' }
            ]
            const oldest = new Date(1500000000000).toLocaleDateString()
            const newest = new Date(1700000000000).toLocaleDateString()
            expect(calculateDateSpan(bookmarks)).toBe(`${oldest} – ${newest}`)
        })

        it('works when input is an object with a bookmarks array property', () => {
            const input = {
                bookmarks: [
                    { title: 'A', dateAdded: 1500000000000 },
                    { title: 'B', dateAdded: 1700000000000 }
                ]
            }
            const oldest = new Date(1500000000000).toLocaleDateString()
            const newest = new Date(1700000000000).toLocaleDateString()
            expect(calculateDateSpan(input)).toBe(`${oldest} – ${newest}`)
        })

        it('handles large collections efficiently without recursion or stack overflow', () => {
            const count = 50000
            const baseSec = 1500000000
            const largeList = Array.from({ length: count }, (_, i) => ({
                title: `Bookmark ${i}`,
                url: `https://example.com/${i}`,
                add_date: `${baseSec + i}`
            }))
            const span = calculateDateSpan(largeList)
            const oldest = new Date(baseSec * 1000).toLocaleDateString()
            const newest = new Date((baseSec + count - 1) * 1000).toLocaleDateString()
            expect(span).toBe(`${oldest} – ${newest}`)
        })
    })
})

describe('getMonthYearBucket', () => {
    it('returns "Undated" for invalid, missing, or zero timestamps', () => {
        expect(getMonthYearBucket(null)).toBe('Undated')
        expect(getMonthYearBucket(0)).toBe('Undated')
        expect(getMonthYearBucket(-100)).toBe('Undated')
        expect(getMonthYearBucket({})).toBe('Undated')
        expect(getMonthYearBucket({ title: 'No Date' })).toBe('Undated')
    })

    it('returns Month and Year format for valid bookmark timestamp', () => {
        const d = new Date(2023, 8, 15) // Sept 15, 2023
        expect(getMonthYearBucket(d.getTime())).toBe('September 2023')
        expect(getMonthYearBucket({ dateAdded: d.getTime() })).toBe('September 2023')
    })
})

describe('sortMonthYearBuckets', () => {
    const sample = ['January 2022', 'September 2023', 'August 2023', 'Undated', 'December 2021']

    it('sorts newest to oldest with Undated at the end', () => {
        const sorted = sortMonthYearBuckets(sample, true)
        expect(sorted).toEqual([
            'September 2023',
            'August 2023',
            'January 2022',
            'December 2021',
            'Undated'
        ])
    })

    it('sorts oldest to newest with Undated at the end', () => {
        const sorted = sortMonthYearBuckets(sample, false)
        expect(sorted).toEqual([
            'December 2021',
            'January 2022',
            'August 2023',
            'September 2023',
            'Undated'
        ])
    })
})

describe('getStandardizedOutputLabel', () => {
    const fixedDate = new Date('2026-09-14T12:00:00Z')

    it('generates standardized labels for chronological newest first', () => {
        const label = getStandardizedOutputLabel({
            flatDateSort: true,
            dateSortOrder: 'desc',
            date: fixedDate
        })
        expect(label.rootFolderTitle).toBe('[Chronological - Newest First] Bookmarks-2026-09-14')
        expect(label.downloadFilename).toBe('bookmarks_chronological_newest_2026-09-14.html')
        expect(label.displayLabel).toBe('Chronological (Newest First)')
        expect(label.tierLabel).toBe('Month & Year')
    })

    it('generates standardized labels for chronological oldest first', () => {
        const label = getStandardizedOutputLabel({
            flatDateSort: true,
            dateSortOrder: 'asc',
            date: fixedDate
        })
        expect(label.rootFolderTitle).toBe('[Chronological - Oldest First] Bookmarks-2026-09-14')
        expect(label.downloadFilename).toBe('bookmarks_chronological_oldest_2026-09-14.html')
        expect(label.displayLabel).toBe('Chronological (Oldest First)')
    })

    it('generates standardized labels for AI categorized modes', () => {
        const labelAlpha = getStandardizedOutputLabel({
            flatDateSort: false,
            schemaSortOrder: 'alpha',
            date: fixedDate
        })
        expect(labelAlpha.rootFolderTitle).toBe('[AI Categorized - Alphabetical] Bookmarks-2026-09-14')
        expect(labelAlpha.downloadFilename).toBe('bookmarks_ai_alpha_2026-09-14.html')

        const labelDomain = getStandardizedOutputLabel({
            flatDateSort: false,
            schemaSortOrder: 'domain',
            date: fixedDate
        })
        expect(labelDomain.rootFolderTitle).toBe('[AI Categorized - Domain A–Z] Bookmarks-2026-09-14')
        expect(labelDomain.downloadFilename).toBe('bookmarks_ai_domain_2026-09-14.html')
    })
})
