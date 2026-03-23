---
name: belz-cli
description: |
  Core usage patterns for the Belzabar CLI (belz). Use this skill when you need to understand how to run belz commands, interpret output, switch environments, or discover available commands.
  MANDATORY TRIGGERS: belz, belz ad, belz pd, belz tw, belz migrate, --llm, --env, CLI commands
---

# Belz CLI — Agent Usage Guide

## Always Use `--llm` for Structured Output

Every belz command supports `--llm` which returns a JSON envelope instead of human-formatted tables. **Always use this flag** for parseable output.

```bash
belz ad show <uuid> --llm
belz pd show <input> --vars --llm
```

Envelope structure:
```json
{
  "schema": "ad.show",
  "version": "2.0",
  "ok": true,
  "command": "show",
  "data": { ... },
  "error": null,
  "meta": {
    "env": "nsm-dev",
    "durationMs": 1293,
    "warnings": ["Using cached config. Use --force for refresh."]
  }
}
```

On failure: `ok: false`, `error: { code: "NOT_FOUND", message: "..." }`, `data` may be null.

## Namespaces

```
belz ad <cmd>       Automation Designer — inspect, test, execute AD methods
belz pd <cmd>       Page Designer — inspect PD pages, variables, HTTP calls, components
belz tw <cmd>       Teamwork — fetch tasks and comments from Teamwork PM
belz migrate <cmd>  Migrations — cross-environment AD/PD migrations
belz config <cmd>   Credentials — view/edit environment config
belz envs           List configured environments
belz web <cmd>      Web app management (start/stop/status)
```

## Discovering Commands

```bash
belz --help-full          # All commands with one-liner descriptions and flag examples
belz <ns> <cmd> --help    # Detailed help for a specific command
```

`--help-full` is the single best reference. It lists every command, every flag, and example invocations.

## Environments

Three NSM environments: `nsm-dev` (default), `nsm-qa`, `nsm-uat`.

```bash
belz ad show <uuid> --env nsm-qa --llm    # Query against QA environment
belz envs                                  # List all environments with status
```

## Caching

Most data is cached to `~/.belz/cache/`:
- AD methods: 5-minute TTL
- PD page configs: 5-minute TTL
- Search indexes (AD finder, PD finder): 7-day TTL
- Service definitions: 1 hour (custom) or permanent (core)

Use `--force` to bypass cache:
```bash
belz ad show <uuid> --force --llm
belz pd show <input> --force --llm
```

## Typical Agent Workflow

1. **Discover** — `belz ad find <query>` or `belz pd find <query>` to locate entities
2. **Inspect** — `belz ad show <uuid> --inputs --services --llm` or `belz pd show <input> --vars --http --llm`
3. **Deep-dive** — `belz ad show <uuid> --service-detail <N> --llm` or `belz pd show <input> --var-detail <name> --llm`
4. **Validate/Test** — `belz pd validate <input> --llm` or `belz ad test <uuid> --inputs <file> --llm`
5. **Execute** — `belz ad run <published-id> '<json>' --llm`

## Input Flexibility

PD commands accept any of these input formats (auto-detected):
- App URL: `https://staff-nss-stage.verifi-nc.com/pages/ncdot/dashboard`
- PD designer URL: `https://nsm-dev.nc.verifi.dev/ui-designer/page/<hex-id>`
- Bare hex ID: `406c644cc2511cc15f309adb44137e99`
- Component name: `n_s_staff_email_correspondence`

AD commands accept UUID or full AD URL.
