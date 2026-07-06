// unb8 content script: finds teaser headlines (and article pages), asks the
// background worker for de-clickbaited versions and swaps them into the DOM.

// Configuration for different sites
const SITE_CONFIG = {
  'ekstrabladet.dk': {
    // Teaser: <div.dre-item__text> wraps <a.dre-item__title>, which holds three
    // responsive variants (--lg/--md/--sm), each splitting the headline into
    // per-line <p style="font-size:Xem/Xvw"> auto-fitted to the teaser width.
    articleSelector: '.dre-item__text',
    linkSelector: 'a.dre-item__title',
    titleSelector: 'a.dre-item__title',
    // The <a>'s own font-size is a tiny base (the big look comes from the per-line
    // multipliers), so measure the rendered box and grow the replacement to fill it.
    titleFit: 'fill',
    // Real articles end in a numeric id (…/slug/11227016) or the legacy
    // article<digits>.ece form. Also accept LIVE blogs under /eblive/ (the user wants
    // those de-clickbaited too). Podcasts and off-site bold.dk links stay rejected.
    isArticleUrl: (u) => {
      if (!u.hostname.endsWith('ekstrabladet.dk')) return false;
      if (u.pathname.startsWith('/eblive/')) return true;
      const last = u.pathname.split('/').filter(Boolean).pop() || '';
      return /^\d+$/.test(last) || /^article\d+\.ece$/i.test(last);
    },
    articlePage: {
      headingSelector: 'h1.font-article-title',
      headingTextSelector: null,
      leadSelector: 'h2.font-article-subheader',
      bodySelector: '.article-bodytext',
      // Direct children only: .article-bodytext also holds caption/related <p>s.
      paragraphSelector: ':scope > p'
    }
  },
  'bt.dk': {
    // Next.js CSS-module hashed classes change per build, so key on stable
    // attributes. The teaser container holds both the headline and an empty
    // absolutely-positioned overlay <a> whose aria-label is the clean title.
    // Match ANY data-item-id (not just urn:bm:article:…): LIVE teasers use a short
    // content id (e.g. "8kj0kqyv"). Non-teaser data-item-id nodes lack a headline/
    // link and are skipped by the link/title guard in processArticles.
    articleSelector: '[data-item-id]',
    linkSelector: 'a[class*="TeaserLink_link"]',
    titleSelector: '[data-article-headline="true"]',
    titleFit: 'fill',
    // The visible headline is split into fluid-line spans (plus an aria-hidden
    // duplicate that doubles innerText, and sometimes a <s> strikethrough), so
    // take the original title from the link's aria-label instead.
    titleFromLinkAttr: 'aria-label',
    isArticleUrl: (u) => {
      if (!u.hostname.endsWith('bt.dk')) return false;
      const seg = u.pathname.split('/').filter(Boolean);
      return seg.length >= 2 && seg[seg.length - 1].includes('-');
    },
    articlePage: {
      headingSelector: 'h1[itemprop="headline"]',
      headingTextSelector: null,
      leadSelector: '[itemprop="description"]',
      bodySelector: '[itemprop="articleBody"]',
      paragraphSelector: 'p[class*="ArticleBody_paragraphNode"]'
    }
  },
  'dr.dk': {
    // Four teaser systems (verified July 2026):
    //  .hydra-card                              — front page + category pages (/nyheder/udland)
    //  .hydra-latest-news-item--article         — "Seneste nyt" band on the front page
    //  .hydra-latest-news-teaser                — timeline column on /nyheder and /nyheder/seneste
    //  .hydra-latest-news-page-short-news-card  — short-news cards on /nyheder and /nyheder/seneste
    articleSelector: '.hydra-card, .hydra-latest-news-item--article, .hydra-latest-news-teaser, .hydra-latest-news-page-short-news-card',
    // Never use a bare 'a': cards contain duplicate/utility anchors (e.g. "Læs hele artiklen").
    linkSelector: 'a.hydra-card-title, a.hydra-teaser-title',
    titleSelector: '.hydra-card-title__text, .hydra-teaser-title__text, .hydra-latest-news-item__title-text',
    // Only real news articles: skips DRTV, /digital/ video stories, /om-dr/, /mad/,
    // category pages (/nyheder/udland) and other section links.
    isArticleUrl: (u) => {
      if (!u.hostname.endsWith('dr.dk')) return false;
      if (!/^\/(nyheder|sporten)\//.test(u.pathname)) return false;
      const segments = u.pathname.split('/').filter(Boolean);
      const slug = segments[segments.length - 1];
      return segments.length >= 2 && slug.includes('-');
    },
    articlePage: {
      headingSelector: 'h1.hydra-article-title__heading',
      // The visible headline text lives in a span inside the h1
      headingTextSelector: '.dre-title-text',
      leadSelector: 'p.hydra-article-title__summary',
      bodySelector: '.hydra-article-body',
      paragraphSelector: 'p.hydra-article-body-paragraph'
    },
    // "Kort nyt" items on /nyheder + /nyheder/seneste: full article rendered
    // inline with NO link to a separate page, so the body text is read straight
    // from the DOM (no fetch) and the headline replaced in place.
    inlineArticle: {
      containerSelector: 'article.hydra-latest-news-page-short-news-article',
      headingSelector: 'h2.hydra-latest-news-page-short-news-article__title',
      titleSelector: '.hydra-latest-news-page-short-news-article__title .dre-title-text',
      bodySelector: '.hydra-latest-news-page-short-news-article__body',
      paragraphSelector: 'p.hydra-latest-news-page-short-news-article__paragraph'
    }
  }
};

function getSiteConfig() {
  const hostname = window.location.hostname.replace('www.', '');
  if (hostname.includes('ekstrabladet.dk')) return SITE_CONFIG['ekstrabladet.dk'];
  if (hostname.includes('bt.dk')) return SITE_CONFIG['bt.dk'];
  if (hostname.includes('dr.dk')) return SITE_CONFIG['dr.dk'];
  return null;
}

const config = getSiteConfig();
const settings = { enabled: true, rewriteArticles: false };
let observer = null;
let scanTimer = null;
// Original article-page state for the rewrite feature (too large for data attributes)
let articleState = null;
// Per-item state for inline "Kort nyt" short-news articles (headline + optional body).
const inlineState = new Map();
// Bumped on disable and on rewrite-mode changes so in-flight article/inline responses
// from the previous mode are dropped instead of applied.
let articleEpoch = 0;

if (config) {
  init();
}

async function init() {
  const stored = await chrome.storage.local.get(['extensionEnabled', 'rewriteArticles']);
  settings.enabled = stored.extensionEnabled !== false; // default: on
  settings.rewriteArticles = stored.rewriteArticles === true; // default: off

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.extensionEnabled) {
      settings.enabled = changes.extensionEnabled.newValue !== false;
      if (settings.enabled) {
        start();
      } else {
        stop();
      }
    }
    if (changes.rewriteArticles) {
      settings.rewriteArticles = changes.rewriteArticles.newValue === true;
      if (settings.enabled) {
        // Re-process from a clean slate in the new mode; drop in-flight responses.
        // Inline short-news items follow the same toggle (headline-only vs full rewrite).
        articleEpoch++;
        revertArticlePage();
        revertInlineArticles();
        processArticlePage();
        processInlineArticles();
      }
    }
  });

  if (settings.enabled) {
    start();
  }
}

