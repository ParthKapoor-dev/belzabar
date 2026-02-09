import { OBSERVER_OPTIONS } from '../../config/constants.js';
import { debouncedInjectJSONButton } from './injector.js';

// Main JSON feature coordinator
export function initJSONFeature() {
  console.log('Initializing JSON feature...');
  
  // Try immediate injection
  setTimeout(() => {
    debouncedInjectJSONButton();
  }, 1000);

  // Watch for dynamic changes with debouncing
  const jsonObserver = new MutationObserver(() => {
    debouncedInjectJSONButton();
  });

  jsonObserver.observe(document.body, OBSERVER_OPTIONS);
  
  console.log('JSON feature initialized');
}