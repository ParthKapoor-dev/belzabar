import { log } from '../../core/logger.js';
import { extractAllInputs } from './extractor.js';

// JSON sync operations

const STRUCTURED_TYPES = new Set(['Json', 'Array', 'Map', 'StructuredData']);
const DATE_TYPES = new Set(['Date', 'DateTime']);

function padTwo(value) {
  return String(value).padStart(2, '0');
}

function formatDateAsYMD(date) {
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}`;
}

function normalizeBooleanValue(value) {
  if (value === null || value === undefined || value === '') {
    return { valid: true, stringValue: '' };
  }

  if (typeof value === 'boolean') {
    return { valid: true, stringValue: value ? 'Yes' : 'No' };
  }

  if (typeof value === 'number') {
    if (value === 1) return { valid: true, stringValue: 'Yes' };
    if (value === 0) return { valid: true, stringValue: 'No' };
    return { valid: false, error: `Unsupported boolean number: ${value}` };
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['yes', 'true', '1'].includes(normalized)) {
      return { valid: true, stringValue: 'Yes' };
    }

    if (['no', 'false', '0'].includes(normalized)) {
      return { valid: true, stringValue: 'No' };
    }

    return { valid: false, error: `Unsupported boolean string: "${value}"` };
  }

  return { valid: false, error: `Unsupported boolean value type: ${typeof value}` };
}

function normalizeNumberValue(value, type) {
  if (value === null || value === undefined || value === '') {
    return { valid: true, stringValue: '' };
  }

  const normalized = typeof value === 'number' ? value : Number(String(value).trim());
  if (Number.isNaN(normalized)) {
    return { valid: false, error: `Invalid ${type.toLowerCase()} value: ${value}` };
  }

  if (type === 'Integer' && !Number.isInteger(normalized)) {
    return { valid: false, error: `Expected integer, got: ${value}` };
  }

  return { valid: true, stringValue: String(normalized) };
}

function normalizeDateValue(value) {
  if (value === null || value === undefined || value === '') {
    return { valid: true, stringValue: '' };
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { valid: true, stringValue: formatDateAsYMD(value) };
  }

  if (typeof value === 'string') {
    const input = value.trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      return { valid: true, stringValue: input };
    }

    const ymdWithSlash = input.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (ymdWithSlash) {
      const [, year, month, day] = ymdWithSlash;
      return { valid: true, stringValue: `${year}-${padTwo(month)}-${padTwo(day)}` };
    }

    const mdY = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdY) {
      const [, month, day, year] = mdY;
      return { valid: true, stringValue: `${year}-${padTwo(month)}-${padTwo(day)}` };
    }

    const isoLike = input.match(/^(\d{4}-\d{2}-\d{2})T/);
    if (isoLike) {
      return { valid: true, stringValue: isoLike[1] };
    }

    const parsed = new Date(input);
    if (!Number.isNaN(parsed.getTime())) {
      return { valid: true, stringValue: formatDateAsYMD(parsed) };
    }
  }

  return { valid: false, error: `Invalid date value: ${String(value)}` };
}

function normalizeValueForType(value, type) {
  if (type === 'Boolean') {
    return normalizeBooleanValue(value);
  }

  if (type === 'Integer' || type === 'Number') {
    return normalizeNumberValue(value, type);
  }

  if (DATE_TYPES.has(type)) {
    return normalizeDateValue(value);
  }

  if (STRUCTURED_TYPES.has(type) && value !== null && value !== undefined) {
    if (typeof value === 'string') {
      return { valid: true, stringValue: value };
    }

    if (typeof value === 'object') {
      return { valid: true, stringValue: JSON.stringify(value, null, 2) };
    }

    return { valid: true, stringValue: String(value) };
  }

  // Defensive fallback: avoid "[object Object]" for any unexpected object payload.
  if (typeof value === 'object' && value !== null) {
    return { valid: true, stringValue: JSON.stringify(value, null, 2) };
  }

  if (value === null || value === undefined) {
    return { valid: true, stringValue: '' };
  }

  return { valid: true, stringValue: String(value) };
}

function dispatchInputEvents(element) {
  element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

  if (typeof InputEvent !== 'undefined') {
    element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
  }

  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dispatchMouseClick(element) {
  if (!element) return;

  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function setFormControlValue(element, stringValue) {
  try {
    if (typeof element.focus === 'function') {
      element.focus();
    }

    const prototype = Object.getPrototypeOf(element);
    const valueDescriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    if (valueDescriptor && typeof valueDescriptor.set === 'function') {
      valueDescriptor.set.call(element, stringValue);
    } else {
      element.value = stringValue;
    }

    dispatchInputEvents(element);

    if (typeof element.blur === 'function') {
      element.blur();
    }

    return true;
  } catch (error) {
    console.error('Error setting form control value:', error);
    return false;
  }
}

function ensureBooleanMatchText(element, stringValue) {
  const selectBoxText = element.querySelector('.select-box-text');
  if (!selectBoxText) {
    return false;
  }

  const placeholder = selectBoxText.querySelector('.ui-select-placeholder');
  if (placeholder) {
    placeholder.remove();
  }

  let wrapper = selectBoxText.querySelector('span.flex.items-center');
  if (!wrapper) {
    wrapper = document.createElement('span');
    wrapper.className = 'flex items-center ng-star-inserted';
    selectBoxText.appendChild(wrapper);
  }

  let matchText = wrapper.querySelector('.ui-select-match-text');
  if (!matchText) {
    matchText = document.createElement('span');
    matchText.className = 'ui-select-match-text single-dropdown-wrap text_grey_darkest ng-star-inserted';
    matchText.setAttribute('showplaceholdericon', '');
    wrapper.appendChild(matchText);
  }

  matchText.textContent = stringValue;
  return true;
}

function findBooleanOptionElement(root, stringValue) {
  const expected = stringValue.trim().toLowerCase();
  const options = root.querySelectorAll('.select-option-text');

  for (const option of options) {
    if (option.textContent?.trim().toLowerCase() === expected) {
      return option.closest('a') || option;
    }
  }

  return null;
}

async function setBooleanSelectValue(element, stringValue) {
  try {
    const trigger =
      element.querySelector('[data-testid="select-option-wrapper-container"]') ||
      element.querySelector('.ui-select-container') ||
      element;

    // Open the select first so option nodes are rendered.
    dispatchMouseClick(trigger);

    let optionToClick = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      optionToClick = findBooleanOptionElement(element, stringValue);
      if (optionToClick) break;
      await sleep(25);
    }

    if (optionToClick) {
      dispatchMouseClick(optionToClick);
      await sleep(10);
    }

    ensureBooleanMatchText(element, stringValue);

    const booleanValue = stringValue === 'Yes';
    const payloads = [
      stringValue,
      booleanValue,
      { value: stringValue, name: stringValue },
      { value: booleanValue, name: stringValue },
      { label: stringValue, value: booleanValue }
    ];
    const eventNames = ['valueChange', 'selectionChange', 'modelChange', 'ngModelChange'];

    for (const eventName of eventNames) {
      for (const payload of payloads) {
        element.dispatchEvent(new CustomEvent(eventName, {
          detail: payload,
          bubbles: true,
          cancelable: true
        }));

        trigger.dispatchEvent(new CustomEvent(eventName, {
          detail: payload,
          bubbles: true,
          cancelable: true
        }));
      }
    }

    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

    const selectedText = element.querySelector('.ui-select-match-text')?.textContent?.trim();
    return selectedText === stringValue;
  } catch (error) {
    console.error('Error setting boolean select value:', error);
    return false;
  }
}

function resolveWritableElements(element, type, container) {
  if (!element) {
    return [];
  }

  const resolved = [];
  const seen = new Set();

  const add = (target) => {
    if (!target || seen.has(target)) {
      return;
    }
    seen.add(target);
    resolved.push(target);
  };

  if (type === 'StructuredData' && container) {
    const testCaseRow = container.querySelector('.service-designer__grid-row._test-case-row');
    const defaultTextarea = testCaseRow?.querySelector('.wrapper-content.textarea_outer.default_value textarea');
    const firstTextarea = testCaseRow?.querySelector('textarea');

    add(defaultTextarea);
    add(firstTextarea);
  }

  add(element);
  return resolved;
}

// ===== Step 6: Enhanced Value Synchronization =====
export async function populateTestValue(element, value, type, container) {
  if (!element) {
    return { success: false, error: 'No element provided for population' };
  }

  const normalizedValue = normalizeValueForType(value, type);
  if (!normalizedValue.valid) {
    return { success: false, error: normalizedValue.error };
  }

  const elementsToPopulate = resolveWritableElements(element, type, container);
  if (elementsToPopulate.length === 0) {
    return { success: false, error: 'No writable element found' };
  }

  let writeCount = 0;
  for (const target of elementsToPopulate) {
    const isBooleanSelect = type === 'Boolean' && target.tagName?.toLowerCase() === 'exp-select';
    const writeSuccess = isBooleanSelect
      ? await setBooleanSelectValue(target, normalizedValue.stringValue)
      : setFormControlValue(target, normalizedValue.stringValue);

    if (writeSuccess) {
      writeCount++;
    }
  }

  if (writeCount === 0) {
    return { success: false, error: 'Failed to write value to target element(s)' };
  }

  log(`Populated ${writeCount} element(s) for type ${type}`);
  return { success: true };
}

export async function syncJSONToInputs(jsonString) {
  try {
    const data = JSON.parse(jsonString);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return {
        success: false,
        errors: ['JSON must be an object with key-value pairs'],
        filledCount: 0,
        skippedMissingKeys: [],
        failedKeys: []
      };
    }

    const inputs = extractAllInputs(true);
    if (inputs.length === 0) {
      return {
        success: false,
        errors: ['No inputs found on page. Make sure you are on the correct step.'],
        filledCount: 0,
        skippedMissingKeys: [],
        failedKeys: []
      };
    }

    const inputMap = new Map(inputs.map((input) => [input.key, input]));
    const skippedMissingKeys = [];
    const failedKeys = [];
    const warnings = [];
    let filledCount = 0;

    for (const [key, value] of Object.entries(data)) {
      const input = inputMap.get(key);
      if (!input) {
        skippedMissingKeys.push(key);
        continue;
      }

      const populateResult = await populateTestValue(
        input.testValueElement,
        value,
        input.type,
        input.container
      );
      if (populateResult.success) {
        filledCount++;
      } else {
        failedKeys.push(key);
        log(`Failed to populate ${key}: ${populateResult.error}`);
      }
    }

    if (skippedMissingKeys.length > 0) {
      warnings.push(
        `Skipped key(s) not found on page (${skippedMissingKeys.length}): ${skippedMissingKeys.join(', ')}`
      );
    }

    if (failedKeys.length > 0) {
      warnings.push(`Failed to populate key(s) (${failedKeys.length}): ${failedKeys.join(', ')}`);
    }

    const totalKeys = Object.keys(data).length;
    const message = `Successfully populated ${filledCount} of ${totalKeys} input(s)`;

    if (filledCount === 0) {
      const errors = warnings.length > 0
        ? warnings
        : ['No matching inputs were populated.'];

      return {
        success: false,
        message,
        errors,
        warnings: warnings.length > 0 ? warnings : undefined,
        filledCount,
        skippedMissingKeys,
        failedKeys
      };
    }

    return {
      success: true,
      message,
      warnings: warnings.length > 0 ? warnings : undefined,
      filledCount,
      skippedMissingKeys,
      failedKeys
    };
  } catch (error) {
    console.error('Error syncing JSON:', error);
    return {
      success: false,
      errors: [`Invalid JSON: ${error.message}`],
      filledCount: 0,
      skippedMissingKeys: [],
      failedKeys: []
    };
  }
}
