---
name: nsm
description: Domain context for the NSM project (NC DMV "Notice and Storage Management") — what the platform does, who uses it, the LT-260/261/262/262A/263/264/265 form lifecycle, status values, the AD services + external integrations (STARS/EStop, fanned-out VIN lookups, Nordis print/mail SFTP, ACH SFTP, PayIt, SharePoint), key AD chain IDs, DB tables touched per phase, and the case-number S→N flip. OPT-IN ONLY — load this skill ONLY when the user explicitly invokes /nsm or asks to load NSM context. Do NOT auto-trigger on incidental NSM keywords; the user manually selects which project context applies to the current task.
---

# NSM Domain Context

Loads enough background on the NSM project that you can reason about LT-26x
forms, status transitions, AD services, integrations, and chain behavior without
re-reading source docs. This is **read-only context** — it carries no workflow,
no commands, no rules. Pair it with `belz-ai` (workflow) and `tw-dev-note`
(Dev Note formatting).

If you need exact step numbers, full input/output shapes, or edge cases beyond
what's here, run `belz ad show <chain-id> --full --llm`.

---

## What NSM is

**NSM = "Notice and Storage Management"** for the **NC Division of Motor Vehicles
(DMV)**. It manages **abandoned / stored / mechanic-lien vehicle workflows** in
North Carolina, and is the successor to a legacy mainframe system (**NSS**) that
is being decommissioned.

When a vehicle is towed and stored — by a tow operator, garage, body shop, or
impound lot — NC law requires the storage facility to file paperwork notifying
the registered owner and lienholder, and (if unclaimed) eventually obtain
authority to sell the vehicle to recover storage fees. NSM runs that whole
paperwork lifecycle. The forms are real legal documents codified in NC statute:

| Form | What it is |
|------|------------|
| **LT-260** | Initial notice of stored vehicle — kicks off the case. |
| **LT-261** | Standalone path (also the LT-265 reprint path). |
| **LT-262** | Mechanic's lien / formal application (regular vehicles). |
| **LT-262A** | Variant for **manufactured / mobile homes**. |
| **LT-263** | Notice of sale — issued and then submitted with sale details. |
| **LT-264 / 264A / 264B / 264G** | Owner notification + court hearing notices. |
| **LT-265 / LT-265A** | Final vehicle-sold documents (terminal state). |

Each form letter is generated as a PDF, mailed/emailed (via Nordis), and recorded
against an "application" (the case file).

**Implementation fact:** NSM is built **entirely on the Expertly Automation
Designer (AD) platform** — business logic lives as published AD chains organized
into services (§5); UIs are Expertly Page Designer pages that call those chains;
storage is PostgreSQL (46 tables). There is no separate hand-rolled backend repo.

---

## Who uses it

Two user classes:

- **Public** — towing operators, garages, body shops filing on behalf of their
  business (the public portal).
- **Staff** — DMV employees who review, approve, issue, file paper logs, and run
  manual actions (the staff portal).

Status transitions and validation rules differ between the two. Many chains
branch on conditions like `loggedBy != null` (staff paper logging) or the
requestor's user type. When debugging a state transition, always check whether
you're on the public path or the staff path.

---

## Core domain objects

An **application** is one case (one stored vehicle). It has a case number, a
status, owner details, per-form data, a timeline, documents, and emails.

### Core PostgreSQL tables (the ones you'll touch first)

| Table | Role |
|-------|------|
| `application` | Master record — status, ownership, FK to form details. |
| `application_form_details` | All form-level data (VIN, year, make, body, firm details JSONB, sale info, **case_number**). |
| `application_timeline` | Audit trail; one row per status transition. |
| `application_documents` | Generated letters (LT-260A, LT-262, LT-264, LT-265, …). |
| `application_owner_details` | Owners / lienholders / lessees (JSONB arrays). |
| `case_number_sequence` | Backing sequence for case numbers (see below). |
| `application_cart`, `application_cart_items`, `transaction` | LT-262 payment flow. |
| `scanned_documents_correspondence` | Metadata for SharePoint-stored scanned paper docs (NOT `application_documents`). |
| `users`, `business` | Filers and their organizations. |

