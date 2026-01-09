(() => {
  'use strict';

  /* ===========================
     Constants & Selectors
     =========================== */

  const METHOD_INPUT_SELECTOR = 'input#SD1_MethodName';

  const RUN_TEST_EXP_BUTTON_SELECTORS = [
    'exp-button#runTest',
    'exp-button.run_test_btn',
    'exp-button[aria-label="run Test"]',
    'exp-button[arialabel="run Test"]'
  ];

  const OBSERVER_OPTIONS = {
    childList: true,
    subtree: true
  };

  const DEBUG = false; // Set to true for console logging

  /* ===========================
     State
     =========================== */

  let lastMethodName = null;
  let toastEl = null;
  let toastTimeout = null;
  let modalEl = null;
  let jsonButtonEl = null;
  let cachedInputs = null;
  let lastInputScanTime = 0;
  let injectionAttempts = 0;
  let injectionDebounceTimer = null;

  /* ===========================
     Debug Logger
     =========================== */

  function log(...args) {
    if (DEBUG) {
      console.log('[SD Extension]', ...args);
    }
  }

  function logError(...args) {
    console.error('[SD Extension Error]', ...args);
  }

  /* ===========================
     Helpers
     =========================== */

  function extractMethodName() {
    const input = document.querySelector(METHOD_INPUT_SELECTOR);
    if (!input || !input.value) return null;
    return input.value.trim();
  }

  function updateTitle() {
    const methodName = extractMethodName();
    if (!methodName || methodName === lastMethodName) return;

    lastMethodName = methodName;
    const baseTitle = document.title.split(' – ')[0];
    document.title = `${baseTitle} – ${methodName}`;
  }

  function isEditableElement(el) {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();

    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const type = (el.type || '').toLowerCase();
      return !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type);
    }

    return el.isContentEditable === true;
  }

  /* ===========================
     Toast UI
     =========================== */

  function ensureToast() {
    if (toastEl) return toastEl;

    toastEl = document.createElement('div');
    toastEl.textContent = 'Run Test triggered';

    Object.assign(toastEl.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: '999999',
      padding: '10px 14px',
      background: '#1f2937',
      color: '#ffffff',
      fontSize: '13px',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      borderRadius: '6px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
      opacity: '0',
      transform: 'translateY(8px)',
      transition: 'opacity 150ms ease, transform 150ms ease',
      pointerEvents: 'none'
    });

    document.body.appendChild(toastEl);
    return toastEl;
  }

  function showToast(message = 'Run Test triggered') {
    const el = ensureToast();
    el.textContent = message;

    if (toastTimeout) {
      clearTimeout(toastTimeout);
    }

    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';

    toastTimeout = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
    }, 1200);
  }

  /* ===========================
     Run Test Trigger (Angular-safe)
     =========================== */

  function findRunTestButton() {
    for (const selector of RUN_TEST_EXP_BUTTON_SELECTORS) {
      const expButtons = document.querySelectorAll(selector);
      for (const exp of expButtons) {
        if (exp.offsetParent === null) continue;

        const innerButton = exp.querySelector('button');
        if (innerButton && !innerButton.disabled) {
          return innerButton;
        }
      }
    }
    return null;
  }

  function triggerRunTest() {
    const button = findRunTestButton();
    if (!button) return;

    button.click();
    showToast('Run Test triggered');
  }

  /* ===========================
     Keyboard Shortcut
     =========================== */

  function handleKeydown(event) {
    if (
      event.ctrlKey &&
      event.shiftKey &&
      event.key === 'Enter'
    ) {
      if (isEditableElement(document.activeElement)) return;

      event.preventDefault();
      event.stopPropagation();

      triggerRunTest();
    }
  }

  /* ===========================
     JSON INPUT FEATURE - ENHANCED
     =========================== */

  /* ===== Step 1: Key Detection ===== */

  function findAllInputKeys() {
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
      logError('Error finding input keys:', error);
      return [];
    }
  }

  /* ===== Step 2: Container Identification ===== */

  function findInputContainer(element) {
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
      logError('Error finding container:', error);
      return null;
    }
  }

  /* ===== Step 3: Data Type Extraction ===== */

  function normalizeDataType(typeString) {
    if (!typeString) return 'Text';

    const normalized = typeString.trim().toLowerCase();
    
    // Map variations to standard types
    const typeMap = {
      'text': 'Text',
      'json': 'Json',
      'boolean': 'Boolean',
      'number': 'Number',
      'integer': 'Integer',
      'interger': 'Integer', // Handle typo
      'array': 'Array',
      'date': 'Date',
      'datetime': 'DateTime',
      'map': 'Map',
      'url': 'Url',
      'structured data': 'StructuredData'
    };

    return typeMap[normalized] || 'Text';
  }

  function extractDataType(container) {
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
      logError('Error extracting data type:', error);
      return 'Text';
    }
  }

  /* ===== Step 4: Test Value Element Detection ===== */

  function findTestValueElement(container) {
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
      logError('Error finding test value element:', error);
      return null;
    }
  }

  /* ===== Step 5: Input Name Extraction ===== */

  function extractInputName(container, key) {
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
      logError('Error extracting input name:', error);
      return key;
    }
  }

  /* ===== Mandatory Detection ===== */

  function isMandatory(container) {
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
      logError('Error checking mandatory:', error);
      return false;
    }
  }

  /* ===== Main Input Extraction with Caching ===== */

  function extractAllInputs(forceRefresh = false) {
    try {
      // Use cache if available and recent (within 2 seconds)
      const now = Date.now();
      if (!forceRefresh && cachedInputs && (now - lastInputScanTime) < 2000) {
        log('Using cached inputs');
        return cachedInputs;
      }

      log('Starting input extraction...');
      const inputs = [];
      
      // Step 1: Find all input keys
      const keyElements = findAllInputKeys();

      if (keyElements.length === 0) {
        log('No input keys found');
        cachedInputs = [];
        lastInputScanTime = now;
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
          logError(`Error processing input ${key}:`, error);
        }
      }

      log(`Successfully extracted ${inputs.length} inputs`);
      
      // Update cache
      cachedInputs = inputs;
      lastInputScanTime = now;

      return inputs;
    } catch (error) {
      logError('Error in extractAllInputs:', error);
      return [];
    }
  }

  /* ===== JSON Operations ===== */

  function generateInputJSON(inputs) {
    const json = {};
    
    for (const input of inputs) {
      let value = input.currentValue;
      
      // Handle empty values
      if (!value || value.trim() === '') {
        json[input.key] = null;
        continue;
      }

      // Type conversion
      try {
        switch (input.type) {
          case 'Json':
          case 'Array':
          case 'Map':
          case 'StructuredData':
            value = JSON.parse(value);
            break;
          
          case 'Boolean':
            value = value === 'true' || value === '1' || value === true;
            break;
          
          case 'Number':
          case 'Integer':
            value = parseFloat(value);
            if (isNaN(value)) value = null;
            break;
          
          case 'Date':
          case 'DateTime':
          case 'Url':
          case 'Text':
          default:
            // Keep as string
            break;
        }
      } catch (e) {
        logError(`Error parsing value for ${input.key}:`, e);
        value = value || null;
      }
      
      json[input.key] = value;
    }
    
    return json;
  }

  /* ===== Step 6: Enhanced Value Synchronization ===== */

  function populateTestValue(element, value, type) {
    if (!element) {
      logError('No element provided for population');
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
      logError('Error populating test value:', error);
      return false;
    }
  }

  function syncJSONToInputs(jsonString) {
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
      logError('Error syncing JSON:', e);
      return { 
        success: false, 
        errors: [`Invalid JSON: ${e.message}`] 
      };
    }
  }

  /* ===========================
     Modal UI - Enhanced
     =========================== */

  function createModal() {
    if (modalEl) return modalEl;

    // Modal overlay
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      background: 'rgba(0, 0, 0, 0.5)',
      zIndex: '999998',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center'
    });

    // Modal container
    const container = document.createElement('div');
    Object.assign(container.style, {
      background: '#ffffff',
      borderRadius: '8px',
      boxShadow: '0 10px 40px rgba(0, 0, 0, 0.3)',
      width: '90%',
      maxWidth: '700px',
      maxHeight: '80vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    });

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '20px 24px',
      borderBottom: '1px solid #e5e7eb',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    });

    const titleContainer = document.createElement('div');
    Object.assign(titleContainer.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '12px'
    });

    const title = document.createElement('h2');
    title.id = 'jsonModalTitle';
    title.textContent = 'Edit Input JSON';
    Object.assign(title.style, {
      margin: '0',
      fontSize: '18px',
      fontWeight: '600',
      color: '#111827'
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = '🔄';
    refreshBtn.setAttribute('title', 'Refresh inputs from page');
    refreshBtn.id = 'jsonRefreshButton';
    Object.assign(refreshBtn.style, {
      background: '#f3f4f6',
      border: 'none',
      borderRadius: '4px',
      padding: '4px 8px',
      fontSize: '16px',
      cursor: 'pointer',
      transition: 'background 150ms ease'
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close');
    Object.assign(closeBtn.style, {
      background: 'none',
      border: 'none',
      fontSize: '28px',
      cursor: 'pointer',
      color: '#6b7280',
      padding: '0',
      width: '32px',
      height: '32px',
      lineHeight: '1'
    });
    closeBtn.onclick = closeModal;

    titleContainer.appendChild(title);
    titleContainer.appendChild(refreshBtn);
    header.appendChild(titleContainer);
    header.appendChild(closeBtn);

    // Content
    const content = document.createElement('div');
    Object.assign(content.style, {
      padding: '24px',
      flex: '1',
      overflow: 'auto',
      position: 'relative'
    });

    // Loading indicator
    const loadingDiv = document.createElement('div');
    loadingDiv.id = 'jsonInputLoading';
    Object.assign(loadingDiv.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      textAlign: 'center',
      color: '#6b7280',
      fontSize: '14px',
      display: 'none'
    });
    loadingDiv.innerHTML = '<div style="font-size: 24px; margin-bottom: 8px;">⏳</div>Loading inputs...';

    // Textarea
    const textarea = document.createElement('textarea');
    textarea.id = 'jsonInputTextarea';
    Object.assign(textarea.style, {
      width: '100%',
      minHeight: '300px',
      padding: '12px',
      fontFamily: 'Monaco, Menlo, "Courier New", monospace',
      fontSize: '13px',
      border: '1px solid #d1d5db',
      borderRadius: '4px',
      resize: 'vertical',
      outline: 'none'
    });
    textarea.addEventListener('focus', () => {
      textarea.style.borderColor = '#3b82f6';
    });
    textarea.addEventListener('blur', () => {
      textarea.style.borderColor = '#d1d5db';
    });

    // Info display
    const infoDiv = document.createElement('div');
    infoDiv.id = 'jsonInputInfo';
    Object.assign(infoDiv.style, {
      marginTop: '12px',
      padding: '8px 12px',
      background: '#f0f9ff',
      border: '1px solid #bae6fd',
      borderRadius: '4px',
      color: '#0c4a6e',
      fontSize: '12px',
      display: 'none'
    });

    // Error display
    const errorDiv = document.createElement('div');
    errorDiv.id = 'jsonInputErrors';
    Object.assign(errorDiv.style, {
      marginTop: '12px',
      padding: '12px',
      background: '#fef2f2',
      border: '1px solid #fecaca',
      borderRadius: '4px',
      color: '#991b1b',
      fontSize: '13px',
      display: 'none'
    });

    content.appendChild(loadingDiv);
    content.appendChild(textarea);
    content.appendChild(infoDiv);
    content.appendChild(errorDiv);

    // Footer
    const footer = document.createElement('div');
    Object.assign(footer.style, {
      padding: '16px 24px',
      borderTop: '1px solid #e5e7eb',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    });

    const helpText = document.createElement('div');
    Object.assign(helpText.style, {
      fontSize: '12px',
      color: '#6b7280'
    });
    helpText.innerHTML = '<span style="font-weight: 500;">💡 Tip:</span> Keys marked with * are mandatory';

    const buttonGroup = document.createElement('div');
    Object.assign(buttonGroup.style, {
      display: 'flex',
      gap: '12px'
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    Object.assign(cancelBtn.style, {
      padding: '8px 16px',
      border: '1px solid #d1d5db',
      borderRadius: '6px',
      background: '#ffffff',
      color: '#374151',
      fontSize: '14px',
      fontWeight: '500',
      cursor: 'pointer'
    });
    cancelBtn.onclick = closeModal;

    const syncBtn = document.createElement('button');
    syncBtn.textContent = 'Sync';
    syncBtn.id = 'jsonSyncButton';
    Object.assign(syncBtn.style, {
      padding: '8px 16px',
      border: 'none',
      borderRadius: '6px',
      background: '#3b82f6',
      color: '#ffffff',
      fontSize: '14px',
      fontWeight: '500',
      cursor: 'pointer'
    });
    syncBtn.onclick = handleSyncClick;

    buttonGroup.appendChild(cancelBtn);
    buttonGroup.appendChild(syncBtn);
    footer.appendChild(helpText);
    footer.appendChild(buttonGroup);

    container.appendChild(header);
    container.appendChild(content);
    container.appendChild(footer);
    overlay.appendChild(container);

    // Click outside to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeModal();
      }
    });

    // Setup refresh button handler
    refreshBtn.onclick = () => {
      loadInputsIntoModal(true);
    };

    document.body.appendChild(overlay);
    modalEl = overlay;

    return modalEl;
  }

  function loadInputsIntoModal(forceRefresh = false) {
    const textarea = document.getElementById('jsonInputTextarea');
    const errorDiv = document.getElementById('jsonInputErrors');
    const infoDiv = document.getElementById('jsonInputInfo');
    const loadingDiv = document.getElementById('jsonInputLoading');
    const title = document.getElementById('jsonModalTitle');

    if (!textarea) return;

    // Show loading
    loadingDiv.style.display = 'block';
    textarea.style.display = 'none';
    errorDiv.style.display = 'none';
    infoDiv.style.display = 'none';

    // Small delay to show loading state
    setTimeout(() => {
      try {
        // Extract inputs
        const inputs = extractAllInputs(forceRefresh);
        
        if (inputs.length === 0) {
          errorDiv.innerHTML = '<strong>Error:</strong> No inputs found on this page. Make sure you are on Step 2.';
          errorDiv.style.display = 'block';
          textarea.value = '{}';
          textarea.style.display = 'block';
          loadingDiv.style.display = 'none';
          title.textContent = 'Edit Input JSON (0 inputs)';
        } else {
          const json = generateInputJSON(inputs);
          textarea.value = JSON.stringify(json, null, 2);
          errorDiv.style.display = 'none';
          
          // Show info about mandatory fields
          const mandatoryCount = inputs.filter(i => i.mandatory).length;
          if (mandatoryCount > 0) {
            const mandatoryKeys = inputs.filter(i => i.mandatory).map(i => i.key).join(', ');
            infoDiv.innerHTML = `<strong>Mandatory fields (${mandatoryCount}):</strong> ${mandatoryKeys}`;
            infoDiv.style.display = 'block';
          } else {
            infoDiv.style.display = 'none';
          }
          
          textarea.style.display = 'block';
          loadingDiv.style.display = 'none';
          title.textContent = `Edit Input JSON (${inputs.length} input${inputs.length !== 1 ? 's' : ''})`;
          
          log(`Loaded ${inputs.length} inputs into modal`);
        }
      } catch (error) {
        logError('Error loading inputs into modal:', error);
        errorDiv.innerHTML = `<strong>Error:</strong> ${error.message}`;
        errorDiv.style.display = 'block';
        textarea.style.display = 'block';
        loadingDiv.style.display = 'none';
      }
    }, 100);
  }

  function showModal() {
    const modal = createModal();
    loadInputsIntoModal(false);

    modal.style.display = 'flex';
    
    // Focus textarea after a short delay
    setTimeout(() => {
      const textarea = document.getElementById('jsonInputTextarea');
      if (textarea) textarea.focus();
    }, 200);

    // Add escape key handler
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        closeModal();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  function closeModal() {
    if (modalEl) {
      modalEl.style.display = 'none';
    }
  }

  function handleSyncClick() {
    const textarea = document.getElementById('jsonInputTextarea');
    const errorDiv = document.getElementById('jsonInputErrors');
    const infoDiv = document.getElementById('jsonInputInfo');
    const syncBtn = document.getElementById('jsonSyncButton');

    if (!textarea) return;

    const jsonString = textarea.value;

    // Show loading state
    const originalText = syncBtn.textContent;
    syncBtn.textContent = 'Syncing...';
    syncBtn.disabled = true;
    errorDiv.style.display = 'none';

    // Small delay to show loading state
    setTimeout(() => {
      const result = syncJSONToInputs(jsonString);

      if (result.success) {
        errorDiv.style.display = 'none';
        showToast(result.message || 'Inputs synced successfully!');
        
        // Show warning if there were partial errors
        if (result.errors && result.errors.length > 0) {
          infoDiv.innerHTML = '<strong>Warning:</strong><br>' + 
            result.errors.map(err => `• ${err}`).join('<br>');
          infoDiv.style.background = '#fef3c7';
          infoDiv.style.borderColor = '#fde68a';
          infoDiv.style.color = '#92400e';
          infoDiv.style.display = 'block';
          
          // Don't close modal on partial success
          syncBtn.textContent = originalText;
          syncBtn.disabled = false;
        } else {

          syncBtn.textContent = originalText;
          syncBtn.disabled = false;
          closeModal();
        }
      } else {
        errorDiv.innerHTML = '<strong>Error:</strong><br>' + 
          (result.errors || ['Unknown error']).map(err => `• ${err}`).join('<br>');
        errorDiv.style.display = 'block';
        syncBtn.textContent = originalText;
        syncBtn.disabled = false;
      }
    }, 100);
  }

  /* ===========================
     Button Injection - Enhanced
     =========================== */

  function findInputsSection() {
    try {
      // Strategy 1: Look for text containing "Inputs" or "Input"
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        // Match "2Inputs", "2 Inputs", "Inputs", etc.
        if (/^\d*\s*Inputs?$/i.test(text) && el.children.length === 0) {
          log('Found inputs section via text match');
          return el.parentElement;
        }
      }

      // Strategy 2: Look for specific patterns
      const possibleSelectors = [
        '[class*="input"]',
        '[class*="Input"]',
        '[id*="input"]',
        '[id*="Input"]'
      ];

      for (const selector of possibleSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (/inputs?/i.test(el.textContent)) {
            log('Found inputs section via selector match');
            return el;
          }
        }
      }

      log('Inputs section not found');
      return null;
    } catch (error) {
      logError('Error finding inputs section:', error);
      return null;
    }
  }

  function createJSONButton() {
    if (jsonButtonEl) return jsonButtonEl;

    const button = document.createElement('button');
    button.textContent = '📋 JSON';
    button.setAttribute('title', 'Edit inputs as JSON');
    button.id = 'sdExtensionJSONButton';
    
    Object.assign(button.style, {
      padding: '6px 12px',
      background: '#3b82f6',
      color: '#ffffff',
      border: 'none',
      borderRadius: '4px',
      fontSize: '13px',
      fontWeight: '500',
      cursor: 'pointer',
      marginLeft: '12px',
      transition: 'background 150ms ease'
    });

    button.addEventListener('mouseenter', () => {
      button.style.background = '#2563eb';
    });

    button.addEventListener('mouseleave', () => {
      button.style.background = '#3b82f6';
    });

    button.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      log('JSON button clicked');
      showModal();
    };

    jsonButtonEl = button;
    return button;
  }

  function injectJSONButton() {
    try {
      // Don't inject if already present
      if (document.getElementById('sdExtensionJSONButton')) {
        log('JSON button already injected');
        return true;
      }

      const section = findInputsSection();
      
      if (!section) {
        log('Inputs section not found for button injection');
        return false;
      }

      // Try to find the title element (containing "Inputs" text)
      let titleElement = null;
      
      // Look for direct text node parent
      for (const child of section.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && /Inputs?/i.test(child.textContent)) {
          titleElement = section;
          break;
        }
        if (child.nodeType === Node.ELEMENT_NODE && /^\d*\s*Inputs?$/i.test(child.textContent?.trim())) {
          titleElement = child;
          break;
        }
      }

      if (!titleElement) {
        titleElement = section;
      }

      // Ensure the container can hold the button
      if (titleElement.style.display !== 'flex') {
        Object.assign(titleElement.style, {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        });
      }

      const button = createJSONButton();
      titleElement.appendChild(button);
      
      log('JSON button successfully injected');
      injectionAttempts = 0; // Reset attempts on success
      return true;
    } catch (error) {
      logError('Error injecting JSON button:', error);
      return false;
    }
  }

  function debouncedInjectJSONButton() {
    // Clear existing timer
    if (injectionDebounceTimer) {
      clearTimeout(injectionDebounceTimer);
    }

    // Set new timer
    injectionDebounceTimer = setTimeout(() => {
      if (injectionAttempts < 10) { // Limit attempts
        injectionAttempts++;
        if (!injectJSONButton()) {
          log(`Button injection attempt ${injectionAttempts} failed`);
        }
      }
    }, 500);
  }

  /* ===========================
     JSON Feature Initialization
     =========================== */

  function initJSONFeature() {
    log('Initializing JSON feature...');
    
    // Try immediate injection
    setTimeout(() => {
      injectJSONButton();
    }, 1000);

    // Watch for dynamic changes with debouncing
    const jsonObserver = new MutationObserver(() => {
      debouncedInjectJSONButton();
    });

    jsonObserver.observe(document.body, OBSERVER_OPTIONS);
    
    log('JSON feature initialized');
  }

  /* ===========================
     Observers & Init
     =========================== */

  function setupObserver() {
    const observer = new MutationObserver(updateTitle);
    observer.observe(document.body, OBSERVER_OPTIONS);
  }

  function init() {
    log('Extension initializing...');
    updateTitle();
    setupObserver();
    document.addEventListener('keydown', handleKeydown, true);
    initJSONFeature();
    log('Extension initialized successfully');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
