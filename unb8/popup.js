document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('model');
  const enabledToggle = document.getElementById('extensionEnabled');
  const rewriteToggle = document.getElementById('rewriteArticles');
  const saveButton = document.getElementById('save');
  const testButton = document.getElementById('test');
  const clearCacheButton = document.getElementById('clearCache');
  const statusDiv = document.getElementById('status');

  // Load saved settings
  chrome.storage.local.get(['openRouterApiKey', 'selectedModel', 'extensionEnabled', 'rewriteArticles'], (result) => {
    if (result.openRouterApiKey) {
      apiKeyInput.value = result.openRouterApiKey;
    }
    modelSelect.value = result.selectedModel || 'auto';
    if (!modelSelect.value) modelSelect.value = 'auto'; // stored model no longer in the list
    enabledToggle.checked = result.extensionEnabled !== false; // default: on
    rewriteToggle.checked = result.rewriteArticles === true;   // default: off
  });

  // Toggles save immediately
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

  // Save settings
  saveButton.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    const model = modelSelect.value;

    if (!apiKey) {
      showStatus('Please enter an API Key.', 'error');
      return;
    }

    chrome.storage.local.set({
      openRouterApiKey: apiKey,
      selectedModel: model
    }, () => {
      showStatus('Settings saved!', 'success');
      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 2000);
    });
  });

  // Test Connection
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
          max_tokens: 100
        })
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || 'API returned an error');
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

  // Clear cached headlines/rewrites
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
