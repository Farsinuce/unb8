# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Unbait2 is a Chrome extension (Manifest V3) that detects clickbait headlines on Danish news sites (dr.dk, ekstrabladet.dk, bt.dk), fetches the article in the background, asks an LLM via OpenRouter to write a factual Danish headline, and swaps it into the page. Users bring their own OpenRouter API key.

## Repository layout

- `unbait2/` — the actual extension. All development happens here.
- `unbait-original/` — unpacked copy of the original "unbait" Firefox extension (v1.1.0), kept as reference only. Do not edit.
- `dr_article.html` — saved sample article page from dr.dk, useful as a fixture when working on the HTML parser in `offscreen.js`.
- `PROJECT_STATUS.md` — detailed status/handover doc with per-site selector configs and next steps.

## Development workflow

There is no build system, package.json, linter, or test suite — the extension is plain JavaScript loaded directly.

- Install: `chrome://extensions/` → enable Developer mode → "Load unpacked" → select the `unbait2/` folder.
- After editing `background.js` or `offscreen.js`: click the reload icon on the extension card in `chrome://extensions/`.
- After editing `content.js`: reload the extension **and** reload the news-site tab.
- Debug the service worker via the "service worker" link on the extension card; content-script logs (prefixed `Unbait2:`) appear in the page's DevTools console.
- First install auto-opens `onboarding.html`; settings live in the popup (`popup.html`).

## Architecture

The core flow spans four contexts connected by `chrome.runtime` messages:

1. **`content.js`** (injected into news sites) scans for article teasers using per-site CSS selectors, watches for new ones with a MutationObserver (infinite scroll), and sends `{action: 'generateTitle', url}` to the background.
2. **`background.js`** (service worker) checks the cache (`chrome.storage.local`, key `unbait_cache_<url>`), fetches the article HTML, delegates parsing to the offscreen document, calls OpenRouter (`/api/v1/chat/completions`), and caches the result.
3. **`offscreen.js`** exists because service workers have no DOMParser. It receives `{type: 'parse-html', target: 'offscreen'}`, strips boilerplate tags, tries article-body selectors (`.article-bodytext`, `.hydra-article-body`, etc.), falls back to parsing the `__NEXT_DATA__` JSON block (needed for dr.dk live blogs), and returns text truncated to 5000 chars plus a `debug` object identifying which selector matched.
4. Back in **`content.js`**, `applyNewTitle` stores the original title/styles in `data-*` attributes on the article container, replaces the text, runs `fitTextToContainer` (binary-search font sizing against the container's dimensions so the layout doesn't break), and adds the 💡 toggle button that switches between AI and original headline, restoring the exact original computed styles.

### Adding a new site

Requires coordinated changes in three files:
- `content.js`: add an entry to `SITE_CONFIG` (`articleSelector`, `linkSelector`, `titleSelector`, `excludeSelector`) and a hostname check in `getSiteConfig()`.
- `manifest.json`: add the domain to both `host_permissions` and `content_scripts.matches`.
- `offscreen.js`: if the site's article body isn't matched by the existing `specificSelectors` list, add its selector (extraction fails when fewer than 100 chars are found).

### API details

- Settings stored in `chrome.storage.local`: `openRouterApiKey`, `selectedModel` (default `google/gemini-2.5-flash`).
- `max_tokens: 100` is intentional — it prevents "insufficient credits" errors on free/low-tier OpenRouter accounts.
- The prompt requires a single Danish headline under ~100 chars with no sensationalist words; output is used verbatim (surrounding quotes stripped), so keep the "ONLY output the headline" constraint intact.