function start() {
  console.log('unb8: Active on', window.location.hostname);
  scanPage();

  if (!observer) {
    // Debounced: reactive news pages mutate constantly (ads, tickers, hydration).
    observer = new MutationObserver((mutations) => {
      if (mutations.some(m => m.addedNodes.length > 0)) {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scanPage, 400);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

function stop() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  clearTimeout(scanTimer);
  articleEpoch++; // drop in-flight article/inline responses
  revertAllTeasers();
  revertInlineArticles();
  revertArticlePage();
  console.log('unb8: Disabled, original headlines restored');
}

function scanPage() {
  if (!settings.enabled) return;
  processArticles();
  processInlineArticles();
  processArticlePage();
}

// Stable 36-radix hash for synthetic cache keys (inline "Kort nyt" items have no URL).
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// Like container.querySelector, but nesting-safe: returns the first match that
// belongs to THIS container and not to a teaser nested inside it. bt.dk nests
// teasers (an outer teaser can contain another data-item-id whose overlay link
// appears first in document order), so a plain querySelector would mis-pair the
// outer headline with an inner link. For non-nesting sites this is just querySelector.
function ownQuery(container, selector) {
  const nodes = container.querySelectorAll(selector);
  for (const n of nodes) {
    if (n.closest(config.articleSelector) === container) return n;
  }
  return null;
}

// The visible headline text, whitespace-normalized. Some sites (bt.dk) render the
// headline as duplicated / decorated spans whose innerText is doubled or carries
// strike-through markup, so prefer a clean copy from a link attribute when configured.
function getOriginalTitle(cfg, titleEl, link) {
  if (cfg.titleFromLinkAttr && link) {
    const v = link.getAttribute(cfg.titleFromLinkAttr);
    if (v && v.trim()) return v.replace(/\s+/g, ' ').trim();
  }
  return titleEl.innerText.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Teasers (front page, overview and category pages)
// ---------------------------------------------------------------------------

function processArticles() {
  const articles = document.querySelectorAll(config.articleSelector);

  articles.forEach(article => {
    if (article.dataset.unbaitProcessed) return;

    const link = ownQuery(article, config.linkSelector);
    const titleEl = ownQuery(article, config.titleSelector);
    if (!link || !titleEl) return;

    let url;
    try {
      url = new URL(link.href, window.location.href);
    } catch {
      return;
    }
    // Skip section links, video stories, DRTV, house content etc.
    if (!config.isArticleUrl(url)) return;

    // Mark as processed immediately to avoid double processing
    article.dataset.unbaitProcessed = 'true';
    const originalTitle = getOriginalTitle(config, titleEl, link);

    chrome.runtime.sendMessage({
      action: 'generateTitle',
      url: url.origin + url.pathname
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('unb8: message failed', chrome.runtime.lastError.message);
        return;
      }
      // Dropped if the user disabled the extension (which reverts and unflags
      // the teaser) while this request was in flight
      if (!settings.enabled || !article.dataset.unbaitProcessed) return;
      if (response && response.success && response.title) {
        applyNewTitle(article, titleEl, originalTitle, response.title, { fit: config.titleFit });
      } else {
        console.log('unb8: Failed to generate title for', url.href, response?.error);
      }
    });
  });
}

function applyNewTitle(articleContainer, titleElement, originalTitle, newTitle, options = {}) {
  const fitMode = options.fit || 'cap'; // 'cap' (dr.dk) | 'fill' (eb.dk/bt.dk)
  // Store original title and styles
  articleContainer.dataset.originalTitle = originalTitle;
  articleContainer.dataset.aiTitle = newTitle;
  articleContainer.dataset.showingAi = 'true';
  // Remembered so revertAllTeasers can re-find the title element without a re-query hint
  articleContainer.dataset.unbaitTitleSelector = options.titleSelector || config.titleSelector;
  articleContainer.dataset.unbaitFit = fitMode;

  // Store original styles once: the verbatim inline style attribute (for exact
  // restore), the original font size (fit ceiling) and the computed line clamp.
  // For 'fill' sites the visible size is driven by per-line font multipliers, not
  // the element's own font-size, so also capture the rendered box (the space to
  // reproduce) and the original inner HTML (which holds that multi-line markup)
  // for an exact toggle-back.
  if (articleContainer.dataset.originalStyleAttr === undefined) {
    const cs = window.getComputedStyle(titleElement);
    articleContainer.dataset.originalStyleAttr = titleElement.getAttribute('style') || '';
    articleContainer.dataset.originalFontSize = cs.fontSize;
    articleContainer.dataset.originalWebkitLineClamp = cs.webkitLineClamp;
    if (fitMode === 'fill') {
      const rect = titleElement.getBoundingClientRect();
      articleContainer.dataset.originalBoxHeight = String(rect.height);
      articleContainer.dataset.originalBoxWidth = String(rect.width);
      articleContainer.dataset.originalTitleHTML = titleElement.innerHTML;
      articleContainer.dataset.fillTypography = JSON.stringify(captureVisibleTypography(titleElement));
    }
  }

  showAiTitle(articleContainer, titleElement);
  addToggleButton(articleContainer, titleElement);
}

// Renders the AI headline into the title element using the site's fit strategy.
function showAiTitle(container, titleElement) {
  const aiTitle = container.dataset.aiTitle;
  if (container.dataset.unbaitFit === 'fill') {
    setFillTitle(titleElement, container, aiTitle);
  } else {
    titleElement.innerText = aiTitle;
    fitTextToContainer(titleElement, container);
  }
}

function fitTextToContainer(textElement, container) {
  let availableWidth = container.clientWidth;
  let availableHeight = container.clientHeight;

  // If the container is very small (e.g. just started rendering), try to use the parent
  if (availableHeight < 20 && container.parentElement) {
    availableHeight = container.parentElement.clientHeight;
    availableWidth = container.parentElement.clientWidth;
  }

  // The replacement must never look bigger than the site's own headline: use the
  // original computed size as the ceiling and only shrink (down to 60%) to avoid
  // overflow. Without this ceiling a short headline in a small teaser (e.g. the
  // --xxs-xx-small "Seneste nyt" band) balloons to fill the available box.
  const originalSize = parseFloat(container.dataset.originalFontSize) || 16;
  const maxSize = Math.round(originalSize);
  const minSize = Math.min(maxSize, Math.max(9, Math.floor(originalSize * 0.6)));

  // Reset styles to allow measurement
  textElement.style.width = '100%';
  textElement.style.height = 'auto';
  textElement.style.display = 'block'; // Ensure it takes up space
  textElement.style.webkitLineClamp = 'unset'; // Disable line clamping during measurement
  textElement.style.overflow = 'visible';

  let lo = minSize;
  let hi = maxSize;
  let bestSize = minSize;

  // Binary search for the largest size (<= original) whose text fits the height
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    textElement.style.fontSize = mid + 'px';
    textElement.style.lineHeight = '1.2'; // Standardize line height for calculation

    // Check if the actual content height fits, with a small tolerance (10%)
    if (textElement.scrollHeight <= availableHeight * 1.1) {
      bestSize = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // Apply best fit
  textElement.style.fontSize = bestSize + 'px';
  textElement.style.lineHeight = '1.2';

  // Re-apply line clamping if it was present, to handle slight overflows gracefully
  if (container.dataset.originalWebkitLineClamp && container.dataset.originalWebkitLineClamp !== 'none') {
    textElement.style.display = '-webkit-box';
    textElement.style.webkitLineClamp = container.dataset.originalWebkitLineClamp;
    textElement.style.webkitBoxOrient = 'vertical';
    textElement.style.overflow = 'hidden';
  }
}

// Copies the font + colour the reader actually sees. On bt.dk the visible text sits
// in nested fluidLine / <strong> spans (not the container). We pick the FIRST visible
// leaf element (no element children) that directly holds text, skipping the
// aria-hidden measurement duplicate bt renders and any <s>/<del> strike-through
// "correction" (whose muted/transparent colour we must NOT mirror). Text-decoration
// itself is never copied, so a clickbait strikethrough is never carried over either.
function captureVisibleTypography(titleElement) {
  let sample = null;
  const nodes = titleElement.querySelectorAll('*');
  for (const el of nodes) {
    if (el.children.length > 0) continue;                       // want a text leaf
    if (el.closest('[aria-hidden="true"], s, del')) continue;   // skip dupes + strike corrections
    const txt = el.textContent && el.textContent.trim();
    if (txt && el.getClientRects().length > 0) { sample = el; break; }
  }
  const cs = window.getComputedStyle(sample || titleElement);
  return {
    fontFamily: cs.fontFamily,
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    color: cs.color,
    textTransform: cs.textTransform,
    letterSpacing: cs.letterSpacing
  };
}

// 'fill' sites (eb.dk, bt.dk) size each headline line to the teaser width, so the
// element's own font-size is a tiny base and the real visual size is the box the
// original text occupied. Replace the multi-line auto-fit markup with one wrapping
// block and grow the font until the wrapped text fills that captured box height.
function setFillTitle(titleElement, container, newTitle) {
  const boxHeight = parseFloat(container.dataset.originalBoxHeight) || 0;
  let boxWidth = parseFloat(container.dataset.originalBoxWidth) || 0;
  if (!boxWidth) {
    boxWidth = container.clientWidth ||
      (container.parentElement && container.parentElement.clientWidth) || 0;
  }
  // A missing / degenerate box height must NOT fall back to the container height:
  // on bt.dk the container is the whole card, so that would inflate the headline to
  // fill the entire teaser. Use a sane two-line default instead, and hard-cap the
  // font so no measurement glitch can ever blow a headline up absurdly.
  const targetHeight = boxHeight > 8 ? boxHeight : 48;
  const targetWidth = boxWidth || Infinity;
  const MAX_FONT = 96;

  titleElement.textContent = newTitle; // wipes the variant / fluid-line markup

  // Turn the title element into a plain wrapping block we can size freely. Break
  // long Danish compound words so they wrap instead of spilling out of the teaser,
  // and clip (overflow:hidden) so a too-long headline can never paint over neighbours.
  titleElement.style.display = 'block';
  // border-box so width == the captured border-box footprint and scrollWidth stays
  // within it regardless of the element's own padding (else the width test below
  // could fail at every size and pin the font to the 9px floor).
  titleElement.style.boxSizing = 'border-box';
  titleElement.style.width = boxWidth ? boxWidth + 'px' : '100%';
  titleElement.style.height = 'auto';
  titleElement.style.whiteSpace = 'normal';
  titleElement.style.overflowWrap = 'break-word';
  titleElement.style.wordBreak = 'break-word';
  titleElement.style.overflow = 'hidden';
  titleElement.style.webkitLineClamp = 'unset';
  titleElement.style.lineHeight = '1.15';

  // Mirror the original headline's font + colour (not just size). Applied BEFORE the
  // search so weight / letter-spacing are reflected in the width measurement.
  if (container.dataset.fillTypography) {
    try {
      const t = JSON.parse(container.dataset.fillTypography);
      titleElement.style.fontFamily = t.fontFamily;
      titleElement.style.fontWeight = t.fontWeight;
      titleElement.style.fontStyle = t.fontStyle;
      titleElement.style.color = t.color;
      titleElement.style.textTransform = t.textTransform;
      titleElement.style.letterSpacing = t.letterSpacing;
    } catch (e) { /* ignore malformed */ }
  }

  // Binary-search the largest font whose wrapped text fits the captured box in BOTH
  // dimensions. Checking width too stops an unbreakable line from passing the height
  // test (single line, short scrollHeight) while overflowing horizontally.
  let lo = 9;
  let hi = Math.min(MAX_FONT, Math.max(9, Math.round(targetHeight)));
  let best = lo;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    titleElement.style.fontSize = mid + 'px';
    if (titleElement.scrollHeight <= targetHeight * 1.08 &&
        titleElement.scrollWidth <= targetWidth + 1) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  titleElement.style.fontSize = best + 'px';
}

function restoreOriginalTitleStyles(container, titleElement) {
  // Fill sites replaced the whole inner markup (multi-line auto-fit lines), so
  // restore innerHTML to bring that structure back exactly; others just set text.
  if (container.dataset.unbaitFit === 'fill' && container.dataset.originalTitleHTML !== undefined) {
    titleElement.innerHTML = container.dataset.originalTitleHTML;
  } else {
    titleElement.innerText = container.dataset.originalTitle;
  }
  // Restore the element's inline style attribute verbatim, so all properties
  // the fitter touched (incl. width/height) revert to stylesheet values
  const saved = container.dataset.originalStyleAttr;
  if (saved !== undefined) {
    if (saved) {
      titleElement.setAttribute('style', saved);
    } else {
      titleElement.removeAttribute('style');
    }
  }
}

function addToggleButton(container, titleElement) {
  // :scope > so a nested teaser's button (bt.dk nests) isn't mistaken for this one's.
  if (container.querySelector(':scope > .unbait-toggle')) return;

  const btn = createToggleButton();
  Object.assign(btn.style, {
    position: 'absolute',
    top: '5px',
    right: '5px'
  });

  // Make container relative so absolute positioning works
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const isShowingAi = container.dataset.showingAi === 'true';
    if (isShowingAi) {
      restoreOriginalTitleStyles(container, titleElement);
      container.dataset.showingAi = 'false';
      setButtonState(btn, false);
    } else {
      showAiTitle(container, titleElement);
      container.dataset.showingAi = 'true';
      setButtonState(btn, true);
    }
  });

  container.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Inline "Kort nyt" short-news articles (no link, body rendered on the list page)
// ---------------------------------------------------------------------------

function processInlineArticles() {
  const cfg = config.inlineArticle;
  if (!cfg) return;

  document.querySelectorAll(cfg.containerSelector).forEach(article => {
    if (article.dataset.unbaitProcessed) return;

    const titleEl = article.querySelector(cfg.titleSelector);
    const body = article.querySelector(cfg.bodySelector);
    if (!titleEl || !body) return;

    // Prefer the real paragraphs (skips the "Læs op" / glossary button noise); fall
    // back to the whole body only if the paragraph markup ever changes.
    const paras = article.querySelectorAll(cfg.paragraphSelector);
    const text = (paras.length
      ? Array.from(paras).map(p => p.innerText.trim()).join('\n\n')
      : body.innerText).trim().substring(0, 6000);
    // Below 100 chars the background would try to fetch the (non-existent) URL, so skip.
    if (text.length < 100) return;

    article.dataset.unbaitProcessed = 'true';
    const originalTitle = titleEl.innerText.trim();
    // These items have no permalink, so cache by a stable synthetic key. Hash the
    // body too, so two items sharing a headline can't collide onto one rewrite.
    const key = `shortnews://${window.location.hostname}/${hashString(originalTitle + ' ' + text)}`;

    const epoch = articleEpoch;

    // With "Unbait article pages" on, these inline items get the full treatment
    // (headline + condensed body); otherwise just the de-clickbaited headline.
    if (settings.rewriteArticles && text.length >= 200) {
      chrome.runtime.sendMessage({ action: 'rewriteArticle', url: key, title: originalTitle, text }, (response) => {
        if (chrome.runtime.lastError || !isInlineResponseCurrent(epoch, article)) return;
        if (response && response.success) {
          applyInlineArticle(cfg, article, titleEl, body, originalTitle, response.title, response.paragraphs);
        } else {
          console.log('unb8: inline rewrite failed, falling back to headline only.', response?.error);
          requestInlineHeadline(cfg, article, titleEl, body, key, originalTitle, text, epoch);
        }
      });
    } else {
      requestInlineHeadline(cfg, article, titleEl, body, key, originalTitle, text, epoch);
    }
  });
}

function requestInlineHeadline(cfg, article, titleEl, body, key, originalTitle, text, epoch) {
  chrome.runtime.sendMessage({ action: 'generateTitle', url: key, text }, (response) => {
    if (chrome.runtime.lastError || !isInlineResponseCurrent(epoch, article)) return;
    if (response && response.success && response.title) {
      applyInlineArticle(cfg, article, titleEl, body, originalTitle, response.title, null);
    } else {
      console.log('unb8: Failed to rewrite inline short-news headline.', response?.error);
    }
  });
}

// A slow response must be dropped if the extension was disabled, the rewrite mode
// changed, or the item scrolled out of the (virtualized) DOM meanwhile.
function isInlineResponseCurrent(epoch, article) {
  return settings.enabled &&
    epoch === articleEpoch &&
    article.isConnected &&
    article.dataset.unbaitProcessed === 'true';
}

// Applies a new headline and (when paragraphs are given) a rewritten body to one
// inline short-news item, tracking state so it can be toggled and reverted.
function applyInlineArticle(cfg, article, titleEl, body, originalTitle, newTitle, paragraphs) {
  const state = {
    cfg, article, titleEl, body,
    originalTitle,
    newTitle,
    paragraphs: paragraphs || null,
    originalBodyHTML: paragraphs ? body.innerHTML : null,
    showingAi: true
  };
  inlineState.set(article, state);
  article.dataset.unbaitInline = 'true'; // marker so revertAllTeasers leaves us alone

  titleEl.innerText = newTitle;
  if (paragraphs) {
    replaceArticleBody(cfg, body, paragraphs);
  }
  addInlineToggleButton(cfg, article, state);
}

function addInlineToggleButton(cfg, article, state) {
  const heading = article.querySelector(cfg.headingSelector) || state.titleEl.parentElement;
  if (heading.querySelector('.unbait-toggle')) return;

  const btn = createToggleButton();
  Object.assign(btn.style, { verticalAlign: 'middle', marginLeft: '10px' });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.showingAi) {
      state.titleEl.innerText = state.originalTitle;
      if (state.originalBodyHTML !== null) state.body.innerHTML = state.originalBodyHTML;
      state.showingAi = false;
      setButtonState(btn, false);
    } else {
      state.titleEl.innerText = state.newTitle;
      if (state.originalBodyHTML !== null) replaceArticleBody(cfg, state.body, state.paragraphs);
      state.showingAi = true;
      setButtonState(btn, true);
    }
  });

  heading.appendChild(btn);
}

