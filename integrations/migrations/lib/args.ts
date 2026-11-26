import { CliError, defineArgs } from "@belzabar/core";
import { KNOWN_MIGRATE_TYPES, type JenkinsClient, type MigrateType } from "./constants";
import { knownRouteHint, profileSegmentEnvs, profileSegments, segmentEnv, withRouteHint } from "./routes";
import type { MigrateRunArgs } from "./types";

/**
 * Trim a `--client` value. Client names are not known statically: they are the
 * Jenkins job's divider groups, so they are checked against the discovered
 * profiles (`matchClient`) once Jenkins has been read.
 */
export function normalizeClient(value: string | undefined): JenkinsClient | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Case-insensitive lookup of a client among the discovered groups (their spelling wins). */
export function matchClient(value: string, known: readonly string[]): JenkinsClient | undefined {
  const wanted = value.trim().toLowerCase();
  return known.find((c) => c.toLowerCase() === wanted);
}

function normalizeMigrateType(value: string | undefined, custom: string | undefined): MigrateType | string {
  if (custom?.trim() && value?.trim()) {
    throw new CliError("Pass --module or --module-custom, not both.", {
      code: "MIGRATE_MODULE_CONFLICT",
      details: { module: value, moduleCustom: custom },
    });
  }
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
  const segmentOf = (env: string): string | undefined => {
    const matches = Object.entries(profileSegmentEnvs()).filter(([, e]) => e === env).map(([segment]) => segment);
    return matches.length === 1 ? matches[0] : undefined; // ambiguous or unmapped → not derivable
  };
  const s = segmentOf(sourceEnv);
  const t = segmentOf(targetEnv);
  if (!s || !t) {
    throw new CliError(
      "Could not derive a profile from the env pair. Pass --profile, or map each env to one profile segment " +
        'in ~/.wi-impl/config.json under "jenkins.profileEnvs".',
      {
        code: "MIGRATE_INVALID_ENV_PAIR",
        details: { sourceEnv, targetEnv, supportedEnvs: [...new Set(Object.values(profileSegmentEnvs()))] },
      },
    );
  }
  return `${s}_${t}`;
}

// -------- status / logs: build number ---------------------------------------

/** The `<build-number>` spec shared by `migrate status` and `migrate logs`. */
export function buildNumberArgs(command: "status" | "logs") {
  return defineArgs({
    command: `wi-impl migrate ${command}`,
    positionals: [
      {
        name: "build-number",
        required: true,
        missingCode: "MIGRATE_BUILD_NUMBER_REQUIRED",
        missingMessage: `wi-impl migrate ${command} requires a build number.`,
      },
    ],
  });
}

/** Digits only: `12abc` must not be read as build 12. */
export function parseBuildNumber(input: string): number {
  const n = /^\d+$/.test(input.trim()) ? Number(input.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CliError(`Invalid build number '${input}'.`, { code: "MIGRATE_BUILD_NUMBER_INVALID", details: { input } });
  }
  return n;
}

// -------- run: argument spec ------------------------------------------------
//
// `migrate run` triggers a real Jenkins build, so a typo'd safety flag
// (`--dryrun`, `--no-autoapprove`) must be an error, never silently ignored.
// core `defineArgs` rejects unknown flags (with a did-you-mean), values on
// switches (`--dry-run=true`) and stray positionals, under MIGRATE_* codes.

const YES_NO = ["Y", "N"] as const;

