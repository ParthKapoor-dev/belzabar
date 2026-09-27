// belz CLI theme — palette, glyphs, line helpers, and the wordmark.
//
// Backed by @belzabar/design so the terminal renders the EXACT same hex values
// the web app and extension use. This is the single place CLI styling is
// defined; commands and the runner consume `ui` / `term` / `symbols` — never
// raw ANSI or picocolors.

import { term, symbols, supportsColor } from "@belzabar/design/terminal";

export { term, symbols, supportsColor };

/** belz wordmark — printed by the bare `belz` command, help, and intros. */
export const wordmark: string =
  `${term.accent("▌")} ${term.bold(term.fg("belz"))}\n` +
  `${term.accent("▌")} ${term.faint("belzabar developer toolkit")}`;

/**
 * Themed line helpers — one consistent symbol + colour vocabulary for every
 * piece of human-facing CLI output.
 */
export const ui = {
  /** `✓ message` — success. */
  ok: (s: string): string => `${term.success(symbols.ok)} ${s}`,
  /** `✗ message` — failure. */
  err: (s: string): string => `${term.danger(symbols.err)} ${s}`,
  /** `▲ message` — warning. */
  warn: (s: string): string => `${term.warning(symbols.warn)} ${s}`,
  /** `◆ message` — informational. */
  info: (s: string): string => `${term.faint(symbols.info)} ${term.muted(s)}`,
  /** `│ message` — a step inside a flow. */
  step: (s: string): string => `${term.faint(symbols.bar)} ${term.muted(s)}`,
  /** `❯ message` — a prompt / call to action. */
  prompt: (s: string): string => `${term.accent(symbols.arrow)} ${s}`,
  /** A section heading — uppercased, accent. */
  heading: (s: string): string => term.bold(term.accent(s.toUpperCase())),
  /** A dim horizontal rule of the given width. */
  rule: (width = 48): string => term.faint(symbols.rule.repeat(width)),
  // Raw colour passthroughs.
  key: (s: string): string => term.muted(s),
  accent: term.accent,
  fg: term.fg,
  muted: term.muted,
  faint: term.faint,
  bold: term.bold,
  dim: term.dim,
} as const;
