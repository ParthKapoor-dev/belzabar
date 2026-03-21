import { subscribeObserver } from '../../core/observer.js';
import { debouncedInjectJSONButton } from './injector.js';
import { closeModal } from './modal.js';
import { state } from '../../core/state.js';

let unsubscribe = null;
let initialInjectionTimer = null;

// Main JSON feature coordinator
export function startJSONFeature() {
  console.log('Initializing JSON feature...');

  initialInjectionTimer = setTimeout(() => {
    debouncedInjectJSONButton();
  }, 1000);

  if (!unsubscribe) {
    unsubscribe = subscribeObserver(() => {
      debouncedInjectJSONButton();
    });
  }

  console.log('JSON feature initialized');
  return stopJSONFeature;
}

export function stopJSONFeature() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
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
