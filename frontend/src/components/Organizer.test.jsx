import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import Organizer from './Organizer'
import { OrganizerService } from '../services/organizer'
import * as inputService from '../services/input_bookmarks'
import * as bookmarksExport from '../services/bookmarks_export'

vi.mock('../services/organizer', () => {
    return {
        OrganizerService: vi.fn(),
        DEFAULT_CATEGORIES: [
            'Work & Career',
            'Finance & Crypto',
            'Design & Media',
            'Reading & Knowledge',
            'Entertainment & Social',
            'Shopping & Tools',
            'Travel & Lifestyle',
            'Tech & Development'
        ],
        SUGGESTED_ADDABLE_CATEGORIES: [
            'Health, Fitness & Wellness',
            'AI & Machine Learning',
            'News & Current Affairs',
            'Recipes & Cooking',
            'Education & Academia',
            'Open Source & Code',
            'Home, DIY & Real Estate',
            'Podcasts, Audio & Music',
            'Gaming & Esports',
            'Legal, Docs & Admin'
        ],
        SCHEMA_SORT_OPTIONS: [
            { id: 'alpha', label: 'Alphabetical (A–Z)' }
        ]
    }
})

vi.mock('../services/input_bookmarks', () => ({
    INPUT_MAX_BYTES: 25 * 1024 * 1024,
    saveInputBookmarkFile: vi.fn(async (input) => ({ saved: true, entry: { ...input, size: input.html.length, savedAt: 1757000000000 } })),
    getInputBookmarkMeta: vi.fn(async () => null),
    getInputBookmarkHtml: vi.fn(async () => null),
    removeInputBookmarkFile: vi.fn(async () => {}),
    downloadInputBookmarkFile: vi.fn()
}))

vi.mock('../services/bookmarks_export', () => ({
    downloadBookmarks: vi.fn()
}))

