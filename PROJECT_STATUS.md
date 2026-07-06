# Unbait2 Project Status

## Project Overview
Unbait2 is a Chrome browser extension designed to combat clickbait headlines on Danish news websites. It automatically detects clickbait headlines, fetches the article content in the background, uses an LLM (via OpenRouter) to generate a factual, descriptive headline, and replaces the original headline on the page.

## Features Implemented
*   **Multi-Site Support:** Currently supports `ekstrabladet.dk`, `bt.dk`, and `dr.dk`.
*   **AI-Powered De-Clickbaiting:**
    *   Fetches article HTML in the background.
    *   Parses HTML safely using an Offscreen Document to extract article text.
    *   **Enhanced Parsing:** Supports extracting text from standard DOM elements and `__NEXT_DATA__` JSON blocks (crucial for DR.dk live blogs).
    *   Sends text to OpenRouter API (defaulting to `google/gemini-2.5-flash`) to generate a non-clickbait title.
*   **Smart Caching:** Generated titles are cached in `chrome.storage.local` to minimize API usage and improve performance.
*   **Visual Toggle:** A lightbulb icon (💡) is added to modified headlines, allowing users to toggle between the original and the AI-generated headline.
*   **Text Fitting:** A dynamic text-fitting algorithm adjusts the font size of the new headline to fit within the original container dimensions, preserving the layout.
*   **Style Preservation:** When toggling back to the original headline, the extension restores the exact original styling (font size, line height, etc.).
*   **Settings UI:** A popup interface allows users to input their OpenRouter API Key and select their preferred LLM model.

## Technical Architecture
*   **Manifest V3:** Built using the latest Chrome Extension manifest version.
*   **Service Worker (`background.js`):** Orchestrates the process. It handles message passing, checks the cache, fetches article HTML, coordinates parsing with the offscreen document, calls the OpenRouter API, and manages caching.
*   **Content Script (`content.js`):** Injected into supported news sites. It identifies article links and headlines based on site-specific selectors, sends URLs to the background script for processing, and updates the DOM with the new titles and toggle buttons. It also handles the text fitting logic.
*   **Offscreen Document (`offscreen.html` / `offscreen.js`):** Used for safe HTML parsing. Since Service Workers don't have access to the DOM parser, this document provides a secure context to convert raw HTML strings into text content. It now includes logic to parse `__NEXT_DATA__` for React/Next.js sites like DR.dk.
*   **Popup (`popup.html` / `popup.js`):** Provides the user interface for configuration.

## Current Status & Next Steps
We have successfully implemented the core functionality for `ekstrabladet.dk`, `bt.dk`, and `dr.dk`.

**Completed Tasks:**
1.  **Added `dr.dk` Support:**
    *   Updated `content.js` with the correct CSS selectors for `dr.dk` (`.dre-teaser`, `.hydra-card`, etc.).
    *   Updated `offscreen.js` to handle `dr.dk`'s article structure, including `.hydra-article-body` and `__NEXT_DATA__` fallback for live blogs.
    *   Verified `manifest.json` includes `https://*.dr.dk/*`.

**Immediate Tasks:**
1.  **Final Testing:** Verify functionality across all three sites, ensuring the text fitting works visually and the toggle button behaves as expected.

## Technical Details for Handover
### Site Configuration (`content.js`)
To add a new site, update the `SITE_CONFIG` object in `content.js`. You need:
*   `articleSelector`: The container element for a single article teaser.
*   `linkSelector`: The `<a>` tag within the article container pointing to the full article.
*   `titleSelector`: The element containing the headline text.
*   `excludeSelector`: A selector to prevent double-processing (usually `[data-unbait-processed="true"]`).

**Current `dr.dk` Config:**
```javascript
'dr.dk': {
  articleSelector: '.dre-teaser, .hydra-latest-news-item, .hydra-card',
  linkSelector: 'a',
  titleSelector: '.dre-title-text, .hydra-card-title__text',
  excludeSelector: '[data-unbait-processed="true"]'
}
```

### Text Fitting Logic
The `fitTextToContainer` function in `content.js` uses a binary search to find the optimal font size. It relies on `scrollHeight` and `clientWidth` to detect overflow. It attempts to use the parent container's dimensions if the immediate container is too small (which can happen during initial render).

### API Integration
The `background.js` script calls `https://openrouter.ai/api/v1/chat/completions`. It requires an API key stored in `chrome.storage.local`. The `max_tokens` parameter is set to 100 to prevent "insufficient credits" errors on free/low-tier accounts.

### Development Setup
1.  Clone/Download the `unbait2` directory.
2.  Open Chrome and navigate to `chrome://extensions/`.
3.  Enable "Developer mode".
4.  Click "Load unpacked" and select the `unbait2` folder.