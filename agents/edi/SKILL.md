---
name: edi
description: Domain context for the EDI project — WebIntensive's internal "Employee Dashboard Internal", a staff-facing dashboard built on the Expertly Automation Designer platform that surfaces Teamwork (projects.webintensive.com) data and internal documents. Covers the company/platform context, the project's AD services (Employee Dashboard, Teamwork API Wrapper — the primary work area, ProjectManagement.Teamwork), the Teamwork.com REST integration, the shared Expertly platform services it builds on (Expertly.DMS / PortalUser / Auth / Notification / Organization), the two belz envs (edi-demo, edi-prod), and the important caveat that demo.expertly.cloud is a shared multi-tenant cloud where this project is one small (mostly-draft) slice. OPT-IN ONLY — load this skill ONLY when the user explicitly invokes /edi or asks to load Employee-Dashboard / Expertly-internal context. Do NOT auto-trigger on incidental "expertly"/"teamwork"/"dashboard" keywords; the user manually selects which project context applies.
---

# EDI — Employee Dashboard Internal (Expertly) Domain Context

Loads enough background on the **Employee Dashboard Internal (EDI)** project that
you can reason about its purpose, AD services, the Teamwork integration, and the
shared-platform services it leans on without re-deriving it. This is **read-only
context** — it carries no workflow, no commands, no rules. Pair it with
`belz-ai` (workflow) and `tw-dev-note` (Dev Note formatting).

For exact step numbers, inputs/outputs, or anything not captured here, run
`belz ad show <uuid> --full --llm --env edi-demo` (or open the method in the AD
UI). **Much of this project lives as drafts, not published chains** (§ Current
state) — when in doubt, the live AD designer is the source of truth, not a static
export.

---

## What EDI is

**EDI ("Employee Dashboard Internal")** is **WebIntensive's own internal
staff-facing dashboard** — an internal tool for employees, not a client product.
It is built **on the Expertly Automation Designer (AD) platform** (the same
low-code platform NSM and YieldSec run on): business logic lives as AD chains,
UIs are Page Designer pages, storage/services are the shared Expertly platform
services.

Its defining integration is **Teamwork** — the company's project-management /
time-tracking tool, self-hosted at **`projects.webintensive.com`**. The dashboard
wraps the Teamwork REST API so employees can see and act on their Teamwork data
(projects, tasks, time, people) from one internal place, alongside internal
documents and other staff tooling.

> **This is dogfooding.** WebIntensive builds the Expertly platform *and* uses it
> to run its own internal employee tooling. So "the project" is a thin slice of
> AD services sitting on top of the same shared platform that hosts everything
> else (§ The shared demo cloud).

---

## Company / platform vocabulary

New to this org? The names overlap confusingly. Keep these straight:

| Term | What it actually is |
|------|---------------------|
| **WebIntensive** | The company. Staff log in as `…@webintensive.com`. |
| **Expertly** | WebIntensive's flagship **low-code automation product** — Automation Designer (AD) + Page Designer (PD), hosted at `*.expertly.cloud` / `*.expertly.com`. |
| **AD (Automation Designer)** | Visual chain/workflow builder. A "method" / "chain" is one workflow; steps call other methods or integration services. |
| **PD (Page Designer)** | Visual UI builder; pages call AD chains. |
| **Teamwork** | Third-party PM tool (teamwork.com), self-hosted at `projects.webintensive.com`. The company's source of truth for projects/tasks/time. |
| **EDI / Employee Dashboard** | *This* project — the internal staff dashboard built on Expertly AD. |

---

## The shared demo cloud (important)

`demo.expertly.cloud` is **not a dedicated EDI environment**. It is the **shared
multi-tenant Expertly dev/QA cloud** — it hosts **~388 AD service categories**
across the whole company: client projects, platform internals (`Expertly.*`),
the `ExpertlyAI.*` product suite, countless `*_Test` / sandbox services, and
this project. **EDI is a small slice of it.**

