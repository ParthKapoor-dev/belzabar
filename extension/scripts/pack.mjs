// Assembles per-browser unpacked extension trees ready for packing/signing.
//
// `build.mjs` produces dist/. This script builds on top of it and writes two
// complete, loadable extension trees:
//
//   build/chrome/    — Chromium manifest (service_worker background)
//   build/firefox/   — Firefox manifest (scripts background + gecko id/update_url)
//
// The GitHub Actions release workflow runs this, then packs build/chrome into a
// signed CRX and signs build/firefox into an XPI. Locally it is also handy for
// `belz extension` testing.
//
// Usage: node scripts/pack.mjs [--version X.Y.Z]

import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');

const versionArg = (() => {
  const i = process.argv.indexOf('--version');
  return i !== -1 ? process.argv[i + 1] : null;
})();

const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const release = JSON.parse(readFileSync(path.join(root, 'release.config.json'), 'utf8'));
const version = versionArg ?? manifest.version;

// 1. Build dist/.
execSync('node scripts/build.mjs', { cwd: root, stdio: 'inherit' });

// 2. Files every packaged tree needs (besides the manifest, written per-browser).
const SHARED = ['dist', 'devtools.html', 'panel.html', 'panel-pd.html', 'fonts'];

/** Copy the shared payload into build/<target>/. */
function stage(target) {
  const dest = path.join(buildDir, target);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const item of SHARED) {
    const from = path.join(root, item);
    if (existsSync(from)) cpSync(from, path.join(dest, item), { recursive: true });
  }
  return dest;
}

// 3. Chromium tree — service_worker background, no gecko settings.
{
  const dest = stage('chrome');
  const m = structuredClone(manifest);
  m.version = version;
  if (m.background) delete m.background.scripts;
  delete m.browser_specific_settings;
  writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(m, null, 2));
}

// 4. Firefox tree — scripts background, gecko id + update_url for auto-update.
{
  const dest = stage('firefox');
  const m = structuredClone(manifest);
  m.version = version;
  if (m.background) delete m.background.service_worker;
  m.browser_specific_settings = {
    gecko: {
      id: release.firefoxId,
      strict_min_version: '128.0',
      update_url: release.firefoxUpdatesJsonUrl
    }
  };
  writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(m, null, 2));
}

console.log(`extension packed (v${version}) → build/chrome, build/firefox`);
