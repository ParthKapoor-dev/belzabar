// Chain Inspector — standalone content-script entry.
//
// The chain HUD is the one feature that must run beyond the AD/PD designer: it
// is mounted on published and public app pages too. It therefore ships as its
// own content-script bundle (matching every app page) instead of riding inside
// `content-script.js`, which stays scoped to the designer routes.

import { startChainInspectorFeature } from './hud.js';

const SETTINGS_KEY = 'sdExtensionSettingsV1';
const SETTINGS_EVENT = 'sd-extension-settings-changed';

// Reads the `chainInspector` toggle straight from storage. Defaults to enabled
// (matching DEFAULT_SETTINGS) — on public pages the settings modal never runs,
// so there may be no stored settings at all.
function chainInspectorEnabled() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return true;
    const value = JSON.parse(raw).chainInspector;
    return value === undefined ? true : Boolean(value);
  } catch {
    return true;
  }
}

(() => {
  let stop = null;

  function apply() {
    const enabled = chainInspectorEnabled();
    if (enabled && !stop) {
      stop = startChainInspectorFeature();
    } else if (!enabled && stop) {
      try {
        stop();
      } catch {
        /* ignore */
      }
      stop = null;
    }
  }

  apply();

  // The settings modal lives in `content-script.js`; when it persists a change
  // it dispatches this event on the shared isolated-world window.
  window.addEventListener(SETTINGS_EVENT, apply);
  // Catches toggles made in another tab on the same origin.
  window.addEventListener('storage', (event) => {
    if (event.key === SETTINGS_KEY) apply();
  });
})();
