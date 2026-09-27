// Records belz install metadata into ~/.belz/config.json.
//
// `belz update` needs to know which git checkout belz was built from and where
// the binary was installed. The install scripts (install.sh / install.ps1) run
// this after installing the binary. Non-`belz` config sections are preserved.
//
// Usage: node record-install.mjs <sourceDir> <installDir> <repoUrl> <version>

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const [sourceDir, installDir, repoUrl, version] = process.argv.slice(2);
const configPath = join(homedir(), '.belz', 'config.json');

let config = {};
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  /* no existing config */
}

config.belz = {
  ...config.belz,
  sourceDir: sourceDir || config.belz?.sourceDir,
  installDir: installDir || config.belz?.installDir,
  repoUrl: repoUrl || config.belz?.repoUrl,
  version: version || config.belz?.version,
  installedAt: new Date().toISOString(),
};

mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`recorded belz install metadata → ${configPath}`);
