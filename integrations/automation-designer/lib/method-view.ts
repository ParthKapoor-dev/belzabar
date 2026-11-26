// Agent-facing views of a HydratedMethod.
//
//   compactMethod(method)  → `ad show --compact`: a header + ONE line per step
//                            (index, kind/service, description, entry condition,
//                            loop, decoded SQL/code/SpEL abbreviated, key inputs,
//                            outputs → variables, exit rules). Full bodies go to
//                            `blocks` only when asked for.
//   storyMarkdown(method)  → `ad show --story`: the plain-English pre-save
//                            approval template
//                            (What it does / Approach / Service, Inputs,
//                            Outputs, Steps tables, decoded custom code).
//
// Works on V1 and V2 parses; every behaviour field (entry condition, loop,
// exit-on-failure, conditional exit, async, account) comes from ParsedStep.

import { decodeBase64Strict } from "./base64";
import { abbreviate, htmlToText, oneLine } from "./compact";
import type { HydratedMethod, MethodField, MethodOutput, ParsedStep, StepInput } from "./types/common";
import { isObj, str, type Obj } from "@belzabar/core";

export type InputLabeler = (input: StepInput) => string | undefined;

/**
 * Step inputs as `path = value` rows: nested mappings are flattened
 * to dotted label paths, empty slots skipped, BASE_64-flagged values decoded.
 * `labelFor` supplies V1 labels (from the service definition); V2 inputs
 * carry their own key/name.
 */
export function flattenStepInputs(
  inputs: StepInput[],
  labelFor: InputLabeler = () => undefined,
): Array<{ input: string; value: string }> {
  const rows: Array<{ input: string; value: string }> = [];
  const walk = (list: StepInput[] | undefined, prefix: string) => {
    for (const i of list ?? []) {
      const name = labelFor(i) ?? i.key ?? i.label ?? (i.automationUserInputId != null ? `#${i.automationUserInputId}` : "?");
      const path = prefix ? `${prefix}.${name}` : name;
      if (typeof i.value === "string" && i.value.length > 0) {
        const decoded = i.encodingType === "BASE_64" ? decodeBase64Strict(i.value) : null;
        rows.push({ input: path, value: decoded ?? i.value });
      }
      walk(i.mappings, path);
    }
  };
  walk(inputs, "");
  return rows;
}

/** Always a string: `<service>.<method>`, else `apiId:<id>` / `automationId:<id>`, else "". */
export function identityForStep(step: ParsedStep): string {
  if (step.serviceName && step.methodName) return `${step.serviceName}.${step.methodName}`;
  if (step.automationApiId != null && String(step.automationApiId).trim()) return `apiId:${String(step.automationApiId).trim()}`;
  if (step.automationId != null && String(step.automationId).trim()) return `automationId:${String(step.automationId).trim()}`;
  return "";
}

// ── Wire facts (loop / exit) ────────────────────────────────────────────────


interface StepFacts {
  when?: string;
  loop?: { type?: string; over?: string; counter?: string; parallel?: boolean; v1Only?: boolean };
  exitOnFailure?: boolean;
  exitMessage?: string;
  /** HTTP status of the exit. */
  exitCode?: string;
  exitIf?: string;
  exitIfCode?: string;
  exitIfMessage?: string;
  async?: boolean;
  /** Account name (else `#id`) the step runs with. */
  account?: string;
}

const LOOP_SHORT: Record<string, string> = {
  LOOP_EXECUTION_ON_INPUT_OUTPUT: "each",
  LOOP_EXECUTION_ON_NUMBER: "times",
  LOOP_EXECUTION_ON_CONDITION: "while",
  LOOP_EXECUTION_ON_RANGE: "range",
};

export function stepFacts(step: ParsedStep): StepFacts {
  const facts: StepFacts = {};
  if (str(step.conditionExpression)) facts.when = oneLine(step.conditionExpression!);
  if (step.runAsync) facts.async = true;

  // Loop + exit-on-failure come from the parser (V1 and V2 alike).
  if (step.repeatStepExecution) {
    const cfg = step.loopConfiguration ?? {};
    facts.loop = {
      type: str(cfg.type),
      over: str(step.loopExecutionSource),
      counter: str(cfg.counter),
      parallel: cfg.executeParallel === true || undefined,
      v1Only: step.legacyLoop || undefined,
    };
  }
  const code = statusCode(step.forceExitStatusCode);
  if (step.forceExitFromFailure) {
    facts.exitOnFailure = true;
    facts.exitMessage = str(step.forceExitErrorMessage);
    if (code) facts.exitCode = code;
  }
  if (str(step.forceReturnExpression)) {
    facts.exitIf = oneLine(step.forceReturnExpression!);
    const ifCode = statusCode(step.forceReturnStatusCode);
    const ifMessage = str(step.forceReturnMessage);
    if (ifCode) facts.exitIfCode = ifCode;
    if (ifMessage) facts.exitIfMessage = ifMessage;
  }
  if (step.account && (step.account.name || step.account.id != null)) facts.account = step.account.name ?? `#${step.account.id}`;
  return facts;
}

