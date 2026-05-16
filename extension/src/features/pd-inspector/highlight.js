// In-page highlight overlay used by the PD Inspector engine.
//
// The DevTools panel is the UI, but highlighting has to happen on the page
// itself — so the content-script engine owns this small shadow-DOM overlay:
// outline boxes plus a floating label. No panel chrome lives here.

const CSS = `
:host { all: initial; }
.box {
  position: fixed; pointer-events: none; box-sizing: border-box;
  border: 2px solid #fbbf24; background: rgba(251,191,36,0.12);
  border-radius: 2px;
}
.label {
  position: fixed; pointer-events: none;
  background: #1e1e22; color: #d4d4d8;
  border: 1px solid #fbbf24; border-radius: 5px;
  padding: 5px 8px; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
  max-width: 360px; box-shadow: 0 3px 10px rgba(0,0,0,0.5);
  white-space: normal; word-break: break-all;
}
.label .t { color: #fbbf24; font-weight: 700; }
.label .s { color: #9ca3af; }
`;

/**
 * Create the highlight overlay. Returns `{ show, hide, destroy }`.
 */
export function createHighlighter() {
  const host = document.createElement('div');
  host.id = 'pdi-highlight-host';
  host.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const label = document.createElement('div');
  label.className = 'label';
  label.style.display = 'none';
  root.appendChild(label);

  /** @type {HTMLElement[]} reused box elements */
  const boxes = [];
  let mounted = false;

  function ensureMounted() {
    if (!mounted) {
      document.documentElement.appendChild(host);
      mounted = true;
    }
  }

  function boxAt(i) {
    if (!boxes[i]) {
      const b = document.createElement('div');
      b.className = 'box';
      root.appendChild(b);
      boxes[i] = b;
    }
    return boxes[i];
  }

  /**
   * Outline one or more elements and show a label.
   * @param {Element[]} elements
   * @param {string} title      bright label line
   * @param {string} [subtitle] dim secondary line
   */
  function show(elements, title, subtitle) {
    ensureMounted();
    const els = (elements || []).filter(Boolean);
    if (!els.length) {
      hide();
      return;
    }
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const b = boxAt(i);
      b.style.display = 'block';
      b.style.left = `${r.left}px`;
      b.style.top = `${r.top}px`;
      b.style.width = `${r.width}px`;
      b.style.height = `${r.height}px`;
    });
    for (let i = els.length; i < boxes.length; i++) {
      boxes[i].style.display = 'none';
    }

    label.innerHTML =
      `<div class="t">${esc(title)}</div>` +
      (subtitle ? `<div class="s">${esc(subtitle)}</div>` : '');
    label.style.display = 'block';
    const first = els[0].getBoundingClientRect();
    const lw = label.offsetWidth;
    const lh = label.offsetHeight;
    let lx = first.left;
    let ly = first.top - lh - 4;
    if (ly < 4) ly = first.top + 4;
    if (lx + lw > window.innerWidth) lx = window.innerWidth - lw - 6;
    label.style.left = `${Math.max(4, lx)}px`;
    label.style.top = `${Math.max(4, ly)}px`;
  }

  function hide() {
    boxes.forEach((b) => {
      b.style.display = 'none';
    });
    label.style.display = 'none';
  }

  function destroy() {
    if (mounted) host.remove();
    mounted = false;
  }

  return { show, hide, destroy };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;'
  })[c]);
}
