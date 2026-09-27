import { state } from '../../core/state.js';
import { generateInputJSON } from './types.js';
import { extractAllInputs } from './extractor.js';
import { syncJSONToInputs } from './sync.js';
import { showToast } from '../../ui/toast.js';
import { EXTENSION_OWNED_ATTR } from '../../config/constants.js';
import { lockModalInteraction, unlockModalInteraction } from '../../ui/modal-lock.js';
import { T, FONT_MONO, RADIUS, SHADOW, SCRIM } from '../../ui/theme.js';
import {
  MODAL_OVERLAY, MODAL_DIALOG, MODAL_HEADER, MODAL_FOOTER,
  MODAL_TITLE, MODAL_ICON_BTN
} from '../../ui/modal.js';
import {
  ICON_BUTTON_STYLE, ICON_BUTTON_HOVER, ICON_BUTTON_UNHOVER,
  PRIMARY_BUTTON_STYLE, PRIMARY_BUTTON_HOVER, PRIMARY_BUTTON_UNHOVER,
  applyHoverEffect
} from '../../ui/styles.js';

// Modal UI component
export function createModal() {
  if (state.modalEl) return state.modalEl;

  // Modal overlay
  const overlay = document.createElement('div');
  overlay.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  Object.assign(overlay.style, MODAL_OVERLAY, { zIndex: '999998' });

  // Modal container
  const container = document.createElement('div');
  Object.assign(container.style, MODAL_DIALOG, {
    width: '90%',
    maxWidth: '700px',
    maxHeight: '80vh'
  });

  // Header
  const header = document.createElement('div');
  Object.assign(header.style, MODAL_HEADER);

  const titleContainer = document.createElement('div');
  Object.assign(titleContainer.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '12px'
  });

  const title = document.createElement('h2');
  title.id = 'jsonModalTitle';
  title.textContent = 'Edit Input JSON';
  Object.assign(title.style, MODAL_TITLE);

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = '⟳';
  refreshBtn.setAttribute('title', 'Refresh inputs from page');
  refreshBtn.id = 'jsonRefreshButton';
  Object.assign(refreshBtn.style, MODAL_ICON_BTN);
  refreshBtn.onmouseenter = () => {
    refreshBtn.style.background = T.surface2;
    refreshBtn.style.color = T.fg;
  };
  refreshBtn.onmouseleave = () => {
    refreshBtn.style.background = 'transparent';
    refreshBtn.style.color = T.fgMuted;
  };

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');
  Object.assign(closeBtn.style, MODAL_ICON_BTN, { fontSize: '18px' });
  closeBtn.onmouseenter = () => {
    closeBtn.style.background = T.surface2;
    closeBtn.style.color = T.fg;
  };
  closeBtn.onmouseleave = () => {
    closeBtn.style.background = 'transparent';
    closeBtn.style.color = T.fgMuted;
  };
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
    color: T.fgMuted,
    fontSize: '14px',
    display: 'none'
  });
  loadingDiv.innerHTML = '<div style="font-size: 24px; margin-bottom: 8px;">⏳</div>Loading inputs...';

  // Textarea container
  const textareaContainer = document.createElement('div');
  Object.assign(textareaContainer.style, {
    position: 'relative'
  });

  // Textarea
  const textarea = document.createElement('textarea');
  textarea.id = 'jsonInputTextarea';
  Object.assign(textarea.style, {
    width: '100%',
    minHeight: '300px',
    padding: '12px',
    fontFamily: FONT_MONO,
    fontSize: '13px',
    border: `1px solid ${T.line2}`,
    borderRadius: RADIUS,
    resize: 'vertical',
    outline: 'none',
    background: T.ink,
    color: T.fg,
    transition: 'border-color 140ms ease'
  });
  textarea.addEventListener('focus', () => {
    textarea.style.borderColor = T.accent;
  });
  textarea.addEventListener('blur', () => {
    textarea.style.borderColor = T.line2;
  });

  textareaContainer.appendChild(textarea);

  // Info display
  const infoDiv = document.createElement('div');
  infoDiv.id = 'jsonInputInfo';
  Object.assign(infoDiv.style, {
    marginTop: '12px',
    padding: '12px 16px',
    background: 'rgba(59, 130, 246, 0.15)',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    borderRadius: RADIUS,
    color: T.accent,
    fontSize: '12px',
    display: 'none',
    backdropFilter: 'blur(10px)'
  });

  // Error display
  const errorDiv = document.createElement('div');
  errorDiv.id = 'jsonInputErrors';
  Object.assign(errorDiv.style, {
    marginTop: '12px',
    padding: '12px 16px',
    background: 'rgba(239, 68, 68, 0.15)',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    borderRadius: RADIUS,
    color: T.danger,
    fontSize: '13px',
    display: 'none',
    backdropFilter: 'blur(10px)'
  });

  content.appendChild(loadingDiv);
  content.appendChild(textareaContainer);
  content.appendChild(infoDiv);
  content.appendChild(errorDiv);

  // Footer
  const footer = document.createElement('div');
  Object.assign(footer.style, MODAL_FOOTER);

  const helpText = document.createElement('div');
  Object.assign(helpText.style, {
    fontSize: '12px',
    color: T.fgFaint
  });
  helpText.textContent = 'Keys marked with * are mandatory';

  const buttonGroup = document.createElement('div');
  Object.assign(buttonGroup.style, {
    display: 'flex',
    gap: '8px'
  });

  const TEXT_BTN = { width: 'auto', height: 'auto', padding: '7px 16px', fontSize: '13px' };

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, ICON_BUTTON_STYLE, TEXT_BTN);
  applyHoverEffect(cancelBtn, ICON_BUTTON_HOVER, ICON_BUTTON_UNHOVER);
  cancelBtn.onclick = closeModal;

  const syncBtn = document.createElement('button');
  syncBtn.textContent = 'Sync';
  syncBtn.id = 'jsonSyncButton';
  Object.assign(syncBtn.style, PRIMARY_BUTTON_STYLE, TEXT_BTN);
  applyHoverEffect(syncBtn, PRIMARY_BUTTON_HOVER, PRIMARY_BUTTON_UNHOVER);
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
  state.modalEl = overlay;

  return state.modalEl;
}

