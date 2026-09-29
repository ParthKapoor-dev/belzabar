// Compact authoring format → V2 wire (Stage 7: `ad create --spec`, structural
// `ad save` ops). An agent writes a few lines per step; belz fills the V2
// boilerplate the AD UI would write.
//
// Compact step (every key optional except what the kind needs):
//   service      "Service/method" (e.g. "Helpers.Legacy/echo", "db_service/data.read")
//   code         custom-code source (plain text)  → CUSTOM_CODE step
//   language     JAVASCRIPT (default) | PYTHON     executor CODE_LAMBDA (default)
//   sql          SQL text → db_service step; the service defaults from the verb
//                (SELECT/WITH data.read, INSERT data.add, UPDATE data.update,
//                DELETE data.delete) and the text goes to body.queryString
//   account      db account id or nickname; may be omitted only when the service
//                has exactly one account (otherwise AD_SPEC_INVALID lists them)
//   description  step description
//   inputs       {"key": value, "body.nested": value}; values are strings
//                (objects/arrays/numbers are JSON-stringified); keys are the
//                callee contract's input keys (checked online: unknown keys are
//                refused because the server silently drops them)
//   outputs      ["serviceKey", …] | [{key, as?, var?, type?, elementToRetrieve?}]
//                | {"fieldCode": "serviceKey" | {key, var?, …}}; `as` is the
//                name the method sees (fieldCode), `var` writes it into a
//                declared variable (inputReference)
//   when         entry condition (SpEL, e.g. "#{x} ne null"); null clears
//   exit         {onFailure?: bool, code?, message?}
//   exitIf       {when, code?, message?} conditional exit; null clears
//   loop         {over: "#{list}"} | {times: n} | {while: expr} |
//                {from, to, by?} + {counter?, parallel?, threads?}; null clears
//   async        runAsync
// `codeFile` / `sqlFile` are resolved to `code` / `sql` before expansion
// (lib/save/sources.ts), relative to the spec / overlay file.
//
// Encodings: new custom code is stored plain unless the source itself is
// valid base64 (the runtime content-sniffs; see serialize/v2 encodeSource);
// SQL is stored plain with encodingType NONE (flag-driven, verified live).
//
// Pure: callee contracts and db accounts come in through `ServiceCatalog`
// (lib/save/services.ts loads them). Problems are collected, not thrown.

import type { ApiContract, ContractInput } from "../validate/online";
import type { V2Step, V2StepInput } from "../types/v2-wire";
import { decodeBase64Strict, encodeBase64 } from "../base64";

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

// ── problems ────────────────────────────────────────────────────────────────

export interface Problem {
  key: string;
  reason: string;
}

/** Collected refusals: `invalid` = malformed input, `notApplied` = would not land on the server. */
export class Problems {
  invalid: Problem[] = [];
  notApplied: Problem[] = [];
  unknown: string[] = [];
  bad(key: string, reason: string): void {
    this.invalid.push({ key, reason });
  }
  drop(key: string, reason: string): void {
    this.notApplied.push({ key, reason });
  }
  get any(): boolean {
    return this.invalid.length + this.notApplied.length + this.unknown.length > 0;
  }
}

// ── service catalogue ─────────────────────────────────────────────────────

export interface DbAccount {
  id: number | string;
  nickname: string | null;
}

export interface ServiceCatalog {
  /** `"svc/method"` → contract; null = looked up and not found; missing = not loaded. */
  contracts: Map<string, ApiContract | null>;
  /** service → its auth accounts (db_service). */
  accounts: Map<string, DbAccount[]>;
}

export const emptyCatalog = (): ServiceCatalog => ({ contracts: new Map(), accounts: new Map() });

export function splitService(s: string): { service: string; method: string } | null {
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { service: s.slice(0, i).trim(), method: s.slice(i + 1).trim() };
}

const DB_SERVICE = "db_service";

