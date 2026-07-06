# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

unb8 (formerly "Unbait2") is a Chrome extension (Manifest V3) that detects clickbait headlines on Danish news sites (dr.dk, ekstrabladet.dk, bt.dk), fetches the article in the background, asks an LLM via OpenRouter to write a factual Danish headline, and swaps it into the page. It can optionally rewrite entire article pages — and dr.dk's inline "Kort nyt" short-news items — condensing text and removing filler (off by default). Users bring their own OpenRouter API key; by default only free models are used, with an automatic fallback chain. The 🎣 fishhook is the brand mark (extension icon + per-headline toggle button).

## Repository layout

- `unb8/` — the actual extension. All development happens here.
- `unbait-original/` — unpacked copy of the original "unbait" Firefox extension (v1.1.0), kept as reference only. Do not edit.
- `dr_article.html` — saved sample article page from dr.dk (a live blog), useful as a fixture when working on the HTML parser in `offscreen.js`.
- `PROJECT_STATUS.md` — detailed status/handover doc with per-site selector configs, verified selector counts and next steps.

## Development workflow

There is no build system, package.json, linter, or test suite — the extension is plain JavaScript loaded directly.

- Install: `chrome://extensions/` → enable Developer mode → "Load unpacked" → select the `unb8/` folder.
- After editing `background.js` or `offscreen.js`: click the reload icon on the extension card in `chrome://extensions/`.
- After editing `content.js`: reload the extension **and** reload the news-site tab.
- Debug the service worker via the "service worker" link on the extension card; content-script logs (prefixed `unb8:`) appear in the page's DevTools console.
- First install auto-opens `onboarding.html`; settings live in the popup (`popup.html`).
- When analyzing news-site HTML, download pages to a temp file and use grep — a single dr.dk front page is ~2 MB; never read one wholesale.

## Architecture

The core flow spans four contexts connected by `chrome.runtime` messages:

