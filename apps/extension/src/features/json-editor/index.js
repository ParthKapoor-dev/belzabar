import { OBSERVER_OPTIONS } from '../../config/constants.js';
import { debouncedInjectJSONButton } from './injector.js';
import { closeModal } from './modal.js';
import { state } from '../../core/state.js';

let jsonObserver = null;
let initialInjectionTimer = null;

// Main JSON feature coordinator
export function startJSONFeature() {
  console.log('Initializing JSON feature...');

  initialInjectionTimer = setTimeout(() => {
    debouncedInjectJSONButton();
  }, 1000);

  if (!jsonObserver) {
    jsonObserver = new MutationObserver(() => {
      debouncedInjectJSONButton();
    });
    jsonObserver.observe(document.body, OBSERVER_OPTIONS);
  }

  console.log('JSON feature initialized');
  return stopJSONFeature;
}

export function stopJSONFeature() {
  if (jsonObserver) {
    jsonObserver.disconnect();
    jsonObserver = null;
  }

  if (initialInjectionTimer) {
    clearTimeout(initialInjectionTimer);
    initialInjectionTimer = null;
  }

  if (state.injectionDebounceTimer) {
    clearTimeout(state.injectionDebounceTimer);
    state.injectionDebounceTimer = null;
  }

  closeModal();

  const jsonButton = document.getElementById('sdExtensionJSONButton');
  if (jsonButton) {
    jsonButton.remove();
  }

  state.jsonButtonEl = null;
  state.injectionAttempts = 0;
}
