// Pre-flight id resolution for `wi-impl migrate run`.
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

import { CliError, Config, isObj } from "@belzabar/core";
import { envPairFromProfile } from "./args";
import type { ResolvedTarget } from "./types";
import { adChainPath, canonicalUuid, fetchRawEntity, isEntityId, pdPagePath } from "@belzabar/core/platform";

interface ResolveTargetsResult {
  sourceEnv: string;
  targets: ResolvedTarget[];
  resolvedIds: string[];
}

const PD_MODULE = /^PD$/i;
const AD_MODULE = /^AD_(Method|Service)$/i;

async function getJson(path: string, env: string): Promise<Record<string, unknown>> {
  const got = await fetchRawEntity<unknown>(path, {
    onError: (res) =>
      new CliError(`Could not resolve migration target on '${env}' (HTTP ${res.status}): ${path}`, {
        code: "MIGRATE_TARGET_RESOLVE_FAILED",
        details: { env, path, status: res.status },
      }),
  });
  if (!got.found && got.reason === "http-404") {
    throw new CliError(`Migration target not found on '${env}': ${path}`, {
      code: "MIGRATE_TARGET_NOT_FOUND",
      details: { env, path },
    });
  }
  // An unknown id is not always a 404: AD answers 200 with an empty body (or
  // `null`) for a uuid it doesn't know. Anything that isn't a
  // non-empty JSON object is "not found", never a crash on `.name`. A stalled
  // body read (HTTP_TIMEOUT from core) propagates, not as a misleading NOT_FOUND.
  if (!got.found || !isObj(got.body) || Object.keys(got.body).length === 0) {
    throw new CliError(`Migration target not found on '${env}' (empty response): ${path}`, {
      code: "MIGRATE_TARGET_NOT_FOUND",
      details: { env, path },
    });
  }
  return got.body;
}

async function resolvePd(id: string, env: string): Promise<ResolvedTarget> {
  const page = await getJson(pdPagePath(id), env);
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
  // AD also accepts a NUMERIC chain id on this endpoint, so an all-digit id
  // silently resolves to some other method. Only a uuid is a
  // migration id, and the method that comes back must carry that uuid.
  if (!isEntityId(id) || /^[0-9-]+$/.test(id)) {
    throw new CliError(`'${id}' is not an AD method uuid (32 hex characters, not all digits).`, {
      code: "MIGRATE_TARGET_ID_INVALID",
      details: { id, env },
    });
  }
  const method = await getJson(adChainPath(id), env);
  if (typeof method.uuid === "string" && canonicalUuid(method.uuid) !== canonicalUuid(id)) {
    throw new CliError(`AD id '${id}' resolved to a different method (${method.uuid}) on '${env}'.`, {
      code: "MIGRATE_TARGET_ID_MISMATCH",
      details: { id, env, resolvedUuid: method.uuid },
    });
  }
  const name = typeof method.name === "string" && method.name ? method.name : "(unnamed)";
  return { inputId: id, resolvedId: id, name, kind: "AD", swapped: false };
}

/**
 * Resolve every id against the source environment. Returns null when there is
 * nothing to resolve (a COMPARISON_REPORT / MIGRATION_STATUS / custom module),
 * or when the source env can't be used — the profile's source env isn't
 * configured locally, or the profile's segments are not mapped in
 * `jenkins.profileEnvs`. Those skips are reported through `warn` (ids then go
 * to Jenkins unresolved), never silent.
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
          `Pass --source-env and --target-env (or map the profile's segments in jenkins.profileEnvs) to enable it.`,
      );
      return null;
    }
    if (!envs[derived]) {
      opts.warn?.(
        `Pre-flight id resolution skipped: profile '${opts.profile}' migrates from '${derived}', which is not configured ` +
          `in ~/.wi-impl/config.json. ${unresolved} Add '${derived}' with 'wi-impl config edit' to enable it.`,
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

  // Restore the caller's env exactly (explicit or defaulted) afterwards.
  const restoreEnv = Config.captureActiveEnv();
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
      const transport = e.code === "HTTP_TIMEOUT" || e.code === "HTTP_NETWORK_ERROR";
      throw new CliError(
        `Pre-flight id resolution on '${sourceEnv}' failed, so no build was triggered: ${e.message} ` +
          (transport ? `Retry when '${sourceEnv}' responds.` : `Fix the '${sourceEnv}' credentials ('wi-impl config edit') and retry.`),
        {
          code: e.code,
          exitCode: e.exitCode,
          details: { ...(isObj(e.details) ? e.details : {}), preflightEnv: sourceEnv },
        },
      );
    }
    throw e;
  } finally {
    restoreEnv();
  }
}

