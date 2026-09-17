import { buildAuthoritativeSchema } from './defaultSchema';
import { canonicalKey, shouldCreateDetailFolder } from './subcategoryIdentity';

// Shared request headers. OpenRouter recommends identifying the calling app.
const OR_HEADERS = (apiKey) => ({
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "X-Title": "AI Bookmark Organizer"
});

// Robustly pull a JSON object out of a model response that may include
// markdown fences, leading prose, or trailing junk. Throws if no object found.
function extractJson(content) {
    let text = (content || "").trim();

    // Strip markdown code fences if present
    if (text.includes("```")) {
        text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    }

    // Slice from the first "{" to the last "}" — drops any prose around it
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
        text = text.slice(start, end + 1);
    }

    try {
        return JSON.parse(text);
    } catch (firstErr) {
        // Models sometimes emit raw control characters inside string values
        // (e.g. a literal newline echoed from a bookmark title), which is
        // invalid JSON. Replacing every control character with a space is
        // safe: between tokens it is already whitespace, and inside a string
        // it repairs the bad literal without losing surrounding text.
        // eslint-disable-next-line no-control-regex
        const repaired = text.replace(/[\u0000-\u001F]/g, " ");
        try {
            return JSON.parse(repaired);
        } catch {
            throw firstErr;
        }
    }
}

// Repair a JSON object that was cut off mid-generation (the model hit its
// output token ceiling). Walks the text tracking string state and bracket
// depth, rewinds to the last point where a value was cleanly completed, drops
// the partial element after it, and closes the still-open brackets.
//
// Only safe where losing the tail is acceptable. That is true for the folder
// schema (a slightly smaller structure is still usable, and validateSchema
// judges the result anyway) and false for classification batches, where a
// dropped tail means silently losing bookmarks — those subdivide and retry
// instead.
export function salvagePartialJson(content) {
    let text = (content || "").trim();

    if (text.includes("```")) {
        text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    }

    const start = text.indexOf("{");
    if (start === -1) return null;
    text = text.slice(start);

    const stack = [];
    let inString = false;
    let escaped = false;
    let cut = -1;
    let closers = null;
    let prevCut = -1;
    let prevClosers = null;

    // Only a closed string, a closed bracket, or a comma marks a point we can
    // safely truncate at. A bare number or keyword may itself be half-written,
    // so those never become cut points — we rewind past them instead.
    const markSafe = (index) => {
        prevCut = cut;
        prevClosers = closers;
        cut = index;
        closers = [...stack];
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') {
                inString = false;
                markSafe(i + 1);
            }
            continue;
        }

        if (ch === '"') inString = true;
        else if (ch === "{") stack.push("}");
        else if (ch === "[") stack.push("]");
        else if (ch === "}" || ch === "]") {
            stack.pop();
            markSafe(i + 1);
        } else if (ch === ",") {
            // Cut before the comma so the incomplete element following it goes away.
            markSafe(i);
        } else if (ch === ":") {
            // The string that just closed was a key, not a value. Cutting there
            // would leave a dangling `{"key"}`, so undo the mark it set.
            cut = prevCut;
            closers = prevClosers;
        }
    }

    if (cut <= 0 || !closers) return null;

    const repaired = text.slice(0, cut) + closers.reverse().join("");
    try {
        return JSON.parse(repaired);
    } catch {
        return null;
    }
}

// Short, human-readable label for common HTTP status codes so the log/UI
// says what actually went wrong instead of echoing a provider error blob.
const STATUS_LABELS = {
    400: "bad request (the model may have rejected the prompt)",
    401: "invalid or missing API key",
    402: "insufficient credits on your account",
    403: "access denied for this API key or model",
    404: "model not found",
    408: "the request timed out",
    413: "request too large — try a smaller batch",
    429: "rate limited — too many requests",
    500: "provider server error",
    502: "provider is unavailable (bad gateway)",
    503: "provider is temporarily overloaded",
    504: "provider timed out (gateway timeout)"
};

// Turn a raw API error response into one concise sentence. Providers return a
// full JSON body (OpenRouter and Gemini both nest the useful text under
// `error.message`); dumping the whole thing floods the terminal, so we pull
// out just the message and pair it with a friendly status label.
function summarizeApiError(response, errorText) {
    const status = response?.status || 500;
    const label = STATUS_LABELS[status] || `request failed (HTTP ${status})`;

    let detail = "";
    try {
        const body = JSON.parse(errorText);
        detail = body?.error?.message || body?.message || "";
    } catch {
        // Not JSON (e.g. an HTML gateway page) — fall back to the raw text.
        detail = (errorText || "").trim();
    }

    // Collapse whitespace and cap the length so a stray verbose message can't
    // recreate the exact "wall of JSON" problem we're fixing.
    detail = detail.replace(/\s+/g, " ").trim();
    if (detail.length > 160) detail = detail.slice(0, 157) + "…";

    const error = new Error(detail ? `${label} — ${detail}` : label);
    error.statusCode = status;

    if (response?.headers?.get) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        if (Number.isFinite(retryAfter) && retryAfter >= 0) {
            error.retryAfterMs = retryAfter * 1000;
        }
    }

    return error;
}

// Determine if an error is retryable (transient) vs permanent
export function isRetryableError(error, statusCode) {
    // Explicitly flagged (e.g. malformed/truncated model output): the request
    // succeeded but the response was unusable — a fresh attempt may differ.
    if (error?.retryable) return true;

    // Permanent client errors are never retryable
    if ([400, 401, 402, 403, 404].includes(statusCode)) return false;

    const message = (error?.message || '').toLowerCase();
    const name = (error?.name || '').toLowerCase();

    if (message.includes('rate') || message.includes('quota')) return true;

    if (!statusCode) {
        // Network/timeout errors are retryable
        return name === 'aborterror' ||
               name === 'timeouterror' ||
               message.includes('timeout') ||
               message.includes('network') ||
               message.includes('fetch') ||
               message.includes('connection') ||
               message.includes('abort');
    }

    // Retryable HTTP status codes:
    // 408 = Request Timeout, 429 = Rate Limited, 500 = Server Error, 502 = Bad Gateway, 503 = Service Unavailable, 504 = Gateway Timeout
    return [408, 429, 500, 502, 503, 504].includes(statusCode);
}

