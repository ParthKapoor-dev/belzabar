// zod schema for ~/.belz/config.json, validated at load (CORE-18).
//
// Unknown keys are kept (passthrough) so sections owned by other tools or
// older/newer belz versions survive a read-modify-write.

import { z } from "zod";
import { CliError } from "../command";

const secretFields = {
  password: z.string().optional(),
  passwordEncoding: z.enum(["plain", "base64"]).optional(),
};

export const EnvEntrySchema = z
  .object({
    url: z.string().optional(),
    user: z.string().optional(),
    ...secretFields,
    /** Project this env belongs to (e.g. "NSM", "YieldSec"). Defaults to the env-name prefix. */
    project: z.string().optional(),
  })
  .passthrough();

export const ConfigFileSchema = z
  .object({
    /** Env used when no `--env` is given and BELZ_ENV is unset (D6). */
    defaultEnv: z.string().min(1).optional(),
    environments: z.record(EnvEntrySchema).optional(),
    teamwork: z
      .object({
        email: z.string().optional(),
        ...secretFields,
      })
      .passthrough()
      .optional(),
    jenkins: z
      .object({
        baseUrl: z.string().optional(),
        user: z.string().optional(),
        ...secretFields, // raw password or API token
        migrationJob: z.string().optional(),
      })
      .passthrough()
      .optional(),
    /** Install metadata — written by the installer / `belz update`. */
    belz: z
      .object({
        sourceDir: z.string().optional(),
        installDir: z.string().optional(),
        repoUrl: z.string().optional(),
        installedAt: z.string().optional(),
        version: z.string().optional(),
      })
      .passthrough()
      .optional(),
    /** Browser extension lifecycle state. */
    extension: z
      .object({
        loadedBrowsers: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type BelzConfigFile = z.infer<typeof ConfigFileSchema>;
export type EnvEntry = z.infer<typeof EnvEntrySchema>;

function formatPath(path: (string | number)[]): string {
  return path.map((p) => String(p)).join(".") || "(root)";
}

/** Validate a parsed config.json. Returns the typed config or a CONFIG_INVALID CliError. */
export function validateConfigFile(raw: unknown, file: string): { config: BelzConfigFile; error: CliError | null } {
  const parsed = ConfigFileSchema.safeParse(raw);
  if (parsed.success) return { config: parsed.data, error: null };
  const issues = parsed.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message }));
  const first = issues[0]!;
  const error = new CliError(
    `Invalid config ${file}: ${first.path}: ${first.message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ""}. Fix it with 'belz config edit'.`,
    { code: "CONFIG_INVALID", details: { file, issues } },
  );
  return { config: {}, error };
}

/** Per-env checks beyond the shape: a usable http(s) url. Returns an error message or null. */
export function envEntryProblem(entry: EnvEntry | undefined, builtinUrl: string | undefined): string | null {
  const url = entry?.url ?? builtinUrl;
  if (!url) return "has no url";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return `url must be http(s) (got ${JSON.stringify(url)})`;
  } catch {
    return `url is not a valid URL (got ${JSON.stringify(url)})`;
  }
  return null;
}
