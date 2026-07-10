// unb8 service worker: caching, article fetching, OpenRouter calls with free-model fallback.

// Curated free models, in preferred order (hand-picked for Danish quality, verified
// against /api/v1/models July 2026). Used as the head of the auto chain and as the
// fallback whenever live discovery (getFreeModelChain) is unavailable.
const FREE_MODEL_CHAIN = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free'
];

// OpenRouter rotates its free models, so once a day we fetch the live catalogue and
// rebuild the auto chain (see getFreeModelChain) so it never goes stale.
const FREE_MODELS_CACHE_KEY = 'unbait_free_models_v1';
const FREE_MODELS_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

// Per-model price map (USD per token), cached from the same daily /models fetch as the
// free chain. Used to ESTIMATE paid-model spend: OpenRouter's inline usage.cost is
// unreliable for some paid providers (it frequently comes back 0, so 270k paid tokens
// could read as "$0.0000"), so we compute cost from token counts × catalogue price
// instead. Not prefixed unbait_cache_/rewrite_, so pruneCache leaves it alone.
const MODEL_PRICING_CACHE_KEY = 'unbait_model_pricing_v1';
const MODEL_PRICING_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

const CACHE_PREFIX_TITLE = 'unbait_cache_v2_';
const CACHE_PREFIX_REWRITE = 'unbait_rewrite_v1_';
const CACHE_TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// Lifetime token counter (experimental universal mode + all other model calls).
// Deliberately NOT prefixed unbait_cache_ / unbait_rewrite_, so pruneCache and the
// popup's Clear-Cache never touch it — it counts up forever.
const USAGE_KEY = 'unbait_usage_v1';

// Per-minute request cap for experimental universal mode (in-memory: resets if the
// service worker sleeps — acceptable for an experiment). The free-model fallback
// chain can make several HTTP attempts per logical request, so this is kept below
// OpenRouter's free-tier limit with headroom for that multiplier.
const UNIVERSAL_MAX_REQ_PER_MIN = 15;
let rlWindowStart = 0;
let rlCount = 0;
function allowUniversalRequest() {
  const now = Date.now();
  if (now - rlWindowStart >= 60000) { rlWindowStart = now; rlCount = 0; }
  if (rlCount >= UNIVERSAL_MAX_REQ_PER_MIN) return false;
  rlCount++;
  return true;
}

// Setup offscreen document for HTML parsing. The creation promise is cached so
// concurrent callers don't race createDocument ("Only a single offscreen document
// may be created") — awaiting it also guarantees the document's message listener
// is registered before anyone sends parse-html.
let creatingOffscreen = null;
async function setupOffscreenDocument(path) {
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Parse article HTML to extract text for AI processing',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

// Open onboarding page on installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'onboarding.html' });
  }
  pruneCache();
  // Stamp the token counter's "since" on first install so the popup can show it.
  chrome.storage.local.get(USAGE_KEY, (r) => {
    if (!r[USAGE_KEY]) {
      chrome.storage.local.set({
        [USAGE_KEY]: { total: 0, prompt: 0, completion: 0, calls: 0, cost: 0, freeTotal: 0, paidTotal: 0, since: Date.now() }
      });
    }
  });
  // One-time migration: v1.2.6 shipped the "newest Gemini Flash" picker option with
  // OpenRouter's catalogue alias id ('~'-prefixed), which 404s at the completions
  // endpoint. v1.2.7 fixed the option value but not already-saved settings — every
  // request for those users still burns a doomed attempt before falling back.
  chrome.storage.local.get('selectedModel', (r) => {
    if (r.selectedModel === '~google/gemini-flash-latest') {
      chrome.storage.local.set({ selectedModel: 'google/gemini-flash-latest' });
    }
  });
});

// --- Missing-key toolbar badge -----------------------------------------------
// Without a key the extension fails silently (every request errors, content.js only
// console.logs), so surface the one mandatory setup step on the toolbar icon itself.
// Top-level call runs on every worker/event-page start-up; the storage listener keeps
// it live while the popup edits the key (saved per keystroke).
function updateKeyBadge() {
  chrome.storage.local.get('openRouterApiKey', (r) => {
    const hasKey = !!(r.openRouterApiKey && String(r.openRouterApiKey).trim());
    chrome.action.setBadgeText({ text: hasKey ? '' : '!' });
    chrome.action.setTitle({ title: hasKey ? 'unb8 Settings' : 'unb8 — add your OpenRouter API key to activate' });
    if (!hasKey) chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  });
}
updateKeyBadge();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.openRouterApiKey) updateKeyBadge();
});

