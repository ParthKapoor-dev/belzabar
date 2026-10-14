// wi-impl install metadata.
//
// wi-impl is a compiled binary built from a git checkout. To self-update
// (`wi-impl update`) and to install OS services, wi-impl needs to know where that
// checkout lives and where its own binary was installed. That metadata is
// written to ~/.wi-impl/config.json (the `install` section; `belz` before the rename) by the installer and by
// `wi-impl update`, and read back here.

import { join } from "path";
import { homedir } from "os";
import { loadConfigFileRaw, trustedBelzEnv, writeConfigFile, type BelzConfigFile } from "./config";

const isWindows = process.platform === "win32";

/** Default source-checkout location when nothing is recorded. */
function defaultSourceDir(): string {
  // Via trustedBelzEnv: a cwd `.env` must not choose which install.sh `wi-impl update` runs.
  return trustedBelzEnv().WI_IMPL_SRC_DIR || join(homedir(), ".wi-impl", "src");
}

/** Default binary-install directory when nothing is recorded. */
function defaultInstallDir(): string {
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "wi-impl", "bin");
  }
  return join(homedir(), ".local", "bin");
}

type InstallMeta = NonNullable<BelzConfigFile["install"]>;

/** The install section of `config`: `install`, or the legacy `belz` one until it is next written. */
export function installMeta(config: BelzConfigFile): InstallMeta | undefined {
  return config.install ?? config.belz;
}

/** Absolute path to the git checkout wi-impl was built from. */
export function getSourceDir(): string {
  return installMeta(loadConfigFileRaw())?.sourceDir ?? defaultSourceDir();
}

/** Absolute directory containing the installed wi-impl binary. */
export function getInstallDir(): string {
  return installMeta(loadConfigFileRaw())?.installDir ?? defaultInstallDir();
}

/** Merge a partial update into the `install` section of config.json (moving a legacy `belz` one). */
export function recordBelzMeta(partial: Partial<InstallMeta>): void {
  const config = loadConfigFileRaw();
  const install = { ...installMeta(config), ...partial };
  delete config.belz;
  writeConfigFile({ ...config, install });
}
