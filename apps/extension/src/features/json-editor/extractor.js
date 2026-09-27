import { log } from '../../core/logger.js';
import { state } from '../../core/state.js';
import { normalizeDataType } from './types.js';

// Input extraction logic

// ===== Step 1: Key Detection =====
export function findAllInputKeys() {
  try {
    const keys = [];
    const seenKeys = new Set();

    const collectKeys = (elements) => {
      for (const el of elements) {
        const id = el.id;
        if (!id) continue;

        let key = null;

        if (id.startsWith('INPUT_LIST_')) {
          key = id.substring('INPUT_LIST_'.length);
        } else {
          const fallbackMatch = id.match(/^INPUT_LIST\d+\.(.+)$/);
          if (fallbackMatch) {
            key = fallbackMatch[1];
          }
        }

        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        keys.push({ key, element: el });
        log('Found input key:', key);
      }
    };

    // Primary selector used by current implementation.
    collectKeys(document.querySelectorAll('[id^="INPUT_LIST_"]'));

    // Fallback for pages that only expose numeric INPUT_LIST ids.
    if (keys.length === 0) {
      collectKeys(document.querySelectorAll('[id^="INPUT_LIST"]'));
    }

    // Published page fallback: no INPUT_LIST ids — keys live in .fieldCode spans
    if (keys.length === 0) {
      const fieldCodeDivs = document.querySelectorAll('.fieldCode');
      for (const div of fieldCodeDivs) {
        const spans = Array.from(div.querySelectorAll('span'));
        let key = null;
        let foundHash = false;
        for (const span of spans) {
          const text = span.textContent?.trim();
          if (!text) continue;
          if (text === '#{') { foundHash = true; continue; }
          if (foundHash && text !== '}') { key = text; break; }
        }
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        keys.push({ key, element: div });
        log('Found input key (published page):', key);
      }
    }

    log(`Total input keys found: ${keys.length}`);
    return keys;
  } catch (error) {
    console.error('Error finding input keys:', error);
    return [];
  }
}

// ===== Step 2: Container Identification =====
export function findInputContainer(element) {
  try {
    let current = element;
    let depth = 0;
    const maxDepth = 15;

    while (current && depth < maxDepth) {
      if (current.classList && current.classList.contains('service-designer__grid-row')) {
        log('Found container at depth:', depth);
        return current;
      }
      current = current.parentElement;
      depth++;
    }

    log('Container not found within max depth');
    return null;
  } catch (error) {
    console.error('Error finding container:', error);
    return null;
  }
}

// ===== Step 3: Data Type Extraction =====
export function extractDataType(container) {
  try {
    // The type lives in the row's dedicated `_type` cell. Query it directly so
    // the cells of a nested `_test-case-row` can never shadow the real one
    // (querying `.service-designer__grid-cell` unscoped picked those up too).
    const typeCell =
      container.querySelector(':scope > .service-designer__grid-cell._type') ||
      container.querySelector('.service-designer__grid-cell._type');

    if (!typeCell) {
      log('Type cell not found, defaulting to Text');
      return 'Text';
    }

    // Draft mode: type is an editable select.
    const selectMatchText = typeCell.querySelector('.ui-select-match-text');
    if (selectMatchText && selectMatchText.textContent?.trim()) {
      return normalizeDataType(selectMatchText.textContent.trim());
    }

    // Newer UI: a `.type_name` div.
    const typeNameDiv = typeCell.querySelector('.type_name');
    if (typeNameDiv && typeNameDiv.textContent?.trim()) {
      return normalizeDataType(typeNameDiv.textContent.trim());
    }

    // Published mode: the cell is plain text (e.g. "Date", "Structured Data").
    const text = typeCell.textContent?.trim();
    if (text && text.length < 40) {
      return normalizeDataType(text);
    }

    log('Type text empty, defaulting to Text');
    return 'Text';
  } catch (error) {
    console.error('Error extracting data type:', error);
    return 'Text';
  }
}

// ===== Step 4: Test Value Element Detection =====
//
// Returns the semantic element for each type: the `exp-*` host for custom
// widgets (so the sync layer can drive the real UI) and the plain field for
// text-like types. The File input is returned even though it is hidden, so the
// sync layer can report it as "skipped" rather than silently dropping the key.
export function findTestValueElement(container, type) {
  try {
    const testCaseRow = container.querySelector('.service-designer__grid-row._test-case-row');
    if (!testCaseRow) {
      log('Test case row not found (is Test Mode on?)');
      return null;
    }

    let element = null;

    switch (type) {
      case 'Boolean':
        element =
          testCaseRow.querySelector('.boolean_response exp-select') ||
          testCaseRow.querySelector('exp-select');
        break;

      case 'Date':
        element = testCaseRow.querySelector('exp-date-picker');
        break;

      case 'DateTime':
        element =
          testCaseRow.querySelector('exp-date-time') ||
          testCaseRow.querySelector('exp-date-picker');
        break;

      case 'File':
        element = testCaseRow.querySelector('input[type="file"]');
        break;

      case 'Integer':
      case 'Number':
        element =
          testCaseRow.querySelector('input[type="number"]') ||
          testCaseRow.querySelector('input[placeholder="Enter Here"]') ||
          testCaseRow.querySelector('input.input_default') ||
          testCaseRow.querySelector('input:not([type="file"]):not([type="checkbox"])');
        break;

      default:
        // Text, Url, Json, Array, Map, StructuredData — plain textareas.
        element =
          testCaseRow.querySelector('textarea') ||
          testCaseRow.querySelector('input[placeholder="Enter Here"]') ||
          testCaseRow.querySelector('input:not([type="file"]):not([type="checkbox"])');
    }

    if (!element) {
      log(`Test value element not found for type: ${type}`);
      return null;
    }

    log(`Found test value <${element.tagName.toLowerCase()}> for type ${type}`);
    return element;
  } catch (error) {
    console.error('Error finding test value element:', error);
    return null;
  }
}