// --- Lifetime token counter -------------------------------------------------
// Accumulate OpenRouter usage across every model call. Concurrent completions all
// read-modify-write the same storage key, so serialize through a promise chain
// (mirrors the creatingOffscreen pattern) — otherwise interleaved async writes lose
// updates. Every field is null-guarded so a missing usage can't NaN-poison the total.
let usageWriteChain = Promise.resolve();
function recordUsage(usage, isFree, model) {
  if (!usage) return usageWriteChain;
  // Look up the model price up front (async, but cached) so a first-time pricing fetch
  // runs concurrently with any queued writes instead of stalling the chain.
  const pricePromise = isFree ? Promise.resolve(null) : getModelPricing(model);
  usageWriteChain = usageWriteChain
    .then(async () => addUsage(usage, isFree, await pricePromise))
    .catch((e) => { console.warn('unb8: usage record failed', e); });
  return usageWriteChain;
}
// `isFree` splits the token total into free- vs paid-model buckets so the popup can show
// them separately. `price` is the paid model's {prompt, completion} USD-per-token rate
// (null for free models / a lookup miss). Paid cost is ESTIMATED from tokens × price
// because OpenRouter's inline usage.cost is unreliable (often 0); the popup shows it with
// a leading ~ to mark it an estimate.
async function addUsage(usage, isFree, price) {
  const cur = (await chrome.storage.local.get(USAGE_KEY))[USAGE_KEY] || {};
  const promptTok = usage.prompt_tokens || 0;
  const completionTok = usage.completion_tokens || 0;
  const totalTok = usage.total_tokens || (promptTok + completionTok);
  // One-time migration: pre-split installs only had a combined `total`. Attribute it to
  // the free bucket (historically almost all usage was the free chain) so the popup's
  // free counter stays continuous instead of resetting to 0 on the first post-update call.
  let curFree = cur.freeTotal, curPaid = cur.paidTotal;
  if (curFree == null && curPaid == null) { curFree = cur.total || 0; curPaid = 0; }
  else { curFree = curFree || 0; curPaid = curPaid || 0; }

  // This call's paid cost, estimated from tokens × catalogue price. Free calls are $0.
  // If the pricing lookup failed, fall back to OpenRouter's inline cost (better than 0).
  let addCost = 0;
  if (!isFree) {
    if (price) addCost = promptTok * price.prompt + completionTok * price.completion;
    else if (typeof usage.cost === 'number') addCost = usage.cost;
  }

  // One-time backfill: installs from before token-based estimation counted paid tokens
  // but ~zero cost (they trusted OpenRouter's unreliable inline usage.cost). Estimate that
  // history now from the paid tokens already counted × this model's price, split by the
  // prompt:completion ratio observed overall. Only REPLACE the stored cost when it's the
  // ~zero the old bug produced — if an install somehow already has a real accumulated cost,
  // keep it. Best-effort, shown with ~; runs once.
  let baseCost = cur.cost || 0;
  let costBackfilled = cur.costBackfilled || false;
  if (!isFree && price && !costBackfilled) {
    if (curPaid > 0 && baseCost < 0.005) {
      const totalSeen = (cur.total || 0) || (curFree + curPaid) || 1;
      const pFrac = (cur.prompt || 0) / totalSeen;
      const cFrac = (cur.completion || 0) / totalSeen;
      baseCost = curPaid * (pFrac * price.prompt + cFrac * price.completion);
    }
    costBackfilled = true;
  }

  await chrome.storage.local.set({
    [USAGE_KEY]: {
      total: (cur.total || 0) + totalTok,
      prompt: (cur.prompt || 0) + promptTok,
      completion: (cur.completion || 0) + completionTok,
      calls: (cur.calls || 0) + 1,
      cost: baseCost + addCost,
      costBackfilled: costBackfilled,
      freeTotal: curFree + (isFree ? totalTok : 0),
      paidTotal: curPaid + (isFree ? 0 : totalTok),
      since: cur.since || Date.now()
    }
  });
}