Full schema is 46 tables. `application_emails` holds sent notifications.

### Case number S→N flip
Assigned at LT-260 submit when status becomes `SUBMITTED`, as
`S<YY>-1<6-digit-seq>` (e.g. `S26-1102305`). After the PayIt cart payment
completes, the helper chain **`_paymentsAndApplicationFallback`** rewrites the
prefix from `S` to `N` (e.g. `S26-1102305` → `N26-1102305`) as the post-payment
marker. The digits never change; only the leading letter flips, once. If a case
is still on `S-` after LT-262 payment, payment hasn't completed.

---

## Status values

| Status | Set By | Condition |
|--------|--------|-----------|
| `SUBMITTED` | LT260.submit input | Application submitted (not draft) |
| `DRAFT` | LT260.submit input | Saved as draft |
| `Stolen` | LT260.issue (chain 1563, step 6) | `form == 'LT260D'` — **terminal** |
| `LT-260 Processed` | LT260.issue (chain 1563, step 6) | `form != 'LT260D'` |
| `Mailed Payment` | LT262.submit (chain 1524, step 11) | Staff paper logging (`loggedBy != null`) |
| `LT-262 Draft` / `LT-262 Paper Draft` | LT262.submit (chain 1524, step 12) | Drafts |
| `LT-262 Submitted` | `_paymentsAndApplicationFallback` | After PayIt payment completes |
| `LT-262A Submitted` | LT262A.submit (chain 2095, step 6) | Submitted |
| `LT-262A Draft` / `LT-262A Paper Draft` | LT262A.submit (chain 2095, step 7) | Drafts |
| `LT-262 Processed` | LT263.issue (chain 1569, step 5) | `generateType == 'ISSUE'` |
| `LT-261 Submitted` | forms.LT261.submit (chain 2030) | isStolen input + form type LT-261 |
| `Vehicle Sold` | LT265andLT265A.issue (chain 1586, step 3) | `generateType == 'ISSUE'` — **terminal** |

---

## Lifecycle paths

Knowing which path applies to a case is the single most useful piece of context
for triaging a bug.

```
Path 1 — regular vehicle, owner found:
  SUBMITTED → LT-260 Processed → LT-262 Submitted
    → (LT-264 issued → LT-264A/B if court hearing)
    → LT-262 Processed → LT-263 Submitted → Vehicle Sold   ← TERMINAL

Path 2 — regular vehicle, owner NOT found:
  SUBMITTED → LT-260 Processed → LT-262 Submitted
    → (LT-262B issued) → LT-262 Processed → LT-263 Submitted → Vehicle Sold

Path 3 — manufactured home:
  SUBMITTED → LT-260 Processed → LT-262A Submitted → Vehicle Sold

Path 4 — stolen vehicle:
  SUBMITTED → Stolen   ← TERMINAL

Path 5 — LT-261 standalone:
  LT-261 Submitted → Stolen | Vehicle Sold
```

---

## AD services

Every AD method belongs to a "service" (category). NSM-owned services in dev,
all `USER_GENERATED`:

### Domain
| Service | Purpose |
|---------|---------|
| `NSM.Public` | Public-portal chains (LT-260 submit, lookup, draft save, …) |
| `NSM.Staff` | Internal staff workflows (review, approve, issue, manual actions) |
| `NSM.PublicAPI` | Public-facing API endpoints (external integrators) |
| `NSM.Documents` | Document generation & PDF assembly |
| `NSM.Templates` | Letter / document templates |
| `NSM.FPA` | Form Processing & Approvals helpers |

### Helpers
| Service | Purpose |
|---------|---------|
| `NSM.Helpers` | Shared utilities (validation, formatting, mapping, **VIN-lookup orchestration**) |
| `NSM-Helpers` | Legacy hyphenated helpers (kept for chains that still reference it) |

### Reporting
| Service | Purpose |
|---------|---------|
| `NSM.Reporting` | Internal reports and dashboards |
| `NSM.Public.Reports` | Public-facing reports |

