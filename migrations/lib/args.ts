import { CliError } from "@belzabar/core";
import {
  JENKINS_CLIENTS,
  KNOWN_MIGRATE_TYPES,
  ENV_TO_PROFILE_SEGMENT,
  type JenkinsClient,
  type MigrateType,
} from "./constants";
import type {
  MigrateArgs,
  MigrateLogsArgs,
  MigrateProfilesArgs,
  MigrateRunArgs,
  MigrateStatusArgs,
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

function parseBuildNumber(args: string[], action: string): number {
  const positional = args.find((a) => !a.startsWith("-"));
  if (!positional) {
    throw new CliError(`belz migrate ${action} requires a build number.`, {
      code: "MIGRATE_BUILD_NUMBER_REQUIRED",
    });
  }
  const n = Number.parseInt(positional, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(`Invalid build number '${positional}'.`, {
      code: "MIGRATE_BUILD_NUMBER_INVALID",
    });
  }
  return n;
}

export async function parseMigrateRunArgs(rest: string[]): Promise<MigrateRunArgs> {
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

function parseProfilesArgs(rest: string[]): MigrateProfilesArgs {
  return {
    action: "profiles",
    refresh: rest.includes("--refresh"),
    client: normalizeClient(parseString(rest, "--client")),
    raw: rest.includes("--raw"),
  };
}

function parseStatusArgs(rest: string[]): MigrateStatusArgs {
  return { action: "status", buildNumber: parseBuildNumber(rest, "status") };
}

function parseLogsArgs(rest: string[]): MigrateLogsArgs {
  return { action: "logs", buildNumber: parseBuildNumber(rest, "logs") };
}

export async function parseMigrateArgs(args: string[]): Promise<MigrateArgs> {
  const action = args[0];
  if (!action) {
    throw new CliError("Missing subcommand. Use one of: profiles, run, status, logs.", {
      code: "MIGRATE_INVALID_SUBCOMMAND",
    });
  }
  const rest = args.slice(1);
  switch (action) {
    case "profiles": return parseProfilesArgs(rest);
    case "run": return await parseMigrateRunArgs(rest);
    case "status": return parseStatusArgs(rest);
    case "logs": return parseLogsArgs(rest);
    default:
      throw new CliError(`Unknown subcommand '${action}'. Use: profiles, run, status, logs.`, {
        code: "MIGRATE_INVALID_SUBCOMMAND",
      });
  }
}