// Check if an error was caused by a network drop, timeout, or unreachable host
export function isNetworkError(error) {
    if (!error) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;

    const statusCode = error.statusCode;
    if ([408, 502, 503, 504].includes(statusCode)) return true;

    const msg = (error.message || '').toLowerCase();
    return msg.includes('network') ||
           msg.includes('timeout') ||
           msg.includes('fetch') ||
           msg.includes('connection') ||
           msg.includes('econnrefused') ||
           msg.includes('econnreset') ||
           msg.includes('etimedout') ||
           msg.includes('enotfound') ||
           msg.includes('offline') ||
           msg.includes('load failed') ||
           msg.includes('abort');
}

// Check if an error was caused by rate limits / quota exhaustion
export function isRateLimitError(error) {
    if (!error) return false;
    const statusCode = error.statusCode;
    if (statusCode === 429) return true;
    const msg = (error.message || '').toLowerCase();
    return msg.includes('rate') || msg.includes('quota') || msg.includes('too many requests');
}

// Validate a completion response and extract its JSON payload. Throws errors
// that name the actual problem (empty / truncated / invalid JSON) and marks
// them retryable, since a fresh generation may well succeed.
function parseModelResponse(data, { salvageTruncated = false } = {}) {
    const choice = data.choices?.[0];
    const content = choice?.message?.content;

    if (!content) {
        const error = new Error("model returned an empty response");
        error.retryable = true;
        throw error;
    }

    if (choice.finish_reason === 'length') {
        const salvaged = salvageTruncated ? salvagePartialJson(content) : null;
        if (salvaged) return salvaged;

        const error = new Error("model response was cut off at the max_tokens limit");
        error.retryable = true;
        throw error;
    }

    try {
        return extractJson(content);
    } catch (parseErr) {
        const error = new Error(`model returned invalid JSON (${parseErr.message})`);
        error.retryable = true;
        throw error;
    }
}

// The same single API-key field accepts keys from either provider. Google AI
// Studio keys start with "AIza"; everything else (OpenRouter "sk-or-...",
// OpenAI-style "sk-...") is treated as OpenRouter.
export function detectProvider(apiKey) {
    return (apiKey || '').trim().startsWith('AIza') ? 'gemini' : 'openrouter';
}

// Model ids in the UI are OpenRouter-namespaced ("google/gemini-3.1-flash-lite").
// The native Gemini API wants the bare id ("gemini-3.1-flash-lite").
export function geminiModelId(model) {
    const bare = model.replace(/^google\//, '');
    // Google AI Studio deprecated gemini-2.5-pro for new users in favor of gemini-3.1-pro-preview
    if (bare === 'gemini-2.5-pro') {
        return 'gemini-3.1-pro-preview';
    }
    return bare;
}

// Validate a native Gemini generateContent response and extract its JSON
// payload, mirroring parseModelResponse: name the actual failure and mark it
// retryable so a fresh generation can succeed.
function parseGeminiResponse(data, { salvageTruncated = false } = {}) {
    if (data.promptFeedback?.blockReason) {
        const error = new Error(`Gemini blocked the request (${data.promptFeedback.blockReason})`);
        throw error; // safety blocks are not transient — do not retry
    }

    const candidate = data.candidates?.[0];
    const content = candidate?.content?.parts?.map(p => p.text).filter(Boolean).join('');

    if (!content) {
        const error = new Error("model returned an empty response");
        error.retryable = true;
        throw error;
    }

    if (candidate.finishReason === 'MAX_TOKENS') {
        const salvaged = salvageTruncated ? salvagePartialJson(content) : null;
        if (salvaged) return salvaged;

        const error = new Error("model response was cut off at the max output token limit");
        error.retryable = true;
        throw error;
    }

    try {
        return extractJson(content);
    } catch (parseErr) {
        const error = new Error(`model returned invalid JSON (${parseErr.message})`);
        error.retryable = true;
        throw error;
    }
}

// Single model call routed to the right provider by key prefix. Returns the
// parsed JSON object. Throws errors tagged with statusCode/retryable so the
// shared withRetry wrapper can decide whether to back off and try again.
const REQUEST_TIMEOUT_MS = 30000;

async function fetchWithTimeout(url, options = {}, isCancelled = null) {
    const controller = new AbortController();
    let cancelTimer = null;

    const timer = setTimeout(() => {
        controller.abort(new Error("request timeout"));
    }, REQUEST_TIMEOUT_MS);

    if (typeof isCancelled === 'function') {
        cancelTimer = setInterval(() => {
            if (isCancelled()) {
                const cancelErr = new Error('Operation cancelled.');
                cancelErr.isCancelled = true;
                controller.abort(cancelErr);
            }
        }, 150);
    }

    try {
        const response = await fetch(url, { ...options, signal: controller.signal });

        let bodyText = '';
        let bodyJson = null;

        if (!response.ok) {
            if (typeof response.text === 'function') {
                bodyText = await response.text();
            } else if (typeof response.json === 'function') {
                const j = await response.json();
                bodyText = typeof j === 'string' ? j : JSON.stringify(j);
            }
            throw summarizeApiError(response, bodyText);
        }

        if (typeof response.json === 'function') {
            bodyJson = await response.json();
        } else if (typeof response.text === 'function') {
            bodyText = await response.text();
            bodyJson = JSON.parse(bodyText);
        }

        return bodyJson;
    } finally {
        clearTimeout(timer);
        if (cancelTimer) clearInterval(cancelTimer);
    }
}

// Single model call routed to the right provider by key prefix. Returns the
// parsed JSON object. Throws errors tagged with statusCode/retryable so the
// shared withRetry wrapper can decide whether to back off and try again.
async function callModel(apiKey, model, systemContent, userContent, { temperature, maxTokens, salvageTruncated = false }, isCancelled = null) {
    if (detectProvider(apiKey) === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelId(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const data = await fetchWithTimeout(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: systemContent }] },
                contents: [{ role: "user", parts: [{ text: userContent }] }],
                generationConfig: {
                    temperature,
                    maxOutputTokens: maxTokens,
                    responseMimeType: "application/json"
                }
            })
        }, isCancelled);

        return parseGeminiResponse(data, { salvageTruncated });
    }

    const data = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: OR_HEADERS(apiKey),
        body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            messages: [
                { role: "system", content: systemContent },
                { role: "user", content: userContent }
            ],
            response_format: { type: "json_object" }
        })
    }, isCancelled);

    return parseModelResponse(data, { salvageTruncated });
}

