// Variable / derived-variable parser. Handles both config formats:
//   - New:    configuration.variables.userDefined : RawUserDefinedVar[]
//   - Legacy: configuration.context.properties    : [name, value][]
//
// Output is always the normalized unified shape (PageVariable / PageDerivedVariable).

import type { PageDerivedVariable, PageVariable } from "../types/common";
import type { RawConfiguration, RawDerivedVar, RawUserDefinedVar } from "../types/wire";

export interface ParsedVariablesResult {
  userDefined: PageVariable[];
  derived: PageDerivedVariable[];
  warnings: string[];
}

export function parseVariables(config: RawConfiguration): ParsedVariablesResult {
  const warnings: string[] = [];
  const userDefined: PageVariable[] = [];
  const seen = new Set<string>();

  const addUserDefined = (raw: RawUserDefinedVar | [string, unknown]): void => {
    if (Array.isArray(raw)) {
      const [name, initial] = raw;
      if (!name) return;
      if (seen.has(name)) {
        warnings.push(`duplicate variable "${name}" in context.properties`);
        return;
      }
      seen.add(name);
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
    if (seen.has(raw.name)) {
      warnings.push(`duplicate variable "${raw.name}" in variables.userDefined`);
      return;
    }
    seen.add(raw.name);
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

  const rawDerived: RawDerivedVar[] =
    config.variables?.derived ?? config.context?.derived ?? [];

  const derived: PageDerivedVariable[] = rawDerived.map((d) => ({
    name: d.name,
    from: Array.isArray(d.from) ? d.from : [],
    spec: d.spec ?? null,
    filterFn: d.filterFn ?? null,
    sideEffect: d.sideEffect === true,
    raw: d,
  }));

  return { userDefined, derived, warnings };
}
