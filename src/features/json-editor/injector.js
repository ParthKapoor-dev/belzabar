import { log } from '../../core/logger.js';
import { state } from '../../core/state.js';
import { showModal } from './modal.js';

// Button injection
export function findInputsSection() {
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
    console.error('Error finding inputs section:', error);
    return null;
  }
}

export function createJSONButton() {
  if (state.jsonButtonEl) return state.jsonButtonEl;

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

  state.jsonButtonEl = button;
  return button;
}

export function injectJSONButton() {
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
    state.injectionAttempts = 0; // Reset attempts on success
    return true;
  } catch (error) {
    console.error('Error injecting JSON button:', error);
    return false;
  }
}

export function debouncedInjectJSONButton() {
  // Clear existing timer
  if (state.injectionDebounceTimer) {
    clearTimeout(state.injectionDebounceTimer);
  }

  // Set new timer
  state.injectionDebounceTimer = setTimeout(() => {
    if (state.injectionAttempts < 10) { // Limit attempts
      state.injectionAttempts++;
      if (!injectJSONButton()) {
        log(`Button injection attempt ${state.injectionAttempts} failed`);
      }
    }
  }, 500);
}