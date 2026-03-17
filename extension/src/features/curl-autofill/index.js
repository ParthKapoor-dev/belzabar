import { syncJSONToInputs } from '../json-editor/sync.js';
import { extractAllInputs } from '../json-editor/extractor.js';
import { showToast } from '../../ui/toast.js';

const PARAM = '_belz_autofill';
const POLL_INTERVAL_MS = 400;
const LOG = (...args) => console.log('[belz autofill]', ...args);

export function startCurlAutofillFeature() {
  if (!window.location.pathname.startsWith('/automation-designer/')) return;

  const params = new URLSearchParams(window.location.search);
  const encoded = params.get(PARAM);
  if (!encoded) return;

  LOG('param detected, removing from URL');
  history.replaceState(null, '', window.location.pathname);

  let jsonString;
  try {
    jsonString = atob(encoded);
    const parsed = JSON.parse(jsonString);
    LOG('decoded JSON successfully, keys:', Object.keys(parsed));
  } catch (err) {
    LOG('failed to decode/parse param:', err);
    return;
  }

  waitForPageTitleThenSync(jsonString);
}

function waitForPageTitle() {
  const initialTitle = document.title;
  LOG('waiting for page title (current:', JSON.stringify(initialTitle), ')');
  return new Promise(resolve => {
    const check = setInterval(() => {
      const current = document.title;
      if (current && current !== initialTitle) {
        clearInterval(check);
        resolve(current);
      }
    }, 200);
  });
}

async function waitForPageTitleThenSync(jsonString) {
  const title = await waitForPageTitle();
  LOG('page title ready:', JSON.stringify(title), '— starting input poll');

  let attempt = 0;

  const timer = setInterval(async () => {
    attempt++;

    const rawCount = document.querySelectorAll('[id^="INPUT_LIST_"]').length;
    const inputs = extractAllInputs(true);
    LOG(`attempt ${attempt}: ${inputs.length} inputs extracted (${rawCount} INPUT_LIST_* ids)`);
    if (inputs.length === 0) return;

    clearInterval(timer);

    // Small pause to let Angular finish any pending bindings after the last render
    await new Promise(r => setTimeout(r, 500));

    LOG('calling syncJSONToInputs...');
    const result = await syncJSONToInputs(jsonString);
    LOG('sync result:', JSON.stringify(result, null, 2));

    if (result.skippedMissingKeys?.length) {
      LOG('skipped (no matching input on page):', result.skippedMissingKeys);
    }
    if (result.failedKeys?.length) {
      LOG('failed to populate:', result.failedKeys);
    }
    if (result.errors?.length) {
      LOG('errors:', result.errors);
    }

    if (result.success) {
      showToast(`Autofill: filled ${result.filledCount} input${result.filledCount === 1 ? '' : 's'}`);
    } else {
      showToast(`Autofill: filled ${result.filledCount}, check console for details`);
    }
  }, POLL_INTERVAL_MS);
}
