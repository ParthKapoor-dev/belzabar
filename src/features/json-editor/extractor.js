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
    
    // Strategy 1: Look for span with type text
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

    // Strategy 2: Look in select elements
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
export function findTestValueElement(container) {
  try {
    // Look for the test case row
    const testCaseRow = container.querySelector('.service-designer__grid-row._test-case-row');
    
    if (!testCaseRow) {
      log('Test case row not found');
      return null;
    }

    // Find textarea within test case row
    const textarea = testCaseRow.querySelector('textarea');
    
    if (!textarea) {
      log('Textarea not found in test case row');
      return null;
    }

    // Verify it's visible
    if (textarea.offsetParent === null) {
      log('Textarea is hidden');
      return null;
    }

    log('Found test value textarea');
    return textarea;
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

        // Step 4: Find test value element
        const testValueElement = findTestValueElement(container);
        if (!testValueElement) {
          log(`Test value element not found for key: ${key}`);
          continue;
        }

        // Step 5: Extract name
        const name = extractInputName(container, key);

        // Get current value
        const currentValue = testValueElement.value || '';

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