function revertInlineArticles() {
  const cfg = config.inlineArticle;
  inlineState.forEach((state) => {
    state.titleEl.innerText = state.originalTitle;
    if (state.originalBodyHTML !== null) state.body.innerHTML = state.originalBodyHTML;
    (state.article.querySelector(cfg.headingSelector) || state.article)
      .querySelector('.unbait-toggle')?.remove();
    delete state.article.dataset.unbaitInline;
  });
  inlineState.clear();
  // Clear the processed flag on every inline item (incl. in-flight, un-applied
  // ones not in the map) so a re-enable / mode change can re-scan them.
  if (cfg) {
    document.querySelectorAll(`${cfg.containerSelector}[data-unbait-processed]`)
      .forEach(a => delete a.dataset.unbaitProcessed);
  }
}

function createToggleButton() {
  const btn = document.createElement('button');
  btn.className = 'unbait-toggle';
  btn.innerHTML = '🎣'; // unb8 brand mark
  btn.title = 'Toggle original headline';
  Object.assign(btn.style, {
    zIndex: '100',
    background: 'white',
    border: '1px solid #ccc',
    borderRadius: '50%',
    width: '24px',
    height: '24px',
    cursor: 'pointer',
    fontSize: '14px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    padding: '0'
  });
  return btn;
}

