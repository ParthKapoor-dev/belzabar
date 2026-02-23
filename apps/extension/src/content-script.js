// Main entry point
import {
  startTitleUpdaterFeature
} from './features/title-updater/index.js';
import {
  startRunTestShortcutFeature
} from './features/keyboard/shortcuts.js';
import {
  startJSONFeature
} from './features/json-editor/index.js';
import {
  startOutputCopyFeature
} from './features/output-copy/index.js';
import {
  startTextareaEditorFeature
} from './features/textarea-editor/index.js';
import { startSettingsFeature } from './features/settings/index.js';
import {
  loadSettings,
  setSetting,
  subscribeSettings
} from './core/settings.js';

(() => {
  'use strict';

  const featureStarters = {
    titleUpdater: startTitleUpdaterFeature,
    runTestShortcut: startRunTestShortcutFeature,
    jsonEditor: startJSONFeature,
    outputCopy: startOutputCopyFeature,
    textareaEditor: startTextareaEditorFeature
  };

  const activeFeatureStops = new Map();

  function startFeature(key) {
    if (activeFeatureStops.has(key)) return;

    const startFeatureFn = featureStarters[key];
    if (!startFeatureFn) return;

    const cleanup = startFeatureFn();
    activeFeatureStops.set(
      key,
      typeof cleanup === 'function' ? cleanup : () => {}
    );
  }

  function stopFeature(key) {
    const cleanup = activeFeatureStops.get(key);
    if (!cleanup) return;

    try {
      cleanup();
    } catch (error) {
      console.error(`Failed stopping feature "${key}":`, error);
    } finally {
      activeFeatureStops.delete(key);
    }
  }

  function applyFeatureSettings(settings) {
    for (const key of Object.keys(featureStarters)) {
      if (settings[key]) {
        startFeature(key);
      } else {
        stopFeature(key);
      }
    }
  }

  function init() {
    console.log('Extension initializing...');

    applyFeatureSettings(loadSettings());
    subscribeSettings((settings) => {
      applyFeatureSettings(settings);
    });

    startSettingsFeature({
      getSettings: loadSettings,
      setSetting
    });

    console.log('Extension initialized successfully');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
