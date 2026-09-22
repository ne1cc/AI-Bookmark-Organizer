# How to Test the Extension (Chrome and Firefox)

## Automated Unit & Integration Tests
Run the test suite to verify that organization works, never stalls on network issues or rate limits, bounds retries cleanly, and progresses to completion:
```bash
cd frontend
npm test
```

To run ESLint:
```bash
npm run lint
```

## Prerequisites for Manual Extension Testing
1. **Build the Project**:
   - Ensure you have Node.js (v18+) and npm installed.
   - Run the build command in the `frontend` directory:
     ```bash
     cd frontend
     npm install

     # Build for both Chrome and Firefox:
     npm run build:all

     # Or build individually:
     npm run build:chrome    # Outputs to dist/chrome
     npm run build:firefox   # Outputs to dist/firefox
     ```

## Loading the Extension in Browsers

### Google Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** in the top-right corner.
3. Click the **Load unpacked** button (top-left).
4. Select the `frontend/dist/chrome` folder in the project directory.
   - **Note**: Do not select `dist` root or `src`; select `dist/chrome`.
5. Click the extension icon in your toolbar to open the Chrome Side Panel.

### Mozilla Firefox
1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `frontend/dist/firefox/manifest.json`.
4. Open the extension in the Firefox Sidebar.

## Verification Steps

### 1. Functional Testing
- **Side Panel & Header Controls**:
  - Open the side panel or sidebar. Verify that the UI displays *Powered by Google Gemini*.
  - **Zoom Controls**: Click `+` and `-` in the header to scale the UI (90%–130%), and click the reset button to restore 100%.
  - **Theme Toggle**: Switch between Light, Dark, and System themes. Verify high-contrast text readability and that Subfolder Hierarchy diagrams switch to dark artwork in dark mode.
- **API Key Configuration**: Enter your Google AI Studio key (`AIza...`) or OpenRouter key (`sk-or-...`). Verify that it is saved locally (it stays populated when you close and reopen the side panel). Direct links are provided below the input field.
- **Model & Sorting Selection**:
  - Select from the 3 Gemini tiers (**3.1 Flash Lite**, **3.8 Flash**, or **3.1 Pro Preview**).
  - Choose an intra-folder sorting option (Alphabetical A–Z, Date Added Newest/Oldest First, Website / Domain A–Z, Reverse Alphabetical).
- **Subfolder Hierarchy Settings**:
  - Cycle through **Compact**, **Balanced**, and **Detailed** subfolder depth options. Verify that the illustrative diagram updates to match the selection and theme.
- **Adaptive Detail Folders**:
  - Test both AI-inferred categories and manually selected categories in Browser Mode and File Mode. For a non-General category/subcategory with at least six bookmarks that naturally separates into two or more topics, verify that each retained third-level detail folder contains at least two bookmarks.
  - For a group with fewer than six bookmarks, a sparse split, or an unavailable detail-inference response, verify that the bookmarks remain directly under their category/subcategory (the two-level fallback) and no empty or one-bookmark detail folder is created.
- **Organization Modes**:
  - **Browser Mode**: Without uploading a file, click **Organize My Bookmarks**. Verify that it scans your browser bookmarks, shows real-time batch progression in the terminal, and creates an `AI Organized Bookmarks-[Date]` folder under *Other Bookmarks*.
  - **File Mode**: Drag and drop a bookmarks HTML file (or browse to select one), and click **Organize File & Download**. Verify that an organized bookmarks file download is initiated with all links preserved.
  - **Cached Input Card**: After uploading, verify the card displays Download, Re-organize, and Remove actions.
  - **Flat Chronological Date Sort (0 AI Tokens)**: Click the "Sort without AI - Flat list" header or direction readout. Verify that the API key requirement is removed, direction flips when clicked, and bookmarks are organized into chronological year/month subfolders without AI tokens.
  - **Duplicate Removal (Free)**: With no file uploaded, click **Delete duplicates**. Confirm the deletion prompt and verify that duplicate URLs are removed while retaining the oldest saved copy.
- **Network Resilience & Progress**:
  - If rate limits (429) occur, a warning banner informs you of the cooldown pause before retrying.
  - If network drops occur, batches retry cleanly without infinite loops, and preserved bookmarks are filed under `Other → General` so 0 bookmarks are lost.
  - Real-time progress percentages and log updates actively move from 0% to 100% until "Organization complete!".
- **Interactive Cancellation & Exit Safety**:
  - During an active run, click the **Cancel** button. Verify that operations halt within 200ms and the UI returns to the idle state.
  - Attempting to close or navigate away during an active run triggers a safety confirmation prompt.

### 2. Developer Console & Security Checks
- **Console Errors**:
  - Right-click inside the extension side panel and choose **Inspect** to open DevTools.
  - Navigate to the **Console** tab.
  - Run the organization process and verify that there are no JavaScript or Content Security Policy (CSP) errors.
  - Try to execute `eval('alert(1)')` in the console. It **should fail** under Manifest V3 default CSP.
