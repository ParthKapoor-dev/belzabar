
(() => {
  'use strict';

  /* ===========================
     Constants & Selectors
     =========================== */

  const METHOD_INPUT_SELECTOR = 'input#SD1_MethodName';

  const RUN_TEST_EXP_BUTTON_SELECTORS = [
    'exp-button#runTest',
    'exp-button.run_test_btn',
    'exp-button[aria-label="run Test"]',
    'exp-button[arialabel="run Test"]'
  ];

  const OBSERVER_OPTIONS = {
    childList: true,
    subtree: true
  };

  /* ===========================
     State
     =========================== */

  let lastMethodName = null;
  let toastEl = null;
  let toastTimeout = null;

  /* ===========================
     Helpers
     =========================== */

  function extractMethodName() {
    const input = document.querySelector(METHOD_INPUT_SELECTOR);
    if (!input || !input.value) return null;
    return input.value.trim();
  }

  function updateTitle() {
    const methodName = extractMethodName();
    if (!methodName || methodName === lastMethodName) return;

    lastMethodName = methodName;
    const baseTitle = document.title.split(' – ')[0];
    document.title = `${baseTitle} – ${methodName}`;
  }

  function isEditableElement(el) {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();

    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const type = (el.type || '').toLowerCase();
      return !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type);
    }

    return el.isContentEditable === true;
  }

  /* ===========================
     Toast UI
     =========================== */

  function ensureToast() {
    if (toastEl) return toastEl;

    toastEl = document.createElement('div');
    toastEl.textContent = 'Run Test triggered';

    Object.assign(toastEl.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: '999999',
      padding: '10px 14px',
      background: '#1f2937', // dark gray
      color: '#ffffff',
      fontSize: '13px',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      borderRadius: '6px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
      opacity: '0',
      transform: 'translateY(8px)',
      transition: 'opacity 150ms ease, transform 150ms ease',
      pointerEvents: 'none'
    });

    document.body.appendChild(toastEl);
    return toastEl;
  }

  function showToast() {
    const el = ensureToast();

    if (toastTimeout) {
      clearTimeout(toastTimeout);
    }

    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';

    toastTimeout = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
    }, 1200);
  }

  /* ===========================
     Run Test Trigger (Angular-safe)
     =========================== */

  function findRunTestButton() {
    for (const selector of RUN_TEST_EXP_BUTTON_SELECTORS) {
      const expButtons = document.querySelectorAll(selector);
      for (const exp of expButtons) {
        if (exp.offsetParent === null) continue;

        const innerButton = exp.querySelector('button');
        if (innerButton && !innerButton.disabled) {
          return innerButton;
        }
      }
    }
    return null;
  }

  function triggerRunTest() {
    const button = findRunTestButton();
    if (!button) return;

    button.click();
    showToast();
  }

  /* ===========================
     Keyboard Shortcut
     =========================== */

  function handleKeydown(event) {
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

  /* ===========================
     Observers & Init
     =========================== */

  function setupObserver() {
    const observer = new MutationObserver(updateTitle);
    observer.observe(document.body, OBSERVER_OPTIONS);
  }

  function init() {
    updateTitle();
    setupObserver();
    document.addEventListener('keydown', handleKeydown, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

