// V1 method parser. Takes a RawMethodResponse (the literal V1 API body),
// JSON.parses the `jsonDefinition` string, and produces a HydratedMethod.

import type { V1RawMethodResponse, V1InnerDefinition, V1InputField, V1OutputField } from "../types/v1-wire";
import type {
  HydratedMethod,
  MethodField,
  MethodOutput,
  ParsedStep,
} from "../types/common";
import { parseV1Step } from "./steps/v1";

export function parseV1Method(raw: V1RawMethodResponse): HydratedMethod {
  const warnings: string[] = [];
  const warn = (msg: string) => warnings.push(msg);

  let inner: V1InnerDefinition = {};
  if (typeof raw.jsonDefinition === "string" && raw.jsonDefinition.length > 0) {
    try {
      inner = JSON.parse(raw.jsonDefinition) as V1InnerDefinition;
    } catch (err) {
      warn(`Failed to parse jsonDefinition string: ${String(err)}`);
    }
  } else if (raw.jsonDefinition != null) {
    warn("jsonDefinition was not a string; using empty inner definition");
  }

  const name = (typeof inner.name === "string" && inner.name.length > 0) ? inner.name : raw.aliasName || "Unknown";
  const summary = inner.summary || inner.description || inner.methodDescription || "(No description)";

  const steps: ParsedStep[] = (inner.services ?? []).map((svc, idx) => parseV1Step(svc, svc.orderIndex ?? idx, warn));

  const inputs: MethodField[] = (inner.inputs ?? []).map(mapField).filter(Boolean) as MethodField[];
  const variables: MethodField[] = (inner.variables ?? []).map(mapField).filter(Boolean) as MethodField[];
  const outputs: MethodOutput[] = (inner.outputs ?? []).map(mapOutput);

  return {
    sourceVersion: "v1",
    uuid: raw.uuid,
    referenceId: normaliseReferenceId(raw.referenceId),
    state: raw.automationState ?? "DRAFT",
    aliasName: raw.aliasName,
    version: typeof raw.version === "number" ? raw.version : 0,

    name,
    summary,
    description: inner.description ?? inner.methodDescription,
    buttonLabel: inner.buttonLabel,
    internalMethod: inner.internalMethod,
    category: raw.category
      ? { id: raw.category.id, name: raw.category.name }
      : null,

    inputs,
    variables,
    outputs,
    parsedSteps: steps,
    assertions: Array.isArray(inner.assertions) ? inner.assertions : [],
    securityFields: Array.isArray(inner.securityFields) ? inner.securityFields : [],

    fetchedAt: Date.now(),
    createdOn: typeof raw.createdOn === "number" ? raw.createdOn : undefined,
    updatedOn: typeof raw.lastUpdatedOn === "number" ? raw.lastUpdatedOn : undefined,
    updatedBy: raw.lastUpdatedBy,

    raw,
    parseWarnings: warnings,
  };
}

function mapField(f: V1InputField): MethodField | null {
  if (!f || typeof f.fieldCode !== "string") return null;
  return {
    code: f.fieldCode,
    displayName: f.label,
    type: typeof f.type === "string" ? f.type : "STRING",
    required: !!f.required,
    description: f.description,
    defaultValue: f.defaultValue,
    testValue: f.testValue,
    secured: f.secured,
    hideInput: f.hideInput,
    orderIndex: f.orderIndex,
    properties: Array.isArray(f.properties) ? f.properties : undefined,
    raw: f,
  };
}

function mapOutput(o: V1OutputField): MethodOutput {
  return {
    code: o.code ?? o.outputCode ?? o.fieldCode ?? "",
    displayName: o.displayName,
    type: o.type,
    automationAPIOutputId: o.automationAPIOutputId,
    internalVarRef: o.internalVarRef,
    rawResponseContainer: o.rawResponseContainer,
    raw: o,
  };
}

function normaliseReferenceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
