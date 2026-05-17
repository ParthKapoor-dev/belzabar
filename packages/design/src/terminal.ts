// Terminal palette — the CLI's view of the design tokens.
//
// Truecolor ANSI (\x1b[38;2;r;g;bm) reproduces the EXACT same hex values the
// web app and extension use, so all three surfaces are literally the same
// colours. Terminals without truecolor fall back to the xterm-256 cube.
// NO_COLOR / FORCE_COLOR / non-TTY are all respected.

import { palette } from "./tokens";

// ── environment ──────────────────────────────────────────────────────────

const proc = (
  globalThis as {
    process?: {
      env?: Record<string, string | undefined>;
      stdout?: { isTTY?: boolean };
    };
  }
).process;
const env = proc?.env ?? {};
const isTTY = Boolean(proc?.stdout?.isTTY);

const colorEnabled = ((): boolean => {
  if (env.NO_COLOR !== undefined) return false;
  const force = env.FORCE_COLOR;
  if (force === "0" || force === "false") return false;
  if (force !== undefined && force !== "") return true;
  return isTTY;
})();

const truecolor = /truecolor|24bit/i.test(env.COLORTERM ?? "");

// ── colour conversion ────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Map an RGB triple to the nearest xterm-256 index (6×6×6 cube + gray ramp). */
function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (c: number) => Math.round((c / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function code(hex: string, layer: 38 | 48): string {
  const [r, g, b] = hexToRgb(hex);
  return truecolor
    ? `\x1b[${layer};2;${r};${g};${b}m`
    : `\x1b[${layer};5;${rgbTo256(r, g, b)}m`;
}

// ── styling primitives ───────────────────────────────────────────────────

type Style = (s: string) => string;

/** Foreground colour from a hex string. */
export function fg(hex: string): Style {
  if (!colorEnabled) return (s) => s;
  const open = code(hex, 38);
  return (s) => `${open}${s}\x1b[39m`;
}

/** Background colour from a hex string. */
export function bg(hex: string): Style {
  if (!colorEnabled) return (s) => s;
  const open = code(hex, 48);
  return (s) => `${open}${s}\x1b[49m`;
}

function attr(open: string, close: string): Style {
  return colorEnabled ? (s) => `${open}${s}${close}` : (s) => s;
}

export const bold: Style = attr("\x1b[1m", "\x1b[22m");
export const dim: Style = attr("\x1b[2m", "\x1b[22m");
export const italic: Style = attr("\x1b[3m", "\x1b[23m");
export const underline: Style = attr("\x1b[4m", "\x1b[24m");

/** True when colour output is active (TTY, not NO_COLOR'd). */
export const supportsColor = colorEnabled;

// ── pre-bound theme ──────────────────────────────────────────────────────

/** The CLI palette — semantic, pre-bound to the design tokens. */
export const term = {
  fg: fg(palette.fg),
  muted: fg(palette.fgMuted),
  faint: fg(palette.fgFaint),
  accent: fg(palette.accent),
  success: fg(palette.success),
  warning: fg(palette.warning),
  danger: fg(palette.danger),
  onAccent: bg(palette.accent),
  bold,
  dim,
  italic,
  underline,
} as const;

/** Glyph set — restrained, skills.sh-style. */
export const symbols = {
  ok: "✓",
  err: "✗",
  warn: "▲",
  info: "◆",
  arrow: "❯",
  bar: "│",
  rule: "─",
  dot: "·",
  bullet: "–",
} as const;
