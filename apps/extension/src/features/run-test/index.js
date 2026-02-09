import { findRunTestButton } from './button-finder.js';
import { showToast } from '../../ui/toast.js';

// Run test trigger
export function triggerRunTest() {
  const button = findRunTestButton();
  if (!button) return;

  button.click();
  showToast('Run Test triggered');
}