import { CliError } from "@belzabar/core";
import {
  JENKINS_CLIENTS,
  KNOWN_MIGRATE_TYPES,
  ENV_TO_PROFILE_SEGMENT,
  type JenkinsClient,
  type MigrateType,
} from "./constants";
import type {
  MigrateRunArgs,
  YesNo,
} from "./types";

function getOptionValue(args: string[], name: string): string | undefined {
  const explicit = args.find((a) => a.startsWith(`${name}=`));
  if (explicit) {
    const value = explicit.split("=").slice(1).join("=").trim();
    return value || undefined;
  }
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  if (!next || next.startsWith("-")) return undefined;
  return next;
}

function hasOption(args: string[], name: string): boolean {
  return args.includes(name) || args.some((a) => a.startsWith(`${name}=`));
}

function parseYesNo(args: string[], name: string, defaultValue: YesNo): YesNo {
  if (!hasOption(args, name)) return defaultValue;
  const raw = getOptionValue(args, name);
  if (!raw) throw new CliError(`${name} requires Y or N.`, { code: "MIGRATE_INVALID_FLAG_VALUE" });
  const normalized = raw.trim().toUpperCase();
  if (normalized !== "Y" && normalized !== "N") {
    throw new CliError(`${name} must be Y or N.`, { code: "MIGRATE_INVALID_FLAG_VALUE", details: { flag: name, value: raw } });
  }
  return normalized;
}

function parseString(args: string[], name: string): string | undefined {
  const v = getOptionValue(args, name);
  return v?.trim() || undefined;
}

function normalizeClient(value: string | undefined): JenkinsClient | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const match = JENKINS_CLIENTS.find((c) => c.toLowerCase() === trimmed.toLowerCase());
  if (!match) {
    throw new CliError(
      `Unknown client '${value}'. Known: ${JENKINS_CLIENTS.join(", ")}.`,
      { code: "MIGRATE_INVALID_CLIENT", details: { value, known: JENKINS_CLIENTS } }
    );
  }
  return match;
}

function normalizeMigrateType(value: string | undefined, custom: string | undefined): MigrateType | string {
  if (custom?.trim()) return custom.trim();
  if (!value?.trim()) {
    throw new CliError(
      `--module is required. Known: ${KNOWN_MIGRATE_TYPES.join(", ")}. Use --module-custom for arbitrary values.`,
      { code: "MIGRATE_MODULE_REQUIRED" }
    );
  }
  const match = KNOWN_MIGRATE_TYPES.find((t) => t.toLowerCase() === value.trim().toLowerCase());
  if (!match) {
    throw new CliError(
      `Unknown --module '${value}'. Known: ${KNOWN_MIGRATE_TYPES.join(", ")}. Use --module-custom to pass an arbitrary name.`,
      { code: "MIGRATE_INVALID_MODULE", details: { value, known: KNOWN_MIGRATE_TYPES } }
    );
  }
  return match;
}

function parseIdsCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s,\n\r]+/g).map((s) => s.trim()).filter(Boolean);
}

async function parseIdsFromFile(path: string): Promise<string[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new CliError(`IDs file not found: ${path}`, { code: "MIGRATE_IDS_FILE_NOT_FOUND" });
  }
  const ids = parseIdsCsv(await file.text());
  if (ids.length === 0) {
    throw new CliError("IDs file is empty.", { code: "MIGRATE_IDS_EMPTY", details: { path } });
  }
  return ids;
}

function deriveProfileFromEnvPair(sourceEnv: string, targetEnv: string): string {
  const s = ENV_TO_PROFILE_SEGMENT[sourceEnv];
  const t = ENV_TO_PROFILE_SEGMENT[targetEnv];
  if (!s || !t) {
    throw new CliError("Could not derive profile from env pair. Pass --profile, or use a supported source/target env (NCDNS only).", {
      code: "MIGRATE_INVALID_ENV_PAIR",
      details: { sourceEnv, targetEnv, supportedEnvs: Object.keys(ENV_TO_PROFILE_SEGMENT) },
    });
  }
  return `${s}_${t}`;
}

