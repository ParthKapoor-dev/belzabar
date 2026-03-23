---
name: nsm-platform
description: |
  NSM (NC Notice & Storage Management) platform context. Use this skill when you need to understand the NSM application domain — environments, portals, tools (AD/PD/Reports), URL patterns, letter types, or the relationship between AD methods and PD pages.
  MANDATORY TRIGGERS: NSM, Notice and Storage, NC DMV, LT-260, LT-261, LT-262, LT-264, LT-265, staff portal, public portal, nsm-dev, nsm-qa
---

# NSM Platform — Domain Context for Agents

## What is NSM?

NSM (NC Notice & Storage Management) is a web platform for the NC Division of Motor Vehicles. It manages vehicle notices, storage tracking, and regulatory workflows. It has two user-facing portals and a set of internal design tools.

## Portals

| Portal | URL Pattern | Users |
|--------|-------------|-------|
| Staff Portal | `https://staff-nss-stage.verifi-nc.com/...` | DMV staff, internal users |
| Public Portal | `https://public-nss-stage.verifi-nc.com/...` | External agencies, tow companies |

## Design Tools

| Tool | Purpose | CLI Namespace |
|------|---------|---------------|
| Automation Designer (AD) | Backend service chains (API calls, DB queries, logic) | `belz ad` |
| Page Designer (PD) | Frontend UI pages (layout, variables, bindings) | `belz pd` |
| Reports Designer | Report generation (not CLI-exposed) | — |

## Environments

| Name | CLI Flag | Base URL | Purpose |
|------|----------|----------|---------|
| nsm-dev | `--env nsm-dev` (default) | `https://nsm-dev.nc.verifi.dev` | Development |
| nsm-qa | `--env nsm-qa` | `https://nsm-qa.nc.verifi.dev` | QA testing |
| nsm-uat | `--env nsm-uat` | `https://nsm-uat.nc.verifi.dev` | User acceptance |
| nsm-stage | — | `https://nss-stage.verifi-nc.com` | Pre-production |
| nsm-stage2 | — | `https://nss-stage2.verifi-nc.com` | Pre-production (alt) |

## URL Patterns

**AD Designer:**
```
https://<env>/automation-designer/<Category>/<method-uuid>
```

**PD Designer:**
```
https://<env>/ui-designer/page/<page-draft-id>        # page
https://<env>/ui-designer/symbol/<component-name>      # component/symbol
```

**Deployed App Pages:**
```
https://<portal>/pages/<app-name>/<page-route>
https://<portal>/<app-name>/<page-route>
```

## How AD and PD Connect

PD pages call AD methods via HTTP service calls:
1. PD page defines variables and an HTTP call with `trigger` variables
2. When a trigger variable changes, the HTTP call fires
3. The HTTP call POSTs to `/rest/api/automation/chain/execute/<ad-method-uuid>`
4. The AD method executes its service chain and returns results
5. The HTTP `handler.success` maps response fields to PD variables via `{%var%}` bindings

To trace this connection:
```bash
# See all HTTP calls in a page with their AD method IDs
belz pd show <page-id> --http --llm

# Then inspect the AD method
belz ad show <ad-method-uuid> --inputs --services --llm
```

## Letter Types (Key Domain Objects)

| Code | Name | Description |
|------|------|-------------|
| LT-260 | Notice of Sale | Initial notice to vehicle owner |
| LT-260A | Amended Notice | Amended version of LT-260 |
| LT-261 | Details Page | Vehicle/owner/storage details |
| LT-262 | Application | Storage facility application |
| LT-264 | Tracking | Letter tracking dashboard |
| LT-265 | Issue Document | Document issuance |
| LT-265A | Amended Issue | Amended document issuance |

## Migration Workflow

Entities move through environments via the migration tool:
```
nsm-dev → nsm-qa → nsm-uat → nsm-stage
```

```bash
belz migrate run --module AD_Method --ids <uuid> --source-env nsm-dev --target-env nsm-qa --llm
belz migrate run --module PD --ids <uuid> --source-env nsm-qa --target-env nsm-uat --llm
```

## Authentication

NSM uses username/password authentication stored in `~/.belz/config.json`. The CLI handles login automatically — on 401, it re-authenticates and retries. Session tokens are cached per-environment at `~/.belz/sessions/<env>.json`.