function setButtonState(btn, showingAi) {
  btn.style.opacity = showingAi ? '1' : '0.5';
  btn.style.filter = showingAi ? 'none' : 'grayscale(100%)';
}

function revertAllTeasers() {
  document.querySelectorAll('[data-unbait-processed]').forEach(container => {
    // The article-page <h1> also carries unbaitProcessed but is owned by revertArticlePage.
    if (config.articlePage && container.matches(config.articlePage.headingSelector)) return;
    // Inline short-news items are owned by revertInlineArticles.
    if (config.inlineArticle && container.matches(config.inlineArticle.containerSelector)) return;

    // Applied items carry the title-selector marker — restore their headline/styles.
    if (container.dataset.unbaitTitleSelector) {
      const titleEl = container.querySelector(container.dataset.unbaitTitleSelector);
      // 'fill' sites restore from originalTitleHTML, not originalTitle, so gate on
      // finding the element (we know it was processed) rather than a non-empty title.
      if (titleEl) {
        restoreOriginalTitleStyles(container, titleEl);
      }
      container.querySelector(':scope > .unbait-toggle')?.remove();
      delete container.dataset.unbaitTitleSelector;
      delete container.dataset.unbaitFit;
      delete container.dataset.originalTitle;
      delete container.dataset.aiTitle;
      delete container.dataset.showingAi;
      delete container.dataset.originalStyleAttr;
      delete container.dataset.originalFontSize;
      delete container.dataset.originalWebkitLineClamp;
      delete container.dataset.originalBoxHeight;
      delete container.dataset.originalBoxWidth;
      delete container.dataset.originalTitleHTML;
      delete container.dataset.fillTypography;
    }
    // Clear the processed flag on both applied and still-in-flight items so a
    // re-enable can re-scan them.
    delete container.dataset.unbaitProcessed;
  });
}

