// Agent-facing views of a HydratedMethod (Stage 7, 7.1).
//
//   compactMethod(method)  → `ad show --compact`: a header + ONE line per step
//                            (index, kind/service, description, entry condition,
//                            loop, decoded SQL/code/SpEL abbreviated, key inputs,
//                            outputs → variables, exit rules). Full bodies go to
//                            `blocks` only when asked for.
//   storyMarkdown(method)  → `ad show --story`: the plain-English pre-save
//                            approval template of the team's AD skill
//                            (What it does / Approach / Service, Inputs,
//                            Outputs, Steps tables, decoded custom code).
//
// Works on V1 and V2 parses. Loops and exit-on-failure come from ParsedStep;
// only the conditional exit (not a ParsedStep field) is read from the wire.

import { decodeBase64Strict } from "./base64";
import { abbreviate, oneLine } from "./compact";
import type { HydratedMethod, MethodField, MethodOutput, ParsedStep, StepInput } from "./types/common";

export type InputLabeler = (input: StepInput) => string | undefined;

/**
 * Step inputs as `path = value` rows (AD-40): nested mappings are flattened
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

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const nonBlank = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export interface StepFacts {
  when?: string;
  loop?: { type?: string; over?: string; counter?: string; parallel?: boolean };
  exitOnFailure?: boolean;
  exitMessage?: string;
  exitIf?: string;
  async?: boolean;
}

const LOOP_SHORT: Record<string, string> = {
  LOOP_EXECUTION_ON_INPUT_OUTPUT: "each",
  LOOP_EXECUTION_ON_NUMBER: "times",
  LOOP_EXECUTION_ON_CONDITION: "while",
  LOOP_EXECUTION_ON_RANGE: "range",
};

export function stepFacts(step: ParsedStep): StepFacts {
  const facts: StepFacts = {};
  const raw = isObj(step.raw) ? step.raw : {};
  if (nonBlank(step.conditionExpression)) facts.when = oneLine(step.conditionExpression!);
  if (step.runAsync) facts.async = true;

  // Loop + exit-on-failure come from the parser (V1 and V2 alike).
  if (step.repeatStepExecution) {
    const cfg = step.loopConfiguration ?? {};
    facts.loop = {
      type: nonBlank(cfg.type),
      over: nonBlank(step.loopExecutionSource),
      counter: nonBlank(cfg.counter),
      parallel: cfg.executeParallel === true || undefined,
    };
  }
  if (step.forceExitFromFailure) {
    facts.exitOnFailure = true;
    facts.exitMessage = nonBlank(step.forceExitErrorMessage);
  }
  // Conditional exit is not on ParsedStep: V2 `exitCondition.conditionalExit`, V1 `forceReturnConditionExpression`.
  const props = isObj(raw.properties) ? raw.properties : null;
  const exit = props && isObj(props.exitCondition) ? props.exitCondition : null;
  const cond = exit && isObj(exit.conditionalExit) ? nonBlank(exit.conditionalExit.expression) : undefined;
  const exitIf = cond ?? nonBlank(raw.forceReturnConditionExpression);
  if (exitIf) facts.exitIf = oneLine(exitIf);
  return facts;
}

// ── Step pieces ─────────────────────────────────────────────────────────────

export function kindLabel(step: ParsedStep): string {
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
export function stepBody(step: ParsedStep): { kind: "SQL" | "CODE" | "SPEL"; text: string; language?: string } | null {
  if (step.kind === "SQL" && step.sql) return { kind: "SQL", text: step.sql };
  if (step.kind === "CUSTOM_CODE" && step.source) return { kind: "CODE", text: step.source, language: step.language ?? undefined };
  if (step.kind === "SPEL_ECHO" && step.expression) return { kind: "SPEL", text: step.expression };
  return null;
}

/** `key[→fieldCode][ ⇒ $var]` per output; V2 outputs carry the exposed name as `fieldCode`. */
export function outputSpecs(step: ParsedStep): string[] {
  return (step.outputs ?? []).map((o) => {
    const raw = isObj(o.raw) ? o.raw : {};
    const exposed = nonBlank(raw.fieldCode) ?? nonBlank(raw.name);
    let s = o.code || exposed || "?";
    if (exposed && exposed !== o.code) s += `→${exposed}`;
    const ref = isObj(o.inputReference) ? nonBlank((o.inputReference as Obj).reference) : nonBlank(o.inputReference ?? o.internalVarRef);
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

export interface CompactOptions {
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
}

export interface CompactBlock {
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
  summary?: string;
  /** `key:TYPE` joined by ", "; `*` = required. */
  in?: string;
  out?: string;
  vars?: string;
  steps: string[];
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

export function compactStepLine(step: ParsedStep, opts: CompactOptions = {}): string {
  const bodyChars = opts.bodyChars ?? 160;
  const valueChars = opts.valueChars ?? 60;
  const parts: string[] = [];
  const ident = step.kind === "SQL" || step.kind === "EXISTING_SERVICE" || step.kind === "UNKNOWN" ? identityForStep(step) : "";
  // `SQL db_service.data.read` already names the operation; `SQL(read)` only when the service is unresolved.
  let head = `${step.orderIndex} ${step.kind === "SQL" && ident ? "SQL" : kindLabel(step)}`;
  if (ident) head += ` ${ident}`;
  if (nonBlank(step.description)) head += ` "${abbreviate(step.description!, 80)}"`;
  parts.push(head);

  const f = stepFacts(step);
  if (f.when) parts.push(`when ${f.when}`);
  if (f.loop) {
    const t = f.loop.type ? LOOP_SHORT[f.loop.type] ?? f.loop.type : "loop";
    parts.push(`loop ${t}${f.loop.over ? ` ${f.loop.over}` : ""}${f.loop.counter ? ` as ${f.loop.counter}` : ""}${f.loop.parallel ? " parallel" : ""}`);
  }

  const body = stepBody(step);
  if (body) {
    const tag = body.kind === "SQL" ? "sql: " : body.kind === "CODE" ? "code: " : "= ";
    parts.push(`${tag}${abbreviate(body.text, bodyChars)}`);
  }
  // Every set input, Redis included (ADR-R3: scope / expirationSeconds /
  // canReplace are what a lock step is about).
  const inputs = inputPairs(step, opts.labels?.get(step.orderIndex));
  if (inputs.length) parts.push(inputs.map((i) => `${i.input}=${abbreviate(i.value, valueChars)}`).join(", "));

  const outs = outputSpecs(step);
  if (outs.length) parts.push(`-> ${outs.join(", ")}`);
  const flags: string[] = [];
  if (f.async) flags.push("async");
  if (f.exitOnFailure) flags.push(f.exitMessage ? `exit-on-fail "${abbreviate(f.exitMessage, 60)}"` : "exit-on-fail");
  if (f.exitIf) flags.push(`exit-if ${f.exitIf}`);
  if (step.kind === "UNKNOWN") flags.push(`unparsed: ${step.reason}`);
  if (flags.length) parts.push(flags.join(", "));
  return parts.join(" | ");
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
    summary: nonBlank(method.summary) ? oneLine(method.summary) : undefined,
    in: fieldList(method.inputs.filter((f) => !f.hideInput), true),
    out: method.outputs.length ? method.outputs.map((o) => `${outputName(o)}:${String(o.type ?? "?")}`).join(", ") : undefined,
    vars: fieldList(method.variables),
    steps: steps.map((s) => compactStepLine(s, opts)),
  };
  const want = opts.fullBodies ?? {};
  const blocks: CompactBlock[] = [];
  for (const s of steps) {
    const b = stepBody(s);
    if (!b) continue;
    if ((b.kind === "SQL" && want.sql) || (b.kind === "CODE" && want.code) || (b.kind === "SPEL" && want.spel)) {
      blocks.push({ step: s.orderIndex, kind: b.kind, ...(b.language ? { language: b.language } : {}), text: b.text });
    }
  }
  if (blocks.length) view.blocks = blocks;
  if (method.parseWarnings.length) view.warnings = method.parseWarnings;
  return view;
}

/** Plain-text rendering of a compact view (human mode). */
export function renderCompact(view: CompactMethodView): string {
  const lines: string[] = [];
  lines.push(`${view.name} [${view.state} v${view.version}] ${view.category} ${view.uuid}${view.referenceId ? ` (ref ${view.referenceId})` : ""}`);
  if (view.summary) lines.push(`summary: ${view.summary}`);
  if (view.in) lines.push(`in: ${view.in}`);
  if (view.out) lines.push(`out: ${view.out}`);
  if (view.vars) lines.push(`vars: ${view.vars}`);
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

function storyStepType(step: ParsedStep): string {
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

function storyStepWhat(step: ParsedStep): string {
  const bits: string[] = [];
  const desc = nonBlank(step.description) ?? (step.kind === "SPEL_ECHO" && step.expression ? `computes ${abbreviate(step.expression, 80)}` : undefined);
  if (desc) bits.push(desc);
  const f = stepFacts(step);
  if (f.when) bits.push(`only when ${f.when}`);
  if (f.loop) bits.push(`repeats ${f.loop.type ? LOOP_SHORT[f.loop.type] ?? f.loop.type : "loop"}${f.loop.over ? ` over ${f.loop.over}` : ""}`);
  const outs = (step.outputs ?? []).map((o) => {
    const raw = isObj(o.raw) ? o.raw : {};
    return nonBlank(raw.fieldCode) ?? o.code;
  }).filter(Boolean);
  if (outs.length) bits.push(`gives ${outs.map((o) => `\`${o}\``).join(", ")}`);
  if (f.exitOnFailure) bits.push("stops the method on failure");
  return bits.join("; ");
}

function testValue(f: MethodField): string {
  const v = f.testValue ?? f.defaultValue;
  if (v === undefined || v === null || v === "") return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function storyMarkdown(method: HydratedMethod): string {
  const out: string[] = [];
  out.push(`## ${method.name}`, "");
  const what = nonBlank(method.summary) ?? nonBlank(method.description) ?? "(no summary)";
  out.push(`**What it does:** ${oneLine(what)}`);
  out.push(`**Approach:** ${approach(method)}`);
  out.push(`**Service:** ${method.category?.name ?? "Uncategorized"}`);
  out.push(`**State:** ${method.state} v${method.version} (\`${method.uuid}\`)`, "");

  const inputs = method.inputs.filter((f) => !f.hideInput);
  out.push("### Inputs");
  if (inputs.length === 0) out.push("(none)");
  else {
    out.push("| Field | Type | Test value | Purpose |", "|---|---|---|---|");
    for (const f of inputs) out.push(`| ${cell(f.code)}${f.required ? " (required)" : ""} | ${cell(String(f.type ?? ""))} | ${cell(abbreviate(testValue(f), 60))} | ${cell(f.description)} |`);
  }
  out.push("", "### Outputs");
  if (method.outputs.length === 0) out.push("(none)");
  else {
    out.push("| Field | Type | Purpose |", "|---|---|---|");
    for (const o of method.outputs) out.push(`| ${cell(outputName(o))} | ${cell(String(o.type ?? ""))} | ${cell(o.description)} |`);
  }
  if (method.variables.length) {
    out.push("", "### Variables");
    out.push("| Name | Type | Purpose |", "|---|---|---|");
    for (const v of method.variables) out.push(`| ${cell(v.code)} | ${cell(String(v.type ?? ""))} | ${cell(v.description)} |`);
  }
  out.push("", "### Steps");
  if (method.parsedSteps.length === 0) out.push("(none)");
  else {
    out.push("| # | Type | What it does |", "|---|---|---|");
    for (const s of method.parsedSteps) out.push(`| ${s.orderIndex} | ${cell(storyStepType(s))} | ${cell(storyStepWhat(s))} |`);
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
