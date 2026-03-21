import {
  EXTENSION_OWNED_ATTR,
  HEADER_BANNER_SELECTOR,
  SETTINGS_BUTTON_ID
} from '../../config/constants.js';
import { log } from '../../core/logger.js';
import { hideSettingsModal, openSettingsModal } from './modal.js';
import { subscribeObserver } from '../../core/observer.js';
import { PRIMARY_BUTTON_STYLE } from '../../ui/styles.js';

let unsubscribe = null;
let settingsInjectionTimer = null;
let settingsInitialTimer = null;
let settingsShortcutHandler = null;

function createSettingsButton(onClick) {
  const button = document.createElement('button');
  button.id = SETTINGS_BUTTON_ID;
  button.type = 'button';
  button.textContent = '⚙';
  button.setAttribute('title', 'Open extension settings');
  button.setAttribute('aria-label', 'Open extension settings');
  button.setAttribute(EXTENSION_OWNED_ATTR, 'true');

  Object.assign(button.style, PRIMARY_BUTTON_STYLE, {
    width: '30px',
    height: '30px',
    marginLeft: '8px',
    fontSize: '16px',
    lineHeight: '1'
  });

  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  };

  return button;
}

function injectSettingsButton(onOpen) {
  if (document.getElementById(SETTINGS_BUTTON_ID)) {
    return true;
  }

  const headerBanner = document.querySelector(HEADER_BANNER_SELECTOR);
  if (!headerBanner) {
    log('Settings injection skipped: .header_banner not found');
    return false;
  }

  const button = createSettingsButton(onOpen);
  const pageTitle = headerBanner.querySelector('.page_title');
  if (!pageTitle) {
    log('Settings injection skipped: .header_banner .page_title not found');
    return false;
  }

  if (pageTitle.style.display !== 'flex') {
    Object.assign(pageTitle.style, {
      display: 'flex',
      alignItems: 'center'
    });
  }

  pageTitle.appendChild(button);
  return true;
}

function debouncedInjectSettingsButton(onOpen) {
  if (settingsInjectionTimer) {
    clearTimeout(settingsInjectionTimer);
  }

  settingsInjectionTimer = setTimeout(() => {
    injectSettingsButton(onOpen);
  }, 250);
}

export function startSettingsFeature({
  getSettings,
  setSetting
}) {
  const openSettings = () => openSettingsModal({ getSettings, setSetting });

  settingsInitialTimer = setTimeout(() => {
    injectSettingsButton(openSettings);
  }, 400);

  if (!unsubscribe) {
    unsubscribe = subscribeObserver(() => {
      debouncedInjectSettingsButton(openSettings);
    });
  }

  settingsShortcutHandler = (event) => {
    if (
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      (event.key === ',' || event.code === 'Comma')
    ) {
      event.preventDefault();
      event.stopPropagation();
      openSettings();
    }
  };

  document.addEventListener('keydown', settingsShortcutHandler, true);
  return stopSettingsFeature;
}

export function stopSettingsFeature() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  if (settingsInjectionTimer) {
    clearTimeout(settingsInjectionTimer);
    settingsInjectionTimer = null;
  }

  if (settingsInitialTimer) {
    clearTimeout(settingsInitialTimer);
    settingsInitialTimer = null;
  }

  if (settingsShortcutHandler) {
    document.removeEventListener('keydown', settingsShortcutHandler, true);
    settingsShortcutHandler = null;
  }

  hideSettingsModal();

  const settingsButton = document.getElementById(SETTINGS_BUTTON_ID);
  if (settingsButton) {
    settingsButton.remove();
  }
}
