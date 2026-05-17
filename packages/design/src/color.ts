// Semantic colour roles.
//
// Decouples *roles* (what UI code references) from the raw *palette*. The role
// names mirror shadcn/ui's token names so the web app's globals.css becomes a
// thin mapping layer. One dark theme — no light/dark pairs.

import { palette } from "./tokens";

export const role = {
  background: palette.ink,
  foreground: palette.fg,

  card: palette.surface,
  cardForeground: palette.fg,

  popover: palette.surface,
  popoverForeground: palette.fg,

  muted: palette.surface2,
  mutedForeground: palette.fgMuted,

  // Single accent — primary and accent are the same blue.
  primary: palette.accent,
  primaryForeground: palette.accentFg,
  accent: palette.accent,
  accentForeground: palette.accentFg,

  secondary: palette.surface2,
  secondaryForeground: palette.fg,

  border: palette.line,
  input: palette.line2,
  ring: palette.accent,

  // Status roles.
  success: palette.success,
  warning: palette.warning,
  destructive: palette.danger,
} as const;

export type Role = keyof typeof role;
