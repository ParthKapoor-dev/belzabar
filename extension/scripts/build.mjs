// Bundles every extension entry point, escapes non-ASCII in the output, and
// copies the static DevTools HTML shells into dist/.
//
// Each entry is built in its own `bun build` invocation so the output lands
// flat in dist/ (a single shared build would mirror the src/ subdirectories).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const entries = [
  { src: 'src/ad-content.js', out: 'ad-content.js' },
  { src: 'src/pd-content.js', out: 'pd-content.js' },
  { src: 'src/devtools/devtools-page.js', out: 'devtools-page.js' },
  { src: 'src/devtools/panel.js', out: 'panel.js' }
];

for (const { src, out } of entries) {
  execSync(`bun build ${src} --outdir dist --minify`, {
    cwd: root,
    stdio: 'inherit'
  });
  execSync(`node scripts/escape-non-ascii.mjs dist/${out}`, {
    cwd: root,
    stdio: 'inherit'
  });
}

fs.mkdirSync(dist, { recursive: true });
for (const html of ['devtools.html', 'panel.html']) {
  fs.copyFileSync(path.join(root, html), path.join(dist, html));
  console.log(`copied ${html} -> dist/`);
}

console.log('extension build complete');
