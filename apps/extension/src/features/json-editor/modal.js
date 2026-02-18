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
    background: 'rgba(0, 0, 0, 0.75)',
    backdropFilter: 'blur(8px)',
    zIndex: '999998',
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center'
  });

  // Modal container
  const container = document.createElement('div');
  Object.assign(container.style, {
    background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    borderRadius: '16px',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1)',
    width: '90%',
    maxWidth: '700px',
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    border: '1px solid rgba(255, 255, 255, 0.1)'
  });

  // Header
  const header = document.createElement('div');
  Object.assign(header.style, {
    padding: '20px 24px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: 'rgba(255, 255, 255, 0.03)'
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
    color: '#ffffff',
    textShadow: '0 2px 10px rgba(59, 130, 246, 0.3)'
  });

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = '🔄';
  refreshBtn.setAttribute('title', 'Refresh inputs from page');
  refreshBtn.id = 'jsonRefreshButton';
  Object.assign(refreshBtn.style, {
    background: 'rgba(59, 130, 246, 0.15)',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    borderRadius: '6px',
    padding: '4px 8px',
    fontSize: '16px',
    cursor: 'pointer',
    transition: 'all 200ms ease',
    color: '#60a5fa'
  });
  refreshBtn.onmouseenter = () => {
    refreshBtn.style.background = 'rgba(59, 130, 246, 0.25)';
    refreshBtn.style.transform = 'scale(1.05)';
  };
  refreshBtn.onmouseleave = () => {
    refreshBtn.style.background = 'rgba(59, 130, 246, 0.15)';
    refreshBtn.style.transform = 'scale(1)';
  };

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');
  Object.assign(closeBtn.style, {
    background: 'rgba(239, 68, 68, 0.15)',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    borderRadius: '6px',
    fontSize: '24px',
    cursor: 'pointer',
    color: '#f87171',
    padding: '0',
    width: '32px',
    height: '32px',
    lineHeight: '1',
    transition: 'all 200ms ease'
  });
  closeBtn.onmouseenter = () => {
    closeBtn.style.background = 'rgba(239, 68, 68, 0.25)';
    closeBtn.style.transform = 'rotate(90deg)';
  };
  closeBtn.onmouseleave = () => {
    closeBtn.style.background = 'rgba(239, 68, 68, 0.15)';
    closeBtn.style.transform = 'rotate(0deg)';
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
    color: '#9ca3af',
    fontSize: '14px',
    display: 'none'
  });
  loadingDiv.innerHTML = '<div style="font-size: 24px; margin-bottom: 8px;">⏳</div>Loading inputs...';

  // Textarea container with grid background
  const textareaContainer = document.createElement('div');
  Object.assign(textareaContainer.style, {
    position: 'relative',
    borderRadius: '8px',
    overflow: 'hidden'
  });

  // Grid dots background
  const gridBackground = document.createElement('div');
  Object.assign(gridBackground.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    right: '0',
    bottom: '0',
    backgroundImage: 'radial-gradient(circle, rgba(59, 130, 246, 0.15) 1px, transparent 1px)',
    backgroundSize: '20px 20px',
    pointerEvents: 'none',
    zIndex: '1'
  });

  // Textarea
  const textarea = document.createElement('textarea');
  textarea.id = 'jsonInputTextarea';
  Object.assign(textarea.style, {
    width: '100%',
    minHeight: '300px',
    padding: '12px',
    fontFamily: '"Geist Mono", Menlo, "Courier New", monospace',
    fontSize: '13px',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    borderRadius: '8px',
    resize: 'vertical',
    outline: 'none',
    background: 'rgba(0, 0, 0, 0.3)',
    color: '#e5e7eb',
    position: 'relative',
    zIndex: '2',
    transition: 'all 200ms ease',
    boxShadow: 'inset 0 2px 10px rgba(0, 0, 0, 0.3)'
  });
  textarea.addEventListener('focus', () => {
    textarea.style.borderColor = '#3b82f6';
    textarea.style.boxShadow = 'inset 0 2px 10px rgba(0, 0, 0, 0.3), 0 0 0 3px rgba(59, 130, 246, 0.2)';
  });
  textarea.addEventListener('blur', () => {
    textarea.style.borderColor = 'rgba(59, 130, 246, 0.3)';
    textarea.style.boxShadow = 'inset 0 2px 10px rgba(0, 0, 0, 0.3)';
  });

  textareaContainer.appendChild(gridBackground);
  textareaContainer.appendChild(textarea);

  // Info display
  const infoDiv = document.createElement('div');
  infoDiv.id = 'jsonInputInfo';
  Object.assign(infoDiv.style, {
    marginTop: '12px',
    padding: '12px 16px',
    background: 'rgba(59, 130, 246, 0.15)',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    borderRadius: '8px',
    color: '#93c5fd',
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
    borderRadius: '8px',
    color: '#fca5a5',
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
  Object.assign(footer.style, {
    padding: '16px 24px',
    borderTop: '1px solid rgba(255, 255, 255, 0.1)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: 'rgba(255, 255, 255, 0.03)'
  });

  const helpText = document.createElement('div');
  Object.assign(helpText.style, {
    fontSize: '12px',
    color: '#9ca3af'
  });
  helpText.innerHTML = '<span style="font-weight: 500; color: #60a5fa;">💡 Tip:</span> Keys marked with * are mandatory';

  const buttonGroup = document.createElement('div');
  Object.assign(buttonGroup.style, {
    display: 'flex',
    gap: '12px'
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, {
    padding: '8px 16px',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: '8px',
    background: 'rgba(255, 255, 255, 0.05)',
    color: '#d1d5db',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'all 200ms ease'
  });
  cancelBtn.onmouseenter = () => {
    cancelBtn.style.background = 'rgba(255, 255, 255, 0.1)';
    cancelBtn.style.transform = 'translateY(-1px)';
  };
  cancelBtn.onmouseleave = () => {
    cancelBtn.style.background = 'rgba(255, 255, 255, 0.05)';
    cancelBtn.style.transform = 'translateY(0)';
  };
  cancelBtn.onclick = closeModal;

  const syncBtn = document.createElement('button');
  syncBtn.textContent = 'Sync';
  syncBtn.id = 'jsonSyncButton';
  Object.assign(syncBtn.style, {
    padding: '8px 16px',
    border: 'none',
    borderRadius: '8px',
    background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
    color: '#ffffff',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'all 200ms ease',
    boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)'
  });
  syncBtn.onmouseenter = () => {
    syncBtn.style.background = 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)';
    syncBtn.style.transform = 'translateY(-2px)';
    syncBtn.style.boxShadow = '0 6px 16px rgba(59, 130, 246, 0.4)';
  };
  syncBtn.onmouseleave = () => {
    syncBtn.style.background = 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)';
    syncBtn.style.transform = 'translateY(0)';
    syncBtn.style.boxShadow = '0 4px 12px rgba(59, 130, 246, 0.3)';
  };
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
  infoDiv.style.color = '#93c5fd';

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
  infoDiv.style.display = 'none';
  infoDiv.style.background = 'rgba(59, 130, 246, 0.15)';
  infoDiv.style.borderColor = 'rgba(59, 130, 246, 0.3)';
  infoDiv.style.color = '#93c5fd';

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
          infoDiv.style.color = '#fbbf24';
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
