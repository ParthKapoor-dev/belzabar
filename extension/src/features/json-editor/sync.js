import { log } from '../../core/logger.js';
import { extractAllInputs } from './extractor.js';

// JSON -> AD test-input synchronisation.
//
// Every type is driven through the real AD UI (native value setter + events
// for plain fields, simulated clicks for the `exp-*` custom widgets), then the
// written value is read back and verified. `window.ng` is not exposed on the
// production build and `__ngContext__` is an opaque numeric index, so driving
// Angular component instances directly is not an option here.

const STRUCTURED_TYPES = new Set(['Json', 'Array', 'Map', 'StructuredData']);
const DATE_TYPES = new Set(['Date', 'DateTime']);
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

// ---- value normalisation --------------------------------------------------
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
    if (['yes', 'true', '1'].includes(normalized)) return { valid: true, stringValue: 'Yes' };
    if (['no', 'false', '0'].includes(normalized)) return { valid: true, stringValue: 'No' };
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

// Parses a date (and optional time) into a normalised ISO date plus clock
// fields. Accepts ISO, `YYYY/M/D`, `M/D/YYYY`, `D/M/YYYY` and loose strings.
function parseDateValue(value) {
  if (value === null || value === undefined || value === '') {
    return { valid: true, date: '', hasTime: false, hour: 0, minute: 0 };
  }

  let hour = 0;
  let minute = 0;
  let hasTime = false;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      valid: true,
      date: formatDateAsYMD(value),
      hasTime: true,
      hour: value.getHours(),
      minute: value.getMinutes()
    };
  }

  if (typeof value !== 'string') {
    return { valid: false, error: `Invalid date value: ${String(value)}` };
  }

  const input = value.trim();

  // Pull a HH:MM time out of an ISO/loose datetime string.
  const timeMatch = input.match(/[T\s](\d{1,2}):(\d{2})/);
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2]);
    hasTime = hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
  }

  const datePart = input.split(/[T\s]/)[0];

  let isoDate = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    isoDate = datePart;
  } else {
    const ymdSlash = datePart.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    const mdySlash = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (ymdSlash) {
      isoDate = `${ymdSlash[1]}-${padTwo(ymdSlash[2])}-${padTwo(ymdSlash[3])}`;
    } else if (mdySlash) {
      const first = Number(mdySlash[1]);
      const second = Number(mdySlash[2]);
      // Disambiguate MM/DD vs DD/MM when the first part can't be a month.
      if (first > 12 && second >= 1 && second <= 12) {
        isoDate = `${mdySlash[3]}-${padTwo(second)}-${padTwo(first)}`;
      } else {
        isoDate = `${mdySlash[3]}-${padTwo(first)}-${padTwo(second)}`;
      }
    } else {
      const parsed = new Date(input);
      if (!Number.isNaN(parsed.getTime())) {
        isoDate = formatDateAsYMD(parsed);
        if (!hasTime && /\d{1,2}:\d{2}/.test(input)) {
          hour = parsed.getHours();
          minute = parsed.getMinutes();
          hasTime = true;
        }
      }
    }
  }

  if (!isoDate) {
    return { valid: false, error: `Invalid date value: ${String(value)}` };
  }
  return { valid: true, date: isoDate, hasTime, hour, minute };
}

function normalizeValueForType(value, type) {
  if (type === 'Boolean') return normalizeBooleanValue(value);
  if (type === 'Integer' || type === 'Number') return normalizeNumberValue(value, type);

  if (DATE_TYPES.has(type)) {
    const parsed = parseDateValue(value);
    return parsed.valid
      ? { valid: true, stringValue: parsed.date, dateInfo: parsed }
      : { valid: false, error: parsed.error };
  }

  if (STRUCTURED_TYPES.has(type) && value !== null && value !== undefined) {
    if (typeof value === 'string') return { valid: true, stringValue: value };
    if (typeof value === 'object') {
      return { valid: true, stringValue: JSON.stringify(value, null, 2) };
    }
    return { valid: true, stringValue: String(value) };
  }

  if (typeof value === 'object' && value !== null) {
    return { valid: true, stringValue: JSON.stringify(value, null, 2) };
  }
  if (value === null || value === undefined) {
    return { valid: true, stringValue: '' };
  }
  return { valid: true, stringValue: String(value) };
}

