import {
  EDITOR_SETTING_DEFINITIONS,
  FEATURE_SETTING_DEFINITIONS,
  loadSettings
} from '../../core/settings.js';
import {
  EXTENSION_OWNED_ATTR,
  SETTINGS_MODAL_ID
} from '../../config/constants.js';
import { lockModalInteraction, unlockModalInteraction } from '../../ui/modal-lock.js';

const CONTENT_ID = 'sdExtensionSettingsContent';
const CHECKBOX_ATTR = 'data-sd-setting-key';
const SELECT_ATTR = 'data-sd-setting-select-key';
const SWITCH_TRACK_ATTR = 'data-sd-setting-switch-track';
const SWITCH_THUMB_ATTR = 'data-sd-setting-switch-thumb';

let settingsModalEl = null;
let settingsGetFn = loadSettings;
let settingsSetFn = null;

function syncSwitchVisual(settingKey, isEnabled) {
  const track = settingsModalEl?.querySelector(`[${SWITCH_TRACK_ATTR}="${settingKey}"]`);
  const thumb = settingsModalEl?.querySelector(`[${SWITCH_THUMB_ATTR}="${settingKey}"]`);
  if (!track || !thumb) return;

  track.style.background = isEnabled
    ? 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)'
    : 'rgba(100, 116, 139, 0.5)';
  track.style.borderColor = isEnabled
    ? 'rgba(59, 130, 246, 0.65)'
    : 'rgba(148, 163, 184, 0.5)';
  thumb.style.transform = isEnabled ? 'translateX(18px)' : 'translateX(0)';
}

function createSettingRow(definition) {
  const row = document.createElement('label');
  row.setAttribute(CHECKBOX_ATTR, definition.key);
  Object.assign(row.style, {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: '10px',
    padding: '10px 12px',
    border: '1px solid rgba(148, 163, 184, 0.22)',
    borderRadius: '8px',
    background: 'rgba(15, 23, 42, 0.46)',
    cursor: 'pointer'
  });

  const textWrap = document.createElement('div');

  const title = document.createElement('div');
  title.textContent = definition.label;
  Object.assign(title.style, {
    color: '#e2e8f0',
    fontSize: '13px',
    fontWeight: '600'
  });

  const description = document.createElement('div');
  description.textContent = definition.description;
  Object.assign(description.style, {
    color: '#94a3b8',
    fontSize: '12px',
    marginTop: '2px'
  });

  textWrap.appendChild(title);
  textWrap.appendChild(description);

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.setAttribute(CHECKBOX_ATTR, definition.key);
  Object.assign(checkbox.style, {
    position: 'absolute',
    opacity: '0',
    width: '1px',
    height: '1px',
    pointerEvents: 'none'
  });

  const switchTrack = document.createElement('span');
  switchTrack.setAttribute(SWITCH_TRACK_ATTR, definition.key);
  Object.assign(switchTrack.style, {
    width: '42px',
    height: '24px',
    borderRadius: '999px',
    border: '1px solid rgba(148, 163, 184, 0.5)',
    background: 'rgba(100, 116, 139, 0.5)',
    position: 'relative',
    transition: 'all 150ms ease'
  });

  const switchThumb = document.createElement('span');
  switchThumb.setAttribute(SWITCH_THUMB_ATTR, definition.key);
  Object.assign(switchThumb.style, {
    position: 'absolute',
    top: '2px',
    left: '2px',
    width: '18px',
    height: '18px',
    borderRadius: '999px',
    background: '#ffffff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
    transition: 'transform 150ms ease'
  });
  switchTrack.appendChild(switchThumb);

  checkbox.onchange = () => {
    syncSwitchVisual(definition.key, checkbox.checked);
    if (typeof settingsSetFn === 'function') {
      settingsSetFn(definition.key, checkbox.checked);
    }
  };

  row.appendChild(textWrap);
  row.appendChild(switchTrack);
  row.appendChild(checkbox);
  return row;
}

function createEditorSettingRow(definition) {
  const row = document.createElement('div');
  row.setAttribute(SELECT_ATTR, definition.key);
  Object.assign(row.style, {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: '12px',
    alignItems: 'center',
    padding: '10px 12px',
    border: '1px solid rgba(148, 163, 184, 0.22)',
    borderRadius: '8px',
    background: 'rgba(15, 23, 42, 0.46)'
  });

  const textWrap = document.createElement('div');

  const title = document.createElement('div');
  title.textContent = definition.label;
  Object.assign(title.style, {
    color: '#e2e8f0',
    fontSize: '13px',
    fontWeight: '600'
  });

  const description = document.createElement('div');
  description.textContent = definition.description;
  Object.assign(description.style, {
    color: '#94a3b8',
    fontSize: '12px',
    marginTop: '2px'
  });

  textWrap.appendChild(title);
  textWrap.appendChild(description);

  const select = document.createElement('select');
  select.setAttribute(SELECT_ATTR, definition.key);
  Object.assign(select.style, {
    minWidth: '120px',
    background: 'rgba(15, 23, 42, 0.75)',
    color: '#cbd5e1',
    border: '1px solid rgba(148, 163, 184, 0.4)',
    borderRadius: '6px',
    padding: '6px 8px',
    fontSize: '12px',
    outline: 'none',
    cursor: 'pointer'
  });

  for (const option of definition.options || []) {
    const optionEl = document.createElement('option');
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    select.appendChild(optionEl);
  }

  select.onchange = () => {
    if (typeof settingsSetFn !== 'function') return;
    const value = definition.key === 'textareaEditorFontSize'
      ? Number.parseInt(select.value, 10)
      : select.value;
    settingsSetFn(definition.key, value);
  };

  row.appendChild(textWrap);
  row.appendChild(select);
  return row;
}

