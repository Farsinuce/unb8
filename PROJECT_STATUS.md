# unb8 Project Status

_Last updated: 2026-07-06 (formerly "Unbait2")_

## Project Overview
unb8 is a Chrome browser extension (Manifest V3) that combats clickbait headlines on Danish news websites. It detects article teasers, fetches the article content in the background, uses an LLM (via OpenRouter) to generate a factual headline, and replaces the original headline on the page. Optionally it can also rewrite entire article pages, condensing the text and removing filler.

## Features Implemented
*   **Multi-Site Support:** `dr.dk`, `ekstrabladet.dk` and `bt.dk` — all re-verified against live HTML July 2026.
*   **dr.dk coverage:** front page, `/nyheder`, `/nyheder/seneste` (including inline "Kort nyt" short-news items that have no article link), category pages (e.g. `/nyheder/udland`), and article pages.
*   **AI-Powered De-Clickbaiting:**
    *   Fetches article HTML in the background (or, on article pages, uses the already-rendered text from the DOM).
    *   Parses HTML safely in an Offscreen Document; falls back to `__NEXT_DATA__` JSON extraction (needed for DR live blogs).
    *   Calls OpenRouter with a **free-model fallback chain** (see API Integration).
*   **Article-page rewriting (default OFF):** popup toggle. When enabled, the full article body is rewritten in condensed form (facts, numbers and quotes kept; filler removed). Paragraph blocks are replaced in place — images and fact boxes are kept.
*   **GUI toggles:** popup switches for "Enable unb8" (default on, applies live without reload) and "Unbait article pages" (default off). Plus a "Clear Cached Headlines" button.
*   **Smart Caching:** results cached in `chrome.storage.local` with a 7-day TTL and startup pruning. Concurrent requests for the same URL are de-duplicated.
*   **Visual Toggle:** 🎣 button (the unb8 brand mark) on each modified headline/article switches between original and AI version, restoring original computed styles exactly.
*   **Text Fitting (two per-site strategies via `config.titleFit`):**
    *   **`'cap'` (dr.dk, default):** binary-search font sizing **capped at the original computed font size**, so a short factual headline never grows larger than the site's own small teaser text (only shrinks, down to 60%, to avoid overflow).
    *   **`'fill'` (eb.dk, bt.dk):** those sites size each headline *line* to fill the teaser width, so the element's own computed font-size is a tiny base and capping at it renders the replacement far too small. Instead the rendered headline box (`getBoundingClientRect()`), the element's `innerHTML`, and the visible text's typography (font-family/weight/style/**colour**/transform/letter-spacing, via `captureVisibleTypography`, skipping bt's `aria-hidden` duplicate + `<s>` strike-throughs) are captured **before** overwriting; `setFillTitle` then replaces the multi-line markup with one wrapping block (`box-sizing:border-box`, `word-break:break-word`, `overflow:hidden`), re-applies the captured typography (so the AI headline keeps the site's font **and** colour, not just size), and binary-searches the largest font (9–96 px) whose wrapped text fits that box in **both** dimensions. Toggle-back restores the saved `innerHTML`.
*   **Inline short-news ("Kort nyt"):** on `/nyheder` and `/nyheder/seneste`, `article.hydra-latest-news-page-short-news-article` items render the full text inline with no link. These are handled by `processInlineArticles()` — the body paragraphs are read straight from the DOM (no fetch), and results are cached under a synthetic `shortnews://<host>/<hash-of-title+body>` key (they have no permalink). The headline is always de-clickbaited; when **"Unbait article pages" is on**, the inline body is also condensed in place (same rewrite path as full article pages, per-item state in an `inlineState` Map with its own 🎣 toggle).

## Technical Architecture
*   **Service Worker (`background.js`):** message handling, cache (TTL + pruning), article fetching with timeout, offscreen parsing coordination, OpenRouter calls with model fallback.
*   **Content Script (`content.js`):** per-site selector configs, MutationObserver (debounced 400 ms) for infinite scroll/hydration, article-page detection and rewriting, live enable/disable via `chrome.storage.onChanged`.
*   **Offscreen Document (`offscreen.html`/`offscreen.js`):** DOMParser context; tries article-body selectors, then `__NEXT_DATA__` JSON.
*   **Popup / Onboarding:** settings UI (API key, model choice, toggles) and first-run guide.

## Site Configuration (`content.js`)
Each entry in `SITE_CONFIG` has:
*   `articleSelector`: container element(s) for a single teaser.
*   `linkSelector`: the `<a>` inside the container pointing to the article. Use specific classes, not bare `a` (cards may contain duplicate/utility anchors).
*   `titleSelector`: the element with the headline text.
*   `isArticleUrl(url)`: predicate filtering out section links, video stories, DRTV and house content.
*   `articlePage` (optional): selectors for the article page itself (`headingSelector`, `headingTextSelector`, `leadSelector`, `bodySelector`, `paragraphSelector`).
*   `inlineArticle` (optional): selectors for link-less inline articles (`containerSelector`, `titleSelector`, `bodySelector`, `paragraphSelector`).

**Current `dr.dk` config (verified against live HTML, July 2026):**
```javascript
'dr.dk': {
  // .hydra-card                              — front page + category pages
  // .hydra-latest-news-item--article         — "Seneste nyt" band on the front page
  // .hydra-latest-news-teaser                — timeline on /nyheder + /nyheder/seneste
  // .hydra-latest-news-page-short-news-card  — short-news cards on /nyheder + /nyheder/seneste
  articleSelector: '.hydra-card, .hydra-latest-news-item--article, .hydra-latest-news-teaser, .hydra-latest-news-page-short-news-card',
  linkSelector: 'a.hydra-card-title, a.hydra-teaser-title',
  titleSelector: '.hydra-card-title__text, .hydra-teaser-title__text, .hydra-latest-news-item__title-text',
  isArticleUrl: /* path starts with /nyheder/ or /sporten/, slug contains a hyphen */,
  articlePage: {
    headingSelector: 'h1.hydra-article-title__heading',
    headingTextSelector: '.dre-title-text',
    leadSelector: 'p.hydra-article-title__summary',
    bodySelector: '.hydra-article-body',
    paragraphSelector: 'p.hydra-article-body-paragraph'
  }
}
```
Verified counts on saved fixtures (July 2026): front page 65 hydra-cards + 9 latest-news items (URL filter keeps 66 news links, skips 8 house-content links); /nyheder and /seneste 79 teasers each; /nyheder/udland 50 cards; article page 1 heading + 1 body + 22 paragraphs.

**Current `ekstrabladet.dk` config (verified against live HTML, July 2026):**
```javascript
'ekstrabladet.dk': {
  articleSelector: '.dre-item__text',   // teaser container
  linkSelector: 'a.dre-item__title',    // the link IS the title element
  titleSelector: 'a.dre-item__title',
  titleFit: 'fill',                     // headline lines auto-size to width → measure box & grow
  isArticleUrl: /* last segment all digits, or article<digits>.ece, or any /eblive/ LIVE blog */,
  articlePage: {
    headingSelector: 'h1.font-article-title',
    leadSelector: 'h2.font-article-subheader',
    bodySelector: '.article-bodytext',
    paragraphSelector: ':scope > p'      // direct children only (excludes caption/related <p>)
  }
}
```
Verified on the saved front page: 71 `.dre-item__text` teasers, 69 pass `isArticleUrl` (2 rejected: a podcast and an off-site `bold.dk` link); the 4 `/eblive/…` LIVE teasers are now accepted.

**Current `bt.dk` config (verified against live HTML, July 2026):**
```javascript
'bt.dk': {
  // Next.js hashed CSS-module classes change per build → key on stable attributes.
  articleSelector: '[data-item-id]',                      // any id (LIVE uses a short id, not urn)
  linkSelector: 'a[class*="TeaserLink_link"]',            // empty overlay anchor
  titleSelector: '[data-article-headline="true"]',
  titleFit: 'fill',
  titleFromLinkAttr: 'aria-label',       // headline innerText is doubled + may contain <s>
  isArticleUrl: /* >=2 path segments and a hyphen in the slug (also lets LIVE …/live-foelg-… through) */,
  // bt nests teasers, so processArticles pairs link+title with the nesting-safe ownQuery().
  articlePage: {
    headingSelector: 'h1[itemprop="headline"]',
    leadSelector: '[itemprop="description"]',
    bodySelector: '[itemprop="articleBody"]',
    paragraphSelector: 'p[class*="ArticleBody_paragraphNode"]'
  }
}
```
Verified on the saved front page: 97 `[data-item-id]` nodes — 80 `urn:bm:article:…` + 17 short-id (incl. LIVE like `8kj0kqyv`). Some urn teasers **nest** an inner `[data-item-id]`, so `ownQuery` keeps each teaser's link↔headline pairing correct. Non-teaser nodes (no headline/link) are skipped; reels, section landings and partner-site links are rejected by `isArticleUrl`; LIVE `…/live-foelg-…` blogs pass.

## API Integration
*   Endpoint: `https://openrouter.ai/api/v1/chat/completions`. Requires user's API key (`chrome.storage.local.openRouterApiKey`).
*   **Model selection:** `selectedModel` defaults to `'auto'`. Auto = the free-model chain, tried in order:
    1. `google/gemma-4-31b-it:free`
    2. `google/gemma-4-26b-a4b-it:free`
    3. `nvidia/nemotron-3-ultra-550b-a55b:free`
    4. `openai/gpt-oss-120b:free`
    5. `openai/gpt-oss-20b:free`
    A specific selected model is tried first with the free chain as fallback. The one paid option in the pickers is `~google/gemini-flash-latest` (OpenRouter's `~` selector auto-tracks the newest Gemini Flash). Fallback triggers on rate limits (429), provider errors (5xx), credit errors (402), OpenRouter 200-with-error bodies, timeouts, empty completions and truncated completions (`finish_reason: "length"`). A 401 (bad key) aborts the chain.
*   **max_tokens:** free models get generous budgets (1000 for headlines, 4000 for rewrites — they cost nothing, and reasoning models like GPT-OSS need headroom). Paid models stay capped (100 / 1500) to avoid "insufficient credits" pre-checks on low-tier accounts, and get `reasoning: {enabled: false}` (paid Gemini models otherwise burn the whole cap thinking).
*   **Cache TTL** is enforced both by startup pruning and on every read; cache writes are non-fatal (quota errors don't fail the request). Onboarding validates the API key via the auth-only `GET /api/v1/key` endpoint, so rate-limited free models can't block saving a valid key.
*   **Storage keys:** `openRouterApiKey`, `selectedModel`, `extensionEnabled` (default true), `rewriteArticles` (default false). Cache: `unbait_cache_v2_<url>` = `{title, ts}`, `unbait_rewrite_v1_<url>` = `{title, paragraphs, ts}`.

## Known Gaps / Next Steps
1.  **ekstrabladet.dk and bt.dk article-page + LIVE handling is new and not yet live-tested.** The teaser selectors and `isArticleUrl` predicates were verified against downloaded front pages, and the article-page selectors (`h1.font-article-title`/`.article-bodytext` for eb; `h1[itemprop="headline"]`/`[itemprop="articleBody"]` for bt) against downloaded article pages — but the on-page headline/body swap on those sites has only been reasoned through and adversarially reviewed, not exercised in a live browser. bt.dk also runs its own client-side headline auto-fit script whose interaction with our replacement hasn't been observed live. **LIVE teasers** (bt `…/live-foelg-…?directpost=N`, eb `/eblive/…`) are now de-clickbaited, but the fetch uses the URL's pathname (query dropped), so the generated headline may reflect the live blog **in general** rather than the specific highlighted post — verify live whether this reads well.
2.  Article rewrite replaces paragraphs at the position of the first paragraph block; interleaved media stays but text no longer flows around it in the original order.
3.  DR live blogs get headline treatment via `__NEXT_DATA__`; full rewrite of live blogs is intentionally skipped (body text too short/streamed).
4.  Consider an options page listing per-site toggles if more sites are added.

## Development Setup
1.  Open Chrome → `chrome://extensions/` → enable "Developer mode".
2.  "Load unpacked" → select the `unb8` folder.
3.  After editing `background.js`/`offscreen.js`: reload the extension. After editing `content.js`: reload the extension **and** the news-site tab.
4.  Service-worker logs: "service worker" link on the extension card. Content-script logs (prefixed `unb8:`): page DevTools console.