### Staff portal subsystems
| Service | Purpose |
|---------|---------|
| `NSM.Staff.Dashboard` | Staff home dashboard widgets and queries |
| `NSM.Staff.ACM` | Access control / role management for staff |
| `NSM.Staff.SharePoint` | SharePoint integration for scanned docs |

### External integrations (transport in §6)
| Service | Purpose | Transport |
|---------|---------|-----------|
| `NSM.Integrations.STARS` | DMV STARS — **EStop submission only** | HTTPS over DMV VPN |
| `NSM.SFTP.Nordis` | Nordis print-and-mail vendor | SFTP |
| `NSM.SFTP.ACH` | Bank ACH file exchange for payments | SFTP |

### Misc
| Service | Purpose |
|---------|---------|
| `NSM.Test_1` | Scratch / test playground — do NOT publish production methods here |

---

## External integrations — important details

The things most likely to break and most likely to surprise a new developer.

### STARS / VIN lookup (DMV)
- **`NSM.Integrations.STARS` is EStop ONLY** — one method, `AsendApplicationToEstop`.
  EStop flags the vehicle as sold/destroyed in the DMV system at the end of the
  lifecycle. Do NOT look here for VIN lookups.
- **VIN lookups are fanned out across multiple providers** (DCIN, NMVITS,
  VINtelligence, STARS) via `NSM.Helpers`:
  - `vin.lookup` (`NSM.Public`) — public entry point
  - `triggerVinChecks` (`NSM.Helpers`) — orchestrator
  - `STARS.lookup`, `_lookupDCIN`, `_lookupNMVITS`, `_lookupVINtelligence`
    (`NSM.Helpers`) — one per provider
- **Transport:** HTTPS, but DMV-side providers (STARS especially) are only
  reachable from inside the **DMV VPN**. The AD environment runs with the tunnel
  up; local dev machines do not — so these calls can't be exercised from a laptop
  without going through the dev server.
- **Failure mode:** VPN down → DMV providers time out (stuck "VIN lookup" /
  "EStop submit" entries in `application_timeline`). Non-DMV providers (NMVITS,
  VINtelligence) keep working.

### Nordis (print + mail)
- **Service:** `NSM.SFTP.Nordis`. **Transport:** SFTP. NSM writes generated PDF
  letter batches to an outbound folder; Nordis prints, mails, and writes
  acknowledgements back to an inbound folder.
- **Key flow:** `batchFile.create` → `batchFile.upload` → (Nordis) →
  `nordisNCOA.download` → `NCOAReport.process` (NCOA = National Change of Address
  address-correction feedback).
- **Failure mode:** SFTP credential rotation, folder permissions, or zip-naming
  mismatches make batches silently pile up. `_zipFilesAndUpdateIndexLogs` is the
  canonical packaging step — start debugging there.

### ACH (payments)
- **Service:** `NSM.SFTP.ACH`. **Transport:** SFTP to the bank.
- **Key flows:** `ACHFile.createAndSendToSFTP` (outbound debit/credit) and
  `AckAndRIPFromSFTP.download` + `ACH.RIPFile.process` +
  `ACHFile.processAcknowledgements` (inbound bank acks + Return/Rejection files).
- **Failure mode:** ACH files are time-sensitive; missed acks need re-ingesting
  by re-running the download chain.

### PayIt (in-app payments)
- **Not its own AD service** — invoked inline from `NSM.Public` / `NSM.Staff`
  during LT-262 submission. Creates `application_cart` + `application_cart_items`
  + `transaction` rows.
- After payment, **`_paymentsAndApplicationFallback`** does the state transition
  in one SQL CTE: flips `application.status` `Payment Pending` → `LT-262 Submitted`,
  rewrites the case number `S…` → `N…`, and inserts the matching timeline row.
  That's where to look when a payment "completed but the case didn't move".

