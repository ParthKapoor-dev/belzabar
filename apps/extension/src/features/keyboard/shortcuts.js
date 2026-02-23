import { triggerRunTest } from '../run-test/index.js';
import { isModalInteractionLocked } from '../../ui/modal-lock.js';

let shortcutListenerAttached = false;

// Keyboard shortcut handler
export function handleKeydown(event) {
  if (isModalInteractionLocked()) return;

  if (
    event.ctrlKey &&
    event.shiftKey &&
    event.key === 'Enter'
  ) {
    event.preventDefault();
    event.stopPropagation();

    triggerRunTest();
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