// -------- run: flag whitelist (MG-1) ---------------------------------------
//
// `migrate run` triggers a real Jenkins build, so a typo'd safety flag
// (`--dryrun`, `--no-autoapprove`) must be an error, never silently ignored.

const RUN_VALUE_FLAGS = [
  "--module", "--module-name", "--module-custom", "--client", "--profile",
  "--source-env", "--target-env", "--ids", "--ids-file", "--migration-id",
  "--async", "--migrate-dependents", "--devops-tag", "--out",
] as const;
const RUN_BOOLEAN_FLAGS = ["--dry-run", "--no-auto-approve", "--raw", "--quiet", "--no-follow"] as const;
const RUN_KNOWN_FLAGS: readonly string[] = [...RUN_VALUE_FLAGS, ...RUN_BOOLEAN_FLAGS];

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

export function suggestFlag(flag: string, known: readonly string[] = RUN_KNOWN_FLAGS): string | undefined {
  const norm = (f: string) => f.replace(/^-+/, "").replace(/[-_]/g, "").toLowerCase();
  const n = norm(flag);
  let best: { flag: string; d: number } | undefined;
  for (const k of known) {
    const d = editDistance(n, norm(k));
    if (!best || d < best.d) best = { flag: k, d };
  }
  if (!best) return undefined;
  return best.d <= Math.max(2, Math.floor(norm(best.flag).length / 3)) ? best.flag : undefined;
}

/** Reject unknown flags, `=value` on boolean flags, and stray positionals. */
export function assertKnownRunFlags(rest: string[]): void {
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("-")) {
      throw new CliError(`Unexpected argument '${token}' for 'belz migrate run'.`, {
        code: "MIGRATE_UNEXPECTED_ARG",
        details: { arg: token },
      });
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if ((RUN_VALUE_FLAGS as readonly string[]).includes(name)) {
      if (eq === -1) {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("-")) i++;
      }
      continue;
    }
    if ((RUN_BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      if (eq !== -1) {
        throw new CliError(`${name} is a switch and takes no value (got '${token}').`, {
          code: "MIGRATE_INVALID_FLAG_VALUE",
          details: { flag: name, value: token.slice(eq + 1) },
        });
      }
      continue;
    }
    const suggestion = suggestFlag(name);
    throw new CliError(
      `Unknown flag '${name}' for 'belz migrate run'.` +
        (suggestion ? ` Did you mean '${suggestion}'?` : "") +
        ` Known: ${RUN_KNOWN_FLAGS.join(", ")}.`,
      {
        code: "MIGRATE_UNKNOWN_FLAG",
        details: { flag: name, suggestion: suggestion ?? null, known: RUN_KNOWN_FLAGS },
      },
    );
  }
}

// -------- run: profile ↔ env consistency (MG-2) -----------------------------
//
// Jenkins migrates whatever the PROFILE says; --source-env only picks where
// belz pre-resolves ids. They must agree, or ids get resolved on one env while
// Jenkins migrates another. Profile segment → belz env, where known.

export const PROFILE_SEGMENT_TO_ENV: Record<string, string> = {
  devncdns: "nsm-dev",
  qancdns: "nsm-qa",
  uatncdns: "nsm-uat",
  stgncdns: "nsm-stage",
  stg2ncdns: "nsm-stage2",
  devsems: "sems-dev",
  qasems: "sems-qa",
  uatsems: "sems-uat",
  stagesems: "sems-stage",
  stage2sems: "sems-stage2",
  qays: "ys-qa",
  stageys: "ys-stage",
};

/** Derive {sourceEnv, targetEnv} from a profile like `devsems_qasems`; null when unknown. */
export function envPairFromProfile(profile: string): { sourceEnv: string; targetEnv: string } | null {
  const parts = profile.trim().toLowerCase().split("_");
  if (parts.length !== 2) return null;
  const sourceEnv = PROFILE_SEGMENT_TO_ENV[parts[0]!];
  const targetEnv = PROFILE_SEGMENT_TO_ENV[parts[1]!];
  if (!sourceEnv || !targetEnv) return null;
  return { sourceEnv, targetEnv };
}