/** db_service method for a SQL text, from its first verb. */
export function dbMethodForSql(sql: string): string {
  const body = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim().replace(/^\(+/, "");
  const verb = (/^([a-z]+)/i.exec(body)?.[1] ?? "").toLowerCase();
  if (verb === "select" || verb === "with") return "data.read";
  if (verb === "insert") return "data.add";
  if (verb === "update") return "data.update";
  if (verb === "delete") return "data.delete";
  return "schema.modify";
}

/** The `"svc/method"` a compact step calls, or null for custom code. */
export function compactService(step: Obj): string | null {
  if (typeof step.service === "string") return step.service.trim();
  if (typeof step.code === "string") return null;
  if (typeof step.sql === "string") return `${DB_SERVICE}/${dbMethodForSql(step.sql)}`;
  return null;
}

// ── keys ──────────────────────────────────────────────────────────────────

export const COMPACT_STEP_KEYS = new Set([
  "service", "code", "language", "executor", "sql", "account", "description",
  "inputs", "outputs", "when", "exit", "exitIf", "loop", "async",
]);
/** update-step `set` keys: the compact step minus `service`, plus output removal. */
export const STEP_SET_KEYS = new Set([...COMPACT_STEP_KEYS].filter((k) => k !== "service").concat(["removeOutputs", "replaceOutputs"]));

/** A raw V2 step (fetched body) rather than a compact one. */
export function isRawV2Step(s: unknown): boolean {
  return isObj(s) && ("properties" in s || "serviceName" in s || "automationAPIId" in s || Array.isArray(s.inputs) || "coreMethod" in s);
}

// ── method-level fields ──────────────────────────────────────────────────

const FIELD_KEYS = new Set(["key", "name", "type", "required", "description", "default", "defaultValue", "secured", "encodingType", "properties", "reference"]);
const OUTPUT_KEYS = new Set(["key", "name", "type", "description", "fieldCode"]);

export type FieldKind = "input" | "variable" | "output";

/**
 * Compact method input / variable / output → V2 entry. A string is the key.
 * `default` is the UI's defaultValue. testValue is refused (every save drops
 * it); a variable's BASE_64 encodingType is refused (silently stripped).
 */
export function expandField(given: unknown, kind: FieldKind, where: string, p: Problems): Obj | null {
  const g: Obj = typeof given === "string" ? { key: given } : isObj(given) ? given : {};
  if (!isObj(given) && typeof given !== "string") {
    p.bad(where, "must be a key string or an object {key, type, …}");
    return null;
  }
  const allowed = kind === "output" ? OUTPUT_KEYS : FIELD_KEYS;
  for (const k of Object.keys(g)) {
    if (k === "testValue") p.drop(`${where}.testValue`, "stored testValues are dropped by every save; pass inputs to `ad test`");
    else if (k === "uuid" || k === "referenceUuid") continue; // server-minted; a copied uuid is dropped
    else if (!allowed.has(k)) p.unknown.push(`${where}.${k}`);
  }
  const key = typeof g.key === "string" ? g.key.trim() : "";
  if (!key) {
    p.bad(`${where}.key`, "required");
    return null;
  }
  if (kind === "variable" && g.encodingType === "BASE_64") {
    p.drop(`${where}.encodingType`, "a variable's BASE_64 encodingType is silently stripped by the server; encode at the step input");
  }
  if (kind === "output") {
    return {
      key,
      fieldCode: typeof g.fieldCode === "string" ? g.fieldCode : key,
      name: typeof g.name === "string" ? g.name : key,
      type: typeof g.type === "string" ? g.type : "STRING",
      ...(typeof g.description === "string" ? { description: g.description } : {}),
    };
  }
  const out: Obj = {
    key,
    name: typeof g.name === "string" ? g.name : key,
    type: typeof g.type === "string" ? g.type : "STRING",
    required: typeof g.required === "boolean" ? g.required : false,
    properties: Array.isArray(g.properties) ? g.properties : [],
    encodingType: typeof g.encodingType === "string" ? g.encodingType : "NONE",
  };
  if (typeof g.description === "string") out.description = g.description;
  const dv = "default" in g ? g.default : g.defaultValue;
  if (dv !== undefined) out.defaultValue = dv;
  if (typeof g.secured === "boolean") out.secured = g.secured;
  if (typeof g.reference === "string") out.reference = g.reference;
  return out;
}

/** Merge compact fields into an existing method field (set-input on a known key); keeps its uuid. */
export function mergeField(existing: Obj, given: Obj, kind: FieldKind, where: string, p: Problems): Obj {
  const fresh = expandField({ ...given, key: existing.key }, kind, where, p);
  if (!fresh) return existing;
  const out = structuredClone(existing);
  for (const k of Object.keys(given)) {
    if (k === "key" || k === "uuid" || k === "testValue") continue;
    const wireKey = k === "default" ? "defaultValue" : k;
    if (wireKey in fresh) out[wireKey] = fresh[wireKey];
  }
  return out;
}

// ── step pieces ──────────────────────────────────────────────────────────

const SPEL = /#\{/;

export function stringValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** New custom code: plain unless the source is itself valid base64 (the runtime sniffs). */
export function encodeNewSource(source: string): string {
  return decodeBase64Strict(source) !== null ? encodeBase64(source) : source;
}

interface OutputSpec {
  key: string;
  as: string;
  var?: string | null;
  type?: string;
  elementToRetrieve?: string;
  description?: string;
}

const COMPACT_OUTPUT_KEYS = new Set(["key", "as", "var", "type", "elementToRetrieve", "description"]);

/** Normalise the three `outputs` spellings to a list. */
export function normaliseOutputs(given: unknown, where: string, p: Problems): OutputSpec[] {
  const one = (o: unknown, w: string, fieldCode?: string): OutputSpec | null => {
    if (typeof o === "string") return { key: o, as: fieldCode ?? o };
    if (!isObj(o)) {
      p.bad(w, "must be a service output key or {key, as?, var?, type?}");
      return null;
    }
    for (const k of Object.keys(o)) if (!COMPACT_OUTPUT_KEYS.has(k)) p.unknown.push(`${w}.${k}`);
    const key = typeof o.key === "string" ? o.key : undefined;
    if (!key) {
      p.bad(`${w}.key`, "required (the service output key, e.g. response, flatData[])");
      return null;
    }
    const as = typeof o.as === "string" ? o.as : fieldCode ?? key;
    const spec: OutputSpec = { key, as };
    if (o.var === null || typeof o.var === "string") spec.var = o.var as string | null;
    else if (o.var !== undefined) p.bad(`${w}.var`, "must be a variable key or null");
    if (typeof o.type === "string") spec.type = o.type;
    if (typeof o.elementToRetrieve === "string") spec.elementToRetrieve = o.elementToRetrieve;
    if (typeof o.description === "string") spec.description = o.description;
    return spec;
  };
  if (Array.isArray(given)) return given.map((o, i) => one(o, `${where}[${i}]`)).filter((x): x is OutputSpec => !!x);
  if (isObj(given)) return Object.entries(given).map(([fc, o]) => one(o, `${where}.${fc}`, fc)).filter((x): x is OutputSpec => !!x);
  p.bad(where, "must be an array or an object {fieldCode: serviceKey}");
  return [];
}

/**
 * A step output key that indexes or paths into a service output
 * (`flatData[0].col`, `flatData[].col`, `response.a`) → why it cannot work and
 * the pattern that does, else null. Live 2026-09-29: the V2 route
 * stores the contract's own key (`flatData[]`, matched by uuid) or drops the
 * output altogether, and drops `elementToRetrieve` on non-code steps, so an
 * index never reaches the runtime.
 */
export function indexedOutputHint(o: Pick<OutputSpec, "key" | "as">, known: string[]): string | null {
  const bare = (k: string) => k.replace(/\[\]$/, "");
  const base = known.find((k) => o.key !== k && (o.key.startsWith(`${bare(k)}[`) || o.key.startsWith(`${bare(k)}.`)));
  if (!base && !/\[\d+\]/.test(o.key)) return null;
  const whole = base ?? o.key.replace(/\[\d+\].*$/, "[]");
  let rest = base ? o.key.slice(bare(base).length).replace(/^\[\]/, "") : o.key.slice(o.key.search(/\[\d+\]/));
  if (!rest.startsWith("[")) rest = `${whole.endsWith("[]") ? "[0]" : ""}${rest.startsWith(".") || !rest ? rest : `.${rest}`}`;
  const tmp = o.as === o.key ? "rows" : `${o.as}Rows`;
  return (
    `'${o.key}' indexes into the service output '${whole}': step output keys cannot be indexed or pathed ` +
    `(the server keeps only the contract key '${whole}' or drops the output). Bind the whole output and reduce it in the next step: ` +
    `outputs [{"key": "${whole}", "as": "${tmp}"}], then {"service": "Helpers.Legacy/echo", "inputs": {"Input": "#{${tmp}${rest}}"}, ` +
    `"outputs": [{"key": "response", "as": "${o.as}"}]}`
  );
}

/** Build one step output. Custom code outputs are bound by key (the server rewrites fieldCode := key). */
function buildOutput(o: OutputSpec, isCc: boolean, multi: boolean, contract: ApiContract | null | undefined, where: string, p: Problems): Obj | null {
  if (isCc) {
    if (o.as !== o.key) {
      p.bad(where, `custom-code outputs are bound by key; the server rewrites fieldCode := key, so '${o.as}' would never be written (use key '${o.as}')`);
      return null;
    }
    const out: Obj = { key: o.key, fieldCode: o.key, name: o.key, type: o.type ?? "TEXT" };
    if (o.elementToRetrieve ?? multi) out.elementToRetrieve = o.elementToRetrieve ?? o.key;
    if (o.description) out.description = o.description;
    if (o.var) out.inputReference = { type: "method_input", reference: o.var };
    return out;
  }
  const outs = contract?.automationAPIOutputs ?? [];
  const match = outs.find((c) => c.consumes === o.key);
  const indexed = !match ? indexedOutputHint(o, outs.map((c) => c.consumes).filter((k): k is string => typeof k === "string")) : null;
  if (indexed) {
    p.drop(where, indexed);
    return null;
  }
  if (outs.length > 0 && !match) {
    p.drop(where, `'${o.key}' is not an output of the service (known: ${outs.map((c) => c.consumes).join(", ")})`);
    return null;
  }
  const out: Obj = {};
  if (match?.uuid) out.uuid = match.uuid;
  Object.assign(out, { key: o.key, fieldCode: o.as, name: o.as });
  if (o.type) out.type = o.type;
  if (o.description) out.description = o.description;
  if (o.var) out.inputReference = { type: "method_input", reference: o.var };
  return out;
}

/** Contract input node for a dotted key path (`body.queryString`), or null. */
function contractPath(contract: ApiContract, segs: string[]): ContractInput[] | null {
  const out: ContractInput[] = [];
  let level = contract.automationUserInputs ?? [];
  for (const s of segs) {
    const node = level.find((c) => c.produces === s);
    if (!node) return null;
    out.push(node);
    level = node.automationUserInputs ?? [];
  }
  return out;
}

function newInputNode(c: ContractInput | undefined, key: string, leaf: boolean): V2StepInput {
  return {
    ...(c?.uuid ? { uuid: c.uuid } : {}),
    key,
    ...(leaf ? {} : { type: "OBJECT", displayWidgetSuggestion: "OBJECT", combineInput: false }),
    properties: [],
    encodingType: "NONE",
  };
}

/**
 * Set `dotted` = value on a step's inputs tree (creating nodes from the
 * callee contract), or remove it (value null). Existing nodes keep their
 * uuid/type/name. SpEL values get combineInput true (CI1).
 */
export function setStepInput(
  inputs: V2StepInput[],
  dotted: string,
  value: unknown,
  contract: ApiContract | null | undefined,
  where: string,
  p: Problems,
): boolean {
  const segs = dotted.split(".").map((s) => s.trim());
  if (segs.some((s) => !s)) {
    p.bad(where, "empty key segment");
    return false;
  }
  const cpath = contract ? contractPath(contract, segs) : null;
  let level = inputs;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const leaf = i === segs.length - 1;
    let idx = level.findIndex((n) => n && n.key === seg);
    if (value === null && idx < 0) {
      p.drop(where, `the step has no input '${dotted}' to remove`);
      return false;
    }
    if (value === null && leaf) {
      level.splice(idx, 1);
      return true;
    }
    if (idx < 0) {
      if (contract === undefined) {
        p.drop(where, `input '${dotted}' is new and the callee contract was not loaded`);
        return false;
      }
      if (!cpath) {
        const known = (contract?.automationUserInputs ?? []).map((c) => c.produces).filter(Boolean);
        p.drop(
          where,
          contract
            ? `'${dotted}' is not an input of the callee (the server silently drops unknown keys; known: ${known.join(", ") || "none"})`
            : "the callee contract was not found, so the input key cannot be checked (the server drops unknown keys)",
        );
        return false;
      }
      level.push(newInputNode(cpath[i], seg, leaf));
      idx = level.length - 1;
    }
    const node = level[idx]!;
    if (leaf) {
      const v = stringValue(value);
      node.value = v;
      if (SPEL.test(v) || node.combineInput === undefined) node.combineInput = true;
      return true;
    }
    if (!Array.isArray(node.properties)) node.properties = [];
    level = node.properties as V2StepInput[];
  }
  return true;
}

