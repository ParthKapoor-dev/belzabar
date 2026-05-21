---
name: ys
description: Domain context for the YieldSec (YS) project — a content watermarking / proof-of-authenticity system built entirely on the Expertly Automation Designer platform. Covers the two flows (workbook upload, watermarking/OTS proof), the four YieldSec.* AD services, the core PostgreSQL tables, the file status lifecycle, external integrations (Google Drive, OpenTimestamps/Bitcoin, Expertly DMS, Scheduler), and the env URLs. OPT-IN ONLY — load this skill ONLY when the user explicitly invokes /ys or asks to load YieldSec context. Do NOT auto-trigger on incidental "yieldsec"/"watermark" keywords; the user manually selects which project context applies.
---

# YieldSec Domain Context

Loads enough background on the YieldSec project that you can reason about its
two flows, AD chains, and DB tables without re-reading the handover doc. This is
**read-only context** — it carries no workflow, no commands, no rules. Pair it
with `belz-ai` (workflow) and `tw-dev-note` (Dev Note formatting).

For exact step numbers, full input/output shapes, or edge cases beyond what's
here, run `belz ad show <chain-id> --full --llm` against a YS env (e.g.
`--env ys-qa`).

---

## What YieldSec is

**YieldSec ("YS")** is a **content watermarking and proof-of-authenticity
system**. It watermarks files, anchors a cryptographic hash of each one to the
**Bitcoin blockchain via OpenTimestamps (OTS)**, and produces downloadable
**proof** and **verification** documents — so a client can prove a file existed,
unaltered, at a specific point in time.

The broader product monitors illegal online-market activity; market-traffic data
is gathered by external **web-scraping "target scripts"** (NOT hosted on AD)
whose Excel output is uploaded into the system. The two AD-hosted flows below are
the parts that live on the Expertly platform.

It is built **entirely on the Expertly Automation Designer (AD) platform** — AD
chains for logic, Page Designer pages for UI, PostgreSQL for storage. There is no
separate hand-rolled backend.

---

## The two flows

Both flows are scoped to a **client** (`clients.client_uuid` is the FK target
everything hangs off).

### Flow 1 — Workbook upload
A client uploads an Excel **workbook** in a fixed format. The system converts it
to JSON, parses the rows, and stores them as **dataset records** keyed by
reporting dimensions: `year`, `month`, `market`, `country`, `category`. Those
dimensions become the filterable facets in the UI. Entry chain:
`YieldSec.Datasets/uploadFromWorkbook`.

### Flow 2 — Watermarking / Proof (OpenTimestamps)
1. A user uploads file(s) into a **Google Drive folder** and shares it with the
   service identity **`david.bodnick@yieldsec.com`**.
2. They submit the Drive URL. The system lists the files, computes a **SHA-256**
   of each, creates an **OTS timestamp** request (anchors the hash to Bitcoin),
   and **schedules a poller** to run every 10 min for up to 6 h.
3. The poller (`processFile`) checks whether the OTS timestamp has been
   **upgraded** — confirmed in a mined Bitcoin block (~10 min). Until then the
   file stays `PENDING`.
4. Once confirmed, it uploads the OTS / proof / verification files back to Drive,
   validates the timestamp on-chain, records the merkle root + OTS metadata,
   marks the file `COMPLETE`, and cancels the scheduler.

### File status lifecycle (`yieldsec_files.status`)
```
CREATED  →  PENDING  →  COMPLETE
   │           │           └─ OTS confirmed on Bitcoin; proof + verification docs uploaded
   │           └─ OTS request created; scheduler polling every 10 min (≤ 6 h)
   └─ yieldsec_files row inserted, SHA-256 computed
```

---

## AD services (four `YieldSec.*`, all USER_GENERATED)

| Service             | Methods | Purpose |
| ------------------- | ------- | ------- |
| `YieldSec.Proof`    | 11      | Watermarking / OTS / proof engine — both watermarking entry points |
| `YieldSec.Public`   | 16      | Public-portal CRUD — client & user management, navigation config |
| `YieldSec.Datasets` | 6       | Workbook dataset upload, replace, list, lookup |
| `YieldSec.Helper`   | 5       | Shared helpers — config lookup, user→client resolve, doc up/download, country lookup |

### Anchor chains to know

| Chain                              | Service             | Purpose |
| ---------------------------------- | ------------------- | ------- |
| `watermarkGoogleDriveFileOrFolder` | `YieldSec.Proof`    | Watermarking entry — Drive URL in, fans out per file (async) |
| `watermarkGoogleDriveFile`         | `YieldSec.Proof`    | Per-file worker — SHA-256, OTS stamp, schedules the poller |
| `processFile`                      | `YieldSec.Proof`    | Scheduled poller — checks OTS confirmation, finalizes, self-cancels |
| `fetchYieldSecData`                | `YieldSec.Proof`    | Lists a client's watermarking records (paginated) |
| `uploadFromWorkbook`               | `YieldSec.Datasets` | Workbook entry — Excel → `yieldsec_dataset` rows |
| `client.listAll`                   | `YieldSec.Public`   | Powers the list-all-clients page |
| `client.create` / `update` / `get` | `YieldSec.Public`   | Client CRUD |

