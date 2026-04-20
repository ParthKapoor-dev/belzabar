import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi, type MethodVersionSummary, type MethodVersionFull } from "../../lib/api/index";
import { parseV1Method, parseV2Method } from "../../lib/parser/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";
import { requireConfirmation, logIntent } from "../../lib/args/confirm";
import type { HydratedMethod } from "../../lib/types/common";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

type Action = "list" | "show" | "diff" | "restore";

interface HistoryArgs {
  action: Action;
  uuid: string;
  version?: number;
  v1?: number;
  v2num?: number;
  yes: boolean;
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
  methodName: string;
  category: string;
  totalVersions: number;
  versions: VersionRow[];
}

interface HistoryShowData {
  action: "show";
  uuid: string;
  version: number;
  versionUUID: string;
  methodName: string;
  category: string;
  isPublished: boolean;
  addedBy: number;
  addedWhen: string;
  stepCount: number;
  inputCount: number;
  method: HydratedMethod;
}

interface DiffStepRow {
  orderIndex: number;
  kind: string;
  v1Desc: string;
  v2Desc: string;
  changed: boolean;
  detail?: string;
}

interface HistoryDiffData {
  action: "diff";
  uuid: string;
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
  uuid: string;
  version: number;
  success: boolean;
}

type HistoryData = HistoryListData | HistoryShowData | HistoryDiffData | HistoryRestoreData;

