const SETTINGS_STORAGE_KEY = 'sdExtensionSettingsV1';

export const TEXTAREA_EDITOR_LANGUAGE_OPTIONS = [
  'auto',
  'sql',
  'spel',
  'javascript',
  'json',
  'plain'
];
export const TEXTAREA_EDITOR_WRAP_OPTIONS = ['nowrap', 'wrap'];
export const TEXTAREA_EDITOR_FONT_SIZE_OPTIONS = [12, 13, 14, 16, 18];

export const DEFAULT_SETTINGS = {
  titleUpdater: true,
  runTestShortcut: true,
  jsonEditor: true,
  outputCopy: true,
  textareaEditor: true,
  textareaEditorLanguage: 'auto',
  textareaEditorWrap: 'nowrap',
  textareaEditorFontSize: 13
};

export const FEATURE_SETTING_DEFINITIONS = [
  {
    key: 'titleUpdater',
    label: 'Title Updater',
    description: 'Update tab title with AD/PD method/page name'
  },
  {
    key: 'runTestShortcut',
    label: 'Run Test Shortcut',
    description: 'Enable Ctrl+Shift+Enter to run tests'
  },
  {
    key: 'jsonEditor',
    label: 'JSON Editor',
    description: 'Show JSON input button and modal editor'
  },
  {
    key: 'outputCopy',
    label: 'Output Copy',
    description: 'Show Copy button near output containers'
  },
  {
    key: 'textareaEditor',
    label: 'Textarea Editor',
    description: 'Show Open button for native textareas'
  }
];

export const EDITOR_SETTING_DEFINITIONS = [
  {
    key: 'textareaEditorLanguage',
    label: 'Editor Language',
    description: 'Default syntax highlighting mode',
    type: 'select',
    options: TEXTAREA_EDITOR_LANGUAGE_OPTIONS.map((value) => ({
      value,
      label: value === 'auto'
        ? 'Auto'
        : value === 'sql'
          ? 'SQL'
          : value === 'spel'
            ? 'SpEL'
            : value === 'javascript'
              ? 'JavaScript'
              : value === 'json'
                ? 'JSON'
                : 'Plain'
    }))
  },
  {
    key: 'textareaEditorWrap',
    label: 'Editor Wrap',
    description: 'Wrap long lines in the large editor',
    type: 'select',
    options: [
      { value: 'nowrap', label: 'No Wrap' },
      { value: 'wrap', label: 'Wrap' }
    ]
  },
  {
    key: 'textareaEditorFontSize',
    label: 'Editor Font Size',
    description: 'Default font size for large editor',
    type: 'select',
    options: TEXTAREA_EDITOR_FONT_SIZE_OPTIONS.map((value) => ({
      value: String(value),
      label: `${value}px`
    }))
  }
];

const settingListeners = new Set();
let cachedSettings = null;

function sanitizeSettingValue(key, value) {
  if (key === 'titleUpdater'
    || key === 'runTestShortcut'
    || key === 'jsonEditor'
    || key === 'outputCopy'
    || key === 'textareaEditor') {
    return Boolean(value);
  }

  if (key === 'textareaEditorLanguage') {
    return TEXTAREA_EDITOR_LANGUAGE_OPTIONS.includes(value)
      ? value
      : DEFAULT_SETTINGS.textareaEditorLanguage;
  }

  if (key === 'textareaEditorWrap') {
    return TEXTAREA_EDITOR_WRAP_OPTIONS.includes(value)
      ? value
      : DEFAULT_SETTINGS.textareaEditorWrap;
  }

  if (key === 'textareaEditorFontSize') {
    const parsed = Number.parseInt(String(value), 10);
    return TEXTAREA_EDITOR_FONT_SIZE_OPTIONS.includes(parsed)
      ? parsed
      : DEFAULT_SETTINGS.textareaEditorFontSize;
  }

  return DEFAULT_SETTINGS[key];
}

function sanitizeSettings(input) {
  const next = { ...DEFAULT_SETTINGS };

  if (!input || typeof input !== 'object') {
    return next;
  }

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      next[key] = sanitizeSettingValue(key, input[key]);
    }
  }

  return next;
}

function readFromStorage() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }

    const parsed = JSON.parse(raw);
    return sanitizeSettings(parsed);
  } catch (error) {
    console.error('Failed to load extension settings:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

function writeToStorage(settings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error('Failed to persist extension settings:', error);
  }
}

function notifySettingsChange() {
  if (!cachedSettings) return;
  const snapshot = { ...cachedSettings };
  for (const listener of settingListeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error('Settings listener failed:', error);
    }
  }
}

export function loadSettings() {
  if (!cachedSettings) {
    cachedSettings = readFromStorage();
  }
  return { ...cachedSettings };
}

export function saveSettings(nextSettings) {
  cachedSettings = sanitizeSettings(nextSettings);
  writeToStorage(cachedSettings);
  notifySettingsChange();
  return { ...cachedSettings };
}

export function getSetting(key) {
  const settings = loadSettings();
  return Boolean(settings[key]);
}

export function setSetting(key, value) {
  const settings = loadSettings();
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) {
    return settings;
  }

  const normalizedValue = sanitizeSettingValue(key, value);
  if (settings[key] === normalizedValue) {
    return settings;
  }

  const next = {
    ...settings,
    [key]: normalizedValue
  };

  return saveSettings(next);
}

export function subscribeSettings(listener) {
  settingListeners.add(listener);
  listener(loadSettings());

  return () => {
    settingListeners.delete(listener);
  };
}
