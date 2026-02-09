import { log } from '../../core/logger.js';
import { extractAllInputs } from './extractor.js';

// JSON sync operations

// ===== Step 6: Enhanced Value Synchronization =====
export function populateTestValue(element, value, type, container) {
  if (!element) {
    console.error('No element provided for population');
    return false;
  }

  try {
    // Convert value to string based on type
    let stringValue = '';

    if (value === null || value === undefined) {
      stringValue = '';
    } else if (['Json', 'Array', 'Map', 'StructuredData'].includes(type) && typeof value === 'object') {
      stringValue = JSON.stringify(value, null, 2);
    } else if (type === 'Boolean') {
      stringValue = value ? 'Yes' : 'No';
    } else {
      stringValue = String(value);
    }

    // For boolean exp-select elements, handle differently
    if (type === 'Boolean' && element.tagName.toLowerCase() === 'exp-select') {
      // Use Angular events to set the value properly
      const valueToSet = stringValue;

      // Dispatch custom events that Angular components listen to
      element.dispatchEvent(new CustomEvent('valueChange', {
        detail: valueToSet,
        bubbles: true,
        cancelable: true
      }));

      element.dispatchEvent(new CustomEvent('selectionChange', {
        detail: valueToSet,
        bubbles: true,
        cancelable: true
      }));

      // Also try standard change events
      element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

      log(`Dispatched value change events for boolean: ${valueToSet}`);
      return true;
    }

    // For structured data inputs, just use the element found by findTestValueElement
    const isStructuredData = container && container.querySelector('.service-designer__grid-row._structured') !== null;
    const elementsToPopulate = [];

    // For all inputs including structured data, populate the textarea with JSON
    elementsToPopulate.push(element);

    // Populate all identified elements
    for (const el of elementsToPopulate) {
      el.value = stringValue;

      // Enhanced Angular change detection
      el.focus();

      // Use longer delays for structured data to allow Angular processing
      const delay = isStructuredData ? 100 : 10;

      setTimeout(() => {
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));

        setTimeout(() => {
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

          setTimeout(() => {
            el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
            el.blur();

            // For structured data, re-set the value after all events to ensure it sticks
    if (isStructuredData) {
      // For structured data, populate the default_value textarea
      const testCaseRow = container.querySelector('.service-designer__grid-row._test-case-row');
      if (testCaseRow) {
        const defaultTextarea = testCaseRow.querySelector('.wrapper-content.textarea_outer.default_value textarea');
        if (defaultTextarea) {
          elementsToPopulate.push(defaultTextarea);
        } else {
          elementsToPopulate.push(element);
        }
      } else {
        elementsToPopulate.push(element);
      }
    } else {
      // For regular inputs, just populate the single element
      elementsToPopulate.push(element);
    }
          }, delay);
        }, delay);
      }, delay);
    }

    log(`Successfully populated ${elementsToPopulate.length} element(s) for ${isStructuredData ? 'structured data' : 'regular'} input`);
    return true;
  } catch (error) {
    console.error('Error populating test value:', error);
    return false;
  }
}

export function syncJSONToInputs(jsonString) {
  try {
    // Parse JSON
    const data = JSON.parse(jsonString);
    
    if (typeof data !== 'object' || Array.isArray(data)) {
      return { 
        success: false, 
        errors: ['JSON must be an object with key-value pairs'] 
      };
    }
    
    // Extract current inputs from page (force refresh)
    const inputs = extractAllInputs(true);
    
    if (inputs.length === 0) {
      return {
        success: false,
        errors: ['No inputs found on page. Make sure you are on the correct step.']
      };
    }
    
    // Create key-to-input map
    const inputMap = new Map(inputs.map(i => [i.key, i]));
    
    // Validate all JSON keys exist
    const errors = [];
    const notFound = [];
    
    for (const key of Object.keys(data)) {
      if (!inputMap.has(key)) {
        notFound.push(key);
      }
    }
    
    if (notFound.length > 0) {
      errors.push(`Input(s) not found on page: ${notFound.join(', ')}`);
      errors.push(`Available inputs: ${Array.from(inputMap.keys()).join(', ')}`);
      return { success: false, errors };
    }
    
    // Populate each input
    let successCount = 0;
    const failedInputs = [];
    
    for (const [key, value] of Object.entries(data)) {
      const input = inputMap.get(key);
      if (input) {
        const populated = populateTestValue(input.testValueElement, value, input.type, input.container);
        if (populated) {
          successCount++;
        } else {
          failedInputs.push(key);
        }
      }
    }
    
    if (failedInputs.length > 0) {
      errors.push(`Failed to populate: ${failedInputs.join(', ')}`);
    }
    
    return { 
      success: successCount > 0, 
      message: `Successfully populated ${successCount} of ${Object.keys(data).length} input(s)`,
      errors: errors.length > 0 ? errors : undefined
    };
    
  } catch (e) {
    console.error('Error syncing JSON:', e);
    return { 
      success: false, 
      errors: [`Invalid JSON: ${e.message}`] 
    };
  }
}