describe('Organizer Component UI Tests', () => {
    beforeEach(() => {
        localStorage.clear()
        vi.clearAllMocks()
        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({})),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: {
                    get: vi.fn((keys, cb) => cb({})),
                    set: vi.fn()
                }
            }
        }
    })

    afterEach(() => {
        cleanup()
        delete global.chrome
    })

    it('renders the initial UI with Gemini AI models info', () => {
        render(<Organizer />)

        expect(screen.getByText(/Gemini AI/i)).toBeDefined()
        expect(screen.getByPlaceholderText(/AIza\.\.\. \(Google AI Studio\) or sk-or-\.\.\. \(OpenRouter\)/i)).toBeDefined()
    })

    it('defaults new installs to inferred categories with no manual selection', () => {
        render(<Organizer />)

        expect(screen.getByRole('switch', { name: /Infer categories/i }).getAttribute('aria-checked')).toBe('true')
        expect(screen.getByText(/No manual categories selected/i)).toBeDefined()
        expect(screen.getByPlaceholderText(/Add custom category/i).disabled).toBe(true)
    })

    it('explains that chosen categories are root folders and subfolders remain automatic', () => {
        render(<Organizer />)

        expect(screen.getByText(/Your chosen categories become the root-level folders/i)).toBeDefined()
        expect(screen.getAllByText(/Subfolders are always generated automatically inside each root folder/i).length).toBeGreaterThan(0)
    })

    it('renders the complete suggested category pool when manual editing is enabled', () => {
        localStorage.setItem('inferCategories', 'false')
        render(<Organizer />)

        for (const category of [
            'Health, Fitness & Wellness',
            'AI & Machine Learning',
            'News & Current Affairs',
            'Recipes & Cooking',
            'Education & Academia',
            'Open Source & Code',
            'Home, DIY & Real Estate',
            'Podcasts, Audio & Music',
            'Gaming & Esports',
            'Legal, Docs & Admin'
        ]) {
            expect(screen.getByRole('button', { name: new RegExp(category, 'i') })).toBeDefined()
        }
    })

    it('persists disabling inferred categories and restores the saved manual controls', () => {
        localStorage.setItem('categories', JSON.stringify(['Work']))
        render(<Organizer />)

        const inferToggle = screen.getByRole('switch', { name: /Infer categories/i })
        fireEvent.click(inferToggle)

        expect(inferToggle.getAttribute('aria-checked')).toBe('false')
        expect(localStorage.getItem('inferCategories')).toBe('false')
        expect(global.chrome.storage.local.set).toHaveBeenCalledWith({ inferCategories: false })
        expect(screen.getByPlaceholderText(/Add custom category/i).disabled).toBe(false)
        expect(screen.getByText('Work')).toBeDefined()
    })

    it.each([true, false])(
        'restores an explicitly saved empty manual selection when inference is %s',
        (inferCategories) => {
            global.chrome.storage.local.get.mockImplementation((keys, cb) => cb({
                categories: [],
                inferCategories
            }))

            render(<Organizer />)

            expect(screen.getByRole('switch', { name: /Infer categories/i }).getAttribute('aria-checked'))
                .toBe(String(inferCategories))
            expect(screen.getByText(/No manual categories selected/i)).toBeDefined()
            expect(localStorage.getItem('categories')).toBe('[]')
        }
    )

    it('does not persist categories generated for an inferred run', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-inferred-run')
        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.stats = {
                categoriesCount: 1,
                categoryBreakdown: { 'Generated Topic': 1 }
            }
            this.start = vi.fn(async () => {
                act(() => onProgress({ status: 'done', message: 'Organization complete!' }))
                return [{
                    title: 'Item 1',
                    url: 'https://example.com',
                    category: 'Generated Topic',
                    sub_category: 'Generated Detail'
                }]
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        render(<Organizer />)
        fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))

        await waitFor(() => expect(screen.getByText(/Organization complete!/i)).toBeDefined())
        expect(localStorage.getItem('categories')).toBeNull()
        expect(global.chrome.storage.local.set.mock.calls.some(([entry]) => Object.hasOwn(entry, 'categories'))).toBe(false)
        const persistedPayloads = [
            ...global.chrome.storage.local.set.mock.calls,
            ...global.chrome.storage.session.set.mock.calls
        ].map(([payload]) => payload)
        expect(JSON.stringify(persistedPayloads)).not.toContain('Generated Topic')
        expect(JSON.stringify(persistedPayloads)).not.toContain('Generated Detail')
    })

    it('preserves an actionable inference error from the in-panel runner', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-inference-error')
        const actionableMessage = 'Could not infer categories from your bookmarks: the AI returned only Other. Try again with a different model.'
        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.start = vi.fn(async () => {
                act(() => onProgress({ status: 'error', message: actionableMessage }))
                throw new Error('the AI returned only Other')
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        render(<Organizer />)
        fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))

        await waitFor(() => expect(screen.getByText(actionableMessage)).toBeDefined())
        expect(screen.queryByText('Failed to start process.')).toBeNull()
    })

    it('requires a manual category before manual AI organization starts', () => {
        localStorage.setItem('apiKey', 'sk-or-test-manual-empty')
        render(<Organizer />)

        fireEvent.click(screen.getByRole('switch', { name: /Infer categories/i }))
        fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))

        expect(screen.getByText('Add at least one category or turn on Infer categories.')).toBeDefined()
        expect(OrganizerService).not.toHaveBeenCalled()
    })

    it('lets browser-mode organization explain the missing API key instead of disabling the action', () => {
        render(<Organizer />)

        const organizeButton = screen.getByRole('button', { name: 'Organize My Bookmarks' })
        expect(organizeButton.disabled).toBe(false)

        fireEvent.click(organizeButton)

        expect(screen.getByText(/Please enter your Google AI Studio or OpenRouter API Key/i)).toBeDefined()
    })

    it('shows the matching hierarchy illustration for each subfolder setting', () => {
        render(<Organizer />)

        const image = screen.getByRole('img', { name: /category and nested subfolder hierarchy/i })
        expect(image.getAttribute('src')).toContain('subfolder-hierarchy.png')

        fireEvent.click(screen.getByRole('button', { name: 'Medium' }))
        expect(image.getAttribute('src')).toContain('subfolder-hierarchy-balanced.png')

        fireEvent.click(screen.getByRole('button', { name: 'Detailed' }))
        expect(image.getAttribute('src')).toContain('subfolder-hierarchy-detailed.png')
    })

    it('shows a dark hierarchy illustration when dark mode is active', () => {
        render(<Organizer theme="dark" />)

        const image = screen.getByRole('img', { name: /category and nested subfolder hierarchy/i })
        expect(image.getAttribute('src')).toContain('subfolder-hierarchy-dark.png')
    })

    it('allows entering API key and persists to localStorage', () => {
        render(<Organizer />)

        const input = screen.getByPlaceholderText(/AIza\.\.\. \(Google AI Studio\) or sk-or-\.\.\. \(OpenRouter\)/i)
        act(() => {
            fireEvent.change(input, { target: { value: 'sk-or-test-12345' } })
        })

        expect(input.value).toBe('sk-or-test-12345')
        expect(localStorage.getItem('apiKey')).toBe('sk-or-test-12345')
    })

    it('handles status processing and progress to actually update UI progress and logs', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.start = vi.fn(async () => {
                act(() => {
                    onProgress({ status: 'processing', message: 'Classifying batch 1/2...', percent: 0 })
                })
                act(() => {
                    onProgress({ status: 'progress', message: 'Classified batch 1/2.', percent: 50 })
                })
                act(() => {
                    onProgress({ status: 'processing', message: 'Classifying batch 2/2...', percent: 50 })
                })
                act(() => {
                    onProgress({ status: 'progress', message: 'Classified batch 2/2.', percent: 100 })
                })
                act(() => {
                    onProgress({ status: 'done', message: 'Organization complete!' })
                })
                return [
                    { title: 'Item 1', url: 'https://example.com/1', category: 'Tech', sub_category: 'Code' }
                ]
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        render(<Organizer />)

        const startButton = screen.getByRole('button', { name: /Organize My Bookmarks/i })
        expect(startButton.disabled).toBe(false)

        act(() => {
            fireEvent.click(startButton)
        })

        await waitFor(() => {
            expect(screen.getByText(/Classifying batch 1\/2\.\.\./i)).toBeDefined()
            expect(screen.getByText(/Classified batch 1\/2\./i)).toBeDefined()
            expect(screen.getByText(/Organization complete!/i)).toBeDefined()
        })
    })

    it('shows rate limit / network retry notification banner when warning is received and clears on completion', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.start = vi.fn(async () => {
                act(() => {
                    onProgress({
                        status: 'warning',
                        message: 'Rate limit reached (429). Pausing for 8s before retrying batch 1...'
                    })
                })
                act(() => {
                    onProgress({ status: 'done', message: 'Organization complete!' })
                })
                return [{ title: 'Item 1', url: 'https://example.com/1' }]
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        render(<Organizer />)

        const startButton = screen.getByRole('button', { name: /Organize My Bookmarks/i })
        act(() => {
            fireEvent.click(startButton)
        })

        await waitFor(() => {
            expect(screen.getByText(/Organization complete!/i)).toBeDefined()
        })
    })

    it('allows toggling flat date sort (0 AI tokens) which makes API key optional', () => {
        render(<Organizer />)

        const flatToggle = screen.getByRole('switch', { name: /Sort by date added - Flat list/i })
        expect(flatToggle.getAttribute('aria-checked')).toBe('false')

        act(() => {
            fireEvent.click(flatToggle)
        })
        expect(flatToggle.getAttribute('aria-checked')).toBe('true')

        expect(screen.getByText(/Optional for flat date sorting/i)).toBeDefined()
        expect(screen.getByText('Newest bookmarks at the top')).toBeDefined()
    })

    it('toggles flat date sort when the card title is clicked', () => {
        render(<Organizer />)

        const flatToggle = screen.getByRole('switch', { name: /Sort by date added - Flat list/i })
        expect(flatToggle.getAttribute('aria-checked')).toBe('false')

        const titleButton = screen.getByRole('button', { name: 'Toggle Sort by date added - Flat list' })
        act(() => {
            fireEvent.click(titleButton)
        })
        expect(flatToggle.getAttribute('aria-checked')).toBe('true')

        act(() => {
            fireEvent.click(titleButton)
        })
        expect(flatToggle.getAttribute('aria-checked')).toBe('false')
    })

    it('shows the default direction readout after enabling flat date sort', () => {
        render(<Organizer />)

        act(() => {
            fireEvent.click(screen.getByRole('switch', { name: /Sort by date added - Flat list/i }))
        })

        expect(screen.getByText('Newest bookmarks at the top')).toBeDefined()
    })

    it('flips the direction readout text once per click while flat date sort is enabled', () => {
        render(<Organizer />)

        act(() => {
            fireEvent.click(screen.getByRole('switch', { name: /Sort by date added - Flat list/i }))
        })
        expect(screen.getByText('Newest bookmarks at the top')).toBeDefined()

        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Newest bookmarks at the top' }))
        })
        expect(screen.getByText('Oldest bookmarks at the top')).toBeDefined()
        expect(screen.queryByText('Newest bookmarks at the top')).toBeNull()

        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Oldest bookmarks at the top' }))
        })
        expect(screen.getByText('Newest bookmarks at the top')).toBeDefined()
        expect(screen.queryByText('Oldest bookmarks at the top')).toBeNull()
    })

    it('provides cancel button during processing that invokes organizer.cancel()', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        let serviceInstance = null
        let resolveStart = null
        const startPromise = new Promise(resolve => {
            resolveStart = resolve
        })

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            serviceInstance = this
            this.start = vi.fn(() => startPromise)
            this.cancel = vi.fn(() => {
                this.isCancelled = true
                act(() => {
                    onProgress({ status: 'warning', message: 'Process cancelled.' })
                })
            })
            this.isCancelled = false
        })

        render(<Organizer />)

        const startButton = screen.getByRole('button', { name: /Organize My Bookmarks/i })
        act(() => {
            fireEvent.click(startButton)
        })

        // Cancel button appears
        const cancelButton = await screen.findByRole('button', { name: /Cancel/i })
        expect(cancelButton).toBeDefined()

        act(() => {
            fireEvent.click(cancelButton)
        })

        expect(serviceInstance.cancel).toHaveBeenCalled()

        resolveStart(null)
    })
})

