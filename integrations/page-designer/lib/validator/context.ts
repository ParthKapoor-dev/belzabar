// Shared, once-per-page facts every rule reads (built by validateHydrated).
//
// Calibrated against the real sems-dev fixtures (tests/fixtures/real, PD-5):
//   - a binding `{%a.b[0].c%}` refers to the variable `a` (root segment);
//   - variables come from userDefined, derived, variables.generated (editor-
//     owned: form configs, `$$navigation*`, `requestEvent*`), and a component's
//     `inputs`;
//   - `$item` / `$row` / `$event` / `$$…` and `pageContext` are runtime scope,
//     never declared;
//   - bindings that only occur inside `variables.generated` are editor-owned
//     (form-builder configs) and are reported separately (warn, not error).

import type { HydratedPage } from "../types/common";
import type { RawConfiguration } from "../types/wire";

export interface RuleContext {
  /** Every `{%ref%}` outside `variables.generated` (author-owned config). */
  bindingRefs: Set<string>;
  /** `{%ref%}`s that occur ONLY inside `variables.generated`. */
  generatedBindingRefs: Set<string>;
  /** Names a binding may resolve to: userDefined + derived + generated + component inputs. */
  definedVarNames: Set<string>;
  /** Root variable names referenced anywhere (bindings, derived.from, triggers, input bindings, `this.x`). */
  usedRoots: Set<string>;
}

const BINDING_RE = /\{%([^%]+)%\}/g;

/** Runtime-scope roots that are never declared as page variables. */
const BUILTIN_ROOTS = new Set(["pageContext", "null", "true", "false", "undefined", "this"]);

export function collectBindingRefs(text: string, into = new Set<string>()): Set<string> {
  BINDING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BINDING_RE.exec(text)) !== null) {
    if (m[1]) into.add(m[1]);
  }
  return into;
}

/**
 * The variable a binding expression refers to: its leading identifier
 * (`a.b[0]` → `a`, ` x ` → `x`, `!flag` → `flag`). `null` when the
 * expression does not start with an identifier (a literal / expression).
 */
export function bindingRoot(ref: string): string | null {
  const m = ref.match(/^[\s!(]*([A-Za-z_$][\w$-]*)/);
  return m?.[1] ?? null;
}

/** True for runtime-scope references ($item, $row, $$nav…, pageContext, literals). */
export function isBuiltinRoot(root: string): boolean {
  return root.startsWith("$") || BUILTIN_ROOTS.has(root);
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
      out.push((item as { name: string }).name);
    } else if (Array.isArray(item) && typeof item[0] === "string") {
      out.push(item[0]); // legacy context.properties tuple
    }
  }
  return out;
}

export function buildRuleContext(page: HydratedPage): RuleContext {
  const inner = (page.rawConfiguration ?? {}) as RawConfiguration;
  const generated = Array.isArray(inner.variables?.generated) ? inner.variables!.generated! : [];

  // Author scope = the whole config minus variables.generated.
  let authorText = page.rawConfigurationString;
  let generatedText = "";
  if (generated.length > 0) {
    const { generated: _g, ...restVars } = inner.variables ?? {};
    authorText = JSON.stringify({ ...inner, variables: restVars });
    generatedText = JSON.stringify(generated);
  }
  const bindingRefs = collectBindingRefs(authorText);
  const generatedBindingRefs = new Set<string>();
  for (const ref of collectBindingRefs(generatedText)) if (!bindingRefs.has(ref)) generatedBindingRefs.add(ref);

  // Trimmed too: the editor keeps names verbatim (sems-dev "Student
  // Information" has a derived var " loaderTextNull" bound as {% loaderTextNull%}).
  const definedVarNames = new Set<string>();
  for (const n of [
    ...page.variables.map((v) => v.name),
    ...page.derived.map((d) => d.name),
    ...names(generated),
    ...page.inputs.filter((i): i is string => typeof i === "string"),
  ]) {
    definedVarNames.add(n);
    definedVarNames.add(n.trim());
  }

  const usedRoots = new Set<string>();
  for (const ref of [...bindingRefs, ...generatedBindingRefs]) {
    const root = bindingRoot(ref);
    if (root) usedRoots.add(root);
  }
  for (const d of page.derived) for (const f of d.from) usedRoots.add(bindingRoot(f) ?? f);
  for (const g of generated) {
    const from = (g as { from?: unknown })?.from;
    if (Array.isArray(from)) for (const f of from) if (typeof f === "string") usedRoots.add(bindingRoot(f) ?? f);
  }
  for (const call of page.httpRequests) {
    for (const t of call.triggers) usedRoots.add(bindingRoot(t) ?? t);
    for (const b of call.inputBindings) if (b.bindingVariable) usedRoots.add(bindingRoot(b.bindingVariable) ?? b.bindingVariable);
  }
  // `this.x` / `pageContext.x` references (event handlers, triggers, custom
  // code, `${pageContext.x}` templates) and `${x…}` template roots.
  const text = page.rawConfigurationString;
  const memberRe = /\b(?:this|pageContext)\.([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(text)) !== null) if (m[1]) usedRoots.add(m[1]);
  const templateRe = /\$\{\s*!?\s*([A-Za-z_$][\w$-]*)/g;
  while ((m = templateRe.exec(text)) !== null) if (m[1]) usedRoots.add(m[1]);

  return { bindingRefs, generatedBindingRefs, definedVarNames, usedRoots };
}
