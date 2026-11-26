import { existsSync, statSync } from "fs";
import { CliError, type CommandModule, Config, currentCacheEnv, defineArgs, ok, openUrlInBrowser, readJsonInputSync, triggerDetachedRefresh } from "@belzabar/core";
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import { AD_V2_FLAG, apiVersionOf } from "../../lib/args/common";
import { resolveMethodRef } from "@belzabar/core/platform";
import { abbreviate, htmlToText, pruneEmpty } from "../../lib/compact";
import { parseV1Method, parseV2Method } from "../../lib/parser/index";
import { adApi } from "../../lib/api/index";
import { parseVersionBody } from "../../lib/fingerprint";
import { getVersionOf, sideOf } from "../../lib/history";
import { cachedCategoryResolver } from "../../lib/method-finder";
import {
  canonicalIdentity,
  compactMethod,
  defaultText,
  flattenStepInputs,
  identityForStep,
  inputPairs,
  renderCompact,
  stepGates,
  storedSummaryOf,
  storyMarkdown,
  type CategoryResolver,
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
  ConditionRow,
} from "../../lib/types/common";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";
import type { V2MethodResponse } from "../../lib/types/v2-wire";
import { assertNotKnownDeleted, fetchMethodChecked, fetchViewMethod } from "../../lib/view-fetch";

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
  /** `--version N`: that saved version of this chain, read through history. */
  version: number | null;
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
  /** Behaviour markers: entry condition, loop, exit-if / exit-on-fail, async, account. */
  gates?: string[];
}

/**
 * Default `ad show` payload. Lean by design: no request echo, empty /
 * null fields dropped (pruneEmpty), the wire body only with `--raw` and only
 * once (`raw`), code / SQL bodies only when asked for (`--code`, `--sql`,
 * `--full`).
 */
/** A cached read: when it was cached, and the server version it was checked against (D2). */
interface CacheInfo {
  savedAt: string;
  ageMinutes: number;
  version: number | string;
  /** The server's current version (a cheap V1 read); absent when that check failed. */
  serverVersion?: number | string;
}

/** `--version N`: the history record the view was built from. */
interface HistoryInfo {
  version: number;
  side: "DRAFT" | "PUBLISHED";
  versionUUID?: string;
  isPublished?: boolean;
  addedBy?: number;
  addedWhen?: string;
}

interface ShowMethodData {
  view?: undefined;
  source: "cache" | "stale" | "fresh" | "file" | "history";
  sourceVersion: "v1" | "v2";
  cache?: CacheInfo;
  history?: HistoryInfo;
  /** e.g. a stepless (built-in) method has no source. */
  note?: string;
  summary: {
    name: string;
    alias?: string;
    /** K8: the alias (the old name after a rename) is not the name; it still reserves that name in the category. */
    aliasDiffers?: boolean;
    category: string;
    state: string;
    version: number | string;
    uuid: string;
    referenceId?: string | null;
    updated?: string;
    /** The summary as stored ("" when unset; never the description). */
    summary?: string;
    /** The long method description (`ad save` key `description`). */
    methodDescription?: string;
    inputCount: number;
    variableCount: number;
    outputCount: number;
    stepCount: number;
    parseWarnings?: string[];
    editUrl?: string;
    deprecated?: boolean;
    scope?: string;
    timeoutSeconds?: number;
  };
  /** Absent with `--step N` (that step only, in `stepDetail`). */
  steps?: StepSummaryRow[];
  inputs?: Array<{ code: string; type: string; required: boolean; description: string; defaultValue?: string; testValue?: string }>;
  variables?: Array<{ code: string; type: string; description: string; defaultValue?: string }>;
  outputs?: Array<{ code: string; type: string; displayName: string; description: string }>;
  stepDetail?: StepDetailView | null;
  allStepDetails?: StepDetailView[];
  /** The wire body as fetched (V1 or V2) — `--raw` only. */
  raw?: unknown;
}

