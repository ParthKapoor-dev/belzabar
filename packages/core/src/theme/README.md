# core/src/theme

The single place CLI styling is defined. Commands and the runner use `ui` / `term` / `symbols`
(re-exported by `src/ui.ts`), never raw ANSI.

| File | Contents |
|------|----------|
| `tokens.ts` | `palette`: hex colours named by intent (`fg`, `fgMuted`, `fgFaint`, `accent`, `success`, `warning`, `danger`) |
| `terminal.ts` | `term` (colour and weight functions over the palette) and `symbols` (glyphs) |
| `index.ts` | `ui` line helpers (`ok`, `err`, `warn`, `info`, `step`, `heading`, …) and the `wordmark` |

Colours are truecolor ANSI when `COLORTERM` advertises it, else the nearest xterm-256 colour.
They are off when `NO_COLOR` is set or stdout is not a TTY, unless `FORCE_COLOR` is set
(`FORCE_COLOR=0` also disables them). Help and other print outcomes are additionally
ANSI-stripped by the runner off a TTY.

Up: [src](../README.md).