// Generic retry wrapper with exponential backoff, rate-limit cooldowns, jitter, Retry-After header support, and cancellation
export async function withRetry(fn, maxRetries = 5, initialDelayMs = 1500, isCancelled = null, onRetry = null) {
    let attempt = 1;

    const checkCancelled = () => {
        if (!isCancelled) return false;
        return typeof isCancelled === 'function' ? isCancelled() : Boolean(isCancelled);
    };

    while (true) {
        if (checkCancelled()) {
            const err = new Error('Operation cancelled.');
            err.isCancelled = true;
            throw err;
        }

        try {
            return await fn();
        } catch (error) {
            if (error?.isCancelled) {
                throw error;
            }

            // Extract status code if available
            const statusCode = error.statusCode || (error.message?.match(/\b([45]\d{2})\b/) ? parseInt(error.message.match(/\b([45]\d{2})\b/)[1], 10) : null);
            const msgLower = (error?.message || '').toLowerCase();
            const isPermanent = [400, 401, 402, 403, 404].includes(statusCode);
            const isRateLimit = !isPermanent && (statusCode === 429 || msgLower.includes('rate') || msgLower.includes('quota'));

            const maxAttempts = isRateLimit ? 8 : maxRetries;

            // If not retryable or this was the last attempt, throw
            if ((!isRetryableError(error, statusCode) && !isRateLimit) || attempt >= maxAttempts) {
                throw error;
            }

            let delayMs;
            if (isRateLimit) {
                const progressive = 5000 * Math.pow(1.8, attempt - 1) * (0.8 + Math.random() * 0.4);
                delayMs = (typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0)
                    ? error.retryAfterMs
                    : Math.min(60000, progressive);
            } else {
                const exponentialDelay = initialDelayMs * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
                delayMs = Math.min(30000, Math.max(exponentialDelay, error.retryAfterMs || 0));
            }

            console.log(`Attempt ${attempt} failed (${isRateLimit ? 'rate limit' : 'retryable'}), retrying in ${Math.round(delayMs)}ms:`, error.message);

            if (typeof onRetry === 'function') {
                try {
                    onRetry({ attempt, delayMs, error, isRateLimit });
                } catch (cbErr) {
                    console.error('Error in onRetry callback:', cbErr);
                }
            }

            let elapsed = 0;
            const stepMs = 200;
            while (elapsed < delayMs) {
                if (checkCancelled()) {
                    const err = new Error('Operation cancelled.');
                    err.isCancelled = true;
                    throw err;
                }
                const sleepTime = Math.min(stepMs, delayMs - elapsed);
                await new Promise(resolve => setTimeout(resolve, sleepTime));
                elapsed += sleepTime;
            }

            if (checkCancelled()) {
                const err = new Error('Operation cancelled.');
                err.isCancelled = true;
                throw err;
            }

            attempt++;
        }
    }
}

// Schema design — inferred or fixed-category — only needs a representative
// spread of the collection, not every bookmark. A sample of 200 bookmarks
// provides rich topical variance while keeping prompt serialization and
// inference instantaneous (< 1-2s); themes the sample misses are still placed
// by classification's proposed-subcategory rule and reconciliation.
export const SCHEMA_SAMPLE_LIMIT = 200;

// The schema JSON is small (8-10 categories x up to ~14 subcategories), but the
// old 8000 ceiling left no headroom: a run that overshot it was flagged
// retryable, truncated on all 5 retries, and fell through to the flat-schema
// fallback that put every bookmark in "General".
export const SCHEMA_MAX_TOKENS = 16000;

export const DETAIL_SCHEMA_GROUP_LIMIT = 12;
export const DETAIL_SCHEMA_SAMPLE_LIMIT = 60;
export const DETAIL_CLASSIFICATION_BATCH_SIZE = 50;
export const DETAIL_MIN_BOOKMARKS = 6;
export const DETAIL_MIN_FOLDER_SIZE = 2;
export const DETAIL_MAX_FOLDERS = 4;

// Evenly spaced sample across the whole list. Bookmark exports are grouped by
// folder, so spacing preserves topic variety better than taking the first N.
function sampleForSchema(bookmarks, limit = SCHEMA_SAMPLE_LIMIT) {
    if (bookmarks.length <= limit) return bookmarks;
    const step = bookmarks.length / limit;
    return Array.from({ length: limit }, (_, i) => bookmarks[Math.floor(i * step)]);
}

// Subcategory counts per category, keyed by the user's granularity setting.
// `ask` is the range we request from the model, `min` the floor we actually
// enforce (models routinely undershoot the ask, and rejecting a slightly thin
// but usable schema would cost a whole extra round-trip), and `max` the ceiling
// the reconciliation pass enforces after classification.
export const SUBFOLDER_BOUNDS = {
    '1-3': { ask: [1, 3], min: 1, max: 3 },
    '3-6': { ask: [3, 6], min: 2, max: 6 },
    '6-10': { ask: [6, 10], min: 3, max: 10 },
    '0-5': { ask: [3, 5], min: 2, max: 5 },
    '5-10': { ask: [5, 10], min: 3, max: 10 },
    '10+': { ask: [10, 14], min: 5, max: 16 }
};

export function subfolderBounds(subfolderTarget) {
    return SUBFOLDER_BOUNDS[subfolderTarget] || SUBFOLDER_BOUNDS['1-3'];
}

// Categories that exist to absorb outliers. They are allowed to carry no
// subcategories of their own, so they never fail validation.
const CATCH_ALL_CATEGORIES = new Set(['other', 'archive', 'uncategorized', 'general']);

// In inferred mode, reject a broader family of names whose only purpose is
// absorbing bookmarks that the model did not place topically. Keep this
// separate from CATCH_ALL_CATEGORIES so explicit manual categories retain
// their existing validation behavior.
const INFERRED_FILLER_CATEGORIES = new Set([
    ...CATCH_ALL_CATEGORIES,
    'others',
    'misc',
    'miscellaneous',
    'various',
    'assorted',
    'everything else',
    'other stuff',
    'catch all',
    'uncategorised',
    'unclassified',
    'unsorted',
    'unknown',
    'none'
]);
const INFERRED_FILLER_PREFIXES = new Set([
    'misc',
    'miscellaneous',
    'various',
    'assorted',
    'other',
    'others',
    'uncategorized',
    'uncategorised',
    'general'
]);
const INFERRED_FILLER_SUFFIXES = new Set([
    'item',
    'items',
    'link',
    'links',
    'topic',
    'topics',
    'stuff',
    'content',
    'bookmark',
    'bookmarks',
    'resource',
    'resources'
]);

// Subcategory names carrying no organizational information. They are stripped
// before counting, so a "schema" of nothing but "General" reads as flat —
// which is exactly what it is, and exactly the bug we are guarding against.
const FILLER_SUBCATEGORIES = new Set(['general', 'other', 'misc', 'miscellaneous', 'uncategorized', 'none', 'various']);

