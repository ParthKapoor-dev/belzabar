// Form-builder configs. An `exp-form-builder` node renders a form whose whole
// definition lives OUTSIDE the layout tree: in a generated variable
// (`variables.generated[i]`, `isFormVariable: true`, named
// `__form_config_var…`) that the node binds through its `[formConfig]` prop
// (`this.<var>` or `{%<var>%}`). Inside its initialValue: `form.fields[]`
// (fields; some carry a `layoutConfig` node tree of their own), action
// buttons, event handlers (`events: {valueChange: [[target, code, filter]]}`)
// and two-way `[(value)]` bindings. `show --var-graph / --node / --find /
// --var-detail` read them through this module. Pure.

import { isObj } from "@belzabar/core";
import { parseLayout, walkParsed } from "./parser/nodes";
import type { HydratedPage, ParsedNode } from "./types/common";
import type { RawLayoutNode } from "./types/wire";

/** The variable a handler target or binding names: `{%x%}`, `this.x`, `pageContext.x` → `x`. */
export function targetVariable(target: unknown): string | null {
  if (typeof target !== "string") return null;
  const t = target.trim();
  const tpl = t.match(/^\{%\s*([^%]+?)\s*%\}$/);
  if (tpl) return tpl[1]!;
  const ref = t.match(/^(?:this|pageContext)\.([\w$]+)$/);
  return ref ? ref[1]! : null;
}

interface FormConfig {
  /** The generated variable holding the form. */
  variable: string;
  /** Its config path (`variables.generated[i]`). */
  path: string;
  type: string | null;
  /** exp-form-builder nodes whose `[formConfig]` names it. */
  builderNodeIds: string[];
  /** The form's own node trees (every `layoutConfig`), parsed like the page layout. */
  trees: ParsedNode[];
  initialValue: unknown;
}

/** form variable → the exp-form-builder node ids bound to it. */
function builderBindings(page: HydratedPage): Map<string, string[]> {
  const out = new Map<string, string[]>();
  walkParsed(page.layout, (n) => {
    if (n.tagName !== "exp-form-builder") return;
    const v = targetVariable(n.props["[formConfig]"]);
    if (v) out.set(v, [...(out.get(v) ?? []), n.nodeId]);
  });
  return out;
}

const sub = (path: string, key: string | number) => (typeof key === "number" ? `${path}[${key}]` : `${path}.${key}`);

function collectTrees(v: unknown, path: string, page: HydratedPage, out: ParsedNode[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => collectTrees(x, sub(path, i), page, out));
    return;
  }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (k === "layoutConfig" && isObj(x)) out.push(parseLayout(x as RawLayoutNode, page.variables, sub(path, k)).root);
    collectTrees(x, sub(path, k), page, out);
  }
}

/** Every form config of the page: generated variables marked as forms or bound by an exp-form-builder. */
export function formConfigs(page: HydratedPage): FormConfig[] {
  const generated = (page.rawConfiguration as { variables?: { generated?: unknown } } | null)?.variables?.generated;
  if (!Array.isArray(generated)) return [];
  const bound = builderBindings(page);
  const out: FormConfig[] = [];
  generated.forEach((e, i) => {
    if (!isObj(e) || typeof e.name !== "string") return;
    const iv = e.initialValue;
    if (e.isFormVariable !== true && !bound.has(e.name) && !(isObj(iv) && isObj(iv.form))) return;
    const path = `variables.generated[${i}]`;
    const trees: ParsedNode[] = [];
    collectTrees(iv, `${path}.initialValue`, page, trees);
    out.push({
      variable: e.name,
      path,
      type: typeof e.type === "string" ? e.type : null,
      builderNodeIds: bound.get(e.name) ?? [],
      trees,
      initialValue: iv,
    });
  });
  return out;
}

interface FormRef {
  /** The page variable written or read. */
  variable: string;
  /** The form config it is in. */
  form: string;
  /** The nearest node id (or field name) around it. */
  nodeId: string;
  /** `event:<name>` (handler target), `[(value)]` (two-way binding) or the prop holding a `{%var%}` binding. */
  via: string;
  /** Config path of the handler list / prop. */
  path: string;
}

const BINDING = /\{%\s*([\w$]+)/g;

/** Variables written (event handler targets, `[(value)]`) and read (`{%var%}` bindings) inside every form. */
export function formRefs(page: HydratedPage, forms = formConfigs(page)): { writes: FormRef[]; reads: FormRef[] } {
  const writes: FormRef[] = [];
  const reads: FormRef[] = [];
  for (const f of forms) {
    const walk = (v: unknown, path: string, nodeId: string): void => {
      if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, sub(path, i), nodeId));
        return;
      }
      if (!isObj(v)) return;
      const here =
        typeof v.id === "string" && typeof v.name === "string" ? v.id : typeof v.name === "string" && v.name.startsWith("__") ? v.name : nodeId;
      for (const [k, x] of Object.entries(v)) {
        const at = sub(path, k);
        if (k === "events" && isObj(x)) {
          for (const [ev, handlers] of Object.entries(x)) {
            if (!Array.isArray(handlers)) continue;
            for (const h of handlers) {
              const target = targetVariable(Array.isArray(h) ? h[0] : null);
              if (target) writes.push({ variable: target, form: f.variable, nodeId: here, via: `event:${ev}`, path: sub(at, ev) });
            }
          }
          continue;
        }
        if (typeof x === "string") {
          if (k === "[(value)]") {
            const target = targetVariable(x);
            if (target) writes.push({ variable: target.split(/[.[\s]/)[0]!, form: f.variable, nodeId: here, via: k, path: at });
          }
          for (const m of x.matchAll(BINDING)) reads.push({ variable: m[1]!, form: f.variable, nodeId: here, via: k, path: at });
          continue;
        }
        walk(x, at, here);
      }
    };
    walk(f.initialValue, `${f.path}.initialValue`, f.builderNodeIds[0] ?? f.variable);
  }
  return { writes, reads };
}
