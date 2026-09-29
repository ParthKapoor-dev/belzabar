# `belz envs`

Lists every configured environment (from `~/.belz/config.json`, or `BELZ_HOME`) with its
project and base URL, and marks the active one: `--env`, else `BELZ_ENV`, else the config's
`defaultEnv`, else the only configured env. With several envs and no default, none is active
(`active: null`) and env-aware commands fail with `ENV_NOT_SELECTED` until you pass `--env`.

```bash
belz envs
belz envs --env qa --llm
```

Local only (no network); the envelope carries no `meta.env`. Implementation: `index.ts`.
