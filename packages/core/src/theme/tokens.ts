// CLI colour palette. Hex on purpose: truecolor ANSI (./terminal) reproduces
// hex exactly, and terminals without truecolor fall back to the xterm-256 cube.

/** Raw colour palette. Names describe intent, not appearance. */
export const palette = {
  fg: "#e6e7e8", // primary text
  fgMuted: "#9ba1a6", // secondary text
  fgFaint: "#5c6166", // tertiary text / hints
  accent: "#3b82f6",
  success: "#3fb950",
  warning: "#d29922",
  danger: "#f85149",
} as const;
