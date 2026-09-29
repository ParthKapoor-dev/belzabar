// Lint rules: the mechanical part of the team's `pd-review` checklist
// (§3a structural, §3c bindings + HTTP, §3d accessibility) and the figma-to-pd
// `validate-pd-config.py` rules that hold on real editor output.
//
// Codes: figma-to-pd codes are kept where the rule means the same thing (V1,
// V4, T1–T6, C5, R1, H1, F1, U1); belz-only rules use UPPER_SNAKE names. Rules
// that already existed under another name keep it (L1 = ROOT_LAYOUT_MALFORMED,
// V3 = ARRAY_INITIAL_VALUE, R2 = BUTTON_DYNAMIC_CLASSNAME, …); the catalogue
// (lib/validator/catalogue.ts) records the mapping and the severities.
//
// Every rule here fires on real pages that render, so they are warnings; the
// ones worth blocking when an edit introduces them are marked `escalate` in the
// catalogue. Messages never carry a position that shifts when siblings are
// added (HTTP calls are named by callId/label, nodes by id), so validateEdit's
// pre-existing match holds.
//
// Figma rules NOT ported (they encode another runtime): V4's "capitalized
// primitives are invalid" (the PD editor itself writes String/Boolean/Number —
// V4 here flags types outside the known enum), V5 metadata (real pages carry
// `__LAYOUT_CONFIG_METADATA: {}`), C6 checkbox chrome, B1 (needs an LLM), H2, S1.

import { walkParsed } from "../../parser/nodes";
import type { HydratedPage, PageHttpRequest, ParsedNode, ValidationIssue } from "../../types/common";
import type { RawConfiguration } from "../../types/wire";
import { issue } from "../catalogue";
import { bindingRoot, isBuiltinRoot, type Rule } from "../context";
import { isStyleOnlySymbol } from "./invariants";

const nodeRef = (n: ParsedNode) => ({ nodeId: n.nodeId, nodeName: n.tagName });
const inner = (page: HydratedPage) => (page.rawConfiguration ?? {}) as RawConfiguration & Record<string, unknown>;
const callName = (c: PageHttpRequest) => `"${c.label.trim()}"${c.callId ? ` (${c.callId})` : ""}`;

