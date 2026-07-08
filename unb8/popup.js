document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('model');
  const enabledToggle = document.getElementById('extensionEnabled');
  const rewriteToggle = document.getElementById('rewriteArticles');
  const lazyToggle = document.getElementById('lazyLoad');
  const testButton = document.getElementById('test');
  const clearCacheButton = document.getElementById('clearCache');
  const cleanPageButton = document.getElementById('cleanPage');
  const consentPanel = document.getElementById('universalConsent');
  const consentAccept = document.getElementById('consentAccept');
  const consentCancel = document.getElementById('consentCancel');
  const statusDiv = document.getElementById('status');

  // Usage panel
  const usageFree = document.getElementById('usageFree');
  const usagePaid = document.getElementById('usagePaid');
  const usageEmpty = document.getElementById('usageEmpty');
  const freeTokensEl = document.getElementById('freeTokens');
  const paidCostEl = document.getElementById('paidCost');
  const paidTokensEl = document.getElementById('paidTokens');

  const USAGE_KEY = 'unbait_usage_v1';
  const CONSENT_KEY = 'universalConsent';

  // --- Usage counter -------------------------------------------------------
  // Kept in sync with the identical helper in background.js (no build step to share it).
  // 1234 -> "1.2k", 999_500 -> "1M" (round the mantissa, then promote if it hits 1000).
  function formatTokens(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n < 1000) return String(n);
    const units = [{ v: 1e3, s: 'k' }, { v: 1e6, s: 'M' }, { v: 1e9, s: 'B' }];
    let idx = 0;
    for (let i = 0; i < units.length; i++) {
      if (n >= units[i].v) idx = i;
    }
    const mantissa = (v) => { const m = n / v; return m >= 100 ? Math.round(m) : Math.round(m * 10) / 10; };
    let m = mantissa(units[idx].v);
    if (m >= 1000 && idx < units.length - 1) { idx++; m = mantissa(units[idx].v); }
    return (Number.isInteger(m) ? m : m.toFixed(1)) + units[idx].s;
  }

  // Two independent lines: free-model tokens (which cost nothing) and paid-model spend.
  // `cost` is an ESTIMATE (tokens × the model's catalogue price, summed in background.js) —
  // OpenRouter's inline usage.cost proved unreliable (often 0), so it's shown with a ~.
  // Pre-split installs only stored `total`, so fall back to showing it as free (background.js
  // migrates it into freeTotal on the next call).
  function renderCounter(usage) {
    usage = usage || {};
    const freeTotal = (usage.freeTotal != null) ? usage.freeTotal : (usage.total || 0);
    const paidTotal = usage.paidTotal || 0;
    const cost = usage.cost || 0;

    const hasFree = freeTotal > 0;
    const hasPaid = paidTotal > 0 || cost > 0;

    usageFree.style.display = hasFree ? 'block' : 'none';
    usagePaid.style.display = hasPaid ? 'block' : 'none';
    usageEmpty.style.display = (hasFree || hasPaid) ? 'none' : 'block';

    if (hasFree) freeTokensEl.textContent = formatTokens(freeTotal);
    if (hasPaid) {
      paidCostEl.textContent = '~$' + (cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2));
      paidTokensEl.textContent = paidTotal > 0 ? `(${formatTokens(paidTotal)} tokens)` : '';
    }
  }

  chrome.storage.local.get(USAGE_KEY, (r) => renderCounter(r[USAGE_KEY]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[USAGE_KEY]) renderCounter(changes[USAGE_KEY].newValue);
  });

  // --- Load saved settings -------------------------------------------------
  chrome.storage.local.get(['openRouterApiKey', 'selectedModel', 'extensionEnabled', 'rewriteArticles', 'lazyLoad'], (result) => {
    if (result.openRouterApiKey) apiKeyInput.value = result.openRouterApiKey;
    modelSelect.value = result.selectedModel || 'auto';
    if (!modelSelect.value) modelSelect.value = 'auto'; // stored model no longer in the list
    enabledToggle.checked = result.extensionEnabled !== false; // default: on
    rewriteToggle.checked = result.rewriteArticles === true;   // default: off
    lazyToggle.checked = result.lazyLoad !== false;            // default: on
  });

  // --- Everything saves instantly (no "Save" button) -----------------------
  enabledToggle.addEventListener('change', () => {
    chrome.storage.local.set({ extensionEnabled: enabledToggle.checked }, () => {
      showStatus(enabledToggle.checked ? 'unb8 enabled.' : 'unb8 disabled.', 'success');
    });
  });

  rewriteToggle.addEventListener('change', () => {
    chrome.storage.local.set({ rewriteArticles: rewriteToggle.checked }, () => {
      showStatus(rewriteToggle.checked
        ? 'Article rewriting enabled. Reload the article page to apply.'
        : 'Article rewriting disabled.', 'success');
    });
  });

  lazyToggle.addEventListener('change', () => {
    chrome.storage.local.set({ lazyLoad: lazyToggle.checked }, () => {
      showStatus(lazyToggle.checked
        ? 'Prioritizing visible headlines — others load as you scroll.'
        : 'Processing whole page on load (old method).', 'success');
    });
  });

  modelSelect.addEventListener('change', () => {
    chrome.storage.local.set({ selectedModel: modelSelect.value }, () => {
      showStatus('Model saved.', 'success');
    });
  });

  // Save the key immediately on each edit (robust if the popup closes mid-typing);
  // the "saved" toast is debounced so it doesn't flash on every keystroke.
  let keyToastTimer = null;
  apiKeyInput.addEventListener('input', () => {
    chrome.storage.local.set({ openRouterApiKey: apiKeyInput.value.trim() });
    clearTimeout(keyToastTimer);
    keyToastTimer = setTimeout(() => showStatus('API key saved.', 'success'), 500);
  });

  // --- Test Connection -----------------------------------------------------
  testButton.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const model = modelSelect.value === 'auto' ? 'google/gemma-4-31b-it:free' : modelSelect.value;

    if (!apiKey) {
      showStatus('Please enter an API Key first.', 'error');
      return;
    }

    showStatus('Testing connection...', 'loading');
    testButton.disabled = true;

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/Farsinuce/unb8',
          'X-Title': 'unb8 Popup'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'user', content: 'Hi' }
          ],
          max_tokens: 100,
          usage: { include: true }
        })
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || 'API returned an error');
      }

      // Count this call's tokens too, via the background accumulator.
      if (data.usage) {
        chrome.runtime.sendMessage({ action: 'recordUsage', usage: data.usage, isFree: model.endsWith(':free'), model: model });
      }

      if (data.choices && data.choices.length > 0) {
        showStatus(`Connection successful! (${model})`, 'success');
      } else {
        throw new Error('No response from AI.');
      }

    } catch (error) {
      console.error(error);
      showStatus(`Failed: ${error.message}`, 'error');
    } finally {
      testButton.disabled = false;
    }
  });

  // --- Clean this page (experimental universal mode) -----------------------
  // First use shows a one-time consent panel (explaining what gets sent where);
  // after the user accepts once, later clicks inject straight away.
  cleanPageButton.addEventListener('click', () => {
    chrome.storage.local.get(CONSENT_KEY, (r) => {
      if (r[CONSENT_KEY]) {
        runCleanPage();
      } else {
        consentPanel.classList.add('show');
      }
    });
  });

  consentCancel.addEventListener('click', () => consentPanel.classList.remove('show'));

  consentAccept.addEventListener('click', () => {
    chrome.storage.local.set({ [CONSENT_KEY]: true }, () => {
      consentPanel.classList.remove('show');
      runCleanPage();
    });
  });

  // Inject parser.js (shared HTML->text extractor, reused to read same-origin articles)
  // then universal.js into the active tab. Opening the popup granted activeTab for that
  // tab, so no host permission is needed. http(s) only — executeScript rejects
  // chrome:/about:/file: pages. The injected script keeps running (and shows its own
  // on-page control) after this popup closes, which it will as soon as focus leaves it.
  function runCleanPage() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) {
        showStatus('Cannot clean this page (only http/https pages).', 'error');
        return;
      }
      cleanPageButton.disabled = true;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['parser.js', 'universal.js'] }, () => {
        cleanPageButton.disabled = false;
        if (chrome.runtime.lastError) {
          showStatus(`Failed: ${chrome.runtime.lastError.message}`, 'error');
        } else {
          showStatus('Cleaning this page — a floating control appears on the page. You can close this popup.', 'success');
        }
      });
    });
  }

  // --- Clear cached headlines/rewrites -------------------------------------
  clearCacheButton.addEventListener('click', () => {
    chrome.storage.local.get(null, (all) => {
      const keys = Object.keys(all).filter(k => k.startsWith('unbait_cache_') || k.startsWith('unbait_rewrite_'));
      chrome.storage.local.remove(keys, () => {
        showStatus(`Cleared ${keys.length} cached entries.`, 'success');
      });
    });
  });

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = type;
    statusDiv.style.display = 'block';
  }
});