/**
 * Short behaviour markers for the default `ad show` step table: entry
 * condition, loop, exit rules, async and account. Conditions are never cut
 * (a cut condition was read as a different one, D3).
 */
export function stepGates(step: ParsedStep): string[] {
  const f = stepFacts(step);
  const out: string[] = [];
  if (f.when) out.push(`when ${f.when}`);
  if (f.loop) out.push(`loop ${f.loop.type ? LOOP_SHORT[f.loop.type] ?? f.loop.type : "loop"}${f.loop.over ? ` ${f.loop.over}` : ""}${f.loop.parallel ? " parallel" : ""}${f.loop.v1Only ? " (v1 only)" : ""}`);
  if (f.exitIf) out.push(`exit-if ${f.exitIf}${f.exitIfCode ? ` → ${f.exitIfCode}` : ""}`);
  if (f.exitOnFailure) out.push(`exit-on-fail${f.exitCode ? ` ${f.exitCode}` : ""}`);
  if (f.async) out.push("async");
  if (f.account) out.push(`account ${f.account}`);
  return out;
}

function statusCode(v: unknown): string | undefined {
  return typeof v === "number" ? String(v) : str(v);
}

// ── Step pieces ─────────────────────────────────────────────────────────────

function kindLabel(step: ParsedStep): string {
  switch (step.kind) {
    case "SQL":
      return `SQL(${step.operation || "?"})`;
    case "CUSTOM_CODE":
      return `CODE(${(step.language ?? "?").toLowerCase()})`;
    case "SPEL_ECHO":
      return "SPEL";
    case "REDIS_GET":
      return "REDIS-GET";
    case "REDIS_SET":
      return "REDIS-SET";
    case "REDIS_REMOVE":
      return "REDIS-REMOVE";
    case "EXISTING_SERVICE":
      return "CALL";
    case "UNKNOWN":
      return "UNKNOWN";
  }
}

/** The step's body text (decoded SQL / source / SpEL expression), if it has one. */
function stepBody(step: ParsedStep): { kind: "SQL" | "CODE" | "SPEL"; text: string; language?: string } | null {
  if (step.kind === "SQL" && step.sql) return { kind: "SQL", text: step.sql };
  if (step.kind === "CUSTOM_CODE" && step.source) return { kind: "CODE", text: step.source, language: step.language ?? undefined };
  if (step.kind === "SPEL_ECHO" && step.expression) return { kind: "SPEL", text: step.expression };
  return null;
}

/** `key[→fieldCode][ ⇒ $var]` per output; V2 outputs carry the exposed name as `fieldCode`. */
/** Step outputs as `key→exposed⇒$variable` (the binding a step writes). */
export function outputSpecs(step: ParsedStep): string[] {
  return (step.outputs ?? []).map((o) => {
    const raw = isObj(o.raw) ? o.raw : {};
    const exposed = str(raw.fieldCode) ?? str(raw.name);
    let s = o.code || exposed || "?";
    if (exposed && exposed !== o.code) s += `→${exposed}`;
    const ref = isObj(o.inputReference) ? str((o.inputReference as Obj).reference) : str(o.inputReference ?? o.internalVarRef);
    if (ref) s += `⇒$${ref}`;
    return s;
  });
}

/** Step inputs minus the body slot (the SQL query / SpEL expression is shown as the body). */
export function inputPairs(step: ParsedStep, labelFor?: InputLabeler): Array<{ input: string; value: string }> {
  const body = stepBody(step);
  return flattenStepInputs(step.inputs ?? [], labelFor).filter((r) => !(body && r.value === body.text));
}

// ── Compact view ────────────────────────────────────────────────────────────

/** Every cut in the agent views says how to see the whole text (D3). */
const FULL_HINT = "use --full";

/** A callee category by any of its spellings (name, label, alias such as `Schools - Utilities`). */
export type CategoryResolver = (service: string) => { name: string; uuid?: string } | undefined;