// ---------------------------------------------------------------------------
// Article pages: de-clickbait the headline; optionally rewrite the whole body
// ---------------------------------------------------------------------------

function processArticlePage() {
  const ap = config.articlePage;
  if (!ap) return;

  const heading = document.querySelector(ap.headingSelector);
  const body = document.querySelector(ap.bodySelector);
  if (!heading || !body) return; // not an article page
  if (heading.dataset.unbaitProcessed) return;
  heading.dataset.unbaitProcessed = 'true';

  const url = window.location.origin + window.location.pathname;
  const originalTitle = heading.innerText.trim();
  const text = extractArticleText(ap, body);
  const epoch = articleEpoch;

  if (settings.rewriteArticles && text.length >= 200) {
    chrome.runtime.sendMessage({ action: 'rewriteArticle', url, title: originalTitle, text }, (response) => {
      if (chrome.runtime.lastError || !isArticleResponseCurrent(epoch, heading, url)) return;
      if (response && response.success) {
        applyArticleRewrite(ap, heading, body, originalTitle, response.title, response.paragraphs);
      } else {
        console.log('unb8: article rewrite failed, falling back to headline only.', response?.error);
        requestArticleHeadline(ap, heading, url, originalTitle, text, epoch);
      }
    });
  } else {
    requestArticleHeadline(ap, heading, url, originalTitle, text, epoch);
  }
}

