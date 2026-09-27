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
import { envPairFromProfile } from "./args";
import type { ResolvedTarget } from "./types";

export interface ResolveTargetsResult {
  sourceEnv: string;
  targets: ResolvedTarget[];
  resolvedIds: string[];
}

const PD_MODULE = /^PD$/i;
const AD_MODULE = /^AD_(Method|Service)$/i;

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
 * nothing to resolve (a COMPARISON_REPORT / MIGRATION_STATUS / custom module),
 * or when the source env can't be used — the profile's source env isn't
 * configured locally, or a non-NCDNS/SEMS/YS profile gives no env. Those skips
 * are reported through `warn` (ids then go to Jenkins unresolved), never silent.
 */
export async function resolveMigrationTargets(opts: {
  sourceEnv?: string;
  profile: string;
  migrateType: string;
  ids: string[];
  warn?: (message: string) => void;
}): Promise<ResolveTargetsResult | null> {
  const isPd = PD_MODULE.test(opts.migrateType);
  const isAd = AD_MODULE.test(opts.migrateType);
  if ((!isPd && !isAd) || opts.ids.length === 0) return null;

  // The profile decides what Jenkins migrates; never resolve ids on another env.
  const derived = envPairFromProfile(opts.profile)?.sourceEnv;
  if (opts.sourceEnv && derived && opts.sourceEnv !== derived) {
    throw new CliError(
      `Profile '${opts.profile}' migrates from ${derived}, but --source-env is ${opts.sourceEnv}.`,
      { code: "MIGRATE_ENV_PROFILE_MISMATCH", details: { profile: opts.profile, sourceEnv: opts.sourceEnv, expected: derived } },
    );
  }
  const envs = Config.getAllEnvs();
  const unresolved = isPd
    ? "Ids go to Jenkins unresolved: a PD draft id will fail the migration (use the published id)."
    : "Ids go to Jenkins unresolved (existence and names not checked).";
  if (!opts.sourceEnv) {
    if (!derived) {
      opts.warn?.(
        `Pre-flight id resolution skipped: can't derive the source env from profile '${opts.profile}'. ${unresolved} ` +
          `Pass --source-env and --target-env to enable it.`,
      );
      return null;
    }
    if (!envs[derived]) {
      opts.warn?.(
        `Pre-flight id resolution skipped: profile '${opts.profile}' migrates from '${derived}', which is not configured ` +
          `in ~/.belz/config.json. ${unresolved} Add '${derived}' with 'belz config edit' to enable it.`,
      );
      return null;
    }
  }
  const sourceEnv = opts.sourceEnv ?? derived!;

  if (!envs[sourceEnv]) {
    throw new CliError(
      `Cannot resolve migration ids: source env '${sourceEnv}' is not configured. ` +
        `Known: ${Object.keys(envs).join(", ")}.`,
      { code: "MIGRATE_SOURCE_ENV_UNKNOWN", details: { sourceEnv } },
    );
  }

  // Restore the caller's env exactly: an explicit choice by name, a default by
  // reset (setActiveEnv on an unconfigured default name would throw and mark it explicit).
  const original = Config.activeEnv.name;
  const wasExplicit = Config.envWasExplicit;
  Config.setActiveEnv(sourceEnv);
  try {
    const targets: ResolvedTarget[] = [];
    for (const id of opts.ids) {
      targets.push(isPd ? await resolvePd(id, sourceEnv) : await resolveAd(id, sourceEnv));
    }
    return { sourceEnv, targets, resolvedIds: targets.map((t) => t.resolvedId) };
  } catch (e) {
    // A MIGRATE_* error is already specific. Anything else (login failure,
    // expired creds, network) gets told what to do: the build is not triggered.
    if (e instanceof CliError && !String(e.code ?? "").startsWith("MIGRATE_")) {
      throw new CliError(
        `Pre-flight id resolution on '${sourceEnv}' failed, so no build was triggered: ${e.message} ` +
          `Fix the '${sourceEnv}' credentials ('belz config edit') and retry.`,
        {
          code: e.code,
          exitCode: e.exitCode,
          details: { ...(isRecord(e.details) ? e.details : {}), preflightEnv: sourceEnv },
        },
      );
    }
    throw e;
  } finally {
    if (wasExplicit) Config.setActiveEnv(original);
    else Config.resetActiveEnv();
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
