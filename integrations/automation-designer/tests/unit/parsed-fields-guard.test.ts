// Guard: no behaviour-affecting wire field is silently dropped by the parser.
//
// For every real fixture (V1 and V2), every wire key whose value is not a
// default (null / "" / false / "null" / [] / {}) must either be represented in
// the parsed model (the accessor returns something) or sit on the ignore list
// below with a reason. A key nobody listed fails the test: when a new capture
// brings a new key, decide whether it changes behaviour (parse + render it) or
// is bookkeeping (add it here, with why).
//
// Why: `ad show` once dropped a step's conditional exit
// (`forceReturnConditionExpression` / `conditionalExit`), and an agent spent
// ~150 calls concluding a gate did not exist.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "fs";
import { parseV1Method } from "../../lib/parser/v1";
import { parseV2Method } from "../../lib/parser/v2";
import type { HydratedMethod, MethodField, MethodOutput, ParsedStep, StepInput } from "../../lib/types/common";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

const FIX = `${import.meta.dir}/../fixtures`;

/** Accessor into the parsed model, or the reason the key is not modelled. */
type Rule<T> = ((parsed: T) => unknown) | string;

const BOOK = "bookkeeping: ids, audit stamps, versions or migration markers";
const UI = "UI-only state (tabs, widgets, run status in the designer)";
const PERM = "designer permissions (who may edit/view the method), not runtime behaviour";
const PICKER = "the designer's output-picker state behind a `#{…}` value; the value (parsed) is what runs";
const RAW = "kept verbatim in the step/field `raw`; the value lives in a parsed sibling";

// ── Method level ────────────────────────────────────────────────────────────

const V2_METHOD: Record<string, Rule<HydratedMethod>> = {
  uuid: (m) => m.uuid,
  name: (m) => m.name,
  summary: (m) => m.summary,
  description: (m) => m.description,
  automationState: (m) => m.state,
  methodDeprecated: (m) => m.deprecated,
  deprecatedAt: BOOK,
  deprecatedBy: BOOK,
  automationApiId: BOOK,
  changelogs: BOOK,
  testSuite: "test suite: read by `ad test-cases`, not part of the method's behaviour",
  migration: BOOK,
  interfaceMigration: BOOK,
  securityFields: (m) => m.securityFields.length || undefined,
  "metadata.version.uuid": BOOK,
  "metadata.version.name": (m) => m.version,
  "metadata.version.description": BOOK,
  "metadata.referenceId": (m) => m.referenceId,
  "metadata.state": (m) => m.state,
  "metadata.service.id": (m) => m.category?.id,
  "metadata.service.uuid": (m) => m.category?.uuid,
  "metadata.service.name": (m) => m.category?.name,
  "metadata.service.description": "the category's own description text",
  steps: (m) => m.parsedSteps.length || undefined,
  inputs: (m) => m.inputs.length || undefined,
  outputs: (m) => m.outputs.length || undefined,
  variables: (m) => m.variables.length || undefined,
  "metadata.categories": PERM,
  "metadata.executionTimeLimit.timeoutInSecond": (m) => m.timeoutSeconds,
  "metadata.internal.createdAt": (m) => m.createdOn,
  "metadata.internal.createdBy": BOOK,
  "metadata.internal.lastPublishedAt": BOOK,
  "metadata.internal.lastPublishedBy": BOOK,
  "metadata.internal.migrationVersion": BOOK,
  "metadata.internal.sourceEnvironment": BOOK,
  "metadata.internal.systemMethod": BOOK,
  "permissions.methodScope": (m) => m.scope,
  "permissions.permissionSet": PERM,
  "permissions.allowedCategories": PERM,
};

