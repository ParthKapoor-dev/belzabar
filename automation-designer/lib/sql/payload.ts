import { CliError } from "@belzabar/core";
import type { RawMethodResponse } from "../types";
import type { BuildSqlPayloadOptions, SqlOperationInput } from "./types";

function flattenInputs(inputs: SqlOperationInput[] | undefined): SqlOperationInput[] {
  if (!inputs) return [];

  const flattened: SqlOperationInput[] = [];
  const stack = [...inputs];

  while (stack.length > 0) {
    const next = stack.shift() as SqlOperationInput;
    flattened.push(next);
    if (Array.isArray(next.automationUserInputs) && next.automationUserInputs.length > 0) {
      stack.unshift(...next.automationUserInputs);
    }
  }

  return flattened;
}

function findSqlQueryInputId(inputs: SqlOperationInput[] | undefined): number | null {
  const flattened = flattenInputs(inputs);

  const byLabel = flattened.find((input) => (input.label || "").trim().toLowerCase() === "sqlquery");
  if (byLabel) return byLabel.id;

  const byProduces = flattened.find((input) => input.produces === "queryString");
  if (byProduces) return byProduces.id;

  const byOperationId = flattened.find((input) => (input.operationId || "").endsWith(".SQLQuery"));
  if (byOperationId) return byOperationId.id;

  return null;
}

function findRootInputId(inputs: SqlOperationInput[] | undefined): number | null {
  const flattened = flattenInputs(inputs);
  const bodyInput = flattened.find((input) => input.produces === "body");
  return bodyInput?.id ?? null;
}

function ensureArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function findMappingByInputId(mappings: any[], inputId: number): any | null {
  for (const mapping of mappings) {
    if (Number(mapping?.automationUserInputId) === inputId) {
      return mapping;
    }

    const children = ensureArray(mapping?.mappings);
    const found = findMappingByInputId(children, inputId);
    if (found) {
      return found;
    }
  }

  return null;
}

function findFirstSqlLeafMapping(mappings: any[]): any | null {
  for (const mapping of mappings) {
    const children = ensureArray(mapping?.mappings);
    const foundInChild = findFirstSqlLeafMapping(children);
    if (foundInChild) return foundInChild;

    if (mapping?.encodingType === "BASE_64") {
      return mapping;
    }

    if (typeof mapping?.value === "string" && (mapping?.uiRepresentation === "CUSTOM" || mapping?.combineInputs)) {
      return mapping;
    }
  }

  return null;
}

function upsertSqlQueryMapping(service: any, rootInputId: number | null, queryInputId: number | null, query: string): void {
  const encoded = Buffer.from(query, "utf8").toString("base64");

  if (!Array.isArray(service.mappings)) {
    service.mappings = [];
  }

  if (queryInputId !== null) {
    const existingQuery = findMappingByInputId(service.mappings, queryInputId);
    if (existingQuery) {
      existingQuery.value = encoded;
      existingQuery.encodingType = "BASE_64";
      existingQuery.uiRepresentation = existingQuery.uiRepresentation || "CUSTOM";
      existingQuery.combineInputs = true;
      return;
    }

    if (rootInputId !== null) {
      let rootMapping = findMappingByInputId(service.mappings, rootInputId);
      if (!rootMapping) {
        rootMapping = {
          automationUserInputId: rootInputId,
          uiRepresentation: "OBJECT",
          mappings: [],
        };
        service.mappings.push(rootMapping);
      }

      if (!Array.isArray(rootMapping.mappings)) {
        rootMapping.mappings = [];
      }

      rootMapping.mappings.push({
        automationUserInputId: queryInputId,
        uiRepresentation: "CUSTOM",
        value: encoded,
        encodingType: "BASE_64",
        combineInputs: true,
        mappings: [],
      });
      return;
    }
  }

  const firstLeaf = findFirstSqlLeafMapping(service.mappings);
  if (firstLeaf) {
    firstLeaf.value = encoded;
    firstLeaf.encodingType = "BASE_64";
    firstLeaf.uiRepresentation = firstLeaf.uiRepresentation || "CUSTOM";
    firstLeaf.combineInputs = true;
    return;
  }

  throw new CliError("Unable to locate SQL query mapping in select operation payload template.", {
    code: "SQL_PAYLOAD_BUILD_FAILED",
    details: {
      reason: "SQL query input mapping not found",
    },
  });
}

function resolveTargetService(innerDefinition: any, operationId: number): any {
  const services = ensureArray(innerDefinition?.services);
  if (services.length === 0) {
    throw new CliError("SQL method template has no services.", {
      code: "SQL_PAYLOAD_BUILD_FAILED",
      details: {
        reason: "Template contains no services",
      },
    });
  }

  return services.find((service) => Number(service?.automationApiId) === operationId) || services[0];
}

