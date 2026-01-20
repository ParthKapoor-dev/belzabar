# Automation Designer CLI

A modular CLI tool for interacting with the Automation Designer API, supporting multiple environments (Dev, QA, UAT).

## Setup

1.  **Install Dependencies**
    ```bash
    bun install
    ```

2.  **Environment Configuration**
    Create a `.env` file in the root. You can configure multiple environments.

    **Template (.env):**
    ```ini
    # --- NSM Dev (Default) ---
    NSM_DEV_URL=https://nsm-dev.nc.verifi.dev
    NSM_DEV_USER=dev_user
    NSM_DEV_PASSWORD=base64_dev_password

    # --- NSM QA ---
    NSM_QA_URL=https://nsm-qa.nc.verifi.dev
    NSM_QA_USER=qa_user
    NSM_QA_PASSWORD=base64_qa_password

    # --- NSM UAT ---
    NSM_UAT_URL=https://nsm-uat.nc.verifi.dev
    NSM_UAT_USER=uat_user
    NSM_UAT_PASSWORD=base64_uat_password

    # --- Fallback (Legacy Support) ---
    # API_USER and API_PASSWORD will be used if specific env credentials are missing
    API_USER=fallback_user
    API_PASSWORD=fallback_base64_pass
    ```

## Usage

Run commands via the entry point:

```bash
bun run bin/cli.ts <command> [args]
```

### Global Flags

- `--env <name>` / `-e <name>`: Switch environment (default: `nsm-dev`).

### Available Commands

- **envs**: List available environments.
  ```bash
  bun run bin/cli.ts envs
  ```

- **fetch-method**: Get details of an automation chain.
  ```bash
  bun run bin/cli.ts fetch-method <UUID> --env nsm-qa
  ```

- **run-method**: Execute an automation chain.
  ```bash
  bun run bin/cli.ts run-method <PUBLISHED_ID> ./payload.json -e nsm-uat
  ```

### Help

```bash
bun run bin/cli.ts --help
```
