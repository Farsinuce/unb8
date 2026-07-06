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
    }
  });

  saveButton.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const model = modelSelect.value;

    if (!apiKey) {
      showStatus('Please enter an API Key.', 'error');
      return;
    }

    showStatus('Testing connection...', 'loading');
    saveButton.disabled = true;

    // Test the key by making a small request to OpenRouter
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/kilocode/unbait2',
          'X-Title': 'Unbait2 Onboarding'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'user', content: 'Say "Hello" if this works.' }
          ],
          max_tokens: 5
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API Error: ${response.status} - ${errText}`);
      }

      const data = await response.json();
      
      if (data.choices && data.choices.length > 0) {
        // Success! Save settings.
        chrome.storage.local.set({
          openRouterApiKey: apiKey,
          selectedModel: model
        }, () => {
          showStatus('Success! You are ready to go. You can close this tab.', 'success');
          saveButton.textContent = 'Saved & Verified';
        });
      } else {
        throw new Error('No response from AI model.');
      }

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