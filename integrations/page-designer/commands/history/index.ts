// belz pd history — version history for PD pages.
//
// Subcommands:
//   list <pageId> [--limit N]              → table of {versionId, status, partial, updatedAt, user}
//   show <pageId> --version <vid>          → parse + validate one historical version
//   diff <pageId> --from A --to B          → structural diff between two versions
//   restore <pageId> --version <vid>       → withLock(pageId, () => PUT /pages/revert/<vid>)
//
// List is backed by GET /pages/history?pageId=<id>. Show is backed by
// GET /pages/version/<vid>. Restore is backed by PUT /pages/revert/<vid>.

import { CliError, ok, type CommandModule } from "@belzabar/core";
import { parsePdCommonArgs } from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { parsePage } from "../../lib/parser/index";
import { partitionBySeverity, validateHydrated } from "../../lib/validator/index";
import { withLock } from "../../lib/lock";
import { countNodes, diffPages } from "../../lib/page-diff";
import type { ValidationIssue } from "../../lib/types/common";
import type { RawHistoryEntry } from "../../lib/types/wire";

type Action = "list" | "show" | "diff" | "restore";

interface HistoryArgs {
  action: Action;
  pageId: string;
  version?: number;
  from?: number;
  to?: number;
  limit: number;
  force: boolean;
  yes: boolean;
}

interface VersionRow {
  versionId: number;
  status: string;
  partialUpdate: boolean;
  updatedAt: number;
  updatedAtIso: string;
  updatedBy: number;
  userName: string | null;
}

interface HistoryListData {
  action: "list";
  pageId: string;
  totalVersions: number;
  versions: VersionRow[];
}

interface HistoryShowData {
  action: "show";
  pageId: string;
  versionId: number;
  name: string;
  entityType: "PAGE" | "COMPONENT";
  status: string;
  variableCount: number;
  derivedCount: number;
  httpCount: number;
  nodeCount: number;
  parseWarnings: string[];
  validationIssues: ValidationIssue[];
  errorCount: number;
  warnCount: number;
}

interface HistoryDiffData {
  action: "diff";
  pageId: string;
  from: number;
  to: number;
  variables: { added: string[]; removed: string[]; changed: string[] };
  derived: { added: string[]; removed: string[]; changed: string[] };
  httpRequests: { added: string[]; removed: string[] };
  nodeCountBefore: number;
  nodeCountAfter: number;
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesKindChanged: Array<{ nodeId: string; before: string; after: string }>;
  stylesChanged: boolean;
}

interface HistoryRestoreData {
  action: "restore";
  pageId: string;
  restoredVersionId: number;
  newVersionId: number | null;
}

type HistoryData =
  | HistoryListData
  | HistoryShowData
  | HistoryDiffData
  | HistoryRestoreData;

// -------- helpers --------------------------------------------------------

function parseNum(raw: string | undefined, flag: string): number {
  if (!raw) throw new CliError(`${flag} requires a value.`, { code: "INVALID_FLAG" });
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new CliError(`${flag} must be an integer, got: ${raw}`, { code: "INVALID_FLAG" });
  return n;
}

function toRow(e: RawHistoryEntry): VersionRow {
  return {
    versionId: typeof e.id === "number" ? e.id : Number(e.id),
    status: String(e.status),
    partialUpdate: e.partialUpdate === true,
    updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : 0,
    updatedAtIso: new Date(typeof e.updatedAt === "number" ? e.updatedAt : 0).toISOString(),
    updatedBy: typeof e.updatedBy === "number" ? e.updatedBy : 0,
    userName: typeof e.userName === "string" ? e.userName : null,
  };
}

// -------- command --------------------------------------------------------