// ---- low-level DOM helpers ------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `fn` until it returns a truthy value or the attempts run out.
async function waitFor(fn, { tries = 24, interval = 30 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const result = fn();
      if (result) return result;
    } catch {
      // keep polling
    }
    await sleep(interval);
  }
  return null;
}

// Writes through the prototype's `value` setter so Angular/React value
// tracking sees the change.
function nativeSetValue(element, value) {
  const proto = Object.getPrototypeOf(element);
  const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
}

function fireInputEvents(element) {
  element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  if (typeof InputEvent !== 'undefined') {
    element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
  }
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

// AD's date/time widgets open, page and commit on a single native click.
// `.click()` dispatches exactly one click event — important, because those
// widgets toggle, so a second click would immediately close them again. A full
// synthetic PointerEvent sequence was also observed to lock up the date
// picker, so deliberately keep this to the element's own click.
function mouseClick(element) {
  if (!element) return;
  try {
    element.scrollIntoView({ block: 'center', inline: 'center' });
  } catch {
    // detached node — ignore
  }
  try {
    element.click();
  } catch {
    // ignore
  }
}

// ---- per-type setters -----------------------------------------------------
// Plain <textarea>/<input>: native write + events, verified by read-back.
function setTextValue(element, stringValue) {
  try {
    element.focus();
  } catch {
    // ignore
  }
  if (element.hasAttribute('readonly')) {
    element.removeAttribute('readonly');
  }
  nativeSetValue(element, stringValue);
  fireInputEvents(element);
  try {
    element.blur();
  } catch {
    // ignore
  }
  element.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
  return (element.value ?? '') === stringValue;
}

// Boolean <exp-select>: open the dropdown, click the matching option.
async function setBooleanValue(expSelect, stringValue) {
  const currentText = () =>
    expSelect.querySelector('.ui-select-match-text')?.textContent?.trim() || '';

  if (stringValue === '') {
    // No reliable "clear" affordance — treat an already-empty select as done.
    return currentText() === '';
  }
  if (currentText().toLowerCase() === stringValue.toLowerCase()) return true;

  const trigger =
    expSelect.querySelector('[data-testid="select-option-wrapper-container"]') ||
    expSelect.querySelector('.ui-select-container') ||
    expSelect.querySelector('.select-box-text') ||
    expSelect;
  mouseClick(trigger);

  const wanted = stringValue.toLowerCase();
  const option = await waitFor(() => {
    const scopes = [expSelect, document];
    for (const scope of scopes) {
      for (const opt of scope.querySelectorAll('.select-option-text')) {
        if (
          opt.offsetParent !== null &&
          opt.textContent?.trim().toLowerCase() === wanted
        ) {
          return opt.closest('a') || opt;
        }
      }
    }
    return null;
  });
  if (!option) return false;

  mouseClick(option);
  await sleep(60);
  return currentText().toLowerCase() === wanted;
}

function parseMonthLabel(text) {
  const lower = (text || '').toLowerCase();
  const yearMatch = lower.match(/\b(19|20)\d{2}\b/);
  // AD's calendar header abbreviates month names ("Jun 2026"), so match on the
  // first three letters — which are unique across all twelve months — rather
  // than the full name.
  const monthIndex = MONTHS.findIndex((m) => lower.includes(m.slice(0, 3)));
  if (!yearMatch || monthIndex < 0) return null;
  return { year: Number(yearMatch[0]), month: monthIndex + 1 };
}

// Opens AD's custom calendar for an <exp-date-picker> and returns its root.
async function openAdCalendar(datePickerRoot) {
  const findCalendar = () =>
    datePickerRoot.querySelector('.calendar') || document.querySelector('.calendar');

  const existing = findCalendar();
  if (existing) return existing;

  const triggers = [
    datePickerRoot.querySelector('.datepicker_input-icon exp-svg-icon'),
    datePickerRoot.querySelector('exp-svg-icon'),
    datePickerRoot.querySelector('.datepicker_input-icon'),
    datePickerRoot.querySelector('input.datepicker_input-form'),
    datePickerRoot.querySelector('.datepicker_input-wrapper'),
    datePickerRoot
  ].filter(Boolean);

  for (const trigger of triggers) {
    mouseClick(trigger);
    const calendar = await waitFor(findCalendar, { tries: 10, interval: 35 });
    if (calendar) return calendar;
  }
  return null;
}

// Date <exp-date-picker>: open the calendar, page to the target month, click
// the day cell. AD ships its own calendar markup (`.calendar_*`).
async function setDateValue(datePickerRoot, isoDate) {
  const input =
    datePickerRoot.querySelector('input.datepicker_input-form') ||
    datePickerRoot.querySelector('input');

  if (!isoDate) {
    if (input) {
      input.removeAttribute('readonly');
      nativeSetValue(input, '');
      fireInputEvents(input);
    }
    return !input || (input.value ?? '') === '';
  }

  if (input && input.value === isoDate) return true;

  const [year, month, day] = isoDate.split('-').map(Number);
  const calendar = await openAdCalendar(datePickerRoot);
  if (!calendar) return false;

  // Page month-by-month to the target.
  for (let i = 0; i < 60; i++) {
    const label = calendar.querySelector('.calendar_header_month_label_text');
    const current = label && parseMonthLabel(label.textContent || '');
    if (!current) break;

    const currentIndex = current.year * 12 + current.month;
    const targetIndex = year * 12 + month;
    if (currentIndex === targetIndex) break;

    const navButton = calendar.querySelector(
      currentIndex < targetIndex
        ? '.calendar_header_month_navigate_next'
        : '.calendar_header_month_navigate_prev'
    );
    if (!navButton) break;
    // The arrow's click handler lives on an inner <button>.
    mouseClick(navButton.querySelector('button') || navButton);
    await sleep(120);
  }

  // Click the matching current-month day cell.
  const dayCell = await waitFor(() => {
    for (const cell of calendar.querySelectorAll('.calendar_body_row_date.curr_month')) {
      if (/disable/.test(cell.className)) continue;
      const valueEl = cell.querySelector('.calendar_body_row_date_val') || cell;
      if ((valueEl.textContent || '').trim() === String(day)) return cell;
    }
    return null;
  });
  if (!dayCell) return false;

  mouseClick(dayCell);
  await sleep(80);

  const finalValue = (input?.value || '').trim();
  return finalValue === isoDate || finalValue.includes(isoDate);
}

// DateTime <exp-timepicker>: hour/minute are editable inputs; AM-PM is a
// spinner toggled with its chevron.
async function setTimeValue(expDateTime, hour24, minute) {
  const timepicker = expDateTime.querySelector('exp-timepicker');
  if (!timepicker) return false;

  const triggers = [
    timepicker.querySelector('.timepicker-placeholder'),
    timepicker.querySelector('.timepicker'),
    timepicker.querySelector('.timepicker-icon'),
    timepicker
  ].filter(Boolean);

  let inputs = null;
  for (const trigger of triggers) {
    mouseClick(trigger);
    inputs = await waitFor(() => {
      const visible = Array.from(
        document.querySelectorAll('input.time_select-input')
      ).filter((el) => el.offsetParent !== null);
      return visible.length >= 2 ? visible : null;
    }, { tries: 10, interval: 35 });
    if (inputs) break;
  }
  if (!inputs) return false;

  const ampmInput = inputs[2] || null; // present only in 12-hour mode
  let hour = hour24;
  let ampm = null;
  if (ampmInput) {
    ampm = hour24 >= 12 ? 'PM' : 'AM';
    hour = hour24 % 12;
    if (hour === 0) hour = 12;
  }

  setTextValue(inputs[0], String(hour));
  setTextValue(inputs[1], padTwo(minute));

  if (ampmInput && ampmInput.value.trim().toUpperCase() !== ampm) {
    const column = ampmInput.parentElement;
    const chevron = column && column.querySelector('exp-svg-icon.chevron, .chevron');
    if (chevron) {
      mouseClick(chevron.querySelector('button') || chevron);
      await sleep(80);
    }
  }

  // Commit by clicking away from the popup.
  mouseClick(document.body);
  await sleep(40);

  const hourOk = String(inputs[0].value).trim() === String(hour);
  const minuteOk = Number(inputs[1].value) === Number(minute);
  const ampmOk = !ampmInput || ampmInput.value.trim().toUpperCase() === ampm;
  return hourOk && minuteOk && ampmOk;
}

// DateTime <exp-date-time>: a calendar plus a timepicker.
async function setDateTimeValue(expDateTime, dateInfo) {
  const datePicker = expDateTime.querySelector('exp-date-picker') || expDateTime;
  let ok = await setDateValue(datePicker, dateInfo.date);
  if (dateInfo.date && dateInfo.hasTime) {
    ok = (await setTimeValue(expDateTime, dateInfo.hour, dateInfo.minute)) && ok;
  }
  return ok;
}

// ===== Public: populate one input =========================================
export async function populateTestValue(element, value, type) {
  if (type === 'File') {
    return {
      success: false,
      skipped: true,
      error: 'File inputs cannot be auto-filled by the extension'
    };
  }
  if (!element) {
    return { success: false, error: 'No input element found on the page' };
  }

  const normalized = normalizeValueForType(value, type);
  if (!normalized.valid) {
    return { success: false, error: normalized.error };
  }

  let ok = false;
  try {
    if (type === 'Boolean') {
      ok = await setBooleanValue(element, normalized.stringValue);
    } else if (type === 'Date') {
      ok = await setDateValue(element, normalized.stringValue);
    } else if (type === 'DateTime') {
      ok = await setDateTimeValue(element, normalized.dateInfo);
    } else {
      ok = setTextValue(element, normalized.stringValue);
    }
  } catch (error) {
    return { success: false, error: `Error writing ${type}: ${error.message}` };
  }

  if (!ok) {
    return { success: false, error: `Could not confirm ${type} value on the page` };
  }
  log(`Populated ${type} input`);
  return { success: true };
}

// ===== Public: sync a JSON object to the page =============================
export async function syncJSONToInputs(jsonString) {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch (error) {
    return {
      success: false,
      errors: [`Invalid JSON: ${error.message}`],
      filledCount: 0,
      skippedMissingKeys: [],
      failedKeys: []
    };
  }

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
      errors: ['No inputs found on page. Make sure Test Mode is on and you are on the Inputs step.'],
      filledCount: 0,
      skippedMissingKeys: [],
      failedKeys: []
    };
  }

  const inputMap = new Map(inputs.map((input) => [input.key, input]));
  const skippedMissingKeys = [];
  const failedKeys = [];
  const fileSkippedKeys = [];
  const warnings = [];
  let filledCount = 0;

  // Date/DateTime fields are processed last — opening their calendar/timepicker
  // overlays can otherwise interfere with sibling fields still being written.
  const entries = Object.entries(data).sort(([keyA], [keyB]) => {
    const aIsDate = DATE_TYPES.has(inputMap.get(keyA)?.type);
    const bIsDate = DATE_TYPES.has(inputMap.get(keyB)?.type);
    if (aIsDate === bIsDate) return 0;
    return aIsDate ? 1 : -1;
  });

  for (const [key, value] of entries) {
    const input = inputMap.get(key);
    if (!input) {
      skippedMissingKeys.push(key);
      continue;
    }

    const result = await populateTestValue(input.testValueElement, value, input.type);
    if (result.success) {
      filledCount++;
    } else if (result.skipped) {
      fileSkippedKeys.push(key);
      log(`Skipped ${key}: ${result.error}`);
    } else {
      failedKeys.push(key);
      log(`Failed to populate ${key}: ${result.error}`);
    }
  }

  if (skippedMissingKeys.length > 0) {
    warnings.push(
      `Not found on page (${skippedMissingKeys.length}): ${skippedMissingKeys.join(', ')}`
    );
  }
  if (fileSkippedKeys.length > 0) {
    warnings.push(
      `File input(s) skipped — pick the file manually (${fileSkippedKeys.length}): ${fileSkippedKeys.join(', ')}`
    );
  }
  if (failedKeys.length > 0) {
    warnings.push(`Failed to populate (${failedKeys.length}): ${failedKeys.join(', ')}`);
  }

  const totalKeys = Object.keys(data).length;
  const message = `Populated ${filledCount} of ${totalKeys} input(s)`;

  if (filledCount === 0) {
    return {
      success: false,
      message,
      errors: warnings.length > 0 ? warnings : ['No matching inputs were populated.'],
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
}
