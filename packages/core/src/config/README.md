# core/src/config

belz configuration: `~/.wi-impl/config.json` (or `$WI_IMPL_HOME/config.json`) plus a small set of
trusted `WI_IMPL_*` environment variables. `Config` is the process-wide view of the active
environment and its credentials.

## What's here

| File | Contents |
|------|----------|
| `index.ts` | `Config`, `BELZ_CONFIG_DIR`, `CONFIG_FILE_PATH`, `NO_ENV`, `loadConfigFileRaw`, `writeConfigFile`, `noEnvSelectedError`, `reloadConfig` (test seam) |
| `schema.ts` | zod schema `validateConfigFile`, type `BelzConfigFile`, `envEntryProblem` |
| `secrets.ts` | `decodeSecret`, `encodeSecret`, `keepSecret` |
| `fs.ts` | `writeSecureJson` (tmp + fsync + rename, 0600), `hardenBelzHome` |
| `env-vars.ts` | `trustedBelzEnv`, `withoutDotenvInjected`, `parseDotEnv`, `inAgentSession` |

## config.json

```json
{
  "defaultEnv": "dev",
  "environments": {
    "dev": { "url": "https://dev.example.test", "user": "me", "password": "…", "passwordEncoding": "plain", "sqlDefaultDb": "main" }
  },
  "teamwork": { "baseUrl": "https://example.teamwork.test", "email": "…", "password": "…" },
  "jenkins": { "baseUrl": "…", "user": "…", "password": "…", "migrationJob": "…", "profileEnvs": { "dev": "dev" } },
  "lint": { "resolverTables": { "<table>": "<resolver function>" } },
  "install": { "sourceDir": "…", "installDir": "…", "repoUrl": "…", "installedAt": "…", "version": "…" }
}
```

- The schema is passthrough: unknown keys survive a read-modify-write. A violation fails with
  `CONFIG_INVALID` naming the path.
- `passwordEncoding` is `"plain"` or `"base64"`; absent means legacy base64, decoded strictly.
  New writes are plain (the file is 0600). Never guess an encoding.
- The `install` section is install metadata written by the installer and `belz update`;
  `install.installKind` is `"binary"` (release install, self-updating) or `"source"` (git checkout).
  Releases before the rename wrote it as `belz`: it is read from there and moved to `install` on
  the next write (`installMeta`, `recordBelzMeta`).
- `update` (optional): `auto: false` turns off the daily background update check of a binary
  install; `pin: "x.y.z"` keeps it on that version (`belz update` installs exactly it). See
  [`apps/cli/lib/README.md`](../../../../apps/cli/lib/README.md).
- When config loads, `hardenBelzHome` tightens an existing belz home to 0700 dirs and 0600
  files (no-op on Windows, never throws).

## Env selection

`--env` (runner → `Config.setActiveEnv`) > `WI_IMPL_ENV` > `defaultEnv` > the only configured env.
There is no built-in env. With several envs and no default, `Config.envSource` is `"none"` and
env-aware commands fail with `ENV_NOT_SELECTED` (listing the configured envs); an unknown name
fails with `INVALID_ENV`.

`Config` members: `activeEnv` (never throws), `setActiveEnv`, `resetActiveEnv`,
`defaultEnvName`, `envSource` (`flag` | `WI_IMPL_ENV` | `config` | `only` | `none`),
`envWasExplicit`, `configError`, `assertUsable()`, `baseUrl` / `cleanBaseUrl` / `loginId` /
`password` (throw when the env is unusable), `getJenkins()`, `getTeamwork()`,
`withEnv(name, fn)` (run on another env and restore the caller's selection exactly, even on
throw) and `captureActiveEnv()` (a restore function for code that switches several times).

## Environment variables

`trustedBelzEnv()` is the only way belz reads the process env. Bun auto-loads `.env*` files from
the current directory, even in the compiled binary, so a `WI_IMPL_*` value identical to one in a
cwd `.env*` file is treated as injected and ignored. Each variable is also read under its name
before the rename (`BELZ_HOME` for `WI_IMPL_HOME`, and so on) when the new name is not set
(`withLegacyNames`). Variables read:

| Variable | Effect |
|----------|--------|
| `WI_IMPL_HOME` | Replaces `~/.wi-impl` (tests always set it). Unset, while only the legacy `~/.belz` exists (a compiled binary moves it on its first run), that is read |
| `WI_IMPL_ENV` | Default env for this shell |
| `WI_IMPL_AGENT` | `1`: agent session (`--llm` output by default); `0`: never. Unset: Claude Code's `CLAUDECODE=1` decides (the one non-`WI_IMPL_` variable read, dotenv-checked the same way) |
| `WI_IMPL_HTTP_TIMEOUT_MS` / `WI_IMPL_HTTP_WRITE_TIMEOUT_MS` | HTTP timeouts (see [`../http/`](../http/README.md)) |
| `WI_IMPL_JENKINS_{URL,USER,PASSWORD,JOB}` | Fallbacks for fields missing from the `jenkins` section |
| `WI_IMPL_TEAMWORK_{URL,EMAIL,PASSWORD}` | Fallbacks for fields missing from the `teamwork` section (password plain) |
| `WI_IMPL_SRC_DIR` | Fallback source checkout for `belz update` |
| `WI_IMPL_NO_UPDATE` | `1` turns off the background auto-update of a binary install |
| `WI_IMPL_UPDATE_BASE_URL` | Replaces the GitHub Releases URL that updates and the installers download from (a mirror; the tests' local server) |
| `WI_IMPL_UPDATE_WORKER`, `WI_IMPL_RECORD_INSTALL`, `WI_IMPL_RECORD_PIN` | Internal modes of the binary (the background update check; the release installer recording the install and the pin of an explicit `--version`), set by belz and its installers |
| `WI_IMPL_VERBOSE` | Set to `1` by `-v`; enables `vlog` (read directly, not through `trustedBelzEnv`) |

Unprefixed keys (e.g. `TEAMWORK_*`) are read only by `belz setup --from-env`, through
`withoutDotenvInjected()`, which reports the keys it dropped.

Tests: `packages/core/tests/config.test.ts`. Up: [src](../README.md).