describe('Last run banner date reporting', () => {
    const savedAt = new Date(2026, 8, 4, 18, 13, 43).getTime()
    const runTime = new Date(savedAt).toLocaleString(undefined, {
        month: 'numeric',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    })

    const bannerText = (stats) => {
        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({ organizedMeta: { count: 3462, savedAt, stats } })),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }
        const { container } = render(<Organizer />)
        const banner = container.querySelector('.last-run-banner')
        expect(banner).not.toBeNull()
        return banner.textContent
    }

    afterEach(() => {
        cleanup()
        delete global.chrome
    })

    it('opens with the bare run time and trails the unlabeled bookmark range', () => {
        const text = bannerText({
            total: 3462,
            isFlat: false,
            duplicatesRemoved: 0,
            deadLinksArchived: 0,
            categoriesCount: 12,
            categoryBreakdown: {},
            dateSpan: '7/14/2017 – 11/14/2023'
        })

        expect(text).toContain(`${runTime} · 3,462 bookmarks organized · 7/14/2017 – 11/14/2023`)
        expect(text).not.toContain('Last run')
        expect(text).not.toContain('Dates')
        expect(text).not.toContain('Ran')
        expect(text).not.toContain('6:13:43')
    })

    it('widens a legacy stored single date into a full range', () => {
        const text = bannerText({
            total: 3462,
            isFlat: false,
            duplicatesRemoved: 0,
            deadLinksArchived: 0,
            categoriesCount: 12,
            categoryBreakdown: {},
            dateSpan: '9/3/2026'
        })

        expect(text).toContain('· 9/3/2026 – 9/3/2026')
    })

    it('says the range was not recorded for metadata saved without one, rather than leaving a lone date', () => {
        const text = bannerText({
            total: 3462,
            isFlat: false,
            duplicatesRemoved: 0,
            deadLinksArchived: 0,
            categoriesCount: 12,
            categoryBreakdown: {}
        })

        expect(text).toContain('dates not recorded')
        expect(text.trimStart().startsWith(runTime)).toBe(true)
    })

    it('shows failed moves in the last-run banner', () => {
        const text = bannerText({
            total: 3, isFlat: false, duplicatesRemoved: 0, deadLinksArchived: 0,
            categoriesCount: 1, categoryBreakdown: {},
            failedMoves: [{ title: 'X', reason: 'gone' }]
        })
        expect(text).toContain('1 move failed')
    })

    it('displays date span in the idle schema drawer header when expanded', async () => {
        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({
                        organizedMeta: {
                            count: 10,
                            savedAt,
                            stats: {
                                total: 10,
                                isFlat: false,
                                duplicatesRemoved: 0,
                                deadLinksArchived: 0,
                                categoriesCount: 1,
                                categoryBreakdown: { 'Tech': 10 },
                                dateSpan: '1/1/2021 – 12/31/2023'
                            }
                        }
                    })),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }
        render(<Organizer />)
        const schemaBtn = screen.getByRole('button', { name: /Schema/i })
        act(() => {
            fireEvent.click(schemaBtn)
        })
        expect(screen.getAllByText(/Dates 1\/1\/2021 – 12\/31\/2023/i).length).toBe(1)
    })

    it('backfills dateSpan from chrome.storage.session if organizedMeta lacks dateSpan', async () => {
        const mockSet = vi.fn()
        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({
                        organizedMeta: {
                            count: 2,
                            savedAt,
                            stats: {
                                total: 2,
                                isFlat: false
                            }
                        }
                    })),
                    set: mockSet,
                    remove: vi.fn()
                },
                session: {
                    get: vi.fn((keys, cb) => cb({
                        organizedData: [
                            { url: 'https://a.com', dateAdded: 1609459200000 }, // 2021-01-01
                            { url: 'https://b.com', dateAdded: 1703980800000 }  // 2023-12-31
                        ]
                    })),
                    set: vi.fn()
                }
            }
        }

        render(<Organizer />)

        await waitFor(() => {
            expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
                organizedMeta: expect.objectContaining({
                    dateSpan: expect.stringMatching(/\d{1,2}\/\d{1,2}\/\d{4}/)
                })
            }))
        })
    })
})

