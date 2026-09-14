# AI Bookmark Organizer (Chrome and Firefox Extension)

Turn messy, unsorted bookmarks into a clean, organized folder structure in one click using AI (via Google AI Studio or OpenRouter). Runs locally in your browser side panel (Chrome) or sidebar (Firefox) with no account needed, no tracking, and no external servers.

## Features

- One-Click Organizing: Automatically sorts hundreds or thousands of messy bookmarks into clear, logical folders.
- No Duplicate Folders: Plans the full folder layout first before sorting, so you never get redundant folders like "Tech Articles" and "Tech News".
- Choose Folder Detail: Pick how many subfolders you want:
  - Compact (1 to 3 subfolders per category) for simple, broad organization (recommended).
  - Balanced (3 to 6 subfolders) for everyday collections.
  - Detailed (6 to 10 subfolders) for large, topic-rich collections.
- Custom Categories: Start with 10 standard categories, add your own, pick from quick suggestions, or clear them all with one click.
- Model Options: Choose the Gemini model that fits your needs:
  - Gemini 3.1 Flash Lite: Fast, low cost, and great for most collections (default).
  - Gemini 3.8 Flash: Balanced speed and categorization quality.
  - Gemini 3.1 Pro Preview: Best for very large or complex bookmark collections.
- Sort Inside Folders: Order links inside each folder alphabetically, by date added (newest or oldest first), or by website name.
- Sort by Date (Free, Offline): A fast offline mode that sorts all bookmarks into a simple date timeline without using any AI tokens.
- Clean Up Titles: Optionally shortens long, cluttered webpage titles and strips tracking text.
- Keeps Original Dates: Moves bookmarks directly so your original "date added" timestamps are never lost or overwritten.
- Automatic Safety Backup: Automatically saves an HTML backup of your bookmarks to your Downloads folder before making changes.
- Delete Duplicate URLs (Free): In browser mode, scans the existing bookmark tree and, after confirmation, deletes newer copies of exact duplicate URLs while keeping the oldest copy. No API key or uploaded file is required.
- View Bookmark Date Ranges: Shows the full date range of your collection (e.g. 2021 to 2026) in the status banner and completion screens.
- Two Ways to Organize:
  - Browser Mode: Organizes your active browser bookmarks into a new dated folder (e.g. "AI Organized Bookmarks-YYYY-MM-DD") under Other Bookmarks.
  - File Mode: Drag and drop an exported bookmarks HTML file from any browser and download an organized file back.
- Saved Input File Card: Uploaded files stay available in the extension so you can re-organize, redownload the untouched original, or remove the file anytime.
- Works in Chrome and Firefox: Runs in the Chrome Side Panel or the Firefox Sidebar.
- Background Processing: Continues working even if you close the side panel or sidebar, and sends a desktop notification when done.
- Light, Dark, and System Themes: Clean design that matches your system or preference.

## How It Works

1. Read: The extension reads your bookmarks (or an uploaded HTML bookmark file).
2. Backup: In browser mode, it saves a backup HTML file to your Downloads folder first.
3. Design: The AI reviews your collection and creates a clean folder layout.
4. Sort: Links are placed into their best matching folders.
5. Finish: In browser mode, bookmarks are placed into a new dated folder in your browser. In file mode, your organized bookmark file is ready to download.

To only clean duplicate URLs, leave the file upload area empty and use **Delete duplicates**. The cleanup is local to the browser and does not use AI tokens.

## Installation

### Chrome

1. Download the latest release zip (bookmark-organizer-chrome-v*.zip) from the Releases page.
2. Unzip the file on your computer.
3. Open Chrome and go to `chrome://extensions`.
4. Turn on Developer mode (toggle in the top-right corner).
5. Click Load unpacked and select the unzipped folder.
6. Click the extension icon in your toolbar to open the Side Panel.

Requires Chrome 114 or newer.

### Firefox

1. Download the latest release zip (bookmark-organizer-firefox-v*.zip) from the Releases page.
2. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
3. Click Load Temporary Add-on and select `manifest.json` from the unzipped folder.
4. The extension opens directly in the Firefox Sidebar.

