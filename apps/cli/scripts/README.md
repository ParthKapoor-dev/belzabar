# apps/cli/scripts

Install, update and release-build scripts. The repo-root one-liners (`install.sh`, `install.ps1`)
install the release binary by default; with `--from-source` (Windows: `WI_IMPL_FROM_SOURCE=1`) they
clone or pull the source into `~/.wi-impl/src` and hand off to the source installers here. `wi-impl update`
on a source install calls these after pulling.

| File | Role |
|------|------|
| `build-release.ts` | Release build. `--targets <t,…> --out <dir> [--sign]` compiles `wi-impl-<target>` binaries (default: every target in `../lib/release.ts`; `--sign` ad-hoc codesigns darwin builds, macOS only). `--manifest-only --out <dir>` hashes the binaries in `<dir>` and writes `SHA256SUMS`, `manifest.json` and copies of the root installers. Used by `.github/workflows/release.yml` |
| `install.sh [--env-file <path>] [--install-dir <dir>]` | Source install: `bun install --ignore-scripts`, compile, install the binary (default `~/.local/bin`), record install metadata (`installKind: "source"`), and on first install run `wi-impl onboard` (or `wi-impl setup --env-file`). "First install" is decided before metadata recording creates config.json (`FIRST_RUN`) |
| `install.ps1 [-EnvFile <path>] [-InstallDir <dir>]` | Windows equivalent (per-user `%LOCALAPPDATA%\wi-impl\bin`, per-user PATH, no admin). If `wi-impl.exe` is in use it stages `wi-impl.exe.new` and launches `swap-binary.ps1` |
| `swap-binary.ps1 -NewPath <new> -TargetPath <exe>` | Waits for the running binary to exit, then moves the new one into place |
| `record-install.mjs <sourceDir> <installDir> <repoUrl> <version>` | Writes the `wi-impl` section of `~/.wi-impl/config.json` (read by `wi-impl update`): atomic, 0600 file / 0700 dir, other sections kept, never overwrites a malformed config |
| `reinstall.sh [--env-file <path>] [--install-dir <dir>] [--yes]` | Deletes `~/.wi-impl/` (credentials, sessions, caches) and the binary, then runs `install.sh` |

Tests: `apps/cli/tests/install-scripts.test.ts` (record-install in a scratch HOME; installers
decide first run before recording), `update-paths.test.ts` and `self-update.test.ts`.

Up: [apps/cli](../README.md).