/** `identityForStep` with the callee's canonical category name (D36). */
export function canonicalIdentity(step: ParsedStep, categoryOf?: CategoryResolver): string {
  if (step.serviceName && step.methodName && categoryOf) {
    const c = categoryOf(step.serviceName);
    if (c) return `${c.name}.${step.methodName}`;
  }
  return identityForStep(step);
}

interface CompactOptions {
  /** Max chars for an abbreviated body (SQL/code/SpEL) on the step line. 0 = no limit. */
  bodyChars?: number;
  /** Max chars per input value. */
  valueChars?: number;
  /** Emit full bodies in `blocks` for these kinds. */
  fullBodies?: { sql?: boolean; code?: boolean; spel?: boolean };
  /** V1 input labels per step orderIndex (from the service definitions). */
  labels?: Map<number, InputLabeler>;
  /** Only this step (orderIndex). */
  step?: number | null;
  /** Description chars on a step line (default 80; 0 = whole). */
  descChars?: number;
  /** Resolves a callee's category spelling to its canonical name / uuid. */
  categoryOf?: CategoryResolver;
}

/** A called method, by canonical category and automation-API uuid (what `find` / `callers` use). */
interface CompactCallee {
  step: number;
  category: string;
  categoryUuid?: string;
  method: string;
  apiUuid?: string;
}

interface CompactBlock {
  step: number;
  kind: "SQL" | "CODE" | "SPEL";
  language?: string;
  text: string;
}

export interface CompactMethodView {
  name: string;
  category: string;
  state: string;
  version: number | string;
  uuid: string;
  referenceId?: string;
  /** `deprecated`, `scope X`, `timeout Ns` — only when set. */
  flags?: string;
  /** The summary as stored (never the description). */
  summary?: string;
  /** The long method description (V1 `methodDescription`; `ad save` key `description`). */
  methodDescription?: string;
  /** `key:TYPE` joined by ", "; `*` = required. */
  in?: string;
  out?: string;
  vars?: string;
  /** Default values of inputs / variables, whole (a variable may hold SQL text). */
  defaults?: { inputs?: Record<string, string>; variables?: Record<string, string> };
  steps: string[];
  /** Service-call steps' callees, canonical names (step lines use the same). */
  callees?: CompactCallee[];
  /** Present (possibly empty) whenever a body kind was asked for. */
  blocks?: CompactBlock[];
  warnings?: string[];
}

/** Method outputs are keyed by `key` (V2) / fieldCode (V1); some V2 bodies carry only `name`. */
function outputName(o: MethodOutput): string {
  return o.code || o.displayName || "?";
}

function fieldList(fields: MethodField[], required = false): string | undefined {
  if (fields.length === 0) return undefined;
  return fields.map((f) => `${f.code}:${String(f.type ?? "?")}${required && f.required ? "*" : ""}`).join(", ");
}

/** A field's default value as text; undefined when unset. */
export function defaultText(f: MethodField): string | undefined {
  const v = f.defaultValue as unknown;
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" ? v : JSON.stringify(v);
}

function defaultsOf(fields: MethodField[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const d = defaultText(f);
    if (d !== undefined) out[f.code] = d;
  }
  return Object.keys(out).length ? out : undefined;
}