chrome.runtime.onStartup.addListener(pruneCache);

// Drop cache entries older than the TTL, plus entries from the old (pre-v2) format.
async function pruneCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const toRemove = [];
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith('unbait_cache_') || key.startsWith('unbait_rewrite_')) {
        const isCurrent = key.startsWith(CACHE_PREFIX_TITLE) || key.startsWith(CACHE_PREFIX_REWRITE);
        if (!isCurrent || !value || typeof value !== 'object' || !value.ts || (now - value.ts) > CACHE_TTL_MS) {
          toRemove.push(key);
        }
      }
    }
    if (toRemove.length) {
      await chrome.storage.local.remove(toRemove);
      console.log(`unb8: pruned ${toRemove.length} cache entries`);
    }
  } catch (e) {
    console.warn('unb8: cache prune failed', e);
  }
}

// Read a cache entry, enforcing the TTL (pruneCache only runs at browser startup,
// so long-lived sessions must expire entries on read too).
async function getCached(cacheKey) {
  const cached = await chrome.storage.local.get(cacheKey);
  const entry = cached[cacheKey];
  if (!entry || !entry.title) return null;
  if (!entry.ts || (Date.now() - entry.ts) > CACHE_TTL_MS) {
    chrome.storage.local.remove(cacheKey).catch(() => {});
    return null;
  }
  return entry;
}

// Cache write that never fails the request (e.g. storage quota exceeded).
async function setCached(cacheKey, value) {
  try {
    await chrome.storage.local.set({ [cacheKey]: value });
  } catch (e) {
    console.warn('unb8: cache write failed', e);
  }
}

// De-duplicate concurrent requests for the same URL (the same article often
// appears in several teasers on one page).
const pendingTitleRequests = new Map();
const pendingRewriteRequests = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target === 'offscreen') return; // offscreen.js handles these

  // Popup's Test Connection: run a tiny prompt through the SAME chain real requests
  // use (selected model first, live free chain, reasoning-off retry), so the result
  // reflects what headline generation will actually do — a hardcoded test model would
  // report failure whenever that one model is rotated out or rate-limited even though
  // the extension still works. Usage is recorded by tryModel as usual.
  if (request.action === 'testConnection') {
    handleTestConnection().then(sendResponse);
    return true;
  }

  if (request.action === 'generateTitle') {
    let pending = pendingTitleRequests.get(request.url);
    if (!pending) {
      pending = handleGenerateTitle(request.url, request.text, request.source, request.headline)
        .finally(() => pendingTitleRequests.delete(request.url));
      pendingTitleRequests.set(request.url, pending);
    }
    pending.then(sendResponse);
    return true; // Keep message channel open for async response
  }

  if (request.action === 'rewriteArticle') {
    let pending = pendingRewriteRequests.get(request.url);
    if (!pending) {
      pending = handleRewriteArticle(request.url, request.title, request.text)
        .finally(() => pendingRewriteRequests.delete(request.url));
      pendingRewriteRequests.set(request.url, pending);
    }
    pending.then(sendResponse);
    return true;
  }
});

// Test the user's setup end-to-end. A cheap GET /key first (free, immune to model
// rate limits) so a bad key is reported crisply; then a minimal completion through
// callOpenRouterWithFallback so the verdict matches real headline generation.
async function handleTestConnection() {
  const { openRouterApiKey } = await chrome.storage.local.get('openRouterApiKey');
  if (!openRouterApiKey) {
    return { success: false, error: 'No API key configured' };
  }
  // keyValid is only claimed when the probe actually CONFIRMED the key (2xx) — a
  // timed-out/5xx probe must not later mislabel a fatal 401 as "key is valid".
  let keyConfirmed = false;
  try {
    const keyRes = await fetchWithTimeout('https://openrouter.ai/api/v1/key', 15000, {
      headers: { 'Authorization': `Bearer ${openRouterApiKey}` }
    });
    if (keyRes.status === 401 || keyRes.status === 403) {
      return { success: false, error: 'Invalid API key' };
    }
    keyConfirmed = keyRes.ok;
  } catch (e) { /* network hiccup — let the completion test below surface it */ }
  const result = await callOpenRouterWithFallback('Reply with the single word: OK', { maxTokensFree: 500, maxTokensPaid: 50 });
  if (result.success) {
    return { success: true, model: result.model };
  }
  const authFailed = /HTTP 401/.test(result.error || '');
  if (authFailed) {
    return { success: false, error: 'Invalid API key' };
  }
  return { success: false, keyValid: keyConfirmed, error: result.error };
}

