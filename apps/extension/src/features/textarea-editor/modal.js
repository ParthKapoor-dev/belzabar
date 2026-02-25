import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { sql } from '@codemirror/lang-sql';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { state } from '../../core/state.js';
import { showToast } from '../../ui/toast.js';
import { EXTENSION_OWNED_ATTR } from '../../config/constants.js';
import { lockModalInteraction, unlockModalInteraction } from '../../ui/modal-lock.js';

const OVERLAY_ID = 'sdTextareaEditorOverlay';
const TITLE_ID = 'sdTextareaEditorTitle';
const SUBTITLE_ID = 'sdTextareaEditorSubtitle';
const EDITOR_ID = 'sdTextareaEditorInput';
const EDITOR_HOST_ID = 'sdTextareaEditorHost';
const SAVE_BTN_ID = 'sdTextareaEditorSave';
const LANG_SELECT_ID = 'sdTextareaEditorLanguage';
const FONT_SIZE_SELECT_ID = 'sdTextareaEditorFontSize';

const EDITOR_VERTICAL_PADDING_PX = 14;
const EDITOR_HORIZONTAL_PADDING_PX = 16;

let editorView = null;
let resolvedEditorLanguage = 'plain';
const languageCompartment = new Compartment();

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontFamily: '"Jet Brains Mono", "JetBrains Mono", "Geist Mono", Menlo, "Courier New", monospace',
      backgroundColor: 'rgba(15, 23, 42, 0.52)',
      color: '#e2e8f0'
    },
    '.cm-scroller': {
      fontFamily: 'inherit',
      lineHeight: '1.5',
      overflow: 'auto'
    },
    '.cm-content': {
      caretColor: '#e2e8f0',
      padding: `${EDITOR_VERTICAL_PADDING_PX}px ${EDITOR_HORIZONTAL_PADDING_PX}px`,
      minHeight: '100%',
      letterSpacing: 'normal',
      wordSpacing: 'normal'
    },
    '.cm-gutters': {
      backgroundColor: 'rgba(15, 23, 42, 0.7)',
      color: '#64748b',
      borderRight: '1px solid rgba(148, 163, 184, 0.2)'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '44px',
      padding: '0 10px 0 0',
      textAlign: 'right'
    },
    '&.cm-focused': {
      outline: 'none'
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: '#e2e8f0'
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(96, 165, 250, 0.35)'
    }
  },
  { dark: true }
);

function destroyEditorView() {
  if (!editorView) return;
  editorView.destroy();
  editorView = null;
}

function getEditorText() {
  if (!editorView) return '';
  return editorView.state.doc.toString();
}

function getSelectedFontSize() {
  const fontSizeSelect = document.getElementById(FONT_SIZE_SELECT_ID);
  const value = Number.parseInt(fontSizeSelect?.value || '13', 10);
  if (Number.isFinite(value) && value >= 11 && value <= 24) {
    return value;
  }
  return 13;
}

function getSelectedLanguageMode() {
  const languageSelect = document.getElementById(LANG_SELECT_ID);
  return languageSelect?.value || 'auto';
}

function applyEditorFontSize(fontSize) {
  if (!editorView) return;
  const fontSizePx = `${fontSize}px`;
  editorView.dom.style.fontSize = fontSizePx;
  editorView.dom.style.letterSpacing = 'normal';
  editorView.dom.style.wordSpacing = 'normal';
}

function detectLanguage(text) {
  const sample = text.trim();
  if (!sample) return 'plain';

  if ((sample.startsWith('{') && sample.endsWith('}')) || (sample.startsWith('[') && sample.endsWith(']'))) {
    try {
      JSON.parse(sample);
      return 'json';
    } catch {
      // continue with other detectors
    }
  }

  if (/#\{[^}]*\}|T\([^)]+\)|\b(eq|ne|lt|gt|le|ge|and|or|not)\b/i.test(sample)) {
    return 'spel';
  }

  if (/\b(select|insert|update|delete|from|where|join|group\s+by|order\s+by|having|with)\b/i.test(sample)) {
    return 'sql';
  }

  if (/\b(const|let|var|function|return|class|import|export|async|await)\b|=>|console\./.test(sample)) {
    return 'javascript';
  }

  return 'plain';
}