// A slow LLM response must not be applied if the user changed settings or
// client-side-navigated to another article (Next.js SPA routing) meanwhile.
function isArticleResponseCurrent(epoch, heading, url) {
  return settings.enabled &&
    epoch === articleEpoch &&
    heading.isConnected &&
    (window.location.origin + window.location.pathname) === url;
}

function requestArticleHeadline(ap, heading, url, originalTitle, text, epoch) {
  // Pass the already-rendered text along so the background skips re-fetching the page.
  chrome.runtime.sendMessage({ action: 'generateTitle', url, text }, (response) => {
    if (chrome.runtime.lastError || !isArticleResponseCurrent(epoch, heading, url)) return;
    if (response && response.success && response.title) {
      applyArticleRewrite(ap, heading, null, originalTitle, response.title, null);
    } else {
      console.log('unb8: Failed to generate article headline.', response?.error);
    }
  });
}

function extractArticleText(ap, body) {
  const parts = [];
  const lead = ap.leadSelector && document.querySelector(ap.leadSelector);
  if (lead) parts.push(lead.innerText.trim());

  const paragraphs = body.querySelectorAll(ap.paragraphSelector);
  if (paragraphs.length > 0) {
    paragraphs.forEach(p => parts.push(p.innerText.trim()));
  } else {
    parts.push(body.innerText.trim()); // e.g. live blogs
  }
  return parts.join('\n\n').substring(0, 6000);
}