function refreshSettingRows() {
  if (!settingsModalEl) return;
  const settings = settingsGetFn();

  for (const def of FEATURE_SETTING_DEFINITIONS) {
    const checkbox = settingsModalEl.querySelector(`input[${CHECKBOX_ATTR}="${def.key}"]`);
    if (!checkbox) continue;
    checkbox.checked = Boolean(settings[def.key]);
    syncSwitchVisual(def.key, checkbox.checked);
  }

  for (const def of EDITOR_SETTING_DEFINITIONS) {
    const select = settingsModalEl.querySelector(`select[${SELECT_ATTR}="${def.key}"]`);
    if (!select) continue;
    const value = settings[def.key];
    select.value = value == null ? '' : String(value);
  }
}

function closeSettingsModal() {
  if (!settingsModalEl || settingsModalEl.style.display === 'none') return;
  settingsModalEl.style.display = 'none';
  unlockModalInteraction();
}

function handleSettingsEscape(event) {
  if (!settingsModalEl || settingsModalEl.style.display !== 'flex') return;
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeSettingsModal();
}

function createSettingsModal() {
  if (settingsModalEl) return settingsModalEl;

  const overlay = document.createElement('div');
  overlay.id = SETTINGS_MODAL_ID;
  overlay.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '1000002',
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(2, 6, 23, 0.72)',
    backdropFilter: 'blur(4px)',
    padding: '20px'
  });

  const dialog = document.createElement('div');
  Object.assign(dialog.style, {
    width: '560px',
    maxWidth: 'calc(100vw - 30px)',
    maxHeight: 'calc(100vh - 40px)',
    overflow: 'hidden',
    borderRadius: '12px',
    border: '1px solid rgba(148, 163, 184, 0.3)',
    background: 'linear-gradient(180deg, #0f172a 0%, #111827 100%)',
    boxShadow: '0 30px 70px rgba(0,0,0,0.45)',
    display: 'flex',
    flexDirection: 'column'
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px',
    borderBottom: '1px solid rgba(148, 163, 184, 0.22)'
  });

  const title = document.createElement('h2');
  title.textContent = 'Extension Settings';
  Object.assign(title.style, {
    margin: '0',
    color: '#f8fafc',
    fontSize: '16px'
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close settings');
  Object.assign(closeBtn.style, {
    width: '30px',
    height: '30px',
    borderRadius: '6px',
    border: '1px solid rgba(248, 113, 113, 0.45)',
    background: 'rgba(248, 113, 113, 0.14)',
    color: '#fca5a5',
    fontSize: '20px',
    cursor: 'pointer',
    lineHeight: '1'
  });
  closeBtn.onclick = closeSettingsModal;

  header.appendChild(title);
  header.appendChild(closeBtn);

  const content = document.createElement('div');
  content.id = CONTENT_ID;
  Object.assign(content.style, {
    padding: '14px 16px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px'
  });

  for (const def of FEATURE_SETTING_DEFINITIONS) {
    content.appendChild(createSettingRow(def));
  }

  const editorSectionTitle = document.createElement('div');
  editorSectionTitle.textContent = 'Textarea Editor Defaults';
  Object.assign(editorSectionTitle.style, {
    color: '#93c5fd',
    fontSize: '12px',
    fontWeight: '600',
    letterSpacing: '0.4px',
    marginTop: '6px',
    textTransform: 'uppercase'
  });
  content.appendChild(editorSectionTitle);

  for (const def of EDITOR_SETTING_DEFINITIONS) {
    content.appendChild(createEditorSettingRow(def));
  }

  const footer = document.createElement('div');
  Object.assign(footer.style, {
    borderTop: '1px solid rgba(148, 163, 184, 0.22)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '10px',
    padding: '12px 16px'
  });

  const hint = document.createElement('div');
  hint.textContent = 'Settings apply immediately and are persisted in this browser.';
  Object.assign(hint.style, {
    fontSize: '12px',
    color: '#94a3b8'
  });

  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.textContent = 'Done';
  Object.assign(doneBtn.style, {
    border: '1px solid rgba(96, 165, 250, 0.45)',
    background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
    color: '#ffffff',
    borderRadius: '8px',
    padding: '8px 14px',
    cursor: 'pointer'
  });
  doneBtn.onclick = closeSettingsModal;

  footer.appendChild(hint);
  footer.appendChild(doneBtn);

  dialog.appendChild(header);
  dialog.appendChild(content);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeSettingsModal();
    }
  });

  document.addEventListener('keydown', handleSettingsEscape, true);
  document.body.appendChild(overlay);

  settingsModalEl = overlay;
  return settingsModalEl;
}

export function openSettingsModal({
  getSettings = loadSettings,
  setSetting
} = {}) {
  settingsGetFn = getSettings;
  settingsSetFn = setSetting;

  const modal = createSettingsModal();
  refreshSettingRows();

  const wasOpen = modal.style.display === 'flex';
  modal.style.display = 'flex';
  if (!wasOpen) {
    lockModalInteraction();
  }
}

export function hideSettingsModal() {
  closeSettingsModal();
}
