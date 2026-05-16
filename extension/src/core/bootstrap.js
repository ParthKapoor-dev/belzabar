// Shared content-script bootstrap.
//
// Both designer bundles (ad-content.js, pd-content.js) call this with their own
// feature-starter map. Splitting the entry points means a Page Designer tab
// never even loads the AD-only feature code, and no designer code ships to
// general/published pages at all.

import { startSettingsFeature } from '../features/settings/index.js';
import { startCurlAutofillFeature } from '../features/curl-autofill/index.js';
import { loadSettings, setSetting, subscribeSettings } from './settings.js';

/**
 * Wire up a designer content script.
 *
 * @param {Record<string, () => (void | (() => void))>} featureStarters
 * @param {{ curlAutofill?: boolean }} [options]
 */
export function bootstrap(featureStarters, options) {
  const opts = options || {};
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
      try {
        if (settings[key]) {
          startFeature(key);
        } else {
          stopFeature(key);
        }
      } catch (error) {
        console.error(`Failed applying feature "${key}":`, error);
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

    if (opts.curlAutofill) {
      startCurlAutofillFeature();
    }

    console.log('Extension initialized successfully');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
