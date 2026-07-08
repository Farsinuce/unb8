// unb8 UNIVERSAL MODE (experimental) — injected on demand by the popup's
// "Clean this page" button via chrome.scripting.executeScript (together with
// parser.js). Unlike content.js (which targets the 3 tuned Danish sites), this runs
// on ANY page and de-clickbaits whatever visible headlines it finds.
//
// For a PROPER de-clickbait it tries to read the article BEHIND each headline: when
// the headline links to the SAME origin as the current tab, it fetches that article
// HTML directly (a same-origin request needs no host permission — verified against
// Chrome & Firefox MV3 docs) and extracts the body text with the shared parseHtml
// (parser.js). The fetch is credential-less (credentials:'omit') so it never forwards
// the user's authenticated/personalized content to the model and can't cause a
// credentialed side-effect; and only hyphen-slug ("article-looking") same-origin paths
// are followed. Cross-origin links (other domains, or www/apex & http/https mismatches
// — origin is scheme+host+port) can't be fetched from a content script; those, and any
// article that fails to fetch, fall back to the visible headline + nearby text only.
//
// The popup closes the moment focus leaves it, but this script lives in the PAGE and
// keeps running (its observers, timers and messaging survive) — so it shows its own
// on-page status widget with a Stop button, the only way to convey "still working" and
// offer a stop control (an action popup cannot be pinned open in either browser).
//
// Guardrails: lazy IntersectionObserver dispatch, a per-page LLM-call cap, per-request
// input caps, same-origin-only credential-less fetch with a timeout, reject-memoization,
// and a per-minute request cap enforced in the background worker.

