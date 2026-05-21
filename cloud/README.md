# Running belz in Claude Code **cloud** sessions

Use belz from a Claude Code cloud session (claude.ai/code) — driveable from your
phone, with your laptop off — **without ever giving the cloud session access to
this private `belzabar` repo.**

## The idea: decouple the session's repo from the belz tooling

A cloud session always clones *a* repo, but it can be **any** repo your GitHub
account can see — it does not have to be belzabar. So we use a tiny throwaway
**runner repo** for the session, and deliver belz into it as a prebuilt binary.

```
  belzabar (private)                belz-sandbox (private)            cloud session
  ─────────────────                 ──────────────────────            ─────────────
  CI: cloud/publish.sh  ──pushes──▶  • belz-linux-x64 (Release)  ◀──clones──  setup
  on every push to main             • .claude/skills/             script installs
                                    • CLAUDE.md (rules)           belz + writes
                                    • cloud-setup.sh              ~/.belz/config.json
```

- **belzabar** — never attached to a cloud session. Its CI builds belz and
  pushes the bundle *out* to belz-sandbox.
- **belz-sandbox** — a private repo the cloud session connects to. CI-maintained;
  you never hand-edit it. Holds the skills, a rules `CLAUDE.md`, and the belz
  binary as a rolling Release.
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
- **Variable** `BELZ_SANDBOX_REPO` = `your-org/belz-sandbox`
- **Secret** `BELZ_SANDBOX_TOKEN` = a fine-grained PAT with **Contents: read &
  write on belz-sandbox ONLY** (do not grant it belzabar).

`.github/workflows/belz-cloud-release.yml` then runs on every push to `main`
(or `workflow_dispatch`) and publishes the bundle. To publish once by hand:
```bash
SANDBOX_REPO=your-org/belz-sandbox bash cloud/publish.sh
```

### 3. Create the cloud environment (claude.ai/code → New cloud environment)
- **Repository:** `belz-sandbox` (NOT belzabar).
- **Network access:** **Custom** (Trusted alone can't reach your internal hosts).
  Keep "include default list" on (for the GitHub clone/download), and add:
  ```
  *.nc.verifi.dev
  *.verifi-nc.com
  *.expertly.cloud
  *.expertly.com
  ysmetrics.com
  projects.webintensive.com
  ```
  If a deeper host (e.g. `jenkins-asg.stg.expertly.cloud`,
  `migration.services.qa.expertly.cloud`) isn't reached by the wildcard, add it
  explicitly — or use **Full** if the allowlist gets unwieldy.
- **Setup script:** **leave empty.** Cloud env vars are NOT exported to the
  Setup-script phase — only to the running session. belz is instead installed +
  configured by a **SessionStart hook** (`.claude/settings.json`, committed into
  belz-sandbox) that runs `cloud-setup.sh` in-session, where the env vars exist.
- **Environment variables:** see below.

### 4. Environment variables (the only place creds can go)
There is **no secrets store** in cloud — env vars are visible to anyone who can
edit the environment. So configure **non-prod only** unless you accept the
exposure. Use the project-agnostic `BELZ_ENV_<NAME>_*` keys
(`<NAME>` lowercases with `_`→`-`, e.g. `BELZ_ENV_YS_QA_URL` → env `ys-qa`).

> **Do NOT quote values.** The cloud .env field stores quotes literally
> (`KEY='v$$'` → the value becomes `'v$$'`, quotes and all). Write bare values:
> `BELZ_ENV_NSM_DEV_PASSWORD=preeti@Ver1f1$$`.

```dotenv
# which repo holds the belz release (also derivable from the clone's origin)
BELZ_SANDBOX_REPO=your-org/belz-sandbox
# set this so the SessionStart hook can download the (private) release binary
BELZ_SANDBOX_TOKEN=<read-only PAT on belz-sandbox>

# NSM (built-in names — URL is filled in automatically)
BELZ_ENV_NSM_DEV_USER=...
BELZ_ENV_NSM_DEV_PASSWORD=...
BELZ_ENV_NSM_QA_USER=...
BELZ_ENV_NSM_QA_PASSWORD=...

# YieldSec (custom env — URL required)
BELZ_ENV_YS_QA_URL=https://yieldsec.qa.expertly.cloud
BELZ_ENV_YS_QA_USER=...
BELZ_ENV_YS_QA_PASSWORD=...
BELZ_ENV_YS_QA_PROJECT=YieldSec

# optional
BELZ_JENKINS_URL=...
BELZ_JENKINS_USER=...
BELZ_JENKINS_PASSWORD=...
TEAMWORK_EMAIL=...
TEAMWORK_PASSWORD=...
```

> **Skip prod.** Don't put `BELZ_ENV_*_PROD_*` (or `staff-nss`/`yieldsec.expertly.com`)
> creds here unless you really want a phone-driven session to be able to touch
> production. The blast radius of plaintext env vars is the whole point of the
> warning.

## What a session can do
On session start, the hook installs belz + writes the config, so the session has
`belz` on PATH and the skills loaded — identical to local. It works through the
**belz CLI** only; it has no belzabar source and the `CLAUDE.md` rules tell it
never to commit to the sandbox repo. Verify with `belz envs` and `belz --help`.
(If the hook didn't run, `bash cloud-setup.sh` bootstraps it — it's idempotent.)

## Updating belz
Push to belzabar `main` → CI rebuilds and republishes to belz-sandbox →
the next cloud session downloads the latest binary + skills automatically.
