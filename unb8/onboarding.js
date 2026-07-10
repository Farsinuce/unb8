document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('model');
  const saveButton = document.getElementById('saveAndTest');
  const statusDiv = document.getElementById('status');

  // Load saved settings if they exist (e.g. if user re-opens onboarding)
  chrome.storage.local.get(['openRouterApiKey', 'selectedModel'], (result) => {
    if (result.openRouterApiKey) {
      apiKeyInput.value = result.openRouterApiKey;
    }
    if (result.selectedModel) {
      modelSelect.value = result.selectedModel;
      if (!modelSelect.value) {
        // Stored model no longer in the list: persist the fallback, don't just show it.
        modelSelect.value = 'auto';
        chrome.storage.local.set({ selectedModel: 'auto' });
      }
    }
  });

  saveButton.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const model = modelSelect.value || 'auto';

    if (!apiKey) {
      showStatus('Please enter an API Key.', 'error');
      return;
    }

    showStatus('Checking API key...', 'loading');
    saveButton.disabled = true;

    // Auth-only check (GET /key): free of charge and immune to the rate limits
    // that would make a chat-completion test fail even with a perfectly valid key.
    try {
      const response = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid API key');
      }
      if (!response.ok) {
        throw new Error(`OpenRouter error: HTTP ${response.status}`);
      }

      // Key is valid — save settings.
      chrome.storage.local.set({
        openRouterApiKey: apiKey,
        selectedModel: model
      }, () => {
        showStatus('Success! You are ready to go. You can close this tab.', 'success');
        saveButton.textContent = 'Saved & Verified';
      });

    } catch (error) {
      console.error(error);
      showStatus(`Connection failed: ${error.message}`, 'error');
      saveButton.disabled = false;
    }
  });

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = type;
  }
});