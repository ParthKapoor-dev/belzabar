# Automation Designer CLI (Belzabar)

A Bun + TypeScript CLI for interacting with Automation Designer APIs.

## Features

-   **Manage Environments**: Easy switching between Dev, QA, and Prod.
-   **Method Inspection**: View definitions, inputs, and logic (SQL/Code).
-   **Draft Testing**: Run draft methods with inputs and trace execution.
-   **SQL Read Queries**: Run SQL read queries against configured DB accounts.
-   **NSM Migrations**: Run PD/AD migrations through the DB migration tool protocol.
-   **AI Native**: First-class support for AI agents via MCP and JSON output.

## 🤖 AI Agent Mode

This CLI is designed to be driven by AI agents (Gemini, Claude, etc.).

### Enabling AI Mode
Pass the global flag `--llm` to any command.
This forces **deterministic compact JSON output** and suppresses human tables.

```bash
belz ad show <UUID> --llm
```

LLM output shape is standardized:
```json
{
  "schema": "ad.<command>",
  "version": "2.0",
  "ok": true,
  "command": "<command-name>",
  "data": {},
  "error": null,
  "meta": {}
}
```

`--llm` does not change command semantics. It returns the same command data as human mode, only rendered as compact JSON.
Use `--raw` on supported commands when raw payloads are explicitly needed.

### Agent Contract
See [BELZABAR_AD_AGENT.md](./BELZABAR_AD_AGENT.md) for the strict operational contract.
This document defines "Safe Operations" and "Hallucination Boundaries".

### MCP Server (Gemini)
An MCP (Model Context Protocol) server is provided in `integrations/gemini-mcp/`.
It exposes:
*   `ad.show_method`
*   `ad.test_method`

## 🛠️ Usage

### Installation
```bash
bun install
```

### Commands

**Show Method**
```bash
belz ad show <UUID> [flags]
# Flags: --full, --inputs, --services
```

**Test Method**
```bash
belz ad test <UUID> --inputs data.json
```

**Save Regression Suite**
```bash
belz ad save-suite <UUID> --name "smoke-test"
```

**SQL Read Query**
```bash
belz ad sql run "select * from users limit 1"
belz ad sql dbs
belz ad sql tui
```

**NSM Migration**
```bash
belz migrate profiles
belz migrate run --module PD --ids <uuid1,uuid2> --profile devncdns_qancdns
```

## 🏗️ Architecture

*   **`bin/`**: Entry point.
*   **`commands/`**: Modular command logic.
*   **`lib/`**: Shared core (API, Auth, Display, Parser).
*   **`integrations/`**: Adapters for external systems (MCP).

## License
Private / Internal.