export function compactStepLine(step: ParsedStep, opts: CompactOptions = {}): string {
  const bodyChars = opts.bodyChars ?? 160;
  const valueChars = opts.valueChars ?? 60;
  const cut = (t: string, max: number) => abbreviate(t, max, FULL_HINT);
  const parts: string[] = [];
  const ident = step.kind === "SQL" || step.kind === "EXISTING_SERVICE" || step.kind === "UNKNOWN" ? canonicalIdentity(step, opts.categoryOf) : "";
  // `SQL db_service.data.read` already names the operation; `SQL(read)` only when the service is unresolved.
  let head = `${step.orderIndex} ${step.kind === "SQL" && ident ? "SQL" : kindLabel(step)}`;
  if (ident) head += ` ${ident}`;
  // AD rich-text descriptions (`<ul id="isPasted" style=…`) as plain text;
  // cut at 80 unless --full / --step (descChars 0).
  const desc = str(step.description) ? htmlToText(step.description!) : "";
  if (desc) head += ` "${cut(desc, opts.descChars ?? (bodyChars === 0 ? 0 : 80))}"`;
  parts.push(head);

  const f = stepFacts(step);
  if (f.when) parts.push(`when ${f.when}`);
  if (f.loop) {
    const t = f.loop.type ? LOOP_SHORT[f.loop.type] ?? f.loop.type : "loop";
    parts.push(`loop ${t}${f.loop.over ? ` ${f.loop.over}` : ""}${f.loop.counter ? ` as ${f.loop.counter}` : ""}${f.loop.parallel ? " parallel" : ""}${f.loop.v1Only ? " (v1 only)" : ""}`);
  }

  const body = stepBody(step);
  if (body) {
    const tag = body.kind === "SQL" ? "sql: " : body.kind === "CODE" ? "code: " : "= ";
    parts.push(`${tag}${cut(body.text, bodyChars)}`);
  }
  // Every set input, Redis included (scope / expirationSeconds /
  // canReplace are what a lock step is about).
  const inputs = inputPairs(step, opts.labels?.get(step.orderIndex));
  if (inputs.length) parts.push(inputs.map((i) => `${i.input}=${cut(i.value, valueChars)}`).join(", "));

  const outs = outputSpecs(step);
  if (outs.length) parts.push(`-> ${outs.join(", ")}`);
  const flags: string[] = [];
  if (f.async) flags.push("async");
  if (f.account) flags.push(`account ${f.account}`);
  const msgChars = bodyChars === 0 ? 0 : 60;
  if (f.exitOnFailure) flags.push(["exit-on-fail", f.exitCode, f.exitMessage && `"${cut(f.exitMessage, msgChars)}"`].filter(Boolean).join(" "));
  if (f.exitIf) {
    const then = [f.exitIfCode, f.exitIfMessage && `"${cut(f.exitIfMessage, msgChars)}"`].filter(Boolean).join(" ");
    flags.push(`exit-if ${f.exitIf}${then ? ` → ${then}` : ""}`);
  }
  if (step.kind === "UNKNOWN") flags.push(`unparsed: ${step.reason}`);
  if (flags.length) parts.push(flags.join(", "));
  return parts.join(" | ");
}

/**
 * The summary as stored. `method.summary` falls back to the description, so a
 * method with no summary showed its description under "summary" (B124); a
 * parse without `storedSummary` (an older cache entry) drops that fallback.
 */
export function storedSummaryOf(m: HydratedMethod): string {
  if (typeof m.storedSummary === "string") return m.storedSummary;
  return m.summary === "(No description)" || (!!m.description && m.summary === m.description) ? "" : m.summary;
}

/** Method-level behaviour flags; undefined when none is set. */
function methodFlags(m: HydratedMethod): string | undefined {
  const out: string[] = [];
  if (m.deprecated) out.push("deprecated");
  if (m.scope) out.push(`scope ${m.scope}`);
  if (m.timeoutSeconds != null) out.push(`timeout ${m.timeoutSeconds}s`);
  return out.length ? out.join(", ") : undefined;
}

export function compactMethod(method: HydratedMethod, opts: CompactOptions = {}): CompactMethodView {
  const steps = opts.step != null ? method.parsedSteps.filter((s) => s.orderIndex === opts.step) : method.parsedSteps;
  const view: CompactMethodView = {
    name: method.name,
    category: method.category?.name ?? "Uncategorized",
    state: method.state,
    version: method.version,
    uuid: method.uuid,
    referenceId: method.referenceId ?? undefined,
    flags: methodFlags(method),
    summary: str(storedSummaryOf(method)) ? oneLine(storedSummaryOf(method)) : undefined,
    methodDescription: str(method.description) ? method.description : undefined,
    in: fieldList(method.inputs.filter((f) => !f.hideInput), true),
    out: method.outputs.length ? method.outputs.map((o) => `${outputName(o)}:${String(o.type ?? "?")}`).join(", ") : undefined,
    vars: fieldList(method.variables),
    steps: steps.map((s) => compactStepLine(s, opts)),
  };
  const inDefaults = defaultsOf(method.inputs.filter((f) => !f.hideInput));
  const varDefaults = defaultsOf(method.variables);
  if (inDefaults || varDefaults) view.defaults = { ...(inDefaults ? { inputs: inDefaults } : {}), ...(varDefaults ? { variables: varDefaults } : {}) };
  const callees: CompactCallee[] = [];
  for (const s of steps) {
    if (s.kind !== "EXISTING_SERVICE" || !s.serviceName || !s.methodName) continue;
    const c = opts.categoryOf?.(s.serviceName);
    callees.push({
      step: s.orderIndex,
      category: c?.name ?? s.serviceName,
      ...(c?.uuid ? { categoryUuid: c.uuid } : {}),
      method: s.methodName,
      ...(s.automationApiUuid ? { apiUuid: s.automationApiUuid.trim() } : {}),
    });
  }
  if (callees.length) view.callees = callees;
  const want = opts.fullBodies ?? {};
  const blocks: CompactBlock[] = [];
  for (const s of steps) {
    const b = stepBody(s);
    if (!b) continue;
    if ((b.kind === "SQL" && want.sql) || (b.kind === "CODE" && want.code) || (b.kind === "SPEL" && want.spel)) {
      blocks.push({ step: s.orderIndex, kind: b.kind, ...(b.language ? { language: b.language } : {}), text: b.text });
    }
  }
  // Asked for: always present, `[]` when the method has none (D5: scripts read `blocks`).
  if (want.sql || want.code || want.spel || blocks.length) view.blocks = blocks;
  if (method.parseWarnings.length) view.warnings = method.parseWarnings;
  return view;
}