/** `source` / `fetchedAt`: the views are always read fresh, from history (`--version`), or from a local file. */
type ViewSource = { source: "fresh" | "file" | "history"; sourceVersion: "v1" | "v2"; fetchedAt?: string; history?: HistoryInfo };
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
  /** Step input values. */
  inputs?: Array<{ input: string; value: string }>;
  loop?: { source?: string; parallel?: boolean; type?: string; counter?: string };
  /** Conditional exit: the method returns after this step when `expression` holds. */
  exitIf?: { mode?: string; expression?: string; rows?: ConditionRow[]; statusCode?: number | string; message?: string };
  exitOnFailure?: { statusCode?: number | string; message?: string };
  account?: { id?: number | string; name?: string };
  /** A call step's callee reference exactly as the read body stores it (K17). */
  callee?: CalleeReference;
  reason?: string;
}

/**
 * How a call step points at its callee, from the step's wire JSON (only the
 * keys present). V1 (the stored jsonDefinition): `automationApiId` (the
 * callee API's env-local numeric id), on some bodies `automationApiUuid` (the
 * API uuid, the same on every env) and `categoryName`, and no method name.
 * Older V1 bodies hold only `automationId`: the step's env-local automation
 * record, whose definition (`GET /automations/{id}`) names the API. V2:
 * `automationAPIId` (the API uuid) plus the `serviceName` / `methodName` the
 * read fills in.
 */
export interface CalleeReference {
  route: "v1" | "v2";
  apiUuid?: string;
  /** V1 numeric `automationApiId` (env-local). */
  apiNumericId?: number;
  /** V1 `automationId`: the step's automation record (env-local). */
  automationId?: number;
  categoryName?: string;
  serviceName?: string;
  methodName?: string;
  /** Whether the read body names the callee's method (V2 only). */
  methodNameStored: boolean;
}

