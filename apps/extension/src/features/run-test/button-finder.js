import { RUN_TEST_EXP_BUTTON_SELECTORS } from '../../config/constants.js';

// Button selector logic
export function findRunTestButton() {
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