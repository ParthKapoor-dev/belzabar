import { z } from "zod";

/**
 * The `--llm` output contract: the exact shape `toEnvelope` (runner.ts) and the
 * runner-level help/error envelopes produce. The agent skills and scripts parse
 * this, so it is a public contract — every command is checked against it by
 * `apps/cli/tests/envelope-contract.test.ts`.
 *
 * - `schema`   `<namespace>.<command>`, derived by the runner from routing:
 *              `ad.show`, `pd.validate`, `tw.task`, `migrate.status`,
 *              `release.matrix`, top-level `belz.envs` / `belz.config`.
 *              Runner-level outcomes: `belz.help`, `belz.runner` (unknown
 *              command, bad global flags), `belz.version`.
 * - `version`  always `"2.0"`.
 * - `ok`       false whenever the operation failed or found a failure-shaped
 *              result (then `error` is set; `data` may still carry the result).
 *              `ok` ⇔ exit code 0.
 * - `error`    `{ code, message, details? }`; `message` has no `"Error: "`
 *              prefix; `details` is always an object.
 * - `meta`     `durationMs` always; `env` only for env-aware commands (AD/PD,
 *              cache…), never for tw/migrate/release/config/envs or runner-level
 *              envelopes, and with it `envSource` (`flag` | `BELZ_ENV` |
 *              `default`: config.json `defaultEnv` or the built-in nsm-dev);
 *              `warnings` when any were raised.
 *
 * Invariants beyond the field types:
 * - `ok: true`  ⇒ `error === null`
 * - `ok: false` ⇒ `error` is set, with a non-empty `code`
 */
export const ENVELOPE_VERSION = "2.0" as const;

/** `<namespace>.<command>`: lowercase words joined by `-`, exactly one dot. */
export const SCHEMA_NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

export const EnvelopeErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "error.code must be UPPER_SNAKE"),
    message: z.string().refine((m) => !/^\s*Error:/.test(m), "error.message must not start with 'Error:'"),
    details: z.record(z.unknown()).optional(),
  })
  .strict();

export const EnvelopeMetaSchema = z
  .object({
    env: z.string().min(1).optional(),
    envSource: z.enum(["flag", "BELZ_ENV", "default"]).optional(),
    durationMs: z.number().nonnegative(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

export const EnvelopeSchema = z
  .object({
    schema: z.string().regex(SCHEMA_NAME, "schema must be <namespace>.<command>"),
    version: z.literal(ENVELOPE_VERSION),
    ok: z.boolean(),
    command: z.string(),
    data: z.unknown(),
    error: EnvelopeErrorSchema.nullable(),
    meta: EnvelopeMetaSchema,
  })
  .strict()
  .superRefine((env, ctx) => {
    if (env.ok && env.error !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "ok:true envelope must have error:null" });
    }
    if (!env.ok && env.error === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "ok:false envelope must carry an error" });
    }
  });

export type EnvelopeShape = z.infer<typeof EnvelopeSchema>;
