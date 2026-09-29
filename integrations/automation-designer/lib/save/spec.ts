// A method spec file → the V2 body `ad create` would POST. Shared by `create`
// and by `lint` / `validate`, which accept the same compact spec (
// they rejected it, so agents had to dig `data.body` out of `create --dry-run`).

import { dirname } from "path";
import { CliError, isObj, readJsonInput } from "@belzabar/core";
import { resolveMethodRef } from "@belzabar/core/platform";
import * as v2 from "../api/v2";
import type { V2MethodBody } from "../types/v2-wire";
import { fetchCategories, requireChainCategory, type Category } from "../categories";
import { isRawV2Step } from "../serialize/compact";
import { assertCreatableCategory, buildCreateBody, compactSteps } from "./create";
import { loadServiceCatalog, servicesOfCompactSteps } from "./services";
import { resolveSpecSources } from "./sources";

/** Read + parse a spec file and inline its codeFile / sqlFile references. */
export async function readSpecFile(path: string): Promise<unknown> {
  const invalid = (err: unknown) => new CliError(`Invalid JSON in spec file ${path}: ${String(err)}`, { code: "INVALID_JSON" });
  const spec = await readJsonInput(path, {
    unreadable: (err, missing) =>
      missing ? new CliError(`Cannot read spec file ${path}: ${String(err)}`, { code: "FILE_NOT_FOUND" }) : invalid(err),
    invalid,
  });
  await resolveSpecSources(spec, dirname(path));
  return spec;
}

/**
 * A compact spec (needs expanding) rather than a V2 body: a compact step
 * (`service`/`sql`/`code`/`codeFile`/`sqlFile`), a method field given as a bare
 * key string, or a `category` without V2 `metadata`.
 */
export function isCompactSpec(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (Array.isArray(v.steps) && v.steps.some((s) => isObj(s) && !isRawV2Step(s))) return true;
  if ((["inputs", "outputs", "variables"] as const).some((k) => Array.isArray(v[k]) && (v[k] as unknown[]).some((f) => typeof f === "string"))) return true;
  return "category" in v && !isObj(v.metadata);
}

interface ExpandedSpec {
  body: Record<string, unknown>;
  /** Server-owned spec keys that were dropped. */
  dropped: string[];
  category: Category & { chainCategoryId: number };
}

/**
 * Expand a spec against the active env: resolve the category (`categoryFlag`
 * or `spec.category`, which must agree), refuse core categories, and check
 * compact steps against the callee contracts.
 */
export async function expandSpec(spec: unknown, categoryFlag: string | null): Promise<ExpandedSpec> {
  const specCategory = isObj(spec) ? spec.category : undefined;
  if (specCategory !== undefined && typeof specCategory !== "string" && typeof specCategory !== "number") {
    throw new CliError("spec.category must be a category name, id or uuid.", { code: "AD_SPEC_INVALID", details: { path: "category" } });
  }
  const categoryRef = categoryFlag ?? (specCategory === undefined ? null : String(specCategory));
  if (!categoryRef) {
    throw new CliError("--category <name|id|uuid> is required (or set category in the spec).", { code: "MISSING_CATEGORY" });
  }
  const categories = await fetchCategories();
  const category = requireChainCategory(categories, categoryRef);
  if (categoryFlag && specCategory !== undefined && requireChainCategory(categories, String(specCategory)).chainCategoryId !== category.chainCategoryId) {
    throw new CliError(`--category ${categoryFlag} and spec.category ${String(specCategory)} name different categories.`, {
      code: "AD_SPEC_INVALID",
      details: { flag: categoryFlag, spec: specCategory },
    });
  }
  assertCreatableCategory(category);
  const catalog = await loadServiceCatalog(servicesOfCompactSteps(compactSteps(spec)));
  const { body, dropped } = buildCreateBody(spec, category, catalog);
  return { body, dropped, category };
}

export interface LoadedBody<T> {
  body: T;
  /** Set when the file was a compact spec, expanded as `ad create --dry-run` would. */
  spec: { expanded: true; dropped: string[]; category: { chainCategoryId: number; name: string } } | null;
}

/**
 * A local file for `lint` / `validate`: a V2 body is used as-is; a compact
 * create spec is expanded first (needs the env: category + callee contracts).
 */
async function loadBodyOrSpec<T>(path: string, categoryFlag: string | null): Promise<LoadedBody<T>> {
  const raw = await readSpecFile(path);
  if (!isCompactSpec(raw)) {
    if (categoryFlag) throw new CliError("--category applies only to a compact spec file.", { code: "INVALID_ARGUMENT" });
    return { body: raw as T, spec: null };
  }
  const { body, dropped, category } = await expandSpec(raw, categoryFlag);
  return { body: body as T, spec: { expanded: true, dropped, category: { chainCategoryId: category.chainCategoryId, name: category.name } } };
}

/**
 * The `<uuid|file>` argument of `lint` / `validate`: a path (ends in `.json`,
 * contains `/` or starts with `.`), otherwise a method uuid (canonicalised).
 */
export function methodTarget(input: string): { kind: "uuid" | "file"; target: string } {
  const isFile = input.endsWith(".json") || input.includes("/") || input.startsWith(".");
  return isFile ? { kind: "file", target: input } : { kind: "uuid", target: resolveMethodRef(input) };
}

/** The V2 body a `<uuid|file>` target names: the local file (body or compact spec) or the saved method. */
export async function loadTargetBody(
  t: { kind: "uuid" | "file"; target: string },
  categoryFlag: string | null,
): Promise<LoadedBody<V2MethodBody>> {
  if (t.kind === "file") return loadBodyOrSpec<V2MethodBody>(t.target, categoryFlag);
  if (categoryFlag) throw new CliError("--category applies only to a compact spec file.", { code: "INVALID_ARGUMENT" });
  return { body: await v2.fetchRawMethod(t.target), spec: null };
}
