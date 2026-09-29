// L1 — structural validation of a V2 method body.
//
// zod checks JSON types and the server-side enums (step type, language,
// executor, state); explicit checks add the key regexes and required fields,
// each under its own rule code. Enums and optional fields are calibrated on the
// 36 real a dev env bodies in tests/fixtures/real-v2 (nullable almost
// everywhere; step `id`/`automationAPIId` absent on custom code).

import { z } from "zod";
import { classifyService } from "../parser/steps/classify";
import { arr, str, type Report, type StepRef } from "./types";
import { isObj, str as nonBlank } from "@belzabar/core";

/** ^\w+$ — input, variable and output keys; step output name/fieldCode (live-verified). */
const KEY_RE = /^[A-Za-z0-9_]+$/;
/** Method names also allow `. ~ -`, but not a leading/trailing `.` (live-verified). */
const METHOD_NAME_RE = /^[A-Za-z0-9_.~-]+$/;
/** 32 hex (the server pads with spaces) or a dashed uuid (db_service). */
const UUID_RE = /^(?:[0-9a-fA-F]{32}\s*|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

const STEP_TYPES = ["EXISTING_SERVICE", "CUSTOM_CODE"] as const;
/** Server enum (400 on anything else). */
const CC_LANGUAGES = ["JAVA", "COBOL", "PYTHON", "JAVASCRIPT", "PERL"] as const;
const CC_EXECUTORS = ["CODE_LAMBDA", "NODEJS_LAMBDA", "INTERNAL_SERVER"] as const;
/** Data types: the team's documented set plus CUSTOM and ENUM (both seen live on a dev env). */
export const DATA_TYPES = new Set([
  "STRING", "TEXT", "NUMBER", "INTEGER", "FLOAT", "BOOLEAN", "OBJECT", "ARRAY", "JSON", "DATE", "TIMESTAMP", "CUSTOM", "ENUM",
]);

const nStr = z.string().nullable().optional();
const idLike = z.union([z.string(), z.number()]).nullable().optional();

const condition = z
  .object({ expression: nStr, expandedExpressions: z.array(z.unknown()).nullable().optional() })
  .passthrough();

const exitCondition = z
  .object({
    exitOnFailure: z
      .object({ value: z.boolean().nullable().optional(), code: idLike, message: nStr })
      .passthrough()
      .nullable()
      .optional(),
    conditionalExit: z
      .object({ expression: nStr, message: nStr, code: idLike, expandedExpressions: z.array(z.unknown()).nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const customCode = z
  .object({
    inlineCode: nStr,
    language: z.enum(CC_LANGUAGES).nullable().optional(),
    executor: z.enum(CC_EXECUTORS).nullable().optional(),
  })
  .passthrough();

const loop = z
  .object({
    type: z.string().nullable().optional(),
    counter: nStr,
    value: z.union([z.string(), z.number()]).nullable().optional(),
    executeParallel: z.boolean().nullable().optional(),
    numberOfConcurrentThread: z.union([z.number(), z.string()]).nullable().optional(),
  })
  .passthrough();

const stepProperties = z
  .object({
    type: z.enum(STEP_TYPES),
    runAsync: z.boolean().nullable().optional(),
    entryCondition: condition.nullable().optional(),
    exitCondition: exitCondition.nullable().optional(),
    customCode: customCode.nullable().optional(),
    repeatStepExecution: loop.nullable().optional(),
  })
  .passthrough();

type StepInputShape = { [k: string]: unknown };
const stepInput: z.ZodType<StepInputShape> = z.lazy(() =>
  z
    .object({
      uuid: nStr,
      key: nStr,
      name: nStr,
      type: nStr,
      combineInput: z.boolean().nullable().optional(),
      encodingType: nStr,
      encodedBase64: z.boolean().nullable().optional(),
      properties: z.array(stepInput).nullable().optional(),
      outputRef: z.object({ referenceStepIndex: z.number().nullable().optional() }).passthrough().nullable().optional(),
    })
    .passthrough(),
);

const stepOutput = z
  .object({
    uuid: nStr,
    key: nStr,
    fieldCode: nStr,
    name: nStr,
    type: nStr,
    elementToRetrieve: nStr,
    inputReference: z.object({ type: nStr, reference: nStr }).passthrough().nullable().optional(),
  })
  .passthrough();

const step = z
  .object({
    id: nStr,
    automationAPIId: nStr,
    serviceName: nStr,
    methodName: nStr,
    description: nStr,
    inputs: z.array(stepInput).nullable().optional(),
    outputs: z.array(stepOutput).nullable().optional(),
    accountConfiguration: z.object({ id: idLike, name: nStr }).passthrough().nullable().optional(),
    properties: stepProperties,
  })
  .passthrough();

const field = z
  .object({ uuid: nStr, key: nStr, name: nStr, type: nStr, required: z.boolean().nullable().optional() })
  .passthrough();

const methodOutput = z.object({ uuid: nStr, key: nStr, name: nStr, fieldCode: nStr, type: nStr }).passthrough();

const metadata = z
  .object({
    state: z.enum(["DRAFT", "PUBLISHED"]).nullable().optional(),
    referenceId: nStr,
    version: z.object({ name: z.union([z.string(), z.number()]).nullable().optional() }).passthrough().nullable().optional(),
    service: z.object({ id: idLike, uuid: nStr, name: nStr }).passthrough().nullable().optional(),
  })
  .passthrough();

const methodSchema = z
  .object({
    uuid: nStr,
    name: z.string().nullable().optional(),
    summary: nStr,
    description: nStr,
    metadata: metadata.optional(),
    inputs: z.array(field).nullable().optional(),
    variables: z.array(field).nullable().optional(),
    outputs: z.array(methodOutput).nullable().optional(),
    steps: z.array(step),
  })
  .passthrough();

// ── helpers ───────────────────────────────────────────────────────────────

export function jsonPath(parts: ReadonlyArray<string | number>): string {
  let out = "";
  for (const p of parts) out += typeof p === "number" ? `[${p}]` : out ? `.${p}` : p;
  return out;
}

export function stepKind(s: unknown): string {
  if (!isObj(s)) return "UNKNOWN";
  const props = s.properties;
  if (isObj(props) && props.type === "CUSTOM_CODE") return "CUSTOM_CODE";
  if (!isObj(props) || props.type !== "EXISTING_SERVICE") return "UNKNOWN";
  const system = str(s.serviceName)?.trim();
  const api = str(s.methodName)?.trim();
  if (system && api) {
    if (system === "Helpers.Legacy" && api === "exception.raise") return "EXCEPTION";
    return classifyService({ system, api }).kind;
  }
  return "EXISTING_SERVICE";
}

export function stepRef(s: unknown, index: number): StepRef {
  const ref: StepRef = { orderIndex: index + 1, kind: stepKind(s) };
  if (isObj(s)) {
    const svc = str(s.serviceName)?.trim();
    const m = str(s.methodName)?.trim();
    if (svc && m) ref.service = `${svc}/${m}`;
  }
  return ref;
}

// ── L1 ────────────────────────────────────────────────────────────────────

/** Returns false when the body is not usable at all (later layers are skipped). */
export function checkStructure(body: unknown, report: Report): boolean {
  if (!isObj(body)) {
    report({ rule: "AD-SCHEMA-001", message: "The method body is not a JSON object.", path: "" });
    return false;
  }
  if (!Array.isArray(body.steps)) {
    const v1 = Array.isArray(body.services) || typeof body.jsonDefinition === "string";
    report({
      rule: "M2",
      message: v1
        ? "This looks like a V1 body (services[] / jsonDefinition); the validator and save route take the V2 body (steps[])."
        : "The method has no steps array.",
      path: "steps",
      fix: v1 ? "Fetch the method with `belz ad fetch <uuid> --v2` and edit that body." : "Add a steps array.",
    });
    return false;
  }

  const parsed = methodSchema.safeParse(body);
  if (!parsed.success) {
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
      const path = jsonPath(issue.path);
      const f = mapIssue(issue, body);
      const key = `${f.rule}|${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const stepIdx = issue.path[0] === "steps" && typeof issue.path[1] === "number" ? issue.path[1] : undefined;
      report({
        ...f,
        path,
        ...(stepIdx !== undefined ? { step: stepRef(arr(body.steps)[stepIdx], stepIdx) } : {}),
      });
    }
  }

  checkMethodFields(body, report);
  arr(body.steps).forEach((s, i) => checkStepStructure(s, i, report));
  return true;
}

function mapIssue(issue: z.ZodIssue, body: Record<string, unknown>): { rule: string; message: string; fix?: string; evidence?: string } {
  const p = issue.path;
  const last = p[p.length - 1];
  const got = describeValueAt(body, p);
  if (p[0] === "steps" && p[2] === "properties" && (p.length === 3 || last === "type")) {
    return p.length === 3
      ? { rule: "S1", message: "Step has no properties object.", fix: "Copy properties from a fetched step; set properties.type.", evidence: "500 NPE AutomationChainStep.getProperties() is null" }
      : { rule: "S1", message: `properties.type ${got} is not EXISTING_SERVICE or CUSTOM_CODE.`, fix: "Use EXISTING_SERVICE or CUSTOM_CODE.", evidence: "400 JSON parse error … not one of [EXISTING_SERVICE, CUSTOM_CODE]" };
  }
  if (p[0] === "steps" && p[3] === "customCode" && last === "language") {
    return { rule: "CC1", message: `Custom code language ${got} is not one of ${CC_LANGUAGES.join("|")}.`, fix: "Use JAVASCRIPT or PYTHON.", evidence: "400 enum parse error" };
  }
  if (p[0] === "steps" && p[3] === "customCode" && last === "executor") {
    return { rule: "CC5", message: `Custom code executor ${got} is not one of ${CC_EXECUTORS.join("|")}.`, fix: "Use CODE_LAMBDA.", evidence: "400 enum parse error" };
  }
  if (p[0] === "metadata" && last === "state") {
    return { rule: "AD-SCHEMA-001", message: `metadata.state ${got} is not DRAFT or PUBLISHED.` };
  }
  if (last === "inputReference") {
    return { rule: "AD-SCHEMA-001", message: `inputReference must be an object {type, reference} or null, got ${got}.`, fix: 'Use {"type":"method_input","reference":"<variable>"} or remove it.', evidence: "400 Cannot coerce empty String … AutomationChainInputReference" };
  }
  return { rule: "AD-SCHEMA-001", message: `${issue.message} (got ${got}).` };
}

function describeValueAt(root: unknown, path: ReadonlyArray<string | number>): string {
  let cur: unknown = root;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return "undefined";
    cur = (cur as Record<string | number, unknown>)[k];
  }
  if (cur === undefined) return "missing";
  const s = JSON.stringify(cur);
  return s && s.length > 40 ? `${s.slice(0, 37)}...` : String(s);
}

function checkMethodFields(body: Record<string, unknown>, report: Report): void {
  const name = body.name;
  if (typeof name !== "string" || !name.trim()) {
    report({ rule: "M1", message: "Method name is required.", path: "name" });
  } else if (!METHOD_NAME_RE.test(name) || name.startsWith(".") || name.endsWith(".")) {
    report({
      rule: "M1",
      message: `Method name "${name}" is invalid: letters, digits and _ . - ~ only, no spaces, no leading/trailing '.'.`,
      path: "name",
      evidence: "400 invalid_method_name",
    });
  }

  const meta = body.metadata;
  if (isObj(meta) && meta.state === "PUBLISHED") {
    report({
      rule: "AD-META-001",
      message: "metadata.state is PUBLISHED; only drafts can be saved.",
      path: "metadata.state",
      fix: "Save the draft (resolve it with `belz ad state <uuid>`).",
      evidence: "400 Draft referenceId is mandatory for the Published method",
    });
  }
  if (nonBlank(body.uuid)) {
    const missing = ["version", "service", "internal"].filter((k) => !isObj(meta) || meta[k] == null);
    if (missing.length > 0) {
      report({
        rule: "AD-META-002",
        message: `Update body is missing metadata.${missing.join(", metadata.")}; the server checks the full state block.`,
        path: "metadata",
        fix: "Overlay your changes onto a fresh GET of the V2 body.",
        evidence: "400 Invalid state, provided state does not match.",
      });
    }
  }

  arr(body.inputs).forEach((inp, i) => {
    if (!isObj(inp)) return;
    const k = inp.key;
    if (typeof k === "string" && k && !KEY_RE.test(k)) {
      report({ rule: "IK1", message: `Method input key "${k}" is invalid: letters, digits and underscore only.`, path: jsonPath(["inputs", i, "key"]), evidence: "400 invalid_input_key" });
    }
    checkDataType(inp.type, jsonPath(["inputs", i, "type"]), `Method input "${str(k) ?? i}"`, report);
  });
  arr(body.variables).forEach((v, i) => {
    if (!isObj(v)) return;
    const k = v.key;
    if (typeof k === "string" && k && !KEY_RE.test(k)) {
      report({ rule: "VK1", message: `Variable key "${k}" is invalid: letters, digits and underscore only (dots are rejected live).`, path: jsonPath(["variables", i, "key"]), evidence: "400 invalid_internal_variable_key" });
    }
    checkDataType(v.type, jsonPath(["variables", i, "type"]), `Variable "${str(k) ?? i}"`, report);
  });
  arr(body.outputs).forEach((o, i) => {
    if (!isObj(o)) return;
    const k = o.key;
    if (typeof k !== "string" || !k.trim()) {
      report({
        rule: "OK1",
        message: `Method output ${JSON.stringify(o.name ?? o.fieldCode ?? i)} has no key; method outputs are keyed by 'key', not 'fieldCode'.`,
        path: jsonPath(["outputs", i, "key"]),
        fix: "Set key to the step output fieldCode or variable it returns.",
        evidence: 'save 200, then every run 500 NPE "key" is null',
      });
    } else if (!KEY_RE.test(k)) {
      report({ rule: "OK1", message: `Method output key "${k}" is invalid: letters, digits and underscore only.`, path: jsonPath(["outputs", i, "key"]) });
    }
    const nm = o.name;
    if (typeof nm === "string" && nm && !KEY_RE.test(nm)) {
      report({ rule: "ON1", message: `Method output name "${nm}" is invalid: letters, digits and underscore only.`, path: jsonPath(["outputs", i, "name"]), evidence: "400 invalid_output_name" });
    }
    checkDataType(o.type, jsonPath(["outputs", i, "type"]), `Method output "${str(k) ?? i}"`, report);
  });
}

function checkDataType(t: unknown, path: string, what: string, report: Report): void {
  if (typeof t !== "string" || !t) return;
  if (!DATA_TYPES.has(t)) {
    report({ rule: "AD-SCHEMA-002", message: `${what} has type "${t}", which is not a known data type.`, path, fix: `Use one of ${[...DATA_TYPES].join(", ")}.`, evidence: "500 An error has occurred at server side" });
  }
}

function checkStepStructure(s: unknown, i: number, report: Report): void {
  if (!isObj(s)) return;
  const ref = stepRef(s, i);
  const at = (...rest: Array<string | number>) => jsonPath(["steps", i, ...rest]);
  const props = isObj(s.properties) ? s.properties : undefined;
  const type = props?.type;

  const id = nonBlank(s.id);
  if (id && !UUID_RE.test(str(s.id)!)) {
    report({ rule: "S2", message: `Step id ${JSON.stringify(s.id)} is not a uuid; the server will replace it.`, path: at("id"), step: ref });
  }

  if (type === "EXISTING_SERVICE") {
    const apiId = nonBlank(s.automationAPIId);
    if (!apiId && !(nonBlank(s.serviceName) && nonBlank(s.methodName))) {
      report({ rule: "ES1", message: "EXISTING_SERVICE step names no service: set automationAPIId or serviceName + methodName.", path: at("automationAPIId"), step: ref });
    }
    if (apiId && !UUID_RE.test(str(s.automationAPIId)!)) {
      report({ rule: "ES2", message: `automationAPIId ${JSON.stringify(s.automationAPIId)} is not a uuid.`, path: at("automationAPIId"), step: ref });
    }
  }

  walkInputs(s.inputs, ["steps", i, "inputs"], (inp, path) => {
    if (!nonBlank(inp.key)) report({ rule: "EI1", message: "Step input has no key.", path: jsonPath([...path, "key"]), step: ref });
    const t = inp.type;
    if (typeof t === "string" && t && !DATA_TYPES.has(t)) {
      report({ rule: "EI2", message: `Step input "${str(inp.key) ?? "?"}" has type "${t}", not a known data type.`, path: jsonPath([...path, "type"]), step: ref });
    }
    const u = nonBlank(inp.uuid);
    if (u && !UUID_RE.test(str(inp.uuid)!)) {
      report({ rule: "AD-SCHEMA-003", message: `Step input uuid ${JSON.stringify(inp.uuid)} is not a uuid.`, path: jsonPath([...path, "uuid"]), step: ref });
    }
  });

  arr(s.outputs).forEach((o, j) => {
    if (!isObj(o)) return;
    const op = (k: string) => at("outputs", j, k);
    const writesVar = isObj(o.inputReference) && !!nonBlank(o.inputReference.reference);
    const isCC = type === "CUSTOM_CODE";
    for (const field of ["fieldCode", "name"] as const) {
      const v = o[field];
      if (typeof v === "string" && v.trim()) {
        if (!KEY_RE.test(v)) {
          report({ rule: "NC1", message: `Step output ${field} "${v}" is invalid: letters, digits and underscore only.`, path: op(field), step: ref, evidence: `400 invalid_step_output_${field === "name" ? "name" : "field_code"}` });
        }
        continue;
      }
      // Missing / empty. VB1 (variable writers) and CO2 (custom-code name) own their cases.
      if (writesVar) continue;
      if (isCC && field === "name") continue;
      report({
        rule: "AD-OUT-001",
        message: `Step output ${field} is ${v === null ? "null" : "missing or empty"}.`,
        path: op(field),
        step: ref,
        evidence: v === null && field === "fieldCode" ? "500 NPE AutomationChainOutput.getCode() is null" : `400 invalid_step_output_${field === "name" ? "name" : "field_code"}`,
      });
    }
    if (!nonBlank(o.key)) {
      report({ rule: "AD-OUT-002", message: "Step output has no key (the service output it binds).", path: op("key"), step: ref });
    }
    const u = nonBlank(o.uuid);
    if (u && !UUID_RE.test(str(o.uuid)!)) {
      report({ rule: "AD-SCHEMA-003", message: `Step output uuid ${JSON.stringify(o.uuid)} is not a uuid.`, path: op("uuid"), step: ref });
    }
  });
}

/** Depth-first walk of step inputs and their nested `properties`. */
export function walkInputs(
  inputs: unknown,
  base: ReadonlyArray<string | number>,
  visit: (inp: Record<string, unknown>, path: Array<string | number>) => void,
): void {
  arr(inputs).forEach((inp, i) => {
    if (!isObj(inp)) return;
    const path = [...base, i];
    visit(inp, path);
    walkInputs(inp.properties, [...path, "properties"], visit);
  });
}
