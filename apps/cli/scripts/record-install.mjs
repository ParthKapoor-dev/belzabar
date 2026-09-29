// Records belz install metadata into ~/.belz/config.json.
//
// `belz update` needs to know which git checkout belz was built from and where
// the binary was installed. The install scripts (install.sh / install.ps1) run
// this after installing the binary. Non-`belz` config sections are preserved.
//
// Usage: node record-install.mjs <sourceDir> <installDir> <repoUrl> <version>

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const [sourceDir, installDir, repoUrl, version] = process.argv.slice(2);
const configPath = join(homedir(), '.belz', 'config.json');

let config = {};
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  if (err?.code !== 'ENOENT') {
    // Never replace an unreadable/malformed config (it holds credentials).
    console.error(`record-install: not updating ${configPath}: ${err?.message ?? err}`);
    process.exit(1);
  }
}

config.belz = {
  ...config.belz,
  sourceDir: sourceDir || config.belz?.sourceDir,
  installDir: installDir || config.belz?.installDir,
  repoUrl: repoUrl || config.belz?.repoUrl,
  version: version || config.belz?.version,
  installedAt: new Date().toISOString(),
};

// config.json holds credentials: private dir, 0600 file, written atomically
// (tmp + rename) so a crash never truncates it (CORE-R2).
mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
chmodSync(tmp, 0o600);
renameSync(tmp, configPath);
console.log(`recorded belz install metadata → ${configPath}`);
