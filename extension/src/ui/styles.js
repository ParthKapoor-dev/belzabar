// Shared button styles for extension UI elements

export const ICON_BUTTON_STYLE = {
  width: '28px',
  height: '28px',
  padding: '0',
  borderRadius: '8px',
  border: '1px solid rgba(59, 130, 246, 0.45)',
  background: 'rgba(15, 23, 42, 0.88)',
  color: '#e2e8f0',
  fontSize: '13px',
  fontWeight: '600',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'transform 140ms ease, box-shadow 140ms ease, filter 140ms ease',
  boxShadow: '0 4px 10px rgba(15, 23, 42, 0.35)'
};

export const ICON_BUTTON_HOVER = {
  transform: 'translateY(-1px)',
  filter: 'brightness(1.05)',
  boxShadow: '0 6px 14px rgba(15, 23, 42, 0.42)'
};

export const ICON_BUTTON_UNHOVER = {
  transform: 'translateY(0)',
  filter: 'none',
  boxShadow: '0 4px 10px rgba(15, 23, 42, 0.35)'
};

export const PRIMARY_BUTTON_STYLE = {
  border: '1px solid rgba(59, 130, 246, 0.45)',
  background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
  color: '#ffffff',
  borderRadius: '999px',
  padding: '0',
  fontWeight: '600',
  cursor: 'pointer',
  boxShadow: '0 4px 10px rgba(37, 99, 235, 0.28)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'transform 140ms ease, filter 140ms ease, box-shadow 140ms ease'
};

export const PRIMARY_BUTTON_HOVER = {
  transform: 'translateY(-1px)',
  filter: 'brightness(1.05)',
  boxShadow: '0 6px 14px rgba(37, 99, 235, 0.34)'
};

export const PRIMARY_BUTTON_UNHOVER = {
  transform: 'translateY(0)',
  filter: 'none',
  boxShadow: '0 4px 10px rgba(37, 99, 235, 0.28)'
};

export function applyHoverEffect(button, hoverStyle, unhoverStyle) {
  button.addEventListener('mouseenter', () => {
    Object.assign(button.style, hoverStyle);
  });
  button.addEventListener('mouseleave', () => {
    Object.assign(button.style, unhoverStyle);
  });
}