1. **`content.js`** (injected into news sites) scans for article teasers using per-site CSS selectors, filters links through the site's `isArticleUrl()` predicate (skipping section links, DRTV, video stories, house content), watches for new ones with a debounced MutationObserver (infinite scroll/hydration), and sends `{action: 'generateTitle', url}` to the background. `processInlineArticles()` additionally handles dr.dk "Kort nyt" items (`article.hydra-latest-news-page-short-news-article`) that render inline with no link — their body text is read from the DOM and sent directly (no fetch) with a synthetic `shortnews://` cache key; the headline is always de-clickbaited, and when `rewriteArticles` is on the inline body is condensed in place too (per-item state in the `inlineState` Map, reusing `replaceArticleBody`). On dr.dk article pages it also handles the page's own `<h1>`: always de-clickbaits the headline (sending the already-rendered text along so the background skips re-fetching), and — when the `rewriteArticles` setting is on — sends `{action: 'rewriteArticle', url, title, text}` and swaps in the condensed paragraphs in place (media/fact boxes kept). It listens to `chrome.storage.onChanged` so the popup toggles apply live: disabling restores every original headline.
2. **`background.js`** (service worker) checks the cache (`unbait_cache_v2_<url>` / `unbait_rewrite_v1_<url>`, 7-day TTL, pruned on startup), de-duplicates concurrent requests per URL, fetches the article HTML (20 s timeout), delegates parsing to the offscreen document, calls OpenRouter with a free-model fallback chain, and caches the result.
3. **`offscreen.js`** exists because service workers have no DOMParser. It receives `{type: 'parse-html', target: 'offscreen'}`, strips boilerplate tags, tries article-body selectors (`.hydra-article-body`, `.article-bodytext`, etc.), falls back to parsing the `__NEXT_DATA__` JSON block (needed for dr.dk live blogs), and returns text truncated to 5000 chars plus a `debug` object identifying which selector matched.
4. Back in **`content.js`**, `applyNewTitle` stores the original title/styles in `data-*` attributes on the teaser container, replaces the text, sizes it with one of two per-site strategies (`config.titleFit`), and adds the 🎣 toggle button that switches between AI and original, restoring the exact original inline style attribute. The two fit strategies: **`'cap'`** (dr.dk, the default) runs `fitTextToContainer` — binary-search font sizing **capped at the original computed size** so the AI headline shrinks-to-fit but never grows larger than the site's own text. **`'fill'`** (eb.dk, bt.dk) runs `setFillTitle` — those sites size each headline *line* to fill the teaser width (per-line `font-size` multipliers), so the element's own computed font-size is a tiny base and capping at it renders the replacement far too small. Instead `applyNewTitle` captures the rendered headline box (`getBoundingClientRect()` height/width), the element's `innerHTML`, and the visible text's typography (`captureVisibleTypography` — the first visible leaf's font-family/weight/style/color/transform/letter-spacing, skipping bt's `aria-hidden` duplicate span and `<s>` strikethroughs) **before** overwriting it. Then `setFillTitle` replaces the multi-line markup with one wrapping block (`box-sizing:border-box`, `word-break:break-word`, `overflow:hidden`), re-applies the captured typography (so the AI headline keeps the site's font and colour, not just size), and binary-searches the largest font (9–96 px) whose wrapped text fits that captured box in **both** dimensions. Toggle-back restores the saved `innerHTML` so the site's original auto-fit markup returns intact. `ownQuery` (used to locate each teaser's link + title) is nesting-safe: bt.dk nests teasers, and it returns only the descendant whose nearest `articleSelector` ancestor is *this* container, so an outer headline is never mis-paired with a nested teaser's link. `revertAllTeasers` iterates `[data-unbait-processed]` but skips the article-page `<h1>` (owned by `revertArticlePage`) and inline short-news items (owned by `revertInlineArticles`), clearing the processed flag on in-flight items so a re-enable can re-scan them.

### Settings (chrome.storage.local)

`openRouterApiKey`; `selectedModel` (default `'auto'` = free chain); `extensionEnabled` (default true — absent key means enabled); `rewriteArticles` (default false). Popup toggles write these immediately; content.js reacts via `storage.onChanged`.

### Model fallback chain

`FREE_MODEL_CHAIN` in `background.js`: gemma-4-31b → gemma-4-26b-a4b → nemotron-3-ultra → gpt-oss-120b → gpt-oss-20b (all `:free`). A specifically selected model is tried first, then the chain. Fall back on 429/402/404/5xx, OpenRouter 200-with-`error`-body, timeout, empty completion, or truncated completion (`finish_reason: "length"`); abort on 401. `max_tokens` is generous for `:free` models (they cost nothing) but intentionally low for paid models — it prevents "insufficient credits" errors on low-tier OpenRouter accounts; paid models are sent `reasoning: {enabled: false}` so thinking doesn't consume the cap. The one paid picker option is `~google/gemini-flash-latest` (OpenRouter's `~` prefix auto-selects the newest Gemini Flash); it routes through the paid path. Model IDs were verified against `GET /api/v1/models` in July 2026.

### dr.dk selectors

Verified against live HTML July 2026 — four teaser systems (`.hydra-card`, `.hydra-latest-news-item--article`, `.hydra-latest-news-teaser`, `.hydra-latest-news-page-short-news-card`); links must use `a.hydra-card-title, a.hydra-teaser-title` (never bare `a` — cards contain duplicate anchors). Article pages: `h1.hydra-article-title__heading`, body `.hydra-article-body`, paragraphs `p.hydra-article-body-paragraph` wrapped in `div.dre-speech`. See PROJECT_STATUS.md for the full config and verified counts.

### ekstrabladet.dk & bt.dk selectors

Both re-verified against live HTML July 2026 and both use the `'fill'` title-fit strategy (their teasers size each headline line to the teaser width).

- **eb.dk** — teaser container `.dre-item__text`; the link *and* title are the same element, `a.dre-item__title`, which wraps three responsive variants (`.dre-item__alt-title--lg/--md/--sm`), each splitting the headline into per-line `<p style="font-size:Xem|Xvw">`. `isArticleUrl` accepts a last path segment that is all digits **or** the legacy `article<digits>.ece`, **or** any `/eblive/…` path (LIVE blogs — the user wants those de-clickbaited too), rejecting `/podcast` and off-site `bold.dk` links. Article pages: `h1.font-article-title`, lead `h2.font-article-subheader`, body `.article-bodytext` with direct-child `:scope > p` paragraphs.
- **bt.dk** — a Next.js site whose CSS-module class hashes change every build, so selectors key on **stable attributes**: teaser container `[data-item-id]` (any id — LIVE teasers use a short content id like `8kj0kqyv`, not `urn:bm:article:…`; non-teaser nodes are skipped by the link/title guard), an empty absolutely-positioned overlay link `a[class*="TeaserLink_link"]`, and headline `[data-article-headline="true"]`. bt **nests** teasers, so `processArticles` uses `ownQuery` to avoid pairing an outer headline with a nested teaser's link. The visible headline is split into `TeaserHeadline_fluidLine` spans plus an `aria-hidden` duplicate (so its `innerText` is doubled and may carry `<s>` strike-through) — the clean original title is therefore read from the overlay link's **`aria-label`** (`config.titleFromLinkAttr`). `isArticleUrl` accepts ≥2 path segments with a hyphen in the slug (this also lets LIVE `…/live-foelg-…` blogs through), rejecting `/video/reels/…`, section landings, and partner-site links. Article pages: `h1[itemprop="headline"]`, lead `[itemprop="description"]`, body `[itemprop="articleBody"]` with `p[class*="ArticleBody_paragraphNode"]` paragraphs.

Both sites' article bodies are already covered by `offscreen.js` (`.article-bodytext` / `[itemprop="articleBody"]`), so no offscreen change was needed.

### Adding a new site

Requires coordinated changes in three files:
- `content.js`: add an entry to `SITE_CONFIG` (`articleSelector`, `linkSelector`, `titleSelector`, `isArticleUrl`, optional `articlePage`, optional `titleFit: 'fill'` when the site auto-sizes headline lines to width, optional `titleFromLinkAttr` when the visible headline text is unreliable) and a hostname check in `getSiteConfig()`.
- `manifest.json`: add the domain to both `host_permissions` and `content_scripts.matches`.
- `offscreen.js`: if the site's article body isn't matched by the existing `specificSelectors` list, add its selector (extraction fails when fewer than 100 chars are found).

### API details

- The headline prompt requires a single Danish headline under ~100 chars with no sensationalist words; output is used verbatim (quotes/labels stripped by `cleanHeadline`), so keep the "ONLY output the headline" constraint intact.
- The rewrite prompt returns plain text: headline on line 1, blank line, then paragraphs separated by blank lines — parsed by `parseRewriteOutput`. Keep the "plain text only" constraint intact.
