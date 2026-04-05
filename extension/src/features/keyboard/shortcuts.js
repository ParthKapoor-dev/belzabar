import { triggerRunTest } from '../run-test/index.js';
import { isModalInteractionLocked } from '../../ui/modal-lock.js';
import { extractMethodName, extractServiceCategory } from '../../utils/dom.js';
import { showToast } from '../../ui/toast.js';

let shortcutListenerAttached = false;

// Keyboard shortcut handler
export function handleKeydown(event) {
  if (isModalInteractionLocked()) return;

  if (event.ctrlKey && event.shiftKey && event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    triggerRunTest();
    return;
  }

  if (event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === 'L') {
    if (!window.location.pathname.startsWith('/automation-designer/')) return;

    const tag = document.activeElement?.tagName;
    const editable = document.activeElement?.isContentEditable;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable) return;

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

export function startRunTestShortcutFeature() {
  if (!shortcutListenerAttached) {
    document.addEventListener('keydown', handleKeydown, true);
    shortcutListenerAttached = true;
  }

  return stopRunTestShortcutFeature;
}

export function stopRunTestShortcutFeature() {
  if (!shortcutListenerAttached) return;
  document.removeEventListener('keydown', handleKeydown, true);
  shortcutListenerAttached = false;
}
