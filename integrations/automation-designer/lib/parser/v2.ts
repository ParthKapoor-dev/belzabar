// V2 method parser. Reads flat V2 JSON (no stringification) and produces the
// same HydratedMethod shape the V1 parser emits.

import type { V2MethodResponse, V2Field, V2Output } from "../types/v2-wire";
import type {
  HydratedMethod,
  MethodField,
  MethodOutput,
  MethodState,
  ParsedStep,
} from "../types/common";
import { parseV2Step } from "./steps/v2";

export function parseV2Method(raw: V2MethodResponse): HydratedMethod {
  const warnings: string[] = [];
  const warn = (msg: string) => warnings.push(msg);

  const metadata = raw.metadata;
  if (!metadata || typeof metadata.uuid !== "string") {
    warn("V2 response is missing metadata.uuid — parse may be degraded");
  }

  const steps: ParsedStep[] = (raw.steps ?? []).map((s, idx) => parseV2Step(s, idx, warn));

  const inputs: MethodField[] = (raw.inputs ?? []).map(mapField);
  const variables: MethodField[] = (raw.variables ?? []).map(mapField);
  const outputs: MethodOutput[] = (raw.outputs ?? []).map(mapOutput);

  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : "Unknown";
  const summary = raw.summary || raw.description || "(No description)";
  const version = parseVersion(metadata?.version?.name);

  return {
    sourceVersion: "v2",
    uuid: metadata?.uuid ?? "",
    referenceId: normaliseReferenceId(metadata?.referenceId),
    state: (metadata?.state as MethodState) ?? "DRAFT",
    version,

    name,
    summary,
    description: raw.description,
    buttonLabel: raw.buttonLabel,
    internalMethod: raw.internalMethod,
    category: metadata?.service
      ? { id: metadata.service.id, uuid: metadata.service.uuid, name: metadata.service.name }
      : null,

    inputs,
    variables,
    outputs,
    parsedSteps: steps,
    assertions: Array.isArray(raw.assertions) ? raw.assertions : [],
    securityFields: Array.isArray(raw.securityFields) ? raw.securityFields : [],

    fetchedAt: Date.now(),
    createdOn: typeof metadata?.createdOn === "number" ? metadata.createdOn : undefined,
    updatedOn: typeof metadata?.lastUpdatedOn === "number" ? metadata.lastUpdatedOn : undefined,
    updatedBy: metadata?.lastUpdatedBy,

    raw,
    parseWarnings: warnings,
  };
}

function mapField(f: V2Field): MethodField {
  return {
    code: f.key,
    displayName: f.name,
    type: f.type,
    required: !!f.required,
    description: f.description,
    defaultValue: f.defaultValue,
    secured: f.secured,
    orderIndex: undefined,
    reference: f.reference,
    encodingType: f.encodingType,
    properties: Array.isArray(f.properties) ? f.properties : undefined,
    raw: f,
  };
}

function mapOutput(o: V2Output): MethodOutput {
  return {
    code: o.key,
    displayName: o.name,
    type: o.type,
    description: o.description,
    inputReference: o.inputReference,
    rawResponseContainer: o.rawResponseContainer,
    raw: o,
  };
}

function normaliseReferenceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseVersion(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}
