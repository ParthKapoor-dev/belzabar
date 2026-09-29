// One category identity model (AD-09, AD-10, F9).
//
// The platform has two id spaces for what the UI calls a "category":
//   - the chain category (`/chain/category?fetchSystemServices=false`,
//     `/automation/services`): e.g. id 42 for one category. This is
//     what methods carry as `category`, what `POST /chain` and
//     `/chain/export/category/{id}` accept, and what `ad find` indexes.
//   - the automation system (`/chain/category?fetchSystemServices=true`):
//     e.g. id 57 for the same one; a user system points back with
//     `automationChainCategoryId`, a chain category points at its system with
//     `automationSystemUuid`.
// SYSTEM_GENERATED services (db_service, …) exist only as systems: they carry
// system ids in both lists and have no chain category.
// Uuids come padded with 4 spaces; every uuid here is trimmed, never padded.

import { CliError, num, strOrNull } from "@belzabar/core";
import { normalizeUuid } from "@belzabar/core/platform";
import { adApi } from "./api/index";

export interface Category {
  /** Chain-category id (methods' `category.id`); null for SYSTEM_GENERATED services. */
  chainCategoryId: number | null;
  chainCategoryUuid: string | null;
  /** Automation-system id/uuid. */
  systemId: number | null;
  systemUuid: string | null;
  name: string;
  type: "USER_GENERATED" | "SYSTEM_GENERATED" | string;
  label?: string;
}

type Row = Record<string, unknown>;

function rows(payload: unknown): Row[] {
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { categories?: unknown })?.categories)
      ? (payload as { categories: unknown[] }).categories
      : Array.isArray((payload as { result?: unknown })?.result)
        ? (payload as { result: unknown[] }).result
        : [];
  return arr.filter((r): r is Row => !!r && typeof r === "object" && !Array.isArray(r));
}


/**
 * Join the chain-category list with the system list into one row per
 * category. `systemList` may be empty (then systemId is unknown for user
 * categories).
 */
export function buildCategories(chainList: unknown, systemList: unknown): Category[] {
  const systems = rows(systemList);
  const sysByUuid = new Map<string, Row>();
  const sysByChainId = new Map<number, Row>();
  for (const s of systems) {
    const u = normalizeUuid(s.uuid);
    if (u) sysByUuid.set(u, s);
    const cid = num(s.automationChainCategoryId);
    if (cid !== null) sysByChainId.set(cid, s);
  }

  const out: Category[] = [];
  const seen = new Set<string>();
  for (const c of rows(chainList)) {
    const name = strOrNull(c.name) ?? strOrNull(c.label);
    if (!name) continue;
    const type = strOrNull(c.type) ?? "";
    const label = strOrNull(c.label) ?? undefined;
    if (type === "SYSTEM_GENERATED") {
      const systemUuid = normalizeUuid(c.uuid);
      out.push({ chainCategoryId: null, chainCategoryUuid: null, systemId: num(c.id), systemUuid, name, type, label });
      if (systemUuid) seen.add(systemUuid);
      continue;
    }
    const chainCategoryId = num(c.id);
    const chainUuid = normalizeUuid(c.uuid);
    // Old categories (e.g. "Dipsi Practice") have no automationSystemUuid; their
    // system shares the chain category's uuid.
    const sys =
      (normalizeUuid(c.automationSystemUuid) && sysByUuid.get(normalizeUuid(c.automationSystemUuid)!)) ||
      (chainCategoryId !== null ? sysByChainId.get(chainCategoryId) : undefined) ||
      (chainUuid ? sysByUuid.get(chainUuid) : undefined);
    const systemUuid = normalizeUuid(c.automationSystemUuid) ?? (sys ? normalizeUuid(sys.uuid) : null);
    out.push({
      chainCategoryId,
      chainCategoryUuid: chainUuid,
      systemId: sys ? num(sys.id) : null,
      systemUuid,
      name,
      type,
      label,
    });
    if (systemUuid) seen.add(systemUuid);
  }
  // Systems with no chain-category row (not expected, but never drop data).
  for (const s of systems) {
    const u = normalizeUuid(s.uuid);
    const name = strOrNull(s.name) ?? strOrNull(s.label);
    if (!name || (u && seen.has(u))) continue;
    out.push({
      chainCategoryId: num(s.automationChainCategoryId),
      chainCategoryUuid: null,
      systemId: num(s.id),
      systemUuid: u,
      name,
      type: strOrNull(s.type) ?? "",
      label: strOrNull(s.label) ?? undefined,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a user's category reference: chain-category id, chain-category or
 * system uuid (padding/case ignored), exact name (case-insensitive), or — if
 * no chain category has that number — a system id. Null when nothing matches.
 */
export function findCategory(categories: Category[], ref: string): Category | null {
  const r = ref.trim();
  if (!r) return null;
  if (/^\d+$/.test(r)) {
    const n = Number(r);
    return categories.find((c) => c.chainCategoryId === n) ?? categories.find((c) => c.systemId === n) ?? null;
  }
  const lower = r.toLowerCase();
  return (
    categories.find((c) => c.chainCategoryUuid?.toLowerCase() === lower || c.systemUuid?.toLowerCase() === lower) ??
    categories.find((c) => c.name.toLowerCase() === lower) ??
    null
  );
}

/** Like findCategory, but a chain category is required (export, create target). */
export function requireChainCategory(categories: Category[], ref: string): Category & { chainCategoryId: number } {
  const c = findCategory(categories, ref);
  if (!c) {
    throw new CliError(`No AD category matches '${ref}' (tried chain-category id, uuid, system id/uuid, name).`, {
      code: "CATEGORY_NOT_FOUND",
      details: { ref },
    });
  }
  if (c.chainCategoryId === null) {
    throw new CliError(`'${c.name}' is a ${c.type || "system"} service with no chain category; it has no methods to export.`, {
      code: "CATEGORY_NOT_CHAIN",
      details: { ref, category: c },
    });
  }
  return c as Category & { chainCategoryId: number };
}

/** Both listings, joined. Two GETs (the chain list and the system list). */
export async function fetchCategories(): Promise<Category[]> {
  const [chain, systems] = await Promise.all([
    adApi.listCategories({ includeSystem: false }),
    adApi.listCategories({ includeSystem: true }),
  ]);
  return buildCategories(chain, systems);
}
