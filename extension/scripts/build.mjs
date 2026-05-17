// Bundles every extension entry point and escapes non-ASCII in the output.
//
// Each entry is built in its own `bun build` invocation so the output lands
// flat in dist/ (a single shared build would mirror the src/ subdirectories).
//
// The DevTools HTML shells (devtools.html, panel.html) stay at the extension
// root and are NOT copied into dist/ — keeping them at the root makes the
// panel page path resolve the same way in Chromium and Firefox.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const entries = [
  { src: 'src/ad-content.js', out: 'ad-content.js' },
  { src: 'src/pd-content.js', out: 'pd-content.js' },
  { src: 'src/pd-inspector.js', out: 'pd-inspector.js' },
  { src: 'src/background.js', out: 'background.js' },
  { src: 'src/devtools/devtools-page.js', out: 'devtools-page.js' },
  { src: 'src/devtools/panel.js', out: 'panel.js' },
  { src: 'src/devtools/panel-pd.js', out: 'panel-pd.js' }
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

console.log('extension build complete');