async function handleGenerateTitle(url, providedText, source, headline) {
  try {
    const settings = await chrome.storage.local.get(['extensionEnabled']);
    // Universal mode is a manual, explicit one-shot action, so it runs even when the
    // automatic tuned-site rewriting is toggled off.
    if (settings.extensionEnabled === false && source !== 'universal') {
      return { success: false, error: 'Extension is disabled' };
    }

    // 1. Check Cache (identical keys mean an already-cleaned headline is free to reuse)
    const cacheKey = CACHE_PREFIX_TITLE + url;
    const cachedTitle = await getCached(cacheKey);
    if (cachedTitle) {
      return { success: true, title: cachedTitle.title, cached: true };
    }

    // 1b. Universal (experimental): visible-text-only, NEVER fetch. A cache miss here
    // goes straight to the model from the page text the content side already read
    // (fetching the synthetic 'universal://' key would hit a bogus URL). Rate-limited
    // in-memory; a cache hit above is free and never throttled.
    if (source === 'universal') {
      if (!allowUniversalRequest()) {
        // Tell the page how long the closed rate window has left, so its retry can
        // be scheduled AFTER the window reopens instead of burning retries inside it.
        return { success: false, throttled: true, retryAfterMs: Math.max(1000, 60000 - (Date.now() - rlWindowStart)) };
      }
      const prompt = buildUniversalHeadlinePrompt(headline || '', providedText || '');
      const apiResult = await callOpenRouterWithFallback(prompt, { maxTokensFree: 1000, maxTokensPaid: 100 });
      if (apiResult.success) {
        const title = cleanHeadline(apiResult.content);
        if (!title) return { success: false, error: 'Model returned an empty headline' };
        await setCached(cacheKey, { title, ts: Date.now() });
        return { success: true, title, model: apiResult.model };
      }
      return { success: false, error: apiResult.error || 'AI generation failed' };
    }

    // 2. Get article text: either provided by the content script (article pages,
    // already rendered) or by fetching + parsing the article HTML.
    let text = (providedText && providedText.length >= 100) ? providedText : null;
    if (!text) {
      const response = await fetchWithTimeout(url, 20000);
      if (!response.ok) {
        return { success: false, error: `Article fetch failed: HTTP ${response.status}` };
      }
      const html = response.body;

      // 3. Parse HTML (inline on Firefox, via offscreen on Chrome)
      const parseResult = await parseArticleHtml(html);
      text = parseResult.text;

      if (!text || text.length < 100) {
        console.warn('unb8: Insufficient text extracted.', {
          url,
          textLength: text ? text.length : 0,
          debug: parseResult.debug
        });
        return { success: false, error: `Could not extract sufficient text (found ${text ? text.length : 0} chars). Selector: ${parseResult.debug?.foundSelector}` };
      }
    }

    // 4. Call OpenRouter API
    const prompt = buildHeadlinePrompt(text);
    const apiResult = await callOpenRouterWithFallback(prompt, { maxTokensFree: 1000, maxTokensPaid: 100 });

    // 5. Cache Result
    if (apiResult.success) {
      const title = cleanHeadline(apiResult.content);
      if (!title) {
        return { success: false, error: 'Model returned an empty headline' };
      }
      await setCached(cacheKey, { title, ts: Date.now() });
      console.log(`unb8: headline via ${apiResult.model} for ${url}`);
      return { success: true, title, model: apiResult.model };
    }
    return { success: false, error: apiResult.error || 'AI generation failed' };

  } catch (error) {
    console.error('Error processing URL:', url, error);
    return { success: false, error: error.message };
  }
}

