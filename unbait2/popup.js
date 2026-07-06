document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('model');
  const saveButton = document.getElementById('save');
  const testButton = document.getElementById('test');
  const statusDiv = document.getElementById('status');

  // Load saved settings
  chrome.storage.local.get(['openRouterApiKey', 'selectedModel'], (result) => {
    if (result.openRouterApiKey) {
      apiKeyInput.value = result.openRouterApiKey;
    }
    if (result.selectedModel) {
      modelSelect.value = result.selectedModel;
    }
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
    const model = modelSelect.value;

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
          'HTTP-Referer': 'https://github.com/kilocode/unbait2',
          'X-Title': 'Unbait2 Popup'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'user', content: 'Hi' }
          ],
          max_tokens: 5
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.choices && data.choices.length > 0) {
        showStatus('Connection successful!', 'success');
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

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = type;
    statusDiv.style.display = 'block';
  }
});