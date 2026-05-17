// Generates dist/theme.css from the design tokens.
// Run with: bun run scripts/build-css.ts  (or `bun run build`).

import { generateThemeCss } from "../src/css";

const out = `${import.meta.dir}/../dist/theme.css`;
await Bun.write(out, generateThemeCss());
console.log(`@belzabar/design → wrote ${out}`);
