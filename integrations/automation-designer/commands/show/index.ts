import { existsSync, readFileSync, statSync } from "fs";
import { CliError, ok, Config, defineArgs, openUrlInBrowser, triggerDetachedRefresh, type CommandModule } from "@belzabar/core";
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";
import { resolveMethodRef } from "../../lib/ids";
import { abbreviate, htmlToText, pruneEmpty } from "../../lib/compact";
import { parseV1Method, parseV2Method } from "../../lib/parser/index";
import {
  compactMethod,
  flattenStepInputs,
  identityForStep,
  renderCompact,
  storyMarkdown,
  type CompactMethodView,
  type InputLabeler,
} from "../../lib/method-view";
import type {
  HydratedMethod,
  ParsedStep,
  CustomCodeStep,
  SpelEchoStep,
  SqlStep,
  RedisStep,
  UnknownStep,
  MethodField,
  MethodOutput,
  StepInput,
  ConditionRow,
} from "../../lib/types/common";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

// Moved to lib/method-view.ts (shared with --compact / --story); re-exported for callers/tests.
export { flattenStepInputs, identityForStep };

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
  open: boolean;
  compact: boolean;
  story: boolean;
}

/** `uuid` for a method on the env, or `file` for a local V1/V2 JSON body (e.g. a create spec before save). */
type ShowTarget = { kind: "uuid"; uuid: string } | { kind: "file"; path: string };

interface ShowMethodArgs {
  target: ShowTarget;
  flags: ShowMethodFlags;
  apiVersion: "v1" | "v2";
}

interface StepSummaryRow {
  orderIndex: number;
  kind: ParsedStep["kind"];
  description?: string;
  identity?: string;
}

/**
 * Default `ad show` payload. Lean by design (7.1): no request echo, empty /
 * null fields dropped (pruneEmpty), the wire body only with `--raw` and only
 * once (`raw`), code / SQL bodies only when asked for (`--code`, `--sql`,
 * `--full`).
 */
interface ShowMethodData {
  view?: undefined;
  source: "cache" | "stale" | "fresh" | "file";
  sourceVersion: "v1" | "v2";
  summary: {
    name: string;
    alias?: string;
    category: string;
    state: string;
    version: number | string;
    uuid: string;
    referenceId?: string | null;
    updated?: string;
    summary?: string;
    inputCount: number;
    variableCount: number;
    outputCount: number;
    stepCount: number;
    parseWarnings?: string[];
    editUrl?: string;
  };
  steps: StepSummaryRow[];
  inputs?: Array<{ code: string; type: string; required: boolean; description: string }>;
  variables?: Array<{ code: string; type: string; description: string }>;
  outputs?: Array<{ code: string; type: string; displayName: string; description: string }>;
  stepDetail?: StepDetailView | null;
  allStepDetails?: StepDetailView[];
  /** The wire body as fetched (V1 or V2) — `--raw` only. */
  raw?: unknown;
}

/** `source` / `fetchedAt` (ADR-R13): the views are always read fresh, or from a local file. */
type ViewSource = { source: "fresh" | "file"; sourceVersion: "v1" | "v2"; fetchedAt?: string };
type CompactData = { view: "compact" } & ViewSource & CompactMethodView;
interface StoryData extends ViewSource {
  view: "story";
  name: string;
  uuid: string;
  markdown: string;
}

type ShowData = ShowMethodData | CompactData | StoryData;

