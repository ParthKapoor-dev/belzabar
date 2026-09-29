# `belz envs`

Lists every configured environment (from `~/.belz/config.json`, or `BELZ_HOME`) with its
project and base URL, and marks the active one: `--env`, else `BELZ_ENV`, else the config's
`defaultEnv`, else `nsm-dev`.

```bash
belz envs
belz envs --env nsm-qa --llm
```

Local only (no network); the envelope carries no `meta.env`. Implementation: `index.ts`.
