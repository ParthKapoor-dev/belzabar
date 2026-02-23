import { state } from '../../core/state.js';
import { showToast } from '../../ui/toast.js';
import { EXTENSION_OWNED_ATTR } from '../../config/constants.js';
import { lockModalInteraction, unlockModalInteraction } from '../../ui/modal-lock.js';

const OVERLAY_ID = 'sdTextareaEditorOverlay';
const TITLE_ID = 'sdTextareaEditorTitle';
const SUBTITLE_ID = 'sdTextareaEditorSubtitle';
const EDITOR_ID = 'sdTextareaEditorInput';
const GUTTER_ID = 'sdTextareaEditorGutter';
const SAVE_BTN_ID = 'sdTextareaEditorSave';

function getLineCount(value) {
  return Math.max(1, value.split('\n').length);
}

function buildLineNumberContent(lineCount) {
  return Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n');
}

function syncGutter() {
  const editor = document.getElementById(EDITOR_ID);
  const gutter = document.getElementById(GUTTER_ID);
  if (!editor || !gutter) return;

  gutter.textContent = buildLineNumberContent(getLineCount(editor.value));
  gutter.scrollTop = editor.scrollTop;
}

function closeTextareaEditor() {
  if (!state.textareaEditorModalEl || state.textareaEditorModalEl.style.display === 'none') return;
  state.textareaEditorModalEl.style.display = 'none';
  state.textareaEditorSourceEl = null;
  unlockModalInteraction();
}

function syncSourceTextarea(sourceEl, value) {
  sourceEl.value = value;
  sourceEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  sourceEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

function handleSave() {
  const sourceEl = state.textareaEditorSourceEl;
  const editor = document.getElementById(EDITOR_ID);
  const saveBtn = document.getElementById(SAVE_BTN_ID);

  if (!sourceEl || !editor || !saveBtn || saveBtn.disabled) {
    return;
  }

  syncSourceTextarea(sourceEl, editor.value);
  showToast('Textarea updated');
  closeTextareaEditor();
}

function applyTabIndent(editor) {
  const start = editor.selectionStart ?? 0;
  const end = editor.selectionEnd ?? start;
  const before = editor.value.slice(0, start);
  const after = editor.value.slice(end);

  editor.value = `${before}\t${after}`;
  editor.selectionStart = start + 1;
  editor.selectionEnd = start + 1;
  syncGutter();
}

function describeSource(textarea) {
  const label = textarea.getAttribute('aria-label')
    || textarea.getAttribute('name')
    || textarea.id
    || textarea.getAttribute('placeholder')
    || 'textarea';

  return `Editing: ${label}`;
}

function updateModalForSource(sourceEl) {
  const title = document.getElementById(TITLE_ID);
  const subtitle = document.getElementById(SUBTITLE_ID);
  const editor = document.getElementById(EDITOR_ID);
  const saveBtn = document.getElementById(SAVE_BTN_ID);

  if (!title || !subtitle || !editor || !saveBtn) return;

  const readOnly = sourceEl.readOnly || sourceEl.disabled;
  const textValue = sourceEl.value || '';

  title.textContent = 'Large Text Editor';
  subtitle.textContent = readOnly
    ? `${describeSource(sourceEl)} (read only)`
    : describeSource(sourceEl);

  editor.value = textValue;
  editor.readOnly = readOnly;
  editor.disabled = sourceEl.disabled;
  saveBtn.disabled = readOnly;
  saveBtn.style.opacity = readOnly ? '0.45' : '1';
  saveBtn.style.cursor = readOnly ? 'not-allowed' : 'pointer';

  syncGutter();
}

function attachGlobalShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (!state.textareaEditorModalEl || state.textareaEditorModalEl.style.display !== 'flex') {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeTextareaEditor();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      handleSave();
    }
  }, true);
}