const V1_METHOD: Record<string, Rule<HydratedMethod>> = {
  id: (m) => m.numericId,
  uuid: (m) => m.uuid,
  name: (m) => m.name,
  aliasName: (m) => m.aliasName,
  aliasUuid: BOOK,
  referenceId: (m) => m.referenceId,
  automationState: (m) => m.state,
  state: (m) => m.state,
  version: (m) => m.version,
  methodDeprecated: (m) => m.deprecated,
  scope: (m) => m.scope,
  category: (m) => m.category?.name,
  createdOn: (m) => m.createdOn,
  updatedOn: (m) => m.updatedOn,
  updatedBy: (m) => m.updatedBy,
  createdBy: BOOK,
  deprecatedAt: BOOK,
  deprecatedBy: BOOK,
  lastPublishedAt: BOOK,
  lastPublishedBy: BOOK,
  migration: BOOK,
  migrationVersion: BOOK,
  automationApiUuid: BOOK,
  changelog: BOOK,
  sourceRefId: BOOK,
  sourceRefType: BOOK,
  methodType: BOOK,
  active: "designer flag; always false on captures, the runtime ignores it",
  permissions: PERM,
  permissionSet: PERM,
  allowedCategoryNames: PERM,
  allowedCategoryUuids: PERM,
  securityTags: PERM,
  securityTagsCommaSeparated: PERM,
  jsonDefinition: "parsed below (V1_DEFINITION)",
};

const V1_DEFINITION: Record<string, Rule<HydratedMethod>> = {
  name: (m) => m.name,
  uuid: BOOK,
  summary: (m) => m.summary,
  methodDescription: (m) => m.description,
  buttonLabel: (m) => m.buttonLabel,
  internalMethod: (m) => m.internalMethod,
  scope: (m) => m.scope,
  inputs: (m) => m.inputs.length || undefined,
  outputs: (m) => m.outputs.length || undefined,
  variables: (m) => m.variables.length || undefined,
  services: (m) => m.parsedSteps.length || undefined,
  assertions: (m) => m.assertions.length || undefined,
  securityFields: (m) => m.securityFields.length || undefined,
  allowedCategoryUuids: PERM,
  executionStatus: UI,
  useServiceAuthenticationStructure: "always false on captures; service-level auth switch not modelled yet",
};

// ── Step level ──────────────────────────────────────────────────────────────

const V2_STEP: Record<string, Rule<ParsedStep>> = {
  id: BOOK,
  automationAPIId: (s) => s.automationApiId,
  serviceName: (s) => s.serviceName,
  methodName: (s) => s.methodName,
  description: (s) => s.description,
  inputs: (s) => s.inputs.length || undefined,
  outputs: (s) => s.outputs.length || undefined,
  coreMethod: BOOK,
  interfaceMigration: BOOK,
  "accountConfiguration.id": (s) => s.account?.id,
  "accountConfiguration.name": (s) => s.account?.name,
  "properties.type": (s) => s.kind,
  "properties.runAsync": (s) => s.runAsync,
  "properties.entryCondition.expression": (s) => s.conditionExpression,
  // the designer's row form of the expression; the expression is what runs.
  "properties.entryCondition.expandedExpressions": (s) => s.conditionExpression,
  "properties.exitCondition.exitOnFailure.value": (s) => s.forceExitFromFailure,
  "properties.exitCondition.exitOnFailure.code": (s) => s.forceExitStatusCode,
  "properties.exitCondition.exitOnFailure.message": (s) => s.forceExitErrorMessage,
  "properties.exitCondition.conditionalExit.expression": (s) => s.forceReturnExpression,
  "properties.exitCondition.conditionalExit.expandedExpressions": (s) => s.forceReturnExpression,
  // code / message are set in pairs with exitOnFailure; they only act with an expression.
  "properties.exitCondition.conditionalExit.code": (s) => s.forceReturnStatusCode ?? (s.forceReturnExpression ? undefined : "no expression"),
  "properties.exitCondition.conditionalExit.message": (s) => s.forceReturnMessage ?? (s.forceReturnExpression ? undefined : "no expression"),
  "properties.repeatStepExecution.type": (s) => s.loopConfiguration?.type,
  "properties.repeatStepExecution.value": (s) => s.loopExecutionSource,
  "properties.repeatStepExecution.counter": (s) => s.loopConfiguration?.counter,
  "properties.repeatStepExecution.executeParallel": (s) => s.loopConfiguration?.executeParallel,
  "properties.repeatStepExecution.numberOfConcurrentThread": (s) => s.loopConfiguration?.numberOfConcurrentThread,
  "properties.repeatStepExecution.rangeStartInclusive": (s) => s.loopExecutionSource,
  "properties.repeatStepExecution.rangeEndExclusive": (s) => s.loopExecutionSource,
  "properties.customCode.inlineCode": (s) => (s.kind === "CUSTOM_CODE" ? s.source : undefined),
  "properties.customCode.language": (s) => (s.kind === "CUSTOM_CODE" ? s.language : undefined),
  "properties.customCode.executor": (s) => (s.kind === "CUSTOM_CODE" ? s.customCodeEnv : undefined),
  "properties.customCode.fileName": "file-backed custom code; not on any capture with a value",
  "properties.customCode.file": "file-backed custom code; not on any capture with a value",
  // a string mirror of accountConfiguration.id.
  "properties.databaseRead.account": (s) => s.account?.id,
  "properties.databaseRead.query": "legacy slot; the query is the queryString input (SqlStep.sql)",
};

