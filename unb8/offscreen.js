// Chrome-only offscreen document: a service worker has no DOMParser, so HTML
// parsing is delegated here. The actual extraction lives in parser.js (shared
// with Firefox's inline path); this file is just the message-listener shim.
// parseHtml is provided by parser.js, loaded before this script in offscreen.html.

chrome.runtime.onMessage.addListener(handleMessages);

function handleMessages(message, sender, sendResponse) {
  if (message.target !== 'offscreen') {
    return;
  }

  if (message.type === 'parse-html') {
    const result = parseHtml(message.data);
    sendResponse(result);
  }
}