const LOOP_KEYS = new Set(["over", "times", "while", "from", "to", "by", "counter", "parallel", "threads", "type", "value", "executeParallel", "numberOfConcurrentThread", "rangeStartInclusive", "rangeEndExclusive", "incrementalCount", "expandedExpression"]);

export function expandLoop(given: unknown, where: string, p: Problems): Obj | null {
  if (!isObj(given)) {
    p.bad(where, "must be an object ({over}|{times}|{while}|{from,to}) or null");
    return null;
  }
  for (const k of Object.keys(given)) if (!LOOP_KEYS.has(k)) p.unknown.push(`${where}.${k}`);
  if (typeof given.type === "string") return structuredClone(given); // raw V2 loop, passed through
  const common = (): Obj => {
    const counter = typeof given.counter === "string" ? (given.counter.startsWith("#{") ? given.counter : `#{${given.counter}}`) : null;
    return {
      counter,
      executeParallel: given.parallel === true,
      numberOfConcurrentThread: typeof given.threads === "number" ? given.threads : null,
    };
  };
  const kinds = ["over", "times", "while", "from"].filter((k) => k in given);
  if (kinds.length !== 1) {
    p.bad(where, "give exactly one of over / times / while / from+to");
    return null;
  }
  if ("over" in given) return { type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", ...common(), value: stringValue(given.over) };
  // The server stores loop numbers as strings (live: 2 → "2"); send them
  // that way so the post-save verify compares like with like.
  if ("times" in given) return { type: "LOOP_EXECUTION_ON_NUMBER", ...common(), value: stringValue(given.times) };
  if ("while" in given) return { type: "LOOP_EXECUTION_ON_CONDITION", ...common(), value: stringValue(given.while) };
  if (!("to" in given)) {
    p.bad(where, "a range loop needs from and to");
    return null;
  }
  return {
    type: "LOOP_EXECUTION_ON_RANGE",
    ...common(),
    rangeStartInclusive: stringValue(given.from),
    rangeEndExclusive: stringValue(given.to),
    ...(given.by !== undefined ? { incrementalCount: stringValue(given.by) } : {}),
  };
}

// ── whole steps ──────────────────────────────────────────────────────────

export function stepSkeleton(type: "EXISTING_SERVICE" | "CUSTOM_CODE"): V2Step {
  const cc = type === "CUSTOM_CODE";
  return {
    coreMethod: false,
    inputs: [],
    outputs: [],
    properties: {
      type,
      runAsync: false,
      exitCondition: {
        exitOnFailure: { value: true, code: null, message: "" },
        conditionalExit: { code: null, message: "", expression: null, expandedExpressions: null },
      },
      entryCondition: { expression: null, expandedExpressions: null },
      customCode: cc
        ? ({ inlineCode: null, language: "JAVASCRIPT", executor: "CODE_LAMBDA", fileName: null, file: null } as never)
        : ({ inlineCode: null, language: null, executor: null, fileName: null, file: null } as never),
    },
    interfaceMigration: false,
  };
}

function pickAccount(service: string, given: unknown, catalog: ServiceCatalog, where: string, p: Problems): { id: number | string; name: string | null } | null {
  const accounts = catalog.accounts.get(service);
  if (given === undefined) {
    if (accounts && accounts.length === 1) return { id: accounts[0]!.id, name: accounts[0]!.nickname };
    p.bad(
      where,
      accounts?.length
        ? `${service} has ${accounts.length} accounts on this env, so the step must name one (id or nickname): ${accounts.map((a) => `${a.id}=${a.nickname}`).join(", ")}`
        : `a ${service} step needs an account (id or nickname); ${accounts ? "the service has no accounts on this env" : "its accounts were not loaded"}`,
    );
    return null;
  }
  if (typeof given !== "string" && typeof given !== "number") {
    p.bad(where, "must be an account id or nickname");
    return null;
  }
  if (!accounts) return { id: given, name: null };
  const hit = accounts.find((a) => String(a.id) === String(given) || (a.nickname ?? "").toLowerCase() === String(given).toLowerCase());
  if (!hit) {
    p.drop(where, `'${given}' is not an account of ${service} (known: ${accounts.map((a) => `${a.id}=${a.nickname}`).join(", ") || "none"}; 500 on save)`);
    return null;
  }
  return { id: hit.id, name: hit.nickname };
}

/**
 * Apply compact fields to a V2 step in place (shared by new steps and
 * update-step). `kind` is the step's family (CUSTOM_CODE / SQL / other).
 */
export function applyStepFields(
  step: V2Step,
  set: Obj,
  ctx: { kind: string; service: string | null; catalog: ServiceCatalog; where: string; p: Problems; isNew: boolean },
): string[] {
  const { p, where, kind, catalog } = ctx;
  const changed: string[] = [];
  const props = step.properties!;
  const at = (k: string) => `${where}.${k}`;
  const isCc = kind === "CUSTOM_CODE";
  const svc = ctx.service ? splitService(ctx.service) : null;
  const contract = ctx.service ? catalog.contracts.get(ctx.service) : null;

  if ("description" in set) {
    if (typeof set.description !== "string") p.bad(at("description"), "must be a string");
    else {
      step.description = set.description;
      changed.push("description");
    }
  }
  if ("code" in set || "language" in set || "executor" in set) {
    if (!isCc) p.drop(at("code"), `the step is ${kind}, not CUSTOM_CODE`);
    else {
      const cc = (props.customCode ??= { inlineCode: null, language: "JAVASCRIPT", executor: "CODE_LAMBDA" } as never);
      if ("code" in set) {
        if (typeof set.code !== "string" || !set.code.trim()) p.bad(at("code"), "must be non-empty source text");
        else {
          // Existing code keeps its stored encoding (plain stays plain, base64 stays base64).
          const current = cc.inlineCode;
          const wasB64 = !ctx.isNew && typeof current === "string" && current.length > 0 && decodeBase64Strict(current) !== null;
          cc.inlineCode = wasB64 ? encodeBase64(set.code) : encodeNewSource(set.code);
          changed.push("code");
        }
      }
      if ("language" in set) {
        if (typeof set.language !== "string") p.bad(at("language"), "must be JAVASCRIPT or PYTHON");
        else {
          cc.language = set.language.toUpperCase() as never;
          changed.push("language");
        }
      }
      if ("executor" in set) {
        if (typeof set.executor !== "string") p.bad(at("executor"), "must be a string");
        else {
          cc.executor = set.executor;
          changed.push("executor");
        }
      }
    }
  }
  if ("sql" in set) {
    if (kind !== "SQL") p.drop(at("sql"), `the step is ${kind}, not SQL`);
    else if (typeof set.sql !== "string" || !set.sql.trim()) p.bad(at("sql"), "must be non-empty SQL text");
    else {
      const slot = findSqlSlot(step.inputs, "");
      if (slot) {
        slot.input.value = encodeSql(slot.input, set.sql);
        if (SPEL.test(set.sql)) slot.input.combineInput = true;
      } else setStepInput((step.inputs ??= []), "body.queryString", set.sql, contract, at("sql"), p);
      changed.push("sql");
    }
  }
  if ("account" in set) {
    if (!svc || kind !== "SQL") p.drop(at("account"), `accounts apply to db_service steps; the step is ${kind}`);
    else {
      const a = pickAccount(svc.service, set.account, catalog, at("account"), p);
      if (a) {
        step.accountConfiguration = { id: a.id, name: a.name };
        const dr = (props as unknown as Obj).databaseRead;
        if (isObj(dr) && "account" in dr) dr.account = String(a.id);
        changed.push("account");
      }
    }
  }
  if ("inputs" in set) {
    if (isCc) p.drop(at("inputs"), "custom-code steps take no inputs here; reference #{name} directly in the code");
    else if (!isObj(set.inputs)) p.bad(at("inputs"), 'must be an object {"key": value}');
    else {
      step.inputs ??= [];
      for (const [k, v] of Object.entries(set.inputs)) {
        if (v === undefined) continue;
        if (setStepInput(step.inputs, k, v, contract, `${at("inputs")}.${k}`, p)) changed.push(`inputs.${k}`);
      }
    }
  }
  // Output semantics (CLI trial: agents expected `outputs` to replace):
  //   outputs         MERGE — upsert by fieldCode (the `as` name); others stay
  //   removeOutputs   drop these fieldCodes
  //   replaceOutputs  REPLACE — the step's outputs become exactly this list
  //                   (a listed fieldCode keeps its uuid; the rest are removed)
  if ("replaceOutputs" in set) {
    if ("outputs" in set || "removeOutputs" in set) {
      p.bad(at("replaceOutputs"), "replaceOutputs is the whole new list; do not combine it with outputs / removeOutputs");
    } else {
      const specs = normaliseOutputs(set.replaceOutputs, at("replaceOutputs"), p);
      const keep = new Set(specs.map((o) => o.as));
      const outs = (step.outputs ??= []) as Obj[];
      for (let i = outs.length - 1; i >= 0; i--) {
        if (!keep.has(outs[i]!.fieldCode as string)) {
          changed.push(`-output ${String(outs[i]!.fieldCode)}`);
          outs.splice(i, 1);
        }
      }
      set = { ...set, outputs: set.replaceOutputs };
      delete set.replaceOutputs;
    }
  }
  if ("outputs" in set || "removeOutputs" in set) {
    step.outputs ??= [];
    const outs = step.outputs as Obj[];
    if ("removeOutputs" in set) {
      if (!Array.isArray(set.removeOutputs)) p.bad(at("removeOutputs"), "must be an array of fieldCodes");
      else
        for (const fc of set.removeOutputs) {
          const i = outs.findIndex((o) => o.fieldCode === fc);
          if (i < 0) p.drop(`${at("removeOutputs")}.${String(fc)}`, "the step has no output with that fieldCode");
          else {
            outs.splice(i, 1);
            changed.push(`-output ${String(fc)}`);
          }
        }
    }
    if ("outputs" in set) {
      const specs = normaliseOutputs(set.outputs, at("outputs"), p);
      for (const [i, o] of specs.entries()) {
        const existing = outs.findIndex((x) => x.fieldCode === o.as);
        if (existing >= 0 && !ctx.isNew) {
          // Update in place: keep the uuid; key / var / type / etr as given.
          const cur = outs[existing]!;
          if (isCc && o.as !== o.key) p.bad(`${at("outputs")}[${i}]`, "custom-code outputs are bound by key");
          cur.key = o.key;
          if (o.var === null) delete cur.inputReference;
          else if (o.var) cur.inputReference = { type: "method_input", reference: o.var };
          if (o.type) cur.type = o.type;
          if (o.elementToRetrieve) cur.elementToRetrieve = o.elementToRetrieve;
          if (o.description) cur.description = o.description;
          changed.push(`output ${o.as}`);
          continue;
        }
        const multi = isCc && specs.length + outs.length > 1;
        const built = buildOutput(o, isCc, multi, contract, `${at("outputs")}[${i}]`, p);
        if (built) {
          outs.push(built);
          changed.push(`output ${o.as}`);
        }
      }
      if (isCc && outs.length > 1) for (const o of outs) if (!o.elementToRetrieve) o.elementToRetrieve = o.key;
    }
  }
  if ("when" in set) {
    if (set.when !== null && typeof set.when !== "string") p.bad(at("when"), "must be a SpEL string or null");
    else {
      props.entryCondition = { expression: (set.when as string | null) || null, expandedExpressions: null };
      changed.push("when");
    }
  }
  // One exit code/message pair per step: the server stores it once and
  // mirrors it into exitOnFailure AND conditionalExit (live; every
  // real body has the two equal). `exit` and `exitIf` both write the pair.
  if ("exit" in set || "exitIf" in set) {
    const ex = (props.exitCondition ??= stepSkeleton("EXISTING_SERVICE").properties!.exitCondition!);
    // code is the HTTP status the method answers with (an integer on the wire).
    const pair: { code?: number | null; message?: string } = {};
    const takePair = (e: Obj, w: string) => {
      for (const k of ["code", "message"] as const) {
        if (!(k in e)) continue;
        let v: number | string | null;
        if (k === "code") {
          const n = typeof e.code === "string" && /^\d{3}$/.test(e.code.trim()) ? Number(e.code) : e.code;
          if (n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < 100 || n > 599)) {
            p.bad(`${w}.code`, "must be an HTTP status code (e.g. 400) or null");
            continue;
          }
          v = n as number | null;
        } else v = e.message === null ? "" : String(e.message);
        if (k in pair && pair[k] !== v) p.bad(`${w}.${k}`, "exit and exitIf share one code/message per step; give it once");
        (pair as Obj)[k] = v;
      }
    };
    if ("exit" in set) {
      const e = set.exit;
      if (!isObj(e)) p.bad(at("exit"), "must be {onFailure?, code?, message?}");
      else {
        for (const k of Object.keys(e)) if (!["onFailure", "code", "message"].includes(k)) p.unknown.push(`${at("exit")}.${k}`);
        if ("onFailure" in e) {
          if (typeof e.onFailure !== "boolean") p.bad(`${at("exit")}.onFailure`, "must be true or false");
          else ex.exitOnFailure.value = e.onFailure;
        }
        takePair(e, at("exit"));
        changed.push("exit");
      }
    }
    if ("exitIf" in set) {
      const e = set.exitIf;
      if (e === null) {
        ex.conditionalExit = { ...ex.conditionalExit, expression: null, expandedExpressions: null };
        changed.push("exitIf");
      } else if (!isObj(e) || typeof e.when !== "string" || !e.when.trim()) p.bad(at("exitIf"), "must be {when, code?, message?} or null");
      else {
        for (const k of Object.keys(e)) if (!["when", "code", "message"].includes(k)) p.unknown.push(`${at("exitIf")}.${k}`);
        ex.conditionalExit = { ...ex.conditionalExit, expression: e.when, expandedExpressions: null };
        takePair(e, at("exitIf"));
        changed.push("exitIf");
      }
    }
    if ("code" in pair) ex.exitOnFailure.code = ex.conditionalExit.code = pair.code ?? null;
    if ("message" in pair) ex.exitOnFailure.message = ex.conditionalExit.message = pair.message ?? "";
  }
  if ("loop" in set) {
    if (set.loop === null) {
      delete props.repeatStepExecution;
      changed.push("loop");
    } else {
      const loop = expandLoop(set.loop, at("loop"), p);
      if (loop) {
        props.repeatStepExecution = loop;
        changed.push("loop");
      }
    }
  }
  if ("async" in set) {
    if (typeof set.async !== "boolean") p.bad(at("async"), "must be true or false");
    else {
      props.runAsync = set.async;
      changed.push("async");
    }
  }
  return changed;
}