function isCatchAllCategory(name) {
    return CATCH_ALL_CATEGORIES.has((name || '').trim().toLowerCase());
}

function isInferredFillerCategory(name) {
    const normalized = (name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (INFERRED_FILLER_CATEGORIES.has(normalized)) return true;

    const [prefix, ...suffixes] = normalized.split(' ');
    return INFERRED_FILLER_PREFIXES.has(prefix)
        && suffixes.length > 0
        && suffixes.every(suffix => INFERRED_FILLER_SUFFIXES.has(suffix));
}

// A collection this small cannot support a rich structure — one real
// subcategory per category is a legitimate result, not a degenerate one.
const TINY_COLLECTION_THRESHOLD = 40;

// Validate a model-generated schema and return a cleaned copy alongside any
// reasons it is unusable. Normalizing here means callers (and the classifier)
// never see filler subcategories or case-duplicate folder names.
export function validateSchema(schema, { subfolderTarget = '1-3', bookmarkCount = Infinity, expectedCategories = null } = {}) {
    const issues = [];
    const rawCategories = Array.isArray(schema?.categories) ? schema.categories : null;

    if (!rawCategories || rawCategories.length === 0) {
        return { ok: false, issues: ['the response contained no categories'], schema: { categories: [] } };
    }

    const { min } = subfolderBounds(subfolderTarget);
    const requiredMin = bookmarkCount < TINY_COLLECTION_THRESHOLD ? 1 : min;

    const categories = [];
    const seenCategories = new Set();

    for (const raw of rawCategories) {
        const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
        if (!name) continue;

        const key = name.toLowerCase();
        if (seenCategories.has(key)) continue;
        seenCategories.add(key);

        const seenSubs = new Set();
        const sub_categories = [];
        for (const rawSub of Array.isArray(raw.sub_categories) ? raw.sub_categories : []) {
            if (typeof rawSub !== 'string') continue;
            const sub = rawSub.trim();
            if (!sub) continue;
            const subKey = canonicalKey(sub);
            // Filler names and a subcategory echoing its own parent add no structure.
            if (FILLER_SUBCATEGORIES.has(sub.toLowerCase()) || subKey === canonicalKey(name)) continue;
            if (seenSubs.has(subKey)) continue;
            seenSubs.add(subKey);
            sub_categories.push(sub);
        }

        categories.push({ name, sub_categories });
    }

    if (categories.length === 0) {
        return { ok: false, issues: ['no category had a usable name'], schema: { categories: [] } };
    }

    if (expectedCategories === null) {
        const catchAllNames = categories
            .filter(category => isInferredFillerCategory(category.name))
            .map(category => category.name);
        if (catchAllNames.length > 0) {
            issues.push(`catch-all top-level categories are not allowed in an inferred schema: ${catchAllNames.join(', ')}`);
        }
    }

    // A truncated response leaves omitted selected categories with only their
    // General fallback. Require enough breadth to avoid losing useful structure,
    // but never demand more categories than the user selected.
    // Tiny collections are exempt, as with the relaxed subcategory floor.
    const floor = Array.isArray(expectedCategories) && expectedCategories.length > 0
        ? Math.min(expectedCategories.length, Math.max(3, Math.ceil(expectedCategories.length / 2)))
        : 3;
    if (bookmarkCount >= TINY_COLLECTION_THRESHOLD && categories.length < floor) {
        issues.push(`the response covered only ${categories.length} categories; at least ${floor} are needed`);
    }

    // Catch-all categories legitimately carry no subcategories, so they take
    // part in neither the per-category floor nor the overall ratio.
    const real = categories.filter(c => !isCatchAllCategory(c.name));

    const thin = real
        .filter(c => c.sub_categories.length < requiredMin)
        .map(c => `"${c.name}" has ${c.sub_categories.length}`);

    if (thin.length > 0) {
        issues.push(`every category needs at least ${requiredMin} subcategories, but ${thin.join(', ')}`);
    }

    // A schema averaging one subcategory per category is flat in practice even
    // when each category technically clears the floor. Tiny collections are
    // exempt for the same reason they get a relaxed floor: there is not enough
    // material to build a rich structure from.
    const totalSubs = real.reduce((sum, c) => sum + c.sub_categories.length, 0);
    if (real.length > 0 && bookmarkCount >= TINY_COLLECTION_THRESHOLD && totalSubs <= real.length) {
        issues.push(`the structure is flat overall (${totalSubs} subcategories across ${real.length} categories)`);
    }

    return { ok: issues.length === 0, issues, schema: { categories } };
}

const SUBFOLDER_RULES = {
    '1-3': 'Keep it very compact — create only 1-3 subfolders for the clearest, genuinely distinct groups. Combine related items into broader folders rather than splitting too finely.',
    '3-6': 'Create a focused structure of 3-6 subfolders for the clearest groups. Combine closely related topics and avoid one-off folders.',
    '6-10': 'Create a detailed but scannable structure of 6-10 subfolders. Use specific topics only when each folder has a meaningful group of bookmarks.',
    '0-5': 'Keep it minimal — only create subfolders for truly distinct groups, and err on the side of combining related items into broader folders.',
    '5-10': 'About 7-8 is the sweet spot: enough to be genuinely useful, few enough to scan at a glance. Scale to the content — a content-heavy category can carry more, a sparse one fewer.',
    '10+': 'Be generous with specific subfolders for different topics, so each bookmark has a precise home.'
};

function buildSchemaPrompt({ bookmarks, bookmarkCount = bookmarks.length, askMin, askMax, subfolderTarget, fixedCategories = null, issues = null, sampleLimit = SCHEMA_SAMPLE_LIMIT }) {
    const subfolderGuidance = SUBFOLDER_RULES[subfolderTarget] || SUBFOLDER_RULES['1-3'];

    // Both modes sample: inferred-category design previously serialized the
    // ENTIRE collection into the prompt, which for large libraries produced a
    // multi-hundred-thousand-token request that was slow, expensive, and over
    // the context window of most OpenRouter models.
    const schemaSource = sampleForSchema(bookmarks, sampleLimit);
    const sampleNote = schemaSource.length < bookmarkCount
        ? `\n    NOTE: The list below is a representative sample of ${schemaSource.length} bookmarks drawn evenly from the full collection. Design the structure for the ENTIRE collection of ${bookmarkCount}.\n`
        : '';

    const correction = issues?.length
            ? `
    CORRECTION REQUIRED — YOUR PREVIOUS ANSWER WAS REJECTED
    Reason: ${issues.join('; ')}.
    Your previous structure was too flat. Every category MUST contain at least ${askMin} distinct, specific subcategories. Never return an empty "sub_categories" array, and never use "General" or "Other" as a subcategory name. Look harder at the bookmarks below and find the real topical groupings.
`
            : '';

    const categoryInstructions = fixedCategories
        ? `
    FIXED TOP-LEVEL CATEGORIES (use every name exactly as written; do not rename, omit, or add categories):
    ${JSON.stringify(fixedCategories)}
`
        : `
    TOP-LEVEL CATEGORY DESIGN
    Create broad, mutually exclusive top-level categories inferred from the bookmarks. Use a topical category whenever one is possible; do not create filler categories such as "Other", "Archive", "Uncategorized", or "General" just to absorb items.
    Every category name must be 1-3 words in Title Case. Each bookmark should have exactly one obvious destination.
`;
    const structureInstruction = fixedCategories
        ? 'The fixed top-level categories above are authoritative. Design subcategories inside each one; every bookmark must have a natural home.'
        : 'The inferred top-level categories are authoritative for this response. Keep them broad and non-overlapping, and make every bookmark fit one natural home.';
    const outlierInstruction = fixedCategories
        ? 'A genuine outlier still belongs in the closest fixed top-level category. Use its "General" subcategory when no specific subcategory fits; do not add an "Other" category or invent a filler subcategory.'
        : 'A genuine outlier still belongs in the closest topical category. Do not add an "Other" category or invent a filler subcategory.';

    return `
    You are an expert information architect designing an intuitive bookmark folder structure for a real person's collection of ${bookmarkCount} bookmarks.
    ${sampleNote}${correction}

    GOAL
    Design a clean two-level structure: broad top-level CATEGORIES, each holding nested SUB-CATEGORIES. A person should glance at the folders and instantly know where any link lives — like a well-organized bookshelf, not a sprawling database.

    THE SUBCATEGORIES ARE THE POINT
    1. For EVERY category you MUST define ${askMin}-${askMax} concrete, mutually exclusive subcategories. ${subfolderGuidance}
    2. A category with an empty "sub_categories" array is INVALID and will be rejected. Categories are just the shelves; the subcategories are what make the collection browsable.
    3. Never use "General", "Other", "Misc" or "Various" as a subcategory name. If you are tempted to, you have not looked hard enough at what the bookmarks actually have in common — find the real grouping instead.

    ${categoryInstructions}

    STRUCTURE RULES
    4. ${structureInstruction}
    5. NON-REDUNDANCY IS CRITICAL. Sub-categories within a category MUST be mutually exclusive. Never create near-duplicates or synonyms as separate folders. Collapse "Tech News" + "Tech Articles" + "Tech Blogs" + "Tech Reports" into ONE folder. Collapse "Career Advice" + "Career Pathways" + "Career Roles" into ONE folder. Collapse "JS" + "JavaScript" into ONE. If two folder names could plausibly hold the same bookmark, merge them.
    6. Group by the user's INTENT, not surface keywords. Ask "why did they save this?" Links saved for the same purpose belong together even when their titles look different.

    NAMING RULES
    7. Use clear, human, real-world names a non-technical person understands. Prefer "Job Search" over "Career Acquisition Pipeline".
    8. Keep names short (1-3 words), in Title Case. No emojis, no numbering, no slashes.
    9. A folder's contents should be obvious from its name alone.

    QUALITY BAR
    10. No orphan folders: every sub-category should plausibly hold several bookmarks. Never create a folder for a single link — merge it into the nearest fit.
    11. Categories themselves must not overlap either. Each bookmark should have exactly ONE obvious destination, never two or three.
    12. ${outlierInstruction}

    OUTPUT — return ONLY this JSON, no markdown fences, no commentary:
    {
      "categories": [
        {
          "name": "Category Name",
          "sub_categories": ["Subcategory A", "Subcategory B"]
        }
      ]
    }

    BOOKMARKS TO ANALYZE:
    ${JSON.stringify(schemaSource.map(b => ({ title: b.title, url: b.url })))}
    `;
}

const requestSchema = (prompt, apiKey, model, isCancelled, onRetry) => withRetry(
    () => callModel(apiKey, model, "You are an expert information architect and precise JSON generator. Output only valid JSON. Do not use Markdown blocks.", prompt, { temperature: 0.2, maxTokens: SCHEMA_MAX_TOKENS, salvageTruncated: true }, isCancelled),
    5,
    1500,
    isCancelled,
    onRetry
);

export async function generateSchema(bookmarks, apiKey, baseCategories, model = "google/gemini-3.1-flash-lite", subfolderTarget = "1-3", isCancelled = null, onRetry = null, sampleLimit = SCHEMA_SAMPLE_LIMIT) {
    const { ask: [askMin, askMax] } = subfolderBounds(subfolderTarget);
    const buildPrompt = issues => buildSchemaPrompt({ bookmarks, askMin, askMax, subfolderTarget, fixedCategories: baseCategories, issues, sampleLimit });
    const attempt = issues => requestSchema(buildPrompt(issues), apiKey, model, isCancelled, onRetry);

    const options = { subfolderTarget, bookmarkCount: bookmarks.length, expectedCategories: baseCategories };

    const first = validateSchema(await attempt(null), options);
    if (first.ok) return buildAuthoritativeSchema(baseCategories, first.schema);

    // One corrective round-trip naming exactly what was wrong. Models that
    // return a flat structure usually fix it when told so explicitly.
    if (typeof onRetry === 'function') {
        onRetry({ attempt: 1, delayMs: 0, error: new Error(first.issues.join('; ')), isRateLimit: false, isSchemaCorrection: true });
    }

    const second = validateSchema(await attempt(first.issues), options);
    if (second.ok) return buildAuthoritativeSchema(baseCategories, second.schema);

    const error = new Error(`the AI returned a folder structure without usable subcategories (${second.issues.join('; ')})`);
    error.schemaInvalid = true;
    // Whatever categories did come back are still better than nothing — the
    // caller merges them with curated defaults rather than starting from zero.
    error.partialSchema = second.schema;
    throw error;
}

export async function generateInferredSchema(
    bookmarks,
    apiKey,
    model = 'google/gemini-3.1-flash-lite',
    subfolderTarget = '1-3',
    isCancelled = null,
    onRetry = null
) {
    const { ask: [askMin, askMax] } = subfolderBounds(subfolderTarget);
    const buildPrompt = issues => buildSchemaPrompt({ bookmarks, askMin, askMax, subfolderTarget, fixedCategories: null, issues });
    const attempt = issues => requestSchema(buildPrompt(issues), apiKey, model, isCancelled, onRetry);
    const options = { subfolderTarget, bookmarkCount: bookmarks.length, expectedCategories: null };

    const first = validateSchema(await attempt(null), options);
    if (first.ok) return first.schema;
    if (typeof onRetry === 'function') {
        onRetry({ attempt: 1, delayMs: 0, error: new Error(first.issues.join('; ')), isRateLimit: false, isSchemaCorrection: true });
    }

    const second = validateSchema(await attempt(first.issues), options);
    if (second.ok) return second.schema;

    const error = new Error(`the AI could not infer a usable folder structure (${second.issues.join('; ')})`);
    error.schemaInvalid = true;
    throw error;
}

const DETAIL_FILLER_NAMES = new Set([
    'general',
    'other',
    'none',
    'uncategorized',
    'uncategorised',
    'misc',
    'miscellaneous',
    'various',
    'assorted',
    'everything else',
    'other stuff',
    'catch all',
    'catch-all',
    'unclassified',
    'unsorted',
    'unknown',
    'bookmarks',
    'links',
    'items',
    'resources',
    'content',
    'stuff'
]);

function canonicalDetailParentKey(category, subCategory) {
    if (typeof category !== 'string' || typeof subCategory !== 'string') return '';
    return `${canonicalKey(category)}\u0000${canonicalKey(subCategory)}`;
}

function recordsForDetailGroup(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.bookmarks)) return value.bookmarks;
    if (Array.isArray(value?.records)) return value.records;
    if (Array.isArray(value?.items)) return value.items;
    return [];
}

