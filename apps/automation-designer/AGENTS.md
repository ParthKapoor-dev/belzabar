# AI Agent Context for Automation CLI

This file explains the architecture of the `belzabar.cli` project. If you are an AI agent starting a session, READ THIS FIRST.

## 1. Project Structure

The project is a modular CLI built with Bun and TypeScript.

- **`/bin/cli.ts`**: The entry point. Handles global flags (like `--env`) and dispatches commands.
- **`/lib`**: Core logic shared across commands.
  - `auth.ts`: Handles login, token persistence (in `~/.belzabar-cli/sessions/<env>.json`), and Base64 password decoding.
  - `api.ts`: A fetch wrapper. Handles 401 Re-auth. Uses `Config.activeEnv` to determine target URL and Auth.
  - `config.ts`: Environment variable validation (Zod) and **Environment Profile Management**.
- **`/commands`**: Each subfolder is a CLI command.

## 2. Environment Profiles

The CLI supports multiple environments (e.g., `nsm-dev`, `nsm-qa`).

- **Config**: Defined in `lib/config.ts`. Mapped from `.env` vars (e.g., `NSM_QA_URL`).
- **Selection**:
  - Default: `nsm-dev`.
  - Override: Use global flag `--env <name>` or `-e <name>`.
  - Example: `cli fetch-method 123 --env nsm-qa`.
- **Persistence**: Sessions are isolated per environment.
  - `nsm-dev` -> `~/.belzabar-cli/sessions/nsm-dev.json`
  - `nsm-qa`  -> `~/.belzabar-cli/sessions/nsm-qa.json`

## 3. How to Add a New Command

1.  Create folder: `commands/<name>/`
2.  Create `index.ts` exporting `run(args: string[])`.
3.  Create `help.txt` & `README.md`.

## 4. Authentication Flow

1.  `apiFetch` gets `Config.activeEnv`.
2.  It calls `loadSession()` which reads the env-specific session file.
3.  If 401, `login()` is called using `Config.activeEnv.credentials`.

## 5. Auth Modes

- `authMode: "Bearer"` -> Headers: `Authorization: Bearer <token>`
- `authMode: "Raw"`    -> Headers: `Authorization: <token>`