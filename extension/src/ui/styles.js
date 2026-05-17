// Shared button styles for extension UI elements.
// Token-driven (see ./theme.js) — sharp corners, hairline borders, flat accent.

import { T, FONT_MONO, RADIUS } from './theme.js';

export const ICON_BUTTON_STYLE = {
  width: '28px',
  height: '28px',
  padding: '0',
  borderRadius: RADIUS,
  border: `1px solid ${T.line2}`,
  background: T.surface,
  color: T.fg,
  fontFamily: FONT_MONO,
  fontSize: '13px',
  fontWeight: '600',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 140ms ease, border-color 140ms ease'
};

export const ICON_BUTTON_HOVER = {
  background: T.surface2,
  borderColor: T.accent
};

export const ICON_BUTTON_UNHOVER = {
  background: T.surface,
  borderColor: T.line2
};

export const PRIMARY_BUTTON_STYLE = {
  border: `1px solid ${T.accent}`,
  background: T.accent,
  color: T.accentFg,
  borderRadius: RADIUS,
  padding: '0',
  fontFamily: FONT_MONO,
  fontWeight: '600',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 140ms ease, border-color 140ms ease'
};

export const PRIMARY_BUTTON_HOVER = {
  background: T.accentHover,
  borderColor: T.accentHover
};

export const PRIMARY_BUTTON_UNHOVER = {
  background: T.accent,
  borderColor: T.accent
};

export function applyHoverEffect(button, hoverStyle, unhoverStyle) {
  button.addEventListener('mouseenter', () => {
    Object.assign(button.style, hoverStyle);
  });
  button.addEventListener('mouseleave', () => {
    Object.assign(button.style, unhoverStyle);
  });
}
