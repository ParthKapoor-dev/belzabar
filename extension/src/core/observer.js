import { OBSERVER_OPTIONS } from '../config/constants.js';

const POLL_FALLBACK_MS = 1000;

let observer = null;
let pollTimer = null;
const subscribers = new Set();

function fireAll() {
  for (const callback of subscribers) {
    try {
      callback();
    } catch (error) {
      console.error('Observer subscriber failed:', error);
    }
  }
}

export function subscribeObserver(callback) {
  subscribers.add(callback);

  if (!observer) {
    observer = new MutationObserver(fireAll);
    observer.observe(document.body, OBSERVER_OPTIONS);
  }

  if (!pollTimer) {
    pollTimer = setInterval(fireAll, POLL_FALLBACK_MS);
  }

  try {
    callback();
  } catch (error) {
    console.error('Observer subscriber failed on initial call:', error);
  }

  return () => unsubscribeObserver(callback);
}

export function unsubscribeObserver(callback) {
  subscribers.delete(callback);

  if (subscribers.size === 0) {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
}
