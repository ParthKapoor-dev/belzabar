import { CliError, defineSubcommands, failWithData, ok, type CommandModule, type CommandResult } from "@belzabar/core";
import { adApi, type MethodVersionSummary, type MethodVersionFull } from "../../lib/api/index";
import { AD_COMMON_FLAGS, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { requireConfirmation, logIntent } from "../../lib/args/confirm";
import { diffPaths, fingerprintMethod, fingerprintProjection, parseVersionBody } from "../../lib/fingerprint";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { getVersionOf, sideOf, type HistorySide } from "../../lib/history";
import { resolveMethodRef } from "@belzabar/core/platform";
import type { HydratedMethod } from "../../lib/types/common";
import { CacheManager } from "../../lib/cache";
import * as v2api from "../../lib/api/v2";
import { invalidateCompiledCache, type CompiledCacheResult } from "../../lib/save/compiled-cache";
import { validateMethodV2, type ValidationFinding } from "../../lib/validate/index";
import { compactMethod } from "../../lib/method-view";
import { abbreviate, htmlToText, pruneEmpty } from "../../lib/compact";

type Action = "list" | "show" | "diff" | "restore";

interface HistoryArgs {
  action: Action;
  uuid: string;
  version?: number;
  v1?: number;
  v2num?: number;
  yes: boolean;
  /** show: include the full parsed method (`method`). */
  full?: boolean;
}

interface VersionRow {
  version: number;
  versionUUID: string;
  isPublished: boolean;
  isDeactivated: boolean;
  addedBy: number;
  addedWhen: string;
}


interface HistoryListData {
  action: "list";
  uuid: string;
  side: HistorySide;
  methodName: string;
  category: string;
  totalVersions: number;
  versions: VersionRow[];
}

interface HistoryShowData {
  action: "show";
  uuid: string;
  side: HistorySide;
  version: number;
  versionUUID: string;
  methodName: string;
  category: string;
  isPublished: boolean;
  addedBy: number;
  addedWhen: string;
  stepCount: number;
  inputCount: number;
  /** 7.9: the version as a compact view (`in`/`out`/`vars` + one line per step, see `ad show --compact`). */
  in?: string;
  out?: string;
  vars?: string;
  steps: string[];
  /** The full parsed method — only with --full. */
  method?: HydratedMethod;
}

interface DiffStepRow {
  orderIndex: number;
  kind: string;
  v1Desc: string;
  v2Desc: string;
  changed: boolean;
  detail?: string;
}

/** Width a diff description cell is cut to in human mode. */
const DIFF_CELL_MAX = 60;

/**
 * Human `history diff` table rows (F36): the AD UI's rich-text descriptions
 * become plain text cut to DIFF_CELL_MAX, so the table fits a terminal. The
 * `--llm` data keeps the full descriptions.
 */
export function diffTableRows(steps: DiffStepRow[], max = DIFF_CELL_MAX): Array<Array<string | number>> {
  const cell = (t: string) => abbreviate(htmlToText(t), max);
  return steps.map(s => [s.orderIndex, s.kind, s.changed ? "YES" : "", cell(s.v1Desc), cell(s.v2Desc), cell(s.detail ?? "")]);
}

interface HistoryDiffData {
  action: "diff";
  uuid: string;
  side: HistorySide;
  v1: number;
  v2: number;
  v1StepCount: number;
  v2StepCount: number;
  v1InputCount: number;
  v2InputCount: number;
  steps: DiffStepRow[];
  inputChanges: string[];
}

interface HistoryRestoreData {
  action: "restore";
  /** The draft that was restored (resolved through the draft guard). */
  uuid: string;
  /** The uuid the caller passed. */
  inputUuid: string;
  version: number;
  success: boolean;
  /** Platform answer: true / false / null when the response shape was not recognised. */
  platformResponse: boolean | null;
  previousVersion: number | null;
  /** Draft version after the restore (the platform saves the restored body as a new version). */
  resultingVersion: number | null;
  /** Whether the re-fetched draft's logic fingerprint equals the target version's. */
  contentMatches: boolean | null;
  /** When contentMatches is false: up to 10 projection paths that differ (see fingerprintProjection). */
  contentDiff?: string[];
  /** Compiled-chain cache eviction for the draft (both routes). */
  compiledCache: CompiledCacheResult;
  /** Validator findings on the restored body (the restore already happened: reported, not blocking). */
  validation: { errors: ValidationFinding[]; warnings: ValidationFinding[] } | null;
}

type HistoryData = HistoryListData | HistoryShowData | HistoryDiffData | HistoryRestoreData;

const UUID_ARG = [
  { name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing <uuid> argument." },
] as const;
const VERSION_FLAG = {
  type: "number",
  integer: true,
  min: 1,
  required: true,
  missingCode: "MISSING_VERSION",
  missingMessage: "--version <N> is required.",
} as const;

export const args = defineSubcommands(
  {
    list: { positionals: UUID_ARG, flags: { ...AD_COMMON_FLAGS } },
    show: { positionals: UUID_ARG, flags: { ...AD_COMMON_FLAGS, version: VERSION_FLAG, full: { type: "boolean" } } },
    diff: {
      positionals: UUID_ARG,
      flags: {
        ...AD_COMMON_FLAGS,
        from: { ...VERSION_FLAG, missingMessage: "--from <N> and --to <M> are required for 'history diff'." },
        to: { ...VERSION_FLAG, missingMessage: "--from <N> and --to <M> are required for 'history diff'." },
      },
    },
    restore: { positionals: UUID_ARG, flags: { ...AD_COMMON_FLAGS, ...AD_YES_FLAG, version: VERSION_FLAG } },
  },
  {
    command: "belz ad history",
    codes: { UNKNOWN_SUBCOMMAND: "INVALID_ACTION", MISSING_SUBCOMMAND: "INVALID_ACTION" },
    missingMessage:
      "Usage: belz ad history <list|show|diff|restore> <uuid> [flags]\n\n" +
      "  list <uuid>                     List all saved versions\n" +
      "  show <uuid> --version N         Fetch + parse a specific version\n" +
      "  diff <uuid> --from N --to M     Compare two versions side by side\n" +
      "  restore <uuid> --version N      Revert to a previous version",
  },
);

const command: CommandModule<HistoryArgs, HistoryData> = {
  schema: "ad.history",
  writes: (a) => a.action === "restore",
  parseArgs(argv) {
    const parsed = args.parse(argv);
    resolveAdCommon(parsed.flags, "list", "history"); // history is V1-only: --v2 prints the fallback notice
    const base = { action: parsed.subcommand, uuid: parsed.positionals.uuid };
    switch (parsed.subcommand) {
      case "list":
        return { ...base, yes: false };
      case "show":
        return { ...base, version: parsed.flags.version, yes: false, ...(parsed.flags.full ? { full: true } : {}) };
      case "diff":
        return { ...base, v1: parsed.flags.from, v2num: parsed.flags.to, yes: false };
      case "restore":
        return { ...base, version: parsed.flags.version, yes: parsed.flags.yes };
    }
  },

  async execute(rawArgs, context) {
    const args = { ...rawArgs, uuid: resolveMethodRef(rawArgs.uuid) };
    // restore resolves its own target through the draft guard (one fetch).
    if (args.action === "restore") return executeRestore(args, context);

    // history.get needs the method's category name and method name.
    const current = await adApi.fetchMethod(args.uuid, "v1");
    const category = current.category?.name ?? "";
    const methodName = current.name;

    switch (args.action) {
      case "list":
        return executeList(args, current, category);
      case "show":
        return executeShow(args, current, category, methodName);
      case "diff":
        return executeDiff(args, current, category, methodName);
    }
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as HistoryData;

    switch (data.action) {
      case "list": {
        ui.section(`Version History (${data.side.toLowerCase()} chain): ${data.methodName} (${data.totalVersions} versions)`);
        if (data.versions.length === 0) {
          ui.text("No version history available for this method.");
        } else {
          ui.table(
            ["Version", "Version UUID", "Published", "Deactivated", "By", "When"],
            data.versions.map(v => [
              v.version,
              v.versionUUID.slice(0, 16) + "...",
              v.isPublished ? "Yes" : "No",
              v.isDeactivated ? "Yes" : "No",
              v.addedBy,
              v.addedWhen,
            ]),
          );
        }
        break;
      }

      case "show": {
        ui.section(`Version ${data.version} of ${data.methodName} (${data.side.toLowerCase()} chain)`);
        ui.table(
          ["Property", "Value"],
          [
            ["Version UUID", data.versionUUID],
            ["Version", data.version],
            ["Published", data.isPublished ? "Yes" : "No"],
            ["Added By", data.addedBy],
            ["Added When", data.addedWhen],
            ["Steps", data.stepCount],
            ["Inputs", data.inputCount],
          ],
        );
        ui.section("Steps at this version");
        if (data.steps.length === 0) {
          ui.text("(no steps — likely the initial creation)");
        } else if (!data.method) {
          if (data.in) ui.text(`in: ${data.in}`);
          if (data.out) ui.text(`out: ${data.out}`);
          if (data.vars) ui.text(`vars: ${data.vars}`);
          ui.text(data.steps.join("\n"));
        } else {
          const badgeMap: Record<string, string> = {
            CUSTOM_CODE: "CODE", SPEL_ECHO: "SPEL", SQL: "SQL",
            REDIS_GET: "REDIS-GET", REDIS_SET: "REDIS-SET", REDIS_REMOVE: "REDIS-REMOVE",
            EXISTING_SERVICE: "EXISTING", UNKNOWN: "UNKNOWN",
          };
          ui.table(
            ["#", "Kind", "Description"],
            data.method.parsedSteps.map(s => [
              s.orderIndex,
              `[${badgeMap[s.kind] ?? s.kind}]`,
              s.description ?? "",
            ]),
          );
        }
        break;
      }

      case "diff": {
        ui.section(`Diff: v${data.v1} → v${data.v2}`);
        ui.table(
          ["", "v" + data.v1, "v" + data.v2],
          [
            ["Steps", data.v1StepCount, data.v2StepCount],
            ["Inputs", data.v1InputCount, data.v2InputCount],
          ],
        );

        if (data.inputChanges.length > 0) {
          ui.section("Input Changes");
          for (const change of data.inputChanges) ui.text("  " + change);
        }

        if (data.steps.length > 0) {
          ui.section("Step-by-step");
          ui.table(
            ["#", "Kind", "Changed", "v" + data.v1, "v" + data.v2, "Detail"],
            diffTableRows(data.steps),
          );
        }
        break;
      }

      case "restore": {
        if (data.success) {
          ui.success(
            `Restored draft ${data.uuid} to the content of version ${data.version}` +
              (data.resultingVersion != null ? ` (now v${data.resultingVersion}).` : "."),
          );
        } else {
          ui.warn(`Restore to version ${data.version} was not confirmed — check the method in the UI.`);
        }
        break;
      }
    }
  },
};

// ─── sub-action implementations ──────────────────────────────────────────

async function executeList(
  args: HistoryArgs,
  current: HydratedMethod,
  category: string,
): Promise<CommandResult<HistoryListData>> {
  const versions = await adApi.historyListAll(args.uuid, { includeDraft: true });
  const rows: VersionRow[] = versions.map(v => ({
    version: v.methodVersion,
    versionUUID: v.methodVersionID,
    isPublished: v.isPublished,
    isDeactivated: v.isDeactivated,
    addedBy: v.addedBy,
    addedWhen: v.addedWhen,
  }));
  rows.sort((a, b) => a.version - b.version);

  return ok<HistoryListData>({
    action: "list",
    uuid: args.uuid,
    side: sideOf(current),
    methodName: current.name,
    category,
    totalVersions: rows.length,
    versions: rows,
  });
}

async function executeShow(
  args: HistoryArgs,
  current: HydratedMethod,
  category: string,
  methodName: string,
): Promise<CommandResult<HistoryShowData>> {
  if (args.version == null || Number.isNaN(args.version)) {
    throw new CliError("--version <N> is required for 'history show'.", { code: "MISSING_VERSION" });
  }

  const full = await getVersionOf(current, category, args.version);
  const parsed = parseVersionBody(full);
  const view = compactMethod(parsed);

  const data = pruneEmpty<HistoryShowData>({
    action: "show",
    uuid: args.uuid,
    side: sideOf(current),
    version: full.methodVersion,
    versionUUID: full.methodVersionID,
    methodName,
    category,
    isPublished: full.isPublished,
    addedBy: full.addedBy,
    addedWhen: full.addedWhen,
    stepCount: parsed.parsedSteps.length,
    inputCount: parsed.inputs.length,
    in: view.in,
    out: view.out,
    vars: view.vars,
    steps: view.steps,
  });
  if (!data.steps) data.steps = [];
  // The full parse is kept verbatim (not pruned) and only on request.
  if (args.full) data.method = parsed;
  return ok<HistoryShowData>(data);
}

async function executeDiff(
  args: HistoryArgs,
  current: HydratedMethod,
  category: string,
  _methodName: string,
): Promise<CommandResult<HistoryDiffData>> {
  if (args.v1 == null || args.v2num == null) {
    throw new CliError("--from <N> and --to <M> are required for 'history diff'.", { code: "MISSING_VERSION" });
  }

  const [fullV1, fullV2] = await Promise.all([
    getVersionOf(current, category, args.v1),
    getVersionOf(current, category, args.v2num),
  ]);

  const parsedV1 = parseVersionBody(fullV1);
  const parsedV2 = parseVersionBody(fullV2);

  // Build step diff
  const maxSteps = Math.max(parsedV1.parsedSteps.length, parsedV2.parsedSteps.length);
  const steps: DiffStepRow[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const s1 = parsedV1.parsedSteps[i];
    const s2 = parsedV2.parsedSteps[i];
    const v1Desc = s1 ? `[${s1.kind}] ${s1.description ?? ""}` : "(absent)";
    const v2Desc = s2 ? `[${s2.kind}] ${s2.description ?? ""}` : "(absent)";
    let changed = false;
    let detail: string | undefined;

    if (!s1 || !s2) {
      changed = true;
      detail = !s1 ? "Added" : "Removed";
    } else if (s1.kind !== s2.kind) {
      changed = true;
      detail = `Kind changed: ${s1.kind} → ${s2.kind}`;
    } else if (JSON.stringify(s1.raw) !== JSON.stringify(s2.raw)) {
      changed = true;
      if (s1.kind === "CUSTOM_CODE" && s2.kind === "CUSTOM_CODE") {
        detail = "Source changed";
      } else if (s1.kind === "SQL" && s2.kind === "SQL") {
        detail = "SQL changed";
      } else if (s1.kind === "SPEL_ECHO" && s2.kind === "SPEL_ECHO") {
        detail = "Expression changed";
      } else {
        detail = "Step body changed";
      }
    }

    steps.push({
      orderIndex: (s1 ?? s2)!.orderIndex,
      kind: (s2 ?? s1)!.kind,
      v1Desc,
      v2Desc,
      changed,
      detail,
    });
  }

  // Build input diff
  const inputChanges: string[] = [];
  const v1Inputs = new Map(parsedV1.inputs.map(i => [i.code, i]));
  const v2Inputs = new Map(parsedV2.inputs.map(i => [i.code, i]));
  for (const [code, inp] of v2Inputs) {
    if (!v1Inputs.has(code)) inputChanges.push(`+ Added input: ${code} (${inp.type})`);
  }
  for (const [code, inp] of v1Inputs) {
    if (!v2Inputs.has(code)) inputChanges.push(`- Removed input: ${code} (${inp.type})`);
  }

  return ok<HistoryDiffData>({
    action: "diff",
    uuid: args.uuid,
    side: sideOf(current),
    v1: args.v1,
    v2: args.v2num,
    v1StepCount: parsedV1.parsedSteps.length,
    v2StepCount: parsedV2.parsedSteps.length,
    v1InputCount: parsedV1.inputs.length,
    v2InputCount: parsedV2.inputs.length,
    steps,
    inputChanges,
  });
}

async function executeRestore(
  args: HistoryArgs,
  context: { outputMode: "human" | "llm"; env: { name: string }; warn: (message: string) => void },
): Promise<CommandResult<HistoryRestoreData>> {
  if (args.version == null || Number.isNaN(args.version)) {
    throw new CliError("--version <N> is required for 'history restore'.", { code: "MISSING_VERSION" });
  }

  // AD-23: a restore is a write — it must land on the DRAFT, never the published chain.
  const guard = await resolveDraftTarget(args.uuid, "v1");
  if (!guard.ok) {
    throw new CliError(guard.message, {
      code: `AD_DRAFT_GUARD_${guard.reason}`,
      details: { uuid: args.uuid, publishedUuid: guard.publishedUuid },
    });
  }
  if (guard.switchedFromPublished) {
    // Version numbers are per chain (F7): the N the caller saw for the
    // published uuid is not the draft's N. Refuse instead of guessing.
    throw new CliError(
      `${args.uuid} is the PUBLISHED chain; its history versions differ from the draft's. ` +
        `Restore works on the draft: pick a version from 'belz ad history list ${guard.draft.uuid}' ` +
        `and run 'belz ad history restore ${guard.draft.uuid} --version <N>'.`,
      { code: "HISTORY_RESTORE_NEEDS_DRAFT", details: { publishedUuid: args.uuid, draftUuid: guard.draft.uuid } },
    );
  }
  const draft = guard.draft;
  const category = draft.category?.name ?? "";
  const methodName = draft.name;

  // The target must exist on the draft's history before we write anything.
  const target = await getVersionOf(draft, category, args.version);
  const targetMethod = parseVersionBody(target);
  const targetIsV2 = isV2Body(target.jsonDefinition);

  await requireConfirmation({
    yes: args.yes,
    outputMode: context.outputMode,
    action: `restore draft "${methodName}" to version ${args.version}`,
    details: [
      ["Method", methodName],
      ["Category", category],
      ["Draft UUID", draft.uuid],
      ["Target version", `${args.version} (${target.addedWhen})`],
      ["Current version", String(draft.version)],
    ],
  });

  logIntent("POST", "Expertly.Automation.Method.History.restore (via execute)", {
    uuid: draft.uuid,
    category,
    methodName,
    version: args.version,
  });

  let platformResponse: boolean | null;
  let compiledCache: CompiledCacheResult = { ok: false, uuids: [], routes: [] };
  try {
    platformResponse = await adApi.historyRestore({
      category,
      methodName,
      version: args.version,
      includeDraft: true,
    });
  } finally {
    for (const id of new Set([args.uuid, draft.uuid, draft.referenceId])) await CacheManager.invalidate(id);
    // ADW-R8: like save/publish/delete — otherwise `ad test` keeps running the old compiled body.
    compiledCache = await invalidateCompiledCache([draft.uuid]);
  }
  if (!compiledCache.ok) {
    context.warn(
      `Compiled-cache eviction failed on every route; tests may run the previous body. Retry with: belz cache ${draft.uuid} --env ${context.env.name} --yes`,
    );
  }

  // Re-fetch and verify: report the resulting version and whether the draft
  // now carries the target version's logic.
  let resultingVersion: number | null = null;
  let contentMatches: boolean | null = null;
  let contentDiff: string[] | undefined;
  try {
    const after = await adApi.fetchMethod(draft.uuid, targetIsV2 ? "v2" : "v1");
    resultingVersion = typeof after.version === "number" ? after.version : null;
    // Same normalised projection as trace/state (ADW-R8): the V2 GET and the
    // history body differ in display-only fields (fieldCode, service spelling).
    contentMatches = fingerprintMethod(after) === fingerprintMethod(targetMethod);
    if (!contentMatches) contentDiff = diffPaths(fingerprintProjection(after), fingerprintProjection(targetMethod), 10);
  } catch {
    // leave as null — reported below
  }

  // The restored body skipped the validator: report its findings (not blocking — it is already saved).
  let validation: HistoryRestoreData["validation"] = null;
  try {
    const r = validateMethodV2({ after: await v2api.fetchRawMethod(draft.uuid) });
    validation = { errors: r.errors, warnings: r.warnings };
    for (const f of r.errors) context.warn(`Restored body: ${f.rule} ${f.path}: ${f.message}`);
  } catch {
    // unreadable: contentMatches already says whether the restore is verified
  }

  const previousVersion = typeof draft.version === "number" ? draft.version : null;
  // ADW-R8: success means the re-fetched draft verifiably carries the target
  // content. The restore is addressed by category + name, so a `true` answer
  // alone does not prove the right chain/version was restored.
  const success = platformResponse !== false && contentMatches === true;
  const data: HistoryRestoreData = {
    action: "restore",
    uuid: draft.uuid,
    inputUuid: args.uuid,
    version: args.version,
    success,
    platformResponse,
    previousVersion,
    resultingVersion,
    contentMatches,
    ...(contentDiff ? { contentDiff } : {}),
    compiledCache,
    validation,
  };
  // The platform answers `false` when it did not restore: that is a failed
  // operation, so the envelope must be ok:false (exit 1), not ok:true.
  if (platformResponse === false) {
    return failWithData("RESTORE_FAILED", `Restore of "${methodName}" to version ${args.version} returned false.`, data);
  }
  // Fail closed (AD-23, ADW-R8): whatever the platform answered, the restore
  // is only a success when the re-fetched draft matches the target content.
  if (!success) {
    return failWithData(
      "RESTORE_UNCONFIRMED",
      contentMatches === false
        ? `Restore of "${methodName}" to version ${args.version} answered ${platformResponse === true ? "true" : "with an unrecognised response"}, but the draft does not carry version ${args.version}'s content. Check the method (belz ad history diff) before retrying.`
        : `Restore of "${methodName}" to version ${args.version} could not be verified (the draft could not be re-read). Check the method before retrying.`,
      data,
    );
  }
  return ok(data);
}

function isV2Body(jd: unknown): boolean {
  if (!jd || typeof jd !== "object" || Array.isArray(jd)) return false;
  const o = jd as Record<string, unknown>;
  return !!(o.metadata || o.steps);
}

export default command;