// Applies a new headline and (when paragraphs are given) a rewritten body.
function applyArticleRewrite(ap, heading, body, originalTitle, newTitle, paragraphs) {
  articleState = {
    heading,
    body,
    originalTitle,
    newTitle,
    paragraphs,
    originalBodyHTML: (body && paragraphs) ? body.innerHTML : null,
    showingAi: true
  };

  setArticleHeadline(ap, heading, newTitle);
  if (body && paragraphs) {
    replaceArticleBody(ap, body, paragraphs);
  }
  addArticleToggleButton(ap, heading);
}

function setArticleHeadline(ap, heading, title) {
  const textEl = (ap.headingTextSelector && heading.querySelector(ap.headingTextSelector)) || heading;
  textEl.innerText = title;
  heading.setAttribute('aria-label', title);
}

// Replace the article's paragraphs with the rewritten ones pairwise, in place,
// so media, fact boxes and subheadings between paragraphs stay where they are.
function replaceArticleBody(ap, body, paragraphs) {
  const existing = Array.from(body.querySelectorAll(ap.paragraphSelector));
  if (existing.length === 0) return;

  // DR wraps each paragraph as <div class="dre-speech"><p class="...">text</p></div>
  const blockOf = (p) => p.closest('.dre-speech') || p;
  const templateP = existing[0];
  const templateBlock = blockOf(templateP);
  const makeBlock = (text) => {
    const p = document.createElement('p');
    p.className = templateP.className;
    p.innerText = text;
    if (templateBlock === templateP) return p;
    const w = document.createElement('div');
    w.className = templateBlock.className;
    w.appendChild(p);
    return w;
  };

  const count = Math.min(existing.length, paragraphs.length);
  let lastBlock = null;
  for (let i = 0; i < count; i++) {
    const newBlock = makeBlock(paragraphs[i]);
    blockOf(existing[i]).replaceWith(newBlock);
    lastBlock = newBlock;
  }
  // More rewritten paragraphs than original ones: append the extras in sequence
  for (let i = count; i < paragraphs.length; i++) {
    const newBlock = makeBlock(paragraphs[i]);
    lastBlock.after(newBlock);
    lastBlock = newBlock;
  }
  // Fewer (the usual case for a condensed rewrite): drop the leftover originals
  for (let i = count; i < existing.length; i++) {
    blockOf(existing[i]).remove();
  }
}

