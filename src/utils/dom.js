import { METHOD_INPUT_SELECTOR } from '../config/constants.js';

// DOM helper utilities
export function extractMethodName() {
  const input = document.querySelector(METHOD_INPUT_SELECTOR);
  if (!input || !input.value) return null;
  return input.value.trim();
}

export function isEditableElement(el) {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();

  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = (el.type || '').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type);
  }

  return el.isContentEditable === true;
}