async function handleRewriteArticle(url, originalTitle, articleText) {
  try {
    const settings = await chrome.storage.local.get(['extensionEnabled', 'rewriteArticles']);
    if (settings.extensionEnabled === false) {
      return { success: false, error: 'Extension is disabled' };
    }
    if (settings.rewriteArticles !== true) {
      return { success: false, error: 'Article rewriting is disabled' };
    }
    if (!articleText || articleText.length < 200) {
      return { success: false, error: `Article text too short to rewrite (${articleText ? articleText.length : 0} chars)` };
    }

    const cacheKey = CACHE_PREFIX_REWRITE + url;
    const cachedRewrite = await getCached(cacheKey);
    if (cachedRewrite) {
      return { success: true, ...cachedRewrite, cached: true };
    }

    const prompt = buildRewritePrompt(originalTitle, articleText);
    const apiResult = await callOpenRouterWithFallback(prompt, { maxTokensFree: 4000, maxTokensPaid: 1500 });
    if (!apiResult.success) {
      return { success: false, error: apiResult.error || 'AI rewrite failed' };
    }

    const parsed = parseRewriteOutput(apiResult.content);
    if (!parsed) {
      return { success: false, error: 'Could not parse rewrite output' };
    }

    const result = { title: parsed.title, paragraphs: parsed.paragraphs, ts: Date.now() };
    await setCached(cacheKey, result);
    console.log(`unb8: rewrite via ${apiResult.model} for ${url}`);
    return { success: true, ...result, model: apiResult.model };

  } catch (error) {
    console.error('Error rewriting article:', url, error);
    return { success: false, error: error.message };
  }
}

function buildHeadlinePrompt(articleText) {
  return `You are a helpful assistant that rewrites clickbait headlines.
Read the following article text and generate a single, factual, non-clickbait headline in Danish.
The headline should be descriptive and summarize the main point of the article.
Do not use "Breaking", "Chok", "Afsløring" or similar sensationalist words.
Write in natural, correct Danish and always keep the Danish letters æ, ø and å — never transliterate them to a, o, ae, oe or aa (e.g. write "23-årig", never "23-arig").
Keep it under 100 characters if possible.
ONLY output the headline, nothing else.

Article Text:
${articleText}`;
}

function buildRewritePrompt(originalTitle, articleText) {
  return `You rewrite Danish news articles to remove clickbait and filler.
Rewrite the article below in Danish following these rules:
- First line: a factual, non-sensationalist headline (under 100 characters). No "Breaking", "Chok", "Afsløring" or similar words.
- Then a blank line.
- Then a condensed version of the article: keep every key fact, number, name, date and quote, but remove repetition, teaser phrases and filler.
- Use short paragraphs separated by blank lines.
- Write in natural, correct Danish and always keep the Danish letters æ, ø and å — never transliterate them to a, o, ae, oe or aa (e.g. write "23-årig", never "23-arig").
- Do not add information that is not in the article.
- Plain text only: no markdown, no bullet points, no headings, no commentary.

Original headline: ${originalTitle}

Article text:
${articleText}`;
}

// Universal mode runs on any site in any language, so — unlike buildHeadlinePrompt
// (Danish-hardcoded) — this mirrors the source language and adds nothing not already
// on the page (it never fetches the article).
function buildUniversalHeadlinePrompt(headline, context) {
  return `You rewrite clickbait headlines into factual, non-sensational ones.
Rewrite the headline below in the SAME language as the original.
Remove clickbait, sensationalism, curiosity gaps and teaser phrasing; state the actual point plainly.
Use ONLY information contained in the headline and the provided context — invent nothing, add no facts.
If the headline is already factual and non-sensational, return it essentially unchanged.
Keep the original language's letters and diacritics exactly (do not transliterate).
Keep it concise, ideally under 100 characters.
ONLY output the rewritten headline, nothing else.

Headline:
${headline}

Context (may be empty):
${context}`;
}

