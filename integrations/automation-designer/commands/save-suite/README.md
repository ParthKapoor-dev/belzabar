# ad save-suite

Saves a named local regression suite for a method so `belz ad run-suites` can run it
later.

```bash
belz ad save-suite <uuid> --name smoke-test [--inputs in.json]
```

- Fetches the method to validate the uuid.
- Collects input values, interactively or from `--inputs`. `--inputs` is required
  with `--llm`.
- Writes `suites/<name>.spec.json` under the current directory. The name may contain
  only letters, digits, `.`, `_` and `-`.