export function loadInputsIntoModal(forceRefresh = false) {
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
  infoDiv.style.background = 'rgba(59, 130, 246, 0.15)';
  infoDiv.style.borderColor = 'rgba(59, 130, 246, 0.3)';
  infoDiv.style.color = T.accent;

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
        
        console.log(`Loaded ${inputs.length} inputs into modal`);
      }
    } catch (error) {
      console.error('Error loading inputs into modal:', error);
      errorDiv.innerHTML = `<strong>Error:</strong> ${error.message}`;
      errorDiv.style.display = 'block';
      textarea.style.display = 'block';
      loadingDiv.style.display = 'none';
    }
  }, 100);
}

export function showModal() {
  const modal = createModal();
  loadInputsIntoModal(false);

  const wasOpen = modal.style.display === 'flex';
  modal.style.display = 'flex';
  if (!wasOpen) {
    lockModalInteraction();
  }
  
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

export function closeModal() {
  if (state.modalEl && state.modalEl.style.display !== 'none') {
    state.modalEl.style.display = 'none';
    unlockModalInteraction();
  }
}

export function handleSyncClick() {
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
  infoDiv.style.display = 'none';
  infoDiv.style.background = 'rgba(59, 130, 246, 0.15)';
  infoDiv.style.borderColor = 'rgba(59, 130, 246, 0.3)';
  infoDiv.style.color = T.accent;

  // Small delay to show loading state
  setTimeout(async () => {
    try {
      const result = await syncJSONToInputs(jsonString);

      if (result.success) {
        errorDiv.style.display = 'none';
        showToast(result.message || 'Inputs synced successfully!');

        if (result.warnings && result.warnings.length > 0) {
          infoDiv.innerHTML = '<strong>Warning:</strong><br>' +
            result.warnings.map((warning) => `• ${warning}`).join('<br>');
          infoDiv.style.background = 'rgba(245, 158, 11, 0.15)';
          infoDiv.style.borderColor = 'rgba(245, 158, 11, 0.3)';
          infoDiv.style.color = T.warning;
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
        const errorMessages = result.errors || ['Unknown error'];
        errorDiv.innerHTML = '<strong>Error:</strong><br>' +
          errorMessages.map((error) => `• ${error}`).join('<br>');
        errorDiv.style.display = 'block';
        syncBtn.textContent = originalText;
        syncBtn.disabled = false;
      }
    } catch (error) {
      errorDiv.innerHTML = `<strong>Error:</strong><br>• ${error.message || 'Unknown error'}`;
      errorDiv.style.display = 'block';
      syncBtn.textContent = originalText;
      syncBtn.disabled = false;
    }
  }, 100);
}