// ===== Step 5: Input Name Extraction =====
export function extractInputName(container, key) {
  try {
    const cells = container.querySelectorAll('.service-designer__grid-cell');
    
    if (cells.length < 1) {
      log('No grid cells found for name extraction');
      return key;
    }

    const nameCell = cells[0]; // 1st cell

    // Strategy 1: Find input with placeholder "Enter Here"
    const nameInput = nameCell.querySelector('input[placeholder="Enter Here"]');
    if (nameInput && nameInput.value && nameInput.value.trim()) {
      log('Found name from input:', nameInput.value);
      return nameInput.value.trim();
    }

    // Strategy 2: Extract from Field Code
    const fieldCodeMatch = container.textContent?.match(/Field Code:\s*#\{([^}]+)\}/);
    if (fieldCodeMatch && fieldCodeMatch[1]) {
      log('Found name from field code:', fieldCodeMatch[1]);
      return fieldCodeMatch[1];
    }

    // Fallback: Use key
    log('Using key as name:', key);
    return key;
  } catch (error) {
    console.error('Error extracting input name:', error);
    return key;
  }
}

// ===== Mandatory Detection =====
export function isMandatory(container) {
  try {
    // Look for mandatory indicators
    const text = container.textContent || '';
    
    // Check for asterisk or "Yes" in mandatory cell
    if (/\*|mandatory|required/i.test(text)) {
      const mandatoryCells = container.querySelectorAll('.service-designer__grid-cell._mandatory');
      if (mandatoryCells.length > 0) {
        const cellText = mandatoryCells[0].textContent?.trim().toLowerCase();
        return cellText === 'yes';
      }
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error checking mandatory:', error);
    return false;
  }
}

// ===== Main Input Extraction with Caching =====
export function extractAllInputs(forceRefresh = false) {
  try {
    // Use cache if available and recent (within 2 seconds)
    const now = Date.now();
    if (!forceRefresh && state.cachedInputs && (now - state.lastInputScanTime) < 2000) {
      log('Using cached inputs');
      return state.cachedInputs;
    }

    log('Starting input extraction...');
    const inputs = [];
    
    // Step 1: Find all input keys
    const keyElements = findAllInputKeys();

    if (keyElements.length === 0) {
      log('No input keys found');
      state.cachedInputs = [];
      state.lastInputScanTime = now;
      return [];
    }

    // Process each input
    for (const { key, element } of keyElements) {
      try {
        // Step 2: Find container
        const container = findInputContainer(element);
        if (!container) {
          log(`Container not found for key: ${key}`);
          continue;
        }

        // Step 3: Extract data type
        const type = extractDataType(container);

        // Check if this is structured data
        const isStructuredData = type === 'StructuredData';

        // Step 4: Find test value element
        const testValueElement = findTestValueElement(container, type);
        if (!testValueElement) {
          log(`Test value element not found for key: ${key}`);
          continue;
        }

        // Step 5: Extract name
        const name = extractInputName(container, key);

        // Get current value - for structured data, try to find the best textarea
        let currentValue = testValueElement.value || '';

        // For boolean exp-select, get value from match text
        if (type === 'Boolean' && testValueElement.tagName.toLowerCase() === 'exp-select') {
          const matchText = testValueElement.querySelector('.ui-select-match-text');
          currentValue = matchText ? matchText.textContent.trim() : '';
          log(`Got boolean value from select: ${currentValue}`);
        }

        // For structured data, if the main textarea contains "[object Object]", try the default_value textarea
        if (isStructuredData && currentValue === '[object Object]') {
          const testCaseRow = container.querySelector('.service-designer__grid-row._test-case-row');
          if (testCaseRow) {
            const defaultTextarea = testCaseRow.querySelector('.wrapper-content.textarea_outer.default_value textarea');
            if (defaultTextarea && defaultTextarea.value && defaultTextarea.value !== '[object Object]') {
              currentValue = defaultTextarea.value;
              log(`Using default_value textarea for structured data: ${currentValue.substring(0, 50)}...`);
            }
          }
        }

        // Check if mandatory
        const mandatory = isMandatory(container);

        inputs.push({
          key,
          name,
          type,
          testValueElement,
          mandatory,
          currentValue,
          container
        });

        log(`Extracted input: ${key} (${name}) - Type: ${type}, Mandatory: ${mandatory}`);
      } catch (error) {
        console.error(`Error processing input ${key}:`, error);
      }
    }

    log(`Successfully extracted ${inputs.length} inputs`);
    
    // Update cache
    state.cachedInputs = inputs;
    state.lastInputScanTime = now;

    return inputs;
  } catch (error) {
    console.error('Error in extractAllInputs:', error);
    return [];
  }
}
