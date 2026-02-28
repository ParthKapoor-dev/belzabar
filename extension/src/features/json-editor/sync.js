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

function formatDateAsMDY(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${month}/${day}/${year}`;
}

function formatDateLong(isoDate) {
  const [year, month, day] = isoDate.split('-').map((part) => Number(part));
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return `${months[Math.max(0, month - 1)]} ${day}, ${year}`;
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

    const slashDate = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashDate) {
      const first = Number(slashDate[1]);
      const second = Number(slashDate[2]);
      const year = slashDate[3];

      // Handle both MM/DD/YYYY and DD/MM/YYYY safely.
      if (first > 12 && second >= 1 && second <= 12) {
        return { valid: true, stringValue: `${year}-${padTwo(second)}-${padTwo(first)}` };
      }

      return { valid: true, stringValue: `${year}-${padTwo(first)}-${padTwo(second)}` };
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

function asSafeString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  // SVG elements can expose className as SVGAnimatedString.
  if (typeof value === 'object' && typeof value.baseVal === 'string') {
    return value.baseVal;
  }

  try {
    const stringified = String(value);
    return stringified === '[object Object]' ? '' : stringified;
  } catch {
    return '';
  }
}

function dispatchMouseClick(element) {
  if (!element) return;

  if (typeof element.focus === 'function') {
    try {
      element.focus();
    } catch {
      // Ignore focus errors for detached/readonly nodes.
    }
  }

  if (typeof PointerEvent !== 'undefined') {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  }
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  if (typeof PointerEvent !== 'undefined') {
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
  }
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  if (typeof element.click === 'function') {
    try {
      element.click();
    } catch {
      // Ignore click errors.
    }
  }
}

function collectAngularNodes(node, seen = new Set(), nodes = []) {
  if (!node || seen.has(node)) {
    return nodes;
  }
  seen.add(node);

  if (typeof node === 'object' || typeof node === 'function') {
    nodes.push(node);
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectAngularNodes(item, seen, nodes);
    }
    return nodes;
  }

  if (typeof node === 'object') {
    for (const value of Object.values(node)) {
      if (typeof value === 'object' || typeof value === 'function') {
        collectAngularNodes(value, seen, nodes);
      }
    }
  }

  return nodes;
}

function syncAngularDateModel(inputElement, datePickerRoot, displayValue, isoValue, dateValue) {
  try {
    const candidates = [displayValue, isoValue, dateValue];
    const nodes = [];
    collectAngularNodes(inputElement?.__ngContext__, new Set(), nodes);
    collectAngularNodes(datePickerRoot?.__ngContext__, new Set(), nodes);

    let applied = false;
    for (const node of nodes) {
      if (!node) continue;

      // Reactive form controls.
      if (typeof node.setValue === 'function' && typeof node.updateValueAndValidity === 'function') {
        for (const candidate of candidates) {
          try {
            node.setValue(candidate, { emitEvent: true });
            if (typeof node.markAsDirty === 'function') node.markAsDirty();
            if (typeof node.markAsTouched === 'function') node.markAsTouched();
            node.updateValueAndValidity({ emitEvent: true });
            applied = true;
          } catch {
            // Try next candidate.
          }
        }
      }

      // ControlValueAccessor-style hooks.
      if (typeof node.writeValue === 'function') {
        for (const candidate of candidates) {
          try {
            node.writeValue(candidate);
            applied = true;
          } catch {
            // Try next candidate.
          }
        }
      }

      if (typeof node._onChange === 'function') {
        for (const candidate of candidates) {
          try {
            node._onChange(candidate);
            applied = true;
          } catch {
            // Try next candidate.
          }
        }
      }

      if (typeof node.onChange === 'function') {
        for (const candidate of candidates) {
          try {
            node.onChange(candidate);
            applied = true;
          } catch {
            // Try next candidate.
          }
        }
      }
    }

    return applied;
  } catch {
    return false;
  }
}

function isElementActuallyVisible(element) {
  if (!element) return false;
  if (element.closest('.display-none,[hidden],.ng-hide')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isLikelyDateElementVisible(element) {
  if (!element) return false;
  if (element.closest('.display-none')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  return true;
}

function findVisibleDayElements() {
  const selectors = [
    '.mat-calendar-body-cell-content',
    '.mat-calendar-body-cell',
    '.ngb-dp-day',
    '.owl-dt-calendar-cell-content',
    '.react-datepicker__day',
    '.flatpickr-day',
    '[data-date]',
    '[aria-label]'
  ];

  const all = document.querySelectorAll(selectors.join(','));
  return Array.from(all).filter((el) => isElementActuallyVisible(el));
}

function isDisabledDayCell(element) {
  if (!element) return true;
  const classes = asSafeString(element.className);
  const disabledPatterns = [
    'disabled',
    'mat-calendar-body-disabled',
    'ngb-dp-disabled',
    'flatpickr-disabled',
    'react-datepicker__day--disabled',
    'owl-dt-calendar-cell-disabled'
  ];
  return disabledPatterns.some((pattern) => classes.includes(pattern)) || element.hasAttribute('disabled');
}

function findDayCellByDate(isoDate) {
  const day = String(Number(isoDate.split('-')[2]));
  const mdy = formatDateAsMDY(isoDate).toLowerCase();
  const long = formatDateLong(isoDate).toLowerCase();
  const isoLower = isoDate.toLowerCase();

  const dayElements = findVisibleDayElements().filter((el) => !isDisabledDayCell(el));
  const exactMatches = [];
  const dayOnlyMatches = [];

  for (const el of dayElements) {
    const label = asSafeString(
      el.getAttribute('aria-label') ||
      el.getAttribute('data-date') ||
      el.getAttribute('title') ||
      el.textContent
    ).trim().toLowerCase();

    if (!label) continue;

    if (label.includes(isoLower) || label.includes(mdy) || label.includes(long)) {
      exactMatches.push(el);
      continue;
    }

    if ((el.textContent || '').trim() === day) {
      dayOnlyMatches.push(el);
    }
  }

  if (exactMatches.length > 0) {
    return exactMatches[0];
  }

  if (dayOnlyMatches.length === 1) {
    return dayOnlyMatches[0];
  }

  return null;
}

function findNavigationButtons() {
  const previousSelectors = [
    '.mat-calendar-previous-button',
    '.react-datepicker__navigation--previous',
    '.flatpickr-prev-month',
    '.owl-dt-control-button-content'
  ];
  const nextSelectors = [
    '.mat-calendar-next-button',
    '.react-datepicker__navigation--next',
    '.flatpickr-next-month',
    '.owl-dt-control-button-content'
  ];

  const prev = previousSelectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .find((el) => isElementActuallyVisible(el));
  const next = nextSelectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .find((el) => isElementActuallyVisible(el));

  return { prev, next };
}

function parseVisibleMonthYear() {
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ];
  const candidates = [
    '.mat-calendar-period-button',
    '.react-datepicker__current-month',
    '.flatpickr-current-month',
    '.owl-dt-calendar-control-content',
    '[class*="month"]',
    '[class*="calendar"]'
  ];

  const texts = candidates
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter((el) => isElementActuallyVisible(el))
    .map((el) => asSafeString(el.textContent).trim().toLowerCase())
    .filter(Boolean);

  for (const text of texts) {
    const yearMatch = text.match(/\b(19|20)\d{2}\b/);
    if (!yearMatch) continue;
    const monthIndex = monthNames.findIndex((month) => text.includes(month));
    if (monthIndex === -1) continue;
    return { year: Number(yearMatch[0]), month: monthIndex + 1 };
  }

  return null;
}

async function navigateCalendarToDate(isoDate) {
  const [targetYear, targetMonth] = isoDate.split('-').map((value, index) => (index < 2 ? Number(value) : value));

  for (let i = 0; i < 18; i++) {
    const current = parseVisibleMonthYear();
    if (!current) {
      break;
    }

    const currentIndex = current.year * 12 + current.month;
    const targetIndex = targetYear * 12 + targetMonth;
    if (currentIndex === targetIndex) {
      return true;
    }

    const { prev, next } = findNavigationButtons();
    if (targetIndex > currentIndex && next) {
      dispatchMouseClick(next);
    } else if (targetIndex < currentIndex && prev) {
      dispatchMouseClick(prev);
    } else {
      break;
    }

    await sleep(60);
  }

  return false;
}

function findConfirmButton() {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
  return buttons.find((button) => {
    if (!isElementActuallyVisible(button)) return false;
    const text = asSafeString(button.textContent).trim().toLowerCase();
    return ['apply', 'ok', 'done', 'set'].some((word) => text === word || text.includes(`${word} `));
  });
}

async function selectDateByCalendar(inputElement, datePickerRoot, isoDate) {
  const triggers = [
    inputElement,
    datePickerRoot?.querySelector('.datepicker_input-wrapper'),
    datePickerRoot?.querySelector('.datepicker_input-icon'),
    datePickerRoot?.querySelector('exp-svg-icon')
  ].filter(Boolean);

  for (const trigger of triggers) {
    dispatchMouseClick(trigger);
    await sleep(80);

    // Wait for calendar panel rendering.
    for (let waitAttempt = 0; waitAttempt < 6 && findVisibleDayElements().length === 0; waitAttempt++) {
      await sleep(40);
    }

    let dayCell = findDayCellByDate(isoDate);
    if (!dayCell) {
      await navigateCalendarToDate(isoDate);
      dayCell = findDayCellByDate(isoDate);
    }

    if (!dayCell) {
      continue;
    }

    dispatchMouseClick(dayCell);
    await sleep(70);

    const confirmButton = findConfirmButton();
    if (confirmButton) {
      dispatchMouseClick(confirmButton);
      await sleep(50);
    }

    // Commit-like interaction after choosing date.
    dispatchMouseClick(document.body);
    inputElement.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
    inputElement.dispatchEvent(new Event('focusout', { bubbles: true, cancelable: true }));
    await sleep(30);

    for (let commitAttempt = 0; commitAttempt < 10; commitAttempt++) {
      const currentValue = (
        inputElement.value ||
        inputElement.getAttribute('value') ||
        datePickerRoot?.getAttribute('value') ||
        ''
      ).trim();

      if (currentValue.length > 0) {
        return true;
      }

      await sleep(40);
    }
  }

  return false;
}

function findCalendarDateElement(isoDate) {
  const mdy = formatDateAsMDY(isoDate);
  const longLabel = formatDateLong(isoDate).toLowerCase();
  const dayText = String(Number(isoDate.split('-')[2]));

  const selectorPool = [
    '.mat-calendar-body-cell',
    '.ngb-dp-day',
    '.owl-dt-calendar-cell-content',
    '.react-datepicker__day',
    '.flatpickr-day',
    '.day',
    '[aria-label]',
    '[data-date]',
    '[title]'
  ];

  const all = document.querySelectorAll(selectorPool.join(','));
  for (const el of all) {
    if (!isLikelyDateElementVisible(el)) continue;

    const label = asSafeString(
      el.getAttribute('aria-label') ||
      el.getAttribute('data-date') ||
      el.getAttribute('title') ||
      el.textContent
    ).trim().toLowerCase();

    if (!label) continue;

    if (
      label.includes(isoDate.toLowerCase()) ||
      label.includes(mdy.toLowerCase()) ||
      label.includes(longLabel)
    ) {
      return el;
    }
  }

  // Fallback: pick a visible day cell with the same day number.
  const dayCandidates = Array.from(all).filter((el) => {
    if (!isLikelyDateElementVisible(el)) return false;
    const text = (el.textContent || '').trim();
    return text === dayText;
  });

  return dayCandidates.length > 0 ? dayCandidates[0] : null;
}

async function tryConfirmDateViaCalendar(inputElement, isoDate) {
  try {
    dispatchMouseClick(inputElement);
    await sleep(40);

    const dayElement = findCalendarDateElement(isoDate);
    if (dayElement) {
      dispatchMouseClick(dayElement);
      await sleep(30);
      return true;
    }
  } catch {
    // Ignore; fallback paths still run.
  }

  return false;
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

function setInputValueProgrammatically(input, value, options = {}) {
  const { overrideReadonly = false } = options;
  const hadReadonly = overrideReadonly && input.hasAttribute('readonly');
  if (hadReadonly) {
    input.removeAttribute('readonly');
  }

  const success = setFormControlValue(input, value);
  if (success) {
    input.setAttribute('value', value);
  }

  if (hadReadonly) {
    input.setAttribute('readonly', '');
  }

  return success;
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

async function setDatePickerValue(element, isoDate) {
  try {
    const datePickerRoot = element.closest('exp-date-picker');
    const wrapper = element.closest('.datepicker_input-wrapper');

    if (!isoDate) {
      const cleared = setInputValueProgrammatically(element, '', { overrideReadonly: true });
      if (cleared && datePickerRoot) {
        datePickerRoot.value = '';
        datePickerRoot.setAttribute('value', '');
        datePickerRoot.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        datePickerRoot.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }
      return cleared;
    }

    const displayCandidates = [formatDateAsMDY(isoDate), isoDate, isoDate.replace(/-/g, '/')];
    const uniqueCandidates = [...new Set(displayCandidates)];
    const [year, month, day] = isoDate.split('-').map((segment) => Number(segment));
    const parsedDate = new Date(year, month - 1, day);

    // Primary strategy: real calendar interaction (closest to manual behavior).
    const manualSelection = await selectDateByCalendar(element, datePickerRoot, isoDate);
    if (manualSelection) {
      await sleep(40);
      const postManualValue = (
        element.value ||
        element.getAttribute('value') ||
        datePickerRoot?.getAttribute('value') ||
        ''
      ).trim();

      // Do not run programmatic fallback after manual select; it can desync AD internals.
      if (postManualValue.length > 0) {
        log(`Date set via manual calendar emulation: ${postManualValue}`);
        element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
        if (datePickerRoot) {
          datePickerRoot.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          datePickerRoot.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        }
        if (wrapper) {
          wrapper.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          wrapper.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        }
        return true;
      }

      log('Manual calendar selection succeeded but value was still empty; using fallback write path');
    }

    log('Manual calendar emulation did not resolve date; using fallback write path');
    let writeSuccess = false;
    for (const candidate of uniqueCandidates) {
      const didSet = setInputValueProgrammatically(element, candidate, { overrideReadonly: true });
      if (!didSet) {
        continue;
      }

      // Keep host attribute in sync for AD internals/inspection.
      if (datePickerRoot) {
        datePickerRoot.setAttribute('value', candidate);
      }

      syncAngularDateModel(element, datePickerRoot, candidate, isoDate, parsedDate);

      // Native events only: custom events can be interpreted as value payloads by AD.
      element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
      if (datePickerRoot) {
        datePickerRoot.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        datePickerRoot.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }
      if (wrapper) {
        wrapper.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        wrapper.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }

      await tryConfirmDateViaCalendar(element, isoDate);

      // Commit-like interaction: click out after setting date.
      dispatchMouseClick(document.body);
      element.dispatchEvent(new Event('focusout', { bubbles: true, cancelable: true }));

      await sleep(10);
      const currentValue = element.value?.trim();
      if (/^\[object\s.+\]$/.test(currentValue || '')) {
        // Defensive: never leave event-object string in date field.
        setInputValueProgrammatically(element, candidate, { overrideReadonly: true });
      }
      if (currentValue === candidate) {
        writeSuccess = true;
        break;
      }
    }

    return writeSuccess;
  } catch (error) {
    console.error('Error setting date picker value:', error);
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
    const isDatePickerInput =
      (type === 'Date' || type === 'DateTime') &&
      target.tagName?.toLowerCase() === 'input' &&
      target.classList?.contains('datepicker_input-form');

    const writeSuccess = isBooleanSelect
      ? await setBooleanSelectValue(target, normalizedValue.stringValue)
      : isDatePickerInput
        ? await setDatePickerValue(target, normalizedValue.stringValue)
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

    const entries = Object.entries(data);
    entries.sort(([keyA], [keyB]) => {
      const inputA = inputMap.get(keyA);
      const inputB = inputMap.get(keyB);
      const aIsDate = inputA?.type === 'Date' || inputA?.type === 'DateTime';
      const bIsDate = inputB?.type === 'Date' || inputB?.type === 'DateTime';
      if (aIsDate === bIsDate) return 0;
      return aIsDate ? 1 : -1; // Process date fields last.
    });

    for (const [key, value] of entries) {
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
