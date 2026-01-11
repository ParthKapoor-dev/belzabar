import { DEBUG } from '../config/constants.js';

// Debug logging utilities
export function log(...args) {
  if (DEBUG) {
    console.log('[SD Extension]', ...args);
  }
}

export function logError(...args) {
  console.error('[SD Extension Error]', ...args);
}