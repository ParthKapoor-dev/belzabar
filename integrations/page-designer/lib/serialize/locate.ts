// Locate overlay targets inside the RAW inner configuration, by their real
// array index (PD-2: indices are never taken from the parsed, de-duplicated
// lists). Used by applyOverlay and by the partial-ops serializer.

import { isDerivedEntry } from "../parser/variables";
import type { RawConfiguration } from "../types/wire";

/** True for old-format pages: variables live in `context.properties` tuples. */
export function usesLegacyVariables(inner: RawConfiguration): boolean {
  const ud = inner.variables?.userDefined;
  return !(Array.isArray(ud) && ud.length > 0) && Array.isArray(inner.context?.properties);
}

/** True when the page has the old flat `http` array. */
export function usesLegacyHttp(inner: RawConfiguration): boolean {
  return Array.isArray(inner.http) && inner.http.length > 0;
}

interface Located {
  /** Dot-notation key of the containing array, e.g. `variables.userDefined`. */
  list: string;
  index: number;
}

/** A plain (non-derived) variable, first match by name. */
export function locateVariable(inner: RawConfiguration, name: string): Located | null {
  if (usesLegacyVariables(inner)) {
    const props = inner.context!.properties!;
    const index = props.findIndex((p) => Array.isArray(p) && p[0] === name);
    return index < 0 ? null : { list: "context.properties", index };
  }
  const ud = inner.variables?.userDefined;
  if (!Array.isArray(ud)) return null;
  const index = ud.findIndex((v) => v && typeof v === "object" && v.name === name && !isDerivedEntry(v));
  return index < 0 ? null : { list: "variables.userDefined", index };
}

/** A derived variable: an entry of variables.derived / context.derived, or a userDefined entry with `from`. */
export function locateDerived(inner: RawConfiguration, name: string): Located | null {
  const ud = inner.variables?.userDefined;
  if (Array.isArray(ud)) {
    const index = ud.findIndex((v) => isDerivedEntry(v) && v.name === name);
    if (index >= 0) return { list: "variables.userDefined", index };
  }
  for (const [list, arr] of [
    ["variables.derived", inner.variables?.derived],
    ["context.derived", inner.context?.derived],
  ] as const) {
    if (!Array.isArray(arr)) continue;
    const index = arr.findIndex((d) => d && typeof d === "object" && d.name === name);
    if (index >= 0) return { list, index };
  }
  return null;
}

/** An HTTP request by its serviceCall.callId, in generated / userDefined / legacy `http`. */
export function locateHttp(inner: RawConfiguration, callId: string): Located | null {
  for (const [list, arr] of [
    ["httpRequests.userDefined", inner.httpRequests?.userDefined],
    ["httpRequests.generated", inner.httpRequests?.generated],
    ["http", inner.http],
  ] as const) {
    if (!Array.isArray(arr)) continue;
    const index = arr.findIndex((h) => h?.meta?.serviceCall?.callId === callId);
    if (index >= 0) return { list, index };
  }
  return null;
}
