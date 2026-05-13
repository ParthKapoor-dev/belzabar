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

function inferEntityType(raw: RawPageResponse, inner: RawConfiguration): PdEntityType {
  // A symbol/component has `isSymbol: true` on its root layout node. Pages have
  // `unSelectable: true` on theirs. If neither is set — fall back to checking
  // for the presence of top-level `inputs`/`events` arrays (symbol-only).
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

// Legacy extractors — still used by `show`, `find-ad-methods`, `analyze`.
// Prefer parsePage()/validateHydrated() in new code.
export {
  extractReferences,
  extractDirectChildComponentNames,
  extractVariables,
  extractHttpSummary,
  extractEventHandlers,
  extractComponentTree,
  extractHttpDetail,
  extractVarDetail,
  validateConfig,
} from "./legacy";
export type { HttpCallDetail, VarDetail } from "./legacy";
