// belz design tokens for the extension — injected UI + DevTools panel.
//
// Mirrors @belzabar/design (the single source of truth): one dark theme,
// axiom-style blue accent, sharp corners, hairline borders, no gradients.
// The extension build (bun build) bundles @belzabar/design/tokens directly.

import { palette } from "@belzabar/design/tokens";

/** Token palette (hex) for inline styles. */
export const T = {
  ink: palette.ink, // overlay / deepest
  surface: palette.surface, // panels, modals
  surface2: palette.surface2, // raised rows, inputs, hover
  line: palette.line, // hairline border
  line2: palette.line2, // stronger border
  fg: palette.fg, // primary text
  fgMuted: palette.fgMuted, // secondary text
  fgFaint: palette.fgFaint, // hints
  accent: palette.accent, // signature blue
  accentHover: palette.accentHover,
  accentFg: palette.accentFg, // text on accent
  danger: palette.danger,
  warning: palette.warning,
  success: palette.success,
};

/** Monospace stack — matches web + CLI. */
export const FONT_MONO =
  '"Berkeley Mono", "IoskeleyMono", ui-monospace, SFMono-Regular, Menlo, monospace';

/** Sharp corners everywhere. */
export const RADIUS = "0";

/** A flat, restrained shadow for raised surfaces (no glow). */
export const SHADOW = "0 8px 24px rgba(0, 0, 0, 0.5)";

/** Modal backdrop scrim. */
export const SCRIM = "rgba(0, 0, 0, 0.66)";

/** `#rrggbb` + alpha (0..1) → `rgba()` — for subtle token-derived fills. */
export function alpha(hex, a) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
