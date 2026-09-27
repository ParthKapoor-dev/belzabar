// `ad create` — spec → V2 create body (POST /chain/v2 without a uuid).
//
// The spec is a V2 method body or a subset of it (name, summary, description,
// inputs, outputs, variables, steps). Server-owned fields (uuid, ids,
// metadata state/version/internal, changelogs, permissions…) are dropped and
// reported; the category comes from --category, never from the spec. Defaults
// mirror what the AD UI writes (exitOnFailure true, JavaScript on CODE_LAMBDA
// for custom code, combineInput true when a value holds SpEL). Stage 7 adds a
// compact spec on top of this.
//
// Live sems-dev (2026-09-28): a minimal body is accepted and the server mints
// step ids and input/output uuids; a duplicate name is refused with
// `error.automation_chain.duplicate_method_name`.

import { CliError } from "@belzabar/core";
import type { Category } from "../categories";

/** WSR-6: core/shared categories are never written from belz. */
const PROTECTED_CATEGORY = /^(helpers|database|cache|email|expertly)(\.|$)/i;
const PROTECTED_NAMES = new Set(["web socket", "websocket"]);

export function assertCreatableCategory(c: Category): void {
  const name = c.name.trim();
  const reason =
    c.type === "SYSTEM_GENERATED"
      ? "it is a system service"
      : PROTECTED_CATEGORY.test(name) || PROTECTED_NAMES.has(name.toLowerCase())
        ? "it is a core/shared platform category (WSR-6)"
        : null;
  if (reason) {
    throw new CliError(`Refusing to create a method in '${name}': ${reason}. Use a project category.`, {
      code: "AD_CATEGORY_PROTECTED",
      details: { category: c },
    });
  }
}