function detailGroupEntries(groups) {
    let rawEntries = [];
    if (groups instanceof Map) {
        rawEntries = [...groups.entries()].map(([key, value]) => ({ key, value }));
    } else if (Array.isArray(groups)) {
        rawEntries = groups.map((value, index) => {
            if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
                return { key: value[0], value: value[1] };
            }
            return { key: typeof value?.key === 'string' ? value.key : index, value };
        });
    } else if (groups && typeof groups === 'object') {
        rawEntries = Object.entries(groups).map(([key, value]) => ({ key, value }));
    }

    const entries = [];
    const seen = new Set();
    for (const { key: rawKey, value } of rawEntries) {
        const records = recordsForDetailGroup(value);
        const first = records.find(record => typeof record?.category === 'string' && typeof record?.sub_category === 'string');
        const keyParts = typeof rawKey === 'string' ? rawKey.split('\u0000') : [];
        const category = typeof value?.category === 'string'
            ? value.category.trim()
            : (first?.category?.trim() || keyParts[0]?.trim() || '');
        const sub_category = typeof value?.sub_category === 'string'
            ? value.sub_category.trim()
            : (first?.sub_category?.trim() || keyParts[1]?.trim() || '');
        const canonicalPair = canonicalDetailParentKey(category, sub_category);
        if (!canonicalPair || seen.has(canonicalPair)) continue;
        seen.add(canonicalPair);
        entries.push({
            key: typeof rawKey === 'string' ? rawKey : `${category.toLowerCase()}\u0000${sub_category.toLowerCase()}`,
            canonicalPair,
            category,
            sub_category,
            records
        });
    }
    return entries;
}