describe('In-process and completion date range display', () => {
    afterEach(() => {
        cleanup()
        delete global.chrome
    })

    it('renders active date range pill while processing when dateSpan is received', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.start = vi.fn(async () => {
                act(() => {
                    onProgress({
                        status: 'info',
                        message: 'Found 5 bookmarks',
                        dateSpan: '5/10/2018 – 8/20/2024'
                    })
                })
                act(() => {
                    onProgress({
                        status: 'processing',
                        message: 'Classifying bookmarks...',
                        percent: 30
                    })
                })
                // keep in processing state for check
                return new Promise(() => {})
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({})),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }

        render(<Organizer />)

        const startButton = screen.getByRole('button', { name: /Organize My Bookmarks/i })
        act(() => {
            fireEvent.click(startButton)
        })

        await waitFor(() => {
            expect(screen.getByText(/5\/10\/2018 – 8\/20\/2024/i)).toBeDefined()
        })
    })

    it('displays date range under download button on completion screen', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.start = vi.fn(async () => {
                act(() => {
                    onProgress({ status: 'done', message: 'Complete!' })
                })
                const results = [
                    { title: 'Item 1', url: 'https://example.com/1', dateAdded: 1609459200000 }
                ]
                results.stats = {
                    total: 1,
                    isFlat: false,
                    duplicatesRemoved: 0,
                    deadLinksArchived: 0,
                    categoriesCount: 1,
                    dateSpan: '1/1/2021'
                }
                return results
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({})),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }

        render(<Organizer />)

        const startButton = screen.getByRole('button', { name: /Organize My Bookmarks/i })
        act(() => {
            fireEvent.click(startButton)
        })

        await waitFor(() => {
            expect(screen.getByText(/All Done! Check your "AI Organized Bookmarks/i)).toBeDefined()
            expect(screen.getByText(/A backup file was also saved to your downloads/i)).toBeDefined()
            expect(screen.getByText(/Date range:/i)).toBeDefined()
            expect(screen.getByRole('button', { name: /Download Organized Bookmarks/i }).getAttribute('title')).toContain('Dates 1/1/2021')
        })
    })

    it('shows the compact sort label and an oldest-to-newest range in the completion stats pill', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.start = vi.fn(async () => {
                act(() => {
                    onProgress({ status: 'done', message: 'Complete!' })
                })
                const results = [{ title: 'Item 1', url: 'https://example.com/1', dateAdded: 1788489600000 }]
                results.stats = {
                    total: 3462,
                    isFlat: false,
                    duplicatesRemoved: 0,
                    deadLinksArchived: 0,
                    categoriesCount: 9,
                    schemaSortOrder: 'alpha',
                    categoryBreakdown: {},
                    dateSpan: '9/3/2026 – 9/3/2026'
                }
                return results
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({})),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }

        const { container } = render(<Organizer />)

        act(() => {
            fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))
        })

        await waitFor(() => {
            const pill = container.querySelector('.stats-pill')
            expect(pill).not.toBeNull()
            expect(pill.textContent).toContain('A–Z')
            expect(pill.textContent).toContain('Dates 9/3/2026 – 9/3/2026')
            expect(pill.textContent).not.toContain('Alphabetical')
        })
    })

    describe('Background Organization and Reconnection', () => {
        it('restores in-flight background organization state from session storage on mount', async () => {
            global.chrome = {
                storage: {
                    local: {
                        get: vi.fn((keys, cb) => cb({})),
                        set: vi.fn(),
                        remove: vi.fn()
                    },
                    session: {
                        get: vi.fn((keys, cb) => {
                            if (keys.includes('activeJobState')) {
                                cb({
                                    activeJobState: {
                                        status: 'processing',
                                        progress: 68,
                                        activeDateSpan: '1/1/2024 – 6/1/2024',
                                        logs: [
                                            { message: 'Classifying batch 2/4 in background...', timestamp: Date.now() }
                                        ]
                                    }
                                })
                            } else {
                                cb({})
                            }
                        }),
                        set: vi.fn()
                    }
                }
            }

            render(<Organizer />)

            await waitFor(() => {
                expect(screen.getByText(/68%/i)).toBeDefined()
                expect(screen.getByText(/1\/1\/2024 – 6\/1\/2024/i)).toBeDefined()
                expect(screen.getByText(/Classifying batch 2\/4 in background/i)).toBeDefined()
                expect(screen.getByRole('button', { name: /Cancel/i })).toBeDefined()
            })
        })

        it('requests and downloads completed inferred results from background memory after reconnecting', async () => {
            const listeners = []
            const mockPort = {
                postMessage: vi.fn(),
                onMessage: {
                    addListener: vi.fn((fn) => listeners.push(fn)),
                    removeListener: vi.fn()
                },
                onDisconnect: { addListener: vi.fn() },
                disconnect: vi.fn()
            }
            const generatedResults = [{
                title: 'Generated result',
                url: 'https://example.com/generated',
                category: 'Generated Topic',
                sub_category: 'Generated Detail',
                detail_category: 'Generated Leaf'
            }]
            const meta = {
                count: 1,
                savedAt: 1757890000000,
                stats: {
                    categoriesCount: 1,
                    categoryBreakdown: { 'Generated Topic': 1 },
                    detailFoldersCount: 1,
                    detailedSubcategories: 1,
                    dateSpan: '1/1/2024 – 2/1/2024'
                },
                dateSpan: '1/1/2024 – 2/1/2024'
            }

            global.chrome = {
                runtime: { connect: vi.fn(() => mockPort) },
                storage: {
                    local: { get: vi.fn((keys, cb) => cb({})), set: vi.fn(), remove: vi.fn() },
                    session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
                }
            }

            render(<Organizer />)

            act(() => {
                listeners.forEach((listener) => listener({
                    type: 'STATUS_UPDATE',
                    payload: {
                        id: 'job_123',
                        status: 'complete',
                        progress: 100,
                        logs: [{ message: 'Finding useful third-level groups...', timestamp: Date.now() }]
                    }
                }))
            })

            expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'GET_RESULTS' })

            act(() => {
                listeners.forEach((listener) => listener({
                    type: 'JOB_RESULTS',
                    payload: { results: generatedResults, meta }
                }))
            })

            const downloadButton = await screen.findByRole('button', { name: /Download Organized Bookmarks/i })
            const statsPill = document.querySelector('.stats-pill')
            expect(screen.getByText('Finding useful third-level groups...')).toBeDefined()
            expect(statsPill.textContent).toContain('1 detail folder')
            expect(statsPill.textContent).toContain('1 detailed subcategory')
            fireEvent.click(downloadButton)

            await waitFor(() => {
                expect(bookmarksExport.downloadBookmarks).toHaveBeenCalledWith(generatedResults)
            })
            const persistedPayloads = [
                ...global.chrome.storage.local.set.mock.calls,
                ...global.chrome.storage.session.set.mock.calls
            ].map(([payload]) => payload)
            expect(JSON.stringify(persistedPayloads)).not.toContain('Generated Topic')
            expect(JSON.stringify(persistedPayloads)).not.toContain('Generated Detail')
            expect(JSON.stringify(persistedPayloads)).not.toContain('Generated Leaf')
        })

        it('keeps completed worker results available after the automatic menu return and a reconnect', async () => {
            vi.useFakeTimers()
            const listeners = []
            const generatedResults = [{
                title: 'Generated result',
                url: 'https://example.com/generated',
                category: 'Generated Topic',
                sub_category: 'Generated Detail'
            }]
            const meta = { count: 1, savedAt: 1757890000000, stats: { categoriesCount: 1 } }
            let resultsAvailable = true
            const mockPort = {
                postMessage: vi.fn((message) => {
                    if (message.type === 'RESET_JOB') resultsAvailable = false
                    if (message.type === 'GET_RESULTS') {
                        listeners.forEach(listener => listener(resultsAvailable
                            ? { type: 'JOB_RESULTS', payload: { results: generatedResults, meta } }
                            : { type: 'JOB_RESULTS_UNAVAILABLE', payload: {} }))
                    }
                }),
                onMessage: { addListener: vi.fn(listener => listeners.push(listener)), removeListener: vi.fn() },
                onDisconnect: { addListener: vi.fn() },
                disconnect: vi.fn()
            }
            global.chrome = {
                runtime: { connect: vi.fn(() => mockPort) },
                storage: {
                    local: { get: vi.fn((keys, cb) => cb({})), set: vi.fn(), remove: vi.fn() },
                    session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
                }
            }

            const firstPanel = render(<Organizer />)
            act(() => {
                listeners.forEach(listener => listener({
                    type: 'STATUS_UPDATE',
                    payload: { id: 'job_complete', status: 'complete', progress: 100, logs: [] }
                }))
            })
            expect(screen.getByRole('button', { name: /Download Organized Bookmarks/i })).toBeDefined()

            act(() => vi.advanceTimersByTime(10000))
            expect(screen.getByRole('button', { name: /Organize My Bookmarks/i })).toBeDefined()
            expect(mockPort.postMessage).not.toHaveBeenCalledWith({ type: 'RESET_JOB' })
            vi.useRealTimers()

            firstPanel.unmount()
            render(<Organizer />)
            act(() => {
                listeners.forEach(listener => listener({
                    type: 'STATUS_UPDATE',
                    payload: { id: 'job_complete', status: 'complete', progress: 100, logs: [] }
                }))
            })
            const downloadButton = await screen.findByRole('button', { name: /Download Organized Bookmarks/i })
            fireEvent.click(downloadButton)
            await waitFor(() => {
                expect(bookmarksExport.downloadBookmarks).toHaveBeenCalledWith(generatedResults)
            })
        })

        it('replaces the previous in-memory result before a new delegated run can complete', async () => {
            vi.useFakeTimers()
            localStorage.setItem('apiKey', 'sk-or-test-new-run')
            const listeners = []
            const oldResults = [{ title: 'Old result', url: 'https://example.com/old', category: 'Old', sub_category: 'Old' }]
            const freshResults = [{ title: 'Fresh result', url: 'https://example.com/fresh', category: 'Fresh', sub_category: 'Fresh' }]
            const oldMeta = { count: 1, savedAt: 1757890000000, stats: { categoriesCount: 1 } }
            const freshMeta = { count: 1, savedAt: 1757890001000, stats: { categoriesCount: 1 } }
            let resultsRequestCount = 0
            const mockPort = {
                postMessage: vi.fn((message) => {
                    if (message.type === 'START_JOB') {
                        listeners.forEach(listener => listener({ type: 'JOB_ACK' }))
                    }
                    if (message.type === 'GET_RESULTS') {
                        resultsRequestCount += 1
                        const results = resultsRequestCount === 1 ? oldResults : freshResults
                        const meta = resultsRequestCount === 1 ? oldMeta : freshMeta
                        listeners.forEach(listener => listener({
                            type: 'JOB_RESULTS',
                            payload: { results, meta }
                        }))
                    }
                }),
                onMessage: { addListener: vi.fn(listener => listeners.push(listener)), removeListener: vi.fn() },
                onDisconnect: { addListener: vi.fn() },
                disconnect: vi.fn()
            }
            global.chrome = {
                runtime: { connect: vi.fn(() => mockPort) },
                storage: {
                    local: { get: vi.fn((keys, cb) => cb({})), set: vi.fn(), remove: vi.fn() },
                    session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
                }
            }

            render(<Organizer />)
            act(() => {
                listeners.forEach(listener => listener({
                    type: 'STATUS_UPDATE',
                    payload: { id: 'old-run', status: 'complete', progress: 100, logs: [] }
                }))
                listeners.forEach(listener => listener({
                    type: 'JOB_RESULTS',
                    payload: { results: oldResults, meta: oldMeta }
                }))
            })
            expect(screen.getByRole('button', { name: /Download Organized Bookmarks/i })).toBeDefined()

            act(() => vi.advanceTimersByTime(10000))
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))
                await Promise.resolve()
            })

            act(() => {
                listeners.forEach(listener => listener({
                    type: 'STATUS_UPDATE',
                    payload: { id: 'fresh-run', status: 'complete', progress: 100, logs: [] }
                }))
            })

            expect(mockPort.postMessage.mock.calls.filter(([message]) => message.type === 'GET_RESULTS')).toHaveLength(2)
            bookmarksExport.downloadBookmarks.mockClear()
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /Download Organized Bookmarks/i }))
                await Promise.resolve()
            })
            expect(bookmarksExport.downloadBookmarks).toHaveBeenCalledWith(freshResults)
            vi.useRealTimers()
        })

        it('removes stale download state when transient worker results are unavailable', async () => {
            const listeners = []
            const staleResults = [{
                title: 'Stale result',
                url: 'https://example.com/stale',
                category: 'Generated Topic',
                sub_category: 'Generated Detail'
            }]
            const staleMeta = { count: 1, savedAt: 1757890000000, stats: { categoriesCount: 1 } }
            let provideStaleResults = true
            const mockPort = {
                postMessage: vi.fn(),
                onMessage: {
                    addListener: vi.fn((fn) => listeners.push(fn)),
                    removeListener: vi.fn()
                },
                onDisconnect: { addListener: vi.fn() },
                disconnect: vi.fn()
            }
            const unavailableMessage = 'Organized results are no longer available because they were kept only for this run and the background worker restarted. Run organization again.'

            global.chrome = {
                runtime: { connect: vi.fn(() => mockPort) },
                storage: {
                    local: { get: vi.fn((keys, cb) => cb({ organizedMeta: staleMeta })), set: vi.fn(), remove: vi.fn() },
                    session: {
                        get: vi.fn((keys, cb) => {
                            if (keys.includes('organizedData') && provideStaleResults) {
                                provideStaleResults = false
                                cb({ organizedData: staleResults })
                            } else {
                                cb({})
                            }
                        }),
                        set: vi.fn()
                    }
                }
            }

            render(<Organizer />)

            act(() => {
                listeners.forEach((listener) => listener({
                    type: 'STATUS_UPDATE',
                    payload: {
                        id: 'job_completed_in_worker',
                        status: 'complete',
                        progress: 100,
                        logs: [],
                        count: 1,
                        completedAt: 1757890000000
                    }
                }))
            })

            expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'GET_RESULTS' })

            expect(await screen.findByRole('button', { name: /Download Organized Bookmarks/i })).toBeDefined()

            act(() => {
                listeners.forEach((listener) => listener({
                    type: 'JOB_RESULTS_UNAVAILABLE',
                    payload: { message: unavailableMessage }
                }))
            })

            await waitFor(() => {
                expect(screen.getByText(unavailableMessage)).toBeDefined()
                expect(screen.queryByRole('button', { name: /Download Organized Bookmarks/i })).toBeNull()
            })

            act(() => {
                listeners.forEach((listener) => listener({
                    type: 'STATUS_UPDATE',
                    payload: {
                        id: 'job_completed_after_unavailable',
                        status: 'complete',
                        progress: 100,
                        logs: [],
                        count: 1,
                        completedAt: 1757890000000
                    }
                }))
            })

            expect(mockPort.postMessage).toHaveBeenLastCalledWith({ type: 'GET_RESULTS' })
            expect(mockPort.postMessage.mock.calls.filter(([message]) => message.type === 'GET_RESULTS')).toHaveLength(2)
            expect(global.chrome.storage.local.set).not.toHaveBeenCalled()
            expect(global.chrome.storage.session.set).not.toHaveBeenCalled()
        })

        it('does not show a transient-result error when no completed run was expected', async () => {
            const listeners = []
            const mockPort = {
                postMessage: vi.fn(),
                onMessage: {
                    addListener: vi.fn((fn) => listeners.push(fn)),
                    removeListener: vi.fn()
                },
                onDisconnect: { addListener: vi.fn() },
                disconnect: vi.fn()
            }
            const unavailableMessage = 'Organized results are no longer available because they were kept only for this run and the background worker restarted. Run organization again.'

            global.chrome = {
                runtime: { connect: vi.fn(() => mockPort) },
                storage: {
                    local: { get: vi.fn((keys, cb) => cb({})), set: vi.fn(), remove: vi.fn() },
                    session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
                }
            }

            render(<Organizer />)

            expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'GET_STATUS' })
            expect(mockPort.postMessage).not.toHaveBeenCalledWith({ type: 'GET_RESULTS' })

            act(() => {
                listeners.forEach((listener) => listener({
                    type: 'JOB_RESULTS_UNAVAILABLE',
                    payload: { message: unavailableMessage }
                }))
            })

            expect(screen.queryByText(unavailableMessage)).toBeNull()
            expect(screen.getByRole('button', { name: /Organize My Bookmarks/i })).toBeDefined()
        })

        it('ignores unavailable results after resetting a pending result request', async () => {
            const listeners = []
            const mockPort = {
                postMessage: vi.fn(),
                onMessage: {
                    addListener: vi.fn((fn) => listeners.push(fn)),
                    removeListener: vi.fn()
                },
                onDisconnect: { addListener: vi.fn() },
                disconnect: vi.fn()
            }
            const unavailableMessage = 'Organized results are no longer available because they were kept only for this run and the background worker restarted. Run organization again.'

            global.chrome = {
                runtime: { connect: vi.fn(() => mockPort) },
                storage: {
                    local: { get: vi.fn((keys, cb) => cb({})), set: vi.fn(), remove: vi.fn() },
                    session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
                }
            }

            render(<Organizer />)

            act(() => {
                listeners.forEach((listener) => listener({
                    type: 'STATUS_UPDATE',
                    payload: { id: 'job_pending_results', status: 'complete', progress: 100 }
                }))
            })

            expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'GET_RESULTS' })
            fireEvent.click(screen.getByText('Organize Again'))

            act(() => {
                listeners.forEach((listener) => listener({
                    type: 'JOB_RESULTS_UNAVAILABLE',
                    payload: { message: unavailableMessage }
                }))
            })

            expect(screen.queryByText(unavailableMessage)).toBeNull()
            expect(screen.getByRole('button', { name: /Organize My Bookmarks/i })).toBeDefined()
        })

        it('ignores unavailable results after disconnecting a pending result request', async () => {
            const listeners = []
            const disconnectListeners = []
            const mockPort = {
                postMessage: vi.fn(),
                onMessage: {
                    addListener: vi.fn((fn) => listeners.push(fn)),
                    removeListener: vi.fn()
                },
                onDisconnect: { addListener: vi.fn((fn) => disconnectListeners.push(fn)) },
                disconnect: vi.fn()
            }
            const unavailableMessage = 'Organized results are no longer available because they were kept only for this run and the background worker restarted. Run organization again.'

            global.chrome = {
                runtime: { connect: vi.fn(() => mockPort) },
                storage: {
                    local: { get: vi.fn((keys, cb) => cb({})), set: vi.fn(), remove: vi.fn() },
                    session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
                }
            }

            render(<Organizer />)

            act(() => {
                listeners.forEach((listener) => listener({
                    type: 'STATUS_UPDATE',
                    payload: { id: 'job_pending_results', status: 'complete', progress: 100 }
                }))
            })

            expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'GET_RESULTS' })
            act(() => disconnectListeners.forEach((listener) => listener()))

            act(() => {
                listeners.forEach((listener) => listener({
                    type: 'JOB_RESULTS_UNAVAILABLE',
                    payload: { message: unavailableMessage }
                }))
            })

            expect(screen.queryByText(unavailableMessage)).toBeNull()
            expect(screen.getByText('Organize Again')).toBeDefined()
        })

        it('dispatches START_JOB over port and runs in background when the service worker acknowledges', async () => {
            localStorage.setItem('apiKey', 'sk-or-test-port')

            const listeners = []
            const mockPort = {
                postMessage: vi.fn((msg) => {
                    if (msg?.type === 'START_JOB') {
                        listeners.forEach((fn) => fn({ type: 'JOB_ACK', payload: {} }))
                    }
                }),
                onMessage: {
                    addListener: vi.fn((fn) => listeners.push(fn)),
                    removeListener: vi.fn((fn) => {
                        const idx = listeners.indexOf(fn)
                        if (idx !== -1) listeners.splice(idx, 1)
                    })
                },
                onDisconnect: { addListener: vi.fn() },
                disconnect: vi.fn()
            }

            global.chrome = {
                runtime: {
                    connect: vi.fn(() => mockPort)
                },
                storage: {
                    local: {
                        get: vi.fn((keys, cb) => cb({})),
                        set: vi.fn(),
                        remove: vi.fn()
                    },
                    session: {
                        get: vi.fn((keys, cb) => cb({})),
                        set: vi.fn()
                    }
                }
            }

            render(<Organizer />)

            expect(global.chrome.runtime.connect).toHaveBeenCalledWith({ name: 'organizer-channel' })

            const callsBefore = OrganizerService.mock.calls.length
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))
            })

            expect(mockPort.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'START_JOB',
                    payload: expect.objectContaining({
                        config: expect.objectContaining({ apiKey: 'sk-or-test-port', inferCategories: true })
                    })
                })
            )
            expect(screen.getByText(/acknowledged the job/i)).toBeDefined()
            expect(OrganizerService.mock.calls.length).toBe(callsBefore)

            // Click Cancel
            act(() => {
                fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
            })

            expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'CANCEL_JOB' })
        })

        it('falls back to an in-panel run with live progress when the service worker never acknowledges START_JOB', async () => {
            localStorage.setItem('apiKey', 'sk-or-test-fallback')
            vi.useFakeTimers()

            try {
                OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
                    this.start = vi.fn(async () => {
                        act(() => { onProgress({ status: 'info', message: 'Processing uploaded file...' }) })
                        act(() => { onProgress({ status: 'processing', message: 'Classifying batch 1/3...', percent: 25 }) })
                        act(() => { onProgress({ status: 'done', message: 'Organization complete!' }) })
                        return [{ title: 'Item 1', url: 'https://example.com/1' }]
                    })
                    this.cancel = vi.fn()
                    this.isCancelled = false
                })

                const listeners = []
                const silentPort = {
                    postMessage: vi.fn(), // START_JOB vanishes — no JOB_ACK ever arrives
                    onMessage: {
                        addListener: vi.fn((fn) => listeners.push(fn)),
                        removeListener: vi.fn((fn) => {
                            const idx = listeners.indexOf(fn)
                            if (idx !== -1) listeners.splice(idx, 1)
                        })
                    },
                    onDisconnect: { addListener: vi.fn() },
                    disconnect: vi.fn()
                }

                global.chrome = {
                    runtime: { connect: vi.fn(() => silentPort) },
                    storage: {
                        local: { get: vi.fn((keys, cb) => cb({})), set: vi.fn(), remove: vi.fn() },
                        session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
                    }
                }

                render(<Organizer />)

                await act(async () => {
                    fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))
                    await vi.advanceTimersByTimeAsync(2500)
                })

                expect(screen.getByText(/did not acknowledge the job/i)).toBeDefined()
                expect(screen.getByText(/Processing uploaded file\.\.\./i)).toBeDefined()
                expect(screen.getByText(/Classifying batch 1\/3\.\.\./i)).toBeDefined()
                expect(screen.getByText(/Organization complete!/i)).toBeDefined()
                expect(OrganizerService.mock.calls.at(-1).at(-1)).toBe(true)
                expect(silentPort.postMessage).toHaveBeenCalledWith({ type: 'CANCEL_JOB' })
                expect(silentPort.disconnect).toHaveBeenCalled()
            } finally {
                vi.useRealTimers()
            }
        })

        it('falls back immediately when the service worker disconnects during the START_JOB handshake', async () => {
            localStorage.setItem('apiKey', 'sk-or-test-disconnect')
            vi.useFakeTimers()

            try {
                OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
                    this.start = vi.fn(async () => {
                        act(() => { onProgress({ status: 'done', message: 'Organization complete!' }) })
                        return [{ title: 'Item 1', url: 'https://example.com/1' }]
                    })
                    this.cancel = vi.fn()
                    this.isCancelled = false
                })

                const messageListeners = []
                const disconnectListeners = []
                const disconnectedPort = {
                    postMessage: vi.fn((msg) => {
                        if (msg?.type === 'START_JOB') {
                            disconnectListeners.forEach((fn) => fn())
                        }
                    }),
                    onMessage: {
                        addListener: vi.fn((fn) => messageListeners.push(fn)),
                        removeListener: vi.fn((fn) => {
                            const idx = messageListeners.indexOf(fn)
                            if (idx !== -1) messageListeners.splice(idx, 1)
                        })
                    },
                    onDisconnect: { addListener: vi.fn((fn) => disconnectListeners.push(fn)) },
                    disconnect: vi.fn()
                }

                global.chrome = {
                    runtime: { connect: vi.fn(() => disconnectedPort) },
                    storage: {
                        local: { get: vi.fn((keys, cb) => cb({})), set: vi.fn(), remove: vi.fn() },
                        session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
                    }
                }

                render(<Organizer />)

                await act(async () => {
                    fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))
                    await Promise.resolve()
                })

                expect(screen.getByText(/did not acknowledge the job/i)).toBeDefined()
                expect(screen.getByText(/Organization complete!/i)).toBeDefined()
                expect(disconnectedPort.disconnect).toHaveBeenCalled()
            } finally {
                vi.useRealTimers()
            }
        })

        it('wires live worker updates to the port reconnected after the original port died', async () => {
            localStorage.setItem('apiKey', 'sk-or-test-rewire')

            const deadListeners = []
            const deadDisconnect = []
            const deadPort = {
                postMessage: vi.fn(),
                onMessage: { addListener: vi.fn((fn) => deadListeners.push(fn)), removeListener: vi.fn() },
                onDisconnect: { addListener: vi.fn((fn) => deadDisconnect.push(fn)) },
                disconnect: vi.fn()
            }
            const liveListeners = []
            const livePort = {
                postMessage: vi.fn((msg) => {
                    if (msg?.type === 'START_JOB') {
                        liveListeners.forEach((fn) => fn({ type: 'JOB_ACK', payload: {} }))
                    }
                }),
                onMessage: {
                    addListener: vi.fn((fn) => liveListeners.push(fn)),
                    removeListener: vi.fn((fn) => {
                        const idx = liveListeners.indexOf(fn)
                        if (idx !== -1) liveListeners.splice(idx, 1)
                    })
                },
                onDisconnect: { addListener: vi.fn() },
                disconnect: vi.fn()
            }
            let connectCount = 0
            global.chrome = {
                runtime: { connect: vi.fn(() => (++connectCount === 1 ? deadPort : livePort)) },
                storage: {
                    local: { get: vi.fn((keys, cb) => cb({})), set: vi.fn(), remove: vi.fn() },
                    session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
                }
            }

            render(<Organizer />)

            // The service worker suspends after idle; the mount-time port dies with it.
            act(() => { deadDisconnect.forEach((fn) => fn()) })

            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))
                await Promise.resolve()
            })

            expect(global.chrome.runtime.connect).toHaveBeenCalledTimes(2)
            expect(livePort.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'START_JOB' })
            )
            await waitFor(() => expect(screen.getByText(/acknowledged the job/i)).toBeDefined())

            // Worker broadcasts run state on the reconnected port — the panel must hear it.
            act(() => {
                liveListeners.forEach((fn) => fn({
                    type: 'STATUS_UPDATE',
                    payload: {
                        id: 'job_live',
                        status: 'processing',
                        progress: 42,
                        logs: [{ message: 'Classifying batch 3/10...', timestamp: Date.now() }]
                    }
                }))
            })

            expect(screen.getByText('Classifying batch 3/10...')).toBeDefined()
            expect(screen.getByText(/In Progress\.\.\. 42%/)).toBeDefined()
        })

        it('watchdog reconnects and resyncs the terminal when the port dies mid-run', async () => {
            localStorage.setItem('apiKey', 'sk-or-test-watchdog')
            vi.useFakeTimers()

            try {
                const firstListeners = []
                const firstDisconnect = []
                const firstPort = {
                    postMessage: vi.fn((msg) => {
                        if (msg?.type === 'START_JOB') {
                            firstListeners.forEach((fn) => fn({ type: 'JOB_ACK', payload: {} }))
                        }
                    }),
                    onMessage: {
                        addListener: vi.fn((fn) => firstListeners.push(fn)),
                        removeListener: vi.fn((fn) => {
                            const idx = firstListeners.indexOf(fn)
                            if (idx !== -1) firstListeners.splice(idx, 1)
                        })
                    },
                    onDisconnect: { addListener: vi.fn((fn) => firstDisconnect.push(fn)) },
                    disconnect: vi.fn()
                }
                const secondListeners = []
                const secondPort = {
                    postMessage: vi.fn(),
                    onMessage: {
                        addListener: vi.fn((fn) => secondListeners.push(fn)),
                        removeListener: vi.fn((fn) => {
                            const idx = secondListeners.indexOf(fn)
                            if (idx !== -1) secondListeners.splice(idx, 1)
                        })
                    },
                    onDisconnect: { addListener: vi.fn() },
                    disconnect: vi.fn()
                }
                let connectCount = 0
                global.chrome = {
                    runtime: { connect: vi.fn(() => (++connectCount === 1 ? firstPort : secondPort)) },
                    storage: {
                        local: { get: vi.fn((keys, cb) => cb({})), set: vi.fn(), remove: vi.fn() },
                        session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
                    }
                }

                render(<Organizer />)

                await act(async () => {
                    fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))
                    await Promise.resolve()
                })
                expect(screen.getByText(/acknowledged the job/i)).toBeDefined()

                // The worker dies mid-run; the port drops with it.
                act(() => { firstDisconnect.forEach((fn) => fn()) })

                await act(async () => { await vi.advanceTimersByTimeAsync(10000) })

                expect(global.chrome.runtime.connect).toHaveBeenCalledTimes(2)
                expect(secondPort.postMessage).toHaveBeenCalledWith({ type: 'GET_STATUS' })

                // The worker answers on the reconnected port and the terminal catches up.
                act(() => {
                    secondListeners.forEach((fn) => fn({
                        type: 'STATUS_UPDATE',
                        payload: {
                            id: 'job_resync',
                            status: 'processing',
                            progress: 55,
                            logs: [{ message: 'Classifying batch 6/10...', timestamp: Date.now() }]
                        }
                    }))
                })

                expect(screen.getByText('Classifying batch 6/10...')).toBeDefined()
                expect(screen.getByText(/In Progress\.\.\. 55%/)).toBeDefined()
            } finally {
                vi.useRealTimers()
            }
        })
    })
})

