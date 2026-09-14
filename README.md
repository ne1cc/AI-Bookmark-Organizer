# AI Bookmark Organizer (Chrome & Firefox Extension)

Turn years of messy, unsorted bookmarks into a clean, browsable folder structure in one click — powered by Google Gemini via Google AI Studio or OpenRouter. Runs entirely in your browser's side panel (Chrome) or sidebar (Firefox): no account, no server, no data collection.

## 🚀 Features

- **One-Click Organization** — Reads your browser bookmarks and sorts hundreds or thousands of links into intuitive categories and subfolders automatically.
- **Two-Phase AI Pipeline** — First generates a single global folder schema from your *entire* collection, then classifies every bookmark against that fixed schema. This eliminates the redundant near-duplicate folders ("Tech News" vs. "Tech Articles") that naive batch-by-batch classification produces.
- **Adjustable Folder Granularity** — Choose how detailed the structure should be:
  - **Compact (0–5)** subfolders per category — minimal, broad folders
  - **Balanced (5–10)** — the recommended default
  - **Detailed (10+)** — fine-grained, topic-specific folders
- **Custom & Suggested Categories** — Start from 10 curated defaults (Technology & Coding, News & Research, Finance & Business, …), add your own custom categories, pick from instant suggested category badges (Health & Wellness, AI & ML, Recipes, Gaming, etc.), or use the 1-click "Clear All Categories" button.
- **Model Selection** — Pick the Gemini model that fits your needs: **3.1 Flash Lite** (ultra-fast latency & minimal cost, recommended default), **3.8 Flash** (balanced intelligence for everyday collections), or **3.1 Pro Preview** (complex taxonomies & rich nested structures).
- **Intra-Folder Content Sorting** — Choose how bookmarks are sorted inside each category folder:
  - **Alphabetical (A–Z)**
  - **Date Added (Newest First)**
  - **Date Added (Oldest First)**
  - **Website / Domain (A–Z)**
- **Flat Chronological Date Sorting (0 AI Tokens)** — Optional offline mode to compile all bookmarks strictly by timestamp without folders or AI schema design (100% offline & free).
- **Clean Titles with AI** — Optional smart title rewriting to shorten bloated URL titles and strip boilerplate tracking tags.
- **Two Input Modes**
  - **Browser mode**: Organizes your live bookmarks into a dated folder (e.g. `AI Organized Bookmarks-YYYY-MM-DD` or `Chronological Bookmarks-YYYY-MM-DD`) under *Other Bookmarks*.
  - **File mode**: Drag & drop any exported `bookmarks.html`, get back a cleaned-up, importable HTML file — works with bookmarks from any browser with memory-bounded favicon preservation.
- **Input Bookmarks Management** — Dropped or uploaded bookmark files are cached locally in extension storage. An interactive **Input Bookmarks card** displays file metadata, bookmark count, and date span, with 1-click actions to **Download** (pristine original file), **Re-organize**, or **Remove**.
- **Original Date Preservation via In-Place Moves** — Uses `chrome.bookmarks.move` rather than re-creating bookmarks, ensuring original `dateAdded` timestamps remain 100% intact across reorganization.
- **Mandatory Pre-Write Safety Snapshot** — Automatically exports a safety backup HTML file to your Downloads folder before making any changes in browser mode, guaranteeing zero risk of data loss.
- **Oldest-Survivor Deduplication** — When duplicate URL detection is enabled, the oldest bookmark entry survives to retain longevity and date provenance.
- **Comprehensive Date Range Visibility** — Oldest-to-newest date ranges are displayed across the app: in the input file card, live progress pills, last-run banner, schema drawer header, completion stats pill, and download file metadata.
- **Accurate Completion Feedback** — The completion banner explicitly names the created dated folder under *Other Bookmarks* and confirms the safety backup download.
- **Multi-Browser Support** — Runs natively on both **Google Chrome** (MV3 Side Panel) and **Mozilla Firefox** (MV3 Sidebar).
- **Persistent Background Execution** — Organization runs reliably in the background service worker even if the side panel or sidebar is closed. Reopening seamlessly reconnects to live progress and logs, and a native desktop notification alerts you when complete.
- **Failure Isolation & Resilient Retries** — Individual bookmark move failures are isolated without aborting the run and surfaced in the logs/stats pill. Bookmarks are classified in concurrent batches with automatic rate-limit backoff, sub-batch subdivision, and a live Cancel button.
- **Light / Dark / System Themes** — Clean modern UI with a slate-blue palette derived from the app icon, with a one-click theme toggle.

