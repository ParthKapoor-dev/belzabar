# apps/cli/lib

Release and self-update logic for the `belz` binary, shared by `belz update`
([`commands/update/`](../commands/update/help.txt)), the entry point ([`bin/cli.ts`](../bin/cli.ts)) and
the release build ([`../scripts/build-release.ts`](../scripts/build-release.ts)).

| File | Contents |
|------|----------|
| `release.ts` | `RELEASE_TARGETS` and `assetName` (`belz-<os>-<arch>[.exe]`), `currentTarget`, version helpers (`parseVersion`, `compareVersions`, `sameMajor`), the release `manifest.json` schema, `fetchManifest` (latest or `v<version>`), `downloadVerifiedAsset` (temp file → sha256 check → executable → rename), `releasesBaseUrl` |
| `auto-update.ts` | `autoUpdateBlocker` (the gate), `autoUpdateTick` (startup: owed notice + at most one background check per 24 h), `runUpdateWorker` (the detached check), `swapInBinary` / `rollbackBinary`, `installKind`, `recordBinaryInstall` |

## Releases

A release is a GitHub Release `vX.Y.Z` of this repo (`.github/workflows/release.yml`) holding
`belz-linux-x64`, `belz-linux-arm64`, `belz-darwin-x64`, `belz-darwin-arm64`,
`belz-windows-x64.exe`, `SHA256SUMS`, `manifest.json` and the installers. `manifest.json`:

```json
{ "version": "0.2.0", "sha": "abc1234", "publishedAt": "…",
  "assets": { "linux-x64": { "name": "belz-linux-x64", "sha256": "…" }, … } }
```

URLs are `<releases>/latest/download/<file>` and `<releases>/download/vX.Y.Z/<file>`, where
`<releases>` is `https://github.com/ParthKapoor-dev/belzabar/releases` unless
`BELZ_UPDATE_BASE_URL` overrides it (a mirror, or the tests' local server).

## Auto-update

Only for a **binary install**: `belz.installKind` is `"binary"` in config.json, written by the
release installer (`install.sh` / `install.ps1` run the new binary once with
`BELZ_RECORD_INSTALL=binary`; an explicit `--version` also passes `BELZ_RECORD_PIN`, which sets
`update.pin` so the version asked for is kept, while a latest install clears any pin). The
installer's own runs of belz set `BELZ_NO_UPDATE=1`, so the first check happens on your first
own run. Source installs record `"source"` and update through git.

1. `autoUpdateTick` runs at every startup. It prints "belz updated A → B" on stderr once after a
   background swap (human mode, terminal only), then returns unless `autoUpdateBlocker` allows an
   update and the last check (`~/.belz/update-state.json` `lastCheckAt`) is over 24 h old. It
   records the check time first, then spawns the binary detached with `BELZ_UPDATE_WORKER=1`.
   It never waits on the network and never throws.
2. `runUpdateWorker` (one at a time: `<belz>.update-lock`) reads the latest manifest. A newer
   version in the same major is downloaded to `<belz>.next`, verified, and swapped in by
   `swapInBinary`, which keeps the old binary as `<belz>.prev`. A command already running keeps
   executing the old file; the next run is the new version. Errors go to `lastError` in the
   state file. A newer major only sets `majorAvailable`.

Blocked when: not a compiled binary (`bun bin/cli.ts`), a dirty build, `CI` set,
`BELZ_NO_UPDATE=1`, `update.auto: false` or `update.pin` in config.json, or not a binary install.
stdout is never written, so the `--llm` envelope is unaffected.

`updateHint` (wired as the runner's `unknownHint`) adds a sentence to an unknown command or flag
error: "belz X is available … run `belz update`" when the state file's `latestVersion` is newer,
nothing when a check within 24 h found this version current, else a pointer to
`belz update --check`.

`swapInBinary` links (or copies) `<belz>` to `<belz>.prev` and renames `<belz>.next` over it,
atomic on Linux/macOS. On Windows the running `belz.exe` is renamed to `.prev` first.
`belz update --rollback` swaps `<belz>` and `<belz>.prev`.

Tests: [`../tests/self-update.test.ts`](../tests/self-update.test.ts).

Up: [apps/cli](../README.md).