const command: CommandModule<HistoryArgs, HistoryData> = {
  schema: "ad.history",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "fetch", "history");
    emitFallbackWarning(common, "history");

    const action = rest[0] as Action;
    if (!action || !["list", "show", "diff", "restore"].includes(action)) {
      throw new CliError(
        "Usage: belz ad history <list|show|diff|restore> <uuid> [flags]\n\n" +
          "  list <uuid>                     List all saved versions\n" +
          "  show <uuid> --version N         Fetch + parse a specific version\n" +
          "  diff <uuid> --from N --to M       Compare two versions side by side\n" +
          "  restore <uuid> --version N      Revert to a previous version",
        { code: "INVALID_ACTION" },
      );
    }

    const uuid = rest[1];
    if (!uuid || uuid.startsWith("-")) {
      throw new CliError("Missing <uuid> argument.", { code: "MISSING_UUID" });
    }

    const versionIdx = rest.indexOf("--version");
    const fromIdx = rest.indexOf("--from");
    const toIdx = rest.indexOf("--to");

    return {
      action,
      uuid,
      version: versionIdx !== -1 ? parseInt(rest[versionIdx + 1]!, 10) : undefined,
      v1: fromIdx !== -1 ? parseInt(rest[fromIdx + 1]!, 10) : undefined,
      v2num: toIdx !== -1 ? parseInt(rest[toIdx + 1]!, 10) : undefined,
      yes: rest.includes("--yes"),
    };
  },

  async execute(args, context) {
    // We need the method's category name and method name to call history.get/restore.
    // Fetch the current method first.
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
      case "restore":
        return executeRestore(args, current, category, methodName, context);
    }
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as HistoryData;

    switch (data.action) {
      case "list": {
        ui.section(`Version History: ${data.methodName} (${data.totalVersions} versions)`);
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
        ui.section(`Version ${data.version} of ${data.methodName}`);
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
        if (data.method.parsedSteps.length === 0) {
          ui.text("(no steps — likely the initial creation)");
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
            data.steps.map(s => [
              s.orderIndex,
              s.kind,
              s.changed ? "YES" : "",
              s.v1Desc,
              s.v2Desc,
              s.detail ?? "",
            ]),
          );
        }
        break;
      }

      case "restore": {
        if (data.success) {
          ui.success(`Restored method to version ${data.version}.`);
        } else {
          ui.warn(`Restore to version ${data.version} returned false — check the method state in the UI.`);
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
): Promise<{ ok: true; data: HistoryListData; meta?: Record<string, unknown> }> {
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
): Promise<{ ok: true; data: HistoryShowData; meta?: Record<string, unknown> }> {
  if (args.version == null || Number.isNaN(args.version)) {
    throw new CliError("--version <N> is required for 'history show'.", { code: "MISSING_VERSION" });
  }

  const full = await adApi.historyGet({
    category,
    methodName,
    version: args.version,
    includeDraft: true,
  });

  const parsed = parseVersionBody(full);

  return ok<HistoryShowData>({
    action: "show",
    uuid: args.uuid,
    version: full.methodVersion,
    versionUUID: full.methodVersionID,
    methodName,
    category,
    isPublished: full.isPublished,
    addedBy: full.addedBy,
    addedWhen: full.addedWhen,
    stepCount: parsed.parsedSteps.length,
    inputCount: parsed.inputs.length,
    method: parsed,
  });
}

async function executeDiff(
  args: HistoryArgs,
  current: HydratedMethod,
  category: string,
  methodName: string,
): Promise<{ ok: true; data: HistoryDiffData; meta?: Record<string, unknown> }> {
  if (args.v1 == null || args.v2num == null) {
    throw new CliError("--from <N> and --to <M> are required for 'history diff'.", { code: "MISSING_VERSION" });
  }

  const [fullV1, fullV2] = await Promise.all([
    adApi.historyGet({ category, methodName, version: args.v1, includeDraft: true }),
    adApi.historyGet({ category, methodName, version: args.v2num, includeDraft: true }),
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
  current: HydratedMethod,
  category: string,
  methodName: string,
  context: { outputMode: "human" | "llm" },
): Promise<{ ok: true; data: HistoryRestoreData; meta?: Record<string, unknown> }> {
  if (args.version == null || Number.isNaN(args.version)) {
    throw new CliError("--version <N> is required for 'history restore'.", { code: "MISSING_VERSION" });
  }

  await requireConfirmation({
    yes: args.yes,
    outputMode: context.outputMode,
    action: `restore method "${methodName}" to version ${args.version}`,
    details: [
      ["Method", methodName],
      ["Category", category],
      ["UUID", args.uuid],
      ["Target version", String(args.version)],
      ["Current version", String(current.version)],
    ],
  });

  logIntent("POST", "Expertly.Automation.Method.History.restore (via execute)", {
    category,
    methodName,
    version: args.version,
  });

  const success = await adApi.historyRestore({
    category,
    methodName,
    version: args.version,
    includeDraft: true,
  });

  return ok<HistoryRestoreData>({
    action: "restore",
    uuid: args.uuid,
    version: args.version,
    success,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Parse a version's jsonDefinition into a HydratedMethod.
 *
 * The history.get response carries jsonDefinition as either:
 *   - A V1-style stringified JSON (older versions)
 *   - A V2-style flat JSON object with `metadata`, `steps`, `inputs` at
 *     top level (current versions — the history service returns V2 shape)
 *
 * We detect the shape and dispatch to the appropriate parser.
 */
function parseVersionBody(full: MethodVersionFull): HydratedMethod {
  const jd = full.jsonDefinition;

  // V2 shape: jsonDefinition is an object with `metadata` or `steps`.
  if (jd && typeof jd === "object" && !Array.isArray(jd)) {
    const obj = jd as Record<string, unknown>;
    if (obj.metadata || obj.steps || obj.inputs) {
      return parseV2Method(obj as V2MethodResponse);
    }
    // Might be a V1 inner definition (name, services, inputs) — wrap as V1.
    const innerStr = JSON.stringify(obj);
    const fakeRaw: V1RawMethodResponse = {
      uuid: full.methodID || "",
      referenceId: "",
      aliasName: "",
      automationState: full.isPublished ? "PUBLISHED" : "DRAFT",
      jsonDefinition: innerStr,
      version: full.methodVersion,
    };
    return parseV1Method(fakeRaw);
  }

  // V1 shape: jsonDefinition is a string.
  const jdString = typeof jd === "string" ? jd : "{}";
  const fakeRaw: V1RawMethodResponse = {
    uuid: full.methodID || "",
    referenceId: "",
    aliasName: "",
    automationState: full.isPublished ? "PUBLISHED" : "DRAFT",
    jsonDefinition: jdString,
    version: full.methodVersion,
  };
  return parseV1Method(fakeRaw);
}

export default command;
