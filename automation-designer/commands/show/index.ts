import { CliError, ok, type CommandModule } from "@belzabar/core";
import { Config } from "../../lib/config";
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import { apiFetch } from "../../lib/api";
import { parseMethodResponse } from "../../lib/parser";
import type { RawMethodResponse, HydratedMethod } from "../../lib/types";

interface ShowMethodArgs {
  uuid: string;
  flags: {
    inputs: boolean;
    services: boolean;
    full: boolean;
    force: boolean;
    raw: boolean;
    serviceDetail: number;
  };
}

interface ServiceInputRow {
  label: string;
  required: boolean;
  value: unknown;
}

interface ServiceOutputRow {
  label: string;
  value: unknown;
}

interface ServiceDetailData {
  index: number;
  type: string;
  automationId: string;
  description?: string;
  definition: null | {
    category: string;
    methodName: string;
    automationId: number;
    publishedId?: string;
    url?: string;
    accountNickname?: string;
  };
  config: Array<{ key: string; value: string }>;
  inputs: ServiceInputRow[];
  outputs: ServiceOutputRow[];
  rawMappings?: unknown;
}

interface FullServiceRow {
  step: number;
  automationId: string;
  description: string;
  type: string;
  logicType: "Custom Code" | "SQL Query" | "Standard Service";
  logic: string | null;
  outputs: string[];
}

