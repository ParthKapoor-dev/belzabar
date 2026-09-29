// belz design tokens — THE single source of truth.
//
// Plain objects, hex values, zero dependencies. The CLI's ANSI styling
// (./terminal) derives from these. Hex is deliberate: it is the one colour
// format the terminal can reproduce exactly via truecolor ANSI.
//
// Aesthetic: axiom.co — one dark theme, a single cool-blue accent, sharp
// corners, hairline borders, no gradients or glows.

/** Raw colour palette. Names describe intent, not appearance. */
export const palette = {
  // Neutrals — near-black with a faint cool undertone
  black: "#08090a", // deepest — text-on-accent, shadows
  ink: "#0c0d0f", // app background
  surface: "#101113", // cards / panels
  surface2: "#16181b", // raised / hover
  line: "#1f2123", // hairline border (the workhorse)
  line2: "#2a2d30", // stronger border / inputs
  fg: "#e6e7e8", // primary text
  fgMuted: "#9ba1a6", // secondary text
  fgFaint: "#5c6166", // tertiary text / hints

  // Signature accent — cool axiom blue
  accent: "#3b82f6",
  accentHover: "#5b9bff",
  accentMuted: "#1d3a66", // solid low-key accent fill
  accentFg: "#08090a", // text/icons ON the accent

  // Status — desaturated to sit calmly in a technical palette
  success: "#3fb950",
  warning: "#d29922",
  danger: "#f85149",
} as const;

export type Palette = typeof palette;
export type ColorToken = keyof Palette;