const SPEC_KEYS = new Set(["name", "summary", "description", "inputs", "outputs", "variables", "steps", "securityFields", "assertions", "metadata"]);
/** Present on fetched V2 bodies; server-owned or ignored on create. Dropped with a notice. */
const DROPPED_KEYS = new Set([
  "uuid",
  "id",
  "automationApiId",
  "changelogs",
  "permissions",
  "automationState",
  "methodDeprecated",
  "migration",
  "interfaceMigration",
  "testSuite",
  "deprecatedAt",
  "deprecatedBy",
  "buttonLabel",
  "internalMethod",
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Defaults under `given`: objects merge recursively, `given` wins, arrays are taken as given. */
function withDefaults(defaults: Obj, given: unknown): Obj {
  if (!isObj(given)) return structuredClone(defaults);
  const out: Obj = structuredClone(defaults);
  for (const [k, v] of Object.entries(given)) {
    out[k] = isObj(v) && isObj(out[k]) ? withDefaults(out[k] as Obj, v) : structuredClone(v);
  }
  return out;
}

// Method-level inputs/outputs/variables get fresh uuids from the server: a
// uuid copied from another method's body is dropped, never re-used.
function field(given: unknown): Obj {
  const key = isObj(given) && typeof given.key === "string" ? given.key : undefined;
  const out = withDefaults({ key, name: key, type: "STRING", required: false, properties: [], encodingType: "NONE" }, given);
  delete out.uuid;
  return out;
}

function methodOutput(given: unknown): Obj {
  const key = isObj(given) && typeof given.key === "string" ? given.key : undefined;
  const out = withDefaults({ key, fieldCode: key, name: key, type: "STRING" }, given);
  delete out.uuid;
  return out;
}

function stepInput(given: unknown): Obj {
  const g = isObj(given) ? given : {};
  const spel = typeof g.value === "string" && g.value.includes("#{");
  const out = withDefaults({ combineInput: spel, properties: [], encodingType: "NONE" }, g);
  if (Array.isArray(out.properties)) out.properties = out.properties.map(stepInput);
  return out;
}

function step(given: unknown, i: number): Obj {
  if (!isObj(given)) {
    throw new CliError(`spec.steps[${i}] must be an object.`, { code: "AD_SPEC_INVALID", details: { path: `steps[${i}]` } });
  }
  const props = isObj(given.properties) ? given.properties : {};
  const cc = isObj(props.customCode) ? props.customCode : null;
  const type = typeof props.type === "string" ? props.type : cc && typeof cc.inlineCode === "string" ? "CUSTOM_CODE" : "EXISTING_SERVICE";
  const isCc = type === "CUSTOM_CODE";
  const defaults = {
    coreMethod: false,
    inputs: [] as unknown[],
    outputs: [] as unknown[],
    properties: {
      type,
      runAsync: false,
      exitCondition: {
        exitOnFailure: { value: true, code: null, message: "" },
        conditionalExit: { code: null, message: "", expression: null, expandedExpressions: null },
      },
      entryCondition: { expression: null, expandedExpressions: null },
      customCode: isCc
        ? { inlineCode: null, language: "JAVASCRIPT", executor: "CODE_LAMBDA", fileName: null, file: null }
        : { inlineCode: null, language: null, executor: null, fileName: null, file: null },
    },
    interfaceMigration: false,
  };
  const out = withDefaults(defaults, given);
  delete out.id; // server mints step ids
  out.inputs = Array.isArray(out.inputs) ? out.inputs.map(stepInput) : [];
  out.outputs = Array.isArray(out.outputs)
    ? out.outputs.map((o) => {
        const key = isObj(o) && typeof o.key === "string" ? o.key : undefined;
        const fieldCode = isObj(o) && typeof o.fieldCode === "string" ? o.fieldCode : key;
        return withDefaults(isCc ? { key, fieldCode, name: fieldCode, type: "TEXT" } : { key, fieldCode, name: fieldCode }, o);
      })
    : [];
  return out;
}

export interface CreateBody {
  body: Obj;
  /** Spec keys dropped because the server owns them. */
  dropped: string[];
}

export function buildCreateBody(spec: unknown, category: Category & { chainCategoryId: number }): CreateBody {
  if (!isObj(spec)) throw new CliError("Spec must be a JSON object (a V2 method body or a subset).", { code: "AD_SPEC_INVALID" });
  const unknown = Object.keys(spec).filter((k) => !SPEC_KEYS.has(k) && !DROPPED_KEYS.has(k));
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown spec key(s): ${unknown.join(", ")}. Supported: ${[...SPEC_KEYS].join(", ")} (server-owned keys are dropped).`,
      { code: "AD_SPEC_UNKNOWN_KEY", details: { unknown } },
    );
  }
  if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
    throw new CliError("spec.name is required (the method name).", { code: "AD_SPEC_INVALID", details: { path: "name" } });
  }
  for (const k of ["inputs", "outputs", "variables", "steps"] as const) {
    if (k in spec && !Array.isArray(spec[k])) {
      throw new CliError(`spec.${k} must be an array.`, { code: "AD_SPEC_INVALID", details: { path: k } });
    }
  }
  const dropped = Object.keys(spec).filter((k) => DROPPED_KEYS.has(k));
  const meta = isObj(spec.metadata) ? spec.metadata : {};
  for (const k of Object.keys(meta)) if (k !== "executionTimeLimit") dropped.push(`metadata.${k}`);

  const body: Obj = {
    name: spec.name.trim(),
    ...(typeof spec.summary === "string" ? { summary: spec.summary } : {}),
    ...(typeof spec.description === "string" ? { description: spec.description } : {}),
    metadata: {
      service: { id: category.chainCategoryId, uuid: category.chainCategoryUuid, name: category.name },
      ...(isObj(meta.executionTimeLimit) ? { executionTimeLimit: meta.executionTimeLimit } : {}),
    },
    inputs: ((spec.inputs as unknown[]) ?? []).map(field),
    outputs: ((spec.outputs as unknown[]) ?? []).map(methodOutput),
    variables: ((spec.variables as unknown[]) ?? []).map(field),
    steps: ((spec.steps as unknown[]) ?? []).map(step),
    ...(Array.isArray(spec.securityFields) ? { securityFields: spec.securityFields } : {}),
    ...(Array.isArray(spec.assertions) ? { assertions: spec.assertions } : {}),
  };
  return { body, dropped };
}