### SharePoint (scanned documents)
- **Service:** `NSM.Staff.SharePoint`. Staff attach scanned paper docs (incoming
  mail, court orders) to a case. The binaries live in SharePoint; **metadata rows
  go to `scanned_documents_correspondence`** (NOT `application_documents`) via
  `scannedCorrespondence.add` / `.get` / `.remove`. The helper
  `_latestDocument.update` separately *updates* `application_documents.location_id`
  + `name` so the case's primary paper-form row points at the latest scan — the
  only link between the two tables.

### Also
- **DMS** — document management system where generated PDFs are uploaded.
- **ElasticSearch** — search index, upserted on status changes.

---

## Key AD chain IDs

When the user says "chain 1521", know which method that is. Reverse lookup:

| Chain ID | Method | Steps | Role |
|----------|--------|-------|------|
| 1521 | `LT260.submit` | 37 | Submission entry point. Step 37 triggers auto-issue. |
| 1563 | `LT260.issue` | 22 | Generates LT260A/B/C/D. Step 6 flips to "Stolen" / "LT-260 Processed". |
| 1943 | `160BAnd260Aform.autoIssue` | 12 | Auto-issues LT260. Calls `LT260.issue` at step 9; step 11 marks timeline auto-issued (`created_by = -1`). |
| 1524 | `LT262.submit` | 26 | LT-262 application + payment cart. |
| 2095 | `LT262A.submit` | 21 | Manufactured-home variant of LT-262. |
| 1619 | `LT264.issue` | 25 | Aging notice to owners (LT-264 + LT-264G). |
| 1796 | `LT264AB.issue` | 23 | Court hearing notices (LT-264A + LT-264B). |
| 1569 | `LT263.issue` | 13 | Sale notice issuance. Step 5 flips to "LT-262 Processed". |
| 1568 | `LT263.submit` | 19 | Requestor fills sale details (buyer info). |
| 1586 | `LT265andLT265A.issue` | 23 | Vehicle-sold notices + EStop API call (step 22). |
| 2030 | `forms.LT261.submit` | 12 | Standalone LT-261 path. |

Chain IDs are environment-local; confirm a method name with `belz ad show` on
first encounter if anything looks off.

---

## Tables written per phase

Useful when predicting DB impact of a proposed change.

**LT-260 Submission:** `application_form_details` (ins/upd), `application`
(status=SUBMITTED), `case_number_sequence` (gen `S…`), `application_owner_details`,
`application_documents` (LT260_SUBMISSION_COPY + VIN image), `application_timeline`,
`application_emails`.

**LT-260 Auto-Issue / Processing:** `application_owner_details` (VIN results,
is_auto_issued), `application` (status="Stolen" | "LT-260 Processed"),
`application_timeline`, `application_documents` (LT260D | LT260C | LT260A+LT160B).

**LT-262 Submission (+ payment):** `application_form_details` (LT-262 fields),
`application_cart` + `application_cart_items` + `transaction`, then
`_paymentsAndApplicationFallback` → `application` (status="LT-262 Submitted"),
`application_form_details.case_number` (`S…`→`N…`), `application_documents`
(LT262_SUBMISSION_COPY), `application_timeline`.

**LT-264 / 264A/B Issuance:** `application_documents` (LT264→owners, LT264G→requestor;
LT264A/B court hearing), `application_timeline`, `application_owner_details`.

**LT-263 Issue + Submit:** `application` (status="LT-262 Processed"),
`application_form_details` (sale/buyer details), `application_documents`
(LT263_SUBMISSION_COPY), `application_timeline`, `application_emails`.

**LT-265 Issuance:** `application` (status="Vehicle Sold"), `application_documents`
(LT265, LT265A), `application_timeline`, EStop API call (external).

---

## Documents generated