interface ShowMethodData {
  request: {
    uuid: string;
    flags: ShowMethodArgs["flags"];
  };
  source: "cache" | "fresh";
  summary: {
    methodName: string;
    alias: string;
    category: string;
    state: string;
    version: number;
    uuid: string;
    referenceId: string;
    updated: string;
    summary: string;
    inputCount: number;
    serviceCount: number;
  };
  inputs?: Array<{
    fieldCode: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  services?: Array<{
    orderIndex: number;
    automationId: string;
    type: string;
    description: string;
  }>;
  serviceDetail?: ServiceDetailData | null;
  fullServices?: FullServiceRow[];
  raw?: {
    method: HydratedMethod;
    serviceMappings?: unknown;
  };
}

function formatDate(ts: number): string {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString();
}

async function fetchAndCache(uuid: string): Promise<HydratedMethod> {
  const path = `/rest/api/automation/chain/${uuid}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });

  if (response.status === 404) {
    throw new CliError("404 Chain Not Found", { code: "METHOD_NOT_FOUND" });
  }
  if (!response.ok) {
    throw new CliError(`Request failed ${response.status} ${response.statusText}`, {
      code: "FETCH_FAILED",
    });
  }

  const rawData = (await response.json()) as RawMethodResponse;
  const hydrated = parseMethodResponse(rawData);
  await CacheManager.save(uuid, hydrated);
  return hydrated;
}

function truncateDeep(obj: any, maxLength = 100): any {
  if (typeof obj === "string") {
    if (obj.length > maxLength) return `${obj.substring(0, maxLength)}... (truncated)`;
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(item => truncateDeep(item, maxLength));
  if (obj && typeof obj === "object") {
    const next: any = {};
    for (const key in obj) next[key] = truncateDeep(obj[key], maxLength);
    return next;
  }
  return obj;
}

function decodeBase64(value: string): string {
  try {
    return Buffer.from(value, "base64").toString("utf-8");
  } catch {
    return `${value} (DECODE FAILED)`;
  }
}

function buildFullServiceRows(method: HydratedMethod): FullServiceRow[] {
  return method.services.map((svc) => {
    let logicType: FullServiceRow["logicType"] = "Standard Service";
    let logic: string | null = null;

    if ((svc as any).code && typeof (svc as any).code === "string") {
      logicType = "Custom Code";
      logic = decodeBase64((svc as any).code);
    } else if (svc.mappings && Array.isArray(svc.mappings)) {
      const sqlMapping = svc.mappings.find((m: any) => m?.mappings?.some((sub: any) => sub?.encodingType === "BASE_64"));
      const encoded = sqlMapping?.mappings?.find((sub: any) => sub?.encodingType === "BASE_64")?.value;
      if (typeof encoded === "string") {
        logicType = "SQL Query";
        logic = decodeBase64(encoded);
      }
    }

    return {
      step: svc.orderIndex,
      automationId: svc.automationId,
      description: svc.description || "Service",
      type: svc.type,
      logicType,
      logic,
      outputs: Array.isArray(svc.outputs) ? svc.outputs.map((out: any) => out.code || out.displayName || "") : [],
    };
  });
}

async function buildServiceDetailData(method: HydratedMethod, index: number, includeRaw: boolean): Promise<ServiceDetailData> {
  const service = method.services.find(svc => svc.orderIndex === index);
  if (!service) {
    throw new CliError(`Service with index ${index} not found.`, {
      code: "SERVICE_NOT_FOUND",
    });
  }

  const definition = await ServiceHydrator.getDefinition(service.automationId);
  const config = [
    { key: "Async Execution", value: service.runAsync ? "Yes" : "No" },
    { key: "Stream Capable", value: service.streamCapable ? "Yes" : "No" },
    {
      key: "Loop",
      value: service.repeatStepExecution
        ? `Yes (${service.loopConfiguration?.executeParallel ? "Parallel" : "Sequential"})`
        : "No",
    },
    { key: "Abort on Failure", value: service.forceExitFromFailure ? "Yes" : "No" },
  ];
  if (service.conditionExpression) {
    config.push({ key: "Condition", value: service.conditionExpression });
  }

  const inputs: ServiceInputRow[] = [];
  const outputs: ServiceOutputRow[] = [];
  const rawMappings = includeRaw ? service.mappings : (service.mappings ? truncateDeep(service.mappings) : undefined);

  if (!definition) {
    return {
      index: service.orderIndex,
      type: service.type,
      automationId: service.automationId,
      description: service.description,
      definition: null,
      config,
      inputs,
      outputs,
      rawMappings,
    };
  }

  const definitionMeta = {
    category: definition.automationAPI.automationSystem.label,
    methodName: definition.automationAPI.label,
    automationId: definition.id,
    publishedId: definition.automationAPI.serviceChainUID,
    url: definition.automationAPI.serviceChainUID
      ? `${Config.cleanBaseUrl}/automation-designer/${encodeURIComponent(
          definition.automationAPI.automationSystem.label
        )}/${definition.automationAPI.serviceChainUID}`
      : undefined,
    accountNickname: definition.automationAuth?.nickname,
  };

  const instanceValues = new Map<string, any>();
  const mapInstanceValues = (items: any[]) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item.automationUserInputId) instanceValues.set(String(item.automationUserInputId), item);
      if (item.mappings) mapInstanceValues(item.mappings);
    }
  };

  if (service.mappings) {
    const items = Array.isArray(service.mappings) ? service.mappings : Object.values(service.mappings);
    mapInstanceValues(items);
  }

  if (definition.automationAuth?.nickname) {
    inputs.push({
      label: "Account",
      required: true,
      value: definition.automationAuth.nickname,
    });
  }

  const rootInputs = ServiceHydrator.flattenInputs(definition).filter(input => input.depth === 0 && !input.hidden);
  for (const inputDef of rootInputs) {
    if (!inputDef.label) continue;
    const instanceItem = instanceValues.get(String(inputDef.id));
    let value: unknown = null;
    if (instanceItem && instanceItem.value !== undefined) {
      value = instanceItem.value;
      const isBase64 = instanceItem.encodingType === "BASE_64" || inputDef.encoding === "BASE_64";
      if (isBase64 && typeof value === "string") {
        value = decodeBase64(value);
      }
    }
    inputs.push({
      label: inputDef.label,
      required: !!inputDef.required,
      value,
    });
  }

  if (service.outputs && definition.automationAPI.automationAPIOutputs) {
    const outputsArr = Array.isArray(service.outputs) ? service.outputs : Object.values(service.outputs);
    const visibleOutputs = definition.automationAPI.automationAPIOutputs.filter(o => o.showOnUi !== false);
    for (const outDef of visibleOutputs) {
      const instanceOut = outputsArr.find((o: any) => String(o.automationAPIOutputId) === String(outDef.id));
      outputs.push({
        label: outDef.displayName,
        value: instanceOut ? instanceOut.code : null,
      });
    }
  } else if (service.outputs) {
    outputs.push({ label: "Raw Outputs", value: service.outputs });
  }

  return {
    index: service.orderIndex,
    type: service.type,
    automationId: service.automationId,
    description: service.description,
    definition: definitionMeta,
    config,
    inputs,
    outputs,
    rawMappings: includeRaw ? rawMappings : undefined,
  };
}

const command: CommandModule<ShowMethodArgs, ShowMethodData> = {
  schema: "ad.show",
  parseArgs(args) {
    const uuid = args[0];
    if (!uuid || uuid.startsWith("-")) {
      throw new CliError("Missing UUID argument.", { code: "MISSING_UUID" });
    }

    const flags = {
      inputs: args.includes("--inputs"),
      services: args.includes("--services"),
      full: args.includes("--full"),
      force: args.includes("--force"),
      raw: args.includes("--raw"),
      serviceDetail: -1,
    };
    const detailIndex = args.indexOf("--service-detail");
    if (detailIndex !== -1 && args[detailIndex + 1]) {
      flags.serviceDetail = parseInt(args[detailIndex + 1], 10);
      if (Number.isNaN(flags.serviceDetail)) {
        throw new CliError("--service-detail requires a valid numeric index.", {
          code: "INVALID_SERVICE_DETAIL",
        });
      }
    }

    return { uuid, flags };
  },
  async execute({ uuid, flags }, context) {
    let method = await CacheManager.load(uuid);
    let source: "cache" | "fresh" = "cache";

    if (!method || flags.force) {
      source = "fresh";
      method = await fetchAndCache(uuid);
    }

    if (source === "cache") {
      context.warn("Using cached method definition. Use --force for refresh.");
    }

    const includeInputs = flags.inputs || flags.full;
    const includeServices = flags.services || flags.full;

    const serviceDetail = flags.serviceDetail >= 0
      ? await buildServiceDetailData(method, flags.serviceDetail, flags.raw)
      : null;

    const data: ShowMethodData = {
      request: {
        uuid,
        flags,
      },
      source,
      summary: {
        methodName: method.methodName,
        alias: method.aliasName,
        category: method.category,
        state: method.state,
        version: method.version,
        uuid: method.uuid,
        referenceId: method.referenceId,
        updated: `${formatDate(method.updatedOn)} by ${method.updatedBy || "unknown"}`,
        summary: method.summary || "",
        inputCount: method.inputs.length,
        serviceCount: method.services.length,
      },
      serviceDetail,
    };

    if (includeInputs) {
      data.inputs = method.inputs.map(input => ({
        fieldCode: input.fieldCode,
        type: input.type,
        required: !!input.required,
        description: input.description || "",
      }));
    }

    if (includeServices) {
      data.services = method.services.map(service => ({
        orderIndex: service.orderIndex,
        automationId: service.automationId,
        type: service.type,
        description: service.description || "",
      }));
    }

    if (flags.full) {
      data.fullServices = buildFullServiceRows(method);
    }

    if (flags.raw) {
      data.raw = {
        method,
        serviceMappings: serviceDetail?.rawMappings,
      };
    }

    return ok(data);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ShowMethodData;

    ui.table(
      ["Property", "Value"],
      [
        ["Method Name", data.summary.methodName],
        ["Alias", data.summary.alias],
        ["Category", data.summary.category],
        ["State", data.summary.state],
        ["Version", data.summary.version],
        ["UUID", data.summary.uuid],
        ["Ref ID", data.summary.referenceId],
        ["Updated", data.summary.updated],
        ["Summary", data.summary.summary],
        ["Inputs", data.summary.inputCount],
        ["Services", data.summary.serviceCount],
        ["Source", data.source],
      ]
    );

    if (data.inputs) {
      ui.section("Args (Inputs)");
      if (data.inputs.length === 0) ui.text("No inputs defined.");
      else ui.table(
        ["Field Code", "Type", "Required", "Description"],
        data.inputs.map(input => [input.fieldCode, input.type, input.required ? "Yes" : "No", input.description])
      );
    }

    if (data.services) {
      ui.section("Service Chain");
      if (data.services.length === 0) ui.text("No services defined.");
      else ui.table(
        ["#", "ID", "Type", "Description"],
        data.services.map(service => [service.orderIndex, service.automationId, service.type, service.description])
      );
    }

    if (data.fullServices) {
      ui.section(`Expanded Services (${data.fullServices.length})`);
      data.fullServices.forEach((service) => {
        ui.text(`[Step ${service.step}] ${service.description} (ID: ${service.automationId})`);
        ui.text(`Type: ${service.type} | Logic: ${service.logicType}`);
        if (service.logic) {
          ui.text(service.logic);
        }
        if (service.outputs.length > 0) {
          ui.text(`Outputs: ${service.outputs.join(", ")}`);
        }
        ui.text("");
      });
    }

    if (data.serviceDetail) {
      const detail = data.serviceDetail;
      ui.section(`Service Detail [Index ${detail.index}]`);
      if (detail.definition) {
        ui.table(
          ["Property", "Value"],
          [
            ["Service Category", detail.definition.category],
            ["Method Name", detail.definition.methodName],
            ["Automation ID", detail.definition.automationId],
            ["Published ID", detail.definition.publishedId || ""],
            ["URL", detail.definition.url || ""],
            ["Account", detail.definition.accountNickname || ""],
          ]
        );
      } else {
        ui.warn("Definition not available for deep inspection.");
      }

      ui.section("Configuration");
      ui.table(
        ["Property", "Value"],
        detail.config.map(item => [item.key, item.value])
      );

      ui.section("Inputs");
      if (detail.inputs.length === 0) ui.text("(None)");
      else ui.table(["Label", "Required", "Value"], detail.inputs.map(input => [input.label, input.required ? "Yes" : "No", JSON.stringify(input.value)]));

      ui.section("Outputs");
      if (detail.outputs.length === 0) ui.text("(None)");
      else ui.table(["Label", "Value"], detail.outputs.map(output => [output.label, JSON.stringify(output.value)]));
    }

    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }
  },
};

export default command;