function cleanHeadline(raw) {
  if (!raw) return '';
  // Models wrap output in markdown, quotes or labels despite instructions.
  let title = raw.trim().split('\n')[0].trim();
  title = title.replace(/^#{1,6}\s*/, '');                          // markdown heading
  title = title.replace(/^[*_`]+|[*_`]+$/g, '').trim();             // markdown emphasis
  title = title.replace(/^(overskrift|headline)\s*[:\-]\s*/i, '');  // label prefix
  title = title.replace(/^[*_`]+|[*_`]+$/g, '').trim();             // emphasis inside label
  // Strip wrapping quotes, incl. curly and Danish low-9 styles (U+2018–U+201F)
  title = title.replace(/^["'«»‘-‟]+|["'«»‘-‟]+$/g, '').trim();
  return title;
}

function parseRewriteOutput(raw) {
  if (!raw) return null;
  const text = raw.trim();
  const lines = text.split('\n');
  const title = cleanHeadline(lines[0]);
  const rest = lines.slice(1).join('\n').trim();
  const paragraphs = rest
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 0);
  if (!title || paragraphs.length === 0) return null;
  return { title, paragraphs };
}

// Pick the parse strategy by capability. Firefox's MV3 background is an event
// page (a DOM document) that has DOMParser, so parseHtml (from parser.js, loaded
// via background.scripts) runs inline. Chrome's service worker has no DOMParser,
// so it delegates to the offscreen document. chrome.offscreen is touched only on
// the Chrome branch, so Firefox — where it's undefined — never reaches it.
async function parseArticleHtml(html) {
  if (typeof DOMParser !== 'undefined') return parseHtml(html); // Firefox event page
  return parseHtmlInOffscreen(html);                            // Chrome service worker
}

async function parseHtmlInOffscreen(html) {
  await setupOffscreenDocument('offscreen.html');
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'parse-html',
      target: 'offscreen',
      data: html
    }, (response) => {
      if (chrome.runtime.lastError || !response || response.text === undefined) {
        resolve({ text: '', debug: { error: chrome.runtime.lastError?.message || 'No response from offscreen' } });
      } else {
        resolve(response);
      }
    });
  });
}

// Fetch with a timeout that covers reading the full body, not just the headers —
// a stalled body would otherwise hang the request (and its dedupe-map entry) forever.
async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Live free-model discovery ---------------------------------------------
// OpenRouter rotates its free models, so a hard-coded chain goes stale. Once a day
// we pull the live catalogue (GET /api/v1/models — public, CORS-open, no key or host
// permission needed) and rebuild the auto chain: curated models that are still
// offered (kept first, for Danish quality), then other currently-free TEXT models by
// descending context length. Cached in storage; any failure falls back to the curated
// list so a bad network never blocks title generation.
let freeChainPromise = null;

async function getFreeModelChain() {
  try {
    const cached = (await chrome.storage.local.get(FREE_MODELS_CACHE_KEY))[FREE_MODELS_CACHE_KEY];
    if (cached && cached.ts && (Date.now() - cached.ts) < FREE_MODELS_TTL_MS &&
        Array.isArray(cached.models) && cached.models.length) {
      return cached.models;
    }
  } catch (e) { /* fall through to a live refresh */ }
  // A news page fires many teasers at once — share one in-flight refresh between them.
  if (!freeChainPromise) {
    freeChainPromise = refreshFreeModelChain().finally(() => { freeChainPromise = null; });
  }
  return freeChainPromise;
}

async function refreshFreeModelChain() {
  try {
    const catalogue = await fetchModelCatalogue();
    // Fill the price cache from the same fetch so paid-cost estimation stays warm.
    await setCached(MODEL_PRICING_CACHE_KEY, { ts: Date.now(), prices: buildPricingMap(catalogue) });
    const live = filterFreeModels(catalogue);                     // [{ id, context_length }, ...]
    const liveIds = new Set(live.map(m => m.id));
    const curated = FREE_MODEL_CHAIN.filter(id => liveIds.has(id));
    const extras = live
      .filter(m => !FREE_MODEL_CHAIN.includes(m.id))
      .filter(m => !/coder/i.test(m.id))                          // skip code-specialist models (poor Danish prose)
      .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
      .slice(0, 6)
      .map(m => m.id);
    const chain = [...curated, ...extras];
    const finalChain = chain.length ? chain : FREE_MODEL_CHAIN;
    await setCached(FREE_MODELS_CACHE_KEY, { ts: Date.now(), models: finalChain });
    console.log(`unb8: free-model chain refreshed (${finalChain.length}) — ${finalChain.join(', ')}`);
    return finalChain;
  } catch (e) {
    console.warn('unb8: free-model discovery failed, using curated list —', e.message);
    return FREE_MODEL_CHAIN;
  }
}