(function () {
  'use strict';

  // Re-injection (re-clicking "Clean this page", or a double click) re-runs this file.
  // If a controller already exists, just restart it (resume/rescan) instead of spinning
  // up a second set of observers.
  if (window.__unb8Universal && typeof window.__unb8Universal.restart === 'function') {
    window.__unb8Universal.restart();
    return;
  }

  const MAX_PER_PAGE = 30;          // hard ceiling on LLM calls per page (per injection)
  const MAX_INPUT_CHARS = 1500;     // cap on visible-only text sent per headline
  const MAX_FETCH_CHARS = 4000;     // cap when we fetched the article body (richer context)
  const MAX_OBSERVED = 150;         // cap on unique elements we watch (bounds a huge page)
  const FETCH_TIMEOUT_MS = 8000;    // per same-origin article fetch
  const IO_ROOT_MARGIN = '200px';   // start a little before a heading scrolls into view
  const MIN_LEN = 20;               // shortest plausible headline
  const MAX_LEN = 200;              // longest plausible headline
  const MAX_THROTTLE_RETRIES = 3;   // per element, when the worker rate-limits us

  // Stable 36-radix hash for the synthetic cache key (mirrors content.js:hashString).
  function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim();

  let generation = 0;              // bumped on each (re-)injection; ties async work to its run
  let dispatched = 0;               // LLM calls made (successful or attempted, not throttled)
  let inFlight = 0;                 // requests currently fetching/awaiting a model response
  let stopped = false;             // no new dispatches (cap reached OR user stop)
  let aborted = false;             // user pressed Stop — also drop in-flight results
  let finalReason = null;          // 'stopped' | 'done' once finalized (drives widget text)
  let observedCapped = false;
  let io = null;
  let mo = null;
  let scanTimer = null;
  const applied = new Map();        // element -> { target, originalHTML, aiHTML, aiTitle, showingAi }
  const ctxCache = new Map();       // element -> request context string (avoids re-fetch on throttle-retry)
  const observedEls = new Set();    // elements currently watched (unique — bounds the cap correctly)

  // --- Candidate detection ---------------------------------------------------
  // Cheap textual filters run BEFORE any layout read (getBoundingClientRect /
  // getComputedStyle force reflow); rejects are memoized on the element, and
  // already-observed elements are skipped, so MutationObserver re-scans don't
  // re-measure or double-count anything.
  const SKIP_ANCESTORS = 'nav, header, footer, aside, button, [role="navigation"], [aria-hidden="true"]';

  function isCandidate(el) {
    if (el.dataset.unbaitSkip === '1' || el.dataset.unbaitUniversal === '1' || observedEls.has(el)) return false;

    // Cheap textual checks first (no layout). collectCandidates() has already
    // narrowed the element TYPES (headings, headline links, title-classed or bold
    // card text), so here we only gate on the text and visibility every strategy
    // shares — no tag check needed.
    const txt = cleanText(el.textContent);
    if (txt.length < MIN_LEN || txt.length > MAX_LEN || !txt.includes(' ')) {
      el.dataset.unbaitSkip = '1';
      return false;
    }
    // Reject short ALL-CAPS kickers/labels ("SENESTE NYT", "BREAKING") — section
    // tags, not headlines. Bounded to <40 chars so a genuinely short all-caps
    // headline stays possible; requires a real (incl. Danish æ/ø/å) letter so
    // pure numbers/symbols aren't caught.
    if (txt.length < 40 && txt === txt.toUpperCase() && /[A-ZÆØÅ]/.test(txt)) {
      el.dataset.unbaitSkip = '1';
      return false;
    }
    if (el.closest(SKIP_ANCESTORS)) { el.dataset.unbaitSkip = '1'; return false; }

    // Now the layout read for visibility.
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 10) { el.dataset.unbaitSkip = '1'; return false; }
    const cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) {
      el.dataset.unbaitSkip = '1';
      return false;
    }
    return true;
  }

  // Read an element's class as a lowercase string. Guards against SVG elements,
  // whose `className` is an SVGAnimatedString rather than a plain string.
  const classNameOf = (el) => (el.getAttribute('class') || '').toLowerCase();

  const HEADING_SEL = 'h1, h2, h3, h4';
  const TITLE_SEL = '[class*="title" i], [class*="headline" i], [class*="heading" i]';
  // Card/teaser wrappers on modern JS news sites. Case-insensitive so CSS-module
  // names (`Teaser_root__ab12`) match too.
  const CARD_SEL = '[class*="card" i], [class*="teaser" i], [class*="story" i], ' +
                   '[class*="article" i], [class*="post" i]';
  // Class substrings that mark a title-ish element as NOT the headline (deks,
  // kickers, section/category labels, bylines).
  const NON_HEADLINE_CLASS = /sub|kicker|section|category|label|meta|byline|author|logo|tag|breadcrumb/;

  // Within a card wrapper, the single boldest text leaf — for utility-class
  // (Tailwind-style) sites whose headline is a bare bold <div>/<span> with no
  // heading, link, or title-ish class. Leaf-only and capped to bound the cost of
  // the computed-style reads; class/tag bold hints avoid the read entirely.
  function boldestLeaf(card) {
    let best = null, bestScore = 0, checked = 0;
    for (const n of card.querySelectorAll('div, span, p, strong, b')) {
      if (checked >= 30) break;                 // bound work per card
      if (n.children.length > 0) continue;      // leaves only (cheap, no layout)
      const txt = cleanText(n.textContent);
      if (txt.length < MIN_LEN || txt.length > MAX_LEN || !txt.includes(' ')) continue;
      checked++;
      const cls = classNameOf(n);
      let score;
      if (n.tagName === 'STRONG' || n.tagName === 'B' ||
          /font-bold|font-semibold|fw-bold|text-bold|\bbold\b/.test(cls)) {
        score = 700;                            // class/tag hint — no reflow needed
      } else {
        score = parseInt(window.getComputedStyle(n).fontWeight, 10) || 0;
      }
      if (score >= 600 && score > bestScore) { best = n; bestScore = score; }
    }
    return best;
  }

  // Collect visible-headline candidates via several selector-free strategies so
  // universal mode also reaches modern React/Next teaser cards (where the headline
  // is a styled <div>/<span>, not a semantic heading or bare link). Each headline
  // is queued once: more specific candidates (headings, links) win, and broader
  // strategies skip anything already covered by a nested/ancestor candidate.
  function collectCandidates() {
    const out = [];
    const seen = new Set();
    const push = (el) => { if (el && !seen.has(el)) { seen.add(el); out.push(el); } };

    // 1. Semantic headings.
    document.querySelectorAll(HEADING_SEL).forEach(push);

    // 2. Standalone headline links whose text isn't already owned by a heading.
    document.querySelectorAll('a').forEach(a => {
      if (a.querySelector(HEADING_SEL)) return; // the inner heading is the candidate
      if (a.closest(HEADING_SEL)) return;       // inside a heading — heading is the candidate
      push(a);
    });

    // 3. Non-semantic headline containers: elements whose class hints "title"/
    //    "headline" (but not a sub-title/kicker), when no heading or link already
    //    covers the text. Prefer the innermost such element. Cheap — class match,
    //    no layout read.
    document.querySelectorAll(TITLE_SEL).forEach(el => {
      if (NON_HEADLINE_CLASS.test(classNameOf(el))) return;
      if (el.querySelector(HEADING_SEL + ', a')) return; // a more specific candidate is inside
      if (el.closest(HEADING_SEL + ', a')) return;       // already covered by strategy 1/2
      if (el.querySelector(TITLE_SEL)) return;           // a nested title element wins
      push(el);
    });

    // 4. Utility-class (Tailwind) cards with no heading/link/title-class headline:
    //    fall back to the boldest text leaf in the card.
    document.querySelectorAll(CARD_SEL).forEach(card => {
      if (card.querySelector(HEADING_SEL + ', a, ' + TITLE_SEL)) return;
      push(boldestLeaf(card));
    });

    return out;
  }

  // Headline text + a little nearby visible text (a dek/summary), capped hard.
  function collectContext(el) {
    let text = cleanText(el.textContent);
    const container = el.closest('article, section, li') || el.parentElement;
    if (container) {
      const extras = [];
      const near = container.querySelectorAll('p, h4, [class*="summary"], [class*="dek"], [class*="teaser"], [class*="standfirst"]');
      for (const n of near) {
        if (extras.length >= 2) break;
        if (n === el || el.contains(n) || n.contains(el)) continue;
        const t = cleanText(n.textContent);
        if (t.length > 20 && t.length < 400) extras.push(t);
      }
      if (extras.length) text += '\n\n' + extras.join('\n\n');
    }
    return text.slice(0, MAX_INPUT_CHARS);
  }

  // The same-origin article URL behind a headline, or null. Origin = scheme+host+port,
  // so a link to another domain — or a www/apex or http/https variant — is cross-origin
  // and NOT fetchable from a content script; we return null and fall back to page text.
  // Also require a hyphenated ("slug-like") path so we follow article links, not
  // arbitrary same-origin endpoints (/account, /settings, …).
  function sameOriginArticleHref(el) {
    let a = null;
    if (el.tagName === 'A') a = el;
    else a = el.querySelector('a[href]') || el.closest('a[href]');
    if (!a) return null;
    const raw = a.getAttribute('href');
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) return null;
    let url;
    try { url = new URL(a.href, location.href); } catch (e) { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;
    if (url.origin !== location.origin) return null;         // cross-origin: cannot fetch
    if (url.pathname === location.pathname) return null;     // same page: nothing new to read
    if (url.pathname.split('/').filter(Boolean).length < 1) return null; // bare origin/section
    if (!/[a-z0-9]-[a-z0-9]/i.test(url.pathname)) return null; // require an article-like slug
    return url.href;
  }

  // Fetch a same-origin article and extract its body text via the shared parseHtml
  // (parser.js, injected alongside this file). Credential-less so no authenticated or
  // personalized content is read/forwarded and no credentialed side-effect can fire.
  // Any failure (CORS, network, timeout, parser missing) resolves to '' so the caller
  // falls back to visible text.
  async function fetchArticleText(href) {
    try {
      if (typeof parseHtml !== 'function') return '';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(href, { credentials: 'omit', redirect: 'follow', signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return '';
      const ct = res.headers.get('content-type') || '';
      if (ct && !/html/i.test(ct)) return '';
      const html = await res.text();
      const parsed = parseHtml(html);
      return (parsed && parsed.text) ? parsed.text : '';
    } catch (e) {
      return '';
    }
  }

  // Build the context sent to the model: prefer the fetched article body (proper
  // de-clickbait), else the visible headline + nearby text. Memoized per element.
  async function buildRequestContext(el, headline) {
    if (ctxCache.has(el)) return ctxCache.get(el);
    let context = collectContext(el);
    const href = sameOriginArticleHref(el);
    if (href) {
      const body = await fetchArticleText(href);
      if (body && body.length > 200) {
        context = (headline + '\n\n' + body).slice(0, MAX_FETCH_CHARS);
      }
    }
    ctxCache.set(el, context);
    return context;
  }

  // Where to write the new headline. For a heading that wraps a single link whose
  // text IS the headline, target that <a> so we don't destroy the link; otherwise
  // the element itself.
  function textTarget(el) {
    if (el.tagName === 'A') return el;
    const links = el.querySelectorAll('a');
    if (links.length === 1 && cleanText(links[0].textContent) === cleanText(el.textContent)) {
      return links[0];
    }
    return el;
  }

  // --- Per-headline toggle button (self-contained) ---------------------------
  function makeToggle() {
    const btn = document.createElement('button');
    btn.className = 'unbait-toggle';
    btn.textContent = '🎣';
    btn.title = 'Toggle original headline (unb8)';
    Object.assign(btn.style, {
      zIndex: '2147483647',
      background: 'white',
      border: '1px solid #ccc',
      borderRadius: '50%',
      width: '22px',
      height: '22px',
      cursor: 'pointer',
      fontSize: '13px',
      lineHeight: '20px',
      padding: '0',
      marginLeft: '6px',
      verticalAlign: 'middle',
      boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
    });
    return btn;
  }

  // Write the new headline while PRESERVING non-text children (thumbnails, live/
  // timestamp badges, icons) instead of nuking the whole subtree. Drills to the
  // element that actually owns the headline text and rewrites only its text nodes.
  function replaceHeadlineText(node, newTitle) {
    const fullLen = cleanText(node.textContent).length;
    const directText = Array.from(node.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim().length > 0);
    const directLen = directText.reduce((s, n) => s + n.nodeValue.trim().length, 0);

    // No element children — plain text host, replace it outright.
    if (node.children.length === 0) { node.textContent = newTitle; return; }

    // This node's own direct text carries (almost) the whole headline; the element
    // children are non-text extras (img/badge) — replace the text, keep them.
    if (directText.length > 0 && directLen >= fullLen - 2) {
      directText[0].nodeValue = newTitle;
      for (let i = 1; i < directText.length; i++) directText[i].nodeValue = '';
      return;
    }

    // Headline text lives in a dominant child element — recurse into it, leaving
    // its siblings (timestamps, kickers, images) alone.
    let richest = null, richestLen = 0;
    for (const c of node.children) {
      const l = cleanText(c.textContent).length;
      if (l > richestLen) { richestLen = l; richest = c; }
    }
    if (richest && richestLen >= fullLen * 0.6) { replaceHeadlineText(richest, newTitle); return; }

    // Ambiguous split — rewrite the longest direct text node (or the richest child)
    // rather than wiping the whole subtree.
    if (directText.length > 0) {
      let longest = directText[0];
      for (const n of directText) if (n.nodeValue.trim().length > longest.nodeValue.trim().length) longest = n;
      longest.nodeValue = newTitle;
    } else if (richest) {
      replaceHeadlineText(richest, newTitle);
    } else {
      node.textContent = newTitle;
    }
  }

  function applyTitle(el, newTitle) {
    const target = textTarget(el);
    const originalHTML = target.innerHTML;
    replaceHeadlineText(target, newTitle);
    const aiHTML = target.innerHTML;               // AI-state snapshot (before the button)
    const state = { target, originalHTML, aiHTML, aiTitle: newTitle, showingAi: true };
    applied.set(el, state);

    // Toggle swaps the whole subtree between the original and AI snapshots, so both
    // states keep their images/badges; the button is re-appended after each swap
    // (an innerHTML restore removes it) — it lives in this closure, not the snapshots.
    const btn = makeToggle();
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.showingAi = !state.showingAi;
      state.target.innerHTML = state.showingAi ? state.aiHTML : state.originalHTML;
      btn.style.filter = state.showingAi ? 'none' : 'grayscale(100%)';
      btn.style.opacity = state.showingAi ? '1' : '0.5';
      state.target.appendChild(btn);
    });
    target.appendChild(btn);
    updateWidget();
  }

  // --- On-page status widget (persists after the popup closes) ---------------
  let widgetEl = null, widgetTitleEl = null, widgetCountEl = null, widgetBtn = null;

  function ensureWidget() {
    if (widgetEl && document.documentElement.contains(widgetEl)) return;
    widgetEl = document.createElement('div');
    widgetEl.dataset.unbaitSkip = '1';
    Object.assign(widgetEl.style, {
      position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
      background: '#ffffff', color: '#1f2937', border: '1px solid #d0d5dd',
      borderRadius: '10px', boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      padding: '10px 12px', maxWidth: '280px',
      font: '13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
      display: 'flex', alignItems: 'center', gap: '10px'
    });

    const textWrap = document.createElement('div');
    textWrap.style.lineHeight = '1.35';
    widgetTitleEl = document.createElement('div');
    widgetTitleEl.innerHTML = '🎣 <b>unb8</b> · cleaning this page';
    widgetCountEl = document.createElement('div');
    widgetCountEl.style.color = '#667085';
    widgetCountEl.style.fontSize = '12px';
    textWrap.appendChild(widgetTitleEl);
    textWrap.appendChild(widgetCountEl);

    widgetBtn = document.createElement('button');
    widgetBtn.textContent = 'Stop';
    Object.assign(widgetBtn.style, {
      background: '#f2f4f7', color: '#b42318', border: '1px solid #d0d5dd',
      borderRadius: '6px', padding: '4px 10px', cursor: 'pointer',
      font: '600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      flexShrink: '0'
    });
    widgetBtn.addEventListener('click', () => stopCleaning(true));

    widgetEl.appendChild(textWrap);
    widgetEl.appendChild(widgetBtn);
    document.documentElement.appendChild(widgetEl);
    updateWidget();
  }

  function updateWidget() {
    if (!widgetCountEl) return;
    const done = applied.size;
    if (finalReason) {
      const verb = finalReason === 'stopped' ? 'Stopped' : 'Done';
      widgetCountEl.textContent = `${verb} — ${done} headline${done === 1 ? '' : 's'} cleaned.`;
    } else {
      const prog = inFlight > 0 ? ` · ${inFlight} in progress` : '';
      widgetCountEl.textContent = `${done} cleaned${prog} · keep scrolling for more`;
    }
  }

  function finalize(reason) {
    if (stopped) return;
    stopped = true;
    finalReason = reason;
    if (io) io.disconnect();
    if (mo) mo.disconnect();
    if (widgetTitleEl) {
      widgetTitleEl.innerHTML = reason === 'stopped' ? '🎣 <b>unb8</b> · stopped' : '🎣 <b>unb8</b> · done';
    }
    updateWidget();
    if (widgetBtn) {
      widgetBtn.textContent = 'Close';
      widgetBtn.style.color = '#1f2937';
      const fresh = widgetBtn.cloneNode(true); // drop the Stop listener
      widgetBtn.replaceWith(fresh);
      widgetBtn = fresh;
      widgetBtn.addEventListener('click', removeWidget);
    }
  }

  function removeWidget() {
    if (widgetEl) { widgetEl.remove(); }
    widgetEl = widgetTitleEl = widgetCountEl = widgetBtn = null;
  }

  // User Stop drops in-flight results too (aborted); a cap-reached finish still lets the
  // already-dispatched calls land.
  function stopCleaning(userInitiated) {
    if (userInitiated) aborted = true;
    finalize(userInitiated ? 'stopped' : 'done');
  }

  // --- Dispatch --------------------------------------------------------------
  async function process(el, retries) {
    if (stopped) return;
    if (dispatched >= MAX_PER_PAGE) { finishIfCapReached(); return; }
    if (el.dataset.unbaitUniversal === '1') return;

    const headline = cleanText(el.textContent);
    if (headline.length < MIN_LEN) return;

    const gen = generation;           // tie this run's counters to the current injection
    el.dataset.unbaitUniversal = '1'; // claim it before the async work
    dispatched++;
    inFlight++;
    updateWidget();

    const context = await buildRequestContext(el, headline);
    if (gen !== generation) return;   // a re-injection reset the counters — abandon this stale run
    if (stopped) { inFlight = Math.max(0, inFlight - 1); return; }

    const key = 'universal://' + location.host + location.pathname + '#' +
      hashString(headline + ' ' + context);

    try {
      chrome.runtime.sendMessage(
        { action: 'generateTitle', source: 'universal', headline, text: context, url: key },
        (response) => {
          if (gen !== generation) return; // stale run (re-injected): don't touch the new run's counters
          inFlight = Math.max(0, inFlight - 1);
          if (aborted) return; // user pressed Stop — leave the page and widget alone
          if (chrome.runtime.lastError) {
            console.log('unb8: universal message failed', chrome.runtime.lastError.message);
            updateWidget();
            return;
          }
          if (response && response.throttled) {
            // The worker's per-minute cap kicked in — this didn't cost an LLM call.
            // Give the slot back and retry the element shortly (bounded, only while
            // running). The fetched context is memoized, so no re-fetch on retry.
            dispatched = Math.max(0, dispatched - 1);
            const n = (retries || 0) + 1;
            if (n <= MAX_THROTTLE_RETRIES && !stopped) {
              delete el.dataset.unbaitUniversal;
              setTimeout(() => process(el, n), 4000 + n * 1000);
            }
            updateWidget();
            return;
          }
          if (response && response.success && response.title) {
            if (cleanText(response.title) !== cleanText(el.textContent)) {
              applyTitle(el, response.title); // calls updateWidget()
            } else {
              updateWidget();
            }
          } else {
            if (response && response.error) console.log('unb8: universal title failed —', response.error);
            updateWidget();
          }
        }
      );
    } catch (e) {
      // sendMessage can throw synchronously (e.g. "Extension context invalidated" after a
      // reload/update while the page stays open) — the callback then never fires, so
      // release the in-flight slot here instead of leaking it.
      inFlight = Math.max(0, inFlight - 1);
      updateWidget();
      return;
    }
    finishIfCapReached(); // a throttle-retry can push dispatched to the cap outside an IO batch
  }

  // --- Lazy dispatch via IntersectionObserver --------------------------------
  function buildObserver() {
    if (io) io.disconnect();
    io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        io.unobserve(el); // one-shot per element
        process(el, 0);
      }
      finishIfCapReached();
    }, { rootMargin: IO_ROOT_MARGIN });
  }

  function observe(el) {
    if (stopped || observedEls.has(el)) return;
    if (observedEls.size >= MAX_OBSERVED) {
      if (!observedCapped) {
        observedCapped = true;
        console.log(`unb8: universal watch cap (${MAX_OBSERVED}) reached — not all headlines will be scanned`);
      }
      return;
    }
    observedEls.add(el);
    io.observe(el);
  }

  function scan() {
    if (stopped) return;
    for (const el of collectCandidates()) {
      if (observedEls.size >= MAX_OBSERVED) break;
      if (isCandidate(el)) observe(el);
    }
  }

  function finishIfCapReached() {
    if (dispatched >= MAX_PER_PAGE && !stopped) {
      finalize('done');
      console.log(`unb8: universal per-page cap (${MAX_PER_PAGE}) reached — stopping new headlines`);
    }
  }

  // Re-scan on DOM changes (infinite scroll / hydration), debounced like content.js.
  function startObserver() {
    if (mo) mo.disconnect();
    mo = new MutationObserver((mutations) => {
      if (stopped) return;
      if (mutations.some(m => m.addedNodes.length > 0)) {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, 400);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function start() {
    // Reset per-injection state so a deliberate re-click ("Clean this page" again)
    // resumes cleanly and can process more; already-cleaned headlines stay skipped via
    // their dataset flag, and the background worker's 15/min limit bounds total cost.
    // Bumping the generation neutralizes the previous injection's in-flight callbacks
    // (they check gen !== generation and bail) so they can't corrupt the new run's counters.
    generation++;
    stopped = false;
    aborted = false;
    finalReason = null;
    dispatched = 0;
    inFlight = 0;
    observedCapped = false;
    observedEls.clear();
    removeWidget();   // drop any finalized ("Done/Stopped") widget so we show a fresh running one
    ensureWidget();
    buildObserver();
    startObserver();
    scan();
  }

  window.__unb8Universal = { restart: start, stop: () => stopCleaning(true) };

  console.log('unb8: universal mode active on', location.hostname);
  start();
})();
