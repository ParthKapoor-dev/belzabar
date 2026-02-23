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
const LANG_SELECT_ID = 'sdTextareaEditorLanguage';
const HIGHLIGHT_ID = 'sdTextareaEditorHighlight';
const MODE_ID = 'sdTextareaEditorMode';

const SQL_PATTERN = /(--.*$|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*')|(\b(?:SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|VIEW|AS|DISTINCT|CASE|WHEN|THEN|ELSE|END|NULL|IS|NOT|IN|EXISTS|LIKE|UNION|ALL|WITH)\b)|(\b\d+(?:\.\d+)?\b)/gim;
const JS_PATTERN = /(\/\/.*$|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|new|class|extends|import|from|export|default|async|await|true|false|null|undefined)\b)|(\b\d+(?:\.\d+)?\b)/gm;
const SPEL_PATTERN = /(#\{|\})|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b(?:and|or|not|eq|ne|lt|gt|le|ge|true|false|null)\b)|(\b\d+(?:\.\d+)?\b)|(#[a-zA-Z_][\w.]*)|(T\([^)]+\))/g;

const TOKEN_COLORS = {
  comment: '#94a3b8',
  string: '#fca5a5',
  keyword: '#60a5fa',
  number: '#fbbf24',
  variable: '#22d3ee',
  type: '#c084fc'
};

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function wrapToken(token, color) {
  return `<span style="color:${color}">${escapeHtml(token)}</span>`;
}

function highlightByPattern(text, pattern, classifyMatch) {
  let output = '';
  let lastIndex = 0;
  pattern.lastIndex = 0;

  let match = pattern.exec(text);
  while (match) {
    output += escapeHtml(text.slice(lastIndex, match.index));
    const token = match[0];
    const color = classifyMatch(match);
    output += color ? wrapToken(token, color) : escapeHtml(token);

    lastIndex = match.index + token.length;
    if (match.index === pattern.lastIndex) {
      pattern.lastIndex += 1;
    }
    match = pattern.exec(text);
  }

  output += escapeHtml(text.slice(lastIndex));
  return output;
}

function detectLanguage(text) {
  const sample = text.trim();
  if (!sample) return 'plain';

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

function getSelectedLanguage() {
  const languageSelect = document.getElementById(LANG_SELECT_ID);
  return languageSelect?.value || 'auto';
}

function resolveLanguage(text) {
  const selected = getSelectedLanguage();
  return selected === 'auto' ? detectLanguage(text) : selected;
}

function highlightSQL(text) {
  return highlightByPattern(text, SQL_PATTERN, (match) => {
    if (match[1]) return TOKEN_COLORS.comment;
    if (match[2]) return TOKEN_COLORS.string;
    if (match[3]) return TOKEN_COLORS.keyword;
    if (match[4]) return TOKEN_COLORS.number;
    return '';
  });
}

function highlightJS(text) {
  return highlightByPattern(text, JS_PATTERN, (match) => {
    if (match[1]) return TOKEN_COLORS.comment;
    if (match[2]) return TOKEN_COLORS.string;
    if (match[3]) return TOKEN_COLORS.keyword;
    if (match[4]) return TOKEN_COLORS.number;
    return '';
  });
}

function highlightSpEL(text) {
  return highlightByPattern(text, SPEL_PATTERN, (match) => {
    if (match[1]) return TOKEN_COLORS.type;
    if (match[2]) return TOKEN_COLORS.string;
    if (match[3]) return TOKEN_COLORS.keyword;
    if (match[4]) return TOKEN_COLORS.number;
    if (match[5]) return TOKEN_COLORS.variable;
    if (match[6]) return TOKEN_COLORS.type;
    return '';
  });
}

function renderSyntaxLayer() {
  const editor = document.getElementById(EDITOR_ID);
  const highlight = document.getElementById(HIGHLIGHT_ID);
  const modeEl = document.getElementById(MODE_ID);
  if (!editor || !highlight || !modeEl) return;

  const resolvedLanguage = resolveLanguage(editor.value);
  modeEl.textContent = resolvedLanguage.toUpperCase();

  if (resolvedLanguage === 'sql') {
    highlight.innerHTML = highlightSQL(editor.value);
    return;
  }

  if (resolvedLanguage === 'javascript') {
    highlight.innerHTML = highlightJS(editor.value);
    return;
  }

  if (resolvedLanguage === 'spel') {
    highlight.innerHTML = highlightSpEL(editor.value);
    return;
  }

  highlight.innerHTML = escapeHtml(editor.value || ' ');
}

function getLineCount(value) {
  return Math.max(1, value.split('\n').length);
}

function buildLineNumberContent(lineCount) {
  return Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n');
}

function syncGutter() {
  const editor = document.getElementById(EDITOR_ID);
  const gutter = document.getElementById(GUTTER_ID);
  const highlight = document.getElementById(HIGHLIGHT_ID);
  if (!editor || !gutter) return;

  gutter.textContent = buildLineNumberContent(getLineCount(editor.value));
  gutter.scrollTop = editor.scrollTop;
  if (highlight) {
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
  }
}

function syncEditorView() {
  syncGutter();
  renderSyntaxLayer();
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
  syncEditorView();
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

  syncEditorView();
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

  const headerActions = document.createElement('div');
  Object.assign(headerActions.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '10px'
  });

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
    { value: 'javascript', label: 'JavaScript' }
  ];
  for (const option of languageOptions) {
    const optionEl = document.createElement('option');
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    languageSelect.appendChild(optionEl);
  }

  const modeBadge = document.createElement('div');
  modeBadge.id = MODE_ID;
  modeBadge.textContent = 'AUTO';
  Object.assign(modeBadge.style, {
    color: '#93c5fd',
    fontWeight: '600',
    fontSize: '11px',
    letterSpacing: '0.4px',
    padding: '3px 7px',
    borderRadius: '999px',
    border: '1px solid rgba(96, 165, 250, 0.35)',
    background: 'rgba(96, 165, 250, 0.15)'
  });

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
  headerActions.appendChild(modeBadge);
  headerActions.appendChild(closeBtn);
  header.appendChild(headerActions);

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

  const editorShell = document.createElement('div');
  Object.assign(editorShell.style, {
    position: 'relative',
    flex: '1',
    minHeight: '0',
    background: 'rgba(15, 23, 42, 0.52)'
  });

  const highlight = document.createElement('pre');
  highlight.id = HIGHLIGHT_ID;
  highlight.setAttribute('aria-hidden', 'true');
  Object.assign(highlight.style, {
    position: 'absolute',
    inset: '0',
    margin: '0',
    padding: '14px 16px',
    overflow: 'hidden',
    pointerEvents: 'none',
    color: '#e2e8f0',
    fontFamily: '"Geist Mono", Menlo, "Courier New", monospace',
    fontSize: '13px',
    lineHeight: '1.5',
    whiteSpace: 'pre',
    tabSize: '4'
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
    color: 'transparent',
    caretColor: '#e2e8f0',
    background: 'transparent',
    fontFamily: '"Geist Mono", Menlo, "Courier New", monospace',
    fontSize: '13px',
    lineHeight: '1.5',
    whiteSpace: 'pre',
    tabSize: '4',
    overflow: 'auto'
  });

  editor.addEventListener('input', syncEditorView);
  editor.addEventListener('scroll', syncGutter);
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

  editorShell.appendChild(highlight);
  editorShell.appendChild(editor);
  body.appendChild(gutter);
  body.appendChild(editorShell);

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
  helper.textContent = 'Single editor with syntax highlighting. Tab inserts indentation. Ctrl/Cmd+S saves. Esc closes.';
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
  languageSelect.addEventListener('change', renderSyntaxLayer);

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