function resolveLanguageMode(text, selectedMode) {
  if (selectedMode === 'auto') {
    return detectLanguage(text);
  }
  return selectedMode;
}

function getLanguageExtensionForMode(mode) {
  if (mode === 'sql') return sql();
  if (mode === 'javascript') return javascript();
  if (mode === 'json') return json();
  if (mode === 'spel') return javascript();
  return [];
}

function reconfigureEditorLanguage(mode) {
  if (!editorView) return;
  resolvedEditorLanguage = mode;
  editorView.dispatch({
    effects: languageCompartment.reconfigure(getLanguageExtensionForMode(mode))
  });
}

function createEditorForSource(sourceEl) {
  const host = document.getElementById(EDITOR_HOST_ID);
  if (!host) return;

  const textValue = sourceEl.value || '';
  const readOnly = sourceEl.readOnly || sourceEl.disabled;
  const selectedLanguageMode = getSelectedLanguageMode();
  const initialLanguageMode = resolveLanguageMode(textValue, selectedLanguageMode);
  resolvedEditorLanguage = initialLanguageMode;

  const extensions = [
    lineNumbers(),
    keymap.of([indentWithTab, ...defaultKeymap]),
    EditorState.tabSize.of(4),
    EditorState.readOnly.of(readOnly),
    editorTheme,
    oneDark,
    languageCompartment.of(getLanguageExtensionForMode(initialLanguageMode)),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || !editorView) return;
      if (getSelectedLanguageMode() !== 'auto') return;

      const nextMode = detectLanguage(update.state.doc.toString());
      if (nextMode === resolvedEditorLanguage) return;
      reconfigureEditorLanguage(nextMode);
    })
  ];

  destroyEditorView();
  editorView = new EditorView({
    state: EditorState.create({
      doc: textValue,
      selection: { anchor: textValue.length },
      extensions
    }),
    parent: host
  });

  applyEditorFontSize(getSelectedFontSize());
}

function handleLanguageSelectionChange() {
  if (!editorView) return;

  const selectedMode = getSelectedLanguageMode();
  const resolvedMode = resolveLanguageMode(getEditorText(), selectedMode);
  reconfigureEditorLanguage(resolvedMode);
}

export function closeTextareaEditor() {
  if (!state.textareaEditorModalEl || state.textareaEditorModalEl.style.display === 'none') return;
  state.textareaEditorModalEl.style.display = 'none';
  state.textareaEditorSourceEl = null;
  destroyEditorView();
  unlockModalInteraction();
}

