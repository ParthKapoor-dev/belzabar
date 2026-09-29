// Release spec (`belz release matrix <release.json>`): validated up front with
// zod (RL-1) and its spine/stage envs resolved from the project (RL-2), so a bad
// spec is BAD_SPEC before any Teamwork or AD request.

import { existsSync, readFileSync } from "fs";
import { z } from "zod";
import { CliError, Config, type Environment } from "@belzabar/core";
import { releaseSlug } from "./ledger";

const TicketRef = z.union([z.number(), z.string()]);

export const ReleaseSpecSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "must be a non-empty string")
      .refine((n) => releaseSlug(n, { throwOnEmpty: false }) !== "", "must contain a letter or digit"),
    /** Project whose envs are traced (e.g. "ACME"); default: from spineEnv/stageEnv, else the active env. */
    project: z.string().trim().min(1).optional(),
    included: z.array(TicketRef).min(1, "must list at least one ticket"),
    excluded: z.array(TicketRef).default([]),
    spineEnv: z.string().trim().min(1).optional(),
    stageEnv: z.string().trim().min(1).optional(),
  })
  .strict();

export type ReleaseSpec = z.infer<typeof ReleaseSpecSchema>;

function issuesText(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.length ? i.path.join(".") : "(root)";
    return i.code === "unrecognized_keys" ? `${path}: unknown key(s) ${i.keys.map((k) => `'${k}'`).join(", ")}` : `${path}: ${i.message}`;
  });
}

/** Validate an already-parsed spec. BAD_SPEC with every problem listed. */
export function validateReleaseSpec(value: unknown, source = "release spec"): ReleaseSpec {
  const parsed = ReleaseSpecSchema.safeParse(value);
  if (!parsed.success) {
    const issues = issuesText(parsed.error);
    throw new CliError(`Invalid ${source}: ${issues.join("; ")}.`, {
      code: "BAD_SPEC",
      details: { issues },
    });
  }
  return parsed.data;
}

/** Read + validate a spec file. SPEC_NOT_FOUND / BAD_SPEC. */
export function loadReleaseSpec(path: string): ReleaseSpec {
  if (!existsSync(path)) {
    throw new CliError(`Release spec not found: ${path}`, { code: "SPEC_NOT_FOUND" });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new CliError(`Could not parse ${path}: ${e instanceof Error ? e.message : e}`, { code: "BAD_SPEC" });
  }
  return validateReleaseSpec(raw, path);
}

export interface ReleaseEnvs {
  project: string;
  spineEnv: string;
  stageEnv: string;
}

function findProjectEnv(
  envs: Record<string, Environment>,
  project: string,
  role: "spine" | "stage",
): string {
  const suffix = role === "spine" ? "-dev" : "-stage";
  const key = role === "spine" ? "spineEnv" : "stageEnv";
  const P = project.toUpperCase();
  const candidates = Object.values(envs)
    .filter((e) => e.project.toUpperCase() === P && e.name.endsWith(suffix))
    .map((e) => e.name);
  const preferred = `${project.toLowerCase()}${suffix}`;
  if (candidates.includes(preferred)) return preferred;
  if (candidates.length === 1) return candidates[0]!;
  throw new CliError(
    candidates.length === 0
      ? `Release spec: no configured '*${suffix}' env for project ${P}, so ${key} can't be derived. Set "${key}" in the spec.`
      : `Release spec: several '*${suffix}' envs for project ${P} (${candidates.join(", ")}). Set "${key}" in the spec.`,
    { code: "BAD_SPEC", details: { project: P, role: key, candidates } },
  );
}

/**
 * spineEnv/stageEnv for a spec (RL-2). Explicit values must be configured envs.
 * Missing ones come from the project: `spec.project`, else the project of an
 * explicit spineEnv/stageEnv, else the project of `fallback` (the active env —
 * `--env`, BELZ_ENV or defaultEnv). A release never defaults to another project's envs.
 */
export function resolveReleaseEnvs(
  spec: Pick<ReleaseSpec, "project" | "spineEnv" | "stageEnv">,
  fallback: Environment,
  envs: Record<string, Environment> = Config.getAllEnvs(),
): ReleaseEnvs {
  for (const key of ["spineEnv", "stageEnv"] as const) {
    const name = spec[key];
    if (name && !envs[name]) {
      throw new CliError(`Release spec: ${key} '${name}' is not a configured env. Known: ${Object.keys(envs).join(", ")}.`, {
        code: "BAD_SPEC",
        details: { [key]: name },
      });
    }
  }
  const explicitProject = (spec.spineEnv && envs[spec.spineEnv]?.project) || (spec.stageEnv && envs[spec.stageEnv]?.project);
  const project = spec.project ?? explicitProject ?? fallback.project;
  if (spec.project && !Object.values(envs).some((e) => e.project.toUpperCase() === spec.project!.toUpperCase())) {
    throw new CliError(`Release spec: no configured env belongs to project '${spec.project}'.`, {
      code: "BAD_SPEC",
      details: { project: spec.project },
    });
  }
  const spineEnv = spec.spineEnv ?? findProjectEnv(envs, project, "spine");
  const stageEnv = spec.stageEnv ?? findProjectEnv(envs, project, "stage");
  // OTH-R24: the tracer only locates a method on the spine env's project
  // family, so a stage env from another project would never be traced and
  // every collision would come out `leak: "unknown"`.
  const spineProject = envs[spineEnv]!.project.toUpperCase();
  const stageProject = envs[stageEnv]!.project.toUpperCase();
  if (spineProject !== stageProject) {
    throw new CliError(
      `Release spec: spineEnv '${spineEnv}' (${spineProject}) and stageEnv '${stageEnv}' (${stageProject}) belong to different projects.`,
      { code: "BAD_SPEC", details: { spineEnv, stageEnv, spineProject, stageProject } },
    );
  }
  return { project: project.toUpperCase(), spineEnv, stageEnv };
}
