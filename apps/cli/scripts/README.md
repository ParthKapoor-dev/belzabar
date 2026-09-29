# apps/cli/scripts

Install and update scripts. The repo-root one-liners (`install.sh`, `install.ps1`) clone or pull
the source into `~/.belz/src` and hand off here; `belz update` calls these after pulling.

| File | Role |
|------|------|
| `install.sh [--env-file <path>] [--install-dir <dir>]` | `bun install --ignore-scripts`, compile, install the binary (default `~/.local/bin`), record install metadata, and on first install run `belz onboard` (or `belz setup --env-file`). "First install" is decided before metadata recording creates config.json (`FIRST_RUN`) |
| `install.ps1 [-EnvFile <path>] [-InstallDir <dir>]` | Windows equivalent (per-user `%LOCALAPPDATA%\belz\bin`, per-user PATH, no admin). If `belz.exe` is in use it stages `belz.exe.new` and launches `swap-binary.ps1` |
| `swap-binary.ps1 -NewPath <new> -TargetPath <exe>` | Waits for the running binary to exit, then moves the new one into place |
| `record-install.mjs <sourceDir> <installDir> <repoUrl> <version>` | Writes the `belz` section of `~/.belz/config.json` (read by `belz update`): atomic, 0600 file / 0700 dir, other sections kept, never overwrites a malformed config |
| `reinstall.sh [--env-file <path>] [--install-dir <dir>] [--yes]` | Deletes `~/.belz/` (credentials, sessions, caches) and the binary, then runs `install.sh` |

Tests: `apps/cli/tests/install-scripts.test.ts` (record-install in a scratch HOME; installers
decide first run before recording) and `update-paths.test.ts`.

Up: [apps/cli](../README.md).
