import { log } from '../../core/logger.js';
import { extractAllInputs } from './extractor.js';

// JSON sync operations

// ===== Step 6: Enhanced Value Synchronization =====
export function populateTestValue(element, value, type) {
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
      stringValue = String(value);
    } else {
      stringValue = String(value);
    }
    
    // Set value
    element.value = stringValue;
    
    // Enhanced Angular change detection
    // Step 1: Focus
    element.focus();
    
    // Step 2: Dispatch input event
    setTimeout(() => {
      element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      
      // Step 3: Dispatch change event
      setTimeout(() => {
        element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        
        // Step 4: Blur
        setTimeout(() => {
          element.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          element.blur();
          
          log(`Successfully populated value for element`);
        }, 10);
      }, 10);
    }, 10);
    
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
        const populated = populateTestValue(input.testValueElement, value, input.type);
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