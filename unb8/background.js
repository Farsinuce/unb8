// unb8 service worker: caching, article fetching, OpenRouter calls with free-model fallback.

// Free models on OpenRouter, tried in order. Verified against /api/v1/models (July 2026).
const FREE_MODEL_CHAIN = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free'
];

const CACHE_PREFIX_TITLE = 'unbait_cache_v2_';
const CACHE_PREFIX_REWRITE = 'unbait_rewrite_v1_';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
});

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

  if (request.action === 'generateTitle') {
    let pending = pendingTitleRequests.get(request.url);
    if (!pending) {
      pending = handleGenerateTitle(request.url, request.text).finally(() => pendingTitleRequests.delete(request.url));
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

async function handleGenerateTitle(url, providedText) {
  try {
    const settings = await chrome.storage.local.get(['extensionEnabled']);
    if (settings.extensionEnabled === false) {
      return { success: false, error: 'Extension is disabled' };
    }

    // 1. Check Cache
    const cacheKey = CACHE_PREFIX_TITLE + url;
    const cachedTitle = await getCached(cacheKey);
    if (cachedTitle) {
      return { success: true, title: cachedTitle.title, cached: true };
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
- Do not add information that is not in the article.
- Plain text only: no markdown, no bullet points, no headings, no commentary.

Original headline: ${originalTitle}

Article text:
${articleText}`;
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

// Try the selected model first (or the whole free chain when set to 'auto'),
// falling back through the remaining free models on retryable failures.
async function callOpenRouterWithFallback(prompt, { maxTokensFree, maxTokensPaid }) {
  const settings = await chrome.storage.local.get(['openRouterApiKey', 'selectedModel']);
  const apiKey = settings.openRouterApiKey;
  if (!apiKey) {
    return { success: false, error: 'No API Key configured' };
  }

  const selected = settings.selectedModel || 'auto';
  const chain = (selected === 'auto')
    ? FREE_MODEL_CHAIN
    : [selected, ...FREE_MODEL_CHAIN.filter(m => m !== selected)];

  let lastError = 'No models attempted';
  for (const model of chain) {
    const maxTokens = model.endsWith(':free') ? maxTokensFree : maxTokensPaid;
    const result = await tryModel(apiKey, model, prompt, maxTokens);
    if (result.success) {
      return { success: true, content: result.content, model };
    }
    lastError = `${model}: ${result.error}`;
    console.warn(`unb8: model failed, ${result.fatal ? 'aborting' : 'trying next'} — ${lastError}`);
    if (result.fatal) break; // e.g. invalid API key — no point trying other models
  }
  return { success: false, error: lastError };
}

async function tryModel(apiKey, model, prompt, maxTokens) {
  try {
    const requestBody = {
      model: model,
      messages: [
        { role: 'user', content: prompt }
      ],
      // Free models cost nothing, so give reasoning models headroom; paid models
      // stay capped to avoid "insufficient credits" pre-checks on low-tier accounts.
      max_tokens: maxTokens
    };
    if (!model.endsWith(':free')) {
      // Paid Gemini models think by default and reasoning tokens count against
      // max_tokens — under the low paid cap that yields empty content every time.
      requestBody.reasoning = { enabled: false };
    }

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
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      const finish = choice.finish_reason ?? choice.native_finish_reason;
      if (finish === 'length') {
        // Hit max_tokens: output is cut off mid-text. Retryable — try the next model.
        return { success: false, error: `Truncated completion (finish_reason=length, max_tokens=${maxTokens})` };
      }
      return { success: true, content: content.trim() };
    }
    // Reasoning models can burn the whole token budget thinking and return empty content.
    return { success: false, error: 'Empty completion (model may have spent all tokens on reasoning)' };

  } catch (error) {
    return { success: false, error: error.name === 'AbortError' ? 'Timed out' : `Fetch error: ${error.message}` };
  }
}
