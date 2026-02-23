// Main entry point
import { updateTitle } from './features/title-updater/index.js';
import { setupObserver } from './features/title-updater/observer.js';
import { handleKeydown } from './features/keyboard/shortcuts.js';
import { initJSONFeature } from './features/json-editor/index.js';
import { initOutputCopyFeature } from './features/output-copy/index.js';

(() => {
  'use strict';

  function init() {
    console.log('Extension initializing...');
    updateTitle();
    setupObserver();
    document.addEventListener('keydown', handleKeydown, true);
    initJSONFeature();
    initOutputCopyFeature();
    console.log('Extension initialized successfully');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
