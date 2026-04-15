import { CliError, ok, Config, type CommandModule } from "@belzabar/core";
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import { adApi } from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";
import type {
  HydratedMethod,
  ParsedStep,
  CustomCodeStep,
  SpelEchoStep,
  SqlStep,
  RedisStep,
  ExistingServiceStep,
  UnknownStep,
  MethodField,
  MethodOutput,
} from "../../lib/types/common";

interface ShowMethodFlags {
  code: boolean;
  sql: boolean;
  outputs: boolean;
  variables: boolean;
  inputs: boolean;
  services: boolean;
  full: boolean;
  force: boolean;
  raw: boolean;
  step: number | null;
}

interface ShowMethodArgs {
  uuid: string;
  flags: ShowMethodFlags;
  apiVersion: "v1" | "v2";
}

interface StepSummaryRow {
  orderIndex: number;
  kind: ParsedStep["kind"];
  badge: string;
  description: string;
  identity: string;
}

interface ShowMethodData {
  request: { uuid: string; flags: ShowMethodFlags };
  source: "cache" | "fresh";
  sourceVersion: "v1" | "v2";
  summary: {
    name: string;
    alias?: string;
    category: string;
    state: string;
    version: number | string;
    uuid: string;
    referenceId: string | null;
    updated: string;
    summary: string;
    inputCount: number;
    variableCount: number;
    outputCount: number;
    stepCount: number;
    parseWarnings: string[];
  };
  steps: StepSummaryRow[];
  inputs?: Array<{ code: string; type: string; required: boolean; description: string }>;
  variables?: Array<{ code: string; type: string; description: string }>;
  outputs?: Array<{ code: string; type: string; displayName: string; description: string }>;
  stepDetail?: StepDetailView | null;
  allStepDetails?: StepDetailView[];
  raw?: { method: HydratedMethod };
}

interface StepDetailView {
  orderIndex: number;
  kind: ParsedStep["kind"];
  badge: string;
  description: string;
  identity: string;
  language?: string;
  source?: string | null;
  expression?: string | null;
  sql?: string | null;
  sqlOperation?: string;
  resultShape?: string;
  automationAuthId?: number;
  redis?: {
    key?: string;
    value?: string;
    ttlSeconds?: string;
    store?: string;
    overwrite?: string;
  };
  config: Array<{ key: string; value: string }>;
  outputs: Array<{ code: string; type: string; displayName: string; link?: string }>;
  condition?: { mode?: string; expression?: string };
  loop?: { source?: string; parallel?: boolean };
  reason?: string;
}

function resolveUuid(input: string): string {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const url = new URL(input);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last || !/^[0-9a-f]{32}$/i.test(last)) {
      throw new CliError("Could not extract a valid UUID from the given URL.", {
        code: "INVALID_URL",
      });
    }
    return last;
  }
  return input;
}

function formatDate(ts: number | undefined): string {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString();
}

function badgeForKind(kind: ParsedStep["kind"]): string {
  switch (kind) {
    case "CUSTOM_CODE":
      return "CODE";
    case "SPEL_ECHO":
      return "SPEL";
    case "SQL":
      return "SQL";
    case "REDIS_GET":
      return "REDIS-GET";
    case "REDIS_SET":
      return "REDIS-SET";
    case "REDIS_REMOVE":
      return "REDIS-REMOVE";
    case "EXISTING_SERVICE":
      return "EXISTING";
    case "UNKNOWN":
      return "UNKNOWN";
  }
}

function identityForStep(step: ParsedStep): string {
  if (step.serviceName && step.methodName) {
    return `${step.serviceName}.${step.methodName}`;
  }
  if (step.automationApiId != null) return `apiId:${step.automationApiId}`;
  if (step.automationId) return step.automationId;
  return "";
}

function summariseSteps(method: HydratedMethod): StepSummaryRow[] {
  return method.parsedSteps.map(s => ({
    orderIndex: s.orderIndex,
    kind: s.kind,
    badge: badgeForKind(s.kind),
    description: s.description ?? "",
    identity: identityForStep(s),
  }));
}

function indentSource(source: string, indent = "  "): string {
  return source
    .split("\n")
    .map(line => indent + line)
    .join("\n");
}