/** Expand a compact step to a new V2 step (no id: the server mints it). */
export function expandCompactStep(given: unknown, catalog: ServiceCatalog, where: string, p: Problems): V2Step | null {
  if (!isObj(given)) {
    p.bad(where, "must be an object");
    return null;
  }
  for (const k of Object.keys(given)) {
    if (k === "codeFile" || k === "sqlFile") p.bad(`${where}.${k}`, "was not resolved to its file contents");
    else if (!COMPACT_STEP_KEYS.has(k)) p.unknown.push(`${where}.${k}`);
  }
  const hasCode = "code" in given;
  if (hasCode && ("service" in given || "sql" in given)) {
    p.bad(where, "a step is either custom code (code) or a service call (service / sql), not both");
    return null;
  }
  if (!hasCode && typeof given.service !== "string" && typeof given.sql !== "string") {
    p.bad(where, "needs service (\"Service/method\"), code, or sql");
    return null;
  }
  if (hasCode) {
    const step = stepSkeleton("CUSTOM_CODE");
    if (typeof given.code !== "string" || !given.code.trim()) {
      p.bad(`${where}.code`, "must be non-empty source text");
      return null;
    }
    applyStepFields(step, given, { kind: "CUSTOM_CODE", service: null, catalog, where, p, isNew: true });
    return step;
  }
  const service = compactService(given)!;
  const sm = splitService(service);
  if (!sm) {
    p.bad(`${where}.service`, "must be \"Service/method\"");
    return null;
  }
  const contract = catalog.contracts.get(service);
  if (contract === null) {
    p.drop(`${where}.service`, `${service} does not resolve to an automation API (404 on save); check with \`belz ad services --search\``);
    return null;
  }
  const isSql = sm.service === DB_SERVICE;
  if ("sql" in given && !isSql) {
    p.bad(`${where}.sql`, `sql applies to db_service steps, not ${service}`);
    return null;
  }
  const step = stepSkeleton("EXISTING_SERVICE");
  if (contract?.uuid) step.automationAPIId = contract.uuid;
  step.serviceName = sm.service;
  step.methodName = sm.method;
  const kind = isSql ? "SQL" : "EXISTING_SERVICE";
  if (isSql && !("account" in given)) {
    const a = pickAccount(sm.service, undefined, catalog, `${where}.account`, p);
    if (a) step.accountConfiguration = { id: a.id, name: a.name };
  }
  applyStepFields(step, given, { kind, service, catalog, where, p, isNew: true });
  return step;
}

