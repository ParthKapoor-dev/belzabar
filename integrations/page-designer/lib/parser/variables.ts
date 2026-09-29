// Variable / derived-variable parser. Handles both config formats:
//   - New:    configuration.variables.userDefined : RawUserDefinedVar[]
//   - Legacy: configuration.context.properties    : [name, value][]
//
// Real editor output (every real fixture) keeps DERIVED variables inside
// `variables.userDefined` — entries with a `from` array and a `spec` — and
// leaves `variables.derived` empty. Those entries are parsed as derived
// (`location: "userDefined"`); entries of `variables.derived` / `context.derived`
// get `location: "derived"`. The serializer never rebuilds these arrays from
// the parsed lists — it edits the raw config in place (lossless).
//
// Output is always the normalized unified shape (PageVariable / PageDerivedVariable).

import type { PageDerivedVariable, PageVariable } from "../types/common";
import type { RawConfiguration, RawDerivedVar, RawUserDefinedVar } from "../types/wire";

interface ParsedVariablesResult {
  userDefined: PageVariable[];
  derived: PageDerivedVariable[];
  warnings: string[];
}

/** A userDefined entry the editor uses as a derived variable (has a `from` array). */
export function isDerivedEntry(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { from?: unknown }).from);
}

function toDerived(d: RawDerivedVar, location: PageDerivedVariable["location"]): PageDerivedVariable {
  return {
    name: d.name,
    from: Array.isArray(d.from) ? d.from : [],
    spec: typeof d.spec === "string" ? d.spec : null,
    filterFn: typeof d.filterFn === "string" ? d.filterFn : null,
    sideEffect: d.sideEffect === true,
    location,
    raw: d,
  };
}

export function parseVariables(config: RawConfiguration): ParsedVariablesResult {
  const warnings: string[] = [];
  const userDefined: PageVariable[] = [];
  const derived: PageDerivedVariable[] = [];
  const seen = new Set<string>();

  const claim = (name: string, where: string): boolean => {
    if (seen.has(name)) {
      warnings.push(`duplicate variable "${name}" in ${where}`);
      return false;
    }
    seen.add(name);
    return true;
  };

  const addUserDefined = (raw: RawUserDefinedVar | [string, unknown]): void => {
    if (Array.isArray(raw)) {
      const [name, initial] = raw;
      if (!name || !claim(name, "context.properties")) return;
      userDefined.push({
        name,
        type: null,
        initialValue: initial ?? null,
        translateInitialValue: undefined,
        raw,
      });
      return;
    }

    if (!raw || typeof raw !== "object" || typeof raw.name !== "string") return;
    if (!claim(raw.name, "variables.userDefined")) return;
    if (isDerivedEntry(raw)) {
      derived.push(toDerived(raw as RawDerivedVar, "userDefined"));
      return;
    }
    userDefined.push({
      name: raw.name,
      type: raw.type ?? null,
      initialValue: raw.initialValue ?? null,
      translateInitialValue: raw.translateInitialValue,
      raw,
    });
  };

  if (Array.isArray(config.variables?.userDefined) && config.variables!.userDefined!.length > 0) {
    for (const v of config.variables!.userDefined!) addUserDefined(v);
  } else if (Array.isArray(config.context?.properties)) {
    for (const pair of config.context!.properties!) addUserDefined(pair);
  }

  const rawDerived: RawDerivedVar[] = config.variables?.derived ?? config.context?.derived ?? [];
  for (const d of Array.isArray(rawDerived) ? rawDerived : []) {
    if (!d || typeof d !== "object" || typeof d.name !== "string") continue;
    if (!claim(d.name, "variables.derived")) continue;
    derived.push(toDerived(d, "derived"));
  }

  return { userDefined, derived, warnings };
}