Practical consequences:
- Don't treat "everything on edi-demo" as part of EDI. Scope to the EDI
  services below (§ AD services).
- The same service name can appear twice with **different UUIDs** in two
  subsystems: the **category** (the folder, from `belz ad categories`) and the
  **services catalog** (the published step-identifier registry, from
  `belz ad services`). The AD UI URL `?service=<uuid>` uses the **services-catalog
  UUID**. Example: *Teamwork API Wrapper* → category UUID
  `40600c8d376e7e04f1febe14f4895757` (id 348) **but** services-catalog UUID
  `45ad5c0ee6ccc23299a1a803f2211927` (the one in the URL the user was given).
  `belz ad export-category <id>` keys off the **category id**.

---

## AD services

### The EDI project's own services

| Service (category) | Cat id | Role | State |
|--------------------|:------:|------|-------|
| **Teamwork API Wrapper** | 348 | **Primary work area.** Wraps the Teamwork REST API (`projects.webintensive.com`) for the dashboard. Services-catalog UUID `45ad5c0e…` is the one in the AD URL the user was pointed at. | Draft-stage — **0 published chains** as of handoff |
| **Employee Dashboard** | 339 | The dashboard's own chains. Currently just `DMS_DocUpload` (uploads/downloads docs via `Expertly.DMS`). | 1 published chain |
| **ProjectManagement.Teamwork** | 436 | Despite the name, its *published* methods are generic **PPTX document utilities** (`processCommand`, `contentWithLocations`, `ProcessCommandTableUpdate`) — slide insert/update/locate. Treat as a shared doc-automation helper, not the dashboard core; confirm before assuming it's Teamwork PM. | 3 published chains |
| **Test Service_TeamworkApi** | 354 | Scratch/test playground for the Teamwork wrapper. | 0 published — do NOT ship from here |
| **Wrapper** | 552 | Generic wrapper scratch service. | 0 published |

> The Teamwork-related work is **draft-heavy**: `belz ad export-category` only
> returns *published* chains, so these folders look near-empty from the CLI even
> though active development is happening in drafts. Read drafts in the AD UI or
> via `belz ad show <draft-uuid>` / `belz ad state <uuid>`.

### Shared Expertly platform services EDI builds on

These are **not** EDI-owned — they're platform services every project uses. The
dashboard calls into them the way NSM/YS chains do (step `categoryName` + `uri`):

| Platform service | Used for |
|------------------|----------|
| `Expertly.DMS` (+ `Expertly.DMS-Legacy`) | Document storage (S3-backed). `file.uploadMultiple` / `file.download` — already used by `Employee Dashboard/DMS_DocUpload`. |
| `Expertly.PortalUser` / `Expertly.User` / `portalUser` | Staff identity / portal users (mirror of the auth records). |
| `Expertly.Auth` | Authentication. |
| `Expertly.Notification` | In-app / email notifications. |
| `Expertly.Organization` | Org structure (teams, hierarchy). |
| `Expertly.Automation.Scheduler` | Scheduled / recurring chains (e.g. periodic Teamwork syncs). |
| `Expertly.Report` | Reporting helpers. |

(`Expertly.*` and `ExpertlyAI.*` are large platform/product families — ignore the
ExpertlyAI suite unless a task specifically touches it.)

---

## Teamwork integration

The heart of the project. Teamwork is **`https://projects.webintensive.com`**
(a self-hosted Teamwork.com instance). Its REST API is the v3 Projects API:
`/projects/api/v3/...` (e.g. `/projects/api/v3/tasks.json`,
`/projects/api/v3/tasks/{id}.json`).

- The **Teamwork API Wrapper** AD service exposes Teamwork endpoints as AD methods
  the dashboard can call (auth, projects, tasks, time, people). This is what the
  user will mostly build/maintain.
