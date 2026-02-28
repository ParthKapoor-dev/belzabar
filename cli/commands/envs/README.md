# Envs Command

Lists the available environment profiles.

## Usage

```bash
bun run bin/cli.ts envs
```

## Logic

- Displays all configured environments from `lib/config.ts`.
- Highlights the currently selected environment (default or selected via `--env`).
