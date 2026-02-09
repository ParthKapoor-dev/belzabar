import { log } from '../../core/logger.js';
import { state } from '../../core/state.js';
import { normalizeDataType } from './types.js';

// Input extraction logic

// ===== Step 1: Key Detection =====
export function findAllInputKeys() {
  try {
    const elements = document.querySelectorAll('[id^="INPUT_LIST_"]');
    const keys = [];

    for (const el of elements) {
      const id = el.id;
      if (id && id.startsWith('INPUT_LIST_')) {
        const key = id.substring('INPUT_LIST_'.length);
        if (key) {
          keys.push({ key, element: el });
          log('Found input key:', key);
        }
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
    const cells = container.querySelectorAll('.service-designer__grid-cell');

    if (cells.length < 2) {
      log('Not enough grid cells found');
      return 'Text';
    }

    const typeCell = cells[1]; // 2nd cell (index 1)

    // Strategy 1: Look for div.type_name elements (common in newer UI)
    const typeNameDiv = typeCell.querySelector('.type_name');
    if (typeNameDiv) {
      const text = typeNameDiv.textContent?.trim();
      if (text && text.length > 0 && text.length < 30) {
        log('Found type from div.type_name:', text);
        return normalizeDataType(text);
      }
    }

    // Strategy 2: Look for span with type text
    const spans = typeCell.querySelectorAll('span');
    for (const span of spans) {
      const text = span.textContent?.trim();
      if (text && text.length > 0 && text.length < 30) {
        // Check if it looks like a type (not too long, no special chars)
        if (!/[{}[\]()#@]/.test(text)) {
          log('Found type from span:', text);
          return normalizeDataType(text);
        }
      }
    }

    // Strategy 3: Look in select elements
    const select = typeCell.querySelector('.ui-select-match-text');
    if (select) {
      const text = select.textContent?.trim();
      if (text) {
        log('Found type from select:', text);
        return normalizeDataType(text);
      }
    }

    log('Type not found, defaulting to Text');
    return 'Text';
  } catch (error) {
    console.error('Error extracting data type:', error);
    return 'Text';
  }
}

// ===== Step 4: Test Value Element Detection =====
export function findTestValueElement(container, type) {
  try {
    // Look for the test case row
    const testCaseRow = container.querySelector('.service-designer__grid-row._test-case-row');

    if (!testCaseRow) {
      log('Test case row not found');
      return null;
    }

    // Check if this is a structured data input (has nested structured data grid)
    const isStructuredData = container && container.querySelector('.service-designer__grid-row._structured') !== null;

    let element;

    if (isStructuredData) {
      // For structured data, use the main textarea (not the default_value one)
      element = testCaseRow.querySelector('textarea:not(.wrapper-content.textarea_outer.default_value textarea)');
      if (!element) {
        // Fallback to any textarea
        element = testCaseRow.querySelector('textarea');
      }
      log(`Found structured data textarea for extraction (main: ${!!element})`);
    } else if (type === 'Boolean') {
      // For boolean types, look for the exp-select within boolean_response div
      element = testCaseRow.querySelector('.boolean_response exp-select');
      if (element) {
        log('Found boolean select element');
      } else {
        log('Boolean select element not found');
      }
    } else {
      // For regular inputs, find textarea first (for text/json/array/map types)
      element = testCaseRow.querySelector('textarea');

      // If no textarea found, look for input elements (for integer/boolean/number/date types)
      if (!element) {
        // Try different input selectors in order of specificity
        element = testCaseRow.querySelector('input[placeholder="Enter Here"]') ||
                  testCaseRow.querySelector('input.datepicker_input-form') ||
                  testCaseRow.querySelector('input[type="text"]') ||
                  testCaseRow.querySelector('input');
      }
    }

    if (!element) {
      log('Neither textarea nor input element found in test case row');
      return null;
    }

    // Verify it's visible
    if (element.offsetParent === null) {
      log('Test value element is hidden');
      return null;
    }

    log(`Found test value element: ${element.tagName.toLowerCase()} with placeholder "${element.placeholder || 'none'}" (structured: ${isStructuredData})`);
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