export const RUN_ARGS = defineArgs({
  command: "wi-impl migrate run",
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
    strict: { type: "boolean" },
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

// -------- run: profile ↔ env consistency ------------------------------------
//
// Jenkins migrates whatever the PROFILE says; --source-env only picks where
// wi-impl pre-resolves ids. They must agree, or ids get resolved on one env while
// Jenkins migrates another. Profile segment → wi-impl env comes from config
// `jenkins.profileEnvs` (profiles are `<source segment>_<target segment>`).

/** Derive {sourceEnv, targetEnv} from a profile like `devacme_qaacme`; null when a segment is unmapped. */
export function envPairFromProfile(profile: string): { sourceEnv: string; targetEnv: string } | null {
  const segments = profileSegments(profile);
  const sourceEnv = segmentEnv(segments?.[0]);
  const targetEnv = segmentEnv(segments?.[1]);
  if (!sourceEnv || !targetEnv) return null;
  return { sourceEnv, targetEnv };
}

/**
 * The run's envs: each end is the env flag or, when the flag is missing, the
 * profile segment's `jenkins.profileEnvs` mapping (with no env flag at all,
 * both stay unset). A flag that contradicts a
 * mapped segment is MIGRATE_ENV_PROFILE_MISMATCH. When env flags are given but
 * an end stays unknown (its segment is unmapped), wi-impl cannot check it:
 * MIGRATE_ENV_PROFILE_UNVERIFIED, naming the segment to map.
 */
function resolveProfileEnvs(
  profile: string,
  sourceEnv: string | undefined,
  targetEnv: string | undefined,
): { sourceEnv?: string; targetEnv?: string } {
  const segments = profileSegments(profile);
  const mapped = { source: segmentEnv(segments?.[0]), target: segmentEnv(segments?.[1]) };
  const mismatches: string[] = [];
  if (sourceEnv && mapped.source && sourceEnv !== mapped.source) mismatches.push(`--source-env ${sourceEnv} (profile says ${mapped.source})`);
  if (targetEnv && mapped.target && targetEnv !== mapped.target) mismatches.push(`--target-env ${targetEnv} (profile says ${mapped.target})`);
  if (mismatches.length > 0) {
    const pair = `${mapped.source ?? sourceEnv ?? "?"} → ${mapped.target ?? targetEnv ?? "?"}`;
    throw new CliError(
      `Profile '${profile}' migrates ${pair}, but ${mismatches.join(" and ")}. Fix or drop the env flags.`,
      {
        code: "MIGRATE_ENV_PROFILE_MISMATCH",
        details: { profile, expected: { sourceEnv: mapped.source, targetEnv: mapped.target }, sourceEnv, targetEnv },
      },
    );
  }
  // No env flags: the run derives what it can from the profile later (and a
  // pre-flight it cannot run is a warning, not an error).
  if (!sourceEnv && !targetEnv) return {};
  const resolved = { sourceEnv: sourceEnv ?? mapped.source, targetEnv: targetEnv ?? mapped.target };
  if (!resolved.sourceEnv || !resolved.targetEnv) {
    // A lone env flag is too easy to get wrong silently: the other end must be
    // known too, from a flag or the mapping.
    const unmapped: string[] = [];
    if (!resolved.sourceEnv) unmapped.push(segments?.[0] ?? profile);
    if (!resolved.targetEnv) unmapped.push(segments?.[1] ?? profile);
    const example = unmapped.map((seg) => `"${seg}": "<env>"`).join(", ");
    throw new CliError(
      `Cannot derive the ${!resolved.sourceEnv ? "source" : "target"} env of profile '${profile}': segment ` +
        `${unmapped.map((s) => `'${s}'`).join(" and ")} is not mapped in jenkins.profileEnvs. Map it once in ` +
        `~/.wi-impl/config.json ("jenkins": { "profileEnvs": { ${example} } }) and --profile alone names both envs; ` +
        `or pass BOTH --source-env and --target-env.`,
      { code: "MIGRATE_ENV_PROFILE_UNVERIFIED", details: { profile, sourceEnv, targetEnv, unmappedSegments: unmapped } },
    );
  }
  return resolved;
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

  const isReportType = /MIGRATION_STATUS|COMPARISON_REPORT/i.test(String(migrateType));
  if (!isReportType && ids.length === 0) {
    throw new CliError("Missing --ids or --ids-file.", { code: "MIGRATE_IDS_REQUIRED" });
  }
  // A report/status build without a migration id would run with MIGRATION_ID="".
  const migrationId = flags.migrationId?.trim() || undefined;
  if (isReportType && !migrationId) {
    throw new CliError(`--migration-id is required for --module ${migrateType}.`, {
      code: "MIGRATE_MIGRATION_ID_REQUIRED",
      details: { module: migrateType },
    });
  }

  if (!profile && (!sourceEnv || !targetEnv)) {
    throw new CliError("Provide --profile, or both --source-env and --target-env.", {
      code: "MIGRATE_PROFILE_REQUIRED",
    });
  }

  let resolvedProfile = profile;
  if (!resolvedProfile) {
    try {
      resolvedProfile = deriveProfileFromEnvPair(sourceEnv as string, targetEnv as string);
    } catch (e) {
      // Name the routes that do exist (best effort: Jenkins' profile list).
      if (e instanceof CliError) throw withRouteHint(e, await knownRouteHint({ sourceEnv: sourceEnv as string, targetEnv: targetEnv as string }));
      throw e;
    }
  }
  // The profile names both ends: a missing env flag comes from jenkins.profileEnvs.
  const envs = profile ? resolveProfileEnvs(profile, sourceEnv, targetEnv) : { sourceEnv, targetEnv };

  return {
    action: "run",
    client,
    profile: resolvedProfile,
    sourceEnv: envs.sourceEnv,
    targetEnv: envs.targetEnv,
    migrateType,
    ids,
    migrationId,
    asyncMigration: flags.async,
    migrateDependent: flags.migrateDependents,
    devopsTag: flags.devopsTag?.trim() || undefined,
    dryRun: flags.dryRun,
    autoApprove: !flags.noAutoApprove,
    outPath: flags.out?.trim() || undefined,
    quiet: flags.quiet,
    follow: !flags.noFollow,
    strict: flags.strict,
    yes: flags.yes,
  };
}
