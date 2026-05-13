# NSM System Workflow — End-to-End Application Lifecycle

Verified against the actual AD chain implementations (chains 1521, 1563, 1943, 1524, 1568, 1569, 2095, 2030, 1586, 1619, 1796, 6205).

---

## Status Values (from actual chains)

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

## Flow Diagram: Full Application Lifecycle

```
                            ┌─────────────────────┐
                            │  USER SUBMITS LT-260 │
                            │   (Public or Staff)  │
                            └──────────┬──────────┘
                                       │
                    ┌──────────────────────────────────────┐
                    │  LT260.submit  (chain 1521, 37 steps)│
                    │                                      │
                    │  1. Duplicate VIN check (apiId=1991) │
                    │  2. VIN lookup via STARS (apiId=1736) │
                    │  3-9. Validation gate (collect ALL    │
                    │       errors, throw once)             │
                    │  10-11. Field validation              │
                    │     (staff vs public rules)           │
                    │  14. Register user/business if needed │
                    │  15. Generate case number (S-XXXXXX)  │
                    │  16-17. INSERT/UPDATE form_details    │
                    │         + application                 │
                    │  18. Save owner/lienholder details    │
                    │  22-23. Handle supporting documents   │
                    │  24. INSERT application_timeline      │
                    │      ("LT-260 Submitted")             │
                    │  25. ElasticSearch upsert             │
                    │  26-29. Generate submission copy doc  │
                    │  30-34. Email requestor               │
                    │  35-36. Message Center notification   │
                    │  37. AUTO-ISSUE trigger ──────────────┼──┐
                    └──────────────────────────────────────┘  │
                                                              │
                    ┌─────────────────────────────────────────┘
                    │
                    ▼
    ┌──────────────────────────────────────────┐
    │ 160BAnd260Aform.autoIssue                │
    │ (chain 1943, 12 steps)                   │
    │                                          │
    │ 1. Get business/individual details       │
    │ 4. Trigger VIN checks → get owner details│
    │ 8. Update application_owner_details      │
    │    SET is_auto_issued = true             │
    │ 9. Call LT260.issue ─────────────────────┼──┐
    │ 11. Update timeline created_by to -1     │  │
    │     (marks as auto-issued)               │  │
    └──────────────────────────────────────────┘  │
                                                   │
              ┌────────────────────────────────────┘
              │
              ▼
    ┌──────────────────────────────────────────┐
    │ LT260.issue  (chain 1563, 22 steps)      │
    │                                          │
    │ 1. Extract application data              │
    │ 3. Update application_timeline           │
    │ 4. Generate correspondence documents:    │
    │    ┌──────────────────────────────────┐   │
    │    │ IF is_stolen = true              │   │
    │    │   → form = "LT260D"             │   │
    │    │   → doc for requestor           │   │
    │    │                                 │   │
    │    │ IF NOT stolen, owner NOT found   │   │
    │    │   → form = "LT260C"             │   │
    │    │   → doc for requestor           │   │
    │    │                                 │   │
    │    │ IF NOT stolen, owner found       │   │
    │    │   → form = "LT260A" (to owners) │   │
    │    │   → form = "LT160B" (to reqstr) │   │
    │    └──────────────────────────────────┘   │
    │ 6. UPDATE application SET status =       │
    │    IF form=='LT260D' → 'Stolen'          │
    │    ELSE → 'LT-260 Processed'             │
    │ 10-18. Generate PDFs, email, notify      │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────┐
    │ Status = "Stolen" ?      │
    │                          │
    │  YES ──→ CASE ENDS       │
    │          (terminal)      │
    │                          │
    │  NO ──→ Continue ────────┼──┐
    └──────────────────────────┘  │
                                   │
              ┌────────────────────┘
              │
              ▼
    ┌──────────────────────────────┐
    │ Body Type check              │
    │                              │
    │ == "Manufactured Homes" ─────┼──→ [Path A: LT-262A]
    │                              │
    │ != "Manufactured Homes" ─────┼──→ [Path B: LT-262]
    └──────────────────────────────┘


═══════════════════════════════════════════════════
  PATH A: Manufactured Homes (LT-262A → LT-265)
═══════════════════════════════════════════════════

    ┌──────────────────────────────────────────┐
    │ LT262A.submit (chain 2095, 21 steps)     │
    │                                          │
    │ 1. Field validation                      │
    │ 5. UPDATE application_form_details       │
    │ 6. UPDATE status → "LT-262A Submitted"   │
    │    (or "LT-262A Draft" / "Paper Draft")  │
    │ 8. Deactivate deleted docs               │
    │ 9. Save supporting documents             │
    │ 11. Generate submission copy             │
    │ 14-20. Email, notifications              │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │ LT265andLT265A.issue                     │
    │ (chain 1586, 23 steps)                   │
    │                                          │
    │ 3. UPDATE status → "Vehicle Sold"        │
    │ 4-6. Generate LT-265 document            │
    │ 9-11. Generate LT-265A for               │
    │       owners/lienholders/lessees         │
    │ 15-21. Email, notifications              │
    │ 22. Send EStop API call                  │
    └──────────┬───────────────────────────────┘
               │
               ▼
          CASE CLOSED
      (status = "Vehicle Sold")


═══════════════════════════════════════════════════
  PATH B: Regular Vehicle (LT-262 → LT-264 →
          LT-263 → LT-265)
═══════════════════════════════════════════════════

    ┌──────────────────────────────────────────┐
    │ LT262.submit (chain 1524, 26 steps)      │
    │                                          │
    │ 1. Fetch application status              │
    │ 2. Duplicate VIN check                   │
    │ 4-5. Field validation                    │
    │ 6-7. Check document prerequisites        │
    │ 8. UPDATE application_form_details       │
    │ 9. Generate cart config lookup            │
    │ 10. Add to payment cart                  │
    │     (IF public, status=SUBMITTED)        │
    │ 11. UPDATE status → "Mailed Payment"     │
    │     (IF staff paper logging)             │
    │ 12. UPDATE status → "LT-262 Draft"       │
    │     or "LT-262 Paper Draft"              │
    │ 13-14. Handle documents                  │
    │ 15-16. Generate submission copy          │
    │ 19-26. Email, notifications              │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────┐
    │ Payment completed?           │
    │ (transaction.complete)       │
    │                              │
    │ Case number: S → N prefix    │
    │ Status → "LT-262 Submitted"  │
    └──────────┬───────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │ LT264.issue (chain 1619, 25 steps)       │
    │ (IF owner found → aging starts)          │
    │                                          │
    │ 1. Get application status/form details   │
    │ 3. Validate status is LT-262 Submitted   │
    │ 6. UPDATE timeline                       │
    │ 7-9. Generate LT-264 (to owners)         │
    │ 10. Generate LT-264G (to requestor)      │
    │ 11-12. Upload to DMS, ElasticSearch      │
    │ 15-18. Email owners and requestor        │
    │ 19-25. Notifications                     │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │ LT264AB.issue (chain 1796, 23 steps)     │
    │ (Court hearing documents)                │
    │                                          │
    │ 5-6. UPDATE timeline, checked requestors │
    │ 7. Generate LT-264A                      │
    │ 8. Generate LT-264B                      │
    │ 9. Save application documents            │
    │ 11-22. Email, DMS, notifications         │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │ LT263.issue (chain 1569, 13 steps)       │
    │ (Sale notice issuance)                   │
    │                                          │
    │ 1. Get application details               │
    │ 2. Generate LT-263 document              │
    │ 5. UPDATE status → "LT-262 Processed"   │
    │ 6-12. Email, notifications               │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │ LT263.submit (chain 1568, 19 steps)      │
    │ (Requestor fills sale details)           │
    │                                          │
    │ 1. Validate status = LT-263 Issued       │
    │ 3. UPDATE form_details (sale info,       │
    │    buyer info)                            │
    │ 4. INSERT application_timeline           │
    │    ("LT-263 Submitted")                  │
    │ 5. ElasticSearch upsert                  │
    │ 6-7. Generate submission copy            │
    │ 12-18. Email, notifications              │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │ LT265andLT265A.issue                     │
    │ (chain 1586, 23 steps)                   │
    │                                          │
    │ 2. Validate status = LT-263 Submitted    │
    │ 3. UPDATE status → "Vehicle Sold"        │
    │ 4-11. Generate LT-265 + LT-265A         │
    │ 15-21. Email, notifications              │
    │ 22. Send EStop API call                  │
    └──────────┬───────────────────────────────┘
               │
               ▼
          CASE CLOSED
      (status = "Vehicle Sold")


═══════════════════════════════════════════════════
  PATH C: LT-261 (Separate Flow)
═══════════════════════════════════════════════════

    ┌──────────────────────────────────────────┐
    │ forms.LT261.submit                       │
    │ (chain 2030, 12 steps)                   │
    │                                          │
    │ 1. Check draft status                    │
    │ 3. Duplicate VIN check                   │
    │ 4-6. INSERT/UPDATE form + application    │
    │ 7. INSERT application_timeline           │
    │    ("LT-261 Submitted")                  │
    │ 8-9. Generate submission copy            │
    │ 10. Save document                        │
    │ 11. Save owner details                   │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────┐
    │ is_stolen ?                  │
    │                              │
    │  YES → status = "Stolen"     │
    │        CASE ENDS             │
    │                              │
    │  NO  → status = "Vehicle     │
    │        Sold"                 │
    │        Generate LT-265       │
    │        CASE ENDS             │
    └──────────────────────────────┘


═══════════════════════════════════════════════════
  STATUS PROGRESSION SUMMARY
═══════════════════════════════════════════════════

LT-260 Path (regular vehicle, owner found):

  SUBMITTED → LT-260 Processed → LT-262 Submitted
  → (LT-264 issued, LT-264A/B issued)
  → LT-262 Processed → LT-263 Submitted → Vehicle Sold

LT-260 Path (regular vehicle, owner NOT found):

  SUBMITTED → LT-260 Processed → LT-262 Submitted
  → (LT-262B issued)
  → LT-262 Processed → LT-263 Submitted → Vehicle Sold

LT-260 Path (manufactured home):

  SUBMITTED → LT-260 Processed → LT-262A Submitted → Vehicle Sold

LT-260 Path (stolen vehicle):

  SUBMITTED → Stolen  (terminal)

LT-261 Path:

  LT-261 Submitted → Stolen  OR  Vehicle Sold


═══════════════════════════════════════════════════
  TABLES WRITTEN PER PHASE
═══════════════════════════════════════════════════

Phase: LT-260 Submission
  ├── application_form_details    INSERT/UPDATE
  ├── application                 INSERT/UPDATE (status=SUBMITTED)
  ├── case_number_sequence        INSERT (generate S-XXXXXX)
  ├── application_owner_details   INSERT (owners, lienholders, lessees)
  ├── application_documents       INSERT (LT260_SUBMISSION_COPY, VIN image, supporting docs)
  ├── application_timeline        INSERT ("LT-260 Submitted")
  └── application_emails          INSERT (requestor notification)

Phase: LT-260 Auto-Issue / Processing
  ├── application_owner_details   UPDATE (is_auto_issued = true, VIN check results)
  ├── application                 UPDATE (status = "Stolen" | "LT-260 Processed")
  ├── application_timeline        INSERT ("Stolen" | "LT-260 Processed")
  └── application_documents       INSERT (LT260D | LT260C | LT260A + LT160B)

Phase: LT-262 Submission
  ├── application_form_details    UPDATE (LT-262 fields)
  ├── application                 UPDATE (status = "LT-262 Submitted" after payment)
  ├── application_cart            INSERT
  ├── application_cart_items      INSERT
  ├── transaction                 INSERT (payment)
  ├── application_documents       INSERT (LT262_SUBMISSION_COPY)
  ├── application_timeline        INSERT ("LT-262 Submitted")
  └── case_number_sequence        UPDATE (S → N prefix)

Phase: LT-264 / LT-264A/B Issuance
  ├── application_documents       INSERT (LT264 to owners, LT264G to requestor)
  ├── application_documents       INSERT (LT264A, LT264B - court hearing)
  ├── application_timeline        INSERT
  └── application_owner_details   UPDATE (checked_requestors for hearing)

Phase: LT-263 Issue + Submit
  ├── application                 UPDATE (status = "LT-262 Processed")
  ├── application_form_details    UPDATE (sale details, buyer info)
  ├── application_documents       INSERT (LT263_SUBMISSION_COPY)
  ├── application_timeline        INSERT ("LT-263 Submitted")
  └── application_emails          INSERT

Phase: LT-265 Issuance
  ├── application                 UPDATE (status = "Vehicle Sold")
  ├── application_documents       INSERT (LT265, LT265A)
  ├── application_timeline        INSERT ("Vehicle Sold")
  └── EStop API call              (external)


═══════════════════════════════════════════════════
  DOCUMENT TYPES GENERATED
═══════════════════════════════════════════════════

| Document Type | Generated By | Recipient | When |
|---------------|-------------|-----------|------|
| LT260_SUBMISSION_COPY | LT260.submit (step 27) | Requestor | On submission |
| LT260A | LT260.issue (step 4) | Owners | Not stolen, owner found |
| LT260C | LT260.issue (step 4) | Requestor | Not stolen, owner NOT found |
| LT260D | LT260.issue (step 4) | Requestor | Stolen vehicle |
| LT160B | LT260.issue (step 4) | Requestor | Not stolen, owner found |
| LT262_SUBMISSION_COPY | LT262.submit (step 16) | Requestor | On LT-262 submission |
| LT262_PAPER_FORM | LT262.submit (step 18) | — | Staff paper logging |
| LT262_SUPPORTING_DOCUMENT | LT262.submit (step 14) | — | Supporting docs |
| LT-262A_SUBMISSION_DOCUMENT | LT262A.submit (step 11) | Requestor | On LT-262A submission |
| LT262B | LT264.issue (step 17) | Requestor | Owner found, aging notice |
| LT264 | LT264.issue (step 9) | Owners | Aging / certified mail |
| LT264G | LT264.issue (step 10) | Requestor | Garage copy |
| LT264A | LT264AB.issue (step 7) | — | Court hearing notice |
| LT264B | LT264AB.issue (step 8) | — | Court hearing notice |
| LT263 | LT263.issue (step 2) | Requestor | Sale notice |
| LT263_SUBMISSION_COPY | LT263.submit (step 7) | Requestor | On LT-263 submission |
| LT261_SUBMISSION_COPY | forms.LT261.submit (step 9) | Requestor | On LT-261 submission |
| LT265 | LT265andLT265A.issue (step 4-6) | Requestor | Vehicle sold |
| LT265A | LT265andLT265A.issue (step 10) | Owners/lienholders | Vehicle sold |
