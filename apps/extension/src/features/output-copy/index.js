import {
  OUTPUT_CONTAINER_SELECTOR,
  OBSERVER_OPTIONS,
  EXTENSION_OWNED_ATTR
} from '../../config/constants.js';
import { showToast } from '../../ui/toast.js';
import { log } from '../../core/logger.js';

const COPY_BOUND_ATTR = 'data-sd-copy-bound';
const CONTROLS_CLASS = 'sdExtensionOutputCopyControls';
const OUTPUT_COPY_HOST_CLASS = 'sdExtensionOutputCopyHost';
const OUTPUT_COPY_STYLES_ID = 'sdExtensionOutputCopyStyles';

let outputInjectionTimer = null;
let outputObserver = null;
let initialOutputInjectionTimer = null;

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      log('Navigator clipboard copy failed, using fallback:', error);
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute(EXTENSION_OWNED_ATTR, 'true');

  Object.assign(textarea.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    opacity: '0'
  });

  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (error) {
    console.error('Clipboard fallback copy failed:', error);
  }

  textarea.remove();
  return copied;
}

function createCopyButton(container) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '⧉';
  button.setAttribute('aria-label', 'Copy output JSON');
  button.setAttribute('title', 'Copy output JSON');

  Object.assign(button.style, {
    width: '28px',
    height: '28px',
    padding: '0',
    borderRadius: '8px',
    border: '1px solid rgba(59, 130, 246, 0.45)',
    background: 'rgba(15, 23, 42, 0.88)',
    color: '#e2e8f0',
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'transform 140ms ease, box-shadow 140ms ease, filter 140ms ease',
    boxShadow: '0 4px 10px rgba(15, 23, 42, 0.35)'
  });

  button.addEventListener('mouseenter', () => {
    button.style.transform = 'translateY(-1px)';
    button.style.filter = 'brightness(1.05)';
    button.style.boxShadow = '0 6px 14px rgba(15, 23, 42, 0.42)';
  });

  button.addEventListener('mouseleave', () => {
    button.style.transform = 'translateY(0)';
    button.style.filter = 'none';
    button.style.boxShadow = '0 4px 10px rgba(15, 23, 42, 0.35)';
  });

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

  if (!outputObserver) {
    outputObserver = new MutationObserver(() => {
      debouncedInjectCopyButtons();
    });

    outputObserver.observe(document.body, OBSERVER_OPTIONS);
  }

  return stopOutputCopyFeature;
}

export function stopOutputCopyFeature() {
  if (outputObserver) {
    outputObserver.disconnect();
    outputObserver = null;
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
