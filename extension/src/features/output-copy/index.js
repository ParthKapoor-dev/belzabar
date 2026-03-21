import {
  OUTPUT_CONTAINER_SELECTOR,
  EXTENSION_OWNED_ATTR
} from '../../config/constants.js';
import { showToast } from '../../ui/toast.js';
import { copyText } from '../../utils/clipboard.js';
import { subscribeObserver } from '../../core/observer.js';
import { log } from '../../core/logger.js';
import { ICON_BUTTON_STYLE, ICON_BUTTON_HOVER, ICON_BUTTON_UNHOVER, applyHoverEffect } from '../../ui/styles.js';

const COPY_BOUND_ATTR = 'data-sd-copy-bound';
const CONTROLS_CLASS = 'sdExtensionOutputCopyControls';
const OUTPUT_COPY_HOST_CLASS = 'sdExtensionOutputCopyHost';
const OUTPUT_COPY_STYLES_ID = 'sdExtensionOutputCopyStyles';

let outputInjectionTimer = null;
let unsubscribe = null;
let initialOutputInjectionTimer = null;

function createCopyButton(container) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '⧉';
  button.setAttribute('aria-label', 'Copy output JSON');
  button.setAttribute('title', 'Copy output JSON');

  Object.assign(button.style, ICON_BUTTON_STYLE);
  applyHoverEffect(button, ICON_BUTTON_HOVER, ICON_BUTTON_UNHOVER);

  button.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const textToCopy = extractOutputText(container);
    if (!textToCopy) {
      showToast('Nothing to copy');
      return;
    }

    const copied = await copyText(textToCopy);
    showToast(copied ? 'Output copied' : 'Failed to copy output');
  };

  return button;
}

function extractOutputText(container) {
  const clone = container.cloneNode(true);
  const extensionNodes = clone.querySelectorAll(`[${EXTENSION_OWNED_ATTR}]`);
  for (const node of extensionNodes) {
    node.remove();
  }
  return (clone.innerText || clone.textContent || '').trim();
}

function ensureOutputCopyStyles() {
  if (document.getElementById(OUTPUT_COPY_STYLES_ID)) return;

  const styleEl = document.createElement('style');
  styleEl.id = OUTPUT_COPY_STYLES_ID;
  styleEl.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  styleEl.textContent = `
.${OUTPUT_COPY_HOST_CLASS} {
  position: relative;
}
.${CONTROLS_CLASS} {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 8;
  opacity: 0;
  visibility: hidden;
  transition: opacity 140ms ease, visibility 140ms ease;
}
.${OUTPUT_COPY_HOST_CLASS}:hover > .${CONTROLS_CLASS},
.${OUTPUT_COPY_HOST_CLASS}:focus-within > .${CONTROLS_CLASS} {
  opacity: 1;
  visibility: visible;
}
`;

  document.head.appendChild(styleEl);
}

function injectCopyButtons() {
  ensureOutputCopyStyles();

  const containers = document.querySelectorAll(OUTPUT_CONTAINER_SELECTOR);
  if (containers.length === 0) return;

  for (const container of containers) {
    if (container.getAttribute(COPY_BOUND_ATTR) === 'true') continue;
    if (!container.parentElement) continue;

    const controls = document.createElement('div');
    controls.className = CONTROLS_CLASS;
    controls.setAttribute(EXTENSION_OWNED_ATTR, 'true');
    Object.assign(controls.style, { position: 'absolute', top: '8px', right: '8px' });

    controls.appendChild(createCopyButton(container));
    container.classList.add(OUTPUT_COPY_HOST_CLASS);

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }

    container.appendChild(controls);
    container.setAttribute(COPY_BOUND_ATTR, 'true');
  }
}

function debouncedInjectCopyButtons() {
  if (outputInjectionTimer) {
    clearTimeout(outputInjectionTimer);
  }

  outputInjectionTimer = setTimeout(() => {
    injectCopyButtons();
  }, 300);
}

export function startOutputCopyFeature() {
  log('Initializing output copy feature...');

  initialOutputInjectionTimer = setTimeout(() => {
    injectCopyButtons();
  }, 500);

  if (!unsubscribe) {
    unsubscribe = subscribeObserver(() => {
      debouncedInjectCopyButtons();
    });
  }

  return stopOutputCopyFeature;
}

export function stopOutputCopyFeature() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  if (outputInjectionTimer) {
    clearTimeout(outputInjectionTimer);
    outputInjectionTimer = null;
  }

  if (initialOutputInjectionTimer) {
    clearTimeout(initialOutputInjectionTimer);
    initialOutputInjectionTimer = null;
  }

  const controls = document.querySelectorAll(`.${CONTROLS_CLASS}`);
  for (const control of controls) {
    control.remove();
  }

  const containers = document.querySelectorAll(OUTPUT_CONTAINER_SELECTOR);
  for (const container of containers) {
    container.removeAttribute(COPY_BOUND_ATTR);
    container.classList.remove(OUTPUT_COPY_HOST_CLASS);
  }

  const styleEl = document.getElementById(OUTPUT_COPY_STYLES_ID);
  if (styleEl) {
    styleEl.remove();
  }
}