// ── SQL slot (shared with serialize/v2) ─────────────────────────────────

/**
 * SQL encoding is flag-driven (`encodingType`): BASE_64 slots holding base64
 * get base64; everything else stays plain (a BASE_64 flag on a plain value is
 * ignored by the runtime, so plain stays plain there too).
 */
export function encodeSql(slot: V2StepInput, sql: string): string {
  const v = slot.value;
  const storedB64 = slot.encodingType === "BASE_64" && (typeof v !== "string" || v.length === 0 || decodeBase64Strict(v) !== null);
  return storedB64 ? encodeBase64(sql) : sql;
}

/** Same slot the parser reads (`body.queryString`, else the first BASE_64 string input), with its path. */
export function findSqlSlot(inputs: unknown, path: string): { input: V2StepInput; path: string } | null {
  return (
    findInput(inputs, path, (i) => i.key === "queryString" && typeof i.value === "string") ??
    findInput(inputs, path, (i) => i.encodingType === "BASE_64" && typeof i.value === "string")
  );
}

function findInput(inputs: unknown, path: string, pred: (i: V2StepInput) => boolean): { input: V2StepInput; path: string } | null {
  if (!Array.isArray(inputs)) return null;
  for (let k = 0; k < inputs.length; k++) {
    const raw = inputs[k];
    if (!raw || typeof raw !== "object") continue;
    const i = raw as V2StepInput;
    const p = `${path}[${k}]`;
    if (pred(i)) return { input: i, path: p };
    const nested = findInput(i.properties, `${p}.properties`, pred);
    if (nested) return nested;
  }
  return null;
}
