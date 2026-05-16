// Inspect mode — point at the page, learn which PD component it is.
//
// While active: pointer-move outlines the nearest `exp-*` component and shows
// a tip with its kind + identity; a click pins it (and is swallowed so the
// page's own handler does not also fire).

import { identify } from './correlate.js';
import { KIND_BADGE } from './tree.js';

/**
 * @param {{
 *   highlightEl: HTMLElement,
 *   tipEl: HTMLElement,
 *   shadowHost: HTMLElement,
 *   getContext: () => ({ fieldIndex: Map, kindCounts: object }),
 *   onPick: (info: object) => void
 * }} deps
 */
export function createInspector(deps) {
  const { highlightEl, tipEl, shadowHost, getContext, onPick } = deps;
  let active = false;
  let lastEl = null;

  function hide() {
    highlightEl.style.display = 'none';
    tipEl.style.display = 'none';
    lastEl = null;
  }

  function place(expEl) {
    const r = expEl.getBoundingClientRect();
    highlightEl.style.display = 'block';
    highlightEl.style.left = `${r.left}px`;
    highlightEl.style.top = `${r.top}px`;
    highlightEl.style.width = `${r.width}px`;
    highlightEl.style.height = `${r.height}px`;
  }

  function renderTip(info, x, y) {
    const badge = KIND_BADGE[info.kind] || info.kind;
    let detail;
    if (info.tier === 'exact' && info.node) {
      detail =
        `<div class="pdi-tip-id">${esc(info.node.label)}</div>` +
        `<div class="pdi-tip-note">node ${esc(info.node.id)}</div>`;
    } else if (info.kind === 'FORM_FIELD' && info.fieldName) {
      detail = `<div class="pdi-tip-note">field "${esc(info.fieldName)}" — not in config</div>`;
    } else {
      detail = `<div class="pdi-tip-note">1 of ${info.peers} ${badge.toLowerCase()} node(s) — type only</div>`;
    }
    tipEl.innerHTML =
      `<div><span class="pdi-tip-kind">${badge}</span> &lt;${esc(info.tag)}&gt;</div>${detail}`;
    tipEl.style.display = 'block';
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    let tx = x + 14;
    let ty = y + 14;
    if (tx + tw > window.innerWidth) tx = x - tw - 14;
    if (ty + th > window.innerHeight) ty = y - th - 14;
    tipEl.style.left = `${Math.max(4, tx)}px`;
    tipEl.style.top = `${Math.max(4, ty)}px`;
  }

  function onMove(e) {
    if (e.target === shadowHost) {
      hide();
      return;
    }
    const info = identify(e.target, getContext());
    if (!info) {
      hide();
      return;
    }
    lastEl = info.expEl;
    place(info.expEl);
    renderTip(info, e.clientX, e.clientY);
  }

  function onScroll() {
    if (lastEl) place(lastEl);
  }

  function onClick(e) {
    if (e.target === shadowHost) return;
    const info = identify(e.target, getContext());
    if (!info) return;
    e.preventDefault();
    e.stopPropagation();
    onPick(info);
  }

  function start() {
    if (active) return;
    active = true;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', onScroll, true);
  }

  function stop() {
    if (!active) return;
    active = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('scroll', onScroll, true);
    hide();
  }

  return { start, stop, isActive: () => active };
}

/** Minimal HTML-escape for tip content. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  })[c]);
}
