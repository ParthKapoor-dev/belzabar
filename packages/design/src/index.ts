// @belzabar/design — belz unified design system.
//
// One source of truth (tokens.ts) → three surfaces:
//   - web      consumes ./theme.css (generated) via Tailwind
//   - extension consumes ./theme.css + components.css
//   - CLI      consumes ./terminal (truecolor ANSI bound to the same hex)

export {
  palette,
  radius,
  space,
  fontSize,
  fontFamily,
  fontFile,
  motion,
} from "./tokens";
export type { Palette, ColorToken } from "./tokens";

export { role } from "./color";
export type { Role } from "./color";

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

export { generateThemeCss } from "./css";
