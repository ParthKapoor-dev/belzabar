// All constants and selectors
export const METHOD_INPUT_SELECTOR = 'input#SD1_MethodName';

export const RUN_TEST_EXP_BUTTON_SELECTORS = [
  'exp-button#runTest',
  'exp-button.run_test_btn',
  'exp-button[aria-label="run Test"]',
  'exp-button[arialabel="run Test"]'
];

export const OUTPUT_CONTAINER_SELECTOR = '.output-container, .output_container';
export const TEXTAREA_SELECTOR = 'textarea';
export const TEXTAREA_EDITOR_BOUND_ATTR = 'data-sd-textarea-editor-bound';
export const TEXTAREA_EDITOR_LAUNCHER_CLASS = 'sdExtensionTextareaLauncher';
export const EXTENSION_OWNED_ATTR = 'data-sd-extension-owned';
export const HEADER_BANNER_SELECTOR = '.header_banner';
export const SETTINGS_BUTTON_ID = 'sdExtensionSettingsButton';
export const SETTINGS_MODAL_ID = 'sdExtensionSettingsModal';

export const OBSERVER_OPTIONS = {
  childList: true,
  subtree: true
};

export const DEBUG = false; // Set to true for console logging
