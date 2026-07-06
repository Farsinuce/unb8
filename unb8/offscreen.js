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

function parseHtml(htmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  // Debug info
  const debug = {
    originalLength: htmlString.length,
    title: doc.title,
    foundSelector: null
  };

  // Remove unwanted elements
  const unwantedTags = ['script', 'style', 'noscript', 'iframe', 'svg', 'header', 'footer', 'nav', 'aside', 'link', 'meta'];
  unwantedTags.forEach(tag => {
    const elements = doc.querySelectorAll(tag);
    elements.forEach(el => el.remove());
  });

  // Try to find specific article bodies for better quality
  // Ekstra Bladet often uses .article-bodytext or similar
  // BT often uses .article-content
  // DR often uses .hydra-article-body
  const specificSelectors = [
    '.article-bodytext',
    '.article-content',
    '[itemprop="articleBody"]',
    '.hydra-article-body',
    '.dre-article-body',
    'main',
    'article'
  ];
  
  let contentElement = doc.body;

  for (const selector of specificSelectors) {
    const el = doc.querySelector(selector);
    if (el) {
      contentElement = el;
      debug.foundSelector = selector;
      break;
    }
  }

  if (!debug.foundSelector) {
    debug.foundSelector = 'body (fallback)';
  }

  // Extract text
  let text = contentElement.textContent || '';
  
  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // If text is too short, try to parse __NEXT_DATA__ (common on DR.dk for live blogs)
  if (text.length < 500) {
    const nextDataScript = doc.querySelector('script#__NEXT_DATA__');
    if (nextDataScript) {
      try {
        const json = JSON.parse(nextDataScript.textContent);
        let nextText = '';

        // Helper to extract text from DR's JSON structure
        const extractFromDrJson = (obj) => {
          let extracted = '';
          if (!obj) return '';
          
          // Live Blog Items
          if (obj.liveBlog && obj.liveBlog.items) {
            obj.liveBlog.items.forEach(item => {
              if (item.title) extracted += item.title + '. ';
              if (item.content) {
                // Content is HTML, strip tags
                const tempDiv = doc.createElement('div');
                tempDiv.innerHTML = item.content;
                extracted += tempDiv.textContent + ' ';
              }
            });
          }
          
          // Standard Article Body
          if (obj.body && Array.isArray(obj.body)) {
             obj.body.forEach(block => {
               if (block.type === 'ParagraphComponent' && block.body) {
                 block.body.forEach(textBlock => {
                   if (textBlock.type === 'Text' && textBlock.text) {
                     extracted += textBlock.text + ' ';
                   }
                 });
               }
             });
          }
          
          return extracted;
        };

        // Navigate to article data
        if (json.props && json.props.pageProps && json.props.pageProps.viewProps && json.props.pageProps.viewProps.article) {
           nextText = extractFromDrJson(json.props.pageProps.viewProps.article);
        }

        if (nextText.length > text.length) {
          text = nextText.replace(/\s+/g, ' ').trim();
          debug.foundSelector = 'script#__NEXT_DATA__';
        }
      } catch (e) {
        console.error('Failed to parse __NEXT_DATA__', e);
        debug.nextDataError = e.message;
      }
    }
  }

  // Truncate to avoid token limits (approx 1000 words / 5000 chars should be plenty for a summary/title)
  return {
    text: text.substring(0, 5000),
    debug: debug
  };
}