const V1_STEP: Record<string, Rule<ParsedStep>> = {
  orderIndex: (s) => s.orderIndex,
  description: (s) => s.description,
  automationId: (s) => s.automationId,
  automationApiId: (s) => s.automationApiId,
  automationApiUuid: (s) => s.automationApiUuid ?? "unresolved offline (definition lookup)",
  categoryName: "service system name hint; resolved into serviceName via the definition",
  "activeTab.id": (s) => s.kind,
  "activeTab.text": UI,
  "activeTab.active": UI,
  automationUiSelector: UI,
  executionStatus: UI,
  "executionStatus.executed": UI,
  "executionStatus.failed": UI,
  "executionStatus.calls": UI,
  canExecute: UI,
  empty: UI,
  type: BOOK,
  code: (s) => (s.kind === "CUSTOM_CODE" ? s.source : undefined),
  language: (s) => (s.kind === "CUSTOM_CODE" ? s.language : undefined),
  customCodeEnv: (s) => (s.kind === "CUSTOM_CODE" ? s.customCodeEnv : undefined),
  javascriptNodeJsLambda: "always false on captures; customCodeEnv carries the executor",
  file: "file-backed custom code; not on any capture with a value",
  fileName: "file-backed custom code; not on any capture with a value",
  fatFileType: "file-backed custom code; not on any capture with a value",
  mappings: (s) => s.inputs.length || undefined,
  inputs: RAW,
  outputs: (s) => s.outputs.length || undefined,
  runAsync: (s) => s.runAsync,
  streamCapable: (s) => s.streamCapable,
  repeatStepExecution: (s) => s.repeatStepExecution,
  loopExecutionSource: (s) => s.loopExecutionSource,
  "loopConfiguration.type": (s) => s.loopConfiguration?.type,
  "loopConfiguration.executeParallel": (s) => s.loopConfiguration?.executeParallel,
  conditionMode: (s) => s.conditionMode,
  conditionExpression: (s) => s.conditionExpression,
  condition: (s) => s.conditionRows,
  forceExitFromFailure: (s) => s.forceExitFromFailure,
  forceExitErrorMessage: (s) => s.forceExitErrorMessage,
  forceExitStatusCode: (s) => s.forceExitStatusCode,
  forceExist: "always false on captures; a misspelt designer flag, not read by the runtime",
  forceReturnConditionExpression: (s) => s.forceReturnExpression,
  // the designer keeps a mode even with no condition; it only matters with one.
  forceReturnConditionMode: (s) => s.forceReturnMode ?? (s.forceReturnExpression || s.forceReturnRows ? undefined : "no condition"),
  forceReturnCondition: (s) => s.forceReturnRows,
  automationAuthId: (s) => s.account?.id,
  accountName: (s) => s.account?.name,
  testAccountId: "the designer's test-run account; production runs use automationAuthId",
  currentAccount: UI,
  useServiceAuthenticationStructure: "always false on captures; service-level auth switch not modelled yet",
};

// ── Step inputs / outputs, method fields ────────────────────────────────────

