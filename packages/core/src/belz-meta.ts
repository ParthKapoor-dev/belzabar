// belz install metadata.
//
// belz is a compiled binary built from a git checkout. To self-update
// (`belz update`) and to install OS services, belz needs to know where that
// checkout lives and where its own binary was installed. That metadata is
// written to ~/.belz/config.json (the `belz` section) by the installer and by
// `belz update`, and read back here.

import { join } from "path";
import { homedir } from "os";
import { loadConfigFileRaw, writeConfigFile, type BelzConfigFile } from "./config";

const isWindows = process.platform === "win32";

/** Default source-checkout location when nothing is recorded. */
function defaultSourceDir(): string {
  return process.env.BELZ_SRC_DIR ?? join(homedir(), ".belz", "src");
}

/** Default binary-install directory when nothing is recorded. */
function defaultInstallDir(): string {
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "belz", "bin");
  }
  return join(homedir(), ".local", "bin");
}

/** Absolute path to the git checkout belz was built from. */
export function getSourceDir(): string {
  return loadConfigFileRaw().belz?.sourceDir ?? defaultSourceDir();
}

/** Absolute directory containing the installed belz binary. */
export function getInstallDir(): string {
  return loadConfigFileRaw().belz?.installDir ?? defaultInstallDir();
}

/** Absolute path to the installed belz binary itself. */
export function getBinaryPath(): string {
  return join(getInstallDir(), isWindows ? "belz.exe" : "belz");
}

/** Recorded install metadata, with defaults filled in. */
export function getBelzMeta(): Required<NonNullable<BelzConfigFile["belz"]>> {
  const belz = loadConfigFileRaw().belz ?? {};
  return {
    sourceDir: belz.sourceDir ?? defaultSourceDir(),
    installDir: belz.installDir ?? defaultInstallDir(),
    repoUrl: belz.repoUrl ?? "",
    installedAt: belz.installedAt ?? "",
    version: belz.version ?? "",
  };
}

/** Merge a partial update into the `belz` section of config.json. */
export function recordBelzMeta(partial: Partial<NonNullable<BelzConfigFile["belz"]>>): void {
  const config = loadConfigFileRaw();
  config.belz = { ...config.belz, ...partial };
  writeConfigFile(config);
}
