import { z } from "zod";

/**
 * The `--llm` output contract: the exact shape `toEnvelope` (runner.ts) and the
 * runner-level help/error envelopes produce. The agent skills and scripts parse
 * this, so it is a public contract — every command is checked against it by
 * `apps/cli/tests/envelope-contract.test.ts`.
 *
 * Invariants beyond the field types:
 * - `ok: true`  ⇒ `error === null`
 * - `ok: false` ⇒ `error` is set, with a non-empty `code`
 */
export const EnvelopeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  details: z.unknown().optional(),
});

export const EnvelopeMetaSchema = z
  .object({
    env: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

export const EnvelopeSchema = z
  .object({
    schema: z.string().min(1),
    version: z.string().min(1),
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