export function assertProfileEnvConsistent(
  profile: string,
  sourceEnv: string | undefined,
  targetEnv: string | undefined,
): void {
  if (!sourceEnv && !targetEnv) return;
  const pair = envPairFromProfile(profile);
  if (!pair) {
    // Unknown profile family: we cannot check the envs, so both must be given
    // explicitly (a lone --source-env is too easy to get wrong silently).
    if (!sourceEnv || !targetEnv) {
      throw new CliError(
        `Cannot derive environments from profile '${profile}'. Pass BOTH --source-env and --target-env ` +
          `matching the profile, or omit both (ids are then sent to Jenkins unresolved).`,
        { code: "MIGRATE_ENV_PROFILE_UNVERIFIED", details: { profile, sourceEnv, targetEnv } },
      );
    }
    return;
  }
  const mismatches: string[] = [];
  if (sourceEnv && sourceEnv !== pair.sourceEnv) mismatches.push(`--source-env ${sourceEnv} (profile says ${pair.sourceEnv})`);
  if (targetEnv && targetEnv !== pair.targetEnv) mismatches.push(`--target-env ${targetEnv} (profile says ${pair.targetEnv})`);
  if (mismatches.length > 0) {
    throw new CliError(
      `Profile '${profile}' migrates ${pair.sourceEnv} → ${pair.targetEnv}, but ${mismatches.join(" and ")}. ` +
        `Fix or drop the env flags.`,
      {
        code: "MIGRATE_ENV_PROFILE_MISMATCH",
        details: { profile, expected: pair, sourceEnv, targetEnv },
      },
    );
  }
}

export async function parseMigrateRunArgs(rest: string[]): Promise<MigrateRunArgs> {
  assertKnownRunFlags(rest);

  const moduleValue = parseString(rest, "--module") ?? parseString(rest, "--module-name");
  const customModuleValue = parseString(rest, "--module-custom");
  const migrateType = normalizeMigrateType(moduleValue, customModuleValue);

  const client = normalizeClient(parseString(rest, "--client"));
  const profile = parseString(rest, "--profile");
  const sourceEnv = parseString(rest, "--source-env");
  const targetEnv = parseString(rest, "--target-env");

  const idsArg = parseString(rest, "--ids");
  const idsFile = parseString(rest, "--ids-file");
  if (idsArg && idsFile) {
    throw new CliError("Use either --ids or --ids-file, not both.", { code: "MIGRATE_IDS_CONFLICT" });
  }
  let ids = parseIdsCsv(idsArg);
  if (idsFile) ids = await parseIdsFromFile(idsFile);

  const requiresIds = !/MIGRATION_STATUS|COMPARISON_REPORT/i.test(String(migrateType));
  if (requiresIds && ids.length === 0) {
    throw new CliError("Missing --ids or --ids-file.", { code: "MIGRATE_IDS_REQUIRED" });
  }

  if (!profile && (!sourceEnv || !targetEnv)) {
    throw new CliError("Provide --profile, or both --source-env and --target-env.", {
      code: "MIGRATE_PROFILE_REQUIRED",
    });
  }

  const resolvedProfile = profile || deriveProfileFromEnvPair(sourceEnv as string, targetEnv as string);
  if (profile) assertProfileEnvConsistent(profile, sourceEnv, targetEnv);

  return {
    action: "run",
    client,
    profile: resolvedProfile,
    sourceEnv,
    targetEnv,
    migrateType,
    ids,
    migrationId: parseString(rest, "--migration-id"),
    asyncMigration: parseYesNo(rest, "--async", "N"),
    migrateDependent: parseYesNo(rest, "--migrate-dependents", "N"),
    devopsTag: parseString(rest, "--devops-tag"),
    dryRun: rest.includes("--dry-run"),
    autoApprove: !rest.includes("--no-auto-approve"),
    outPath: parseString(rest, "--out"),
    raw: rest.includes("--raw"),
    quiet: rest.includes("--quiet"),
    follow: !rest.includes("--no-follow"),
  };
}

