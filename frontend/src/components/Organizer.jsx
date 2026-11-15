import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Terminal, AlertCircle, Plus, X, Bookmark, Upload, FileText, Lock, Download, Loader2, RefreshCw, Square, Copy, Check, ChevronDown, ChevronUp, Clock, ArrowDown, ArrowUp, ArrowDownAZ, ArrowUpZA, Globe, FolderTree, ExternalLink, Calendar, Trash2 } from 'lucide-react'
import { parseBookmarks } from '../utils/parser'
import { calculateDateSpan } from '../utils/dates'
import { saveInputBookmarkFile, getInputBookmarkMeta, listInputBookmarkFiles, getInputBookmarkHtml, removeInputBookmarkFile, clearAllInputBookmarkFiles, downloadInputBookmarkFile } from '../services/input_bookmarks'
import { normalizeSubfolderTarget, DEFAULT_SUBFOLDER_TARGET, detectProvider } from '../services/ai'
import { saveRun, loadRunData, deleteRun, clearHistory } from '../services/runHistory'
import ReviewPanel from './ReviewPanel'
import RemoveDuplicatesButton from './RemoveDuplicatesButton'
import { Switch, Segmented } from './controls'
import subfolderHierarchyImage from '../assets/subfolder-hierarchy.png'
import subfolderHierarchyBalancedImage from '../assets/subfolder-hierarchy-balanced.png'
import subfolderHierarchyDetailedImage from '../assets/subfolder-hierarchy-detailed.png'
import subfolderHierarchyDarkImage from '../assets/subfolder-hierarchy-dark.png'
import subfolderHierarchyBalancedDarkImage from '../assets/subfolder-hierarchy-balanced-dark.png'
import subfolderHierarchyDetailedDarkImage from '../assets/subfolder-hierarchy-detailed-dark.png'

export const DEFAULT_CATEGORIES = [
    'Work & Career',
    'Finance & Crypto',
    'Design & Media',
    'Reading & Knowledge',
    'Entertainment & Social',
    'Shopping & Tools',
    'Travel & Lifestyle',
    'Tech & Development'
];

export const SUGGESTED_ADDABLE_CATEGORIES = [
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
];

const SUBFOLDER_EXPLAINER_IMAGES = {
    light: {
        compact: subfolderHierarchyImage,
        medium: subfolderHierarchyBalancedImage,
        detailed: subfolderHierarchyDetailedImage
    },
    dark: {
        compact: subfolderHierarchyDarkImage,
        medium: subfolderHierarchyBalancedDarkImage,
        detailed: subfolderHierarchyDetailedDarkImage
    }
};

/**
 * The three models offered in the picker, cheapest first; the default is the most capable (DEFAULT_MODEL_ID).
 *
 * Contract:
 * - ids are OpenRouter-namespaced; the native Gemini API strips the "google/" prefix (see geminiModelId).
 * - Keep this list at three: more choices overwhelmed users.
 */
const MODEL_OPTIONS = [
    {
        id: 'google/gemini-3.5-flash-lite',
        name: '3.5 Flash Lite',
        label: '3.5 Flash Lite',
        badge: 'Fast',
        desc: 'Fast and low-cost for large bookmark collections.',
        description: 'Fast and low-cost for large bookmark collections.'
    },
    {
        id: 'google/gemini-3.8-flash',
        name: '3.8 Flash',
        label: '3.8 Flash',
        badge: 'Balanced',
        desc: 'High intelligence & reasoning for everyday bookmark collections.',
        description: 'High intelligence & reasoning for everyday bookmark collections.'
    },
    {
        id: 'google/gemini-4-hydrogen',
        name: '4 Hydrogen',
        label: '4 Hydrogen',
        badge: 'Best',
        desc: 'Recommended default — most capable: complex taxonomies and heavy loads with rich nested structures.',
        description: 'Recommended default — most capable: complex taxonomies and heavy loads with rich nested structures.'
    },
]

const DEFAULT_MODEL_ID = 'google/gemini-4-hydrogen'

// Retired picker ids and the model that replaces each (Google shuts down 3.1 Flash Lite on 2027-05-07).
const MODEL_MIGRATIONS = {
    'google/gemini-3.1-flash-lite': 'google/gemini-3.5-flash-lite',
    'google/gemini-3.1-pro-preview': 'google/gemini-4-hydrogen',
    'google/gemini-2.5-pro': 'google/gemini-4-hydrogen',
}

/**
 * Maps a stored model id to one the picker offers.
 *
 * Contract:
 * - Returns the id if offered, its replacement if retired, null for anything else (caller keeps its default).
 */
function resolveModelId(id) {
    const migrated = MODEL_MIGRATIONS[id] || id
    return MODEL_OPTIONS.some((m) => m.id === migrated) ? migrated : null
}

export const SCHEMA_SORT_OPTIONS = [
    {
        id: 'alpha',
        label: 'Alphabetical (A–Z)',
        short: 'A–Z',
        badge: 'Default',
        icon: ArrowDownAZ,
        desc: 'Folders and bookmarks sorted alphabetically by title A to Z.'
    },
    {
        id: 'date-desc',
        label: 'Date Added (Newest First)',
        short: 'Newest first',
        badge: 'Recent',
        icon: ArrowDown,
        desc: 'Folders sorted A–Z; newest bookmarks at the top of each folder.'
    },
    {
        id: 'date-asc',
        label: 'Date Added (Oldest First)',
        short: 'Oldest first',
        badge: 'Archive',
        icon: ArrowUp,
        desc: 'Folders sorted A–Z; earliest saved bookmarks at the top of each folder.'
    },
    {
        id: 'domain',
        label: 'By Website / Domain (A–Z)',
        short: 'Domain A–Z',
        badge: 'Grouped',
        icon: Globe,
        desc: 'Groups bookmarks by domain (e.g. github.com, youtube.com), then title.'
    }
];


// Synchronous in-process memory reader (0.05ms latency, zero IPC overhead)
const getStored = (key, fallback) => {
    try {
        const item = localStorage.getItem(key);
        return item !== null ? JSON.parse(item) : fallback;
    } catch {
        return fallback;
    }
};

// Second precision makes a run timestamp read like bookmark data, so it is dropped.
const formatRunTime = (timestamp) => new Date(timestamp).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
});

// Metadata persisted before the range became unconditional holds a single bare date.
const formatDateSpan = (span) => {
    if (!span) return '';
    return (span.includes(' – ') || span.includes(' - ')) ? span : `${span} – ${span}`;
};

// Shown when the panel reopens and the session snapshot says the previous
// run was cut off before it could finish.
const INTERRUPTED_RUN_NOTICE = 'Your previous organization run was interrupted before it could complete and its results may be incomplete. Re-run to continue.';