| Document | Generated By | Recipient | When |
|----------|-------------|-----------|------|
| `LT260_SUBMISSION_COPY` | LT260.submit (step 27) | Requestor | On submission |
| `LT260A` | LT260.issue (step 4) | Owners | Not stolen, owner found |
| `LT160B` | LT260.issue (step 4) | Requestor | Not stolen, owner found |
| `LT260C` | LT260.issue (step 4) | Requestor | Not stolen, owner NOT found |
| `LT260D` | LT260.issue (step 4) | Requestor | Stolen vehicle |
| `LT262_SUBMISSION_COPY` | LT262.submit (step 16) | Requestor | On LT-262 submission |
| `LT262_PAPER_FORM` | LT262.submit (step 18) | — | Staff paper logging |
| `LT262_SUPPORTING_DOCUMENT` | LT262.submit (step 14) | — | Supporting docs |
| `LT-262A_SUBMISSION_DOCUMENT` | LT262A.submit (step 11) | Requestor | On LT-262A submission |
| `LT262B` | LT264.issue (step 17) | Requestor | Owner not found, aging notice |
| `LT264` | LT264.issue (step 9) | Owners | Aging / certified mail |
| `LT264G` | LT264.issue (step 10) | Requestor | Garage copy |
| `LT264A` | LT264AB.issue (step 7) | — | Court hearing notice |
| `LT264B` | LT264AB.issue (step 8) | — | Court hearing notice |
| `LT263` | LT263.issue (step 2) | Requestor | Sale notice |
| `LT263_SUBMISSION_COPY` | LT263.submit (step 7) | Requestor | On LT-263 submission |
| `LT261_SUBMISSION_COPY` | forms.LT261.submit (step 9) | Requestor | On LT-261 submission |
| `LT265` | LT265andLT265A.issue (step 4–6) | Requestor | Vehicle sold |
| `LT265A` | LT265andLT265A.issue (step 10) | Owners/lienholders | Vehicle sold |

---

## Patterns to remember

### Validation gate pattern
Many chains (especially `LT260.submit` steps 3–9) collect ALL errors then throw
once, instead of failing on the first. When debugging a validation error, check
the gate step for the **full set of conditions** — the user's reported error may
be one of several being collected.

### Auto-issue marker
When `160BAnd260Aform.autoIssue` runs, it sets `application_timeline.created_by = -1`.
That `-1` is the marker for "auto-issued, not human-issued" — useful for filtering
reports.

### Payment completed but case didn't move
The status flip AND the `S…`→`N…` case-number flip both live in
`_paymentsAndApplicationFallback`. If a payment completed but the case is stuck,
that one chain is where to look.

### Terminal states
`Stolen` and `Vehicle Sold` are terminal — no further chains run.

---

## Service category cheat sheet

Used for Dev Note classification (`tw-dev-note` skill) — the category is required
when making an AD change. Heuristic: the prefix tells you a lot
(`forms.LT261.submit` → `NSM.Public`; `LT262.archive` → `NSM.Staff`). Confirm with
`belz ad show <uuid> --llm` if in doubt.

| Category | What's in it |
|----------|--------------|
| `NSM.Public` / `NSM.PublicAPI` | Public-facing chains + external API endpoints |
| `NSM.Staff` (+ `.Dashboard`, `.ACM`, `.SharePoint`) | Staff-only workflows |
| `NSM.Documents` / `NSM.Templates` | Document generation + templates |
| `NSM.Helpers` / `NSM-Helpers` / `NSM.FPA` | Shared utilities + form processing |
| `NSM.Reporting` / `NSM.Public.Reports` | Reports |
| `NSM.Integrations.STARS` / `NSM.SFTP.Nordis` / `NSM.SFTP.ACH` | External integrations |

---

## Environments

| Environment | Staff portal URL |
|-------------|------------------|
| `nsm-dev` | `https://nsm-dev.nc.verifi.dev` (default / primary working env) |
| `nsm-qa` | `https://nsm-qa.nc.verifi.dev` |
| `nsm-uat` | `https://nsm-uat.nc.verifi.dev` |
| `nsm-stage` | `https://staff-nss-stage.verifi-nc.com` |
| `nsm-prod` | `https://staff-nss.verifi-nc.com` |

Credentials live in `~/.belz/config.json` (managed via `belz config edit`) —
never in the repo. Run `belz envs` to see the configured envs; override per
command with `--env <name>`.
