import { state } from '../../core/state.js';
import { generateInputJSON } from './types.js';
import { extractAllInputs } from './extractor.js';
import { syncJSONToInputs } from './sync.js';
import { showToast } from '../../ui/toast.js';

// Modal UI component
export function createModal() {
  if (state.modalEl) return state.modalEl;

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

export function closeModal() {
  if (state.modalEl) {
    state.modalEl.style.display = 'none';
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