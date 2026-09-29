# core/src/config

belz configuration: `~/.belz/config.json` (or `$BELZ_HOME/config.json`) plus a small set of
trusted `BELZ_*` environment variables. `Config` is the process-wide view of the active
environment and its credentials.

## What's here

| File | Contents |
|------|----------|
| `index.ts` | `Config`, `BELZ_CONFIG_DIR`, `CONFIG_FILE_PATH`, `NO_ENV`, `loadConfigFileRaw`, `writeConfigFile`, `noEnvSelectedError`, `reloadConfig` (test seam) |
| `schema.ts` | zod schema `validateConfigFile`, type `BelzConfigFile`, `envEntryProblem` |
| `secrets.ts` | `decodeSecret`, `encodeSecret`, `keepSecret` |
| `fs.ts` | `writeSecureJson` (tmp + fsync + rename, 0600), `hardenBelzHome` |
| `env-vars.ts` | `trustedBelzEnv`, `withoutDotenvInjected`, `parseDotEnv` |

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
  "belz": { "sourceDir": "…", "installDir": "…", "repoUrl": "…", "installedAt": "…", "version": "…" }
}
```

- The schema is passthrough: unknown keys survive a read-modify-write. A violation fails with
  `CONFIG_INVALID` naming the path.
- `passwordEncoding` is `"plain"` or `"base64"`; absent means legacy base64, decoded strictly.
  New writes are plain (the file is 0600). Never guess an encoding.
- The `belz` section is install metadata written by the installer and `belz update`.
- When config loads, `hardenBelzHome` tightens an existing belz home to 0700 dirs and 0600
  files (no-op on Windows, never throws).

## Env selection

`--env` (runner → `Config.setActiveEnv`) > `BELZ_ENV` > `defaultEnv` > the only configured env.
There is no built-in env. With several envs and no default, `Config.envSource` is `"none"` and
env-aware commands fail with `ENV_NOT_SELECTED` (listing the configured envs); an unknown name
fails with `INVALID_ENV`.

`Config` members: `activeEnv` (never throws), `setActiveEnv`, `resetActiveEnv`,
`defaultEnvName`, `envSource` (`flag` | `BELZ_ENV` | `config` | `only` | `none`),
`envWasExplicit`, `configError`, `assertUsable()`, `baseUrl` / `cleanBaseUrl` / `loginId` /
`password` (throw when the env is unusable), `getJenkins()`, `getTeamwork()`,
`withEnv(name, fn)` (run on another env and restore the caller's selection exactly, even on
throw) and `captureActiveEnv()` (a restore function for code that switches several times).

## Environment variables

`trustedBelzEnv()` is the only way belz reads the process env. Bun auto-loads `.env*` files from
the current directory, even in the compiled binary, so a `BELZ_*` value identical to one in a
cwd `.env*` file is treated as injected and ignored. Variables read:

| Variable | Effect |
|----------|--------|
| `BELZ_HOME` | Replaces `~/.belz` (tests always set it) |
| `BELZ_ENV` | Default env for this shell |
| `BELZ_HTTP_TIMEOUT_MS` / `BELZ_HTTP_WRITE_TIMEOUT_MS` | HTTP timeouts (see [`../http/`](../http/README.md)) |
| `BELZ_JENKINS_{URL,USER,PASSWORD,JOB}` | Fallbacks for fields missing from the `jenkins` section |
| `BELZ_TEAMWORK_{URL,EMAIL,PASSWORD}` | Fallbacks for fields missing from the `teamwork` section (password plain) |
| `BELZ_SRC_DIR` | Fallback source checkout for `belz update` |
| `BELZ_VERBOSE` | Set to `1` by `-v`; enables `vlog` (read directly, not through `trustedBelzEnv`) |

Unprefixed keys (e.g. `TEAMWORK_*`) are read only by `belz setup --from-env`, through
`withoutDotenvInjected()`, which reports the keys it dropped.

Tests: `packages/core/tests/config.test.ts`. Up: [src](../README.md).
