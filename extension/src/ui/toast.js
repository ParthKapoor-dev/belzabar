import { state } from '../core/state.js';

// Toast notification component
export function ensureToast() {
  if (state.toastEl) return state.toastEl;

  state.toastEl = document.createElement('div');
  state.toastEl.textContent = 'Run Test triggered';

  Object.assign(state.toastEl.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: '999999',
    padding: '10px 14px',
    background: '#1f2937',
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

  document.body.appendChild(state.toastEl);
  return state.toastEl;
}

export function showToast(message = 'Run Test triggered') {
  const el = ensureToast();
  el.textContent = message;

  if (state.toastTimeout) {
    clearTimeout(state.toastTimeout);
  }

  el.style.opacity = '1';
  el.style.transform = 'translateY(0)';

  state.toastTimeout = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
  }, 1200);
}