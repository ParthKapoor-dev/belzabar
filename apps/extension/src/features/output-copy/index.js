import {
  OUTPUT_CONTAINER_SELECTOR,
  OBSERVER_OPTIONS,
  EXTENSION_OWNED_ATTR
} from '../../config/constants.js';
import { showToast } from '../../ui/toast.js';
import { log } from '../../core/logger.js';

const COPY_BOUND_ATTR = 'data-sd-copy-bound';
const CONTROLS_CLASS = 'sdExtensionOutputCopyControls';

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
  button.textContent = 'Copy';
  button.setAttribute('title', 'Copy output JSON');

  Object.assign(button.style, {
    padding: '6px 12px',
    borderRadius: '6px',
    border: '1px solid rgba(59, 130, 246, 0.45)',
    background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
    color: '#ffffff',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    marginBottom: '6px',
    transition: 'transform 140ms ease, box-shadow 140ms ease, filter 140ms ease',
    boxShadow: '0 4px 10px rgba(37, 99, 235, 0.25)'
  });

  button.addEventListener('mouseenter', () => {
    button.style.transform = 'translateY(-1px)';
    button.style.filter = 'brightness(1.05)';
    button.style.boxShadow = '0 6px 14px rgba(37, 99, 235, 0.32)';
  });

  button.addEventListener('mouseleave', () => {
    button.style.transform = 'translateY(0)';
    button.style.filter = 'none';
    button.style.boxShadow = '0 4px 10px rgba(37, 99, 235, 0.25)';
  });

  button.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const textToCopy = (container.innerText || container.textContent || '').trim();
    if (!textToCopy) {
      showToast('Nothing to copy');
      return;
    }

    const copied = await copyText(textToCopy);
    showToast(copied ? 'Output copied' : 'Failed to copy output');
  };

  return button;
}

function injectCopyButtons() {
  const containers = document.querySelectorAll(OUTPUT_CONTAINER_SELECTOR);
  if (containers.length === 0) return;

  for (const container of containers) {
    if (container.getAttribute(COPY_BOUND_ATTR) === 'true') continue;
    if (!container.parentElement) continue;

    const controls = document.createElement('div');
    controls.className = CONTROLS_CLASS;
    controls.setAttribute(EXTENSION_OWNED_ATTR, 'true');
    Object.assign(controls.style, {
      display: 'flex',
      justifyContent: 'flex-end',
      width: '100%',
      paddingRight: '10px'
    });

    controls.appendChild(createCopyButton(container));
    container.parentElement.insertBefore(controls, container);
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
  }
}
