// Shared modal chrome — one consistent look for every extension modal.
//
// These are inline-style objects (the extension styles via Object.assign).
// Apply them to the overlay / dialog / header / footer / title / close-button
// of each modal so the JSON-input editor and the large text editor share an
// identical shell: axiom-style — flat, sharp corners, hairline borders, the
// mono typeface, no gradients or glows.

import { T, FONT_MONO, RADIUS, SHADOW, SCRIM } from './theme.js';

/** Full-viewport backdrop that centres the dialog. */
export const MODAL_OVERLAY = {
  position: 'fixed',
  inset: '0',
  background: SCRIM,
  backdropFilter: 'blur(6px)',
  display: 'none',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px'
};

/** The dialog surface. Callers set their own width / height / maxWidth. */
export const MODAL_DIALOG = {
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: T.surface,
  color: T.fg,
  border: `1px solid ${T.line2}`,
  borderRadius: RADIUS,
  boxShadow: SHADOW,
  fontFamily: FONT_MONO
};

/** Header strip — title on the left, actions on the right. */
export const MODAL_HEADER = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  padding: '12px 16px',
  background: T.surface2,
  borderBottom: `1px solid ${T.line}`,
  flex: '0 0 auto'
};

/** Footer strip — helper text on the left, buttons on the right. */
export const MODAL_FOOTER = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  padding: '12px 16px',
  background: T.surface2,
  borderTop: `1px solid ${T.line}`,
  flex: '0 0 auto'
};

/** Modal title text. */
export const MODAL_TITLE = {
  margin: '0',
  fontFamily: FONT_MONO,
  fontSize: '14px',
  fontWeight: '600',
  color: T.fg,
  letterSpacing: '0.01em'
};

/** A square icon button (close / refresh) for the header. */
export const MODAL_ICON_BTN = {
  width: '28px',
  height: '28px',
  padding: '0',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  color: T.fgMuted,
  border: `1px solid ${T.line2}`,
  borderRadius: RADIUS,
  fontFamily: FONT_MONO,
  fontSize: '15px',
  lineHeight: '1',
  cursor: 'pointer',
  transition: 'background 140ms ease, color 140ms ease, border-color 140ms ease'
};