// Fetch OpenRouter's full model catalogue (public, CORS-open, no key or host permission).
async function fetchModelCatalogue() {
  const res = await fetchWithTimeout('https://openrouter.ai/api/v1/models', 15000);
  if (!res.ok) throw new Error(`models list HTTP ${res.status}`);
  const list = JSON.parse(res.body).data;
  if (!Array.isArray(list)) throw new Error('unexpected /models payload');
  return list;
}

// Keep the genuinely-free text models. Free means both prompt and completion cost "0";
// text means it can emit text (skip image/audio).
function filterFreeModels(list) {
  return list.filter(m => {
    if (typeof m.id !== 'string' || !m.id.endsWith(':free')) return false;
    const p = m.pricing || {};
    if (String(p.prompt) !== '0' || String(p.completion) !== '0') return false;
    const arch = m.architecture || {};
    const out = arch.output_modalities ||
      (typeof arch.modality === 'string' ? [arch.modality.split('->').pop()] : null);
    if (out && !out.some(x => String(x).includes('text'))) return false;
    return true;
  });
}

// Build a { modelId: { prompt, completion } } USD-per-token map from the catalogue, for
// estimating paid spend. Pricing fields arrive as strings; keep only finite numbers.
function buildPricingMap(list) {
  const prices = {};
  for (const m of list) {
    if (typeof m.id !== 'string' || !m.pricing) continue;
    const prompt = Number(m.pricing.prompt);
    const completion = Number(m.pricing.completion);
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
      prices[m.id] = { prompt, completion };
    }
  }
  return prices;
}

// Look up one model's price for paid-cost estimation. Served from the daily cache (filled
// alongside the free chain in refreshFreeModelChain), so the common path never fetches;
// only a cold-cache miss (e.g. first run right after this update) triggers a live fetch.
let pricingPromise = null;
async function getModelPricing(modelId) {
  if (!modelId) return null;
  try {
    const cached = (await chrome.storage.local.get(MODEL_PRICING_CACHE_KEY))[MODEL_PRICING_CACHE_KEY];
    if (cached && cached.ts && (Date.now() - cached.ts) < MODEL_PRICING_TTL_MS && cached.prices) {
      // '~' fallback: OpenRouter lists auto-alias models (e.g. gemini-flash-latest)
      // under a '~'-prefixed catalogue id, while the completions endpoint takes the
      // bare id — without this, paid spend on such a model would show as ~$0.
      return cached.prices[modelId] || cached.prices['~' + modelId] || null;
    }
  } catch (e) { /* fall through to a live refresh */ }
  if (!pricingPromise) {
    pricingPromise = (async () => {
      try {
        const prices = buildPricingMap(await fetchModelCatalogue());
        await setCached(MODEL_PRICING_CACHE_KEY, { ts: Date.now(), prices });
        return prices;
      } catch (e) {
        console.warn('unb8: model-pricing fetch failed —', e.message);
        return null;
      }
    })().finally(() => { pricingPromise = null; });
  }
  const prices = await pricingPromise;
  return (prices && (prices[modelId] || prices['~' + modelId])) || null;
}

