---
name: automation-designer
description: |
  Automation Designer (AD) investigation and debugging workflow. Use this skill when working with AD methods — inspecting service chains, testing execution, debugging failures, querying databases, or understanding method structure.
  MANDATORY TRIGGERS: AD method, automation designer, service chain, belz ad, method UUID, ad show, ad test, ad fetch
---

# Automation Designer — Agent Investigation Guide

## What is an AD Method?

An AD method is a **service chain**: a sequence of service steps that execute in order. Each method has:
- **Inputs** — typed fields (STRING, JSON, BOOLEAN) that callers provide
- **Service steps** — each step calls an external service (API, database, email, etc.)
- **Outputs** — results from service steps, mapped to output variables

Methods exist in two states: **DRAFT** (editable, has a UUID) and **PUBLISHED** (immutable, has a referenceId). Testing uses draft; live execution uses published.

## Investigation Workflow

### Step 1: Identify the method
```bash
belz ad find "lookup DCIN" --llm          # Search by name/alias
belz ad find list --llm                   # Browse all categories
```

### Step 2: Fetch and cache
```bash
belz ad fetch <uuid> --llm               # Cache method + hydrate service definitions
```

### Step 3: Understand structure
```bash
belz ad show <uuid> --inputs --services --llm
```
This returns: method name, category, state, version, input fields, and service step list.

### Step 4: Deep-dive into a specific service
```bash
belz ad show <uuid> --service-detail <N> --llm
```
Returns: service type, automation ID, definition (category, method name), config (async, loop, conditions), inputs with values, outputs with mappings.

**Note:** Service detail index is the `orderIndex` from the services list (0-based).

### Step 5: Reproduce the issue
```bash
# Create an inputs file
echo '{"applicationId": "12345"}' > /tmp/inputs.json

# Test execution with full trace
belz ad test <uuid> --inputs /tmp/inputs.json --verbose --llm
```

Test results include per-step execution status, timing, and output values. Look for:
- `executionFailed: true` — the method failed
- `stackTrace` in response — Java compilation error (HTTP 200 but broken)
- Individual step failures in the trace

### Step 6: Check database state
```bash
belz ad sql run "SELECT * FROM table WHERE id = '12345'" --llm
belz ad sql run "SELECT * FROM table WHERE id = '12345'" --db NSM_QA_DB --llm
```

### Step 7: Full method detail
```bash
belz ad show <uuid> --full --llm         # All services expanded with inputs/outputs
belz ad show <uuid> --full --raw --llm   # Include raw service mappings
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| UUID | Draft method identifier (32 hex chars) |
| referenceId | Published version of the same method |
| automationId | ID of a specific service definition (used in service steps) |
| Service Definition | The API/connector spec for a service step (inputs, outputs, auth) |
| HydratedMethod | Parsed method with typed inputs, services, and metadata |
| Method cache | 5-minute TTL at `~/.belz/cache/methods/` |

## Live Execution

```bash
# Execute a published method (MUTATES DATA)
belz ad run <published-id> '{"applicationId": "12345"}' --llm
```

**Warning:** `belz ad run` executes against production data. Use `belz ad test` for safe debugging.

## SQL Queries

```bash
belz ad sql dbs --llm                     # List available databases
belz ad sql run "<query>" --llm           # SELECT (default DB)
belz ad sql run "<query>" --db <name> --llm
belz ad sql tui                           # Interactive SQL session
```

## Regression Testing

```bash
belz ad save-suite <uuid> --name smoke-test --inputs ./inputs.json
belz ad run-suites --llm                  # Run all saved suites
```
