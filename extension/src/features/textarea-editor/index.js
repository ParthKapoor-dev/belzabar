import { state } from '../../core/state.js';
import { log } from '../../core/logger.js';
import { showToast } from '../../ui/toast.js';
import {
  OBSERVER_OPTIONS,
  TEXTAREA_SELECTOR,
  TEXTAREA_EDITOR_BOUND_ATTR,
  TEXTAREA_EDITOR_LAUNCHER_CLASS,
  EXTENSION_OWNED_ATTR
} from '../../config/constants.js';
import { closeTextareaEditor, openTextareaEditor } from './modal.js';

const TEXTAREA_EDITOR_ID_ATTR = 'data-sd-textarea-editor-id';
const TEXTAREA_EDITOR_FOR_ATTR = 'data-sd-textarea-editor-for';
const TEXTAREA_COPY_FOR_ATTR = 'data-sd-textarea-copy-for';
const TEXTAREA_WRAPPED_ATTR = 'data-sd-textarea-overlay-wrapped';
const TEXTAREA_OVERLAY_WRAPPER_CLASS = 'sdExtensionTextareaOverlayWrapper';
const TEXTAREA_EDITOR_CONTROLS_CLASS = 'sdExtensionTextareaLauncherControls';
const TEXTAREA_COPY_BUTTON_CLASS = 'sdExtensionTextareaCopyButton';
const TEXTAREA_OVERLAY_STYLES_ID = 'sdExtensionTextareaOverlayStyles';

const textareaLayoutBindings = new Map();

let layoutRefreshTimer = null;
let viewportLayoutListenerAttached = false;
let textareaEditorIdCounter = 0;
let textareaObserver = null;
let initialTextareaInjectionTimer = null;

function getTextareaEditorId(textarea) {
  let id = textarea.getAttribute(TEXTAREA_EDITOR_ID_ATTR);
  if (!id) {
    textareaEditorIdCounter += 1;
    id = `sd-textarea-${textareaEditorIdCounter}`;
    textarea.setAttribute(TEXTAREA_EDITOR_ID_ATTR, id);
  }
  return id;
}

function getOverlayWrapperForTextarea(textarea) {
  const parent = textarea?.parentElement;
  if (!parent) return null;
  if (
    parent.classList.contains(TEXTAREA_OVERLAY_WRAPPER_CLASS) &&
    parent.getAttribute(EXTENSION_OWNED_ATTR) === 'true'
  ) {
    return parent;
  }
  return null;
}

function removeStaleControlsForTextarea(textareaId, validWrapper) {
  const staleControls = document.querySelectorAll(
    `.${TEXTAREA_EDITOR_CONTROLS_CLASS}[${TEXTAREA_EDITOR_FOR_ATTR}="${textareaId}"]`
  );
  for (const control of staleControls) {
    if (control.parentElement !== validWrapper) {
      control.remove();
    }
  }
}

function hasAttachedLauncher(textarea) {
  const textareaId = getTextareaEditorId(textarea);
  const wrapper = getOverlayWrapperForTextarea(textarea);
  if (!wrapper) return false;

  removeStaleControlsForTextarea(textareaId, wrapper);

  const controls = wrapper.querySelector(
    `.${TEXTAREA_EDITOR_CONTROLS_CLASS}[${TEXTAREA_EDITOR_FOR_ATTR}="${textareaId}"]`
  );
  if (!controls) return false;

  const launcher = controls.querySelector(
    `.${TEXTAREA_EDITOR_LAUNCHER_CLASS}[${TEXTAREA_EDITOR_FOR_ATTR}="${textareaId}"]`
  );
  if (!launcher) {
    controls.remove();
    return false;
  }

  return true;
}

