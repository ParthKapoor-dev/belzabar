# Page Designer CLI (`belz pd`)

CLI tools for deep inspection of Page Designer pages and components — variables, HTTP service calls, component trees, validation, and AD method tracing.

## Commands

```bash
belz pd show <input>                      # Overview: name, IDs, variable/HTTP/component counts
belz pd show <input> --vars               # List all variables (user-defined + derived)
belz pd show <input> --http               # List all HTTP service calls
belz pd show <input> --components         # Show layout/component tree
belz pd show <input> --var-detail <name>  # Full config for a specific variable or derived
belz pd show <input> --http-detail <N>    # Full config for the Nth HTTP call (1-indexed)
belz pd show <input> --full               # All sections + all details
belz pd show <input> --force              # Bypass the local cache (SWR 5 min / 1 h)
belz pd show <input> --recursive          # Recursive component tree + all AD IDs

belz pd validate <input>                  # Calibrated validator (exit 1 on errors)
belz pd find [query]                      # Search pages/components (7-day cached index)
belz pd find-ad-methods <ID>              # Extract AD method IDs (--recursive for full tree)
belz pd analyze <id...> [--compliance f]  # Recursive dependency + compliance analysis
```

`<input>` accepts any of: app URL, PD designer URL, bare hex ID, or an exact page/component name.

## Examples

```bash
# Inspect a page by PD URL
belz pd show https://nsm-dev.nc.verifi.dev/ui-designer/page/406c644cc2511cc15f309adb44137e99

# Show all variables with types and initial values
belz pd show 406c644cc2511cc15f309adb44137e99 --vars

# Deep-dive into a specific HTTP call
belz pd show 406c644cc2511cc15f309adb44137e99 --http-detail 1

# Validate a page for common errors
belz pd validate 406c644cc2511cc15f309adb44137e99

# Search for pages by name
belz pd find "notice"

# Structured JSON output for agents
belz pd show 406c644cc2511cc15f309adb44137e99 --vars --llm
```