function syncSourceTextarea(sourceEl, value) {
  sourceEl.value = value;
  sourceEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  sourceEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

async function copyEditorText() {
  const text = getEditorText();
  if (!text.trim()) {
    showToast('Nothing to copy');
    return;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied editor text');
      return;
    } catch (error) {
      // fall through to execCommand fallback
      console.error('Navigator clipboard copy failed:', error);
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
    console.error('Fallback clipboard copy failed:', error);
  }

  tempTextarea.remove();
  showToast(copied ? 'Copied editor text' : 'Failed to copy');
}

function handleSave() {
  const sourceEl = state.textareaEditorSourceEl;
  const saveBtn = document.getElementById(SAVE_BTN_ID);

  if (!sourceEl || !saveBtn || saveBtn.disabled || !editorView) {
    return;
  }

  syncSourceTextarea(sourceEl, getEditorText());
  showToast('Textarea updated');
  closeTextareaEditor();
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
  const saveBtn = document.getElementById(SAVE_BTN_ID);

  if (!title || !subtitle || !saveBtn) return;

  const readOnly = sourceEl.readOnly || sourceEl.disabled;

  title.textContent = 'Large Text Editor';
  subtitle.textContent = readOnly
    ? `${describeSource(sourceEl)} (read only)`
    : describeSource(sourceEl);

  saveBtn.disabled = readOnly;
  saveBtn.style.opacity = readOnly ? '0.45' : '1';
  saveBtn.style.cursor = readOnly ? 'not-allowed' : 'pointer';

  createEditorForSource(sourceEl);
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
    padding: '12px'
  });

  const dialog = document.createElement('div');
  Object.assign(dialog.style, {
    width: 'calc(100vw - 24px)',
    height: 'calc(100vh - 24px)',
    maxWidth: 'none',
    maxHeight: 'none',
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

  const headerActions = document.createElement('div');
  Object.assign(headerActions.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '10px'
  });

  const fontSizeSelect = document.createElement('select');
  fontSizeSelect.id = FONT_SIZE_SELECT_ID;
  Object.assign(fontSizeSelect.style, {
    background: 'rgba(15, 23, 42, 0.75)',
    color: '#cbd5e1',
    border: '1px solid rgba(148, 163, 184, 0.4)',
    borderRadius: '6px',
    padding: '4px 8px',
    fontSize: '12px',
    outline: 'none',
    cursor: 'pointer'
  });
  const fontOptions = ['12', '13', '14', '16', '18'];
  for (const optionValue of fontOptions) {
    const optionEl = document.createElement('option');
    optionEl.value = optionValue;
    optionEl.textContent = `${optionValue}px`;
    if (optionValue === '13') optionEl.selected = true;
    fontSizeSelect.appendChild(optionEl);
  }

  const languageSelect = document.createElement('select');
  languageSelect.id = LANG_SELECT_ID;
  Object.assign(languageSelect.style, {
    background: 'rgba(15, 23, 42, 0.75)',
    color: '#cbd5e1',
    border: '1px solid rgba(148, 163, 184, 0.4)',
    borderRadius: '6px',
    padding: '4px 8px',
    fontSize: '12px',
    outline: 'none',
    cursor: 'pointer'
  });
  const languageOptions = [
    { value: 'auto', label: 'Auto' },
    { value: 'sql', label: 'SQL' },
    { value: 'spel', label: 'SpEL' },
    { value: 'javascript', label: 'JavaScript' },
    { value: 'json', label: 'JSON' },
    { value: 'plain', label: 'Plain' }
  ];
  for (const option of languageOptions) {
    const optionEl = document.createElement('option');
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    if (option.value === 'auto') optionEl.selected = true;
    languageSelect.appendChild(optionEl);
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.setAttribute('title', 'Copy editor text');
  Object.assign(copyBtn.style, {
    border: '1px solid rgba(148, 163, 184, 0.45)',
    background: 'rgba(15, 23, 42, 0.75)',
    color: '#cbd5e1',
    borderRadius: '6px',
    padding: '4px 10px',
    fontSize: '12px',
    cursor: 'pointer'
  });
  copyBtn.onclick = () => {
    copyEditorText();
  };

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
  headerActions.appendChild(languageSelect);
  headerActions.appendChild(fontSizeSelect);
  headerActions.appendChild(copyBtn);
  headerActions.appendChild(closeBtn);
  header.appendChild(headerActions);

  const body = document.createElement('div');
  Object.assign(body.style, {
    display: 'flex',
    flex: '1',
    minHeight: '0'
  });

  const editorHost = document.createElement('div');
  editorHost.id = EDITOR_HOST_ID;
  editorHost.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  Object.assign(editorHost.style, {
    display: 'flex',
    flex: '1',
    minHeight: '0'
  });

  body.appendChild(editorHost);

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
  helper.textContent = 'CodeMirror editor with line numbers and syntax highlighting.';
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
  languageSelect.addEventListener('change', handleLanguageSelectionChange);
  fontSizeSelect.addEventListener('change', () => {
    applyEditorFontSize(getSelectedFontSize());
  });

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

  if (editorView) {
    editorView.focus();
  }
}
