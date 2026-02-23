let lockCount = 0;
let lockedScrollY = 0;
let previousBodyStyles = null;
let previousHtmlOverflow = '';

function applyLock() {
  const bodyStyle = document.body.style;
  previousBodyStyles = {
    overflow: bodyStyle.overflow,
    position: bodyStyle.position,
    top: bodyStyle.top,
    left: bodyStyle.left,
    right: bodyStyle.right,
    width: bodyStyle.width
  };
  previousHtmlOverflow = document.documentElement.style.overflow;

  lockedScrollY = window.scrollY || window.pageYOffset || 0;

  document.documentElement.style.overflow = 'hidden';
  bodyStyle.overflow = 'hidden';
  bodyStyle.position = 'fixed';
  bodyStyle.top = `-${lockedScrollY}px`;
  bodyStyle.left = '0';
  bodyStyle.right = '0';
  bodyStyle.width = '100%';
}

function releaseLock() {
  const bodyStyle = document.body.style;
  if (previousBodyStyles) {
    bodyStyle.overflow = previousBodyStyles.overflow;
    bodyStyle.position = previousBodyStyles.position;
    bodyStyle.top = previousBodyStyles.top;
    bodyStyle.left = previousBodyStyles.left;
    bodyStyle.right = previousBodyStyles.right;
    bodyStyle.width = previousBodyStyles.width;
  }

  document.documentElement.style.overflow = previousHtmlOverflow;
  window.scrollTo(0, lockedScrollY);
}

export function lockModalInteraction() {
  lockCount += 1;
  if (lockCount === 1) {
    applyLock();
  }
}

export function unlockModalInteraction() {
  if (lockCount === 0) return;
  lockCount -= 1;

  if (lockCount === 0) {
    releaseLock();
  }
}

export function isModalInteractionLocked() {
  return lockCount > 0;
}