const V2_INPUT: Record<string, Rule<StepInput>> = {
  uuid: (i) => i.automationUserInputUuid,
  key: (i) => i.key,
  name: (i) => i.label,
  value: (i) => i.value,
  combineInput: (i) => i.combineInput,
  encodingType: (i) => i.encodingType,
  reference: (i) => i.reference,
  properties: (i) => i.mappings,
  type: "the service's declared input type (definition data)",
  displayWidgetSuggestion: UI,
  encodedBase64: "always false on captures; encodingType carries the encoding",
  outputRef: PICKER,
  serviceIndex: PICKER,
  outputAutomationId: PICKER,
  automationUserOutputId: PICKER,
};

const V1_INPUT: Record<string, Rule<StepInput>> = {
  automationUserInputId: (i) => i.automationUserInputId,
  automationUserInputUuid: (i) => i.automationUserInputUuid,
  value: (i) => i.value,
  combineInputs: (i) => i.combineInput,
  uiRepresentation: (i) => i.uiRepresentation,
  encodingType: (i) => i.encodingType,
  securedInput: (i) => i.securedInput,
  mappings: (i) => i.mappings,
  sensitiveInput: "always false on captures; log-masking flag",
  requiresProcessing: "server-derived: set when the value holds a #{…} reference",
  skipFileProcessing: "file-input handling flag; not on any capture with a behaviour change",
  withPrefix: "always false on captures",
  encodedBase64: "always false on captures; encodingType carries the encoding",
  outputRef: PICKER,
  serviceIndex: PICKER,
  outputAutomationId: PICKER,
  automationUserOutputId: PICKER,
};

const OUTPUT: Record<string, Rule<MethodOutput>> = {
  key: (o) => o.code,
  code: (o) => o.code,
  outputCode: (o) => o.code,
  // the variable the output is exposed as (V2 step `fieldCode`, V1 method `fieldCode`).
  fieldCode: (o) => (o.raw as { fieldCode?: string }).fieldCode && (o.code || o.displayName),
  name: (o) => o.displayName,
  displayName: (o) => o.displayName,
  type: (o) => o.type,
  description: (o) => o.description,
  internalVarRef: (o) => o.internalVarRef,
  inputReference: (o) => o.inputReference,
  rawResponseContainer: (o) => o.rawResponseContainer,
  automationAPIOutputId: (o) => o.automationAPIOutputId,
  automationAPIOutputUuid: BOOK,
  referenceUuid: BOOK,
  automationId: BOOK,
  automationUuid: BOOK,
  uuid: BOOK,
  id: BOOK,
  hiddenAutomationAPIOutputIds: UI,
  properties: RAW,
  sensitive: "always false on captures; log-masking flag",
};

const FIELD: Record<string, Rule<MethodField>> = {
  key: (f) => f.code,
  fieldCode: (f) => f.code,
  name: (f) => f.displayName,
  label: (f) => f.displayName,
  type: (f) => f.type,
  required: (f) => f.required,
  description: (f) => f.description,
  defaultValue: (f) => f.defaultValue,
  testValue: (f) => f.testValue,
  secured: (f) => f.secured,
  hideInput: (f) => f.hideInput,
  orderIndex: (f) => f.orderIndex,
  reference: (f) => f.reference,
  inputVarRef: (f) => (f.raw as { inputVarRef?: string }).inputVarRef,
  encodingType: (f) => f.encodingType ?? "NONE",
  properties: (f) => f.properties ?? (f.raw as { properties?: unknown }).properties,
  uuid: BOOK,
  editable: UI,
  showOnSDUi: UI,
  arrayOfFile: "always false on captures",
  sensitive: "always false on captures; log-masking flag",
};

// ── Walker ──────────────────────────────────────────────────────────────────

function isDefault(v: unknown): boolean {
  if (v === null || v === undefined || v === "" || v === false || v === "null") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/** Dotted leaf paths; nested objects are walked, arrays are leaves. */
function leaves(o: unknown, prefix = "", out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) leaves(v, p, out);
    else out.push([p, v]);
  }
  return out;
}