function ensureOverlayStyles() {
  if (document.getElementById(TEXTAREA_OVERLAY_STYLES_ID)) return;

  const styleEl = document.createElement('style');
  styleEl.id = TEXTAREA_OVERLAY_STYLES_ID;
  styleEl.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  styleEl.textContent = `
.${TEXTAREA_OVERLAY_WRAPPER_CLASS} {
  position: relative;
  display: block;
}
.${TEXTAREA_EDITOR_CONTROLS_CLASS} {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  opacity: 0;
  visibility: hidden;
  transition: opacity 140ms ease, visibility 140ms ease;
  z-index: 8;
  pointer-events: none;
}
.${TEXTAREA_OVERLAY_WRAPPER_CLASS}:hover > .${TEXTAREA_EDITOR_CONTROLS_CLASS},
.${TEXTAREA_OVERLAY_WRAPPER_CLASS}:focus-within > .${TEXTAREA_EDITOR_CONTROLS_CLASS} {
  opacity: 1;
  visibility: visible;
}
.${TEXTAREA_EDITOR_CONTROLS_CLASS} .${TEXTAREA_EDITOR_LAUNCHER_CLASS},
.${TEXTAREA_EDITOR_CONTROLS_CLASS} .${TEXTAREA_COPY_BUTTON_CLASS} {
  pointer-events: auto;
}
`;

  document.head.appendChild(styleEl);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      log('Navigator clipboard copy failed, using fallback:', error);
    }
  }

  const tempTextarea = document.createElement('textarea');
  tempTextarea.value = text;
  tempTextarea.setAttribute('readonly', '');
  tempTextarea.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  Object.assign(tempTextarea.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    opacity: '0'
  });

  document.body.appendChild(tempTextarea);
  tempTextarea.select();
  tempTextarea.setSelectionRange(0, tempTextarea.value.length);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (error) {
    console.error('Clipboard fallback copy failed:', error);
  }

  tempTextarea.remove();
  return copied;
}

function isEligibleTextarea(textarea) {
  if (!textarea || textarea.tagName.toLowerCase() !== 'textarea') return false;

  const closestOwned = textarea.closest(`[${EXTENSION_OWNED_ATTR}]`);
  if (
    closestOwned &&
    !closestOwned.classList.contains(TEXTAREA_OVERLAY_WRAPPER_CLASS)
  ) {
    return false;
  }

  if (hasAttachedLauncher(textarea)) {
    textarea.setAttribute(TEXTAREA_EDITOR_BOUND_ATTR, 'true');
    return false;
  }

  return true;
}

function wrapTextarea(textarea) {
  const existingWrapper = getOverlayWrapperForTextarea(textarea);
  if (existingWrapper) return existingWrapper;
  if (!textarea.parentElement) return null;

  const wrapper = document.createElement('div');
  wrapper.className = TEXTAREA_OVERLAY_WRAPPER_CLASS;
  wrapper.setAttribute(EXTENSION_OWNED_ATTR, 'true');

  textarea.parentElement.insertBefore(wrapper, textarea);
  wrapper.appendChild(textarea);
  textarea.setAttribute(TEXTAREA_WRAPPED_ATTR, 'true');

  return wrapper;
}

function syncControlSizing(textarea, controls) {
  if (!textarea || !controls) return;

  const height = Math.max(textarea.offsetHeight, 0);
  const compact = height > 0 && height < 36;
  const buttonSize = compact ? Math.max(16, Math.min(22, height - 4)) : 28;
  const glyphSize = Math.max(10, Math.round(buttonSize * 0.5));

  const openButton = controls.querySelector(`.${TEXTAREA_EDITOR_LAUNCHER_CLASS}`);
  if (openButton) {
    Object.assign(openButton.style, {
      width: `${buttonSize}px`,
      height: `${buttonSize}px`,
      fontSize: `${Math.max(glyphSize, 11)}px`
    });
  }

  const copyButton = controls.querySelector(`.${TEXTAREA_COPY_BUTTON_CLASS}`);
  if (copyButton) {
    Object.assign(copyButton.style, {
      width: `${buttonSize}px`,
      height: `${buttonSize}px`,
      fontSize: `${Math.max(glyphSize - 1, 10)}px`,
      borderRadius: compact ? '6px' : '8px'
    });
  }
}