- belz already ships first-class Teamwork tooling against the **same** instance —
  `belz tw task|comments|items|search|add-comment` (see `belz tw --help`). Those
  commands wrap the **tasks** surface of the v3 API and are a concrete reference
  for how the company authenticates to and shapes Teamwork data. The company's
  **Dev Notes** (see `tw-dev-note`) are posted as comments on these Teamwork
  tasks — so Teamwork is both a data source for the dashboard *and* the team's
  workflow system of record.
- Teamwork credentials for belz live under `teamwork` in `~/.belz/config.json`
  (managed via `belz config edit`) — never in the repo.

> When a wrapper method misbehaves, first check whether it's a Teamwork-side
> issue (auth/token, rate limit, Teamwork API shape) vs. AD-side mapping. The
> wrapper is a pass-through, so most surprises come from the Teamwork response.

---

## Current state (read this before triaging)

As of this handoff, EDI's **published** footprint on `edi-demo` is small:
`Employee Dashboard` has one chain (`DMS_DocUpload`); `ProjectManagement.Teamwork`
has three generic PPTX utilities; the **Teamwork API Wrapper**, **Test Service_
TeamworkApi**, and **Wrapper** services have **no published chains**. The project
is **early / active-development** — most logic exists as **drafts**.

So: if `belz ad export-category` / `belz ad find` shows almost nothing, that's
expected, **not** a sign the project is empty. The work is in the AD draft
designer. Re-establish ground truth from the live UI (`belz ad show <uuid> --open`)
rather than from any cached/exported snapshot, including this skill.

---

## Environments

| belz env | URL | Role |
|----------|-----|------|
| `edi-demo` | `https://demo.expertly.cloud` | Dev **+** QA (shared Expertly cloud). Primary working env. Creds configured. |
| `edi-prod` | `https://inside.expertly.com` | Production. URL only — **no creds configured** by default; add them with `belz config edit` when prod access is granted. |

Only these two environments exist for EDI (no separate stage/UAT). Credentials
live in `~/.belz/config.json` (managed via `belz config edit`) — never in the
repo. Run `belz envs` to list configured envs; override per command with
`--env edi-demo`.

The AD designer URL the user was given:
`https://demo.expertly.cloud/automation-designer?service=45ad5c0ee6ccc23299a1a803f2211927`
→ the **Teamwork API Wrapper** service.

---

## How to explore (read-only)

```bash
belz ad categories --user --env edi-demo          # all service folders (whole cloud — scope to EDI)
belz ad services --search teamwork --env edi-demo  # services-catalog (URL ?service= UUIDs)
belz ad export-category 348 --env edi-demo --llm   # published chains in a folder (drafts NOT included)
belz ad show <uuid> --full --llm --env edi-demo    # one method's structure
belz ad state <uuid> --llm --env edi-demo          # draft/published linkage for a method
belz tw task <id|url>                              # Teamwork task (same instance the wrapper targets)
```

Building the full `belz ad find` index over this cloud is **slow** (~388
categories) — prefer targeted `export-category` / `show` calls for EDI.

---

## Patterns to remember

- **Scope to EDI, not the cloud.** `demo.expertly.cloud` hosts the whole company.
  The EDI services are the five in § AD services; everything else is someone
  else's project or a platform internal.
- **Category UUID ≠ services-catalog UUID.** The AD URL `?service=` uses the
  services-catalog UUID; `export-category` uses the category id. Same logical
  service, two identifiers.
- **Drafts, not exports, are the truth here.** The project is early-stage; the
  CLI's published view understates it. Read the live AD designer.
- **The wrapper is a pass-through.** Most Teamwork-wrapper bugs originate in the
  Teamwork API response, not the AD chain.
- **Reuse platform services.** Docs → `Expertly.DMS`; users → `Expertly.PortalUser`;
  notifications → `Expertly.Notification`; scheduling → `Expertly.Automation.Scheduler`.
  Don't hand-roll what the platform already provides.
- **Service category cheat sheet** (for `tw-dev-note` classification): EDI changes
  are usually `Teamwork API Wrapper` or `Employee Dashboard`; confirm a method's
  category with `belz ad show <uuid> --llm` if unsure.
