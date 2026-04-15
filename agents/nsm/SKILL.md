---
name: nsm
description: Domain context for the NSM project (NCDOT Notice and Storage Management) — what the platform does, who uses it, the LT-260/261/262/262A/263/264/265 form lifecycle, status values, key AD chain IDs, DB tables touched per phase, and external integrations. OPT-IN ONLY — load this skill ONLY when the user explicitly invokes /nsm or asks to load NSM context. Do NOT auto-trigger on incidental NSM keywords; the user manually selects which project context applies to the current task.
---

# NSM Domain Context

Loads enough background on the NSM project that you can reason about LT-26x forms, status transitions, and AD chain behavior without re-reading source docs. This is **read-only context** — it carries no workflow, no commands, no rules. Pair it with `belz-task` (workflow) and `tw-dev-note` (Dev Note formatting).

If you need exact step numbers, full input/output shapes, or edge cases beyond what's here, read `systemWorkflow.md` at the repo root or run `belz ad show <chain-id> --full --llm`.

---

## What NSM is

**NSM = "Notice and Storage Management"** for the **North Carolina Department of Transportation (NCDOT)**.

When a vehicle is towed and stored — by a tow operator, garage, body shop, or impound lot — North Carolina law requires the storage facility to file paperwork notifying the registered owner and lienholder, and (if the owner doesn't reclaim it) eventually obtain authority to sell the vehicle to recover storage fees.

NSM is the web platform that runs that whole paperwork lifecycle. The forms are real legal documents codified in NC statute:

| Form | What it is |
|------|------------|
| **LT-260** | Initial notice of intent to file. Submitted first. |
| **LT-261** | Standalone path for stolen vehicles. |
| **LT-262** | Formal application (regular vehicles). |
| **LT-262A** | Formal application variant for **manufactured homes**. |
| **LT-263** | Sale notice — issued and then submitted with sale details. |
| **LT-264 / LT-264A / LT-264B** | Aging notices and court hearing forms. |
| **LT-265 / LT-265A** | Vehicle-sold notices to requestor / owners. |

Each form letter is generated as a PDF, mailed/emailed, and recorded against an "application" (the case file).

---

## Who uses it

Two user classes:

- **Public** — towing operators, garages, body shops filing on behalf of their business.
- **Staff** — NCDOT employees who can file paper logs, override, and process cases.

Status transitions and validation rules differ between the two. Many AD chains branch on conditions like `loggedBy != null` (staff paper logging) or check the requestor's user type. When debugging a state transition, always check whether you're looking at the public path or the staff path.

---

## Core domain objects

An **application** is one case (one stored vehicle). It has:

- **Case number** — `S-XXXXXX` while in submission, flips to `N-XXXXXX` after payment completes
- **Status** — see status table below
- **Owner details** — registered owners, lienholders, lessees from the STARS VIN lookup
- **Form details** — per-form field data (one row per form type)
- **Timeline** — audit trail of every state change
- **Documents** — generated PDFs
- **Emails** — sent notifications

The DB tables map 1:1 onto those concepts:

```
application                  one row per case
application_form_details     per-form field data
application_owner_details    owners / lienholders / lessees
application_timeline         audit trail
application_documents        generated PDFs
application_emails           sent notifications
application_cart             payment cart
application_cart_items       cart line items
transaction                  payment records
case_number_sequence         S-XXXXXX / N-XXXXXX generator
```

---

## External integrations

| System | Role |
|--------|------|
| **STARS** (`apiId=1736`) | NC DMV's VIN/registration lookup. Called early in `LT260.submit` to resolve owners/lienholders. |
| **EStop API** | Called at the very end of the LT-265 chain to notify DMV that a vehicle has been sold so it stops appearing in registration. |
| **DMS** | Document management system where generated PDFs are uploaded. |
| **ElasticSearch** | Search index, upserted on every status change. |
| **Payment cart** | Public users pay through an integrated cart. The case number flips from `S-` to `N-` only after `transaction.complete`. |

---

## Status values

Every status the system writes:

| Status | Set By | Condition |
|--------|--------|-----------|
| `SUBMITTED` | LT260.submit input | Application submitted (not draft) |
| `DRAFT` | LT260.submit input | Saved as draft |
| `Stolen` | LT260.issue (chain 1563, step 6) | `form == 'LT260D'` |
| `LT-260 Processed` | LT260.issue (chain 1563, step 6) | `form != 'LT260D'` |
| `Mailed Payment` | LT262.submit (chain 1524, step 11) | Staff paper logging (`loggedBy != null`) |
| `LT-262 Draft` | LT262.submit (chain 1524, step 12) | Digital draft |
| `LT-262 Paper Draft` | LT262.submit (chain 1524, step 12) | Staff paper draft |
| `LT-262A Submitted` | LT262A.submit (chain 2095, step 6) | Submitted |
| `LT-262A Draft` / `LT-262A Paper Draft` | LT262A.submit (chain 2095, step 7) | Draft |
| `LT-262 Processed` | LT263.issue (chain 1569, step 5) | `generateType == 'ISSUE'` |
| `LT-261 Submitted` | forms.LT261.submit (chain 2030) | isStolen input + form type LT-261 |
| `Vehicle Sold` | LT265andLT265A.issue (chain 1586, step 3) | `generateType == 'ISSUE'` |

---

## The five lifecycle paths

Knowing which path applies to a case is the single most useful piece of context for triaging a bug.

**Path 1 — LT-260, regular vehicle, owner found:**
```
SUBMITTED → LT-260 Processed → LT-262 Submitted
  → (LT-264 issued, LT-264A/B issued)
  → LT-262 Processed → LT-263 Submitted → Vehicle Sold
```

**Path 2 — LT-260, regular vehicle, owner NOT found:**
```
SUBMITTED → LT-260 Processed → LT-262 Submitted
  → (LT-262B issued)
  → LT-262 Processed → LT-263 Submitted → Vehicle Sold
```

**Path 3 — LT-260, manufactured home:**
```
SUBMITTED → LT-260 Processed → LT-262A Submitted → Vehicle Sold
```

**Path 4 — LT-260, stolen vehicle (terminal):**
```
SUBMITTED → Stolen
```

**Path 5 — LT-261 standalone:**
```
LT-261 Submitted → Stolen  OR  Vehicle Sold
```

---

## Key AD chain IDs

When the user says "chain 1521", you should immediately know which method that is. Reverse lookup:

| Chain ID | Method | Steps | Role |
|----------|--------|-------|------|
| 1521 | `LT260.submit` | 37 | Submission entry point. Step 37 triggers auto-issue. |
| 1563 | `LT260.issue` | 22 | Generates LT260A/B/C/D documents. Step 6 flips status to "Stolen" or "LT-260 Processed". |
| 1943 | `160BAnd260Aform.autoIssue` | 12 | Auto-issues LT260 when conditions met. Calls `LT260.issue` at step 9. Step 11 marks timeline as auto-issued (`created_by = -1`). |
| 1524 | `LT262.submit` | 26 | LT-262 application + payment cart. |
| 2095 | `LT262A.submit` | 21 | Manufactured home variant of LT-262. |
| 1619 | `LT264.issue` | 25 | Aging notice to owners (LT-264 + LT-264G). |
| 1796 | `LT264AB.issue` | 23 | Court hearing notices (LT-264A + LT-264B). |
| 1569 | `LT263.issue` | 13 | Sale notice issuance. Step 5 flips status to "LT-262 Processed". |
| 1568 | `LT263.submit` | 19 | Requestor fills in sale details (buyer info). |
| 1586 | `LT265andLT265A.issue` | 23 | Vehicle-sold notices + EStop API call (step 22). |
| 2030 | `forms.LT261.submit` | 12 | Standalone LT-261 path. |
| 6205 | *(in source list — confirm method name with `belz ad show` on first encounter)* | — | — |

---

## Tables written per phase

Useful when predicting DB impact of a proposed change.

**Phase: LT-260 Submission**
```
application_form_details    INSERT/UPDATE
application                 INSERT/UPDATE (status = SUBMITTED)
case_number_sequence        INSERT (generate S-XXXXXX)
application_owner_details   INSERT (owners, lienholders, lessees)
application_documents       INSERT (LT260_SUBMISSION_COPY, VIN image, supporting docs)
application_timeline        INSERT ("LT-260 Submitted")
application_emails          INSERT (requestor notification)
```

**Phase: LT-260 Auto-Issue / Processing**
```
application_owner_details   UPDATE (is_auto_issued = true, VIN check results)
application                 UPDATE (status = "Stolen" | "LT-260 Processed")
application_timeline        INSERT
application_documents       INSERT (LT260D | LT260C | LT260A + LT160B)
```

**Phase: LT-262 Submission**
```
application_form_details    UPDATE (LT-262 fields)
application                 UPDATE (status = "LT-262 Submitted" after payment)
application_cart            INSERT
application_cart_items      INSERT
transaction                 INSERT (payment)
application_documents       INSERT (LT262_SUBMISSION_COPY)
application_timeline        INSERT ("LT-262 Submitted")
case_number_sequence        UPDATE (S → N prefix)
```

**Phase: LT-264 / LT-264A/B Issuance**
```
application_documents       INSERT (LT264 to owners, LT264G to requestor)
application_documents       INSERT (LT264A, LT264B - court hearing)
application_timeline        INSERT
application_owner_details   UPDATE (checked_requestors for hearing)
```

**Phase: LT-263 Issue + Submit**
```
application                 UPDATE (status = "LT-262 Processed")
application_form_details    UPDATE (sale details, buyer info)
application_documents       INSERT (LT263_SUBMISSION_COPY)
application_timeline        INSERT ("LT-263 Submitted")
application_emails          INSERT
```

**Phase: LT-265 Issuance**
```
application                 UPDATE (status = "Vehicle Sold")
application_documents       INSERT (LT265, LT265A)
application_timeline        INSERT ("Vehicle Sold")
EStop API call              (external)
```

---

## Documents generated

Maps each document type to where it's created and who gets it.

| Document | Generated By | Recipient | When |
|----------|-------------|-----------|------|
| `LT260_SUBMISSION_COPY` | LT260.submit (step 27) | Requestor | On submission |
| `LT260A` | LT260.issue (step 4) | Owners | Not stolen, owner found |
| `LT260C` | LT260.issue (step 4) | Requestor | Not stolen, owner NOT found |
| `LT260D` | LT260.issue (step 4) | Requestor | Stolen vehicle |
| `LT160B` | LT260.issue (step 4) | Requestor | Not stolen, owner found |
| `LT262_SUBMISSION_COPY` | LT262.submit (step 16) | Requestor | On LT-262 submission |
| `LT262_PAPER_FORM` | LT262.submit (step 18) | — | Staff paper logging |
| `LT262_SUPPORTING_DOCUMENT` | LT262.submit (step 14) | — | Supporting docs |
| `LT-262A_SUBMISSION_DOCUMENT` | LT262A.submit (step 11) | Requestor | On LT-262A submission |
| `LT262B` | LT264.issue (step 17) | Requestor | Owner found, aging notice |
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

Many chains (especially `LT260.submit` steps 3–9) follow a "collect all errors, then throw once" pattern instead of failing on the first error. When debugging a validation error, check the gate step for the **full set of conditions**, not just the one the user hit. The user's reported error may be one of several being collected.

### Auto-issue marker

When `160BAnd260Aform.autoIssue` runs, step 11 sets `application_timeline.created_by = -1`. That `-1` is the marker for "auto-issued, not human-issued" — useful for filtering reports.

### Case number flip

The case number transitions from `S-XXXXXX` (submission) to `N-XXXXXX` (notice) only after `transaction.complete` fires. If you see a case still on `S-` after LT-262 submission, payment hasn't gone through.

### Stolen is terminal

The `Stolen` status is terminal — no further chains run. If a case lands there it's done.

---

## Service category cheat sheet

Used for Dev Note classification (`tw-dev-note` skill). When making an AD change, the category is required.

| Category | What's in it |
|----------|--------------|
| `NSM.Staff` | Staff-only methods |
| `NSM.Public` | Public-facing methods (tow operators, etc.) |
| `NSM.Helpers` | Shared utilities |
| `NSM.Reporting` | Reports, exports |
| `NSM.Templates` | Email and PDF templates |

Heuristic: prefix tells you a lot. `forms.LT261.submit` → `NSM.Public`. `LT262.archive` → `NSM.Staff`. Confirm with `belz ad show <uuid> --llm` if there's any doubt.

---

## Environments

| Environment | URL |
|-------------|-----|
| `nsm-dev` | `https://nsm-dev.nc.verifi.dev` (default) |
| `nsm-qa` | `https://nsm-qa.nc.verifi.dev` |
| `nsm-uat` | `https://nsm-uat.nc.verifi.dev` |

Pass `--env nsm-qa` (etc.) on any `belz` command to target a specific environment. Method UUIDs are environment-specific — a chain ID from dev does **not** point to the same method on QA. Use `belz migrate` to promote between environments.
