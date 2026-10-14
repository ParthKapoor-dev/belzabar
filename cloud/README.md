# Running belz in Claude Code **cloud** sessions

Use belz from a Claude Code cloud session (claude.ai/code) — driveable from your
phone, with your laptop off — **without ever giving the cloud session access to
this private `belzabar` repo.**

## Files

| File | Role |
|------|------|
| `publish.sh` | Builds the Linux binary (pinned Bun, frozen lockfile) and pushes it plus the files below to the sandbox repo; run by `.github/workflows/belz-cloud-release.yml` |
| `setup.sh` | Becomes the sandbox's `cloud-setup.sh`: downloads the binary and writes `~/.wi-impl/config.json` from env vars (`belz setup --from-env`); idempotent |
| `sandbox-CLAUDE.md` | Becomes the sandbox's `CLAUDE.md`: rules for the cloud session |
| `sandbox-settings.json` | Becomes the sandbox's Claude settings: the SessionStart hook that runs `cloud-setup.sh` |

## The idea: decouple the session's repo from the belz tooling

A cloud session always clones *a* repo, but it can be **any** repo your GitHub
account can see — it does not have to be belzabar. So we use a tiny throwaway
**runner repo** for the session, and deliver belz into it as a prebuilt binary.

```
  belzabar (private)                belz-sandbox (private)            cloud session
  ─────────────────                 ──────────────────────            ─────────────
  CI: cloud/publish.sh  ──pushes──▶  • belz-linux-x64 (Release)  ◀──clones──  setup
  on every push to main             • CLAUDE.md (rules)           script installs
                                    • cloud-setup.sh              belz + writes
                                                                  ~/.wi-impl/config.json
```

- **belzabar** — never attached to a cloud session. Its CI builds belz and
  pushes the bundle *out* to belz-sandbox.
- **belz-sandbox** — a private repo the cloud session connects to. CI-maintained;
  you never hand-edit it. Holds a rules
  `CLAUDE.md` (from `cloud/sandbox-CLAUDE.md`), `cloud-setup.sh` (from
  `cloud/setup.sh`), and the belz binary as a rolling Release.
- **cloud session** — clones belz-sandbox, runs the setup script, ends up with a
  fully configured belz exactly like a local session.

**Why a separate repo (and not a Release on belzabar):** GitHub has no
"releases-only" token scope — any token that can download belzabar's release can
also clone belzabar's source. Publishing to belz-sandbox keeps the cloud's token
unable to reach belzabar at all.

## One-time setup

### 1. Create the `belz-sandbox` repo (private, empty)
Just create it on GitHub. CI fills it in.

### 2. Wire belzabar CI to publish to it
In **belzabar**'s GitHub settings:
- **Variable** `WI_IMPL_SANDBOX_REPO` = `your-org/belz-sandbox`
- **Secret** `WI_IMPL_SANDBOX_TOKEN` = a fine-grained PAT with **Contents: read &
  write on belz-sandbox ONLY** (do not grant it belzabar).

`.github/workflows/belz-cloud-release.yml` then runs on every push to `main`
(or `workflow_dispatch`) and publishes the bundle. To publish once by hand:
```bash
SANDBOX_REPO=your-org/belz-sandbox bash cloud/publish.sh
```
It builds with the same Bun as CI (1.2.20 — it refuses any other version) and
`bun install --frozen-lockfile`, so a stale `bun.lock` fails the publish
(`scripts/ci-pins.test.ts` keeps the workflows and this script in step).

### 3. Create the cloud environment (claude.ai/code → New cloud environment)
- **Repository:** `belz-sandbox` (NOT belzabar).
- **Network access:** **Custom** (Trusted alone can't reach your internal hosts).
  Keep "include default list" on (for the GitHub clone/download), and add the
  hosts your config points at — every env URL, your Jenkins and your Teamwork
  site, e.g.:
  ```
  *.dev.example.test
  *.qa.example.test
  jenkins.example.test
  <company>.teamwork.com
  ```
  If a deeper host isn't reached by a wildcard, add it explicitly — or use
  **Full** if the allowlist gets unwieldy.
- **Setup script:** **leave empty.** Cloud env vars are NOT exported to the
  Setup-script phase — only to the running session. belz is instead installed +
  configured by a **SessionStart hook** (belz-sandbox's Claude settings file,
  copied from `cloud/sandbox-settings.json`) that runs `cloud-setup.sh`
  in-session, where the env vars exist.
- **Environment variables:** see below.

### 4. Environment variables (the only place creds can go)
There is **no secrets store** in cloud — env vars are visible to anyone who can
edit the environment. So configure **non-prod only** unless you accept the
exposure. Use the project-agnostic `WI_IMPL_ENV_<NAME>_*` keys
(`<NAME>` lowercases with `_`→`-`, e.g. `WI_IMPL_ENV_ACME_QA_URL` → env `acme-qa`).

> **Do NOT quote values.** The cloud .env field stores quotes literally
> (`KEY='v$$'` → the value becomes `'v$$'`, quotes and all). Write bare values:
> `WI_IMPL_ENV_ACME_DEV_PASSWORD=p@ss$$word`.

```dotenv
# which repo holds the belz release (also derivable from the clone's origin)
WI_IMPL_SANDBOX_REPO=your-org/belz-sandbox
# set this so the SessionStart hook can download the (private) release binary
WI_IMPL_SANDBOX_TOKEN=<read-only PAT on belz-sandbox>

# one block per env (there are no built-in envs — URL is always required)
WI_IMPL_ENV_ACME_DEV_URL=https://acme.dev.example.test
WI_IMPL_ENV_ACME_DEV_USER=...
WI_IMPL_ENV_ACME_DEV_PASSWORD=...
WI_IMPL_ENV_ACME_QA_URL=https://acme.qa.example.test
WI_IMPL_ENV_ACME_QA_USER=...
WI_IMPL_ENV_ACME_QA_PASSWORD=...
WI_IMPL_ENV_ACME_QA_PROJECT=ACME
# env used when --env is omitted (else config "defaultEnv"; with one env, that one)
WI_IMPL_ENV=acme-dev

# optional (imported into config.json by `belz setup --from-env`)
WI_IMPL_JENKINS_URL=...
WI_IMPL_JENKINS_USER=...
WI_IMPL_JENKINS_PASSWORD=...
WI_IMPL_JENKINS_JOB=...
TEAMWORK_URL=https://<company>.teamwork.com
TEAMWORK_EMAIL=...
TEAMWORK_PASSWORD=...
```

> **Skip prod.** Don't put `WI_IMPL_ENV_*_PROD_*` (or any production host's)
> creds here unless you really want a phone-driven session to be able to touch
> production. The blast radius of plaintext env vars is the whole point of the
> warning.

## What a session can do
On session start, the hook installs belz + writes the config, so the session has
`belz` on PATH — identical to local. It works through the
**belz CLI** only; it has no belzabar source and the `CLAUDE.md` rules tell it
never to commit to the sandbox repo. Verify with `belz envs` and `belz --help`.
(If the hook didn't run, `bash cloud-setup.sh` bootstraps it — it's idempotent.)

## Updating belz
Push to belzabar `main` → CI rebuilds and republishes to belz-sandbox →
the next cloud session downloads the latest binary automatically.