### Build from Source

```bash
git clone https://github.com/ne1cc/Bookmark-Organizer-Chrome-Extension.git
cd Bookmark-Organizer-Chrome-Extension/frontend
npm install

# Build both browsers:
npm run build:all

# Or build individually:
npm run build:chrome    # Outputs to dist/chrome
npm run build:firefox   # Outputs to dist/firefox

# Package release zip files:
npm run package:all     # Generates Chrome and Firefox zips in dist/
npm run package:chrome  # Generates dist/bookmark-organizer-chrome-v*.zip
npm run package:firefox # Generates dist/bookmark-organizer-firefox-v*.zip

# Run tests:
npm test
```

## Getting Started

1. Get a free API key from Google AI Studio or OpenRouter (quick links are provided directly inside the extension).
2. Click the extension icon to open the side panel or sidebar and paste your key. Your key is stored securely on your computer and is only sent to your chosen provider.
3. Choose your preferred categories and sorting options, then click Organize My Bookmarks.

## Privacy

Your data stays private:
- No user accounts and no analytics.
- Your API key is stored locally in your browser.
- Bookmark titles and URLs are sent directly to Google AI Studio or OpenRouter for organization and are never stored on any middleman server.
- Review the full Privacy Policy in the `docs/privacy.html` file.

## Tech Stack

- Frontend: React 19 and Vite
- Extension: Manifest V3 (Chrome Side Panel and Firefox Sidebar)
- AI: Google Gemini models via Google AI Studio or OpenRouter API

## Changelog

### v1.3.0

- Clickable Sort Mode: Directly click the "Sort by date added - Flat list" title to toggle flat chronological sorting.
- MECE Month & Year Organization: Chronological bookmark sorting groups items into mutually exclusive and collectively exhaustive month-year subfolders without consuming AI tokens.
- Standardized Root Folder & Export Names: Consistent naming conventions across browser bookmark roots and exported Netscape HTML bookmark files.
- Resilient Background Organization: Enhanced background worker persistence, instantaneous cancellation response, and automatic recovery.
- Native Duplicate Bookmark Removal: Free one-click cleanup tool for removing duplicate bookmarks directly from browser bookmark folders.
- Cached Input Bookmark Files: Drop in and retain bookmark files with one-click re-organization, pristine download, or removal.

### v1.2.1

- Keeps Original Bookmark Dates: Reorganized bookmarks keep their original saved dates intact.
- Automatic Pre-Write Backup: Downloads an HTML backup to your Downloads folder before browser bookmarks are moved.
- File Card Management: Uploaded bookmark files are saved in the extension with one-click buttons to download the original, re-organize, or delete.
- Full Firefox Support: Native support for Firefox Sidebar with automated build and packaging scripts.
- Keep Oldest Copy on Deduplication: When duplicate removal is enabled, the oldest saved link is preserved.
- Free Browser Cleanup: Delete duplicate URLs directly from the existing browser bookmark tree without an API key or uploaded file.
- Date Range Visibility: Clear date spans are displayed across all screens so you can see the age range of your bookmarks.
- Clear Completion Details: Shows the exact folder name created in your browser and notes the backup download.

### v1.2.0

- Folder Content Sorting: Added sorting options for links inside folders (alphabetical, newest first, oldest first, and by domain).
- Free Offline Date Sort: Added a 100% free mode that organizes bookmarks into a date timeline without using AI tokens.
- Title Cleanup: Added an option to clean and shorten cluttered webpage titles.
- Updated Models: Added Gemini 3.1 Flash Lite as the default fast, low-cost model, along with Gemini 3.8 Flash and Gemini 3.1 Pro Preview.
- Fast Launch: Reduced side panel launch time to under 200ms.
- Category Helpers: Added suggested categories and a clear-all button.

### v1.1.4

- Duplicate URL removal.
- Better handling for large bookmark files and icons.
- Live progress log.

## License

This project is licensed under the GNU General Public License v3.0. See the LICENSE file for details.

Copyright (C) 2026 Amado Evert
