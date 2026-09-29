import { CliError, acceptedFlags, defineArgs, suggest } from "@belzabar/core";
import {
  JENKINS_CLIENTS,
  KNOWN_MIGRATE_TYPES,
  ENV_TO_PROFILE_SEGMENT,
  type JenkinsClient,
  type MigrateType,
} from "./constants";
import type { MigrateRunArgs } from "./types";

export function normalizeClient(value: string | undefined): JenkinsClient | undefined {
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

// -------- run: argument spec (MG-1) ----------------------------------------
//
// `migrate run` triggers a real Jenkins build, so a typo'd safety flag
// (`--dryrun`, `--no-autoapprove`) must be an error, never silently ignored.
// core `defineArgs` rejects unknown flags (with a did-you-mean), values on
// switches (`--dry-run=true`) and stray positionals; the MIGRATE_* codes predate
// it and are kept.

const YES_NO = ["Y", "N"] as const;

export const RUN_ARGS = defineArgs({
  command: "belz migrate run",
  flags: {
    module: { type: "string", alias: ["--module-name"] },
    "module-custom": { type: "string" },
    client: { type: "string" },
    profile: { type: "string" },
    "source-env": { type: "string" },
    "target-env": { type: "string" },
    ids: { type: "string" },
    "ids-file": { type: "string" },
    "migration-id": { type: "string" },
    async: { type: "enum", values: YES_NO, default: "N" },
    "migrate-dependents": { type: "enum", values: YES_NO, default: "N" },
    "devops-tag": { type: "string" },
    out: { type: "string" },
    "dry-run": { type: "boolean" },
    "no-auto-approve": { type: "boolean" },
    quiet: { type: "boolean" },
    "no-follow": { type: "boolean" },
    yes: { type: "boolean", alias: ["-y"] },
  },
  exclusive: [["ids", "ids-file"]],
  codes: {
    UNKNOWN_FLAG: "MIGRATE_UNKNOWN_FLAG",
    INVALID_VALUE: "MIGRATE_INVALID_FLAG_VALUE",
    UNEXPECTED_ARGUMENT: "MIGRATE_UNEXPECTED_ARG",
    CONFLICTING_FLAGS: "MIGRATE_IDS_CONFLICT",
  },
});

const RUN_KNOWN_FLAGS: readonly string[] = [...acceptedFlags(RUN_ARGS)];

/** Closest known `migrate run` flag to a typo (kept for callers of the old parser). */
export function suggestFlag(flag: string, known: readonly string[] = RUN_KNOWN_FLAGS): string | undefined {
  return suggest(flag, known);
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

export async function parseMigrateRunArgs(argv: string[]): Promise<MigrateRunArgs> {
  const { flags } = RUN_ARGS.parse(argv);

  const migrateType = normalizeMigrateType(flags.module, flags.moduleCustom);
  const client = normalizeClient(flags.client);
  const profile = flags.profile?.trim() || undefined;
  const sourceEnv = flags.sourceEnv?.trim() || undefined;
  const targetEnv = flags.targetEnv?.trim() || undefined;

  let ids = parseIdsCsv(flags.ids);
  if (flags.idsFile) ids = await parseIdsFromFile(flags.idsFile);

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
    migrationId: flags.migrationId?.trim() || undefined,
    asyncMigration: flags.async,
    migrateDependent: flags.migrateDependents,
    devopsTag: flags.devopsTag?.trim() || undefined,
    dryRun: flags.dryRun,
    autoApprove: !flags.noAutoApprove,
    outPath: flags.out?.trim() || undefined,
    quiet: flags.quiet,
    follow: !flags.noFollow,
    yes: flags.yes,
  };
}