export function createTextareaEditorModal() {
  if (state.textareaEditorModalEl) return state.textareaEditorModalEl;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '999997',
    background: 'rgba(2, 6, 23, 0.76)',
    backdropFilter: 'blur(6px)',
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px'
  });

  const dialog = document.createElement('div');
  Object.assign(dialog.style, {
    width: '92%',
    maxWidth: '1180px',
    height: '84vh',
    maxHeight: '820px',
    borderRadius: '14px',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid rgba(148, 163, 184, 0.3)',
    background: 'linear-gradient(180deg, #0f172a 0%, #111827 100%)',
    boxShadow: '0 30px 80px rgba(0, 0, 0, 0.45)'
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid rgba(148, 163, 184, 0.25)',
    background: 'rgba(148, 163, 184, 0.08)'
  });

  const titleWrap = document.createElement('div');
  const title = document.createElement('h2');
  title.id = TITLE_ID;
  title.textContent = 'Large Text Editor';
  Object.assign(title.style, {
    margin: '0',
    fontSize: '16px',
    color: '#f8fafc'
  });

  const subtitle = document.createElement('div');
  subtitle.id = SUBTITLE_ID;
  subtitle.textContent = 'Editing';
  Object.assign(subtitle.style, {
    marginTop: '4px',
    fontSize: '12px',
    color: '#94a3b8'
  });

  titleWrap.appendChild(title);
  titleWrap.appendChild(subtitle);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close large text editor');
  Object.assign(closeBtn.style, {
    width: '30px',
    height: '30px',
    borderRadius: '6px',
    border: '1px solid rgba(248, 113, 113, 0.45)',
    background: 'rgba(248, 113, 113, 0.15)',
    color: '#fca5a5',
    fontSize: '20px',
    cursor: 'pointer',
    lineHeight: '1'
  });
  closeBtn.onclick = closeTextareaEditor;

  header.appendChild(titleWrap);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  Object.assign(body.style, {
    display: 'flex',
    flex: '1',
    minHeight: '0'
  });

  const gutter = document.createElement('pre');
  gutter.id = GUTTER_ID;
  gutter.setAttribute('aria-hidden', 'true');
  Object.assign(gutter.style, {
    margin: '0',
    padding: '14px 10px',
    width: '60px',
    minWidth: '60px',
    overflow: 'hidden',
    userSelect: 'none',
    textAlign: 'right',
    color: '#64748b',
    fontFamily: '"Geist Mono", Menlo, "Courier New", monospace',
    fontSize: '13px',
    lineHeight: '1.5',
    borderRight: '1px solid rgba(148, 163, 184, 0.2)',
    background: 'rgba(15, 23, 42, 0.7)'
  });

  const editor = document.createElement('textarea');
  editor.id = EDITOR_ID;
  editor.spellcheck = false;
  Object.assign(editor.style, {
    flex: '1',
    width: '100%',
    height: '100%',
    minHeight: '0',
    border: '0',
    resize: 'none',
    outline: 'none',
    margin: '0',
    padding: '14px 16px',
    color: '#e2e8f0',
    background: 'transparent',
    fontFamily: '"Geist Mono", Menlo, "Courier New", monospace',
    fontSize: '13px',
    lineHeight: '1.5',
    whiteSpace: 'pre',
    overflow: 'auto'
  });

  editor.addEventListener('input', syncGutter);
  editor.addEventListener('scroll', () => {
    const currentGutter = document.getElementById(GUTTER_ID);
    if (currentGutter) {
      currentGutter.scrollTop = editor.scrollTop;
    }
  });
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      applyTabIndent(editor);
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      handleSave();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeTextareaEditor();
    }
  });

  body.appendChild(gutter);
  body.appendChild(editor);

  const footer = document.createElement('div');
  Object.assign(footer.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    padding: '12px 16px',
    borderTop: '1px solid rgba(148, 163, 184, 0.25)',
    background: 'rgba(148, 163, 184, 0.06)'
  });

  const helper = document.createElement('div');
  helper.textContent = 'Tab inserts indentation. Ctrl/Cmd+S saves. Esc closes.';
  Object.assign(helper.style, {
    color: '#94a3b8',
    fontSize: '12px'
  });

  const buttonGroup = document.createElement('div');
  Object.assign(buttonGroup.style, {
    display: 'flex',
    gap: '10px'
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, {
    border: '1px solid rgba(148, 163, 184, 0.45)',
    background: 'rgba(15, 23, 42, 0.6)',
    color: '#e2e8f0',
    borderRadius: '8px',
    padding: '8px 14px',
    cursor: 'pointer'
  });
  cancelBtn.onclick = closeTextareaEditor;

  const saveBtn = document.createElement('button');
  saveBtn.id = SAVE_BTN_ID;
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  Object.assign(saveBtn.style, {
    border: '1px solid rgba(96, 165, 250, 0.45)',
    background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
    color: '#ffffff',
    borderRadius: '8px',
    padding: '8px 14px',
    cursor: 'pointer',
    boxShadow: '0 4px 10px rgba(37, 99, 235, 0.3)'
  });
  saveBtn.onclick = handleSave;

  buttonGroup.appendChild(cancelBtn);
  buttonGroup.appendChild(saveBtn);
  footer.appendChild(helper);
  footer.appendChild(buttonGroup);

  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeTextareaEditor();
    }
  });

  document.body.appendChild(overlay);
  state.textareaEditorModalEl = overlay;
  attachGlobalShortcuts();

  return state.textareaEditorModalEl;
}

export function openTextareaEditor(sourceEl) {
  if (!sourceEl) return;

  const modal = createTextareaEditorModal();
  const wasOpen = modal.style.display === 'flex';
  state.textareaEditorSourceEl = sourceEl;
  updateModalForSource(sourceEl);
  modal.style.display = 'flex';
  if (!wasOpen) {
    lockModalInteraction();
  }

  const editor = document.getElementById(EDITOR_ID);
  if (editor) {
    editor.focus();
    editor.selectionStart = editor.value.length;
    editor.selectionEnd = editor.value.length;
  }
}
