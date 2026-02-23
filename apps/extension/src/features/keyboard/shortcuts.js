import { triggerRunTest } from '../run-test/index.js';

// Keyboard shortcut handler
export function handleKeydown(event) {
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