function createLauncher(textarea) {
  const textareaId = getTextareaEditorId(textarea);
  const controls = document.createElement('div');
  controls.className = TEXTAREA_EDITOR_CONTROLS_CLASS;
  controls.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  controls.setAttribute(TEXTAREA_EDITOR_FOR_ATTR, textareaId);
  Object.assign(controls.style, {
    position: 'absolute',
    top: '6px',
    right: '6px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '6px'
  });

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = TEXTAREA_EDITOR_LAUNCHER_CLASS;
  openButton.textContent = '⤢';
  openButton.setAttribute('title', 'Open large editor');
  openButton.setAttribute('aria-label', 'Open large editor');
  openButton.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  openButton.setAttribute(TEXTAREA_EDITOR_FOR_ATTR, textareaId);

  Object.assign(openButton.style, {
    width: '28px',
    height: '28px',
    border: '1px solid rgba(59, 130, 246, 0.45)',
    background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
    color: '#ffffff',
    borderRadius: '999px',
    padding: '0',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    boxShadow: '0 4px 10px rgba(37, 99, 235, 0.28)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'transform 140ms ease, filter 140ms ease, box-shadow 140ms ease'
  });

  openButton.addEventListener('mouseenter', () => {
    openButton.style.transform = 'translateY(-1px)';
    openButton.style.filter = 'brightness(1.05)';
    openButton.style.boxShadow = '0 6px 14px rgba(37, 99, 235, 0.34)';
  });
  openButton.addEventListener('mouseleave', () => {
    openButton.style.transform = 'translateY(0)';
    openButton.style.filter = 'none';
    openButton.style.boxShadow = '0 4px 10px rgba(37, 99, 235, 0.28)';
  });

  openButton.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openTextareaEditor(textarea);
  };

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = TEXTAREA_COPY_BUTTON_CLASS;
  copyButton.textContent = '⧉';
  copyButton.setAttribute('title', 'Copy textarea content');
  copyButton.setAttribute('aria-label', 'Copy textarea content');
  copyButton.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  copyButton.setAttribute(TEXTAREA_COPY_FOR_ATTR, textareaId);

  Object.assign(copyButton.style, {
    width: '28px',
    height: '28px',
    border: '1px solid rgba(59, 130, 246, 0.45)',
    background: 'rgba(15, 23, 42, 0.88)',
    color: '#e2e8f0',
    borderRadius: '8px',
    padding: '0',
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
    boxShadow: '0 4px 10px rgba(15, 23, 42, 0.35)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'transform 140ms ease, filter 140ms ease, box-shadow 140ms ease'
  });

  copyButton.addEventListener('mouseenter', () => {
    copyButton.style.transform = 'translateY(-1px)';
    copyButton.style.filter = 'brightness(1.06)';
    copyButton.style.boxShadow = '0 6px 14px rgba(15, 23, 42, 0.42)';
  });
  copyButton.addEventListener('mouseleave', () => {
    copyButton.style.transform = 'translateY(0)';
    copyButton.style.filter = 'none';
    copyButton.style.boxShadow = '0 4px 10px rgba(15, 23, 42, 0.35)';
  });

  copyButton.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const textToCopy = textarea.value || '';
    if (!textToCopy.trim()) {
      showToast('Nothing to copy');
      return;
    }

    const copied = await copyText(textToCopy);
    showToast(copied ? 'Textarea copied' : 'Failed to copy textarea');
  };

  controls.appendChild(openButton);
  controls.appendChild(copyButton);

  const existingBinding = textareaLayoutBindings.get(textareaId);
  if (existingBinding?.textarea && existingBinding?.relayout) {
    existingBinding.textarea.removeEventListener('input', existingBinding.relayout);
    existingBinding.textarea.removeEventListener('focus', existingBinding.relayout);
    existingBinding.textarea.removeEventListener('blur', existingBinding.relayout);
  }

  const relayout = () => {
    syncControlSizing(textarea, controls);
  };
  textarea.addEventListener('input', relayout);
  textarea.addEventListener('focus', relayout);
  textarea.addEventListener('blur', relayout);
  textareaLayoutBindings.set(textareaId, { textarea, relayout });

  requestAnimationFrame(relayout);
  return controls;
}

function refreshAllTextareaControlLayouts() {
  const controlsList = document.querySelectorAll(`.${TEXTAREA_EDITOR_CONTROLS_CLASS}`);
  for (const controls of controlsList) {
    const textareaId = controls.getAttribute(TEXTAREA_EDITOR_FOR_ATTR);
    if (!textareaId) continue;
    const textarea = document.querySelector(
      `${TEXTAREA_SELECTOR}[${TEXTAREA_EDITOR_ID_ATTR}="${textareaId}"]`
    );
    if (!textarea) continue;
    syncControlSizing(textarea, controls);
  }
}

function debouncedRefreshAllLayouts() {
  if (layoutRefreshTimer) {
    clearTimeout(layoutRefreshTimer);
  }

  layoutRefreshTimer = setTimeout(() => {
    refreshAllTextareaControlLayouts();
    layoutRefreshTimer = null;
  }, 80);
}

