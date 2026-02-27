# Page Designer CLI (`pd`)

CLI tools for inspecting Page Designer pages/components, extracting AD method references, and traversing dependencies.

## Setup

```bash
bun install
cp .env.example .env
```

## Run

```bash
bun run bin/pd.ts <command> [args]
```

## Commands

```bash
pd show-page <PAGE_ID> [--full] [--raw]
pd show-component <NAME> [--full] [--raw]
pd find-ad-methods <ID> [--component] [--recursive]
pd analyze [PAGE_ID] [--compliance]
pd inspect-url <PD_URL> [--recursive] [--full] [--raw]
```

## URL Inspection (New)

`inspect-url` accepts full PD URLs directly:

- Page URL: `https://<host>/ui-designer/page/<draft-id>`
- Symbol URL: `https://<host>/ui-designer/symbol/<component-name>`

Examples:

```bash
pd inspect-url https://nsm-dev.nc.verifi.dev/ui-designer/page/488418d9648bbe699cbaaf86ab1cc92f
pd inspect-url https://nsm-dev.nc.verifi.dev/ui-designer/symbol/track_LT_264
pd inspect-url https://nsm-dev.nc.verifi.dev/ui-designer/symbol/track_LT_264 --recursive
```

By default, output includes resolved entity details, direct child components, AD references, and best-effort metadata fields (`draftId`, `publishedId`, `versionId`).
