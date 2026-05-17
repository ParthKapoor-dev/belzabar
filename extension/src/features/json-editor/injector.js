import { log } from '../../core/logger.js';
import { state } from '../../core/state.js';
import { showModal } from './modal.js';
import { T, FONT_MONO, RADIUS } from '../../ui/theme.js';

// Button injection
export function findInputsSection() {
  try {
    // Strategy 1: Walk text nodes to find "Inputs" / "2 Inputs" etc.
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = node.textContent?.trim() || '';
          return /^\d*\s*Inputs?$/i.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      }
    );

    const textNode = walker.nextNode();
    if (textNode) {
      const el = textNode.parentElement;
      if (el && el.children.length === 0) {
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
  button.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/>' +
    '<path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>' +
    '</svg><span>JSON</span>';
  button.setAttribute('title', 'Edit inputs as JSON');
  button.id = 'sdExtensionJSONButton';

  Object.assign(button.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 14px',
    background: T.ink,
    color: T.fg,
    border: `1px solid ${T.line2}`,
    borderRadius: RADIUS,
    fontFamily: FONT_MONO,
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
    marginLeft: '12px',
    transition: 'background 140ms ease, border-color 140ms ease'
  });

  button.addEventListener('mouseenter', () => {
    button.style.background = T.surface2;
    button.style.borderColor = T.accent;
  });

  button.addEventListener('mouseleave', () => {
    button.style.background = T.ink;
    button.style.borderColor = T.line2;
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
  injectJSONButton();
}