/** Plain-text rendering of a compact view (human mode). */
export function renderCompact(view: CompactMethodView): string {
  const lines: string[] = [];
  lines.push(`${view.name} [${view.state} v${view.version}] ${view.category} ${view.uuid}${view.referenceId ? ` (ref ${view.referenceId})` : ""}`);
  if (view.flags) lines.push(`flags: ${view.flags}`);
  if (view.summary) lines.push(`summary: ${view.summary}`);
  if (view.methodDescription) lines.push(`methodDescription: ${oneLine(view.methodDescription)}`);
  if (view.in) lines.push(`in: ${view.in}`);
  if (view.out) lines.push(`out: ${view.out}`);
  if (view.vars) lines.push(`vars: ${view.vars}`);
  for (const [k, v] of Object.entries(view.defaults?.inputs ?? {})) lines.push(`default in ${k} = ${v}`);
  for (const [k, v] of Object.entries(view.defaults?.variables ?? {})) lines.push(`default var ${k} = ${v}`);
  lines.push(...view.steps);
  for (const b of view.blocks ?? []) {
    lines.push("", `--- step ${b.step} ${b.kind}${b.language ? ` (${b.language.toLowerCase()})` : ""} ---`, b.text.trimEnd());
  }
  for (const w of view.warnings ?? []) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

// ── Story (approval template) ───────────────────────────────────────────────

const cell = (s: string | undefined | null): string => (s ? oneLine(s).replace(/\|/g, "\\|") : "");

function approach(method: HydratedMethod): string {
  const n = method.parsedSteps.length;
  if (n === 0) return "no steps yet";
  const code = method.parsedSteps.filter((s) => s.kind === "CUSTOM_CODE").length;
  if (code === 0) return `existing-service composition (${n} step${n === 1 ? "" : "s"})`;
  if (code === n) return `custom code (${n} step${n === 1 ? "" : "s"})`;
  return `mixed (${n} steps: ${code} custom code, ${n - code} service call${n - code === 1 ? "" : "s"})`;
}

function storyStepType(step: ParsedStep, categoryOf?: CategoryResolver): string {
  if (step.kind === "EXISTING_SERVICE" && step.serviceName && step.methodName) {
    return `${categoryOf?.(step.serviceName)?.name ?? step.serviceName}/${step.methodName}`;
  }
  switch (step.kind) {
    case "CUSTOM_CODE":
      return `Custom code (${(step.language ?? "?").toLowerCase()})`;
    case "SQL":
      return step.serviceName ? `${step.serviceName}/${step.methodName ?? ""} (SQL ${step.operation})` : `SQL ${step.operation}`;
    case "SPEL_ECHO":
      return step.serviceName ? `${step.serviceName}/${step.methodName ?? ""}` : "Helpers.Legacy/echo";
    default:
      return step.serviceName && step.methodName ? `${step.serviceName}/${step.methodName}` : identityForStep(step) || step.kind;
  }
}

function storyStepWhat(step: ParsedStep, full: boolean): string {
  const cut = (t: string, max: number) => abbreviate(t, full ? 0 : max, FULL_HINT);
  const bits: string[] = [];
  const desc = str(step.description ? htmlToText(step.description) : undefined) ?? (step.kind === "SPEL_ECHO" && step.expression ? `computes ${cut(step.expression, 80)}` : undefined);
  if (desc) bits.push(desc);
  const f = stepFacts(step);
  if (f.when) bits.push(`only when ${f.when}`);
  if (f.loop) bits.push(`repeats ${f.loop.type ? LOOP_SHORT[f.loop.type] ?? f.loop.type : "loop"}${f.loop.over ? ` over ${f.loop.over}` : ""}`);
  const outs = (step.outputs ?? []).map((o) => {
    const raw = isObj(o.raw) ? o.raw : {};
    return str(raw.fieldCode) ?? o.code;
  }).filter(Boolean);
  if (outs.length) bits.push(`gives ${outs.map((o) => `\`${o}\``).join(", ")}`);
  if (f.exitOnFailure) bits.push(`stops the method on failure${f.exitCode ? ` (${f.exitCode})` : ""}`);
  if (f.exitIf) {
    const then = [f.exitIfCode, f.exitIfMessage && `"${cut(f.exitIfMessage, 60)}"`].filter(Boolean).join(" ");
    bits.push(`returns early when ${f.exitIf}${then ? ` (${then})` : ""}`);
  }
  if (f.async) bits.push("runs async");
  if (f.account) bits.push(`uses account ${f.account}`);
  return bits.join("; ");
}

/** The stored test value only; defaults have their own column (D27). */
function testValue(f: MethodField): string {
  const v = f.testValue;
  if (v === undefined || v === null || v === "") return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** `full`: no cuts (`--story --full`). */
export function storyMarkdown(method: HydratedMethod, opts: { full?: boolean; categoryOf?: CategoryResolver } = {}): string {
  const full = !!opts.full;
  const cut = (t: string, max: number) => abbreviate(t, full ? 0 : max, FULL_HINT);
  const out: string[] = [];
  out.push(`## ${method.name}`, "");
  // Both fields by their real names (B124): the summary is never filled from the description.
  out.push(`**What it does:** ${oneLine(str(storedSummaryOf(method)) ?? "(no summary)")}`);
  if (str(method.description)) out.push(`**Description (methodDescription):** ${oneLine(method.description!)}`);
  out.push(`**Approach:** ${approach(method)}`);
  out.push(`**Service:** ${method.category?.name ?? "Uncategorized"}`);
  out.push(`**State:** ${method.state} v${method.version} (\`${method.uuid}\`)`);
  const mf = methodFlags(method);
  if (mf) out.push(`**Flags:** ${mf}`);
  out.push("");

  const inputs = method.inputs.filter((f) => !f.hideInput);
  out.push("### Inputs");
  if (inputs.length === 0) out.push("(none)");
  else {
    out.push("| Field | Type | Default | Test value | Purpose |", "|---|---|---|---|---|");
    for (const f of inputs) out.push(`| ${cell(f.code)}${f.required ? " (required)" : ""} | ${cell(String(f.type ?? ""))} | ${cell(cut(defaultText(f) ?? "", 60))} | ${cell(cut(testValue(f), 60))} | ${cell(f.description)} |`);
  }
  out.push("", "### Outputs");
  if (method.outputs.length === 0) out.push("(none)");
  else {
    out.push("| Field | Type | Purpose |", "|---|---|---|");
    for (const o of method.outputs) out.push(`| ${cell(outputName(o))} | ${cell(String(o.type ?? ""))} | ${cell(o.description)} |`);
  }
  if (method.variables.length) {
    out.push("", "### Variables");
    out.push("| Name | Type | Default | Purpose |", "|---|---|---|---|");
    for (const v of method.variables) out.push(`| ${cell(v.code)} | ${cell(String(v.type ?? ""))} | ${cell(cut(defaultText(v) ?? "", 120))} | ${cell(v.description)} |`);
  }
  out.push("", "### Steps");
  if (method.parsedSteps.length === 0) out.push("(none)");
  else {
    out.push("| # | Type | What it does |", "|---|---|---|");
    for (const s of method.parsedSteps) out.push(`| ${s.orderIndex} | ${cell(storyStepType(s, opts.categoryOf))} | ${cell(storyStepWhat(s, full))} |`);
  }
  for (const s of method.parsedSteps) {
    const b = stepBody(s);
    if (!b || b.kind === "SPEL") continue;
    const lang = b.kind === "SQL" ? "sql" : (b.language ?? "").toLowerCase() === "python" ? "python" : "javascript";
    const title = b.kind === "SQL" ? `### SQL (Step ${s.orderIndex})` : `### Custom code (Step ${s.orderIndex}) — ${(b.language ?? "?").toLowerCase()}`;
    out.push("", title, "```" + lang, b.text.trimEnd(), "```");
  }
  return out.join("\n") + "\n";
}