async function buildStepDetailView(
  method: HydratedMethod,
  step: ParsedStep,
): Promise<StepDetailView> {
  const config: StepDetailView["config"] = [];
  if (step.runAsync) config.push({ key: "Async", value: "Yes" });
  if (step.streamCapable) config.push({ key: "Stream Capable", value: "Yes" });
  if (step.repeatStepExecution) {
    config.push({
      key: "Loop",
      value: step.loopConfiguration?.executeParallel ? "Parallel" : "Sequential",
    });
  }
  config.push({
    key: "Abort on Failure",
    value: step.forceExitFromFailure ? "Yes" : "No",
  });

  // Hydrator enrichment for EXISTING_SERVICE steps (V1 only — V2 steps carry
  // serviceName/methodName directly and do not need the catalog).
  let displayIdentity = identityForStep(step);
  let automationId = step.automationId;
  if (method.sourceVersion === "v1" && step.automationId) {
    const def = await ServiceHydrator.getDefinition(step.automationId).catch(() => null);
    if (def?.automationAPI) {
      const cat = def.automationAPI.automationSystem?.label;
      const label = def.automationAPI.label;
      if (cat && label) displayIdentity = `${cat}.${label}`;
      automationId = String(def.automationAPI.id);
    }
  }

  const outputs: StepDetailView["outputs"] = (step.outputs ?? []).map(o => ({
    code: o.code,
    type: (o.type as string) ?? "",
    displayName: o.displayName ?? o.code,
    link: o.internalVarRef ?? o.inputReference,
  }));

  const base: StepDetailView = {
    orderIndex: step.orderIndex,
    kind: step.kind,
    badge: badgeForKind(step.kind),
    description: step.description ?? "",
    identity: displayIdentity,
    config,
    outputs,
  };

  if (step.conditionExpression) {
    base.condition = {
      mode: step.conditionMode,
      expression: step.conditionExpression,
    };
  }
  if (step.repeatStepExecution) {
    base.loop = {
      source: step.loopExecutionSource,
      parallel: step.loopConfiguration?.executeParallel,
    };
  }

  switch (step.kind) {
    case "CUSTOM_CODE": {
      const s = step as CustomCodeStep;
      base.language = s.language ?? "";
      base.source = s.source;
      return base;
    }
    case "SPEL_ECHO": {
      const s = step as SpelEchoStep;
      base.expression = s.expression;
      return base;
    }
    case "SQL": {
      const s = step as SqlStep;
      base.sql = s.sql;
      base.sqlOperation = s.operation;
      base.resultShape = s.resultShape;
      base.automationAuthId = s.automationAuthId;
      return base;
    }
    case "REDIS_GET":
    case "REDIS_SET":
    case "REDIS_REMOVE": {
      const s = step as RedisStep;
      base.redis = {
        key: s.key,
        value: s.value,
        ttlSeconds: s.ttlSeconds,
        store: s.store,
        overwrite: s.overwrite,
      };
      return base;
    }
    case "EXISTING_SERVICE": {
      // Identity + outputs already populated above.
      return base;
    }
    case "UNKNOWN": {
      const s = step as UnknownStep;
      base.reason = s.reason;
      return base;
    }
  }
}

function mapInputFields(fields: MethodField[]): NonNullable<ShowMethodData["inputs"]> {
  return fields.map(f => ({
    code: f.code,
    type: String(f.type ?? ""),
    required: !!f.required,
    description: f.description ?? "",
  }));
}

function mapVariableFields(fields: MethodField[]): NonNullable<ShowMethodData["variables"]> {
  return fields.map(f => ({
    code: f.code,
    type: String(f.type ?? ""),
    description: f.description ?? "",
  }));
}

function mapOutputFields(outputs: MethodOutput[]): NonNullable<ShowMethodData["outputs"]> {
  return outputs.map(o => ({
    code: o.code,
    type: String(o.type ?? ""),
    displayName: o.displayName ?? o.code,
    description: o.description ?? "",
  }));
}