function resolveResponseOutputId(operation: any): number | null {
  const outputs = Array.isArray(operation?.automationAPIOutputs) ? operation.automationAPIOutputs : [];
  if (outputs.length === 0) return null;

  const jsonOutput = outputs.find(
    (output: any) => (output?.displayName || "").toLowerCase() === "responsejson"
  );
  if (jsonOutput?.id) return Number(jsonOutput.id);

  const visible = outputs.find((output: any) => output?.showOnUi !== false);
  if (visible?.id) return Number(visible.id);

  return Number(outputs[0]?.id) || null;
}

function buildFallbackInnerDefinition(operation: any, dbAuthId: number, query: string): any {
  const queryInputId = findSqlQueryInputId(operation?.automationUserInputs);
  if (queryInputId === null) {
    throw new CliError("Unable to determine SQL query input id from operation metadata.", {
      code: "SQL_PAYLOAD_BUILD_FAILED",
      details: {
        reason: "SQLQuery input is missing in operation metadata",
      },
    });
  }

  const rootInputId = findRootInputId(operation?.automationUserInputs);
  const encoded = Buffer.from(query, "utf8").toString("base64");
  const queryLeaf = {
    automationUserInputId: queryInputId,
    uiRepresentation: "CUSTOM",
    value: encoded,
    encodingType: "BASE_64",
    combineInputs: true,
    mappings: [],
  };

  const mappings =
    rootInputId !== null
      ? [
          {
            automationUserInputId: rootInputId,
            uiRepresentation: "OBJECT",
            mappings: [queryLeaf],
          },
        ]
      : [queryLeaf];

  const responseOutputId = resolveResponseOutputId(operation);
  const outputs =
    responseOutputId !== null
      ? [
          {
            automationId: null,
            automationAPIOutputId: responseOutputId,
            code: "resp",
            displayName: "resp",
          },
        ]
      : [];

  return {
    name: "",
    methodDescription: "",
    summary: "",
    buttonLabel: "",
    assertions: [],
    inputs: [],
    variables: [],
    services: [
      {
        forceExitFromFailure: true,
        forceExitStatusCode: null,
        forceExitErrorMessage: "",
        repeatStepExecution: false,
        runAsync: false,
        automationAuthId: dbAuthId,
        automationId: null,
        testAccountId: dbAuthId,
        activeTab: {
          id: "existingService",
          active: true,
          text: "EXISTING SERVICE",
        },
        orderIndex: 1,
        automationUiSelector: {},
        mappings,
        outputs,
        automationApiId: operation.id,
      },
    ],
    outputs: [],
    securityFields: [],
    testAccountId: null,
  };
}

export function buildSqlReadPayload(options: BuildSqlPayloadOptions): RawMethodResponse {
  const { template, operation, dbAuthId, query } = options;

  const findNestedJsonDefinition = (value: unknown, depth = 0): unknown => {
    if (!value || depth > 3 || typeof value !== "object") {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    if (record.jsonDefinition !== undefined) {
      return record.jsonDefinition;
    }

    for (const nestedValue of Object.values(record)) {
      const found = findNestedJsonDefinition(nestedValue, depth + 1);
      if (found !== undefined) return found;
    }

    return undefined;
  };

  const definitionSource =
    (template as any).jsonDefinition ??
    (template as any).definition ??
    (template as any).jsondefinition ??
    findNestedJsonDefinition(template);

  const parseJsonDefinition = (value: unknown): any => {
    if (value && typeof value === "object") {
      return value;
    }

    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }

    try {
      const firstPass = JSON.parse(value);
      if (typeof firstPass === "string") {
        return JSON.parse(firstPass);
      }
      return firstPass;
    } catch {
      return null;
    }
  };

  let innerDefinition: any = parseJsonDefinition(definitionSource);
  if (!innerDefinition) {
    innerDefinition = buildFallbackInnerDefinition(operation, dbAuthId, query);
  }

  const targetService = resolveTargetService(innerDefinition, operation.id);

  targetService.automationAuthId = dbAuthId;
  targetService.testAccountId = dbAuthId;

  const queryInputId = findSqlQueryInputId(operation.automationUserInputs);
  const rootInputId = findRootInputId(operation.automationUserInputs);
  upsertSqlQueryMapping(targetService, rootInputId, queryInputId, query);

  return {
    ...template,
    category: (template as any).category ?? { id: 37, name: "NSM.Helpers" },
    version: (template as any).version ?? 1,
    jsonDefinition: JSON.stringify(innerDefinition),
  };
}