function check<T>(
  where: string,
  wire: unknown,
  parsed: T,
  rules: Record<string, Rule<T>>,
  problems: Set<string>,
  opts: { shallow?: string[] } = {},
): void {
  for (const [path, value] of leaves(wire)) {
    const top = opts.shallow?.find((s) => path === s || path.startsWith(`${s}.`));
    const key = top ?? path;
    if (isDefault(value)) continue;
    const rule = rules[key];
    if (rule === undefined) {
      problems.add(`${where}: unknown wire key \`${key}\` — model it or add it to the ignore list with a reason`);
      continue;
    }
    if (typeof rule === "string") continue;
    const got = rule(parsed);
    if (got === undefined || got === null || got === "") problems.add(`${where}: \`${key}\` is set on the wire but missing from the parse`);
  }
}

function fixtures(dir: string, ext: string): string[] {
  return readdirSync(`${FIX}/${dir}`).filter((f) => f.endsWith(ext)).map((f) => `${FIX}/${dir}/${f}`);
}

function checkIo(where: string, wireSteps: unknown[], m: HydratedMethod, v: "v1" | "v2", problems: Set<string>): void {
  wireSteps.forEach((w, idx) => {
    const s = m.parsedSteps[idx]!;
    const ws = w as Record<string, unknown>;
    const wireInputs = (v === "v2" ? ws.inputs : ws.mappings) as unknown[] | undefined;
    const walkInputs = (wi: unknown[] | undefined, pi: StepInput[] | undefined, at: string) => {
      (wi ?? []).forEach((x, j) => {
        const p = pi?.[j];
        if (!p || !x || typeof x !== "object") return;
        check(`${at}.input[${j}]`, x, p, v === "v2" ? V2_INPUT : V1_INPUT, problems, { shallow: ["properties", "mappings", "outputRef"] });
        const nested = (v === "v2" ? (x as { properties?: unknown[] }).properties : (x as { mappings?: unknown[] }).mappings) ?? [];
        walkInputs(nested.filter((n) => n && typeof n === "object" && (v === "v1" || "key" in (n as object))), p.mappings, `${at}.input[${j}]`);
      });
    };
    walkInputs(wireInputs, s.inputs, `${where} step ${idx + 1}`);
    ((ws.outputs as unknown[]) ?? []).forEach((o, j) => check(`${where} step ${idx + 1}.output[${j}]`, o, s.outputs[j]!, OUTPUT, problems, { shallow: ["properties", "inputReference"] }));
  });
}