## ⚙️ How It Works

1. **Read** — Collects bookmarks from your browser (or an uploaded HTML file). Only titles and URLs are used.
2. **Snapshot** — In browser mode, automatically writes a safety backup HTML file to your Downloads before any bookmarks are moved.
3. **Design** — Gemini analyzes the full collection and proposes a non-redundant two-level folder schema, guided by your category and granularity preferences.
4. **Classify** — Bookmarks are classified in parallel batches against that fixed schema, so every link lands in exactly one folder.
5. **Write & Move** — In browser mode, bookmarks are moved into their dated destination folder preserving original timestamps. In file mode, an organized HTML file is prepared for instant download.

## 📥 Installation

You can install this extension manually by downloading the latest release.

**➡️ [Download the latest release (v1.2.1)](https://github.com/ne1cc/Bookmark-Organizer-Chrome-Extension/releases/latest)**

### Chrome Installation
1. **Download**: Grab the latest release zip from the [Releases page](https://github.com/ne1cc/Bookmark-Organizer-Chrome-Extension/releases/latest).
2. **Unzip**: Extract the zip file to a folder on your computer.
3. **Open Chrome Extensions**:
   - Type `chrome://extensions` in your address bar.
   - Enable **Developer mode** (top right switch).
4. **Load**:
   - Click **Load unpacked**.
   - Select the unzipped folder (or `dist` folder if building from source).
5. **Done!** The extension icon will appear in your toolbar. Click it to open the Side Panel.

> Requires Chrome 114 or newer (uses the Side Panel API).

### Firefox Installation
1. Build from source using `npm run build:firefox` or package via `npm run package:firefox`.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…** and select `dist/manifest.json`.
4. The extension will open in Firefox's Sidebar.

### Build from Source
```bash
git clone https://github.com/ne1cc/Bookmark-Organizer-Chrome-Extension.git
cd Bookmark-Organizer-Chrome-Extension/frontend
npm install

# Chrome build:
npm run build:chrome
# Load the "dist" folder in chrome://extensions

# Firefox build:
npm run build:firefox
# Load "dist/manifest.json" in about:debugging -> This Firefox -> Load Temporary Add-on

# Package for Firefox AMO:
npm run package:firefox

# Run automated tests:
npm test
```

## 🔑 Getting Started

1. Create a free API key at [Google AI Studio](https://aistudio.google.com/app/apikey) (`AIza...`) or [OpenRouter](https://openrouter.ai/keys) (`sk-or-...`). Direct minimal links are provided right below the input field in the extension.
2. Click the extension icon to open the side panel and paste your key. The extension detects its provider automatically; it is stored locally in your browser and only sent to that provider for authentication.
3. Pick a model, tune your categories and folder sorting (optional), and hit **Organize My Bookmarks** (or toggle **Sort by Date Added** for 0-token offline sorting).

## 📋 Changelog

### v1.2.1 (Latest Release) — Date Preservation, Move Architecture & Firefox Support

#### 🌟 New Features & Enhancements
- **In-Place Move Architecture & Date Preservation**: Replaced node re-creation with `chrome.bookmarks.move`, guaranteeing that original `dateAdded` timestamps survive reorganization 100% intact.
- **Mandatory Pre-Write Safety Snapshot**: In browser mode, an automatic pre-write HTML backup is downloaded to your Downloads folder before any bookmark moves begin.
- **Input Bookmarks Card**: Dropped or uploaded bookmark files are cached in local storage with an interactive card showing file metadata, count, and date span, plus 1-click actions to **Download** (pristine original file), **Re-organize**, or **Remove**.
- **Firefox MV3 Multi-Browser Support**: Added native Firefox support with sidebar integration (`sidebar_action`), multi-target Vite builds (`build:chrome` and `build:firefox`), and automated packaging (`package:firefox`).
- **Oldest-Survivor Deduplication**: When duplicate removal is enabled, the oldest bookmark entry survives to preserve original date provenance.
- **Comprehensive Date Range Reporting**: Oldest-to-newest date ranges are displayed across all surfaces (Input Bookmarks card, live progress pills, last-run banner, schema drawer header, completion stats pill, and download tooltip).
- **Accurate Completion Messaging**: The completion screen explicitly names the created dated folder under *Other Bookmarks* (`AI Organized Bookmarks-YYYY-MM-DD` or `Chronological Bookmarks-YYYY-MM-DD`) and notes the safety backup file download.
- **Refined Intra-Folder Sorting**: Streamlined intra-folder sorting to 4 core modes: Alphabetical (A–Z), Date Added (Newest First), Date Added (Oldest First), and Website / Domain (A–Z).

#### 🛡️ Reliability & Performance
- **Per-Item Failure Isolation**: Bookmark move errors are isolated per-node without crashing the batch run, and failed moves are surfaced in the logs and last-run banner.
- **Storage-Backed Snapshot Provider**: Background service worker organization reliably generates safety snapshots across process restarts.
- **Synchronous Storage Bootstrap**: Instant side panel boot (<200ms) with `localStorage` fast-path and memory-backed session cache.

---

### v1.2.0 — Major Feature & Reliability Release

#### 🌟 New Features & Enhancements
- **Intra-Folder Content Sorting**: Added folder sorting schemas (`Alphabetical A–Z`, `Date Added Newest First`, `Date Added Oldest First`, and `By Website / Domain A–Z`).
- **Sort by Date Added (Flat List)**: Added an independent chronological ordering mode that bypasses folder generation and uses **0 AI tokens** (100% offline & free), styled with a refined slate neutral border. Toggled off by default on every extension open.
- **Clean Titles with AI**: Added an optional setting to intelligently clean and shorten truncated or messy web titles.
- **Gemini Model Lineup Update**: Upgraded default model to `Gemini 3.1 Flash Lite` for near-instant latency and lowest token consumption, alongside `Gemini 3.8 Flash` and `Gemini 3.1 Pro Preview`.
- **Quick API Key Links**: Added minimal direct links below the API key input to jump straight to Google AI Studio and OpenRouter key generation pages in a new tab.
- **Suggested Categories & Clear All**: Added a curated suggested category pool (Health & Wellness, AI & ML, Recipes, Gaming, etc.) with quick-add buttons and a 1-click "Clear All Categories" button.
- **Instant Schema Copy**: Added a button to copy the generated category distribution breakdown directly to the clipboard.

#### 🛡️ Reliability & Performance Fixes
- **Sub-Second Instant Startup (<200ms)**: Added synchronous in-process memory bootstrap (`localStorage` fast-path), deferred LevelDB disk cleanup, and an inline CSS pre-render skeleton in `index.html`, eliminating cold-start disk contention and cutting side panel launch latency from >10s to under 200ms.
- **Side Panel Startup Fix**: Fixed toolbar click conflicts by properly managing `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` without duplicate action listeners.
- **Storage Optimization & Instant Boot**: Moved ephemeral bookmark tree caching from disk LevelDB to memory-based session storage (`chrome.storage.session`), keeping persistent storage tiny (<5 KB) and eliminating cold-start delays.
- **Adaptive Sub-Batch Subdivision**: Automatically splits batches if payload limits or context boundaries are exceeded, preventing `413 Payload Too Large` errors on massive collections.
- **Resilient Retry Backoff**: Enhanced exponential backoff with server-directed cooldowns and rate-limit handling.
- **Safe CSP Compliance**: Disabled external link prefetch probing that previously triggered strict Manifest V3 Content Security Policy warnings.

---

### v1.1.4
- Added duplicate URL detection and removal toggle.
- Added support for large HTML bookmark imports with memory-bounded favicon handling.
- Improved live progress logging terminal.

## 🔒 Privacy

We do not collect data. Your API key is stored locally in your browser. Bookmark titles and URLs are sent directly to Google AI Studio or OpenRouter for categorization and immediately discarded — there is no middleman server.
[Read our Privacy Policy](docs/privacy.html)

## 🛠️ Tech Stack

- **Frontend**: React 19 + Vite, rendered in Chrome's Side Panel and Firefox's Sidebar
- **AI**: Google Gemini models via Google AI Studio or the OpenRouter API
- **Extension**: Manifest V3 (`storage`, `unlimitedStorage`, `bookmarks`, `downloads`, `sidePanel` / `sidebarAction`, `notifications`)

## License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](LICENSE) file for the full text.

Copyright (C) 2026 Amado Evert
