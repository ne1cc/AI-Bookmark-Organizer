# AI Bookmark Organizer

AI Bookmark Organizer sorts browser bookmarks into a folder structure you can browse and maintain. It works in the Chrome side panel and Firefox sidebar, and can also organize an exported bookmarks HTML file.

## What it does

- Organizes bookmarks with Google Gemini through Google AI Studio or OpenRouter.
- Uses your selected categories as top-level folders, then creates subfolders from the bookmarks. You can also let the organizer suggest categories.
- Adjusts folder detail to your collection, with an optional third level for larger groups.
- Optionally pauses to let you review and edit the proposed folders before anything is filed, and the finished folders (with bookmark counts) before they are saved. The plan review lets you rename, add, delete, move and merge folders; the result review lets you rename, delete, move and merge them.
- Sorts links by title, date added, or website. A date-based organization mode works without AI.
- Removes duplicate URLs from browser bookmarks while keeping the oldest saved copy.
- Saves an HTML backup before changing browser bookmarks and preserves their original dates.
- Supports light, dark, and system themes, adjustable zoom, and custom categories.

## Install

### Chrome

1. Download the latest Chrome release ZIP from the [GitHub Releases](https://github.com/ne1cc/AI-Bookmark-Organizer/releases) page and extract it.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the extracted folder.
4. Open the extension from the toolbar.

Requires Chrome 114 or newer.

### Firefox

1. Download the latest Firefox release ZIP from the [GitHub Releases](https://github.com/ne1cc/AI-Bookmark-Organizer/releases) page and extract it.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on** and choose `manifest.json` inside the extracted folder.
4. Open the extension from the browser toolbar to use its sidebar.

Requires Firefox 115 or newer. Temporary add-ons are removed when Firefox restarts; install a signed release to keep it available.

## Get started

1. Open the extension and add an API key from Google AI Studio or OpenRouter. Links to both providers are available in the extension.
2. Choose your categories and sorting options, or use the date-based mode to organize without AI.
3. Choose whether to organize browser bookmarks or upload an exported bookmarks HTML file, then start organizing.

Browser mode creates a new dated folder under **Other Bookmarks**. File mode lets you download the organized HTML file. To remove duplicate URLs from browser bookmarks, use **Delete duplicates**; this does not require an API key.

## Privacy

The extension has no user accounts or analytics. Your API key is stored in browser storage on your device. When you organize with AI, bookmark titles and URLs are sent directly to your selected provider for processing. The project does not route them through its own server. Browser mode also downloads a local HTML backup before making changes.

See [`docs/privacy.html`](docs/privacy.html) for the full privacy policy.

## Build from source

Requirements: Node.js and npm.

```bash
git clone https://github.com/ne1cc/AI-Bookmark-Organizer.git
cd AI-Bookmark-Organizer/frontend
npm install
```

Build both browser versions:

```bash
npm run build:all
```

Build one browser version with `npm run build:chrome` or `npm run build:firefox`. Outputs are written to `dist/chrome` and `dist/firefox`.

Create release ZIP files with `npm run package:all`, or use `npm run package:chrome` and `npm run package:firefox` individually. Run the test suite with `npm test` and lint with `npm run lint`.

## Technology

The extension uses React 19, Vite, and Manifest V3. AI requests use Google Gemini through Google AI Studio or OpenRouter.

## License

Licensed under the GNU General Public License v3.0. See [`LICENSE`](LICENSE).
