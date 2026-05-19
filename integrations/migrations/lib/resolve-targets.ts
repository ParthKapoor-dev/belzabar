// Pre-flight id resolution for `belz migrate run`.
//
// Migration ids are environment-local — the same PD page/component can carry a
// different id in dev vs qa, and a DRAFT id is NOT migratable (the migration
// service 500s on draft ids; it needs the PUBLISHED id). So before triggering a
// Jenkins build we fetch every id against the SOURCE environment and:
//   - PD: if the id is a DRAFT, swap it for its published sibling (referenceId).
//   - AD: confirm the method exists and capture its name.
// The resolved ids + names are what the build is triggered with and what we
// show the operator, so a doomed build (or a silent wrong-entity migration) is
// caught here instead of 7s into Jenkins.

import { apiFetch, CliError, Config } from "@belzabar/core";
import { ENV_TO_PROFILE_SEGMENT } from "./constants";
import type { ResolvedTarget } from "./types";

export interface ResolveTargetsResult {
  sourceEnv: string;
  targets: ResolvedTarget[];
  resolvedIds: string[];
}

const PD_MODULE = /^PD$/i;
const AD_MODULE = /^AD_(Method|Service)$/i;

/** Reverse ENV_TO_PROFILE_SEGMENT: derive a belz env from a profile's source segment. */
function sourceEnvFromProfile(profile: string): string | undefined {
  const segment = profile.split("_")[0];
  for (const [env, seg] of Object.entries(ENV_TO_PROFILE_SEGMENT)) {
    if (seg === segment) return env;
  }
  return undefined;
}

async function getJson(path: string, env: string): Promise<Record<string, unknown>> {
  const res = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  if (res.status === 404) {
    throw new CliError(`Migration target not found on '${env}': ${path}`, {
      code: "MIGRATE_TARGET_NOT_FOUND",
      details: { env, path },
    });
  }
  if (!res.ok) {
    throw new CliError(
      `Could not resolve migration target on '${env}' (HTTP ${res.status}): ${path}`,
      { code: "MIGRATE_TARGET_RESOLVE_FAILED", details: { env, path, status: res.status } },
    );
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function resolvePd(id: string, env: string): Promise<ResolvedTarget> {
  const page = await getJson(`/rest/api/pagedesigner/pages/${id}`, env);
  const name = typeof page.name === "string" && page.name ? page.name : "(unnamed)";
  const status = typeof page.status === "string" ? page.status.toUpperCase() : "";

  if (status === "DRAFT") {
    const published = typeof page.referenceId === "string" ? page.referenceId : "";
    if (!published) {
      throw new CliError(
        `PD entity '${name}' (${id}) is a DRAFT with no published version on '${env}'. ` +
          `Migrations must target the published id — publish the page/component first.`,
        { code: "MIGRATE_TARGET_DRAFT_UNPUBLISHED", details: { id, env, name } },
      );
    }
    return { inputId: id, resolvedId: published, name, kind: "PD", status, swapped: true };
  }
  return {
    inputId: id,
    resolvedId: id,
    name,
    kind: "PD",
    status: status || "PUBLISHED",
    swapped: false,
  };
}

async function resolveAd(id: string, env: string): Promise<ResolvedTarget> {
  const method = await getJson(`/rest/api/automation/chain/${id}`, env);
  const name = typeof method.name === "string" && method.name ? method.name : "(unnamed)";
  return { inputId: id, resolvedId: id, name, kind: "AD", swapped: false };
}

/**
 * Resolve every id against the source environment. Returns null when there is
 * nothing to resolve (a COMPARISON_REPORT / MIGRATION_STATUS / custom module,
 * or the source env cannot be determined from a non-NCDNS profile).
 */
export async function resolveMigrationTargets(opts: {
  sourceEnv?: string;
  profile: string;
  migrateType: string;
  ids: string[];
}): Promise<ResolveTargetsResult | null> {
  const isPd = PD_MODULE.test(opts.migrateType);
  const isAd = AD_MODULE.test(opts.migrateType);
  if ((!isPd && !isAd) || opts.ids.length === 0) return null;

  const sourceEnv = opts.sourceEnv ?? sourceEnvFromProfile(opts.profile);
  if (!sourceEnv) return null; // non-NCDNS profile with no --source-env: can't pick an env

  const envs = Config.getAllEnvs();
  if (!envs[sourceEnv]) {
    throw new CliError(
      `Cannot resolve migration ids: source env '${sourceEnv}' is not configured. ` +
        `Known: ${Object.keys(envs).join(", ")}.`,
      { code: "MIGRATE_SOURCE_ENV_UNKNOWN", details: { sourceEnv } },
    );
  }

  const original = Config.activeEnv.name;
  Config.setActiveEnv(sourceEnv);
  try {
    const targets: ResolvedTarget[] = [];
    for (const id of opts.ids) {
      targets.push(isPd ? await resolvePd(id, sourceEnv) : await resolveAd(id, sourceEnv));
    }
    return { sourceEnv, targets, resolvedIds: targets.map((t) => t.resolvedId) };
  } finally {
    Config.setActiveEnv(original);
  }
}