function addArticleToggleButton(ap, heading) {
  let btn = heading.querySelector('.unbait-toggle');
  if (btn) return;

  btn = createToggleButton();
  Object.assign(btn.style, {
    verticalAlign: 'middle',
    marginLeft: '10px'
  });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!articleState) return;

    if (articleState.showingAi) {
      setArticleHeadline(ap, articleState.heading, articleState.originalTitle);
      if (articleState.originalBodyHTML !== null) {
        articleState.body.innerHTML = articleState.originalBodyHTML;
      }
      articleState.showingAi = false;
      setButtonState(btn, false);
    } else {
      setArticleHeadline(ap, articleState.heading, articleState.newTitle);
      if (articleState.originalBodyHTML !== null) {
        replaceArticleBody(ap, articleState.body, articleState.paragraphs);
      }
      articleState.showingAi = true;
      setButtonState(btn, true);
    }
    // Re-append: setting the heading text may have wiped the button
    if (!heading.contains(btn)) heading.appendChild(btn);
  });

  heading.appendChild(btn);
}

function revertArticlePage() {
  const ap = config.articlePage;
  if (!ap) return;
  if (articleState) {
    setArticleHeadline(ap, articleState.heading, articleState.originalTitle);
    if (articleState.originalBodyHTML !== null && articleState.body) {
      articleState.body.innerHTML = articleState.originalBodyHTML;
    }
    articleState.heading.querySelector('.unbait-toggle')?.remove();
    delete articleState.heading.dataset.unbaitProcessed;
    articleState = null;
  }
  // Also clear the guard when no response has been applied yet (request still
  // in flight) so the page can be re-processed in the new mode
  const heading = document.querySelector(ap.headingSelector);
  if (heading) delete heading.dataset.unbaitProcessed;
}