const command: CommandModule<HistoryArgs, HistoryData> = {
  schema: "pd.history",

  parseArgs(args) {
    const { common, rest } = parsePdCommonArgs(args);
    const [rawAction, rawPageId, ...tail] = rest;
    if (!rawAction) {
      throw new CliError("Missing action. Expected: list | show | diff | restore", { code: "MISSING_ACTION" });
    }
    const action = rawAction as Action;
    if (!["list", "show", "diff", "restore"].includes(action)) {
      throw new CliError(`Unknown action "${rawAction}". Use: list | show | diff | restore`, { code: "UNKNOWN_ACTION" });
    }
    if (!rawPageId || rawPageId.startsWith("-")) {
      throw new CliError("Missing <pageId>. Provide a PD page or component id.", { code: "MISSING_INPUT" });
    }

    const indexOf = (flag: string): number => tail.indexOf(flag);
    const valueAfter = (flag: string): string | undefined => {
      const i = indexOf(flag);
      return i === -1 ? undefined : tail[i + 1];
    };

    const out: HistoryArgs = {
      action,
      pageId: rawPageId,
      force: common.force,
      yes: common.yes,
      limit: 50,
    };
    const limRaw = valueAfter("--limit");
    if (limRaw) out.limit = parseNum(limRaw, "--limit");

    if (action === "show" || action === "restore") {
      const v = valueAfter("--version");
      if (!v) throw new CliError(`--version <id> is required for "${action}".`, { code: "MISSING_VERSION" });
      out.version = parseNum(v, "--version");
    }
    if (action === "diff") {
      const f = valueAfter("--from");
      const t = valueAfter("--to");
      if (!f || !t) throw new CliError(`--from <A> and --to <B> are required for "diff".`, { code: "MISSING_VERSION_RANGE" });
      out.from = parseNum(f, "--from");
      out.to = parseNum(t, "--to");
    }
    return out;
  },

  async execute(args) {
    if (args.action === "list") {
      const entries = await pdApi.historyList(args.pageId);
      const rows = entries.map(toRow).sort((a, b) => b.versionId - a.versionId);
      const clipped = rows.slice(0, args.limit);
      return ok<HistoryListData>({
        action: "list",
        pageId: args.pageId,
        totalVersions: rows.length,
        versions: clipped,
      });
    }

    if (args.action === "show") {
      const vid = args.version!;
      const raw = await pdApi.historyGet(vid);
      if (!raw) throw new CliError(`Version ${vid} not found.`, { code: "PD_VERSION_NOT_FOUND" });
      const page = parsePage(raw);
      const issues = validateHydrated(page);
      const { errors, warnings } = partitionBySeverity(issues);
      return ok<HistoryShowData>({
        action: "show",
        pageId: args.pageId,
        versionId: vid,
        name: page.name,
        entityType: page.entityType,
        status: page.status,
        variableCount: page.variables.length,
        derivedCount: page.derived.length,
        httpCount: page.httpRequests.length,
        nodeCount: countNodes(page),
        parseWarnings: page.parseWarnings,
        validationIssues: issues,
        errorCount: errors.length,
        warnCount: warnings.length,
      });
    }

    if (args.action === "diff") {
      const [rawA, rawB] = await Promise.all([
        pdApi.historyGet(args.from!),
        pdApi.historyGet(args.to!),
      ]);
      if (!rawA) throw new CliError(`Version ${args.from} not found.`, { code: "PD_VERSION_NOT_FOUND" });
      if (!rawB) throw new CliError(`Version ${args.to} not found.`, { code: "PD_VERSION_NOT_FOUND" });
      const a = parsePage(rawA);
      const b = parsePage(rawB);
      const diff = diffPages(a, b);

      return ok<HistoryDiffData>({
        action: "diff",
        pageId: args.pageId,
        from: args.from!,
        to: args.to!,
        variables: diff.variables,
        derived: diff.derived,
        httpRequests: diff.httpRequests,
        nodeCountBefore: diff.nodeCountBefore,
        nodeCountAfter: diff.nodeCountAfter,
        nodesAdded: diff.nodesAdded,
        nodesRemoved: diff.nodesRemoved,
        nodesKindChanged: diff.nodesKindChanged,
        stylesChanged: diff.styles.changed,
      });
    }

    // restore
    if (!args.yes) {
      throw new CliError(
        `"restore" is a write operation. Pass --yes to confirm reverting page ${args.pageId} to version ${args.version}.`,
        { code: "CONFIRMATION_REQUIRED" },
      );
    }
    const before = await pdApi.fetchPage(args.pageId);
    await withLock(args.pageId, async () => {
      await pdApi.historyRestore(args.version!);
    });
    const after = await pdApi.fetchPage(args.pageId);
    const newVersionId =
      after && typeof after.versionId === "number" && after.versionId !== (before?.versionId ?? null)
        ? after.versionId
        : null;

    return ok<HistoryRestoreData>({
      action: "restore",
      pageId: args.pageId,
      restoredVersionId: args.version!,
      newVersionId,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as HistoryData;

    if (data.action === "list") {
      ui.kv("Page", data.pageId);
      ui.kv("Total versions", data.totalVersions);
      if (data.versions.length === 0) {
        ui.info("No version history yet. PD records one entry per save; brand-new pages show empty until their first update.");
        return;
      }
      ui.table(
        ["Version", "Status", "Partial", "Updated At", "User"],
        data.versions.map((v) => [
          v.versionId,
          v.status,
          v.partialUpdate ? "yes" : "no",
          v.updatedAtIso,
          v.userName ?? String(v.updatedBy),
        ]),
      );
      return;
    }

    if (data.action === "show") {
      ui.table(
        ["Property", "Value"],
        [
          ["Page", data.pageId],
          ["Version", data.versionId],
          ["Name", data.name],
          ["Entity Type", data.entityType],
          ["Status", data.status],
          ["Variables", data.variableCount],
          ["Derived", data.derivedCount],
          ["HTTP Calls", data.httpCount],
          ["Nodes", data.nodeCount],
          ["Errors", data.errorCount],
          ["Warnings", data.warnCount],
        ],
      );
      if (data.parseWarnings.length > 0) {
        ui.section("Parse Warnings");
        for (const w of data.parseWarnings) ui.text(`⚠ ${w}`);
      }
      if (data.validationIssues.length > 0) {
        ui.section("Validator Issues");
        ui.table(
          ["Sev", "Code", "Message"],
          data.validationIssues.map((i) => [i.severity.toUpperCase(), i.code, i.message]),
        );
      }
      return;
    }

    if (data.action === "diff") {
      ui.kv("Page", data.pageId);
      ui.kv("From", data.from);
      ui.kv("To", data.to);
      ui.kv("Nodes", `${data.nodeCountBefore} → ${data.nodeCountAfter}`);
      ui.kv("Styles changed", data.stylesChanged ? "yes" : "no");

      const reportGroup = (title: string, added: string[], removed: string[], changed?: string[]) => {
        if (added.length + removed.length + (changed?.length ?? 0) === 0) return;
        ui.section(title);
        if (added.length > 0) ui.text(`+ ${added.join(", ")}`);
        if (removed.length > 0) ui.text(`- ${removed.join(", ")}`);
        if (changed && changed.length > 0) ui.text(`~ ${changed.join(", ")}`);
      };
      reportGroup("Variables", data.variables.added, data.variables.removed, data.variables.changed);
      reportGroup("Derived", data.derived.added, data.derived.removed, data.derived.changed);
      reportGroup("HTTP Requests", data.httpRequests.added, data.httpRequests.removed);
      if (data.nodesAdded.length > 0 || data.nodesRemoved.length > 0 || data.nodesKindChanged.length > 0) {
        ui.section("Layout Nodes");
        if (data.nodesAdded.length > 0) ui.text(`+ ${data.nodesAdded.join(", ")}`);
        if (data.nodesRemoved.length > 0) ui.text(`- ${data.nodesRemoved.join(", ")}`);
        for (const c of data.nodesKindChanged) ui.text(`~ ${c.nodeId}: ${c.before} → ${c.after}`);
      }
      return;
    }

    // restore
    ui.success(`Restored page ${data.pageId} to version ${data.restoredVersionId}.`);
    if (data.newVersionId) ui.kv("New version", data.newVersionId);
  },
};

export default command;
