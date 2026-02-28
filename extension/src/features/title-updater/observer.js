import { OBSERVER_OPTIONS } from '../../config/constants.js';
import { updateTitle } from './index.js';

// DOM observer for title
export function setupObserver() {
  const observer = new MutationObserver(updateTitle);
  observer.observe(document.body, OBSERVER_OPTIONS);
}