function normalizeDetailName(rawName, category, subCategory) {
    if (typeof rawName !== 'string') return null;
    const name = rawName.trim().replace(/\s+/g, ' ');
    if (!name || DETAIL_FILLER_NAMES.has(name.toLowerCase())) return null;
    if (canonicalKey(name) === canonicalKey(category) || canonicalKey(name) === canonicalKey(subCategory)) return null;
    if (!shouldCreateDetailFolder(category, subCategory, name)) return null;
    return name;
}

/**
 * Validate a model-generated detail schema against the eligible parent groups.
 * The returned Map keeps the requested group's original key and approved name
 * spelling, which is the shape consumed by detail reconciliation.
 */
export function validateDetailSchema(response, requestedGroups) {
    const requested = detailGroupEntries(requestedGroups);
    const requestedByPair = new Map(requested.map(group => [group.canonicalPair, group]));
    const namesByGroup = new Map(requested.map(group => [group.key, []]));
    const issues = [];
    const rawGroups = Array.isArray(response?.groups) ? response.groups : [];

    if (rawGroups.length === 0) issues.push('the response contained no detail groups');

    for (const rawGroup of rawGroups) {
        const category = typeof rawGroup?.category === 'string' ? rawGroup.category.trim() : '';
        const subCategory = typeof rawGroup?.sub_category === 'string' ? rawGroup.sub_category.trim() : '';
        const requestedGroup = requestedByPair.get(canonicalDetailParentKey(category, subCategory));
        if (!requestedGroup) {
            issues.push(`ignored unknown detail parent pair "${category}/${subCategory}"`);
            continue;
        }

        const names = Array.isArray(rawGroup.detail_categories) ? rawGroup.detail_categories : [];
        const seenNames = new Set(namesByGroup.get(requestedGroup.key).map(name => canonicalKey(name)));
        for (const rawName of names) {
            const name = normalizeDetailName(rawName, requestedGroup.category, requestedGroup.sub_category);
            if (!name) continue;
            const identity = canonicalKey(name);
            if (seenNames.has(identity)) continue;
            seenNames.add(identity);
            namesByGroup.get(requestedGroup.key).push(name);
        }
    }

    const schemas = new Map();
    for (const group of requested) {
        const names = namesByGroup.get(group.key);
        const maxNames = Math.min(
            DETAIL_MAX_FOLDERS,
            Math.floor(group.records.length / DETAIL_MIN_FOLDER_SIZE)
        );
        if (names.length < 2 || maxNames < 2) {
            if (rawGroups.length > 0) {
                issues.push(`the detail group "${group.category}/${group.sub_category}" had fewer than two usable names`);
            }
            continue;
        }
        schemas.set(group.key, names.slice(0, maxNames));
    }

    if (schemas.size === 0) {
        issues.push('no requested detail group had at least two usable detail names');
    }

    return { ok: schemas.size > 0, schemas, issues };
}

/**
 * Build the bounded prompt used to infer detail folders. Groups are limited
 * before serialization and each group's sample is evenly spaced through its
 * original records.
 */
