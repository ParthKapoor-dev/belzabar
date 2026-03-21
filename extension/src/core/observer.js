import { OBSERVER_OPTIONS } from '../config/constants.js';

let observer = null;
const subscribers = new Set();

function onMutation(mutations) {
  for (const callback of subscribers) {
    callback(mutations);
  }
}

export function subscribeObserver(callback) {
  subscribers.add(callback);

  if (!observer) {
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, OBSERVER_OPTIONS);
  }

  return () => unsubscribeObserver(callback);
}

export function unsubscribeObserver(callback) {
  subscribers.delete(callback);

  if (subscribers.size === 0 && observer) {
    observer.disconnect();
    observer = null;
  }
}