describe("parser keeps every behaviour-affecting wire field", () => {
  test("V2 fixtures (real-v2, draft-published)", async () => {
    const problems = new Set<string>();
    const files = [...fixtures("real-v2", ".v2.json"), ...fixtures("draft-published", ".v2.json")];
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      const raw = (await Bun.file(file).json()) as V2MethodResponse;
      const m = parseV2Method(raw, { env: "dev" });
      const where = file.split("/").slice(-2).join("/");
      check(where, raw, m, V2_METHOD, problems, { shallow: ["inputs", "outputs", "variables", "steps", "testSuite", "changelogs", "permissions.permissionSet", "permissions.allowedCategories", "metadata.categories"] });
      (raw.steps ?? []).forEach((s, i) => check(`${where} step ${i + 1}`, s, m.parsedSteps[i]!, V2_STEP, problems, { shallow: ["inputs", "outputs", "properties.entryCondition.expandedExpressions", "properties.exitCondition.conditionalExit.expandedExpressions"] }));
      checkIo(where, raw.steps ?? [], m, "v2", problems);
      (raw.inputs ?? []).forEach((f, j) => check(`${where} input[${j}]`, f, m.inputs[j]!, FIELD, problems, { shallow: ["properties"] }));
      (raw.variables ?? []).forEach((f, j) => check(`${where} variable[${j}]`, f, m.variables[j]!, FIELD, problems, { shallow: ["properties"] }));
      (raw.outputs ?? []).forEach((f, j) => check(`${where} output[${j}]`, f, m.outputs[j]!, OUTPUT, problems, { shallow: ["properties", "inputReference"] }));
    }
    expect([...problems]).toEqual([]);
  });

  test("V1 fixtures (real-v1)", async () => {
    const problems = new Set<string>();
    const files = fixtures("real-v1", ".v1.json");
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      const raw = (await Bun.file(file).json()) as V1RawMethodResponse;
      const m = parseV1Method(raw, { env: "dev" });
      const where = file.split("/").slice(-2).join("/");
      const def = (typeof raw.jsonDefinition === "string" ? JSON.parse(raw.jsonDefinition) : raw.jsonDefinition) as Record<string, unknown>;
      check(where, raw, m, V1_METHOD, problems, { shallow: ["jsonDefinition", "category", "changelog", "permissions", "permissionSet", "allowedCategoryNames", "allowedCategoryUuids", "securityTags"] });
      check(`${where} jsonDefinition`, def, m, V1_DEFINITION, problems, { shallow: ["inputs", "outputs", "variables", "services", "assertions", "securityFields", "allowedCategoryUuids", "executionStatus"] });
      const services = (def.services as unknown[]) ?? [];
      services.forEach((s, i) => check(`${where} step ${i + 1}`, s, m.parsedSteps[i]!, V1_STEP, problems, { shallow: ["mappings", "inputs", "outputs", "condition", "forceReturnCondition", "automationUiSelector", "executionStatus"] }));
      checkIo(where, services, m, "v1", problems);
      ((def.inputs as unknown[]) ?? []).forEach((f, j) => check(`${where} input[${j}]`, f, m.inputs[j]!, FIELD, problems, { shallow: ["properties"] }));
      ((def.variables as unknown[]) ?? []).forEach((f, j) => check(`${where} variable[${j}]`, f, m.variables[j]!, FIELD, problems, { shallow: ["properties"] }));
      ((def.outputs as unknown[]) ?? []).forEach((f, j) => check(`${where} output[${j}]`, f, m.outputs[j]!, OUTPUT, problems, { shallow: ["properties"] }));
    }
    expect([...problems]).toEqual([]);
  });

  test("an unlisted key fails the guard", () => {
    const problems = new Set<string>();
    check("synthetic", { retryPolicy: { attempts: 3 } }, {} as ParsedStep, V2_STEP, problems);
    expect([...problems]).toEqual(["synthetic: unknown wire key `retryPolicy.attempts` — model it or add it to the ignore list with a reason"]);
  });
});

describe("conditional exit is parsed on both wires", () => {
  test("V2 conditionalExit → forceReturn* (expression, code, message)", async () => {
    const raw = (await Bun.file(`${FIX}/real-v2/4540d7de58533f1b9545a9537368e546.v2.json`).json()) as V2MethodResponse;
    const m = parseV2Method(raw, { env: "dev" });
    const withExit = m.parsedSteps.filter((s) => s.forceReturnExpression);
    expect(withExit.length).toBeGreaterThan(0);
    for (const s of withExit) {
      const ce = (s.raw as any).properties.exitCondition.conditionalExit;
      expect(s.forceReturnExpression).toBe(ce.expression.trim());
      if (ce.code != null) expect(s.forceReturnStatusCode).toBe(ce.code);
    }
  });

  test("V1 forceReturnConditionExpression → forceReturn* with the shared code/message", async () => {
    let seen = 0;
    for (const file of fixtures("real-v1", ".v1.json")) {
      const m = parseV1Method((await Bun.file(file).json()) as V1RawMethodResponse, { env: "dev" });
      for (const s of m.parsedSteps) {
        const w = s.raw as any;
        if (typeof w.forceReturnConditionExpression !== "string" || !w.forceReturnConditionExpression.trim()) {
          expect(s.forceReturnExpression).toBeUndefined();
          continue;
        }
        seen++;
        expect(s.forceReturnExpression).toBe(w.forceReturnConditionExpression.trim());
        if (w.forceExitStatusCode != null) expect(s.forceReturnStatusCode).toBe(w.forceExitStatusCode);
        if (w.forceExitErrorMessage) expect(s.forceReturnMessage).toBe(w.forceExitErrorMessage);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