export function buildDetailSchemaPrompt(groups, issues = null) {
    const selectedGroups = detailGroupEntries(groups).slice(0, DETAIL_SCHEMA_GROUP_LIMIT);
    const promptGroups = selectedGroups.map(group => ({
        category: group.category,
        sub_category: group.sub_category,
        bookmarks: sampleForSchema(group.records, DETAIL_SCHEMA_SAMPLE_LIMIT).map((bookmark, i) => ({
            i,
            title: bookmark?.title || '',
            url: bookmark?.url || ''
        }))
    }));
    const correction = issues?.length
        ? `
    CORRECTION REQUIRED — YOUR PREVIOUS DETAIL SCHEMA WAS REJECTED.
    Reason: ${issues.join('; ')}.
    Return at least two meaningful detail names for at least one requested group, and omit invalid or unusable groups.
`
        : '';

    return `
    You are an expert information architect inferring useful third-level bookmark folders from real examples.
    ${correction}

    GOAL
    Propose detail folders only where the bookmarks show at least two meaningful, specific groups. A detail folder must make the existing category and subcategory easier to scan.

    NAMING RULES
    1. Use short human-readable names in Title Case, preferably 1-3 words.
    2. Do not use filler names such as "General", "Other", "Misc", "Various", "Bookmarks", or "Links".
    3. Never use a name that echoes the category or subcategory, is empty, or contains a slash or backslash. Do not invent path-like names.
    4. Use at most 4 detail names per group and only return names that could each contain at least two bookmarks.
    5. Keep requested category and sub_category spellings exactly as provided. Do not add unknown parent pairs.

    OUTPUT — return ONLY this JSON object, with no markdown or commentary:
    { "groups": [{ "category": "...", "sub_category": "...", "detail_categories": ["..."] }] }

    BOOKMARK GROUPS:
    ${JSON.stringify(promptGroups)}
    `;
}

const requestDetailSchema = (prompt, apiKey, model, isCancelled, onRetry) => withRetry(
    () => callModel(
        apiKey,
        model,
        'You are a precise information architect and JSON generator. Output only valid JSON. Do not use Markdown blocks.',
        prompt,
        { temperature: 0.2, maxTokens: 8000, salvageTruncated: true },
        isCancelled
    ),
    5,
    1500,
    isCancelled,
    onRetry
);

// Detail-schema batches carry up to DETAIL_SCHEMA_GROUP_LIMIT groups of
// DETAIL_SCHEMA_SAMPLE_LIMIT bookmarks each, so they are heavy requests.
// A small pool keeps large runs from serializing dozens of round-trips while
// leaving headroom under provider rate limits.
export const DETAIL_SCHEMA_CONCURRENCY = 3;

function isDetailCancelled(isCancelled) {
    return typeof isCancelled === 'function' ? isCancelled() : Boolean(isCancelled);
}

function detailCancellationError() {
    const error = new Error('Operation cancelled.');
    error.isCancelled = true;
    return error;
}

/**
 * Infer detail schemas in independent, bounded batches. A failed batch is
 * allowed to remain at two levels while valid sibling batches are retained.
 * Batches run through a small worker pool; per-batch correction and failure
 * semantics match the previous sequential behavior.
 */