export function calleeReference(step: ParsedStep, route: "v1" | "v2"): CalleeReference | undefined {
  const raw = step.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const ref: CalleeReference = { route, methodNameStored: false };
  if (route === "v1") {
    ref.apiUuid = str(r.automationApiUuid);
    const n = typeof r.automationApiId === "number" ? r.automationApiId : Number(str(r.automationApiId) ?? NaN);
    if (Number.isFinite(n)) ref.apiNumericId = n;
    const a = typeof r.automationId === "number" ? r.automationId : Number(str(r.automationId) ?? NaN);
    if (Number.isFinite(a)) ref.automationId = a;
    ref.categoryName = str(r.categoryName);
  } else {
    ref.apiUuid = str(r.automationAPIId);
    ref.serviceName = str(r.serviceName);
    ref.methodName = str(r.methodName);
  }
  ref.methodNameStored = ref.methodName !== undefined;
  for (const k of Object.keys(ref) as Array<keyof CalleeReference>) if (ref[k] === undefined) delete ref[k];
  return ref.apiUuid || ref.apiNumericId != null || ref.automationId != null || ref.serviceName ? ref : undefined;
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

function summariseSteps(method: HydratedMethod, categoryOf?: CategoryResolver): StepSummaryRow[] {
  return method.parsedSteps.map(s => ({
    orderIndex: s.orderIndex,
    kind: s.kind,
    description: s.description ?? "",
    identity: canonicalIdentity(s, categoryOf),
    gates: stepGates(s),
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
  categoryOf?: CategoryResolver,
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
  const exitThen = (code: unknown, message: unknown) =>
    [code != null && code !== "" ? String(code) : "", typeof message === "string" && message ? `"${message}"` : ""].filter(Boolean).join(" ");
  const onFail = step.forceExitFromFailure ? exitThen(step.forceExitStatusCode, step.forceExitErrorMessage) : "";
  config.push({
    key: "Abort on Failure",
    value: step.forceExitFromFailure ? `Yes${onFail ? ` → ${onFail}` : ""}` : "No",
  });
  if (step.forceReturnExpression || step.forceReturnRows) {
    const then = exitThen(step.forceReturnStatusCode, step.forceReturnMessage);
    config.push({ key: "Exit If", value: `${step.forceReturnExpression ?? "(basic rows)"}${then ? ` → ${then}` : ""}` });
  }
  if (step.account && (step.account.name || step.account.id != null)) {
    config.push({ key: "Account", value: [step.account.name, step.account.id != null ? `#${step.account.id}` : ""].filter(Boolean).join(" ") });
  }

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
    identity: canonicalIdentity(step, categoryOf),
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
  // Every kind's bound inputs (D1), minus the body slot shown as sql / source / expression.
  const inputs = inputPairs(step, labelFor);
  if (inputs.length > 0) base.inputs = inputs;
  if (step.forceReturnExpression || step.forceReturnRows) {
    base.exitIf = {
      mode: step.forceReturnMode,
      expression: step.forceReturnExpression,
      ...(step.forceReturnRows ? { rows: step.forceReturnRows } : {}),
      statusCode: step.forceReturnStatusCode,
      message: step.forceReturnMessage,
    };
  }
  if (step.forceExitFromFailure) {
    base.exitOnFailure = { statusCode: step.forceExitStatusCode, message: step.forceExitErrorMessage || undefined };
  }
  if (step.account) base.account = step.account;
  if (step.repeatStepExecution) {
    base.loop = {
      source: step.loopExecutionSource,
      parallel: step.loopConfiguration?.executeParallel,
      type: step.loopConfiguration?.type,
      counter: step.loopConfiguration?.counter,
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
      const callee = calleeReference(step, method.sourceVersion);
      if (callee) base.callee = callee;
      return base;
    }
    case "UNKNOWN": {
      const s = step as UnknownStep;
      base.reason = s.reason;
      return base;
    }
  }
}

function valueText(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Inputs with their default and (V1) test value, kept apart (D27). */
export function mapInputFields(fields: MethodField[]): NonNullable<ShowMethodData["inputs"]> {
  return fields.map(f => ({
    code: f.code,
    type: String(f.type ?? ""),
    required: !!f.required,
    description: f.description ?? "",
    defaultValue: defaultText(f),
    testValue: valueText(f.testValue),
  }));
}

/** Variables with their default (starting) value (D27). */
export function mapVariableFields(fields: MethodField[]): NonNullable<ShowMethodData["variables"]> {
  return fields.map(f => ({
    code: f.code,
    type: String(f.type ?? ""),
    description: f.description ?? "",
    defaultValue: defaultText(f),
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
  const unusable = (e: unknown) => new CliError(`Cannot read ${path} as JSON: ${(e as Error).message}`, { code: "INVALID_FILE" });
  const body = readJsonInputSync(path, { unreadable: unusable, invalid: unusable });
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


function looksLikeFile(input: string): boolean {
  try {
    return existsSync(input) && statSync(input).isFile();
  } catch {
    return false;
  }
}

export const args = defineArgs({
  command: "wi-impl ad show",
  positionals: [
    { name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." },
  ],
  flags: {
    ...AD_V2_FLAG,
    code: { type: "boolean" },
    sql: { type: "boolean" },
    outputs: { type: "boolean" },
    variables: { type: "boolean" },
    inputs: { type: "boolean" },
    services: { type: "boolean" },
    full: { type: "boolean" },
    force: { type: "boolean" },
    raw: { type: "boolean" },
    // `--service-detail N` is the documented spelling; `--step N` the original one.
    step: { type: "number", integer: true, min: 1, alias: ["--service-detail"] },
    open: { type: "boolean", alias: ["-o"] },
    compact: { type: "boolean" },
    story: { type: "boolean" },
    version: { type: "number", integer: true, min: 1 },
  },
  exclusive: [["compact", "story"], ["story", "raw"], ["compact", "raw"], ["version", "force"]],
});

/**
 * Human "Service Chain" rows: the AD UI's rich-text step descriptions as plain
 * text cut to 100 chars (raw `<ul><li>` / `&lt;` would otherwise fill the cells).
 * The `--llm` data keeps the description as stored.
 */
export function stepTableRows(steps: Array<{ orderIndex: number; kind: ParsedStep["kind"]; description?: string; identity?: string; gates?: string[] }>): Array<Array<string | number>> {
  return steps.map(s => [s.orderIndex, `[${badgeForKind(s.kind)}]`, abbreviate(htmlToText(s.description ?? ""), 100), s.identity ?? "", (s.gates ?? []).join("; ")]);
}

const command: CommandModule<ShowMethodArgs, ShowData> = {
  parseArgs(argv) {
    const { positionals, flags: f } = args.parse(argv);
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
      version: f.version ?? null,
    };
    if (flags.version !== null && target.kind === "file") {
      throw new CliError("--version needs a method uuid, not a file.", { code: "INVALID_ARGUMENT" });
    }
    return { target, flags, apiVersion: apiVersionOf(f) };
  },
  async execute({ target, flags, apiVersion }, context) {
    let method: HydratedMethod;
    let source: ShowMethodData["source"];
    let cacheInfo: CacheInfo | undefined;
    let history: HistoryInfo | undefined;
    if (target.kind === "file") {
      if (flags.open) throw new CliError("--open needs a method uuid, not a file.", { code: "INVALID_ARGUMENT" });
      method = parseMethodFile(target.path);
      source = "file";
    } else if (flags.version !== null) {
      // D31: an older version, through the chain's history (the side follows the uuid's state).
      const current = await fetchMethodChecked(target.uuid, "v1");
      const full = await getVersionOf(current, current.category?.name ?? "", flags.version);
      method = {
        ...parseVersionBody(full),
        uuid: current.uuid,
        referenceId: current.referenceId,
        state: current.state,
        category: current.category,
        version: full.methodVersion,
      };
      source = "history";
      history = {
        version: full.methodVersion,
        side: sideOf(current),
        versionUUID: full.methodVersionID || undefined,
        isPublished: full.isPublished,
        addedBy: full.addedBy,
        addedWhen: full.addedWhen,
      };
    } else if (flags.compact || flags.story) {
      // the agent views read V2, whose input paths (`body.json`) and
      // output keys (`key→fieldCode`) are what `ad save` ops / `create --spec`
      // take. V1 names inputs by UI label and drops the service output key.
      source = "fresh";
      method = await fetchViewMethod(target.uuid, context.warn.bind(context));
    } else {
      const uuid = target.uuid;
      const cached = await CacheManager.loadSwr(uuid);
      let m = cached?.data ?? null;
      source = cached?.stale ? "stale" : "cache";

      // A cached copy is only served when the server still has its version (D2):
      // one cheap V1 read (no definition lookups) checks it.
      if (m && cached && !flags.force && flags.step === null && apiVersion === "v1" && m.sourceVersion === "v1") {
        await assertNotKnownDeleted(uuid); // a cached copy of a method seen deleted since
        const ageMinutes = Math.round(Math.max(0, Date.now() - cached.savedAt) / 60000);
        cacheInfo = { savedAt: new Date(cached.savedAt).toISOString(), ageMinutes, version: m.version };
        const probe = await adApi.fetchRawMethod(uuid, "v1").catch(() => null);
        const serverVersion = probe && typeof (probe as { version?: unknown }).version === "number" ? (probe as { version: number }).version : undefined;
        if (serverVersion !== undefined) cacheInfo.serverVersion = serverVersion;
        if (serverVersion !== undefined && serverVersion !== m.version) {
          context.warn(`Cached copy was v${m.version} (${ageMinutes} min old); the server has v${serverVersion} — read fresh.`);
          m = null;
          cacheInfo = undefined;
        } else if (serverVersion === undefined) {
          context.warn(`Using a cached copy (v${m.version}, ${ageMinutes} min old) whose version could not be checked. Use --force for a fresh read.`);
        }
      }

      // Cache is V1-shaped; --v2, --force and --step N read fresh.
      if (!m || flags.force || flags.step !== null || apiVersion === "v2" || m.sourceVersion !== apiVersion) {
        source = "fresh";
        // V1 serves soft-deleted methods: fetchMethodChecked reads V2 beside it.
        m = await fetchMethodChecked(uuid, apiVersion);
        // A degraded parse (a definition lookup failed) is not cached.
        if (apiVersion === "v1" && !m.unresolvedServices?.length) await CacheManager.save(uuid, m);
      }
      method = m;

      if (source === "stale") {
        // Serve stale data now; refresh the cache in a detached background process.
        context.warn(`Using stale cached definition (v${method.version}) — refreshing in background.`);
        triggerDetachedRefresh(CacheManager.dir, uuid);
      } else if (source === "cache") {
        context.warn(`Using cached method definition (v${method.version}, ${cacheInfo?.ageMinutes ?? "?"} min old). Use --force for refresh.`);
      }
    }
    const categoryOf = target.kind === "uuid" ? await cachedCategoryResolver(currentCacheEnv()) : undefined;

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
      source: source === "file" ? "file" : source === "history" ? "history" : "fresh",
      sourceVersion: method.sourceVersion,
      ...(source === "file" ? {} : { fetchedAt: new Date().toISOString() }),
      ...(history ? { history } : {}),
    };
    if (flags.story) {
      const markdown = storyMarkdown(method, { full: flags.full, categoryOf });
      return ok<ShowData>({ view: "story", ...viewSource, name: method.name, uuid: method.uuid, markdown }, { sourceVersion: method.sourceVersion });
    }

    if (flags.compact) {
      const labels = new Map<number, InputLabeler>();
      for (const s of method.parsedSteps) {
        const l = await v1LabelerFor(method, s);
        if (l) labels.set(s.orderIndex, l);
      }
      // --step N: that step whole (D1, B77); --full: nothing cut.
      const whole = flags.full || flags.step !== null;
      const view = compactMethod(method, {
        labels,
        step: flags.step,
        bodyChars: whole ? 0 : 160,
        valueChars: whole ? 0 : 60,
        descChars: whole ? 0 : 80,
        categoryOf,
        fullBodies: {
          sql: flags.sql || flags.full || flags.step !== null,
          code: flags.code || flags.full || flags.step !== null,
          spel: flags.full || flags.step !== null,
        },
      });
      const lean = pruneEmpty<CompactData>({ view: "compact", ...viewSource, ...view });
      // Asked for → always a list (D5): pruneEmpty drops an empty one.
      if (view.blocks && !lean.blocks) lean.blocks = [];
      return ok<ShowData>(lean, { sourceVersion: method.sourceVersion });
    }

    const includeInputs = flags.inputs || flags.full;
    const includeServices = flags.services || flags.full;
    const includeVariables = flags.variables || flags.full;
    const includeOutputs = flags.outputs || flags.full;
    const bodies = { code: flags.code || flags.full, sql: flags.sql || flags.full };
    // A stepless method (a built-in service) has nothing but its contract to show (D5).
    const stepless = method.parsedSteps.length === 0;

    let stepDetail: StepDetailView | null = null;
    if (flags.step !== null) {
      const match = method.parsedSteps.find(s => s.orderIndex === flags.step)!;
      // A single step's detail always carries its body and bound inputs (the point of asking for it).
      stepDetail = await buildStepDetailView(method, match, { code: true, sql: true }, categoryOf);
    }

    if (aliasDiffers(method.aliasName, method.name)) {
      context.warn(
        `Alias '${method.aliasName}' differs from the name '${method.name}' (a rename keeps the old alias). ` +
          `The alias still reserves that name in the category, and no AD screen or route changes it.`,
      );
    }
    const data: ShowMethodData = {
      source,
      sourceVersion: method.sourceVersion,
      ...(cacheInfo && source !== "fresh" ? { cache: cacheInfo } : {}),
      ...(history ? { history } : {}),
      ...(stepless && target.kind === "uuid" ? { note: "No steps: a built-in service method (no source to show); its contract is `inputs` / `outputs`." } : {}),
      summary: {
        name: method.name,
        alias: method.aliasName,
        aliasDiffers: aliasDiffers(method.aliasName, method.name) || undefined,
        category: categoryName,
        state: method.state,
        version: method.version,
        uuid: method.uuid,
        referenceId: method.referenceId,
        updated: method.updatedOn ? `${formatDate(method.updatedOn)} by ${method.updatedBy ?? "unknown"}` : undefined,
        summary: storedSummaryOf(method),
        methodDescription: method.description,
        inputCount: method.inputs.length,
        variableCount: method.variables.length,
        outputCount: method.outputs.length,
        stepCount: method.parsedSteps.length,
        parseWarnings: method.parseWarnings,
        editUrl,
        deprecated: method.deprecated,
        scope: method.scope,
        timeoutSeconds: method.timeoutSeconds,
      },
      // --step N answers with that step only (D1).
      ...(flags.step === null ? { steps: summariseSteps(method, categoryOf) } : {}),
      stepDetail,
    };

    if (includeInputs || stepless) data.inputs = mapInputFields(method.inputs);
    if (includeVariables) data.variables = mapVariableFields(method.variables);
    if (includeOutputs || stepless) data.outputs = mapOutputFields(method.outputs);

    if (flags.step === null && (includeServices || flags.code || flags.sql)) {
      const details: StepDetailView[] = [];
      for (const step of method.parsedSteps) {
        details.push(await buildStepDetailView(method, step, bodies, categoryOf));
      }
      data.allStepDetails = details;
    }

    const lean = pruneEmpty(data);
    // Always present (pruneEmpty drops ""): "" = no summary stored.
    lean.summary.summary ??= "";
    if (flags.step === null) lean.steps ??= [];
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
      ["Alias", `${summary.alias ?? ""}${summary.aliasDiffers ? " (differs from the name)" : ""}`],
      ["Category", summary.category],
      ["State", summary.state],
      ["Version", summary.version],
      [summary.state === "PUBLISHED" ? "Published ID" : "Draft ID", summary.uuid],
      [summary.state === "PUBLISHED" ? "Draft ID" : "Published ID", summary.referenceId ?? ""],
      ["Updated", summary.updated ?? "N/A"],
      ["Summary", summary.summary ?? ""],
      ["Description", summary.methodDescription ?? ""],
      ["Inputs", summary.inputCount],
      ["Variables", summary.variableCount],
      ["Outputs", summary.outputCount],
      ["Steps", summary.stepCount],
      ["API Source", data.sourceVersion.toUpperCase()],
      ["Cache", (data.source === "stale" ? "stale (refreshing…)" : data.source) + (data.cache ? ` (v${data.cache.version}, ${data.cache.ageMinutes} min old${data.cache.serverVersion !== undefined ? `, server v${data.cache.serverVersion}` : ""})` : "")],
    ];
    if (summary.deprecated) rows.push(["Deprecated", "Yes"]);
    if (summary.scope) rows.push(["Scope", summary.scope]);
    if (summary.timeoutSeconds != null) rows.push(["Timeout", `${summary.timeoutSeconds}s`]);
    if (summary.editUrl) rows.push(["Edit URL", summary.editUrl]);
    ui.table(["Property", "Value"], rows);

    if (summary.parseWarnings?.length) {
      ui.section("Parse Warnings");
      for (const w of summary.parseWarnings) ui.warn(w);
    }

    if (data.note) ui.info(data.note);
    // Compact step listing with kind badges (absent with --step N: that step only).
    if (data.steps) {
      ui.section("Service Chain");
      if (data.steps.length === 0) {
        ui.text("No steps defined.");
      } else {
        ui.table(
          ["#", "Kind", "Description", "Identity", "Gates"],
          stepTableRows(data.steps),
        );
      }
    }

    // Empty lists are pruned from the payload: a missing section = none / not asked for.
    if (data.inputs) {
      ui.section("Inputs");
      ui.table(
        ["Field", "Type", "Required", "Default", "Test value", "Description"],
        data.inputs.map(i => [i.code, i.type ?? "", i.required ? "Yes" : "No", i.defaultValue ?? "", i.testValue ?? "", i.description ?? ""]),
      );
    }

    if (data.variables) {
      ui.section("Variables");
      ui.table(
        ["Field", "Type", "Default", "Description"],
        data.variables.map(v => [v.code, v.type ?? "", v.defaultValue ?? "", v.description ?? ""]),
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
      if (detail.callee) {
        const c = detail.callee;
        const parts = [
          c.apiUuid ? `API uuid ${c.apiUuid}` : "",
          c.apiNumericId != null ? `numeric API id ${c.apiNumericId}` : "",
          c.automationId != null ? `automation record ${c.automationId}` : "",
          c.categoryName ? `category ${c.categoryName}` : "",
          c.serviceName || c.methodName ? `name ${c.serviceName ?? ""}.${c.methodName ?? ""}` : "",
        ].filter(Boolean);
        ui.kv(`Callee (${c.route} body)`, `${parts.join(", ")}${c.methodNameStored ? "" : " (no method name stored)"}`);
      }
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
      for (const r of detail.exitIf?.rows ?? []) {
        ui.text(`  exit-if ${r.groupOp ? `${r.groupOp} ` : ""}${r.field} ${r.operator} ${r.value ?? "null"}`);
      }
      if (detail.inputs) {
        ui.table(["Input", "Value"], detail.inputs.map(i => [i.input, i.value]));
      }
      if (detail.loop) {
        ui.kv("Loop Source", detail.loop.source ?? "(none)");
        ui.kv("Parallel", detail.loop.parallel ? "Yes" : "No");
        if (detail.loop.type) ui.kv("Loop Type", detail.loop.type);
        if (detail.loop.counter) ui.kv("Loop Counter", detail.loop.counter);
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

/** A non-empty alias other than the name (the V1 parser falls back to the alias when the name is missing). */
function aliasDiffers(alias: string | undefined, name: string): boolean {
  return !!alias && alias !== name;
}

export default command;
