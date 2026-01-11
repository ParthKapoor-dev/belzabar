import { state } from '../../core/state.js';
import { extractMethodName } from '../../utils/dom.js';

// Title update logic
export function updateTitle() {
  const methodName = extractMethodName();
  if (!methodName || methodName === state.lastMethodName) return;

  state.lastMethodName = methodName;
  const baseTitle = document.title.split(' – ')[0];
  document.title = `${baseTitle} – ${methodName}`;
}