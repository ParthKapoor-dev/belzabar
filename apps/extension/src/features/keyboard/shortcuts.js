import { triggerRunTest } from '../run-test/index.js';
import { isModalInteractionLocked } from '../../ui/modal-lock.js';

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
