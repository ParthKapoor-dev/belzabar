import { state } from '../../core/state.js';
import { log } from '../../core/logger.js';
import {
  OBSERVER_OPTIONS,
  TEXTAREA_SELECTOR,
  TEXTAREA_EDITOR_BOUND_ATTR,
  TEXTAREA_EDITOR_LAUNCHER_CLASS,
  EXTENSION_OWNED_ATTR
} from '../../config/constants.js';
import { openTextareaEditor } from './modal.js';

const TEXTAREA_EDITOR_ID_ATTR = 'data-sd-textarea-editor-id';
const TEXTAREA_EDITOR_FOR_ATTR = 'data-sd-textarea-editor-for';
const TEXTAREA_EDITOR_CONTROLS_CLASS = 'sdExtensionTextareaLauncherControls';
let textareaEditorIdCounter = 0;

function getTextareaEditorId(textarea) {
  let id = textarea.getAttribute(TEXTAREA_EDITOR_ID_ATTR);
  if (!id) {
    textareaEditorIdCounter += 1;
    id = `sd-textarea-${textareaEditorIdCounter}`;
    textarea.setAttribute(TEXTAREA_EDITOR_ID_ATTR, id);
  }
  return id;
}

function findLauncherForTextarea(textarea) {
  const textareaId = getTextareaEditorId(textarea);
  return document.querySelector(
    `.${TEXTAREA_EDITOR_LAUNCHER_CLASS}[${TEXTAREA_EDITOR_FOR_ATTR}="${textareaId}"]`
  );
}

function hasAttachedLauncher(textarea) {
  const launcher = findLauncherForTextarea(textarea);
  if (!launcher) return false;

  const controls = launcher.closest(`.${TEXTAREA_EDITOR_CONTROLS_CLASS}`);
  if (!controls || controls.parentElement !== textarea.parentElement) {
    launcher.remove();
    return false;
  }

  return true;
}

function isEligibleTextarea(textarea) {
  if (!textarea || textarea.tagName.toLowerCase() !== 'textarea') return false;
  if (textarea.closest(`[${EXTENSION_OWNED_ATTR}]`)) return false;
  if (
    textarea.getAttribute(TEXTAREA_EDITOR_BOUND_ATTR) === 'true' &&
    hasAttachedLauncher(textarea)
  ) {
    return false;
  }
  return true;
}

function createLauncher(textarea) {
  const textareaId = getTextareaEditorId(textarea);
  const controls = document.createElement('div');
  controls.className = TEXTAREA_EDITOR_CONTROLS_CLASS;
  controls.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  Object.assign(controls.style, {
    display: 'flex',
    justifyContent: 'flex-end',
    width: '100%',
    marginBottom: '6px'
  });

  const button = document.createElement('button');
  button.type = 'button';
  button.className = TEXTAREA_EDITOR_LAUNCHER_CLASS;
  button.textContent = 'Open';
  button.setAttribute('title', 'Open large editor');
  button.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  button.setAttribute(TEXTAREA_EDITOR_FOR_ATTR, textareaId);

  Object.assign(button.style, {
    position: 'relative',
    border: '1px solid rgba(59, 130, 246, 0.45)',
    background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
    color: '#ffffff',
    borderRadius: '6px',
    padding: '4px 10px',
    fontSize: '11px',
    fontWeight: '600',
    cursor: 'pointer',
    boxShadow: '0 4px 10px rgba(37, 99, 235, 0.3)',
    transition: 'transform 140ms ease, filter 140ms ease, box-shadow 140ms ease'
  });

  button.addEventListener('mouseenter', () => {
    button.style.transform = 'translateY(-1px)';
    button.style.filter = 'brightness(1.05)';
    button.style.boxShadow = '0 6px 14px rgba(37, 99, 235, 0.35)';
  });
  button.addEventListener('mouseleave', () => {
    button.style.transform = 'translateY(0)';
    button.style.filter = 'none';
    button.style.boxShadow = '0 4px 10px rgba(37, 99, 235, 0.3)';
  });

  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openTextareaEditor(textarea);
  };

  controls.appendChild(button);
  return controls;
}

function injectTextareaLaunchers() {
  const textareas = document.querySelectorAll(TEXTAREA_SELECTOR);
  if (textareas.length === 0) return;

  for (const textarea of textareas) {
    if (!isEligibleTextarea(textarea)) continue;
    if (!textarea.parentElement) continue;

    textarea.parentElement.insertBefore(createLauncher(textarea), textarea);
    textarea.setAttribute(TEXTAREA_EDITOR_BOUND_ATTR, 'true');
  }
}

function debouncedInjectTextareaLaunchers() {
  if (state.textareaEditorInjectionTimer) {
    clearTimeout(state.textareaEditorInjectionTimer);
  }

  state.textareaEditorInjectionTimer = setTimeout(() => {
    injectTextareaLaunchers();
  }, 300);
}

export function initTextareaEditorFeature() {
  log('Initializing textarea editor feature...');

  setTimeout(() => {
    injectTextareaLaunchers();
  }, 700);

  const observer = new MutationObserver(() => {
    debouncedInjectTextareaLaunchers();
  });

  observer.observe(document.body, OBSERVER_OPTIONS);
}
