// A report's datasource is a published AD method, stored in the configuration
// as env-local ids: `dataSourceId` (the published method's numeric chain id)
// and `dataSourceCategoryUuid`. Specs name it portably as {category, method};
// this module converts between the two on the active env.

import { CliError, Config, str } from "@belzabar/core";
import { normalizeUuid } from "@belzabar/core/platform";
import { listDatasourceCategories, listDatasources } from "./api";

export interface DataSourceRef {
  /** AD category name. */
  category: string;
  /** Published AD method name. */
  method: string;
}

export interface ResolvedDataSource extends DataSourceRef {
  /** Numeric chain id of the published method, as a string (the configuration's `dataSourceId`). */
  id: string;
  categoryUuid: string;
}

interface Category {
  name: string;
  uuid: string;
  aliases: string[];
}

interface DataSourceRow {
  id: string;
  method: string;
  description: string | null;
}

// Per process and env: one command resolves the same category a few times.
const categoryMemo = new Map<string, Promise<Category[]>>();
const dataSourceMemo = new Map<string, Promise<DataSourceRow[]>>();

export function categories(): Promise<Category[]> {
  const env = Config.activeEnv.name;
  let p = categoryMemo.get(env);
  if (!p) {
    p = listDatasourceCategories().then((rows) =>
      rows.flatMap((r) => {
        const name = str(r.name);
        const uuid = normalizeUuid(r.uuid);
        if (!name || !uuid) return [];
        const aliases = Array.isArray(r.aliasName) ? r.aliasName.filter((a): a is string => typeof a === "string") : [];
        return [{ name, uuid, aliases }];
      }),
    );
    p.catch(() => categoryMemo.delete(env));
    categoryMemo.set(env, p);
  }
  return p;
}

export function dataSourcesOf(categoryUuid: string): Promise<DataSourceRow[]> {
  const key = `${Config.activeEnv.name}\0${categoryUuid}`;
  let p = dataSourceMemo.get(key);
  if (!p) {
    p = listDatasources(categoryUuid).then((rows) =>
      rows.flatMap((r) => {
        const id = r.id === undefined || r.id === null ? "" : String(r.id);
        const method = str(r.label);
        return id && method ? [{ id, method, description: str(r.description) ?? null }] : [];
      }),
    );
    p.catch(() => dataSourceMemo.delete(key));
    dataSourceMemo.set(key, p);
  }
  return p;
}

/** Category by name or alias (case-insensitive), or by uuid. */
export async function findCategory(nameOrUuid: string): Promise<Category | null> {
  const q = nameOrUuid.trim().toLowerCase();
  const all = await categories();
  return (
    all.find((c) => c.uuid.toLowerCase() === q) ??
    all.find((c) => c.name.toLowerCase() === q) ??
    all.find((c) => c.aliases.some((a) => a.toLowerCase() === q)) ??
    null
  );
}

/** {category, method} → the env-local ids. Throws when either is missing on this env. */
export async function resolveDataSource(ref: DataSourceRef): Promise<ResolvedDataSource> {
  const env = Config.activeEnv.name;
  const category = await findCategory(ref.category);
  if (!category) {
    throw new CliError(`Datasource category '${ref.category}' does not exist on ${env}.`, {
      code: "RD_DATASOURCE_CATEGORY_NOT_FOUND",
      details: { env, category: ref.category },
    });
  }
  const rows = await dataSourcesOf(category.uuid);
  const hits = rows.filter((r) => r.method === ref.method);
  const hit = hits[0] ?? rows.find((r) => r.method.toLowerCase() === ref.method.toLowerCase());
  if (!hit) {
    throw new CliError(
      `No published method '${ref.method}' in category '${category.name}' on ${env}. A report datasource must be a published ` +
        "AD method: publish it there (belz ad publish) or migrate it to this env first.",
      { code: "RD_DATASOURCE_NOT_FOUND", details: { env, category: category.name, method: ref.method } },
    );
  }
  if (hits.length > 1) {
    throw new CliError(`Category '${category.name}' on ${env} has ${hits.length} published methods named '${ref.method}'.`, {
      code: "RD_DATASOURCE_AMBIGUOUS",
      details: { env, category: category.name, method: ref.method, ids: hits.map((h) => h.id) },
    });
  }
  return { category: category.name, method: hit.method, id: hit.id, categoryUuid: category.uuid };
}

/** The env-local ids → names; null fields when the category or method is no longer listed. */
export async function describeDataSource(
  id: string | null,
  categoryUuid: string | null,
): Promise<{ category: string | null; method: string | null }> {
  if (!categoryUuid) return { category: null, method: null };
  const category = await findCategory(categoryUuid);
  if (!category) return { category: null, method: null };
  const row = id ? (await dataSourcesOf(category.uuid)).find((r) => r.id === id) : undefined;
  return { category: category.name, method: row?.method ?? null };
}
