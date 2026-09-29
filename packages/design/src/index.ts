// @belzabar/design — belz design tokens.
//
// One source of truth (tokens.ts) consumed by the CLI through ./terminal
// (truecolor ANSI bound to the same hex values).

export { palette } from "./tokens";
export type { Palette, ColorToken } from "./tokens";

export {
  term,
  symbols,
  fg,
  bg,
  bold,
  dim,
  italic,
  underline,
  supportsColor,
} from "./terminal";
