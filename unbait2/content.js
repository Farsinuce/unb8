// Configuration for different sites
const SITE_CONFIG = {
  'ekstrabladet.dk': {
    articleSelector: '.dre-item__text', // Container for the article teaser
    linkSelector: 'a',
    titleSelector: '.dre-item__alt-title--sm, .dre-item__alt-title--md, .dre-item__alt-title--lg, .dre-item__title',
    excludeSelector: '[data-unbait-processed="true"]'
  },
  'bt.dk': {
    articleSelector: '.dre-item__text',
    linkSelector: 'a',
    titleSelector: '.dre-item__alt-title--sm, .dre-item__alt-title--md, .dre-item__alt-title--lg, .dre-item__title',
    excludeSelector: '[data-unbait-processed="true"]'
  },
  'dr.dk': {
    articleSelector: '.dre-teaser, .hydra-latest-news-item, .hydra-card',
    linkSelector: 'a',
    titleSelector: '.dre-title-text, .hydra-card-title__text',
    excludeSelector: '[data-unbait-processed="true"]'
  }
};

function getSiteConfig() {
  const hostname = window.location.hostname.replace('www.', '');
  if (hostname.includes('ekstrabladet.dk')) return SITE_CONFIG['ekstrabladet.dk'];
  if (hostname.includes('bt.dk')) return SITE_CONFIG['bt.dk'];
  if (hostname.includes('dr.dk')) return SITE_CONFIG['dr.dk'];
  return null;
}

const config = getSiteConfig();