export default function Organizer({ theme = 'light' }) {
    const [status, setStatus] = useState('idle') // idle, processing, complete, error
    const [logs, setLogs] = useState([])
    const [progress, setProgress] = useState(0)
    const [errorMsg, setErrorMsg] = useState('')
    const [backgroundNotice, setBackgroundNotice] = useState('')
    const [isCancelling, setIsCancelling] = useState(false)
    const organizedResultsRef = useRef(null)
    const [lastOrganized, setLastOrganized] = useState(null)
    // Older saved runs (newest first); the latest run is `lastOrganized`.
    const [previousRuns, setPreviousRuns] = useState([])
    const [activeDateSpan, setActiveDateSpan] = useState(null)
    const [showSchema, setShowSchema] = useState(true)
    const [showIdleSchema, setShowIdleSchema] = useState(false)
    const [copiedSchema, setCopiedSchema] = useState(false)

    const handleCopySchema = useCallback((breakdown) => {
        if (!breakdown) return
        const text = Object.entries(breakdown)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([cat, count]) => `${cat}: ${count}`)
            .join('\n')
        navigator.clipboard?.writeText(text).then(() => {
            setCopiedSchema(true)
            setTimeout(() => setCopiedSchema(false), 2000)
        })
    }, [])

    // API Key — synchronous in-process memory initialization (0ms delay)
    const [apiKey, setApiKey] = useState(() => {
        try { return localStorage.getItem('apiKey') || '' } catch { return '' }
    })

    // Auto-detect provider from key format
    const provider = useMemo(() => detectProvider(apiKey), [apiKey])

    // Models supported for Google Gemini (see MODEL_OPTIONS)
    const models = MODEL_OPTIONS

    const [selectedModel, setSelectedModel] = useState(() => {
        try {
            return resolveModelId(localStorage.getItem('selectedModel')) || DEFAULT_MODEL_ID
        } catch {
            return DEFAULT_MODEL_ID
        }
    })

    // Manual categories remain saved even while run-scoped inference is active.
    const [categories, setCategories] = useState(() => getStored('categories', []))
    const [inferCategories, setInferCategories] = useState(() => getStored('inferCategories', true))
    const [newCategory, setNewCategory] = useState('')

    // Suggested Categories not yet in active categories
    const availableSuggestions = useMemo(() =>
        SUGGESTED_ADDABLE_CATEGORIES.filter(s => !categories.some(c => c.toLowerCase() === s.toLowerCase())),
        [categories]
    )

    // Folder Content Sorting inside schema folders (alpha, date-desc, date-asc, domain)
    const [schemaSortOrder, setSchemaSortOrder] = useState(() => {
        try {
            const s = localStorage.getItem('schemaSortOrder')
            return s && SCHEMA_SORT_OPTIONS.some(opt => opt.id === s) ? s : 'alpha'
        } catch {
            return 'alpha'
        }
    })
    const sortAlphabetically = schemaSortOrder === 'alpha'

    // Keep only one copy of each exact URL in the organized output.
    const [removeDuplicates, setRemoveDuplicates] = useState(() => getStored('removeDuplicates', true))
    // Pause for review: the proposed folders before anything is filed, and the finished folders before they are saved.
    const [reviewFolders, setReviewFolders] = useState(() => getStored('reviewFolders', false))
    const [planForReview, setPlanForReview] = useState(null) // { categories, error? } while the worker waits for a plan decision
    const planResolverRef = useRef(null)
    const [resultForReview, setResultForReview] = useState(null) // { rows, error? } while the worker waits for a result decision
    const resultResolverRef = useRef(null)

    // Clean messy or truncated titles with AI
    const [cleanTitles, setCleanTitles] = useState(() => getStored('cleanTitles', false))

    // Flat chronological sort by date added — ALWAYS false by default on launch
    const [flatDateSort, setFlatDateSort] = useState(false)
    const [dateSortOrder, setDateSortOrder] = useState(() => {
        try {
            const o = localStorage.getItem('dateSortOrder')
            return o === 'asc' || o === 'desc' ? o : 'desc'
        } catch {
            return 'desc'
        }
    })
    const [flatSortType, setFlatSortType] = useState(() => {
        try {
            const t = localStorage.getItem('flatSortType')
            return t === 'alpha' || t === 'date' ? t : 'date'
        } catch {
            return 'date'
        }
    })
    const [alphaSortOrder, setAlphaSortOrder] = useState(() => {
        try {
            const o = localStorage.getItem('alphaSortOrder')
            return o === 'desc' || o === 'asc' ? o : 'asc'
        } catch {
            return 'asc'
        }
    })

    // Subfolder Target Size — the three choices are relative pressure levels,
    // not folder-count promises: the AI measures each category's material per
    // run and derives the depth from it. The diagrams illustrate the
    // separation between the levels.
    const subfolderTargetOptions = useMemo(() => [
        { id: 'compact', label: 'Compact', description: 'Fewer, broader subfolders; only the clearest groups' },
        { id: 'medium', label: 'Medium', description: 'Recommended — balanced depth that grows with each category\'s material' },
        { id: 'detailed', label: 'Detailed', description: 'Many specific subfolders so every bookmark has a precise home' }
    ], [])
    const [subfolderTarget, setSubfolderTarget] = useState(() => {
        try {
            return normalizeSubfolderTarget(localStorage.getItem('subfolderTarget'))
        } catch {
            return DEFAULT_SUBFOLDER_TARGET
        }
    })
    const subfolderOptions = subfolderTargetOptions

    const logContainerRef = useRef(null)
    const organizerRef = useRef(null)
    const portRef = useRef(null)
    const resultsRequestPendingRef = useRef(false)
    const cancelRequestedRef = useRef(false)
    const completionTimerRef = useRef(null)
    const returnToMenuRef = useRef(null)
    const statusRef = useRef('idle')
    const logsRef = useRef([])
    // Stops the in-panel fallback run's pagehide listeners, set while such a
    // run is live. Unmount must drop them even if the run never reached a
    // terminal state — a closing panel fires pagehide before unmounting, so
    // this only ever cleans up after that snapshot rewrite has happened.
    const endPanelRunRef = useRef(null)
    // True while the panel waits for the worker's JOB_ACK. A replacement
    // port immediately receives the worker's connect-time STATUS_UPDATE
    // (idle), which must not reset the run state mid-handshake.
    const awaitingAckRef = useRef(false)
    useEffect(() => { statusRef.current = status }, [status])
    const cancellingRef = useRef(false)
    useEffect(() => { cancellingRef.current = isCancelling }, [isCancelling])
    useEffect(() => { logsRef.current = logs }, [logs])
    useEffect(() => () => {
        if (endPanelRunRef.current) {
            endPanelRunRef.current()
            endPanelRunRef.current = null
        }
    }, [])

    // How long the panel waits for the service worker to acknowledge a
    // START_JOB before assuming the port is dead and running the job in
    // the panel itself.
    const BACKGROUND_ACK_TIMEOUT_MS = 2500

    // How long the completion summary stays up before the app leaves
    // organization mode and returns to the main menu.
    const RETURN_TO_MENU_DELAY_MS = 10000

    // Organization mode is transient: after a run completes, leave the
    // completion summary up briefly, then hand control back to the main
    // menu (the last-run banner keeps the results downloadable there).
    // This is deliberately separate from an explicit reset, which clears the
    // worker's completed result cache.
    const scheduleReturnToMenu = useCallback(() => {
        if (completionTimerRef.current) clearTimeout(completionTimerRef.current)
        completionTimerRef.current = setTimeout(() => {
            completionTimerRef.current = null
            if (returnToMenuRef.current) returnToMenuRef.current()
        }, RETURN_TO_MENU_DELAY_MS)
    }, [])

    // Attaches the full job-state listener set to a port. Every port this
    // panel uses must be wired — the mount-time port and any port reconnected
    // after the service worker (and the old port with it) died, otherwise
    // progress and terminal updates are broadcast into a port nobody hears.
    const wirePort = useCallback((port) => {
        if (!port) return;

        // The worker's job lived only in its memory, so once the worker is gone the run cannot resume.
        const showInterrupted = () => {
            resultsRequestPendingRef.current = false
            setIsCancelling(false);
            setStatus('idle');
            setProgress(0);
            setBackgroundNotice(INTERRUPTED_RUN_NOTICE);
            if (!planResolverRef.current) setPlanForReview(null);
            if (!resultResolverRef.current) setResultForReview(null);
        };

        port.onMessage.addListener((msg) => {
            if (!msg || !msg.type) return;

            if (msg.type === 'STATUS_UPDATE') {
                const state = msg.payload;
                if (!state) return;

                // An in-panel run (worker did not acknowledge) owns its review cards; the worker's idle
                // updates must not clear them while the run still waits for an answer.
                if (!planResolverRef.current) setPlanForReview(state.status === 'processing' ? (state.plan || null) : null);
                if (!resultResolverRef.current) setResultForReview(state.status === 'processing' ? (state.result || null) : null);

                if (state.status === 'processing') {
                    resultsRequestPendingRef.current = false
                    setStatus('processing');
                    if (typeof state.progress === 'number') setProgress(Math.min(99, Math.max(0, state.progress)));
                    if (state.activeDateSpan) setActiveDateSpan(state.activeDateSpan);
                    if (state.backgroundNotice !== undefined) setBackgroundNotice(state.backgroundNotice);
                    if (Array.isArray(state.logs) && state.logs.length > 0) {
                        setLogs(state.logs.map(l => ({
                            message: l.message,
                            timestamp: new Date(l.timestamp)
                        })));
                    }
                } else if (state.status === 'complete' && state.id) {
                    if (state.activeDateSpan) setActiveDateSpan(state.activeDateSpan);
                    setStatus('complete');
                    setProgress(100);
                    scheduleReturnToMenu();
                    if (Array.isArray(state.logs) && state.logs.length > 0) {
                        setLogs(state.logs.map(l => ({
                            message: l.message,
                            timestamp: new Date(l.timestamp)
                        })));
                    }
                    if (!organizedResultsRef.current) {
                        resultsRequestPendingRef.current = true
                        try {
                            port.postMessage({ type: 'GET_RESULTS' })
                        } catch {
                            resultsRequestPendingRef.current = false
                        }
                    }
                    if (!organizedResultsRef.current && chrome.storage?.session) {
                        chrome.storage.session.get(['organizedData'], (sRes) => {
                            if (sRes?.organizedData) {
                                organizedResultsRef.current = sRes.organizedData;
                            }
                        });
                    }
                } else if (state.status === 'error') {
                    resultsRequestPendingRef.current = false
                    setStatus('error');
                    setErrorMsg(state.errorMsg || 'Failed to complete background organization.');
                    setBackgroundNotice('');
                } else if (state.status === 'interrupted') {
                    showInterrupted();
                } else if (state.status === 'idle') {
                    resultsRequestPendingRef.current = false
                    setIsCancelling(false);
                    // The panel shows a worker run in progress but the worker has
                    // no job: it was killed mid-run (the watchdog's reconnect wakes a
                    // fresh worker), so say the run was interrupted rather than
                    // silently returning to the menu — unless the user cancelled it.
                    // Skipped during the ACK handshake: a freshly reconnected
                    // port receives the worker's connect-time idle snapshot
                    // before the job we are starting has been seen.
                    if (!awaitingAckRef.current && statusRef.current === 'processing' && !organizerRef.current) {
                        if (cancellingRef.current) {
                            setStatus('idle');
                            setProgress(0);
                            setBackgroundNotice('');
                        } else {
                            showInterrupted();
                        }
                    }
                }
            } else if (msg.type === 'JOB_RESULTS') {
                resultsRequestPendingRef.current = false
                const { results, meta } = msg.payload || {};
                if (Array.isArray(results) && results.length > 0) {
                    organizedResultsRef.current = results;
                    if (meta) {
                        setLastOrganized(meta);
                        const span = meta.stats?.dateSpan || meta.dateSpan;
                        if (span) setActiveDateSpan(span);
                    }
                    setStatus('complete');
                    setProgress(100);
                    setBackgroundNotice('');
                    scheduleReturnToMenu();
                }
            } else if (msg.type === 'JOB_RESULTS_UNAVAILABLE') {
                if (!resultsRequestPendingRef.current) return
                resultsRequestPendingRef.current = false
                organizedResultsRef.current = null;
                setLastOrganized(null);
                setStatus('error');
                setProgress(0);
                setErrorMsg(msg.payload?.message || 'Organized results are no longer available. Run organization again.');
                setBackgroundNotice('');
                if (completionTimerRef.current) {
                    clearTimeout(completionTimerRef.current);
                    completionTimerRef.current = null;
                }
            } else if (msg.type === 'JOB_COMPLETE') {
                resultsRequestPendingRef.current = false
                const { results, meta } = msg.payload || {};
                if (results) organizedResultsRef.current = results;
                if (meta) {
                    setLastOrganized(meta);
                    const span = meta.stats?.dateSpan || meta.dateSpan;
                    if (span) setActiveDateSpan(span);
                }
                setStatus('complete');
                setProgress(100);
                setBackgroundNotice('');
                scheduleReturnToMenu();
            } else if (msg.type === 'JOB_ERROR') {
                resultsRequestPendingRef.current = false
                setStatus('error');
                setErrorMsg(msg.payload?.message || 'Failed to complete background organization.');
                setBackgroundNotice('');
            } else if (msg.type === 'JOB_CANCELLED') {
                resultsRequestPendingRef.current = false
                setStatus('idle');
                setIsCancelling(false);
                setProgress(0);
            }
        });

        port.onDisconnect.addListener(() => {
            resultsRequestPendingRef.current = false
            // A replacement port may already be wired by the time a stale
            // port disconnects — never null out the live one.
            if (portRef.current === port) {
                portRef.current = null;
            }
        });
    }, [scheduleReturnToMenu]);

    // Background job connection & state restoration hook
    useEffect(() => {
        const t0 = performance.now()
        const mark = (label) => console.log(`[Startup] ${label} +${(performance.now() - t0).toFixed(1)}ms`)
        mark('panel mounted')

        // 1. Initial check of session storage to restore any in-flight background job
        //    instantly. Only the tiny job-state record is read here — the full
        //    organized results are fetched on demand when the user downloads them.
        if (typeof chrome !== 'undefined' && chrome.storage?.session) {
            try {
                chrome.storage.session.get(['activeJobState'], (res) => {
                    mark('session job state restored')
                    if (res?.activeJobState) {
                        const aj = res.activeJobState;
                        if (aj.status === 'processing') {
                            setStatus('processing');
                            if (aj.plan) setPlanForReview(aj.plan);
                            if (aj.result) setResultForReview(aj.result);
                            if (typeof aj.progress === 'number') setProgress(Math.min(99, Math.max(0, aj.progress)));
                            if (aj.activeDateSpan) setActiveDateSpan(aj.activeDateSpan);
                            if (aj.backgroundNotice !== undefined) setBackgroundNotice(aj.backgroundNotice);
                            if (Array.isArray(aj.logs) && aj.logs.length > 0) {
                                setLogs(aj.logs.map(l => ({
                                    message: l.message,
                                    timestamp: new Date(l.timestamp)
                                })));
                            }
                        } else if (aj.status === 'complete') {
                            if (aj.activeDateSpan) setActiveDateSpan(aj.activeDateSpan);
                            setStatus('complete');
                            setProgress(100);
                            scheduleReturnToMenu();
                            if (Array.isArray(aj.logs) && aj.logs.length > 0) {
                                setLogs(aj.logs.map(l => ({
                                    message: l.message,
                                    timestamp: new Date(l.timestamp)
                                })));
                            }
                        } else if (aj.status === 'interrupted') {
                            setBackgroundNotice(INTERRUPTED_RUN_NOTICE);
                        }
                    }
                });
            } catch {}
        }

        // 2. Connect port to service worker for live progress and background execution
        if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
            try {
                const port = chrome.runtime.connect({ name: 'organizer-channel' });
                wirePort(port);
                portRef.current = port;
                mark('background channel connected')

                // Request state only after the listener is attached. A completed state
                // response will request transient results; idle panels never request them.
                try { port.postMessage({ type: 'GET_STATUS' }) } catch {}
            } catch (err) {
                console.warn('[Organizer] Failed to connect to background channel:', err);
            }
        }

        return () => {
            resultsRequestPendingRef.current = false
            if (completionTimerRef.current) {
                clearTimeout(completionTimerRef.current);
                completionTimerRef.current = null;
            }
            if (portRef.current) {
                try { portRef.current.disconnect(); } catch {}
                portRef.current = null;
            }
        };
    }, [scheduleReturnToMenu, wirePort]);

    // Watchdog: port messages can be dropped while the service worker is
    // busy or restarting, so re-poll its state periodically while a run is
    // active. Keeps the progress bar and terminal from going stale. If the
    // port died (the service worker it belonged to was suspended), reconnect
    // and wire it so the panel resyncs instead of polling a dead channel.
    useEffect(() => {
        if (status !== 'processing') return;
        const watchdog = setInterval(() => {
            if (portRef.current) {
                try { portRef.current.postMessage({ type: 'GET_STATUS' }); } catch {}
            } else if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
                try {
                    const port = chrome.runtime.connect({ name: 'organizer-channel' });
                    wirePort(port);
                    portRef.current = port;
                    port.postMessage({ type: 'GET_STATUS' });
                } catch {}
            }
        }, 10000);
        return () => clearInterval(watchdog);
    }, [status, wirePort]);

    // Non-blocking background sync from chrome.storage (runs AFTER UI is already painted)
    useEffect(() => {
        const startTime = performance.now()
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            chrome.storage.local.get(['apiKey', 'categories', 'inferCategories', 'selectedModel', 'subfolderTarget', 'sortAlphabetically', 'schemaSortOrder', 'removeDuplicates', 'cleanTitles', 'dateSortOrder', 'reviewFolders', 'organizedMeta', 'organizedHistory'], (result) => {
                if (!result) return
                if (result.apiKey) setApiKey(prev => (prev !== result.apiKey ? result.apiKey : prev))
                if (Array.isArray(result.categories)) {
                    setCategories(result.categories)
                    try { localStorage.setItem('categories', JSON.stringify(result.categories)) } catch {}
                }
                if (typeof result.inferCategories === 'boolean') {
                    setInferCategories(result.inferCategories)
                    try { localStorage.setItem('inferCategories', JSON.stringify(result.inferCategories)) } catch {}
                }
                const storedModel = resolveModelId(result.selectedModel)
                if (storedModel) {
                    setSelectedModel(storedModel)
                    try { localStorage.setItem('selectedModel', storedModel) } catch {}
                    // Persist a migrated choice so retired ids are not re-read next load.
                    if (storedModel !== result.selectedModel) chrome.storage.local.set({ selectedModel: storedModel })
                }
                if (result.subfolderTarget) {
                    const normalizedTarget = normalizeSubfolderTarget(result.subfolderTarget)
                    setSubfolderTarget(normalizedTarget)
                    try { localStorage.setItem('subfolderTarget', normalizedTarget) } catch {}
                    if (normalizedTarget !== result.subfolderTarget) {
                        chrome.storage.local.set({ subfolderTarget: normalizedTarget })
                    }
                }
                if (result.schemaSortOrder && SCHEMA_SORT_OPTIONS.some(opt => opt.id === result.schemaSortOrder)) {
                    setSchemaSortOrder(result.schemaSortOrder)
                    try { localStorage.setItem('schemaSortOrder', result.schemaSortOrder) } catch {}
                } else if (typeof result.sortAlphabetically === 'boolean') {
                    const fallbackOrder = result.sortAlphabetically ? 'alpha' : 'date-desc'
                    setSchemaSortOrder(fallbackOrder)
                    try { localStorage.setItem('schemaSortOrder', fallbackOrder) } catch {}
                }
                if (typeof result.removeDuplicates === 'boolean') {
                    setRemoveDuplicates(result.removeDuplicates)
                    try { localStorage.setItem('removeDuplicates', JSON.stringify(result.removeDuplicates)) } catch {}
                }
                if (typeof result.reviewFolders === 'boolean') {
                    setReviewFolders(result.reviewFolders)
                    try { localStorage.setItem('reviewFolders', JSON.stringify(result.reviewFolders)) } catch {}
                }
                if (result.cleanTitles !== undefined) {
                    setCleanTitles(Boolean(result.cleanTitles))
                    try { localStorage.setItem('cleanTitles', JSON.stringify(Boolean(result.cleanTitles))) } catch {}
                }
                if (result.dateSortOrder === 'asc' || result.dateSortOrder === 'desc') {
                    setDateSortOrder(result.dateSortOrder)
                    try { localStorage.setItem('dateSortOrder', result.dateSortOrder) } catch {}
                }
                if (Array.isArray(result.organizedHistory)) setPreviousRuns(result.organizedHistory)
                if (result.organizedMeta) {
                    const meta = result.organizedMeta
                    setLastOrganized(meta)
                    const span = meta.stats?.dateSpan || meta.dateSpan
                    if (span) {
                        setActiveDateSpan(span)
                    } else if (chrome.storage?.session) {
                        chrome.storage.session.get(['organizedData'], (sRes) => {
                            if (sRes?.organizedData && sRes.organizedData.length > 0) {
                                const computedSpan = calculateDateSpan(sRes.organizedData)
                                if (computedSpan) {
                                    const updatedMeta = {
                                        ...meta,
                                        stats: { ...(meta.stats || {}), dateSpan: computedSpan },
                                        dateSpan: computedSpan
                                    }
                                    setLastOrganized(updatedMeta)
                                    setActiveDateSpan(computedSpan)
                                    chrome.storage.local.set({ organizedMeta: updatedMeta })
                                }
                            }
                        })
                    }
                }

                console.log(`[Startup] Side panel ready & synced in ${(performance.now() - startTime).toFixed(1)}ms`)
            })

            // Defer LevelDB cleanup to idle time (3s delay) so disk I/O NEVER competes with window opening
            const cleanupTimer = setTimeout(() => {
                chrome.storage.local.remove(['flatDateSort'])
            }, 3000)
            return () => clearTimeout(cleanupTimer)
        }
    }, [])

    // The background worker saves each finished run; follow its history list live.
    useEffect(() => {
        const onChanged = typeof chrome !== 'undefined' ? chrome.storage?.onChanged : null
        if (!onChanged?.addListener) return undefined
        const listener = (changes, area) => {
            if (area === 'local' && changes.organizedHistory) setPreviousRuns(changes.organizedHistory.newValue || [])
        }
        onChanged.addListener(listener)
        return () => onChanged.removeListener?.(listener)
    }, [])

    // Warm the lazy organize pipeline after first paint so clicking
    // Organize is never slower than the old eager bundle.
    useEffect(() => {
        const idle = window.requestIdleCallback || (cb => setTimeout(cb, 200))
        idle(() => {
            import('../services/organizer')
            import('../services/bookmarks_export')
        })
    }, [])

    // Save Settings to both in-process memory and chrome.storage
    const updateSetting = useCallback((key, val) => {
        try {
            if (typeof val === 'string') localStorage.setItem(key, val)
            else localStorage.setItem(key, JSON.stringify(val))
        } catch {}
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            chrome.storage.local.set({ [key]: val })
        }
    }, [])

    const handleApiKeyChange = useCallback((val) => {
        setApiKey(val)
        updateSetting('apiKey', val)
    }, [updateSetting])

    const handleModelChange = useCallback((modelId) => {
        setSelectedModel(modelId)
        updateSetting('selectedModel', modelId)
    }, [updateSetting])

    const handleSubfolderTargetChange = useCallback((target) => {
        setSubfolderTarget(target)
        updateSetting('subfolderTarget', target)
    }, [updateSetting])

    const handleSchemaSortChange = useCallback((newOrder) => {
        setSchemaSortOrder(newOrder)
        updateSetting('schemaSortOrder', newOrder)
        updateSetting('sortAlphabetically', newOrder === 'alpha')
    }, [updateSetting])

    const handleReviewFoldersToggle = useCallback((enabled) => {
        setReviewFolders(enabled)
        updateSetting('reviewFolders', enabled)
    }, [updateSetting])

    const handleRemoveDuplicatesToggle = useCallback((enabled) => {
        setRemoveDuplicates(enabled)
        updateSetting('removeDuplicates', enabled)
    }, [updateSetting])

    const handleCleanTitlesToggle = useCallback((enabled) => {
        setCleanTitles(enabled)
        updateSetting('cleanTitles', enabled)
    }, [updateSetting])

    const handleInferCategoriesToggle = useCallback((enabled) => {
        setInferCategories(enabled)
        updateSetting('inferCategories', enabled)
    }, [updateSetting])

    const handleFlatDateSortToggle = useCallback((enabled) => {
        setFlatDateSort(enabled)
    }, [])

    const handleDateSortOrderChange = useCallback((order) => {
        setDateSortOrder(order)
        updateSetting('dateSortOrder', order)
    }, [updateSetting])

    const handleFlatSortTypeChange = useCallback((type) => {
        setFlatSortType(type)
        updateSetting('flatSortType', type)
    }, [updateSetting])

    const handleAlphaSortOrderChange = useCallback((order) => {
        setAlphaSortOrder(order)
        updateSetting('alphaSortOrder', order)
    }, [updateSetting])

    const handleAddCategory = useCallback((catName) => {
        const trimmed = (catName || '').trim();
        if (!trimmed) return;
        if (categories.some(c => c.toLowerCase() === trimmed.toLowerCase())) return;
        const next = [...categories, trimmed];
        setCategories(next);
        updateSetting('categories', next);
    }, [categories, updateSetting]);

    const handleRemoveCategory = useCallback((indexToRemove) => {
        const next = categories.filter((_, i) => i !== indexToRemove);
        setCategories(next);
        updateSetting('categories', next);
    }, [categories, updateSetting]);

    const handleClearAllCategories = useCallback(() => {
        setCategories([]);
        updateSetting('categories', []);
    }, [updateSetting]);

    const handleResetDefaultCategories = useCallback(() => {
        setCategories(DEFAULT_CATEGORIES);
        updateSetting('categories', DEFAULT_CATEGORIES);
    }, [updateSetting]);

    // File Upload Handlers
    const [uploadedFile, setUploadedFile] = useState(null)
    const [parsedBookmarks, setParsedBookmarks] = useState(null)
    const [inputFile, setInputFile] = useState(null)
    const [inputFiles, setInputFiles] = useState([])
    const fileInputRef = useRef(null)

    const addLog = useCallback((message) => {
        setLogs(prev => [...prev, { message, timestamp: new Date() }])
    }, [])

    // Says where a download went, since a download manager can save silently.
    const reportSave = useCallback((result) => {
        if (result?.status === 'saved') addLog(`Saved ${result.name}.`)
        else if (result?.status === 'started') addLog('Download started — it will appear in your browser\'s Downloads.')
        else if (result?.status === 'cancelled') addLog('Save cancelled.')
    }, [addLog])

    const processFile = useCallback((file) => {
        if (!file.name.endsWith('.html') && !file.name.endsWith('.htm')) {
            setErrorMsg("Please upload a valid bookmarks HTML file.");
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target.result;
            try {
                const links = parseBookmarks(content);
                const span = calculateDateSpan(links);
                setUploadedFile(file);
                setParsedBookmarks(links);
                saveInputBookmarkFile({ filename: file.name, html: content, count: links.length, dateSpan: span })
                    .then((res) => {
                    if (res.saved) {
                        setInputFile(res.entry);
                        setInputFiles((prev) => [res.entry, ...prev.filter((entry) => entry.id !== res.entry.id)]);
                        addLog(`Saved ${file.name} to persistent storage — downloadable and re-organizable anytime.`);
                    } else {
                        addLog(`Could not cache the input file: ${res.reason}`);
                    }
                })
                    .catch(() => addLog('Could not cache the input file locally.'))
                if (span) setActiveDateSpan(span);
                setErrorMsg('');
                addLog(`Loaded ${file.name} (${links.length.toLocaleString()} bookmarks found${span ? ` · Dates ${span}` : ''})`);
            } catch (err) {
                console.error(err);
                setErrorMsg("Failed to parse bookmarks file.");
            }
        };
        reader.readAsText(file);
    }, [addLog])

    const handleFileSelect = useCallback(async (e) => {
        const file = e.target.files[0];
        if (file) processFile(file);
    }, [processFile])

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) processFile(file);
    }, [processFile])

    const handleDragOver = useCallback((e) => {
        e.preventDefault();
    }, [])

    // Restore the cached dropped-in file (spec §12) on mount. Only the tiny
    // metadata record is read here; the multi-megabyte HTML is fetched from
    // storage on demand (download / re-organize) so panel startup stays fast.
    useEffect(() => {
        const t = performance.now()
        listInputBookmarkFiles()
            .then((list) => {
                console.log(`[Startup] input card metadata restored +${(performance.now() - t).toFixed(1)}ms`)
                if (Array.isArray(list) && list.length > 0) {
                    setInputFiles(list)
                    setInputFile(list[0])
                } else {
                    getInputBookmarkMeta().then((entry) => {
                        if (entry) {
                            setInputFile(entry)
                            setInputFiles([entry])
                        }
                    }).catch(() => {})
                }
            })
            .catch(() => {
                getInputBookmarkMeta().then((entry) => {
                    if (entry) {
                        setInputFile(entry)
                        setInputFiles([entry])
                    }
                }).catch(() => {})
            })
    }, [])

    const handleDownloadInput = useCallback((entryToDownload) => {
        const target = (entryToDownload && typeof entryToDownload.filename === 'string') ? entryToDownload : inputFile
        if (target) Promise.resolve(downloadInputBookmarkFile(target)).then(reportSave).catch((err) => addLog(`Could not save the input file: ${err.message}`))
    }, [inputFile, reportSave, addLog])

    const handleReorganizeInput = useCallback(async (entryToReorganize) => {
        const target = (entryToReorganize && typeof entryToReorganize.filename === 'string') ? entryToReorganize : inputFile
        if (!target) return
        try {
            const html = (typeof target.html === 'string' && target.html.length > 0)
                ? target.html
                : await getInputBookmarkHtml(target.id)
            if (!html) {
                setErrorMsg('Cached input file content is missing — drop the file in again.')
                return
            }
            const links = parseBookmarks(html)
            const span = calculateDateSpan(links)
            setParsedBookmarks(links)
            setInputFile(target)
            setUploadedFile({ name: target.filename })
            setStatus('idle')
            if (span) setActiveDateSpan(span)
            setErrorMsg('')
            addLog(`Re-loaded ${target.filename} from cached input (${links.length.toLocaleString()} bookmarks)`)
        } catch (err) {
            console.error(err)
            setErrorMsg('Cached input file could not be parsed.')
        }
    }, [inputFile, addLog])

    const handleRemoveInput = useCallback(async (entryToRemove) => {
        const target = (entryToRemove && typeof entryToRemove.filename === 'string') ? entryToRemove : inputFile
        if (!target) return
        try {
            const updated = await removeInputBookmarkFile(target.id)
            const nextList = Array.isArray(updated) ? updated : []
            setInputFiles(nextList)
            if (!entryToRemove || !inputFile || inputFile.id === target.id) {
                setInputFile(nextList.length > 0 ? nextList[0] : null)
            }
            addLog(`Removed ${target.filename} from persistent storage.`)
        } catch {
            setInputFile(null)
            setInputFiles([])
        }
    }, [inputFile, addLog])

    const clearAllInputFiles = useCallback(async () => {
        if (!window.confirm('Delete all saved input bookmark files? This cannot be undone.')) return
        await clearAllInputBookmarkFiles()
        setInputFile(null)
        setInputFiles([])
        addLog('All saved input files removed from storage.')
    }, [addLog])

    // Auto-scroll logs
    useEffect(() => {
        if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
        }
    }, [logs])

    const downloadOrganized = useCallback(async () => {
        const { downloadBookmarks } = await import('../services/bookmarks_export')
        const doDownload = (data) => {
            const span = calculateDateSpan(data) || lastOrganized?.stats?.dateSpan || lastOrganized?.dateSpan || activeDateSpan;
            addLog(`Downloading ${data.length.toLocaleString()} bookmarks${span ? ` (Dates ${span})` : ''}...`);
            if (span && !lastOrganized?.stats?.dateSpan) {
                const updatedMeta = {
                    ...lastOrganized,
                    stats: { ...(lastOrganized?.stats || {}), dateSpan: span },
                    dateSpan: span
                };
                setLastOrganized(updatedMeta);
                if (typeof chrome !== 'undefined' && chrome.storage?.local) {
                    chrome.storage.local.set({ organizedMeta: updatedMeta });
                }
            }
            const filename = lastOrganized?.filename || data.filename;
            const saving = filename ? downloadBookmarks(data, filename) : downloadBookmarks(data);
            Promise.resolve(saving).then(reportSave).catch((err) => addLog(`Could not save the file: ${err.message}`));
        };

        if (organizedResultsRef.current) {
            doDownload(organizedResultsRef.current);
            return;
        }
        if (typeof chrome !== 'undefined' && chrome.storage) {
            const retrieve = (data) => {
                if (data && data.length > 0) {
                    organizedResultsRef.current = data;
                    doDownload(data);
                } else {
                    setErrorMsg('No saved organized bookmarks found.');
                    setLastOrganized(null);
                }
            };

            if (chrome.storage.session) {
                chrome.storage.session.get(['organizedData'], (res) => {
                    if (res?.organizedData && res.organizedData.length > 0) {
                        retrieve(res.organizedData);
                    } else if (chrome.storage.local) {
                        chrome.storage.local.get(['organizedData'], (localRes) => {
                            if (localRes?.organizedData && localRes.organizedData.length > 0) {
                                retrieve(localRes.organizedData);
                            } else {
                                retrieve(null);
                            }
                        });
                    } else {
                        retrieve(null);
                    }
                });
            } else if (chrome.storage.local) {
                chrome.storage.local.get(['organizedData'], (localRes) => {
                    if (localRes?.organizedData && localRes.organizedData.length > 0) {
                        retrieve(localRes.organizedData);
                    } else {
                        retrieve(null);
                    }
                });
            }
        }
    }, [addLog, reportSave, lastOrganized, activeDateSpan])

    const downloadPreviousRun = useCallback(async (entry) => {
        const data = await loadRunData(entry.id)
        if (!data) {
            addLog(`The run from ${formatRunTime(entry.savedAt)} is no longer saved.`)
            return
        }
        const { downloadBookmarks } = await import('../services/bookmarks_export')
        addLog(`Downloading ${data.length.toLocaleString()} bookmarks from ${formatRunTime(entry.savedAt)}...`)
        try {
            reportSave(await (entry.filename ? downloadBookmarks(data, entry.filename) : downloadBookmarks(data)))
        } catch (err) {
            addLog(`Could not save the file: ${err.message}`)
        }
    }, [addLog, reportSave])

    const removePreviousRun = useCallback(async (entry) => {
        if (!window.confirm(`Delete the run from ${formatRunTime(entry.savedAt)}? This cannot be undone.`)) return
        setPreviousRuns(await deleteRun(entry.id))
    }, [])

    const clearPreviousRuns = useCallback(async () => {
        if (!window.confirm('Delete all previous runs? The latest run is kept. This cannot be undone.')) return
        await clearHistory()
        setPreviousRuns([])
    }, [])

    // Answer a review pause. In-panel runs resolve the waiting promise directly; worker runs get a port message.
    const decideReview = useCallback((kind, decision, data = {}) => {
        const answer = { decision, ...data }
        const resolverRef = kind === 'plan' ? planResolverRef : resultResolverRef
        const clearCard = () => (kind === 'plan' ? setPlanForReview(null) : setResultForReview(null))
        if (resolverRef.current) {
            const resolve = resolverRef.current
            resolverRef.current = null
            clearCard()
            resolve(answer)
            return
        }
        // Worker run: keep the card until the decision was actually handed over.
        try {
            if (!portRef.current) throw new Error('no port')
            portRef.current.postMessage({ type: kind === 'plan' ? 'PLAN_DECISION' : 'RESULT_DECISION', payload: answer })
            clearCard()
        } catch {
            addLog('Lost contact with the background worker. Reconnecting; try again in a moment.')
        }
    }, [addLog])

    const handleCancel = useCallback(() => {
        cancelRequestedRef.current = true;
        if (planResolverRef.current) decideReview('plan', 'cancel')
        if (resultResolverRef.current) decideReview('result', 'cancel')
        resultsRequestPendingRef.current = false
        if (portRef.current) {
            try {
                portRef.current.postMessage({ type: 'CANCEL_JOB' });
            } catch {}
        }
        if (organizerRef.current) {
            organizerRef.current.cancel();
        }
        setIsCancelling(true);
        addLog('Cancellation requested — halting operations...');
    }, [addLog, decideReview]);

    const returnToMenu = useCallback(() => {
        resultsRequestPendingRef.current = false
        if (completionTimerRef.current) {
            clearTimeout(completionTimerRef.current);
            completionTimerRef.current = null;
        }
        setIsCancelling(false);
        setStatus('idle')
        setLogs([])
        setProgress(0)
        setErrorMsg('')
        setBackgroundNotice('')
        setUploadedFile(null)
        setParsedBookmarks(null)
        setActiveDateSpan(lastOrganized?.stats?.dateSpan || lastOrganized?.dateSpan || null)
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, [lastOrganized])

    const resetApp = useCallback(() => {
        cancelRequestedRef.current = true;
        resultsRequestPendingRef.current = false
        if (portRef.current) {
            try {
                portRef.current.postMessage({ type: 'RESET_JOB' });
            } catch {}
        }
        if (organizerRef.current) {
            organizerRef.current.cancel();
        }
        returnToMenu()
        organizedResultsRef.current = null;
        setLastOrganized(null)
        setActiveDateSpan(null)
    }, [returnToMenu])

    useEffect(() => { returnToMenuRef.current = returnToMenu }, [returnToMenu])

    // Session snapshot writer for in-panel fallback runs. Mirrors the field
    // layout of the service worker's persistSessionSnapshot so any reader of
    // activeJobState sees the same shape regardless of who wrote it.
    const writePanelJobSnapshot = useCallback((snapshot) => {
        if (typeof chrome === 'undefined' || !chrome.storage?.session) return
        try {
            chrome.storage.session.set({
                activeJobState: {
                    id: snapshot.id,
                    status: snapshot.status,
                    progress: snapshot.progress,
                    logs: (snapshot.logs ?? logsRef.current).slice(-60),
                    activeDateSpan: snapshot.activeDateSpan ?? activeDateSpan,
                    backgroundNotice: snapshot.backgroundNotice ?? '',
                    errorMsg: snapshot.errorMsg ?? '',
                    stats: snapshot.stats ?? null,
                    count: snapshot.count ?? null,
                    completedAt: snapshot.completedAt ?? null
                }
            })
        } catch {}
    }, [activeDateSpan])

    const startProcess = useCallback(async () => {
        const requiresApiKey = !flatDateSort || cleanTitles;
        if (requiresApiKey && !apiKey) {
            setErrorMsg(`Please enter your Google Gemini / AI Studio or OpenRouter API Key.`);
            return;
        }
        if (!flatDateSort && !inferCategories && categories.length === 0) {
            setErrorMsg('Add at least one category or turn on Infer categories.')
            setStatus('error')
            return
        }

        if (completionTimerRef.current) {
            clearTimeout(completionTimerRef.current);
            completionTimerRef.current = null;
        }
        setIsCancelling(false);
        cancelRequestedRef.current = false;
        resultsRequestPendingRef.current = false
        organizedResultsRef.current = null;
        setLastOrganized(null);
        setBackgroundNotice('');
        let reportedErrorMessage = '';

        // Session-snapshot bookkeeping for an in-panel fallback run. Only
        // armed once this panel actually runs the job (delegated runs are
        // tracked by the service worker), so nothing here fires when the
        // worker acknowledges START_JOB.
        let panelRunArmed = false;
        let panelRunTerminated = false;
        let panelProgress = 0;
        let lastPanelSnapshotAt = 0;
        const panelJobId = `panel_${Date.now()}`;
        const persistPanelSnapshot = (snapshotStatus, snapshotExtras = {}) => {
            const now = Date.now();
            if (snapshotStatus === 'processing' && now - lastPanelSnapshotAt < 250) return;
            lastPanelSnapshotAt = now;
            if (snapshotStatus !== 'processing') panelRunTerminated = true;
            writePanelJobSnapshot({ id: panelJobId, status: snapshotStatus, progress: panelProgress, ...snapshotExtras });
        };
        // The panel can vanish at any moment mid-run. Before that happens the
        // page gets pagehide / visibilitychange, so rewrite the snapshot as
        // interrupted — unless the run already reached a terminal state here.
        const writeInterruptedSnapshot = () => {
            if (panelRunTerminated) return;
            writePanelJobSnapshot({ id: panelJobId, status: 'interrupted', progress: panelProgress });
        };
        const onPanelPageHide = () => writeInterruptedSnapshot();
        const onPanelVisibilityChange = () => {
            if (document.visibilityState === 'hidden') writeInterruptedSnapshot();
        };
        const endPanelRunTracking = () => {
            panelRunTerminated = true;
            window.removeEventListener('pagehide', onPanelPageHide);
            document.removeEventListener('visibilitychange', onPanelVisibilityChange);
            endPanelRunRef.current = null;
        };

        try {
            setStatus('processing');
            const effectiveDateSortOrder = flatDateSort && flatSortType === 'alpha'
                ? (alphaSortOrder === 'desc' ? 'alpha-desc' : 'alpha-asc')
                : dateSortOrder;

            if (flatDateSort) {
                const isAlpha = flatSortType === 'alpha' || dateSortOrder === 'alpha-asc' || dateSortOrder === 'alpha-desc' || dateSortOrder === 'a-z' || dateSortOrder === 'z-a' || dateSortOrder === 'alpha';
                const isAlphaDesc = flatSortType === 'alpha' ? alphaSortOrder === 'desc' : (dateSortOrder === 'alpha-desc' || dateSortOrder === 'z-a');
                const orderLabel = isAlpha
                    ? (isAlphaDesc ? 'Alphabetical (Z–A)' : 'Alphabetical (A–Z)')
                    : (dateSortOrder === 'desc' ? 'Newest First' : 'Oldest First');
                setLogs([
                    { message: isAlpha ? 'Starting Alphabetical Sort...' : 'Starting Chronological Date Sort...', timestamp: new Date() },
                    { message: 'Mode: Flat List (No Folders / Schema-free)', timestamp: new Date() },
                    { message: `Sort Direction: ${orderLabel}`, timestamp: new Date() },
                    { message: `Remove Duplicate URLs: ${removeDuplicates ? 'On' : 'Off'}`, timestamp: new Date() },
                    { message: `Clean Bookmark Titles: ${cleanTitles ? 'On' : 'Off'}`, timestamp: new Date() }
                ]);
            } else {
                const selectedModelLabel = models.find(m => m.id === selectedModel)?.label || selectedModel;
                const subfolderLabel = subfolderOptions.find(opt => opt.id === subfolderTarget)?.label || subfolderTarget;
                const sortLabel = SCHEMA_SORT_OPTIONS.find(opt => opt.id === schemaSortOrder)?.label || 'Alphabetical (A–Z)';
                setLogs([
                    { message: 'Starting AI Organization...', timestamp: new Date() },
                    { message: `Using Model: Google Gemini ${selectedModelLabel}`, timestamp: new Date() },
                    { message: `Subfolder Organization: ${subfolderLabel}`, timestamp: new Date() },
                    { message: `Folder Content Sorting: ${sortLabel}`, timestamp: new Date() },
                    { message: `Remove Duplicate URLs: ${removeDuplicates ? 'On' : 'Off'}`, timestamp: new Date() },
                    { message: `Clean Bookmark Titles: ${cleanTitles ? 'On' : 'Off'}`, timestamp: new Date() }
                ]);
            }
            setProgress(0);
            setErrorMsg('');
            setBackgroundNotice('');

            // Delegate to the background service worker. A port whose worker
            // has gone idle swallows postMessage silently, which used to
            // strand the run at 0% with no terminal output — so the worker
            // must acknowledge the job before the panel trusts it with
            // the run, and otherwise falls back to an in-panel run.
            let port = portRef.current;
            if (!port && typeof chrome !== 'undefined' && chrome.runtime?.connect) {
                try {
                    port = chrome.runtime.connect({ name: 'organizer-channel' });
                    // A reconnected port carries none of the job-state
                    // listeners of the dead one — without wiring it, every
                    // STATUS_UPDATE the worker broadcasts is lost and the
                    // terminal/progress freeze while the run continues there.
                    wirePort(port);
                    portRef.current = port;
                } catch {
                    port = null;
                }
            }

            let delegated = false;
            if (port) {
                awaitingAckRef.current = true;
                delegated = await new Promise((resolveDelegate) => {
                    let settled = false;
                    let ackListener = null;
                    let disconnectListener = null;
                    const finish = (acknowledged) => {
                        if (settled) return;
                        settled = true;
                        awaitingAckRef.current = false;
                        clearTimeout(ackTimer);
                        if (ackListener && port.onMessage?.removeListener) {
                            try { port.onMessage.removeListener(ackListener); } catch {}
                        }
                        if (disconnectListener && port.onDisconnect?.removeListener) {
                            try { port.onDisconnect.removeListener(disconnectListener); } catch {}
                        }
                        resolveDelegate(acknowledged);
                    };
                    const ackTimer = setTimeout(() => finish(false), BACKGROUND_ACK_TIMEOUT_MS);

                    ackListener = (msg) => {
                        if (msg?.type === 'JOB_ACK') finish(true);
                    };
                    disconnectListener = () => finish(false);
                    try {
                        port.onMessage.addListener(ackListener);
                        port.onDisconnect?.addListener(disconnectListener);
                    } catch {
                        finish(false);
                        return;
                    }

                    try {
                        port.postMessage({
                            type: 'START_JOB',
                            payload: {
                                config: {
                                    apiKey,
                                    categories,
                                    inferCategories,
                                    selectedModel,
                                    subfolderTarget,
                                    sortAlphabetically,
                                    removeDuplicates,
                                    cleanTitles,
                                    flatDateSort,
                                    dateSortOrder: effectiveDateSortOrder,
                                    schemaSortOrder,
                                    reviewFolders
                                },
                                parsedBookmarks
                            }
                        });
                    } catch (portErr) {
                        console.warn('[Organizer] Port postMessage failed, falling back to in-process:', portErr);
                        finish(false);
                    }
                });
            }

            if (delegated && cancelRequestedRef.current) {
                return;
            }
            if (delegated) {
                addLog('Background service worker acknowledged the job — organization continues there.');
                return;
            }

            if (port) {
                // The worker never acknowledged: stop it if it did receive the
                // message, drop the suspect port, and run in this panel so the
                // terminal keeps showing live progress instead of stalling.
                try { port.postMessage({ type: 'CANCEL_JOB' }); } catch {}
                resultsRequestPendingRef.current = false
                try { port.disconnect(); } catch {}
                portRef.current = null;
                if (cancelRequestedRef.current) {
                    return;
                }
                addLog('Background service worker did not acknowledge the job — running the organization in this panel instead.');
            } else if (!cancelRequestedRef.current) {
                addLog('Background service worker unavailable — running the organization in this panel instead.');
            }

            // From here the run lives in this panel, so this panel owns the
            // session snapshot until the run reaches a terminal state.
            panelRunArmed = true;
            window.addEventListener('pagehide', onPanelPageHide);
            document.addEventListener('visibilitychange', onPanelVisibilityChange);
            endPanelRunRef.current = endPanelRunTracking;

            const { OrganizerService } = await import('../services/organizer')
            // Let React paint the completion state before opening the native
            // Save As dialog. Some browsers keep the extension panel looking
            // frozen while that modal is active if it is opened inline in
            // OrganizerService.start().
            const deferFileDownload = (results) => {
                setTimeout(async () => {
                    try {
                        const { downloadBookmarks } = await import('../services/bookmarks_export')
                        downloadBookmarks(results)
                    } catch (downloadError) {
                        console.warn('[Organizer] Deferred file download failed:', downloadError)
                    }
                }, 0)
            }
            organizerRef.current = new OrganizerService(
                apiKey,
                categories,
                (data) => {
                    if (data.dateSpan) {
                        setActiveDateSpan(data.dateSpan);
                    }
                    if (data.status === 'info') {
                        addLog(data.message);
                    } else if (data.status === 'processing') {
                        if (data.message) addLog(data.message);
                        if (typeof data.percent === 'number') {
                            panelProgress = Math.min(99, Math.max(0, Math.round(data.percent)));
                            persistPanelSnapshot('processing');
                        }
                    } else if (data.status === 'progress') {
                        if (data.message) addLog(data.message);
                        panelProgress = Math.min(99, Math.max(0, Math.round(data.percent)));
                        persistPanelSnapshot('processing');
                        if (data.clearNotice) {
                            setBackgroundNotice('');
                        }
                    } else if (data.status === 'retry') {
                        addLog(data.message);
                        setBackgroundNotice(data.message);
                    } else if (data.status === 'warning') {
                        addLog(data.message);
                        if (data.message?.includes('Pausing') || data.message?.includes('Retrying') || data.message?.includes('background')) {
                            setBackgroundNotice(data.message);
                        }
                        if (data.message?.includes('cancelled')) {
                            setStatus('idle');
                            setIsCancelling(false);
                            persistPanelSnapshot('idle');
                            endPanelRunTracking();
                        }
                    } else if (data.status === 'error') {
                        reportedErrorMessage = data.message || '';
                        setErrorMsg(data.message);
                        setBackgroundNotice('');
                        setStatus('error');
                        persistPanelSnapshot('error', { errorMsg: reportedErrorMessage });
                        endPanelRunTracking();
                    } else if (data.status === 'success') {
                        addLog(data.message);
                        setBackgroundNotice('');
                    } else if (data.status === 'done') {
                        addLog(data.message);
                        setBackgroundNotice('');
                        setStatus('complete');
                        setProgress(100);
                        scheduleReturnToMenu();
                        panelProgress = 100;
                        persistPanelSnapshot('complete', { completedAt: Date.now() });
                        endPanelRunTracking();
                    }
                },
                selectedModel,
                subfolderTarget,
                sortAlphabetically,
                removeDuplicates,
                cleanTitles,
                flatDateSort,
                effectiveDateSortOrder,
                schemaSortOrder,
                parsedBookmarks ? deferFileDownload : inferCategories
            );

            if (reviewFolders && !flatDateSort) {
                organizerRef.current.planReviewer = (schema, error) => new Promise((resolve) => {
                    planResolverRef.current = resolve
                    setPlanForReview({
                        categories: (schema.categories || []).map(c => ({ name: c.name, sub_categories: [...(c.sub_categories || [])] })),
                        ...(error ? { error } : {})
                    })
                    addLog('Folder plan ready — review it, then approve to start organizing.')
                })
                organizerRef.current.resultReviewer = (rows, error) => new Promise((resolve) => {
                    resultResolverRef.current = resolve
                    setResultForReview({ rows, ...(error ? { error } : {}) })
                    addLog('Organized folders ready — review them, then save the results.')
                })
            }
            persistPanelSnapshot('processing');

            // Pass parsed bookmarks if file mode, otherwise null (browser mode)
            const results = await organizerRef.current.start(parsedBookmarks);

            if (organizerRef.current?.isCancelled || !results) {
                setStatus('idle');
                setIsCancelling(false);
                persistPanelSnapshot('idle');
                endPanelRunTracking();
                return;
            }

            if (results && results.length > 0) {
                organizedResultsRef.current = results;
                const stats = organizerRef.current?.stats || results.stats || null;
                const finalSpan = stats?.dateSpan || activeDateSpan || calculateDateSpan(results);
                const enrichedStats = {
                    ...(stats || {}),
                    ...(finalSpan ? { dateSpan: finalSpan } : {})
                };
                const meta = {
                    count: results.length,
                    savedAt: Date.now(),
                    mode: parsedBookmarks ? 'file' : 'browser',
                    stats: enrichedStats,
                    ...(finalSpan ? { dateSpan: finalSpan } : {}),
                    ...(results.filename ? { filename: results.filename } : {})
                };
                if (finalSpan) {
                    setActiveDateSpan(finalSpan);
                }
                setLastOrganized(meta);
                persistPanelSnapshot('complete', { stats: enrichedStats, count: results.length, completedAt: Date.now() });
                endPanelRunTracking();
                if (typeof chrome !== 'undefined' && chrome.storage?.local) {
                    // Every run is saved (latest plus the two before it) so it stays downloadable.
                    saveRun(results, meta)
                        .then(() => addLog('Results saved — downloadable anytime, even after reopening the panel.'))
                        .catch((saveError) => addLog(`Could not save results for later download: ${saveError.message}`));
                }
            } else {
                persistPanelSnapshot('complete', { count: 0, completedAt: Date.now() });
                endPanelRunTracking();
            }

        } catch (err) {
            console.error(err);
            setErrorMsg(reportedErrorMessage || err?.message || "Failed to start process.");
            setStatus('error');
            if (panelRunArmed) {
                persistPanelSnapshot('error', { errorMsg: reportedErrorMessage || err?.message || "Failed to start process." });
                endPanelRunTracking();
            }
        } finally {
            setIsCancelling(false);
            // Edits saved for this run's review are stale once the run ends.
            if (typeof chrome !== 'undefined' && chrome.storage?.session) {
                try { chrome.storage.session.remove(['reviewDraft']); } catch {}
            }
        }
    }, [apiKey, models, selectedModel, categories, inferCategories, addLog, parsedBookmarks, subfolderTarget, subfolderOptions, sortAlphabetically, schemaSortOrder, removeDuplicates, cleanTitles, flatDateSort, dateSortOrder, flatSortType, alphaSortOrder, activeDateSpan, scheduleReturnToMenu, wirePort, reviewFolders, writePanelJobSnapshot]);

    // Keep the primary action available before a key is entered so browser
    // mode can explain the remaining requirement instead of looking broken.
    // The uploaded bookmark file remains optional and browser bookmarks are
    // the default source.
    const canStart = status === 'idle' && !isCancelling;

    // The key field collapses to one line once a key is saved. The key loads
    // from storage after mount, so "open" is tracked as an explicit edit in
    // progress (typing or Change) rather than derived once from the key.
    const [keyOpen, setKeyOpen] = useState(false);

    const needsKey = !flatDateSort || cleanTitles;
    const waitingForReview = Boolean(planForReview || resultForReview);
    const stats = lastOrganized?.stats;
    const breakdown = stats?.categoryBreakdown;
    const hasBreakdown = Boolean(breakdown) && Object.keys(breakdown).length > 0;
    const schemaRows = hasBreakdown && Object.entries(breakdown)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, count]) => (
            <div key={category} className="schema-row">
                <span>{category}</span>
                <span className="schema-count">{count}</span>
            </div>
        ));
    const copyButton = hasBreakdown && (
        <button
            type="button"
            className={`btn-quiet ${copiedSchema ? 'is-success' : ''}`}
            onClick={() => handleCopySchema(breakdown)}
            title="Copy category list as plain text"
        >
            {copiedSchema ? <Check size={13} /> : <Copy size={13} />}
            {copiedSchema ? 'Copied' : 'Copy'}
        </button>
    );

    // Cached input files belong with the source picker while idle and with
    // the result once a run completes, so both views place this same block.
    const savedInputs = (
        <>
            {/* Cached dropped-in input file (spec §12): pristine original kept for re-organize/download */}
            {inputFile && (
                <div className="input-bookmarks-card">
                    <div style={{ minWidth: 0 }}>
                        <div className="setting-title">Input Bookmarks</div>
                        <div className="setting-desc">
                            {inputFile.filename} · {(inputFile.count || 0).toLocaleString()} bookmarks
                            {inputFile.dateSpan ? ` · Dates ${formatDateSpan(inputFile.dateSpan)}` : ''}
                            {' '}· saved {new Date(inputFile.savedAt).toLocaleString()}
                        </div>
                    </div>
                    <div className="input-file-actions">
                        <button className="input-file-action input-file-action-secondary" type="button" onClick={() => handleDownloadInput(inputFile)} title="Download the original file">Download</button>
                        <button className="input-file-action input-file-action-primary" type="button" onClick={() => handleReorganizeInput(inputFile)} title="Organize from the cached original again">Re-organize</button>
                        <button className="input-file-action input-file-action-danger" type="button" onClick={() => handleRemoveInput(inputFile)} title="Forget the cached input">Remove</button>
                    </div>
                </div>
            )}

            {/* Recorded input files history (unlimited files with download / re-organize / delete) */}
            {inputFiles.length > 1 && (
                <details className="previous-inputs sub-details">
                    <summary>All saved input files ({inputFiles.length})</summary>
                    <button type="button" className="btn-quiet" onClick={clearAllInputFiles}>
                        Clear all saved input files
                    </button>
                    <ul className="saved-list">
                        {inputFiles.map((entry) => (
                            <li key={entry.id || entry.savedAt}>
                                <span className="saved-meta">
                                    <strong>{entry.filename}</strong>
                                    <br />
                                    {[
                                        `${(entry.count || 0).toLocaleString()} bookmarks`,
                                        formatDateSpan(entry.dateSpan),
                                        formatRunTime(entry.savedAt)
                                    ].filter(Boolean).join(' · ')}
                                </span>
                                <div className="saved-actions">
                                    <button type="button" className="btn-quiet" aria-label={`Download ${entry.filename}`} onClick={() => handleDownloadInput(entry)} title="Download this original input file">
                                        <Download size={13} />
                                        Download
                                    </button>
                                    <button type="button" className="btn-quiet" aria-label={`Re-organize ${entry.filename}`} onClick={() => handleReorganizeInput(entry)} title="Load this input file to organize">
                                        Re-organize
                                    </button>
                                    <button type="button" className="btn-quiet" aria-label={`Delete ${entry.filename}`} onClick={() => handleRemoveInput(entry)} title="Delete this saved input file">
                                        <Trash2 size={13} />
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </>
    );

    return (
        <div className="organizer">

            {status === 'idle' && (
                <>
                    {/* Mode: the right-hand option keeps the switch role and name the flat-sort toggle always had */}
                    <div role="group" aria-label="Mode" className="segmented mode-switch">
                        <button
                            type="button"
                            aria-pressed={!flatDateSort}
                            className={!flatDateSort ? 'active' : ''}
                            onClick={() => handleFlatDateSortToggle(false)}
                        >
                            <Bookmark size={14} />
                            <span>Organize with AI</span>
                        </button>
                        <button
                            type="button"
                            role="switch"
                            aria-label="Sort without AI - Flat list"
                            aria-checked={flatDateSort}
                            className={flatDateSort ? 'active' : ''}
                            onClick={() => handleFlatDateSortToggle(!flatDateSort)}
                        >
                            {flatSortType === 'alpha' ? <ArrowDownAZ size={14} /> : <Clock size={14} />}
                            <span>Sort without AI</span>
                        </button>
                    </div>
                    <p className="hint mode-hint">
                        {flatDateSort
                            ? 'Orders bookmarks by date added or alphabetically into a single list without folders. Uses zero AI tokens.'
                            : 'AI files your bookmarks into category folders and subfolders.'}
                    </p>

                    {/* API key: one line once saved, full field while empty or being changed */}
                    <section className="group">
                        {apiKey && !keyOpen ? (
                            <div className="setting-row">
                                <div className="setting-title with-icon">
                                    <Check size={15} className="ok-icon" />
                                    {provider === 'gemini' ? 'Google Gemini' : 'OpenRouter'} API key saved
                                </div>
                                <button type="button" className="btn-quiet" onClick={() => setKeyOpen(true)}>Change</button>
                            </div>
                        ) : (
                            <>
                                <label className="field-label" htmlFor="api-key">
                                    API Key {needsKey ? <span className="required">*</span> : null}
                                    <span className="hint">
                                        {needsKey ? 'Google Gemini (AI Studio) or OpenRouter' : 'Optional for flat sorting'}
                                    </span>
                                </label>
                                <input
                                    id="api-key"
                                    className="text-input"
                                    type="password"
                                    placeholder="AIza... or AQ... (Google AI Studio / Gemini) or sk-or-... (OpenRouter)"
                                    value={apiKey}
                                    autoFocus={keyOpen}
                                    onChange={(e) => { setKeyOpen(true); handleApiKeyChange(e.target.value); }}
                                    onBlur={() => setKeyOpen(false)}
                                />
                                <div className="key-links">
                                    <a className="link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">
                                        <span>Get Gemini API Key (Google AI Studio - Free)</span>
                                        <ExternalLink size={11} />
                                    </a>
                                    <a className="link" href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">
                                        <span>Get OpenRouter Key</span>
                                        <ExternalLink size={11} />
                                    </a>
                                </div>
                                <p className="hint with-icon">
                                    <Lock size={13} className="ok-icon" />
                                    <span>
                                        Your API key is stored locally in your browser. The provider is detected
                                        automatically{apiKey ? `: ${provider === 'gemini' ? 'Google Gemini' : 'OpenRouter'}` : ''}.
                                    </span>
                                </p>
                            </>
                        )}
                    </section>

                    {/* Source: browser bookmarks unless a file is dropped in */}
                    <section className="group">
                        <div className="field-label">
                            Source
                            <span className="hint">{uploadedFile ? 'Bookmarks file' : 'Your browser bookmarks'}</span>
                        </div>
                        <div
                            data-testid="dropzone"
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            className={`upload-dropzone ${uploadedFile ? 'has-file' : ''}`}
                            onClick={() => fileInputRef.current.click()}
                        >
                            <input
                                type="file"
                                ref={fileInputRef}
                                onChange={handleFileSelect}
                                accept=".html,.htm"
                                style={{ display: 'none' }}
                            />

                            {uploadedFile ? (
                                <div>
                                    <div className="dropzone-file">
                                        <FileText size={18} />
                                        <span>{uploadedFile.name}</span>
                                    </div>
                                    <div className="hint">
                                        {parsedBookmarks
                                            ? `${parsedBookmarks.length.toLocaleString()} bookmarks ready${activeDateSpan ? ` · Dates ${formatDateSpan(activeDateSpan)}` : ''}`
                                            : 'Ready to process'}
                                    </div>
                                    <button type="button" className="link danger" onClick={(e) => { e.stopPropagation(); resetApp(); }}>
                                        Remove File
                                    </button>
                                </div>
                            ) : (
                                // A real button so the picker is reachable by keyboard; its click bubbles to the dropzone.
                                <button type="button" className="dropzone-btn">
                                    <Upload size={18} />
                                    <span>
                                        Drag & drop bookmarks.html here
                                        <span className="hint">or click to browse (Optional - defaults to browser's current bookmarks)</span>
                                    </span>
                                </button>
                            )}
                        </div>
                        {savedInputs}
                    </section>

                    {/* Model */}
                    {needsKey && (
                        <section className="group">
                            <div className="field-label">Select AI Model</div>
                            <Segmented
                                label="AI model"
                                className="segmented-grid"
                                options={models.map((m) => ({ id: m.id, label: m.name, badge: m.badge }))}
                                value={selectedModel}
                                onChange={handleModelChange}
                            />
                            <p className="hint">
                                {models.find(m => m.id === selectedModel)?.description || MODEL_OPTIONS.find(m => m.id === DEFAULT_MODEL_ID).description}
                            </p>
                        </section>
                    )}

                    {/* Flat sort settings */}
                    {flatDateSort && (
                        <section className="group">
                            <div className="field-label">Sort Criterion</div>
                            <Segmented
                                label="Sort Criterion"
                                options={[
                                    { id: 'date', label: 'Date Added', icon: Clock },
                                    { id: 'alpha', label: 'Alphabetical', icon: ArrowDownAZ }
                                ]}
                                value={flatSortType}
                                onChange={handleFlatSortTypeChange}
                            />

                            {flatSortType === 'date' ? (
                                <>
                                    <div className="field-label spaced">
                                        Chronological Direction
                                        <button
                                            type="button"
                                            className="link muted"
                                            onClick={() => handleDateSortOrderChange(dateSortOrder === 'desc' ? 'asc' : 'desc')}
                                            title="Click to reverse direction"
                                        >
                                            {dateSortOrder === 'desc' ? 'Newest bookmarks at the top' : 'Oldest bookmarks at the top'}
                                        </button>
                                    </div>
                                    <Segmented
                                        label="Chronological Direction"
                                        options={[
                                            { id: 'desc', label: 'Newest First', icon: ArrowDown },
                                            { id: 'asc', label: 'Oldest First', icon: ArrowUp }
                                        ]}
                                        value={dateSortOrder}
                                        onChange={handleDateSortOrderChange}
                                    />
                                </>
                            ) : (
                                <>
                                    <div className="field-label spaced">
                                        Alphabetical Direction
                                        <button
                                            type="button"
                                            className="link muted"
                                            onClick={() => handleAlphaSortOrderChange(alphaSortOrder === 'desc' ? 'asc' : 'desc')}
                                            title="Click to reverse direction"
                                        >
                                            {alphaSortOrder === 'desc' ? 'Z to A bookmarks at the top' : 'A to Z bookmarks at the top'}
                                        </button>
                                    </div>
                                    <Segmented
                                        label="Alphabetical Direction"
                                        options={[
                                            { id: 'asc', label: 'A to Z', icon: ArrowDownAZ },
                                            { id: 'desc', label: 'Z to A', icon: ArrowUpZA }
                                        ]}
                                        value={alphaSortOrder}
                                        onChange={handleAlphaSortOrderChange}
                                    />
                                </>
                            )}
                        </section>
                    )}

                    {/* Folders: subfolder depth and in-folder ordering */}
                    {!flatDateSort && (
                        <details className="group">
                            <summary>
                                <span className="group-title">Folders</span>
                                <span className="group-value">
                                    {subfolderOptions.find(opt => opt.id === subfolderTarget)?.label}
                                    {' · '}
                                    {SCHEMA_SORT_OPTIONS.find(opt => opt.id === schemaSortOrder)?.short}
                                </span>
                            </summary>
                            <div className="group-body">
                                <div className="field-label">Subfolder Organization</div>
                                <Segmented
                                    label="Subfolder Organization"
                                    options={subfolderOptions}
                                    value={subfolderTarget}
                                    onChange={handleSubfolderTargetChange}
                                />
                                <p className="hint">{subfolderOptions.find(opt => opt.id === subfolderTarget)?.description}</p>
                                <img
                                    className="subfolder-hierarchy-image"
                                    src={SUBFOLDER_EXPLAINER_IMAGES[theme]?.[subfolderTarget] || subfolderHierarchyImage}
                                    alt="Category and nested subfolder hierarchy for the selected organization level"
                                />

                                <div className="field-label spaced">Folder Content Sorting</div>
                                <p className="hint">Choose how bookmarks are ordered inside each AI-generated category folder:</p>
                                <div className="option-list">
                                    {SCHEMA_SORT_OPTIONS.map(option => {
                                        const isSelected = schemaSortOrder === option.id;
                                        const IconComponent = option.icon;
                                        return (
                                            <button
                                                key={option.id}
                                                type="button"
                                                aria-pressed={isSelected}
                                                className={`option-row ${isSelected ? 'active' : ''}`}
                                                onClick={() => handleSchemaSortChange(option.id)}
                                            >
                                                <IconComponent size={16} className="option-icon" />
                                                <span className="option-text">
                                                    <span className="setting-title">{option.label}</span>
                                                    <span className="setting-desc">{option.desc}</span>
                                                </span>
                                                {isSelected && <Check size={15} strokeWidth={3} className="option-check" />}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </details>
                    )}

                    {/* Category Editor */}
                    {!flatDateSort && (
                        <details className="group">
                            <summary>
                                <span className="group-title">Customize Categories</span>
                                <span className="group-value">{inferCategories ? 'Inferred by AI' : `${categories.length} custom`}</span>
                            </summary>
                            <div className="group-body">
                                <div className="setting-row">
                                    <div>
                                        <div className="setting-title">Infer categories</div>
                                        <div className="setting-desc">
                                            AI creates categories from this run’s bookmarks. Manual choices stay saved but inactive.
                                        </div>
                                    </div>
                                    <Switch label="Infer categories" checked={inferCategories} onChange={handleInferCategoriesToggle} />
                                </div>

                                <div aria-disabled={inferCategories} className={`category-editor ${inferCategories ? 'is-disabled' : ''}`}>
                                    <div className="setting-row">
                                        <span className="hint">{categories.length} chosen</span>
                                        {categories.length > 0 ? (
                                            <button type="button" className="btn-quiet danger" onClick={handleClearAllCategories} disabled={inferCategories} title="Clear all active categories">
                                                <X size={12} />
                                                <span>Clear All</span>
                                            </button>
                                        ) : (
                                            <button type="button" className="btn-quiet" onClick={handleResetDefaultCategories} disabled={inferCategories} title="Reset to default categories">
                                                <RefreshCw size={12} />
                                                <span>Reset Defaults</span>
                                            </button>
                                        )}
                                    </div>

                                    <p className="hint">
                                        <span style={{ display: 'block' }}>Your chosen categories become the root-level folders.</span>
                                        <span style={{ display: 'block' }}>Subfolders are always generated automatically inside each root folder.</span>
                                    </p>

                                    {/* Custom Category Input */}
                                    <div className="input-row">
                                        <input
                                            type="text"
                                            className="text-input"
                                            placeholder="Add custom category..."
                                            aria-label="Add custom category"
                                            value={newCategory}
                                            disabled={inferCategories}
                                            onChange={(e) => setNewCategory(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && newCategory.trim()) {
                                                    handleAddCategory(newCategory);
                                                    setNewCategory('');
                                                }
                                            }}
                                        />
                                        <button
                                            type="button"
                                            className="btn-secondary"
                                            disabled={inferCategories}
                                            onClick={() => {
                                                if (newCategory.trim()) {
                                                    handleAddCategory(newCategory);
                                                    setNewCategory('');
                                                }
                                            }}
                                        >
                                            <Plus size={15} />
                                            <span>Add</span>
                                        </button>
                                    </div>

                                    {/* Active Chosen Categories Bin */}
                                    {categories.length === 0 ? (
                                        <div className="empty-note">
                                            No manual categories selected. The app will infer root-level folders from your bookmark file. Turn off Infer categories to choose the root folders below. Subfolders are always generated automatically inside each root folder.
                                        </div>
                                    ) : (
                                        <div className="chip-list">
                                            {categories.map((cat, idx) => (
                                                <div key={idx} className="chip">
                                                    <span>{cat}</span>
                                                    <button type="button" className="chip-remove" disabled={inferCategories} onClick={() => handleRemoveCategory(idx)} title={`Remove "${cat}"`}>
                                                        <X size={14} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {/* Second List: Suggested Categories (Addable Pool) */}
                                    {availableSuggestions.length > 0 && (
                                        <>
                                            <div className="field-label spaced">
                                                Suggested Categories
                                                <span className="hint">Click + to add into chosen</span>
                                            </div>
                                            <div className="chip-list">
                                                {availableSuggestions.map((sug) => (
                                                    <button
                                                        type="button"
                                                        key={sug}
                                                        className="chip chip-add"
                                                        disabled={inferCategories}
                                                        onClick={() => handleAddCategory(sug)}
                                                        title={`Add "${sug}" to chosen categories`}
                                                    >
                                                        <span>{sug}</span>
                                                        <Plus size={14} />
                                                    </button>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                        </details>
                    )}

                    {/* Options */}
                    <details className="group">
                        <summary>
                            <span className="group-title">Options</span>
                            <span className="group-value">
                                {[
                                    removeDuplicates && 'Dedupe',
                                    !flatDateSort && reviewFolders && 'Review',
                                    cleanTitles && 'AI titles'
                                ].filter(Boolean).join(' · ') || 'None on'}
                            </span>
                        </summary>
                        <div className="group-body">
                            <div className="setting-row">
                                <div>
                                    <div className="setting-title">Remove Duplicate URLs</div>
                                    <div className="setting-desc">
                                        Keep one copy of each URL in the organized result; original bookmarks are unchanged
                                    </div>
                                </div>
                                <Switch label="Remove duplicate URLs" checked={removeDuplicates} onChange={handleRemoveDuplicatesToggle} />
                            </div>

                            {!flatDateSort && (
                                <div className="setting-row">
                                    <div>
                                        <div className="setting-title">Review folders before saving</div>
                                        <div className="setting-desc">
                                            Pause to approve or edit the proposed folders before any bookmark is filed, and again to edit the finished folders before they are saved
                                        </div>
                                    </div>
                                    <Switch label="Review folders before saving" checked={reviewFolders} onChange={handleReviewFoldersToggle} />
                                </div>
                            )}

                            <div className="setting-row">
                                <div>
                                    <div className="setting-title">
                                        Clean Titles with AI
                                        <span className="badge">Consumes AI Tokens</span>
                                    </div>
                                    <div className="setting-desc">
                                        {flatDateSort
                                            ? `Uses AI to rewrite cryptic, truncated, or raw-URL titles into clean names while preserving ${flatSortType === 'alpha' ? 'alphabetical' : 'chronological date'} order. Consumes AI tokens and requires an API key.`
                                            : 'Uses AI to rewrite messy, truncated, or raw-URL titles into human-readable names. Consumes AI tokens.'}
                                    </div>
                                </div>
                                <Switch label="Clean Titles with AI" checked={cleanTitles} onChange={handleCleanTitlesToggle} />
                            </div>

                            <div className="setting-row">
                                <div>
                                    <div className="setting-title">Clean up browser bookmarks now</div>
                                    <div className="setting-desc">
                                        Deletes duplicate bookmarks from your browser right away, without organizing. A backup is saved first.
                                    </div>
                                </div>
                                <RemoveDuplicatesButton />
                            </div>
                        </div>
                    </details>

                    {/* Saved results from previous runs (persist across panel sessions) */}
                    {lastOrganized && (
                        <section className="group">
                            <div className="field-label">Last run</div>
                            <div className="last-run-banner">
                                <div className="last-run-header">
                                    <div className="setting-desc">
                                        <span>{formatRunTime(lastOrganized.savedAt)}</span> · {lastOrganized.count.toLocaleString()} bookmarks {stats?.isFlat ? 'sorted' : 'organized'}
                                        {stats?.isFlat && ` · ${stats?.dateSortOrder === 'desc' ? 'Newest First' : 'Oldest First'}`}
                                        {stats?.dateSpan ? ` · ${formatDateSpan(stats.dateSpan)}` : ' · dates not recorded'}
                                        {stats?.duplicatesRemoved > 0 && ` · ${stats.duplicatesRemoved} dupes`}
                                        {stats?.deadLinksArchived > 0 && ` · ${stats.deadLinksArchived} archived`}
                                        {stats?.failedMoves?.length > 0 && ` · ${stats.failedMoves.length} move${stats.failedMoves.length === 1 ? '' : 's'} failed`}
                                        {stats?.detailFoldersCount > 0 && ` · ${stats.detailFoldersCount} detail folder${stats.detailFoldersCount === 1 ? '' : 's'}`}
                                        {stats?.detailedSubcategories > 0 && ` · ${stats.detailedSubcategories} detailed subcategor${stats.detailedSubcategories === 1 ? 'y' : 'ies'}`}
                                    </div>
                                    <div className="saved-actions">
                                        {hasBreakdown && (
                                            <button type="button" className="btn-quiet" onClick={() => setShowIdleSchema(!showIdleSchema)} title="View category counts" aria-expanded={showIdleSchema}>
                                                {showIdleSchema ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                                Schema
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            className="btn-secondary"
                                            onClick={downloadOrganized}
                                            title={stats?.dateSpan ? `Download bookmarks (Dates ${formatDateSpan(stats.dateSpan)})` : 'Download bookmarks'}
                                        >
                                            <Download size={15} />
                                            Download
                                        </button>
                                    </div>
                                </div>
                                {showIdleSchema && hasBreakdown && (
                                    <div className="schema-box">
                                        <div className="setting-row">
                                            <span className="setting-title">
                                                Category Schema ({Object.keys(breakdown).length} categories)
                                                {stats?.dateSpan && (
                                                    <span className="hint">· Dates {formatDateSpan(stats.dateSpan)}</span>
                                                )}
                                            </span>
                                            {copyButton}
                                        </div>
                                        <div className="schema-list">{schemaRows}</div>
                                    </div>
                                )}
                            </div>

                            {/* Every older saved run, newest first, each downloadable (the latest is the banner above) */}
                            {previousRuns.length > 0 && (
                                <details className="previous-runs sub-details">
                                    <summary>Previous runs ({previousRuns.length})</summary>
                                    <button type="button" className="btn-quiet" onClick={clearPreviousRuns}>
                                        Clear all previous runs
                                    </button>
                                    <ul className="saved-list">
                                        {previousRuns.map((entry) => (
                                            <li key={entry.id}>
                                                <span className="saved-meta">
                                                    <strong>{formatRunTime(entry.savedAt)}</strong>
                                                    <br />
                                                    {[
                                                        `${entry.count.toLocaleString()} bookmarks`,
                                                        entry.stats?.categoriesCount ? `${entry.stats.categoriesCount} categories` : '',
                                                        formatDateSpan(entry.dateSpan || entry.stats?.dateSpan),
                                                        entry.mode === 'file' ? 'from file' : entry.mode === 'browser' ? 'from browser' : ''
                                                    ].filter(Boolean).join(' · ')}
                                                </span>
                                                <div className="saved-actions">
                                                    <button type="button" className="btn-quiet" aria-label={`Download run from ${formatRunTime(entry.savedAt)}`} onClick={() => downloadPreviousRun(entry)} title="Save this run as an HTML file">
                                                        <Download size={13} />
                                                        Download
                                                    </button>
                                                    <button type="button" className="btn-quiet" aria-label={`Delete run from ${formatRunTime(entry.savedAt)}`} onClick={() => removePreviousRun(entry)} title="Delete this saved run">
                                                        <Trash2 size={13} />
                                                    </button>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </section>
                    )}
                </>
            )}

            {/* Result summary */}
            {status === 'complete' && (
                <section className="group result-summary">
                    <div className="result-title">
                        {uploadedFile
                            ? "File Processed! Check your downloads."
                            : (flatDateSort
                                ? `All Done! Check your "Chronological Bookmarks-${new Date(lastOrganized?.savedAt || Date.now()).toISOString().slice(0, 10)}" folder in Other Bookmarks.`
                                : `All Done! Check your "AI Organized Bookmarks-${new Date(lastOrganized?.savedAt || Date.now()).toISOString().slice(0, 10)}" folder in Other Bookmarks.`)}
                    </div>
                    {!uploadedFile && (
                        <div className="hint">(A backup file was also saved to your downloads)</div>
                    )}
                    {stats && (
                        <div className="stats-pill">
                            <span><strong>{(stats.total ?? lastOrganized.count ?? 0).toLocaleString()}</strong> {stats.isFlat ? 'sorted' : 'organized'}</span>
                            <span>•</span>
                            <span><strong>{stats.duplicatesRemoved ?? 0}</strong> duplicates</span>
                            {stats.deadLinksArchived > 0 && (
                                <>
                                    <span>•</span>
                                    <span><strong>{stats.deadLinksArchived}</strong> dead archived</span>
                                </>
                            )}
                            {stats.isFlat ? (
                                <>
                                    <span>•</span>
                                    <span><strong>{stats.dateSortOrder === 'desc' ? 'Newest First' : 'Oldest First'}</strong></span>
                                </>
                            ) : (
                                <>
                                    {stats.categoriesCount != null && (
                                        <>
                                            <span>•</span>
                                            <span><strong>{stats.categoriesCount}</strong> categories</span>
                                        </>
                                    )}
                                    {stats.schemaSortOrder && (
                                        <>
                                            <span>•</span>
                                            <span><strong>{SCHEMA_SORT_OPTIONS.find(o => o.id === stats.schemaSortOrder)?.short || 'A–Z'}</strong></span>
                                        </>
                                    )}
                                    {stats.detailFoldersCount > 0 && (
                                        <>
                                            <span>•</span>
                                            <span><strong>{stats.detailFoldersCount}</strong> detail folder{stats.detailFoldersCount === 1 ? '' : 's'}</span>
                                        </>
                                    )}
                                    {stats.detailedSubcategories > 0 && (
                                        <>
                                            <span>•</span>
                                            <span><strong>{stats.detailedSubcategories}</strong> detailed subcategor{stats.detailedSubcategories === 1 ? 'y' : 'ies'}</span>
                                        </>
                                    )}
                                </>
                            )}
                            <span>•</span>
                            <span>{stats.dateSpan ? `Dates ${formatDateSpan(stats.dateSpan)}` : 'Dates not recorded'}</span>
                        </div>
                    )}
                    {hasBreakdown && (
                        <div className="schema-box">
                            <div className="setting-row">
                                <button type="button" className="link plain" onClick={() => setShowSchema(!showSchema)} aria-expanded={showSchema}>
                                    {showSchema ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                                    <span>Category Schema ({Object.keys(breakdown).length})</span>
                                </button>
                                {copyButton}
                            </div>
                            {showSchema && <div className="schema-list">{schemaRows}</div>}
                        </div>
                    )}
                    {stats?.dateSpan && (
                        <div className="hint">
                            Date range: <strong>{formatDateSpan(stats.dateSpan)}</strong>
                        </div>
                    )}
                    {savedInputs}
                    <div className="hint">
                        Returning to the main menu shortly — your results stay downloadable in the last-run banner.
                    </div>
                </section>
            )}

            {/* Live run: date range and any review the worker is waiting on */}
            {status === 'processing' && (
                <>
                    {activeDateSpan && (
                        <div className="stats-chip">
                            <Calendar size={13} />
                            <span>Date range: <strong>{formatDateSpan(activeDateSpan)}</strong></span>
                        </div>
                    )}
                    <ReviewPanel plan={planForReview} result={resultForReview} onDecide={decideReview} />
                </>
            )}

            {/* Activity log: hidden until there is something to read, open while a run is live */}
            {(logs.length > 0 || status !== 'idle') && (
                <details className="group log-group" open={status !== 'idle'}>
                    <summary>
                        <span className="group-title with-icon"><Terminal size={14} /> Activity log</span>
                        <span className="group-value">{logs.length} {logs.length === 1 ? 'line' : 'lines'}</span>
                    </summary>
                    <div className="terminal-panel" ref={logContainerRef}>
                        {logs.length === 0 && <span className="terminal-muted">Waiting for start...</span>}
                        {logs.map((log, index) => (
                            <div key={index} className="log-line">
                                <span className="terminal-muted">
                                    {typeof log === 'object' ? log.timestamp.toLocaleTimeString() : new Date().toLocaleTimeString()}
                                </span>
                                <span>{typeof log === 'object' ? log.message : log}</span>
                            </div>
                        ))}
                        {status === 'processing' && <div className="log-cursor">_</div>}
                    </div>
                </details>
            )}

            {/* Sticky footer: notices sit directly above the action they explain */}
            <div className="action-bar">
                {/* Background Ongoing Progress / Transient Retry Notification */}
                {status === 'processing' && backgroundNotice && (
                    <div className="notice notice-success">
                        <RefreshCw size={16} className="spin-icon" />
                        <div><strong>Background Run Active:</strong> {backgroundNotice}</div>
                    </div>
                )}

                {/* Interrupted-run notice restored from the previous session */}
                {backgroundNotice === INTERRUPTED_RUN_NOTICE && (
                    <div className="notice notice-error" role="alert">
                        <AlertCircle size={16} />
                        {backgroundNotice}
                    </div>
                )}

                {/* Error Message */}
                {errorMsg && (
                    <div className="notice notice-error" role="alert">
                        <AlertCircle size={16} />
                        {errorMsg}
                    </div>
                )}

                {status === 'complete' ? (
                    <div className="action-row">
                        {lastOrganized && (
                            <button
                                type="button"
                                className="btn-primary"
                                onClick={downloadOrganized}
                                title={stats?.dateSpan ? `Download bookmarks (Dates ${formatDateSpan(stats.dateSpan)})` : 'Download bookmarks'}
                            >
                                <Download size={18} />
                                {stats?.isFlat ? (stats?.tierLabel === 'Alphabetical' || stats?.folderTitle?.includes('Alphabetical') || (stats?.dateSortOrder && String(stats.dateSortOrder).startsWith('alpha')) ? 'Download Alphabetical Bookmarks' : 'Download Chronological Bookmarks') : 'Download Organized Bookmarks'}
                            </button>
                        )}
                        <button type="button" className="btn-secondary" onClick={resetApp}>
                            {flatDateSort ? 'Sort Again' : 'Organize Again'}
                        </button>
                    </div>
                ) : status === 'processing' ? (
                    <div className="action-row">
                        <div className="run-status" role="status">
                            <div className="with-icon">
                                {!waitingForReview && <Loader2 size={16} className="spin-icon" />}
                                <span>{waitingForReview ? 'Waiting for your approval' : `In Progress... ${Math.min(99, Math.max(0, progress))}%`}</span>
                            </div>
                            <progress max="100" value={Math.min(99, Math.max(0, progress))} aria-label="Run progress" />
                        </div>
                        <button
                            type="button"
                            className="btn-secondary danger"
                            onClick={handleCancel}
                            disabled={isCancelling}
                            title="Cancel the organization process"
                        >
                            <Square size={14} fill="currentColor" />
                            {isCancelling ? 'Cancelling...' : 'Cancel'}
                        </button>
                    </div>
                ) : (
                    <button type="button" className="btn-primary btn-block" onClick={startProcess} disabled={!canStart}>
                        {flatDateSort ? (
                            flatSortType === 'alpha' ? (
                                <>
                                    <ArrowDownAZ size={18} />
                                    {uploadedFile ? 'Sort File Alphabetically & Download' : 'Sort My Bookmarks Alphabetically'}
                                </>
                            ) : (
                                <>
                                    <Clock size={18} />
                                    {uploadedFile ? 'Sort File & Download' : 'Sort My Bookmarks by Date'}
                                </>
                            )
                        ) : (
                            <>
                                {uploadedFile ? <FileText size={18} /> : <Bookmark size={18} />}
                                {uploadedFile ? 'Organize File & Download' : 'Organize My Bookmarks'}
                            </>
                        )}
                    </button>
                )}
            </div>

        </div>
    )
}
