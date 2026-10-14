# release/lib

Spec validation and the local ledger, imported as `@belzabar/release/lib/<file>`.

| File | Contents |
|---|---|
| `spec.ts` | `ReleaseSpec` (zod, `.strict()`), `validateReleaseSpec`, `loadReleaseSpec` (`SPEC_NOT_FOUND` / `BAD_SPEC`), `resolveReleaseEnvs` |
| `ledger.ts` | Ledger paths, `releaseSlug`, `loadRelease`, `assertReleaseSlotFree`, `saveRelease`, `saveProdSnapshot`, snapshot types |

## Env resolution (`resolveReleaseEnvs`)

- An explicit `spineEnv` / `stageEnv` must be a configured env (`BAD_SPEC`).
- A missing one is derived from the project: `spec.project`, else the project of an explicit
  spine/stage env, else the active env's (`--env`, `WI_IMPL_ENV`, `defaultEnv`). The candidate is the
  project's configured env ending in `-dev` (spine) or `-stage` (stage), preferring
  `<project>-dev` / `<project>-stage`; none or several → `BAD_SPEC`.
- Spine and stage must belong to the same project, because the tracer only walks the spine's
  project family (`BAD_SPEC`).

## Ledger (`ledger.ts`)

Files under `~/.wi-impl/promotion/`, written atomically (tmp + rename via core `writeSecureJson`,
mode 0644):

| Path | Written by |
|---|---|
| `releases/<slug>.json` | `wi-impl release matrix` (replaced on every run) |
| `prod-snapshots/<slug>.json` | `wi-impl release freeze` (replaced only with `--force`, else `SNAPSHOT_EXISTS`) |

- `<slug>` = `releaseSlug(name)`: lowercase, other characters collapsed to `-`; a name without
  letters or digits is `INVALID_RELEASE_NAME`.
- Two names with one slug are refused (`LEDGER_NAME_COLLISION`); the stored `name` is the source
  of truth. A corrupt record may be overwritten by `matrix`.
- A record that does not parse or validate is `LEDGER_CORRUPT`, never an unhandled error.