interface StepDetailView {
  orderIndex: number;
  kind: ParsedStep["kind"];
  description: string;
  identity: string;
  language?: string;
  /** Decoded custom code — only with --code / --full (or --service-detail N). */
  source?: string | null;
  expression?: string | null;
  /** Decoded SQL — only with --sql / --full (or --service-detail N). */
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
  condition?: { mode?: string; expression?: string; rows?: ConditionRow[] };
  /** Step input values (AD-40). */
  inputs?: Array<{ input: string; value: string }>;
  loop?: { source?: string; parallel?: boolean };
  reason?: string;
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

function summariseSteps(method: HydratedMethod): StepSummaryRow[] {
  return method.parsedSteps.map(s => ({
    orderIndex: s.orderIndex,
    kind: s.kind,
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

/** V1 input labels come from the (cached) service definition; V2 inputs carry their own names. */
async function v1LabelerFor(method: HydratedMethod, step: ParsedStep): Promise<InputLabeler | undefined> {
  if (method.sourceVersion !== "v1" || step.automationId == null || step.inputs.length === 0) return undefined;
  const def = await ServiceHydrator.getDefinition(step.automationId).catch(() => null);
  if (!def) return undefined;
  return (i) =>
    i.automationUserInputId != null
      ? ServiceHydrator.findInputLabel(def, i.automationUserInputId)?.label || undefined
      : undefined;
}

async function buildStepDetailView(
  method: HydratedMethod,
  step: ParsedStep,
  bodies: { code: boolean; sql: boolean },
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

  const labelFor = (await v1LabelerFor(method, step)) ?? (() => undefined);

  const outputs: StepDetailView["outputs"] = (step.outputs ?? []).map(o => ({
    code: o.code,
    type: (o.type as string) ?? "",
    displayName: o.displayName ?? o.code,
    link: o.internalVarRef ?? (typeof o.inputReference === "string" ? o.inputReference : undefined),
  }));

  const base: StepDetailView = {
    orderIndex: step.orderIndex,
    kind: step.kind,
    description: step.description ?? "",
    identity: identityForStep(step),
    config,
    outputs,
  };

  if (step.conditionExpression || step.conditionRows) {
    base.condition = {
      mode: step.conditionMode,
      expression: step.conditionExpression,
      ...(step.conditionRows ? { rows: step.conditionRows } : {}),
    };
  }
  if (step.kind === "EXISTING_SERVICE" || step.kind === "UNKNOWN" || step.kind.startsWith("REDIS_")) {
    const inputs = flattenStepInputs(step.inputs, labelFor);
    if (inputs.length > 0) base.inputs = inputs;
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
      if (bodies.code) base.source = s.source;
      return base;
    }
    case "SPEL_ECHO": {
      const s = step as SpelEchoStep;
      base.expression = s.expression;
      return base;
    }
    case "SQL": {
      const s = step as SqlStep;
      if (bodies.sql) base.sql = s.sql;
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

/** A local V2 (`steps[]`) or V1 (`services[]` / `jsonDefinition`) method body. */
export function parseMethodFile(path: string): HydratedMethod {
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CliError(`Cannot read ${path} as JSON: ${(e as Error).message}`, { code: "INVALID_FILE" });
  }
  const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (o && Array.isArray(o.steps)) return parseV2Method(o as unknown as V2MethodResponse);
  if (o && (typeof o.jsonDefinition === "string" || Array.isArray(o.services))) {
    const raw = typeof o.jsonDefinition === "string" ? o : { jsonDefinition: JSON.stringify(o) };
    return parseV1Method(raw as unknown as V1RawMethodResponse);
  }
  throw new CliError(`${path} is not an AD method body (expected V2 \`steps[]\` or V1 \`services[]\`/\`jsonDefinition\`).`, {
    code: "INVALID_FILE",
  });
}

/**
 * The `--compact` / `--story` read: V2, fresh (never the V1-shaped cache).
 * Falls back to the V1 parse only when the V2 route refuses the method (some
 * old bodies fail the server's V2 conversion); an unknown uuid still fails.
 */
async function fetchViewMethod(uuid: string, warn: (m: string) => void): Promise<HydratedMethod> {
  try {
    return await adApi.fetchMethod(uuid, "v2");
  } catch (err) {
    if (err instanceof CliError && err.code === "METHOD_NOT_FOUND") throw err;
    warn(`V2 read failed (${(err as Error).message}); showing the V1 parse, whose input names are UI labels, not save keys.`);
    return adApi.fetchMethod(uuid, "v1");
  }
}

function looksLikeFile(input: string): boolean {
  try {
    return existsSync(input) && statSync(input).isFile();
  } catch {
    return false;
  }
}

export const args = defineArgs({
  command: "belz ad show",
  positionals: [
    { name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." },
  ],
  flags: {
    ...AD_COMMON_FLAGS,
    code: { type: "boolean" },
    sql: { type: "boolean" },
    outputs: { type: "boolean" },
    variables: { type: "boolean" },
    inputs: { type: "boolean" },
    services: { type: "boolean" },
    full: { type: "boolean" },
    force: { type: "boolean" },
    raw: { type: "boolean" },
    // AD-14 / F6: `--service-detail N` is the documented spelling; `--step N` the original one.
    step: { type: "number", integer: true, min: 1, alias: ["--service-detail"] },
    open: { type: "boolean", alias: ["-o"] },
    compact: { type: "boolean" },
    story: { type: "boolean" },
  },
  exclusive: [["compact", "story"], ["story", "raw"], ["compact", "raw"]],
});

/**
 * Human "Service Chain" rows: the AD UI's rich-text step descriptions as plain
 * text cut to 100 chars (smoke UX: raw `<ul><li>` / `&lt;` in table cells).
 * The `--llm` data keeps the description as stored.
 */
export function stepTableRows(steps: Array<{ orderIndex: number; kind: ParsedStep["kind"]; description?: string; identity?: string }>): Array<Array<string | number>> {
  return steps.map(s => [s.orderIndex, `[${badgeForKind(s.kind)}]`, abbreviate(htmlToText(s.description ?? ""), 100), s.identity ?? ""]);
}

const command: CommandModule<ShowMethodArgs, ShowData> = {
  schema: "ad.show",
  parseArgs(argv) {
    const { positionals, flags: f } = args.parse(argv);
    const common = resolveAdCommon(f, "fetch", "show");
    const target: ShowTarget = looksLikeFile(positionals.uuid)
      ? { kind: "file", path: positionals.uuid }
      : { kind: "uuid", uuid: resolveMethodRef(positionals.uuid) };
    const flags: ShowMethodFlags = {
      code: f.code,
      sql: f.sql,
      outputs: f.outputs,
      variables: f.variables,
      inputs: f.inputs,
      services: f.services,
      full: f.full,
      force: f.force,
      raw: f.raw,
      step: f.step ?? null,
      open: f.open,
      compact: f.compact,
      story: f.story,
    };
    return { target, flags, apiVersion: common.apiVersion.version };
  },
  async execute({ target, flags, apiVersion }, context) {
    let method: HydratedMethod;
    let source: ShowMethodData["source"];
    if (target.kind === "file") {
      if (flags.open) throw new CliError("--open needs a method uuid, not a file.", { code: "INVALID_ARGUMENT" });
      method = parseMethodFile(target.path);
      source = "file";
    } else if (flags.compact || flags.story) {
      // ADR-R4: the agent views read V2, whose input paths (`body.json`) and
      // output keys (`key→fieldCode`) are what `ad save` ops / `create --spec`
      // take. V1 names inputs by UI label and drops the service output key.
      source = "fresh";
      method = await fetchViewMethod(target.uuid, context.warn.bind(context));
    } else {
      const uuid = target.uuid;
      const cached = await CacheManager.loadSwr(uuid);
      let m = cached?.data ?? null;
      source = cached?.stale ? "stale" : "cache";

      // Cache is V1-shaped; if --v2 or force is set, refetch.
      if (!m || flags.force || apiVersion === "v2" || m.sourceVersion !== apiVersion) {
        source = "fresh";
        m = await adApi.fetchMethod(uuid, apiVersion);
        if (apiVersion === "v1") await CacheManager.save(uuid, m);
      }
      method = m;

      if (source === "stale") {
        // Serve stale data now; refresh the cache in a detached background process.
        context.warn("Using stale cached definition — refreshing in background.");
        triggerDetachedRefresh(CacheManager.dir, uuid);
      } else if (source === "cache") {
        context.warn("Using cached method definition. Use --force for refresh.");
      }
    }

    if (flags.step !== null && !method.parsedSteps.some(s => s.orderIndex === flags.step)) {
      throw new CliError(`Step with index ${flags.step} not found.`, { code: "STEP_NOT_FOUND" });
    }

    // The AD UI expects a DRAFT uuid in the URL; a published row's
    // referenceId points at its linked draft, if any.
    const categoryName = method.category?.name ?? "Uncategorized";
    const draftUuid =
      method.state === "PUBLISHED" && method.referenceId ? method.referenceId : method.uuid;
    const editUrl = target.kind === "uuid"
      ? `${Config.cleanBaseUrl}/automation-designer/${encodeURIComponent(categoryName)}/${draftUuid}`
      : undefined;

    if (flags.open && editUrl) {
      try {
        await openUrlInBrowser(editUrl);
      } catch (err) {
        context.warn(`--open failed: ${(err as Error).message}. URL: ${editUrl}`);
      }
    }

    const viewSource: ViewSource = {
      source: source === "file" ? "file" : "fresh",
      sourceVersion: method.sourceVersion,
      ...(source === "file" ? {} : { fetchedAt: new Date().toISOString() }),
    };
    if (flags.story) {
      return ok<ShowData>({ view: "story", ...viewSource, name: method.name, uuid: method.uuid, markdown: storyMarkdown(method) }, { sourceVersion: method.sourceVersion });
    }

    if (flags.compact) {
      const labels = new Map<number, InputLabeler>();
      for (const s of method.parsedSteps) {
        const l = await v1LabelerFor(method, s);
        if (l) labels.set(s.orderIndex, l);
      }
      const view = compactMethod(method, {
        labels,
        step: flags.step,
        bodyChars: flags.full ? 0 : 160,
        valueChars: flags.full ? 0 : 60,
        fullBodies: {
          sql: flags.sql || flags.full || flags.step !== null,
          code: flags.code || flags.full || flags.step !== null,
          spel: flags.full || flags.step !== null,
        },
      });
      return ok<ShowData>(pruneEmpty<CompactData>({ view: "compact", ...viewSource, ...view }), { sourceVersion: method.sourceVersion });
    }

    const includeInputs = flags.inputs || flags.full;
    const includeServices = flags.services || flags.full;
    const includeVariables = flags.variables || flags.full;
    const includeOutputs = flags.outputs || flags.full;
    const bodies = { code: flags.code || flags.full, sql: flags.sql || flags.full };

    let stepDetail: StepDetailView | null = null;
    if (flags.step !== null) {
      const match = method.parsedSteps.find(s => s.orderIndex === flags.step)!;
      // A single step's detail always carries its body (the point of asking for it).
      stepDetail = await buildStepDetailView(method, match, { code: true, sql: true });
    }

    const data: ShowMethodData = {
      source,
      sourceVersion: method.sourceVersion,
      summary: {
        name: method.name,
        alias: method.aliasName,
        category: categoryName,
        state: method.state,
        version: method.version,
        uuid: method.uuid,
        referenceId: method.referenceId,
        updated: method.updatedOn ? `${formatDate(method.updatedOn)} by ${method.updatedBy ?? "unknown"}` : undefined,
        summary: method.summary ?? "",
        inputCount: method.inputs.length,
        variableCount: method.variables.length,
        outputCount: method.outputs.length,
        stepCount: method.parsedSteps.length,
        parseWarnings: method.parseWarnings,
        editUrl,
      },
      steps: summariseSteps(method),
      stepDetail,
    };

    if (includeInputs) data.inputs = mapInputFields(method.inputs);
    if (includeVariables) data.variables = mapVariableFields(method.variables);
    if (includeOutputs) data.outputs = mapOutputFields(method.outputs);

    if (includeServices || flags.code || flags.sql) {
      const details: StepDetailView[] = [];
      for (const step of method.parsedSteps) {
        details.push(await buildStepDetailView(method, step, bodies));
      }
      data.allStepDetails = details;
    }

    const lean = pruneEmpty(data);
    // Kept verbatim (never pruned): the wire body, emitted once.
    if (flags.raw) lean.raw = method.raw;
    return ok<ShowData>(lean, { sourceVersion: method.sourceVersion });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const payload = envelope.data as ShowData;
    if (payload.view === "story") {
      ui.text(payload.markdown);
      return;
    }
    if (payload.view === "compact") {
      ui.text(renderCompact(payload));
      return;
    }
    const data = payload;
    const summary = data.summary;

    const rows: unknown[][] = [
      ["Method Name", summary.name],
      ["Alias", summary.alias ?? ""],
      ["Category", summary.category],
      ["State", summary.state],
      ["Version", summary.version],
      [summary.state === "PUBLISHED" ? "Published ID" : "Draft ID", summary.uuid],
      [summary.state === "PUBLISHED" ? "Draft ID" : "Published ID", summary.referenceId ?? ""],
      ["Updated", summary.updated ?? "N/A"],
      ["Summary", summary.summary ?? ""],
      ["Inputs", summary.inputCount],
      ["Variables", summary.variableCount],
      ["Outputs", summary.outputCount],
      ["Steps", summary.stepCount],
      ["API Source", data.sourceVersion.toUpperCase()],
      ["Cache", data.source === "stale" ? "stale (refreshing…)" : data.source],
    ];
    if (summary.editUrl) rows.push(["Edit URL", summary.editUrl]);
    ui.table(["Property", "Value"], rows);

    if (summary.parseWarnings?.length) {
      ui.section("Parse Warnings");
      for (const w of summary.parseWarnings) ui.warn(w);
    }

    // Compact step listing with kind badges.
    ui.section("Service Chain");
    if (data.steps.length === 0) {
      ui.text("No steps defined.");
    } else {
      ui.table(
        ["#", "Kind", "Description", "Identity"],
        stepTableRows(data.steps),
      );
    }

    // Empty lists are pruned from the payload: a missing section = none / not asked for.
    if (data.inputs) {
      ui.section("Inputs");
      ui.table(
        ["Field", "Type", "Required", "Description"],
        data.inputs.map(i => [i.code, i.type ?? "", i.required ? "Yes" : "No", i.description ?? ""]),
      );
    }

    if (data.variables) {
      ui.section("Variables");
      ui.table(
        ["Field", "Type", "Description"],
        data.variables.map(v => [v.code, v.type ?? "", v.description ?? ""]),
      );
    }

    if (data.outputs) {
      ui.section("Outputs");
      ui.table(
        ["Code", "Display Name", "Type", "Description"],
        data.outputs.map(o => [o.code, o.displayName ?? "", o.type ?? "", o.description ?? ""]),
      );
    }

    const presentDetail = (detail: StepDetailView, title: string) => {
      ui.section(title);
      if (detail.identity) ui.kv("Identity", detail.identity);
      if (detail.reason) ui.warn(detail.reason);

      if (detail.config?.length) {
        ui.table(["Property", "Value"], detail.config.map(c => [c.key, c.value]));
      }
      if (detail.condition) {
        ui.kv("Condition", `${detail.condition.mode ?? "advance"}: ${detail.condition.expression ?? ""}`);
        for (const r of detail.condition.rows ?? []) {
          ui.text(`  ${r.groupOp ? `${r.groupOp} ` : ""}${r.field} ${r.operator} ${r.value ?? "null"}`);
        }
      }
      if (detail.inputs) {
        ui.table(["Input", "Value"], detail.inputs.map(i => [i.input, i.value]));
      }
      if (detail.loop) {
        ui.kv("Loop Source", detail.loop.source ?? "(none)");
        ui.kv("Parallel", detail.loop.parallel ? "Yes" : "No");
      }

      if (detail.kind === "CUSTOM_CODE") {
        ui.kv("Language", detail.language ?? "");
        if (detail.source != null) {
          ui.section("Source");
          ui.text(indentSource(detail.source));
        } else {
          ui.text("(source hidden — use --code or --full)");
        }
      }

      if (detail.kind === "SPEL_ECHO") {
        ui.kv("Expression", detail.expression ?? "");
      }

      if (detail.kind === "SQL") {
        ui.kv("Operation", detail.sqlOperation ?? "");
        ui.kv("Result Shape", detail.resultShape ?? "");
        if (detail.automationAuthId != null) ui.kv("DB Auth ID", String(detail.automationAuthId));
        if (detail.sql != null) {
          ui.section("SQL");
          ui.text(indentSource(detail.sql));
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

      if (detail.outputs?.length) {
        ui.table(
          ["Output", "Type", "Display", "Link"],
          detail.outputs.map(o => [o.code, o.type ?? "", o.displayName ?? "", o.link ?? ""]),
        );
      }
    };

    for (const detail of data.allStepDetails ?? []) {
      presentDetail(detail, `Step ${detail.orderIndex}: [${badgeForKind(detail.kind)}] ${detail.description || detail.identity || ""}`);
    }

    if (data.stepDetail) {
      const d = data.stepDetail;
      presentDetail(d, `Step Detail [Index ${d.orderIndex}] [${badgeForKind(d.kind)}] ${d.description ?? ""}`);
    }

    if (data.raw !== undefined) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }
  },
};

export default command;