export async function generateDetailSchemas(
    groups,
    apiKey,
    model = 'google/gemini-3.1-flash-lite',
    isCancelled = null,
    onRetry = null
) {
    if (isDetailCancelled(isCancelled)) throw detailCancellationError();

    const entries = detailGroupEntries(groups);
    const schemas = new Map();

    const batches = [];
    for (let start = 0; start < entries.length; start += DETAIL_SCHEMA_GROUP_LIMIT) {
        batches.push(entries.slice(start, start + DETAIL_SCHEMA_GROUP_LIMIT));
    }
    if (batches.length === 0) return schemas;

    const runBatch = async (batch) => {
        let first;
        try {
            first = validateDetailSchema(
                await requestDetailSchema(buildDetailSchemaPrompt(batch), apiKey, model, isCancelled, onRetry),
                batch
            );
        } catch (error) {
            if (error?.isCancelled) throw error;
            return;
        }

        let result = first;
        if (!first.ok) {
            if (typeof onRetry === 'function') {
                onRetry({
                    attempt: 1,
                    delayMs: 0,
                    error: new Error(first.issues.join('; ')),
                    isRateLimit: false,
                    isSchemaCorrection: true
                });
            }
            try {
                result = validateDetailSchema(
                    await requestDetailSchema(buildDetailSchemaPrompt(batch, first.issues), apiKey, model, isCancelled, onRetry),
                    batch
                );
            } catch (error) {
                if (error?.isCancelled) throw error;
                return;
            }
        }

        for (const [key, names] of result.schemas) schemas.set(key, names);
    };

    let batchIdx = 0;
    const worker = async () => {
        while (batchIdx < batches.length && !isDetailCancelled(isCancelled)) {
            const batch = batches[batchIdx++];
            await runBatch(batch);
        }
    };

    const workers = [];
    for (let i = 0; i < Math.min(DETAIL_SCHEMA_CONCURRENCY, batches.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    if (isDetailCancelled(isCancelled)) throw detailCancellationError();

    return schemas;
}

// A non-empty authoritative schema always starts with a user-selected category.
// Falling back there preserves the fixed hierarchy when a model response is
// malformed or a terminal request failure leaves no classification to trust.
export function fallbackCategoryForSchema(schema) {
    const category = (Array.isArray(schema?.categories) ? schema.categories : [])
        .find(c => typeof c?.name === 'string' && c.name.trim());
    return category?.name || 'Other';
}

// Resolve an AI classification against the approved two-level schema. A
// subcategory already owned by another category is not a new proposal: it is
// an invalid category/subcategory pair and belongs in the selected category's
// General bucket instead. Truly new names remain proposals for reconciliation.
export function normalizeClassificationForSchema(entry, schema) {
    const approvedCategories = (Array.isArray(schema?.categories) ? schema.categories : [])
        .filter(c => typeof c?.name === 'string' && c.name.trim());
    const fallbackCategory = fallbackCategoryForSchema(schema);
    const schemaCategories = new Map(
        approvedCategories.map(c => [
            c.name.trim().toLowerCase(),
            {
                name: c.name,
                subs: new Map((Array.isArray(c.sub_categories) ? c.sub_categories : [])
                    .filter(s => typeof s === 'string' && s.trim())
                    .map(s => [canonicalKey(s), s]))
            }
        ])
    );

    const rawCategory = typeof entry?.category === 'string' ? entry.category.trim() : '';
    const rawSub = typeof entry?.sub_category === 'string' ? entry.sub_category.trim() : '';
    const known = schemaCategories.get(rawCategory.toLowerCase());
    if (!known) return { category: fallbackCategory, sub_category: 'General', proposed: false };
    if (!rawSub) return { category: known.name, sub_category: 'General', proposed: false };

    const subKey = canonicalKey(rawSub);
    const approvedSub = known.subs.get(subKey);
    if (approvedSub) return { category: known.name, sub_category: approvedSub, proposed: false };

    const belongsToAnotherCategory = [...schemaCategories.values()]
        .some(candidate => candidate !== known && candidate.subs.has(subKey));
    if (belongsToAnotherCategory) return { category: known.name, sub_category: 'General', proposed: false };

    return { category: known.name, sub_category: rawSub, proposed: rawSub.toLowerCase() !== 'general' };
}

// Resolve a third-level classification only against the names approved for its
// exact parent pair. Unknown values are deliberately cleared, never proposed.
export function normalizeDetailClassification(entry, detailSchema) {
    const names = Array.isArray(detailSchema) ? detailSchema
        : (detailSchema?.detail_categories || detailSchema?.detailCategories || detailSchema?.details || []);
    const approved = new Map(names.filter(name => typeof name === 'string' && name.trim())
        .map(name => [canonicalKey(name), name.trim().replace(/\s+/g, ' ')]));
    if (typeof entry?.detail_category !== 'string') return null;
    return approved.get(canonicalKey(entry.detail_category.trim())) || null;
}

export async function classifyDetailBatch(bookmarks, apiKey, detailSchema, model = "google/gemini-3.1-flash-lite", isCancelled = null, onRetry = null) {
    const prompt = `
    Classify each bookmark into one approved detail folder for this exact parent category/subcategory.
    APPROVED DETAIL NAMES: ${JSON.stringify(detailSchema)}
    Return JSON only: { "classified": [{ "i": 0, "detail_category": "..." }] }
    Use only an approved name; use null when none fits. Every bookmark appears exactly once.
    BOOKMARKS (each with its index "i"):
    ${JSON.stringify(bookmarks.map((b, i) => ({ i, title: b.title, url: b.url })))}
    `;
    return withRetry(async () => {
        const parsed = await callModel(apiKey, model, 'You are a precise JSON classification engine. Output only valid JSON.', prompt, { temperature: 0.1, maxTokens: 4000 }, isCancelled);
        const byIndex = new Map((parsed.classified || []).filter(e => Number.isInteger(e?.i) && e.i >= 0 && e.i < bookmarks.length)
            .map(e => [e.i, e]));
        return bookmarks.map((bookmark, i) => ({ ...bookmark, detail_category: normalizeDetailClassification(byIndex.get(i), detailSchema) }));
    }, 5, 1500, isCancelled, onRetry);
}

export async function classifyBatch(bookmarks, apiKey, schema, model = "google/gemini-3.1-flash-lite", cleanTitles = false, isCancelled = null, onRetry = null) {
    const titleInstruction = cleanTitles
        ? `\n    7. Title cleanup: If clean_title is requested, provide a cleaned, human-readable title in the 'clean_title' field for each bookmark (strip site prefixes/suffixes like 'Login |', '- Wikipedia', query noise, or convert raw URL titles into clean titles). If the existing title is already clean, keep it as is.`
        : '';

    const returnSchema = cleanTitles
        ? '{ "classified": [ { "i": 0, "category": "...", "sub_category": "...", "clean_title": "..." } ] }'
        : '{ "classified": [ { "i": 0, "category": "...", "sub_category": "..." } ] }';

    const prompt = `
    Classify these ${bookmarks.length} bookmarks into the folder structure below.

    APPROVED SCHEMA:
    ${JSON.stringify(schema)}

    RULES
    1. For each bookmark, pick the single best-fitting category and sub_category, judging by the user's likely INTENT in saving it — not just keyword matching on the title.
    2. CATEGORY is fixed: you MUST use a "category" string EXACTLY as written in the schema above (same spelling, casing, spacing). Never invent a new category.
    3. SUB_CATEGORY: strongly prefer one written exactly as in the schema. The schema was designed from a sample, so it may miss a real theme. If at least 3 bookmarks in THIS batch share a clear, specific theme that no schema sub-category captures well, you MAY introduce ONE new sub_category for them under the correct existing category. Name it in Title Case, 1-3 words, and make sure it is not a synonym or near-duplicate of a sub-category already in the schema.
    4. Use "General" as the sub_category ONLY when a bookmark genuinely belongs in the category but fits no sub-category at all — neither an existing one nor a new one worth creating. This should be rare.
    5. If a bookmark fits no category at all, choose the closest approved category and use sub_category "General". Never add an "Other" category unless it is already in the approved schema.
    6. Every bookmark must be classified exactly once. Refer to each bookmark ONLY by its index "i" — do NOT repeat titles or urls in your output.${titleInstruction}

    Return JSON object: ${returnSchema}

    BOOKMARKS (each with its index "i"):
    ${JSON.stringify(bookmarks.map((b, i) => ({ i, title: b.title, url: b.url })))}
    `;

    const systemContent = "You are a precise classification engine and JSON generator. Output only valid JSON. Do not use Markdown blocks.";

    return await withRetry(async () => {
        const parsed = await callModel(apiKey, model, systemContent, prompt, { temperature: 0.1, maxTokens: 8000 }, isCancelled);

        // Join the model's index-only answers back to the source bookmarks.
        // Titles and urls come from OUR data, never from model output unless
        // cleanTitles is enabled and the model provides a valid clean_title.
        // The spread also carries fields the AI never sees (icon, add_date)
        // through to the export.
        const byIndex = new Map();
        for (const entry of parsed.classified || []) {
            if (Number.isInteger(entry.i) && entry.i >= 0 && entry.i < bookmarks.length && !byIndex.has(entry.i)) {
                byIndex.set(entry.i, entry);
            }
        }

        return bookmarks.map((b, i) => {
            const entry = byIndex.get(i);
            const hasCleanTitle = cleanTitles && typeof entry?.clean_title === 'string' && entry.clean_title.trim().length > 0;
            const { category, sub_category, proposed } = normalizeClassificationForSchema(entry, schema);

            return {
                ...b,
                title: hasCleanTitle ? entry.clean_title.trim() : b.title,
                category,
                sub_category,
                ...(proposed ? { proposed: true } : {})
            };
        });
    }, 5, 1500, isCancelled, onRetry);
}