function rawNode(n: ParsedNode): Record<string, unknown> {
  return n.raw && typeof n.raw === "object" ? (n.raw as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// pd-review §3a — structural
// ---------------------------------------------------------------------------

/** MISSING_NODE_ID — a node without `id`: not addressable by partial updates or tests. */
const ruleMissingNodeId: Rule = (page) => {
  const out: ValidationIssue[] = [];
  if (isStyleOnlySymbol(page)) return out;
  walkParsed(page.layout, (n) => {
    if (n.nodeId === "__missing_root") return;
    const id = rawNode(n).id;
    if (typeof id === "string" && id.length > 0) return;
    out.push(issue("MISSING_NODE_ID", `"${n.tagName}" node has no id (${n.elementId ? `_elementId ${n.elementId}` : "no _elementId either"})`, nodeRef(n)));
  });
  return out;
};

/** The variable a trigger / event target writes or watches: `this.x` → `x`, `x.y` → `x`. */
function targetRoot(target: string): string | null {
  return bindingRoot(target.replace(/^\s*this\./, ""));
}

/** ORPHAN_HTTP_TRIGGER — an HTTP call triggered by a variable that is not defined (never fires). */
const ruleOrphanHttpTrigger: Rule = (page, ctx) => {
  const out: ValidationIssue[] = [];
  for (const call of page.httpRequests) {
    // An undefined `onInit` is MISSING_ONINIT_VAR's job.
    const missing = [...new Set(call.triggers.map(targetRoot).filter((r): r is string => !!r && r !== "onInit" && !isBuiltinRoot(r) && !ctx.definedVarNames.has(r)))];
    if (missing.length === 0) continue;
    out.push(issue("ORPHAN_HTTP_TRIGGER", `HTTP call ${callName(call)} is triggered by undefined variable(s) ${missing.join(", ")}`, { path: call.callId }));
  }
  return out;
};

/** ORPHAN_EVENT_TARGET — an event handler writes `this.x` but `x` is not defined. */
const ruleOrphanEventTarget: Rule = (page, ctx) => {
  const out: ValidationIssue[] = [];
  walkParsed(page.layout, (n) => {
    if (!n.events) return;
    for (const [event, handlers] of Object.entries(n.events)) {
      if (!Array.isArray(handlers)) continue;
      for (const h of handlers) {
        if (!Array.isArray(h) || typeof h[0] !== "string" || !/^\s*this\./.test(h[0])) continue;
        const root = targetRoot(h[0]);
        if (!root || isBuiltinRoot(root) || ctx.definedVarNames.has(root)) continue;
        out.push(issue("ORPHAN_EVENT_TARGET", `"${n.tagName}" ${event} handler writes undefined variable "${root}"`, { ...nodeRef(n), path: root }));
      }
    }
  });
  return out;
};

/** UNUSED_HTTP_REQUEST — an HTTP call with no trigger never runs. */
const ruleUnusedHttpRequest: Rule = (page) =>
  page.httpRequests
    .filter((c) => c.source !== "legacy" && c.triggers.length === 0)
    .map((c) => issue("UNUSED_HTTP_REQUEST", `HTTP call ${callName(c)} has no trigger — it never runs`, { path: c.callId }));

/** V1 / HTTP_NOT_ARRAY — the variable / service-call buckets must be arrays (an object is silently dropped). */
const ruleBucketsAreArrays: Rule = (page) => {
  const cfg = inner(page);
  const out: ValidationIssue[] = [];
  const vars = cfg.variables as unknown;
  if (vars !== undefined && vars !== null) {
    if (typeof vars !== "object" || Array.isArray(vars)) {
      out.push(issue("V1", "`variables` must be an object {generated:[], userDefined:[…]}", { path: "variables" }));
    } else {
      for (const k of ["userDefined", "generated"] as const) {
        const v = (vars as Record<string, unknown>)[k];
        if (v !== undefined && v !== null && !Array.isArray(v)) {
          out.push(issue("V1", `variables.${k} must be an array — a keyed object renders a blank page`, { path: `variables.${k}` }));
        }
      }
    }
  }
  const http = cfg.httpRequests as unknown;
  if (http && typeof http === "object" && !Array.isArray(http)) {
    for (const k of ["userDefined", "generated"] as const) {
      const v = (http as Record<string, unknown>)[k];
      if (v !== undefined && v !== null && !Array.isArray(v)) {
        out.push(issue("HTTP_NOT_ARRAY", `httpRequests.${k} must be an array — keyed service calls are stripped on save`, { path: `httpRequests.${k}` }));
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// pd-review §3c/§3d — HTTP
// ---------------------------------------------------------------------------

/** HTTP_NO_ERROR_HANDLER — `handler.error` missing or empty: failures are silent. */
const ruleHttpNoErrorHandler: Rule = (page) =>
  page.httpRequests
    .filter((c) => c.errorHandler.length === 0)
    .map((c) => issue("HTTP_NO_ERROR_HANDLER", `HTTP call ${callName(c)} has no handler.error — a failed call is silent`, { path: c.callId }));

const LOAD_TRIGGERS = new Set(["onInit", "onPageLoad", "onLoad"]);
const MUTATING_METHODS = new Set(["PUT", "PATCH", "DELETE"]);
const MUTATION_WORDS = new Set(["save", "update", "delete", "remove", "create", "insert", "submit", "upsert", "publish", "approve", "reject"]);

function words(label: string): string[] {
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * HTTP_MUTATION_ON_LOAD — a call that runs on page load and changes data.
 * Every AD chain call is a POST, so the method alone says nothing: a call is
 * a mutation when its method is PUT/PATCH/DELETE, or its label names a write
 * (save/update/delete/create/submit…). Real onInit calls are all "Get …".
 */
const ruleHttpMutationOnLoad: Rule = (page) => {
  const out: ValidationIssue[] = [];
  for (const c of page.httpRequests) {
    if (!c.triggers.some((t) => LOAD_TRIGGERS.has(t.trim()))) continue;
    const method = (c.method ?? "").toUpperCase();
    const verb = words(c.label).find((w) => MUTATION_WORDS.has(w));
    if (!MUTATING_METHODS.has(method) && !verb) continue;
    out.push(issue("HTTP_MUTATION_ON_LOAD", `HTTP call ${callName(c)} runs on page load and looks like a write (${verb ? `"${verb}"` : method}) — it fires on every visit`, { path: c.callId }));
  }
  return out;
};

/** HTTP_HARDCODED_URL — an absolute URL pins the call to one host/env. */
const ruleHttpHardcodedUrl: Rule = (page) =>
  page.httpRequests
    .filter((c) => typeof c.url === "string" && /^\s*https?:\/\//i.test(c.url))
    .map((c) => issue("HTTP_HARDCODED_URL", `HTTP call ${callName(c)} uses an absolute URL (${c.url!.slice(0, 80)}) — use a relative /rest/… path`, { path: c.callId }));

/** HTTP_NOT_AUTHORIZED — a call to the platform API without request.isAuthorized:true (401 for logged-in users). */
const ruleHttpNotAuthorized: Rule = (page) => {
  const out: ValidationIssue[] = [];
  for (const c of page.httpRequests) {
    if (!c.url || !/^\s*\/rest\//.test(c.url)) continue;
    const req = (c.raw as { request?: { isAuthorized?: unknown } }).request;
    if (req?.isAuthorized === true) continue;
    out.push(issue("HTTP_NOT_AUTHORIZED", `HTTP call ${callName(c)} calls ${c.url.slice(0, 60)} without request.isAuthorized:true`, { path: c.callId }));
  }
  return out;
};

// ---------------------------------------------------------------------------
// pd-review §3d — accessibility
// ---------------------------------------------------------------------------

/** IMG_NO_ALT — `<img>` without alt text. */
const ruleImgNoAlt: Rule = (page) => {
  const out: ValidationIssue[] = [];
  walkParsed(page.layout, (n) => {
    if (n.tagName !== "img") return;
    const attrs = (rawNode(n).attrs ?? {}) as Record<string, unknown>;
    const has = (o: Record<string, unknown>) => ["alt", "[alt]"].some((k) => typeof o[k] === "string" && (o[k] as string).trim() !== "");
    if (has(n.props) || has(attrs)) return;
    out.push(issue("IMG_NO_ALT", `<img> ${n.nodeId} has no alt text`, nodeRef(n)));
  });
  return out;
};

// ---------------------------------------------------------------------------
// figma-to-pd — variables
// ---------------------------------------------------------------------------

/**
 * Types the PD editor writes (every real fixture) plus the lowercase spellings
 * figma-to-pd allows. Anything else is V4.
 */
const KNOWN_VARIABLE_TYPES = new Set([
  "String", "Boolean", "Number", "Any", "KeyValue", "PAGINATION_STORE", "Object", "Array",
  "string", "boolean", "number", "object", "any",
]);

/** V4 — a variable type outside the PD enum silently fails to register. */
const ruleV4VariableType: Rule = (page) =>
  page.variables
    .filter((v) => typeof v.type === "string" && !KNOWN_VARIABLE_TYPES.has(v.type))
    .map((v) => issue("V4", `Variable "${v.name}" has type "${v.type}" — not a PD variable type (${[...KNOWN_VARIABLE_TYPES].slice(0, 6).join(", ")}, …)`, { path: v.name }));

// ---------------------------------------------------------------------------
// figma-to-pd — exp-data-table (T1–T6, C5)
// ---------------------------------------------------------------------------

const TABLE_VAR_RE = /\{%\s*([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)\s*%\}/;

interface TableCtx {
  node: ParsedNode;
  props: Record<string, unknown>;
  varName: string | null;
  sub: string;
  initialValue: unknown;
  varType: string | null;
  rows: unknown[] | null;
}

function tables(page: HydratedPage): TableCtx[] {
  const out: TableCtx[] = [];
  walkParsed(page.layout, (n) => {
    if (n.tagName !== "exp-data-table") return;
    const props = n.props;
    const binding = props["[rowData]"];
    const m = typeof binding === "string" ? binding.match(TABLE_VAR_RE) : null;
    const varName = m?.[1] ?? null;
    const v = varName ? page.variables.find((x) => x.name === varName) : undefined;
    const iv = v?.initialValue;
    const rows = iv && typeof iv === "object" && !Array.isArray(iv) && Array.isArray((iv as { rows?: unknown }).rows)
      ? ((iv as { rows: unknown[] }).rows)
      : null;
    out.push({ node: n, props, varName, sub: m?.[2] ?? "", initialValue: iv, varType: v?.type ?? null, rows });
  });
  return out;
}

/** T1 — a static datasourceState must be "initial" (a missing one is TABLE_NO_DATASOURCE). */
const ruleT1DatasourceState: Rule = (page) =>
  tables(page)
    .filter((t) => typeof t.props.datasourceState === "string" && t.props.datasourceState !== "initial")
    .map((t) => issue("T1", `exp-data-table ${t.node.nodeId} has datasourceState "${String(t.props.datasourceState)}" — the table only renders with "initial"`, nodeRef(t.node)));

/** T2 — rowData bound `{%v.rows%}` needs initialValue `{rows:[…]}`; a raw-array variable bound directly renders blank. */
const ruleT2RowDataShape: Rule = (page) => {
  const out: ValidationIssue[] = [];
  for (const t of tables(page)) {
    if (!t.varName || t.initialValue === null || t.initialValue === undefined || t.initialValue === "") continue;
    if (t.sub === ".rows" && !t.rows) {
      out.push(issue("T2", `exp-data-table ${t.node.nodeId} binds {%${t.varName}.rows%} but "${t.varName}" initialValue is not {rows:[…]}`, { ...nodeRef(t.node), path: t.varName }));
    } else if (t.sub === "" && Array.isArray(t.initialValue)) {
      out.push(issue("T2", `exp-data-table ${t.node.nodeId} binds raw-array variable "${t.varName}" — wrap it as {rows:[…]} and bind {%${t.varName}.rows%}`, { ...nodeRef(t.node), path: t.varName }));
    }
  }
  return out;
};

/** T3 — a rowData field longer than 400 characters is a pre-baked HTML blob. */
const ruleT3LongRowField: Rule = (page) => {
  const out: ValidationIssue[] = [];
  for (const t of tables(page)) {
    const long = (t.rows ?? []).flatMap((r) => (r && typeof r === "object" ? Object.entries(r as Record<string, unknown>) : []))
      .filter(([, v]) => typeof v === "string" && v.length > 400);
    if (long.length) out.push(issue("T3", `exp-data-table ${t.node.nodeId}: "${t.varName}" rows carry ${long.length} field(s) over 400 chars (${long[0]![0]}) — render through cellLayout instead`, nodeRef(t.node)));
  }
  return out;
};

/** T4 — a {rows:[…]} table variable must be typed Any. */
const ruleT4RowVarType: Rule = (page) =>
  tables(page)
    .filter((t) => t.rows && t.varType !== null && t.varType !== "Any")
    .map((t) => issue("T4", `Table variable "${t.varName}" holds {rows:[…]} but is typed "${t.varType}" — use "Any" (the table renders zero rows)`, { ...nodeRef(t.node), path: t.varName }));

const ROW_INTERP_RE = /\{%\s*\$src\.\$row\.[A-Za-z_][\w.]*\s*%\}/;
const GENERIC_HTML = new Set(["div", "span", "exp-html-template", "p", "label", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** T5 — Shape B (dict) cellLayout: `{%$src.$row.X%}` in innerHTML/template of plain HTML is dropped. */
const ruleT5ShapeBInterpolation: Rule = (page) => {
  const out: ValidationIssue[] = [];
  for (const t of tables(page)) {
    const cols = Array.isArray(t.props.columns) ? t.props.columns : [];
    for (const col of cols) {
      const cl = col && typeof col === "object" ? (col as { cellLayout?: unknown; key?: unknown }).cellLayout : null;
      if (!cl || typeof cl !== "object" || Array.isArray(cl)) continue;
      const bad: string[] = [];
      const visit = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        const kids = (node as { children?: unknown }).children;
        for (const ch of Array.isArray(kids) ? kids : []) {
          if (!ch || typeof ch !== "object") continue;
          const c = ch as { name?: unknown; props?: Record<string, unknown> };
          if (typeof c.name === "string" && GENERIC_HTML.has(c.name)) {
            for (const k of ["[innerHTML]", "[template]", "innerHTML", "template"]) {
              const v = c.props?.[k];
              if (typeof v === "string" && ROW_INTERP_RE.test(v)) bad.push(`${c.name}.${k}`);
            }
          }
          visit(ch);
        }
      };
      visit(cl);
      if (bad.length) {
        const key = (col as { key?: unknown }).key;
        out.push(issue("T5", `exp-data-table ${t.node.nodeId} column "${String(key)}": {%$src.$row.X%} in ${bad[0]} of a dict cellLayout renders empty — split into a Shape A text column`, nodeRef(t.node)));
      }
    }
  }
  return out;
};

const HTML_IN_ROW_RE = /<\s*(span|div|button|input|label|a|img|svg|exp-[a-z][a-z0-9-]*)\b/i;

/** T6 — rowData values must be plain text/number/boolean, never HTML. */
const ruleT6RowDataHtml: Rule = (page) => {
  const out: ValidationIssue[] = [];
  for (const t of tables(page)) {
    const hit = (t.rows ?? []).flatMap((r) => (r && typeof r === "object" ? Object.entries(r as Record<string, unknown>) : []))
      .find(([, v]) => typeof v === "string" && HTML_IN_ROW_RE.test(v));
    if (hit) out.push(issue("T6", `exp-data-table ${t.node.nodeId}: "${t.varName}" row field "${hit[0]}" holds HTML — use a cellLayout with real components`, nodeRef(t.node)));
  }
  return out;
};

/** C5 — every static column key must have a value in every initial row (else the cell is hidden with _d-none). */
const ruleC5ColumnKeys: Rule = (page) => {
  const out: ValidationIssue[] = [];
  for (const t of tables(page)) {
    if (!t.rows?.length || !Array.isArray(t.props.columns)) continue;
    const keys = t.props.columns
      .map((c) => (c && typeof c === "object" ? (c as { key?: unknown }).key : null))
      .filter((k): k is string => typeof k === "string" && k !== "");
    const missing = keys.filter((k) => t.rows!.some((r) => !r || typeof r !== "object" || [null, undefined, ""].includes((r as Record<string, unknown>)[k] as never)));
    if (missing.length) out.push(issue("C5", `exp-data-table ${t.node.nodeId}: column key(s) ${missing.join(", ")} missing from some rows of "${t.varName}" — those cells are hidden`, nodeRef(t.node)));
  }
  return out;
};

// ---------------------------------------------------------------------------
// figma-to-pd / page-designer Common Errors — nodes, bindings, styles
// ---------------------------------------------------------------------------

/** R1 — a static `isVisible` next to `[isVisible]` wins and the binding never shows the node. */
const ruleR1StaticAndBoundVisible: Rule = (page) => {
  const out: ValidationIssue[] = [];
  walkParsed(page.layout, (n) => {
    if ("isVisible" in n.props && "[isVisible]" in n.props) {
      out.push(issue("R1", `"${n.tagName}" ${n.nodeId} has both isVisible and [isVisible] — the static prop wins; drop it`, nodeRef(n)));
    }
  });
  return out;
};

/** DIALOG_VISIBILITY — exp-layout-dialog opens only via `[show]`; `[visible]` is ignored, `[isVisible]` removes it. */
const ruleDialogVisibility: Rule = (page) => {
  const out: ValidationIssue[] = [];
  walkParsed(page.layout, (n) => {
    if (n.tagName !== "exp-layout-dialog") return;
    const wrong = ["[visible]", "[isVisible]"].filter((k) => k in n.props);
    if (wrong.length === 0 || "[show]" in n.props) return;
    out.push(issue("DIALOG_VISIBILITY", `exp-layout-dialog ${n.nodeId} is toggled with ${wrong.join("/")} — only [show] opens a dialog`, nodeRef(n)));
  });
  return out;
};

/** ITEM_DIRECT_ACCESS — `{%$item.field%}` is "Can not determine data source"; use `{%$item.value%}?.field`. */
const ruleItemDirectAccess: Rule = (page) => {
  const bad = new Set<string>();
  for (const m of page.rawConfigurationString.matchAll(/\{%\s*\$item\.([A-Za-z_$][\w$]*)/g)) {
    if (m[1] !== "value" && m[1] !== "index") bad.add(m[1]!);
  }
  return [...bad].map((f) => issue("ITEM_DIRECT_ACCESS", `{%$item.${f}%} — loop items are wrapped: use {%$item.value%}?.${f}`, { path: `$item.${f}` }));
};

/** H1 — an exp-html-template longer than 400 chars (other than one SVG asset) should be real PD nodes. */
const ruleH1LongTemplate: Rule = (page) => {
  const out: ValidationIssue[] = [];
  walkParsed(page.layout, (n) => {
    if (n.tagName !== "exp-html-template") return;
    const t = n.props.template ?? n.props["[template]"];
    if (typeof t !== "string" || t.length <= 400) return;
    const s = t.trim();
    if (s.startsWith("<svg") && s.endsWith("</svg>")) return;
    out.push(issue("H1", `exp-html-template ${n.nodeId} template is ${t.length} chars — decompose into PD nodes`, nodeRef(n)));
  });
  return out;
};

const RAW_INPUT_RE = /<(input|select|textarea)\b/i;

/** F1 — raw <input>/<select>/<textarea> inside a template/innerHTML string (not bindable). */
const ruleF1RawInputInTemplate: Rule = (page) => {
  const out: ValidationIssue[] = [];
  walkParsed(page.layout, (n) => {
    for (const k of ["template", "[template]", "innerHTML", "[innerHTML]"]) {
      const v = n.props[k];
      const m = typeof v === "string" ? v.match(RAW_INPUT_RE) : null;
      if (m) {
        out.push(issue("F1", `"${n.tagName}" ${n.nodeId} ${k} contains a raw <${m[1]}> — use exp-form-field`, nodeRef(n)));
        return;
      }
    }
  });
  return out;
};

/** CSS selectors of the page stylesheet (comments and @-rule headers dropped). */
export function cssSelectors(styles: string): string[] {
  const noComments = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const m of noComments.matchAll(/([^{}]+)\{/g)) {
    const sel = m[1]!.trim();
    if (!sel || sel.startsWith("@") || /^(from|to|\d+%)(\s*,\s*(from|to|\d+%))*$/.test(sel)) continue;
    out.push(sel);
  }
  return out;
}

/**
 * CSS_NOT_SCOPED — style rules without the `.latest-version` prefix (the
 * page-designer skill: PD ignores them). One issue per page; most real
 * fixtures carry unscoped rules, so it never blocks.
 */
const ruleCssNotScoped: Rule = (page) => {
  const unscoped = cssSelectors(page.styles).filter((s) => !s.includes(".latest-version") && !/^(html|body|:root)\b/.test(s));
  if (unscoped.length === 0) return [];
  return [issue("CSS_NOT_SCOPED", `${unscoped.length} style rule(s) lack the .latest-version prefix (e.g. ${unscoped.slice(0, 2).map((s) => `"${s.slice(0, 40)}"`).join(", ")})`, { path: "styles" })];
};

/** U1 — a CSS url(...) with a literal newline is dropped by the parser. */
const ruleU1MultilineUrl: Rule = (page) => {
  const n = [...page.styles.matchAll(/url\(([^)]*)\)/g)].filter((m) => /[\r\n]/.test(m[1]!)).length;
  return n ? [issue("U1", `${n} CSS url(...) value(s) contain a newline — collapse data URIs to one line`, { path: "styles" })] : [];
};

export const LINT_RULES: Rule[] = [
  ruleMissingNodeId,
  ruleOrphanHttpTrigger,
  ruleOrphanEventTarget,
  ruleUnusedHttpRequest,
  ruleBucketsAreArrays,
  ruleHttpNoErrorHandler,
  ruleHttpMutationOnLoad,
  ruleHttpHardcodedUrl,
  ruleHttpNotAuthorized,
  ruleImgNoAlt,
  ruleV4VariableType,
  ruleT1DatasourceState,
  ruleT2RowDataShape,
  ruleT3LongRowField,
  ruleT4RowVarType,
  ruleT5ShapeBInterpolation,
  ruleT6RowDataHtml,
  ruleC5ColumnKeys,
  ruleR1StaticAndBoundVisible,
  ruleDialogVisibility,
  ruleItemDirectAccess,
  ruleH1LongTemplate,
  ruleF1RawInputInTemplate,
  ruleCssNotScoped,
  ruleU1MultilineUrl,
];
