import { state } from '../../core/state.js';
import { extractMethodName, extractPageName } from '../../utils/dom.js';
import { OBSERVER_OPTIONS } from '../../config/constants.js';

let titleObserver = null;

// Title update logic
export function updateTitle() {
  const pathname = window.location.pathname;
  let name = null;
  let prefix = '';

  if (pathname.startsWith('/automation-designer/')) {
    name = extractMethodName();
    prefix = 'AD';
  } else if (pathname.startsWith('/ui-designer/')) {
    name = extractPageName();
    prefix = 'PD';
  }

  if (!name || name === state.lastMethodName) return;

  state.lastMethodName = name;
  document.title = `${prefix}: ${name}`;
}

export function startTitleUpdaterFeature() {
  updateTitle();

  if (!titleObserver) {
    titleObserver = new MutationObserver(updateTitle);
    titleObserver.observe(document.body, OBSERVER_OPTIONS);
  }

  return stopTitleUpdaterFeature;
}

export function stopTitleUpdaterFeature() {
  if (titleObserver) {
    titleObserver.disconnect();
    titleObserver = null;
  }
}