// Try the selected model first (or the whole free chain when set to 'auto'),
// falling back through the remaining free models on retryable failures.
async function callOpenRouterWithFallback(prompt, { maxTokensFree, maxTokensPaid }) {
  const settings = await chrome.storage.local.get(['openRouterApiKey', 'selectedModel']);
  const apiKey = settings.openRouterApiKey;
  if (!apiKey) {
    return { success: false, error: 'No API Key configured' };
  }

  const selected = settings.selectedModel || 'auto';
  // Live-discovered free chain (curated head + current extras), falling back to the
  // static curated list if discovery is unavailable.
  const freeChain = await getFreeModelChain();
  const chain = (selected === 'auto')
    ? freeChain
    : [selected, ...freeChain.filter(m => m !== selected)];

  let lastError = 'No models attempted';
  for (const model of chain) {
    const maxTokens = model.endsWith(':free') ? maxTokensFree : maxTokensPaid;
    // Prefer minimal reasoning. If the model burns its whole token budget thinking
    // and comes back empty / length-truncated, retry it ONCE with reasoning fully
    // off (frees the entire budget for the answer) before moving to the next model —
    // so reasoning stays on where it works and is auto-disabled only where it breaks.
    let result = await tryModel(apiKey, model, prompt, maxTokens, { effort: 'low' });
    if (!result.success && result.retryReasoningOff) {
      console.warn(`unb8: ${model} failed with reasoning (${result.error}); retrying with reasoning off`);
      result = await tryModel(apiKey, model, prompt, maxTokens, { enabled: false });
    }
    if (result.success) {
      return { success: true, content: result.content, model };
    }
    lastError = `${model}: ${result.error}`;
    console.warn(`unb8: model failed, ${result.fatal ? 'aborting' : 'trying next'} — ${lastError}`);
    if (result.fatal) break; // e.g. invalid API key — no point trying other models
  }
  return { success: false, error: lastError };
}

async function tryModel(apiKey, model, prompt, maxTokens, reasoning) {
  try {
    const requestBody = {
      model: model,
      messages: [
        { role: 'user', content: prompt }
      ],
      // Paid models stay capped to avoid "insufficient credits" pre-checks on
      // low-tier accounts; free models get headroom (they cost nothing).
      max_tokens: maxTokens,
      // Reasoning level is chosen by the caller ({ effort: 'low' } normally, or
      // { enabled: false } on the retry). Reasoning tokens count against max_tokens,
      // so keeping it minimal stops a reasoning model (paid Gemini, or the free
      // Nemotron / GPT-OSS in the chain) from spending its whole budget thinking
      // and returning empty. Ignored by non-reasoning models (e.g. Gemma).
      reasoning: reasoning,
      // Route to the highest-throughput provider available for this model (speed).
      provider: { sort: 'throughput' },
      // Return token counts (and normalized cost) in the response so we can feed the
      // lifetime usage counter. Free (:free) models report 0 cost.
      usage: { include: true }
    };

    const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', 60000, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/Farsinuce/unb8', // Required by OpenRouter
        'X-Title': 'unb8'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      // 401 = bad key: fatal. 402 (credits), 404 (model gone), 429 (rate limit),
      // 5xx (provider down) are all worth a fallback to the next model.
      return { success: false, error: `HTTP ${response.status} - ${response.body.substring(0, 300)}`, fatal: response.status === 401 };
    }

    const data = JSON.parse(response.body);
    // OpenRouter can return 200 with an error body (e.g. upstream rate limits on free models).
    if (data.error) {
      return { success: false, error: data.error.message || JSON.stringify(data.error).substring(0, 300) };
    }
    // Any 200 that actually ran a model burned tokens — count it, even if we go on to
    // reject the completion (empty / truncated) and fall back. Cache hits never reach
    // tryModel, so they can't inflate the counter. Fire-and-forget: the usage write (and,
    // on a cold pricing cache, its /models fetch) must NOT gate the headline response —
    // recordUsage serializes the write internally and swallows its own errors.
    if (data.usage) {
      // Prefer the response's resolved concrete model id for the pricing lookup —
      // for alias requests (gemini-flash-latest) the routed slug carries the real price.
      recordUsage(data.usage, model.endsWith(':free'), data.model || model);
    }
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      const finish = choice.finish_reason ?? choice.native_finish_reason;
      if (finish === 'length') {
        // Hit max_tokens: output cut off mid-text — often reasoning ate the budget.
        // Retryable, and worth one more go with reasoning off (see the caller).
        return { success: false, error: `Truncated completion (finish_reason=length, max_tokens=${maxTokens})`, retryReasoningOff: true };
      }
      return { success: true, content: content.trim() };
    }
    // Empty content: the model likely spent its whole token budget reasoning.
    return { success: false, error: 'Empty completion (model may have spent all tokens on reasoning)', retryReasoningOff: true };

  } catch (error) {
    return { success: false, error: error.name === 'AbortError' ? 'Timed out' : `Fetch error: ${error.message}` };
  }
}