describe('Input Bookmarks card', () => {
    const cachedMeta = { filename: 'b.html', size: 4, savedAt: 1757000000000, count: 3462, dateSpan: null }

    beforeEach(() => { inputService.getInputBookmarkMeta.mockResolvedValue(null) })
    afterEach(() => { vi.clearAllMocks(); cleanup(); delete global.chrome })

    const chromeWith = (local = {}) => {
        global.chrome = {
            storage: {
                local: { get: vi.fn((keys, cb) => cb(local)), set: vi.fn(), remove: vi.fn() },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }
    }

    it('caches a dropped file and shows the card', async () => {
        chromeWith({})
        const { container } = render(<Organizer />)
        const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p></DL><p>'
        const file = new File([html], 'bookmarks_mpro13.html', { type: 'text/html' })
        const zone = container.querySelector('[data-testid="dropzone"]')
        fireEvent.drop(zone, { dataTransfer: { files: [file] } })
        await waitFor(() => expect(inputService.saveInputBookmarkFile).toHaveBeenCalled())
        const call = inputService.saveInputBookmarkFile.mock.calls[0][0]
        expect(call.filename).toBe('bookmarks_mpro13.html')
        expect(call.html).toBe(html) // raw, byte-for-byte
        await waitFor(() => expect(container.querySelector('.input-bookmarks-card')).not.toBeNull())
    })

    it('renders the cached input as a card with Download, Re-organize, Remove', async () => {
        chromeWith({})
        inputService.getInputBookmarkMeta.mockResolvedValue(cachedMeta)
        const { container, getByText } = render(<Organizer />)
        await waitFor(() => expect(container.querySelector('.input-bookmarks-card')).not.toBeNull())
        expect(container.querySelector('.input-bookmarks-card').textContent).toContain('b.html')
        expect(container.querySelector('.input-bookmarks-card').textContent).toContain('3,462')
        expect(getByText('Download')).toBeTruthy()
        expect(getByText('Re-organize')).toBeTruthy()
        expect(getByText('Remove')).toBeTruthy()
        expect(getByText('Download').classList.contains('input-file-action')).toBe(true)
        expect(getByText('Download').classList.contains('input-file-action-secondary')).toBe(true)
        expect(getByText('Re-organize').classList.contains('input-file-action')).toBe(true)
        expect(getByText('Re-organize').classList.contains('input-file-action-primary')).toBe(true)
        expect(getByText('Remove').classList.contains('input-file-action')).toBe(true)
        expect(getByText('Remove').classList.contains('input-file-action-danger')).toBe(true)
    })

    it('Remove clears the card and calls the service', async () => {
        chromeWith({})
        inputService.getInputBookmarkMeta.mockResolvedValue(cachedMeta)
        const { container, getByText } = render(<Organizer />)
        await waitFor(() => expect(container.querySelector('.input-bookmarks-card')).not.toBeNull())
        fireEvent.click(getByText('Remove'))
        await waitFor(() => expect(inputService.removeInputBookmarkFile).toHaveBeenCalled())
        expect(container.querySelector('.input-bookmarks-card')).toBeNull()
    })

    it('Download emits the pristine original', async () => {
        chromeWith({})
        inputService.getInputBookmarkMeta.mockResolvedValue(cachedMeta)
        const { container, getByText } = render(<Organizer />)
        await waitFor(() => expect(container.querySelector('.input-bookmarks-card')).not.toBeNull())
        fireEvent.click(getByText('Download'))
        // The card holds metadata only; the service fetches the cached HTML itself.
        expect(inputService.downloadInputBookmarkFile).toHaveBeenCalledWith(
            expect.objectContaining({ filename: 'b.html' })
        )
    })
})
