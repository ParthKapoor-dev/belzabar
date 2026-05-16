// Bundles every extension entry point and escapes non-ASCII in the output.
//
// Each entry is built in its own `bun build` invocation so the output lands
// flat in dist/ (a single shared build would mirror the src/ subdirectories).
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const entries = [
  { src: 'src/content-script.js', out: 'content-script.js' },
  { src: 'src/features/chain-inspector/interceptor.js', out: 'interceptor.js' },
  { src: 'src/features/chain-inspector/chain-hud.js', out: 'chain-hud.js' }
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
