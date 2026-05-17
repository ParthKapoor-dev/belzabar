import { triggerRunTest } from '../run-test/index.js';
import { isModalInteractionLocked } from '../../ui/modal-lock.js';
import { extractMethodName, extractServiceCategory } from '../../utils/dom.js';
import { showToast } from '../../ui/toast.js';
import { subscribeObserver } from '../../core/observer.js';

// Window within which a second Escape press counts as an "Esc Esc".
const DOUBLE_ESCAPE_WINDOW_MS = 500;
// Pause after committing a field so the AD app processes the blur/change
// before the test is triggered.
const COMMIT_SETTLE_MS = 150;

let observerUnsubscribe = null;
let lastEscapeTime = 0;

// Fields whose edits the AD app only commits once focus leaves them.
function isEditableElement(element) {
  if (!element) return false;
  const tag = element.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    element.isContentEditable === true
  );
}

// Move focus off the active field so its pending value is registered. AD test
// inputs only commit an edit on blur, so an in-place edit is otherwise lost
// when a shortcut acts on the page.
function commitActiveElement() {
  const element = document.activeElement;
  if (!isEditableElement(element)) return false;

  element.dispatchEvent(new Event('change', { bubbles: true }));
  if (typeof element.blur === 'function') {
    element.blur();
  }
  element.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
}

// Keyboard shortcut handler
export function handleKeydown(event) {
  if (isModalInteractionLocked()) return;

  // Run Test — Ctrl+Shift+Enter. Commit any focused field first so the test
  // runs against the edited value rather than a stale one.
  if (event.ctrlKey && event.shiftKey && event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    if (commitActiveElement()) {
      // Give the AD app a moment to register the blur before running.
      setTimeout(triggerRunTest, COMMIT_SETTLE_MS);
    } else {
      triggerRunTest();
    }
    return;
  }

  // Esc Esc — return focus to the page so a pending textbox edit registers.
  if (event.key === 'Escape') {
    const now = Date.now();
    const isDoubleEscape = now - lastEscapeTime <= DOUBLE_ESCAPE_WINDOW_MS;
    if (isDoubleEscape && isEditableElement(document.activeElement)) {
      lastEscapeTime = 0;
      event.preventDefault();
      event.stopPropagation();
      commitActiveElement();
      showToast('Focus returned to page');
    } else {
      lastEscapeTime = now;
    }
    return;
  }

  // Copy AD rich link — Shift+L (ignored while typing in a field).
  if (event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === 'L') {
    if (!window.location.pathname.startsWith('/automation-designer/')) return;
    if (isEditableElement(document.activeElement)) return;

    event.preventDefault();
    event.stopPropagation();
    copyAdRichLink();
  }
}

async function copyAdRichLink() {
  const category = extractServiceCategory();
  const name = extractMethodName();
  const url = window.location.href;

  const label = [category, name].filter(Boolean).join('::');

  const html = `<a href="${url}">${label}</a>`;
  const plain = `[${label}](${url})`;

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' })
      })
    ]);
    showToast(`Copied: ${label}`);
  } catch {
    // fallback: plain URL
    try {
      await navigator.clipboard.writeText(plain);
      showToast('Copied link (plain)');
    } catch {
      showToast('Failed to copy link');
    }
  }
}

// Idempotently (re)attach the keydown listener. Bound to `window` so it
// survives the AD app replacing parts of the document, and the leading
// removeEventListener guarantees the listener is never stacked twice.
function ensureShortcutListener() {
  window.removeEventListener('keydown', handleKeydown, true);
  window.addEventListener('keydown', handleKeydown, true);
}

export function startRunTestShortcutFeature() {
  ensureShortcutListener();

  // Re-assert the listener on DOM churn (and via the observer's poll). The
  // previous flag-guarded attach could go stale: once the listener was
  // dropped, the shortcuts stayed dead until a settings toggle re-attached
  // them. Self-healing here keeps them working without that toggle.
  if (!observerUnsubscribe) {
    observerUnsubscribe = subscribeObserver(ensureShortcutListener);
  }

  return stopRunTestShortcutFeature;
}

export function stopRunTestShortcutFeature() {
  window.removeEventListener('keydown', handleKeydown, true);

  if (observerUnsubscribe) {
    observerUnsubscribe();
    observerUnsubscribe = null;
  }
}
