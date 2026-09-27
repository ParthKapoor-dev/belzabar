// Page-parser façade. Turns a raw wire response into a HydratedPage.
//
// Commands import parsePage from here. The parser is pure — no network, no
// caching, no side effects. Parse warnings accumulate on the returned page.

import type { HydratedPage, PdEntityType, PdStatus } from "../types/common";
import type { RawConfiguration, RawLayoutNode, RawPageResponse } from "../types/wire";
import { parseHttpRequests } from "./http";
import { parseLayout } from "./nodes";
import { parseVariables } from "./variables";

function parseConfigurationString(str: string, warnings: string[]): RawConfiguration {
  if (!str) {
    warnings.push("configuration field is empty");
    return {};
  }
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === "object") return parsed as RawConfiguration;
    warnings.push("configuration did not parse to an object");
    return {};
  } catch (err) {
    warnings.push(`configuration JSON parse failed: ${String(err)}`);
    return {};
  }
}

/**
 * PAGE vs COMPONENT, from the server's own fields first (PD-10 / F17):
 *   1. `isComponent` (boolean on every GET /pages/{id} component body)
 *   2. `pageType` ("PAGE" | "COMPONENT", when present)
 *   3. a non-empty `relativeRoute` — only pages are routable
 * Only when none is present (e.g. a hand-built body) fall back to the config
 * shape. The root `isSymbol` flag alone is NOT decisive: real pages copy it
 * (e.g. both sems-dev "Add Student" pages have `layout.isSymbol: true`).
 */
export function inferEntityType(raw: RawPageResponse, inner: RawConfiguration = {}): PdEntityType {
  if (typeof raw.isComponent === "boolean") return raw.isComponent ? "COMPONENT" : "PAGE";
  const pageType = typeof raw.pageType === "string" ? raw.pageType.toUpperCase() : "";
  if (pageType === "COMPONENT" || pageType === "SYMBOL") return "COMPONENT";
  if (pageType === "PAGE") return "PAGE";
  if (typeof raw.relativeRoute === "string" && raw.relativeRoute.trim()) return "PAGE";
  const layout = inner.layout as RawLayoutNode | undefined;
  if (layout?.isSymbol === true) return "COMPONENT";
  if (Array.isArray(inner.inputs) || Array.isArray(inner.events)) return "COMPONENT";
  return "PAGE";
}

function inferStatus(raw: RawPageResponse): PdStatus {
  return raw.status === "PUBLISHED" ? "PUBLISHED" : "DRAFT";
}

export function parsePage(raw: RawPageResponse): HydratedPage {
  const warnings: string[] = [];
  const rawConfigurationString = typeof raw.configuration === "string" ? raw.configuration : "";
  const inner = parseConfigurationString(rawConfigurationString, warnings);

  const { userDefined, derived, warnings: varWarnings } = parseVariables(inner);
  warnings.push(...varWarnings);

  const { root: layout, warnings: layoutWarnings, duplicateIds } = parseLayout(inner.layout, userDefined);
  warnings.push(...layoutWarnings);
  for (const dupId of duplicateIds) {
    warnings.push(`duplicate node id "${dupId}"`);
  }

  const httpRequests = parseHttpRequests(inner);

  const entityType = inferEntityType(raw, inner);
  const status = inferStatus(raw);

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    name: typeof raw.name === "string" ? raw.name : "",
    entityType,
    status,
    versionId: typeof raw.versionId === "number" ? raw.versionId : null,
    aliasName: typeof raw.aliasName === "string" ? raw.aliasName : null,
    __version: typeof inner.__version === "number" ? inner.__version : null,
    layout,
    styles: typeof inner.styles === "string" ? inner.styles : "",
    variables: userDefined,
    derived,
    httpRequests,
    inputs: Array.isArray(inner.inputs) ? (inner.inputs as string[]) : [],
    events: Array.isArray(inner.events) ? (inner.events as string[]) : [],
    helpText: (inner.helpText as Record<string, unknown>) ?? {},
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === "number" ? raw.updatedBy : null,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : null,
    createdBy: typeof raw.createdBy === "number" ? raw.createdBy : null,
    raw,
    rawConfiguration: inner,
    rawConfigurationString,
    parseWarnings: warnings,
  };
}

export { findNode, walkParsed } from "./nodes";
export { cleanAdId, extractBindingReferences } from "./refs";
