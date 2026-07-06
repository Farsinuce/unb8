// Setup offscreen document for HTML parsing
async function setupOffscreenDocument(path) {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: path,
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: 'Parse article HTML to extract text for AI processing',
  });
}

setupOffscreenDocument('offscreen.html');

// Open onboarding page on installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'onboarding.html' });
  }
});
// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'generateTitle') {
    handleGenerateTitle(request.url).then(sendResponse);
    return true; // Keep message channel open for async response
  }
});

async function handleGenerateTitle(url) {
  try {
    // 1. Check Cache
    const cacheKey = `unbait_cache_${url}`;
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) {
      console.log('Serving from cache:', url);
      return { success: true, title: cached[cacheKey] };
    }

    // 2. Fetch Article HTML
    const response = await fetch(url);
    const html = await response.text();

    // 3. Parse HTML (via Offscreen)
    const parseResult = await parseHtmlInOffscreen(html);
    const text = parseResult.text;
    
    if (!text || text.length < 100) {
      console.warn('Unbait2: Insufficient text extracted.', {
        url,
        textLength: text ? text.length : 0,
        debug: parseResult.debug
      });
      return { success: false, error: `Could not extract sufficient text (found ${text ? text.length : 0} chars). Selector: ${parseResult.debug?.foundSelector}` };
    }

    // 4. Call OpenRouter API
    const apiResult = await callOpenRouter(text);

    // 5. Cache Result
    if (apiResult && apiResult.success) {
      await chrome.storage.local.set({ [cacheKey]: apiResult.title });
      return { success: true, title: apiResult.title };
    } else {
      return { success: false, error: apiResult?.error || 'AI generation failed' };
    }

  } catch (error) {
    console.error('Error processing URL:', url, error);
    return { success: false, error: error.message };
  }
}

async function parseHtmlInOffscreen(html) {
  await setupOffscreenDocument('offscreen.html');
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'parse-html',
      target: 'offscreen',
      data: html
    }, (response) => {
      if (response && response.text !== undefined) {
        resolve(response);
      } else {
        resolve({ text: '', debug: { error: 'No response from offscreen' } });
      }
    });
  });
}

async function callOpenRouter(articleText) {
  const settings = await chrome.storage.local.get(['openRouterApiKey', 'selectedModel']);
  const apiKey = settings.openRouterApiKey;
  const model = settings.selectedModel || 'google/gemini-2.5-flash';

  if (!apiKey) {
    return { success: false, error: 'No API Key configured' };
  }

  const prompt = `
    You are a helpful assistant that rewrites clickbait headlines.
    Read the following article text and generate a single, factual, non-clickbait headline in Danish.
    The headline should be descriptive and summarize the main point of the article.
    Do not use "Breaking", "Chok", "Afsløring" or similar sensationalist words.
    Keep it under 100 characters if possible.
    ONLY output the headline, nothing else.

    Article Text:
    ${articleText}
  `;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/kilocode/unbait2', // Required by OpenRouter
        'X-Title': 'Unbait2'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'user', content: prompt }
        ],
        max_tokens: 100 // Limit response tokens to avoid "insufficient credits" error
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('OpenRouter API Error:', err);
      return { success: false, error: `API Error: ${response.status} - ${err}` };
    }

    const data = await response.json();
    if (data.choices && data.choices.length > 0) {
      let title = data.choices[0].message.content.trim();
      // Remove quotes if present
      title = title.replace(/^["']|["']$/g, '');
      return { success: true, title: title };
    }
    return { success: false, error: 'No choices returned from API' };

  } catch (error) {
    console.error('OpenRouter Fetch Error:', error);
    return { success: false, error: `Fetch Error: ${error.message}` };
  }
}