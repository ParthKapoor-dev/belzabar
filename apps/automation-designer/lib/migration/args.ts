import { CliError } from "@belzabar/core";
import { NSM_ENV_TO_PROFILE_SEGMENT, NSM_SCRIPT_NAME } from "./constants";
import type { MigrateArgs, MigrationCleanupMode, MigrationModule, YesNo } from "./types";

function getOptionValue(args: string[], name: string): string | undefined {
  const explicit = args.find((arg) => arg.startsWith(`${name}=`));
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
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

function parseYesNo(args: string[], name: string, defaultValue: YesNo): YesNo {
  if (!hasOption(args, name)) return defaultValue;

  const raw = getOptionValue(args, name);
  if (!raw) {
    throw new CliError(`${name} requires a value of Y or N.`, {
      code: "MIGRATE_INVALID_FLAG_VALUE",
    });
  }

  const normalized = raw.trim().toUpperCase();
  if (normalized !== "Y" && normalized !== "N") {
    throw new CliError(`${name} must be Y or N.`, {
      code: "MIGRATE_INVALID_FLAG_VALUE",
      details: { flag: name, value: raw },
    });
  }

  return normalized;
}

function parseCleanup(args: string[]): MigrationCleanupMode {
  const raw = getOptionValue(args, "--cleanup");
  if (!raw) return "auto";
  if (raw !== "auto" && raw !== "never") {
    throw new CliError("--cleanup must be one of: auto, never.", {
      code: "MIGRATE_INVALID_CLEANUP",
      details: { value: raw },
    });
  }
  return raw;
}

function normalizeModuleName(value: string | undefined): MigrationModule {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "PD" || normalized === "AD") {
    return normalized;
  }

  throw new CliError("--module is required and must be one of: PD, AD.", {
    code: "MIGRATE_INVALID_MODULE",
    details: { value },
  });
}

function parseIdsCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,\n\r]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function parseIdsFromFile(filePath: string): Promise<string[]> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new CliError(`IDs file not found: ${filePath}`, {
      code: "MIGRATE_IDS_FILE_NOT_FOUND",
    });
  }

  const text = await file.text();
  const ids = parseIdsCsv(text);
  if (ids.length === 0) {
    throw new CliError("IDs file is empty.", {
      code: "MIGRATE_IDS_EMPTY",
      details: { filePath },
    });
  }

  return ids;
}

function deriveProfileFromEnvPair(sourceEnv: string, targetEnv: string): string {
  const source = NSM_ENV_TO_PROFILE_SEGMENT[sourceEnv];
  const target = NSM_ENV_TO_PROFILE_SEGMENT[targetEnv];
  if (!source || !target) {
    throw new CliError("Unable to derive profile from env pair. Use --profile or supported env names.", {
      code: "MIGRATE_INVALID_ENV_PAIR",
      details: {
        sourceEnv,
        targetEnv,
        supportedEnvs: Object.keys(NSM_ENV_TO_PROFILE_SEGMENT),
      },
    });
  }

  return `${source}_${target}`;
}

function parseStringOption(args: string[], name: string): string | undefined {
  const value = getOptionValue(args, name);
  return value?.trim() || undefined;
}

export async function parseMigrateArgs(args: string[]): Promise<MigrateArgs> {
  const action = args[0];

  if (!action) {
    throw new CliError("Missing migrate subcommand. Use one of: profiles, run.", {
      code: "MIGRATE_INVALID_SUBCOMMAND",
    });
  }

  if (action === "profiles") {
    const rest = args.slice(1);
    return {
      action: "profiles",
      refresh: rest.includes("--refresh"),
      raw: rest.includes("--raw"),
    };
  }

  if (action !== "run") {
    throw new CliError(`Unknown migrate subcommand '${action}'. Use one of: profiles, run.`, {
      code: "MIGRATE_INVALID_SUBCOMMAND",
    });
  }

  const rest = args.slice(1);
  const moduleValue = parseStringOption(rest, "--module") ?? parseStringOption(rest, "--module-name");
  const moduleName = normalizeModuleName(moduleValue);

  const profile = parseStringOption(rest, "--profile");
  const sourceEnv = parseStringOption(rest, "--source-env");
  const targetEnv = parseStringOption(rest, "--target-env");

  const idsArg = parseStringOption(rest, "--ids");
  const idsFile = parseStringOption(rest, "--ids-file");

  if (idsArg && idsFile) {
    throw new CliError("Use either --ids or --ids-file, not both.", {
      code: "MIGRATE_IDS_CONFLICT",
    });
  }

  let ids = parseIdsCsv(idsArg);
  if (idsFile) {
    ids = await parseIdsFromFile(idsFile);
  }

  if (ids.length === 0) {
    throw new CliError("Missing migration IDs. Provide --ids or --ids-file.", {
      code: "MIGRATE_IDS_REQUIRED",
    });
  }

  if (!profile && (!sourceEnv || !targetEnv)) {
    throw new CliError("Provide --profile, or provide both --source-env and --target-env.", {
      code: "MIGRATE_PROFILE_REQUIRED",
    });
  }

  const resolvedProfile = profile || deriveProfileFromEnvPair(sourceEnv as string, targetEnv as string);

  return {
    action: "run",
    moduleName,
    ids,
    profile: resolvedProfile,
    sourceEnv,
    targetEnv,
    useCrud: parseYesNo(rest, "--crud", "Y"),
    isAsync: parseYesNo(rest, "--async", "Y"),
    migrateDependents: parseYesNo(rest, "--migrate-dependents", "N"),
    cleanup: parseCleanup(rest),
    scriptName: parseStringOption(rest, "--script-name") || NSM_SCRIPT_NAME,
    migrationId: parseStringOption(rest, "--migration-id"),
    outPath: parseStringOption(rest, "--out"),
    raw: rest.includes("--raw"),
    quiet: rest.includes("--quiet"),
  };
}

export function deriveNsmProfile(sourceEnv: string, targetEnv: string): string {
  return deriveProfileFromEnvPair(sourceEnv, targetEnv);
}
