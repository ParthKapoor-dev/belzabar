const SETTINGS_STORAGE_KEY = 'sdExtensionSettingsV1';

export const DEFAULT_SETTINGS = {
  titleUpdater: true,
  runTestShortcut: true,
  jsonEditor: true,
  outputCopy: true,
  textareaEditor: true
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

const settingListeners = new Set();
let cachedSettings = null;

function sanitizeSettings(input) {
  const next = { ...DEFAULT_SETTINGS };

  if (!input || typeof input !== 'object') {
    return next;
  }

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      next[key] = Boolean(input[key]);
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

  const normalizedValue = Boolean(value);
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