`YieldSec.Public` also has `user.*` (create/get/listAll/update/activate/
deactivate) and `navigationConfigurations.*` (get/create/update). `processFileClone`
and `watermarkGoogleDriveFileClone` are dev/test clones — **not production paths**.

---

## Core PostgreSQL tables (6, PostgreSQL 14)

| Table              | Role |
| ------------------ | ---- |
| `clients`          | Client orgs. `client_uuid` (UUID) is the FK target for all other tables. |
| `users`            | Portal users. `uuid`, `client_id` → `clients.client_uuid`. |
| `yieldsec_dataset` | Workbook records. Dimensions `year`/`month`/`client`/`market`/`country`/`category`, `records` (json). |
| `yieldsec_files`   | Watermarking files. `sha256`, `google_drive_file_url`, `status`, `ots_*`, `additional_metadata` (json — merkle root etc.). |
| `configurations`   | Key/value config: `monitoring_emails`, `portal_application_id`, `proof_file_templated` / `verification_file_templated` (S3 paths), `… - [nav]` page-nav keys. |
| `req_res_logs`     | Integration audit log. `type` ∈ {`process_file_logic`, `google_drive_file_watermark`}. |

`users`, `yieldsec_dataset`, `yieldsec_files` all reference `clients.client_uuid`.

> Query with the YS read DB nickname, e.g.:
> `belz ad sql run "select * from yieldsec_dataset limit 1" --db YieldsecDB --env ys-qa`

---

## External integrations

- **Google Drive** — `Files.Storage.Google` plus direct Drive REST calls inside
  Python steps in `YieldSec.Proof`. Files are read via `david.bodnick@yieldsec.com`;
  if a folder isn't shared with that identity, the metadata call 403s and the
  file never leaves `CREATED`. ⚠️ Drive OAuth creds are currently hard-coded
  inline in the Python step source — should be moved to `configurations`.
- **OpenTimestamps (OTS)** — `opentimestamps-client` is installed on the AD host
  (`otsLibraryPath`). A request is created at watermark time and **upgraded** once
  the hash is committed in a mined Bitcoin block. If confirmation takes longer
  than the 6-h window, the scheduler expires and the file is left `PENDING`
  (needs manual re-drive).
- **Expertly DMS** — `Expertly.DMS` (`file.uploadMultiple`, `file.download`).
  S3-backed; stores OTS files + generated proof/verification docs.
- **Expertly.Automation.Scheduler** — schedules `processFile` (10-min interval,
  6-h window, UTC); cancelled by `processFile` itself once the file is `COMPLETE`.

---

## Authorization model (`YieldSec.Public`)

Create / update / activate / deactivate chains guard with
`#{LoggedInUser.External} eq true → exception.raise` — **external users cannot
manage clients or users**; only internal users can. Clients and users are backed
by `Expertly.PortalUser`: every create/activate/deactivate calls
`Expertly.PortalUser` first, then writes the local table. The YS `clients` /
`users` tables **mirror** the portal records.

---

## Environments

Staff portals (where AD/PD designers live — `belz` talks to these):

| belz env   | Staff URL |
| ---------- | --------- |
| `ys-demo`  | `https://yieldsec.expertly.cloud` |
| `ys-qa`    | `https://yieldsec.qa.expertly.cloud` (primary working env) |
| `ys-stage` | `https://yieldsec.stage.expertly.cloud` |
| `ys-prod`  | `https://yieldsec.expertly.com` |

Public portals (operator-facing; the AD/PD designers do NOT exist here):

| Env   | Public URL |
| ----- | ---------- |
| QA    | `https://public-yieldsec.demo.expertly.cloud` |
| Stage | `https://public-yieldsec.stage.expertly.cloud` |
| Prod  | `https://ysmetrics.com` |

> The exact belz env names come from `~/.belz/config.json` (`belz envs` lists
> them). Credentials live there too — never in the repo.

UI pages of note (staff portal `/pages/...`):
- `…/pages/yieldsec/list-all-clients` — clients (Flow 1 + client mgmt)
- `…/pages/yieldsec/watermark-activity` — watermarking (Flow 2)

---

## Patterns to remember

- **Two independent flows, one client scope.** Almost everything keys off
  `clients.client_uuid`. When debugging, first establish which client + which
  flow you're in.
- **OTS upgrade is the gate.** A file stuck in `PENDING` almost always means the
  Bitcoin timestamp hasn't been confirmed yet (or the 6-h scheduler window
  expired). Check `processFile` + the scheduled-automation record.
- **Drive sharing is the silent failure.** A file stuck in `CREATED` usually
  means the Drive folder wasn't shared with `david.bodnick@yieldsec.com`.
- **Service category cheat sheet** (for `tw-dev-note` classification):
  `YieldSec.Proof` (watermarking/OTS), `YieldSec.Public` (client/user CRUD,
  nav config), `YieldSec.Datasets` (workbook datasets), `YieldSec.Helper`
  (shared utilities). Confirm with `belz ad show <uuid> --llm` if unsure.