if (config) {
  console.log('Unbait2: Active on', window.location.hostname);
  
  // Initial scan
  processArticles();

  // Observe for new content (infinite scroll, etc.)
  const observer = new MutationObserver((mutations) => {
    let shouldProcess = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldProcess = true;
        break;
      }
    }
    if (shouldProcess) {
      processArticles();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function processArticles() {
  if (!config) return;

  const articles = document.querySelectorAll(config.articleSelector);
  
  articles.forEach(article => {
    if (article.dataset.unbaitProcessed) return;
    
    const link = article.querySelector(config.linkSelector);
    const titleEl = article.querySelector(config.titleSelector);

    if (link && titleEl) {
      // Mark as processed immediately to avoid double processing
      article.dataset.unbaitProcessed = "true";
      
      const originalTitle = titleEl.innerText.trim();
      const url = link.href;

      // Skip if URL is not an article (e.g. section link) or is external
      if (!url.includes(window.location.hostname) && !url.startsWith('/')) return;

      // Send to background script
      chrome.runtime.sendMessage({
        action: 'generateTitle',
        url: url
      }, (response) => {
        if (response && response.success && response.title) {
          applyNewTitle(article, titleEl, originalTitle, response.title);
        } else {
          console.log('Unbait2: Failed to generate title for', url, response?.error);
        }
      });
    }
  });
}

function applyNewTitle(articleContainer, titleElement, originalTitle, newTitle) {
  // Store original title and styles
  articleContainer.dataset.originalTitle = originalTitle;
  articleContainer.dataset.aiTitle = newTitle;
  articleContainer.dataset.showingAi = "true";
  
  // Store original styles if not already stored
  if (!articleContainer.dataset.originalFontSize) {
    const computedStyle = window.getComputedStyle(titleElement);
    articleContainer.dataset.originalFontSize = computedStyle.fontSize;
    articleContainer.dataset.originalLineHeight = computedStyle.lineHeight;
    articleContainer.dataset.originalDisplay = computedStyle.display;
    articleContainer.dataset.originalWebkitLineClamp = computedStyle.webkitLineClamp;
    articleContainer.dataset.originalWebkitBoxOrient = computedStyle.webkitBoxOrient;
    articleContainer.dataset.originalOverflow = computedStyle.overflow;
  }

  // Update text
  titleElement.innerText = newTitle;
  
  // Fit text to container
  fitTextToContainer(titleElement, articleContainer);

  // Add Toggle Button
  addToggleButton(articleContainer, titleElement);
}

function fitTextToContainer(textElement, container) {
  // Get the available dimensions from the container or the element's original bounding box
  // We need to be careful not to rely on the container if it grows with content
  // So we try to use the parent's fixed dimensions if possible, or a max-height style
  
  const computedStyle = window.getComputedStyle(container);
  let maxHeight = parseInt(computedStyle.maxHeight);
  
  // If no max-height is set, try to infer from current height (assuming original text filled it reasonably well)
  // But this is risky if the original text was short.
  // A better approach for news sites is often to look at the parent grid cell or wrapper
  
  let availableWidth = container.clientWidth;
  let availableHeight = container.clientHeight;

  // If the container is very small (e.g. just started rendering), try to use the parent
  if (availableHeight < 20 && container.parentElement) {
      availableHeight = container.parentElement.clientHeight;
      availableWidth = container.parentElement.clientWidth;
  }

  // Reset styles to allow measurement
  textElement.style.width = '100%';
  textElement.style.height = 'auto';
  textElement.style.display = 'block'; // Ensure it takes up space
  textElement.style.webkitLineClamp = 'unset'; // Disable line clamping during measurement
  textElement.style.overflow = 'visible';

  let minSize = 10;
  let maxSize = 40; // Cap at a reasonable max size
  let bestSize = minSize;

  // Binary search for the best font size
  while (minSize <= maxSize) {
    const mid = Math.floor((minSize + maxSize) / 2);
    textElement.style.fontSize = mid + 'px';
    textElement.style.lineHeight = '1.2'; // Standardize line height for calculation
    
    // Check if it fits
    // We check if the scrollHeight (actual content height) is within the available height
    // We allow a small tolerance (10%)
    if (textElement.scrollHeight <= availableHeight * 1.1) {
      bestSize = mid;
      minSize = mid + 1;
    } else {
      maxSize = mid - 1;
    }
  }

  // Apply best fit
  textElement.style.fontSize = bestSize + 'px';
  textElement.style.lineHeight = '1.2';
  
  // Re-apply line clamping if it was present, to handle slight overflows gracefully
  if (container.dataset.originalWebkitLineClamp && container.dataset.originalWebkitLineClamp !== 'none') {
      textElement.style.display = '-webkit-box';
      textElement.style.webkitLineClamp = container.dataset.originalWebkitLineClamp;
      textElement.style.webkitBoxOrient = 'vertical';
      textElement.style.overflow = 'hidden';
  }
}

function addToggleButton(container, titleElement) {
  if (container.querySelector('.unbait-toggle')) return;

  const btn = document.createElement('button');
  btn.className = 'unbait-toggle';
  btn.innerHTML = '💡'; // Lightbulb icon
  btn.title = 'Toggle Original/AI Headline';
  
  // Style the button
  Object.assign(btn.style, {
    position: 'absolute',
    top: '5px',
    right: '5px',
    zIndex: '100',
    background: 'white',
    border: '1px solid #ccc',
    borderRadius: '50%',
    width: '24px',
    height: '24px',
    cursor: 'pointer',
    fontSize: '14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
  });

  // Make container relative so absolute positioning works
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const isShowingAi = container.dataset.showingAi === "true";
    
    if (isShowingAi) {
      // Switch to Original
      titleElement.innerText = container.dataset.originalTitle;
      
      // Restore original styles
      if (container.dataset.originalFontSize) {
        titleElement.style.fontSize = container.dataset.originalFontSize;
        titleElement.style.lineHeight = container.dataset.originalLineHeight;
        titleElement.style.display = container.dataset.originalDisplay;
        titleElement.style.webkitLineClamp = container.dataset.originalWebkitLineClamp;
        titleElement.style.webkitBoxOrient = container.dataset.originalWebkitBoxOrient;
        titleElement.style.overflow = container.dataset.originalOverflow;
      }
      
      container.dataset.showingAi = "false";
      btn.style.opacity = "0.5";
      btn.style.filter = "grayscale(100%)";
    } else {
      // Switch to AI
      titleElement.innerText = container.dataset.aiTitle;
      
      // Re-apply text fitting
      fitTextToContainer(titleElement, container);
      
      container.dataset.showingAi = "true";
      btn.style.opacity = "1";
      btn.style.filter = "none";
    }
  });

  container.appendChild(btn);
}