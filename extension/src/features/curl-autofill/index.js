import { syncJSONToInputs } from '../json-editor/sync.js';
import { showToast } from '../../ui/toast.js';

const PARAM = '_belz_autofill';
const MAX_WAIT_MS = 12000;
const POLL_INTERVAL_MS = 300;

export function startCurlAutofillFeature() {
  if (!window.location.pathname.startsWith('/automation-designer/')) return;

  const params = new URLSearchParams(window.location.search);
  const encoded = params.get(PARAM);
  if (!encoded) return;

  history.replaceState(null, '', window.location.pathname);

  let jsonString;
  try {
    jsonString = atob(encoded);
    JSON.parse(jsonString);
  } catch {
    return;
  }

  waitForInputsThenSync(jsonString);
}

async function waitForInputsThenSync(jsonString) {
  const deadline = Date.now() + MAX_WAIT_MS;

  const timer = setInterval(async () => {
    const inputs = document.querySelectorAll('[id^="INPUT_LIST_"]');

    if (inputs.length === 0 && Date.now() < deadline) return;

    clearInterval(timer);

    if (inputs.length === 0) {
      showToast('Autofill: no inputs found on page');
      return;
    }

    const result = await syncJSONToInputs(jsonString);
    if (result.success) {
      showToast(`Autofill: filled ${result.filledCount} input${result.filledCount === 1 ? '' : 's'}`);
    } else {
      showToast('Autofill: sync failed');
    }
  }, POLL_INTERVAL_MS);
}
