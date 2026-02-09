import { isEditableElement } from '../../utils/dom.js';
import { triggerRunTest } from '../run-test/index.js';

// Keyboard shortcut handler
export function handleKeydown(event) {
  if (
    event.ctrlKey &&
    event.shiftKey &&
    event.key === 'Enter'
  ) {
    if (isEditableElement(document.activeElement)) return;

    event.preventDefault();
    event.stopPropagation();

    triggerRunTest();
  }
}