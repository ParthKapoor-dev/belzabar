// Terminal styling over the palette in ./tokens.
//
// Truecolor ANSI (\x1b[38;2;r;g;bm) reproduces the EXACT hex values in
// tokens.ts. Terminals without truecolor fall back to the xterm-256 cube.
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

function fgCode(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return truecolor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256(r, g, b)}m`;
}

// ── styling primitives ───────────────────────────────────────────────────

type Style = (s: string) => string;

/** Foreground colour from a hex string. */
function fg(hex: string): Style {
  if (!colorEnabled) return (s) => s;
  const open = fgCode(hex);
  return (s) => `${open}${s}\x1b[39m`;
}

function attr(open: string, close: string): Style {
  return colorEnabled ? (s) => `${open}${s}${close}` : (s) => s;
}

const bold: Style = attr("\x1b[1m", "\x1b[22m");
const dim: Style = attr("\x1b[2m", "\x1b[22m");

// ── pre-bound theme ──────────────────────────────────────────────────────

/** The CLI palette — semantic, pre-bound to ./tokens. */
export const term = {
  fg: fg(palette.fg),
  muted: fg(palette.fgMuted),
  faint: fg(palette.fgFaint),
  accent: fg(palette.accent),
  success: fg(palette.success),
  warning: fg(palette.warning),
  danger: fg(palette.danger),
  bold,
  dim,
} as const;

/** Glyph set — restrained, skills.sh-style. */
export const symbols = {
  ok: "✓",
  err: "✗",
  warn: "▲",
  info: "◆",
  arrow: "❯",
  bar: "│",
  dot: "·",
} as const;