function attachViewportLayoutListener() {
  if (viewportLayoutListenerAttached) return;
  viewportLayoutListenerAttached = true;
  window.addEventListener('resize', debouncedRefreshAllLayouts);
}

function detachViewportLayoutListener() {
  if (!viewportLayoutListenerAttached) return;
  window.removeEventListener('resize', debouncedRefreshAllLayouts);
  viewportLayoutListenerAttached = false;
}

function injectTextareaLaunchers() {
  ensureOverlayStyles();
  attachViewportLayoutListener();

  const textareas = document.querySelectorAll(TEXTAREA_SELECTOR);
  if (textareas.length === 0) return;

  for (const textarea of textareas) {
    if (!isEligibleTextarea(textarea)) continue;
    if (!textarea.parentElement) continue;

    const wrapper = wrapTextarea(textarea);
    if (!wrapper) continue;

    const textareaId = getTextareaEditorId(textarea);
    removeStaleControlsForTextarea(textareaId, wrapper);

    wrapper.appendChild(createLauncher(textarea));
    textarea.setAttribute(TEXTAREA_EDITOR_BOUND_ATTR, 'true');
  }

  refreshAllTextareaControlLayouts();
}

function debouncedInjectTextareaLaunchers() {
  if (state.textareaEditorInjectionTimer) {
    clearTimeout(state.textareaEditorInjectionTimer);
  }

  state.textareaEditorInjectionTimer = setTimeout(() => {
    injectTextareaLaunchers();
    refreshAllTextareaControlLayouts();
  }, 300);
}

function unwrapTextarea(wrapper) {
  if (!wrapper?.parentElement) {
    wrapper?.remove();
    return;
  }

  const textarea = wrapper.querySelector(TEXTAREA_SELECTOR);
  if (!textarea) {
    wrapper.remove();
    return;
  }

  wrapper.parentElement.insertBefore(textarea, wrapper);
  textarea.removeAttribute(TEXTAREA_WRAPPED_ATTR);
  wrapper.remove();
}

export function startTextareaEditorFeature() {
  log('Initializing textarea editor feature...');

  initialTextareaInjectionTimer = setTimeout(() => {
    injectTextareaLaunchers();
  }, 700);

  if (!textareaObserver) {
    textareaObserver = new MutationObserver(() => {
      debouncedInjectTextareaLaunchers();
      debouncedRefreshAllLayouts();
    });

    textareaObserver.observe(document.body, OBSERVER_OPTIONS);
  }

  return stopTextareaEditorFeature;
}

export function stopTextareaEditorFeature() {
  if (textareaObserver) {
    textareaObserver.disconnect();
    textareaObserver = null;
  }

  if (initialTextareaInjectionTimer) {
    clearTimeout(initialTextareaInjectionTimer);
    initialTextareaInjectionTimer = null;
  }

  if (state.textareaEditorInjectionTimer) {
    clearTimeout(state.textareaEditorInjectionTimer);
    state.textareaEditorInjectionTimer = null;
  }

  if (layoutRefreshTimer) {
    clearTimeout(layoutRefreshTimer);
    layoutRefreshTimer = null;
  }

  detachViewportLayoutListener();
  closeTextareaEditor();

  for (const binding of textareaLayoutBindings.values()) {
    if (!binding?.textarea || !binding?.relayout) continue;
    binding.textarea.removeEventListener('input', binding.relayout);
    binding.textarea.removeEventListener('focus', binding.relayout);
    binding.textarea.removeEventListener('blur', binding.relayout);
  }
  textareaLayoutBindings.clear();

  const controls = document.querySelectorAll(`.${TEXTAREA_EDITOR_CONTROLS_CLASS}`);
  for (const control of controls) {
    control.remove();
  }

  const wrappers = document.querySelectorAll(
    `.${TEXTAREA_OVERLAY_WRAPPER_CLASS}[${EXTENSION_OWNED_ATTR}="true"]`
  );
  for (const wrapper of wrappers) {
    unwrapTextarea(wrapper);
  }

  const styleEl = document.getElementById(TEXTAREA_OVERLAY_STYLES_ID);
  if (styleEl) {
    styleEl.remove();
  }

  const textareas = document.querySelectorAll(TEXTAREA_SELECTOR);
  for (const textarea of textareas) {
    textarea.removeAttribute(TEXTAREA_EDITOR_BOUND_ATTR);
    textarea.removeAttribute(TEXTAREA_WRAPPED_ATTR);
  }
}
