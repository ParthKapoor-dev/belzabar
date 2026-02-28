# Get Command

Retrieves metadata about an Automation Method.

## Usage

```bash
belz ad get <UUID>
```

## Logic

- Authenticates using Bearer token.
- Determines if the provided UUID is a Draft or Published version.
- Displays the alias name, state, and the corresponding pair ID (Reference ID).
