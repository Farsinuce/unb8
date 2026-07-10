// Single source of truth for the model <select> shown in BOTH the popup and the
// onboarding page — previously two hand-maintained copies that drifted (and gave
// first-run users a flat list without the free/paid grouping). Loaded via
// <script src="models.js"> at the end of <body>, right before popup.js/onboarding.js,
// so the options exist before either page's DOMContentLoaded handler restores the
// stored selection. Model ids must match what background.js sends to OpenRouter.
(function () {
  'use strict';

  const MODEL_OPTIONS = [
    { value: 'auto', label: 'Auto — free models with fallback (recommended)', group: null },
    { value: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (free)', group: 'Free models' },
    { value: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B (free)', group: 'Free models' },
    { value: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B (free)', group: 'Free models' },
    { value: 'openai/gpt-oss-120b:free', label: 'GPT-OSS 120B (free)', group: 'Free models' },
    { value: 'openai/gpt-oss-20b:free', label: 'GPT-OSS 20B (free)', group: 'Free models' },
    { value: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite (paid — cheaper)', group: 'Paid models' },
    { value: 'google/gemini-flash-latest', label: 'Gemini Flash latest (paid — newest, pricier)', group: 'Paid models' }
  ];

  const select = document.getElementById('model');
  if (!select) return;

  let currentGroup = null;
  let container = select;
  for (const opt of MODEL_OPTIONS) {
    if (opt.group !== currentGroup) {
      currentGroup = opt.group;
      if (opt.group) {
        container = document.createElement('optgroup');
        container.label = opt.group;
        select.appendChild(container);
      } else {
        container = select;
      }
    }
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    container.appendChild(o);
  }
})();