const command: CommandModule<ShowMethodArgs, ShowMethodData> = {
  schema: "ad.show",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "fetch", "show");
    emitFallbackWarning(common, "show");

    const first = rest[0];
    if (!first || first.startsWith("-")) {
      throw new CliError("Missing UUID argument.", { code: "MISSING_UUID" });
    }
    const uuid = resolveUuid(first);

    const flags: ShowMethodFlags = {
      code: rest.includes("--code"),
      sql: rest.includes("--sql"),
      outputs: rest.includes("--outputs"),
      variables: rest.includes("--variables"),
      inputs: rest.includes("--inputs"),
      services: rest.includes("--services"),
      full: rest.includes("--full"),
      force: rest.includes("--force"),
      raw: rest.includes("--raw"),
      step: null,
    };
    const stepIdx = rest.indexOf("--step");
    if (stepIdx !== -1 && rest[stepIdx + 1]) {
      const n = parseInt(rest[stepIdx + 1]!, 10);
      if (Number.isNaN(n)) {
        throw new CliError("--step requires a valid numeric index.", { code: "INVALID_STEP_INDEX" });
      }
      flags.step = n;
    }

    return { uuid, flags, apiVersion: common.apiVersion.version };
  },
  async execute({ uuid, flags, apiVersion }, context) {
    let method = await CacheManager.load(uuid);
    let source: "cache" | "fresh" = "cache";

    // Cache is V1-shaped; if --v2 or force is set, refetch.
    if (!method || flags.force || apiVersion === "v2" || method.sourceVersion !== apiVersion) {
      source = "fresh";
      method = await adApi.fetchMethod(uuid, apiVersion);
      if (apiVersion === "v1") await CacheManager.save(uuid, method);
    }

    if (source === "cache") {
      context.warn("Using cached method definition. Use --force for refresh.");
    }

    const includeInputs = flags.inputs || flags.full;
    const includeServices = flags.services || flags.full;
    const includeVariables = flags.variables || flags.full;
    const includeOutputs = flags.outputs || flags.full;

    let stepDetail: StepDetailView | null = null;
    if (flags.step !== null) {
      const match = method.parsedSteps.find(s => s.orderIndex === flags.step);
      if (!match) {
        throw new CliError(`Step with index ${flags.step} not found.`, { code: "STEP_NOT_FOUND" });
      }
      stepDetail = await buildStepDetailView(method, match);
    }

    const data: ShowMethodData = {
      request: { uuid, flags },
      source,
      sourceVersion: method.sourceVersion,
      summary: {
        name: method.name,
        alias: method.aliasName,
        category: method.category?.name ?? "Uncategorized",
        state: method.state,
        version: method.version,
        uuid: method.uuid,
        referenceId: method.referenceId,
        updated: `${formatDate(method.updatedOn)} by ${method.updatedBy ?? "unknown"}`,
        summary: method.summary ?? "",
        inputCount: method.inputs.length,
        variableCount: method.variables.length,
        outputCount: method.outputs.length,
        stepCount: method.parsedSteps.length,
        parseWarnings: method.parseWarnings,
      },
      steps: summariseSteps(method),
      stepDetail,
    };

    if (includeInputs) data.inputs = mapInputFields(method.inputs);
    if (includeVariables) data.variables = mapVariableFields(method.variables);
    if (includeOutputs) data.outputs = mapOutputFields(method.outputs);

    if (includeServices || flags.full || flags.code || flags.sql) {
      const details: StepDetailView[] = [];
      for (const step of method.parsedSteps) {
        details.push(await buildStepDetailView(method, step));
      }
      data.allStepDetails = details;
    }

    if (flags.raw) data.raw = { method };

    return ok(data, { sourceVersion: method.sourceVersion });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ShowMethodData;
    const flags = data.request.flags;

    ui.table(
      ["Property", "Value"],
      [
        ["Method Name", data.summary.name],
        ["Alias", data.summary.alias ?? ""],
        ["Category", data.summary.category],
        ["State", data.summary.state],
        ["Version", data.summary.version],
        [data.summary.state === "PUBLISHED" ? "Published ID" : "Draft ID", data.summary.uuid],
        [data.summary.state === "PUBLISHED" ? "Draft ID" : "Published ID", data.summary.referenceId ?? ""],
        ["Updated", data.summary.updated],
        ["Summary", data.summary.summary],
        ["Inputs", data.summary.inputCount],
        ["Variables", data.summary.variableCount],
        ["Outputs", data.summary.outputCount],
        ["Steps", data.summary.stepCount],
        ["API Source", data.sourceVersion.toUpperCase()],
        ["Cache", data.source],
      ],
    );

    if (data.summary.parseWarnings.length > 0) {
      ui.section("Parse Warnings");
      for (const w of data.summary.parseWarnings) ui.warn(w);
    }

    // Compact step listing with kind badges.
    ui.section("Service Chain");
    if (data.steps.length === 0) {
      ui.text("No steps defined.");
    } else {
      ui.table(
        ["#", "Kind", "Description", "Identity"],
        data.steps.map(s => [s.orderIndex, `[${s.badge}]`, s.description, s.identity]),
      );
    }

    if (data.inputs) {
      ui.section("Inputs");
      if (data.inputs.length === 0) ui.text("(none)");
      else ui.table(
        ["Field", "Type", "Required", "Description"],
        data.inputs.map(i => [i.code, i.type, i.required ? "Yes" : "No", i.description]),
      );
    }

    if (data.variables) {
      ui.section("Variables");
      if (data.variables.length === 0) ui.text("(none)");
      else ui.table(
        ["Field", "Type", "Description"],
        data.variables.map(v => [v.code, v.type, v.description]),
      );
    }

    if (data.outputs) {
      ui.section("Outputs");
      if (data.outputs.length === 0) ui.text("(none)");
      else ui.table(
        ["Code", "Display Name", "Type", "Description"],
        data.outputs.map(o => [o.code, o.displayName, o.type, o.description]),
      );
    }

    if (data.allStepDetails) {
      for (const detail of data.allStepDetails) {
        ui.section(`Step ${detail.orderIndex}: [${detail.badge}] ${detail.description || detail.identity}`);
        if (detail.identity) ui.kv("Identity", detail.identity);
        if (detail.reason) ui.warn(detail.reason);

        if (detail.config.length > 0) {
          ui.table(["Property", "Value"], detail.config.map(c => [c.key, c.value]));
        }
        if (detail.condition) {
          ui.kv("Condition", `${detail.condition.mode ?? "advance"}: ${detail.condition.expression}`);
        }
        if (detail.loop) {
          ui.kv("Loop Source", detail.loop.source ?? "(none)");
          ui.kv("Parallel", detail.loop.parallel ? "Yes" : "No");
        }

        if (detail.kind === "CUSTOM_CODE" && (flags.code || flags.full)) {
          ui.kv("Language", detail.language ?? "");
          ui.section("Source");
          ui.text(indentSource(detail.source ?? ""));
        } else if (detail.kind === "CUSTOM_CODE") {
          ui.kv("Language", detail.language ?? "");
          ui.text("(source hidden — use --code or --full)");
        }

        if (detail.kind === "SPEL_ECHO") {
          ui.kv("Expression", detail.expression ?? "");
        }

        if (detail.kind === "SQL") {
          ui.kv("Operation", detail.sqlOperation ?? "");
          ui.kv("Result Shape", detail.resultShape ?? "");
          if (detail.automationAuthId != null) ui.kv("DB Auth ID", String(detail.automationAuthId));
          if (flags.sql || flags.full) {
            ui.section("SQL");
            ui.text(indentSource(detail.sql ?? ""));
          } else {
            ui.text("(SQL hidden — use --sql or --full)");
          }
        }

        if (detail.redis) {
          if (detail.redis.key != null) ui.kv("Key", detail.redis.key);
          if (detail.redis.value != null) ui.kv("Value", detail.redis.value);
          if (detail.redis.ttlSeconds != null) ui.kv("TTL", detail.redis.ttlSeconds);
          if (detail.redis.store != null) ui.kv("Store", detail.redis.store);
          if (detail.redis.overwrite != null) ui.kv("Overwrite", detail.redis.overwrite);
        }

        if (detail.outputs.length > 0) {
          ui.table(
            ["Output", "Type", "Display", "Link"],
            detail.outputs.map(o => [o.code, o.type, o.displayName, o.link ?? ""]),
          );
        }
      }
    }

    if (data.stepDetail) {
      const d = data.stepDetail;
      ui.section(`Step Detail [Index ${d.orderIndex}] [${d.badge}]`);
      ui.kv("Description", d.description);
      ui.kv("Identity", d.identity);
      if (d.kind === "CUSTOM_CODE") {
        ui.kv("Language", d.language ?? "");
        if (flags.code || flags.full) ui.text(indentSource(d.source ?? ""));
      }
      if (d.kind === "SQL" && (flags.sql || flags.full)) {
        ui.text(indentSource(d.sql ?? ""));
      }
    }

    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }

    // Suppress lint on unused Config — kept for future URL renderings.
    void Config;
  },
};

export default command;
