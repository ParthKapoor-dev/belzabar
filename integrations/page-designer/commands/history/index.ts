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
//
// PD-15: a version id is global, so show/diff/restore check that the version
// belongs to <pageId> (the version body's `id` is its owning page, its
// `referenceId` the linked sibling — history is recorded on the PUBLISHED
// row). Restore locks the owning page AND its linked draft, validates the
// version against the current page (diff-aware), and — because PUT
// /pages/revert rewrites the owning page, which is normally the PUBLISHED
// one — requires --allow-published when the owner is PUBLISHED.

import { CliError, defineSubcommands, ok, type CommandModule } from "@belzabar/core";
import {
  DEPRECATED_FORCE_WARNING,
  PD_WRITE_OVERRIDE_FLAGS,
  PD_YES_FLAG,
  writeOverrides,
  type WriteOverrides,
} from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { describeDraftGuardFailure, resolveLinkedPair } from "../../lib/draft-guard";
import { gateValidation, logIntent, requireConfirmation } from "../../lib/edit";
import { parsePage } from "../../lib/parser/index";
import { partitionBySeverity, validateEdit, validateHydrated } from "../../lib/validator/index";
import { withLock } from "../../lib/lock";
import { countNodes, diffPages, type SetDiff } from "../../lib/page-diff";
import type { RawHistoryEntry, RawPageResponse, ValidationIssue } from "../../lib/types/common";

type Action = "list" | "show" | "diff" | "restore";

interface HistoryArgs {
  action: Action;
  pageId: string;
  version?: number;
  from?: number;
  to?: number;
  limit: number;
  overrides: WriteOverrides;
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
  /** Set when a DRAFT lists 0 versions: history is recorded on its PUBLISHED sibling. */
  publishedId?: string;
  hint?: string;
}

interface HistoryShowData {
  action: "show";
  pageId: string;
  versionId: number;
  /** The page the version belongs to (may be <pageId>'s linked sibling). */
  ownerId: string;
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
  httpRequests: SetDiff;
  nodeCountBefore: number;
  nodeCountAfter: number;
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesKindChanged: Array<{ nodeId: string; before: string; after: string }>;
  nodesChanged: string[];
  stylesChanged: boolean;
  otherChanged: string[];
}

interface HistoryRestoreData {
  action: "restore";
  pageId: string;
  /** The page PUT /pages/revert rewrote (the version's owner). */
  ownerId: string;
  draftId: string | null;
  restoredVersionId: number;
  newVersionId: number | null;
  validation: { errorCount: number; warnCount: number };
  bypassedErrors: ValidationIssue[];
}

type HistoryData =
  | HistoryListData
  | HistoryShowData
  | HistoryDiffData
  | HistoryRestoreData;

// -------- helpers --------------------------------------------------------

const PAGE_ID = {
  name: "page-id",
  required: true,
  missingCode: "MISSING_INPUT",
  missingMessage: "Missing <pageId>. Provide a PD page or component id.",
} as const;
const VERSION = {
  version: {
    type: "number",
    integer: true,
    required: true,
    missingCode: "MISSING_VERSION",
    missingMessage: "--version <id> is required.",
  },
} as const;

export const args = defineSubcommands(
  {
    list: { positionals: [PAGE_ID], flags: { limit: { type: "number", integer: true, min: 1, default: 50 } } },
    show: { positionals: [PAGE_ID], flags: { ...VERSION } },
    diff: {
      positionals: [PAGE_ID],
      flags: {
        from: { type: "number", integer: true, required: true, missingCode: "MISSING_VERSION_RANGE" },
        to: { type: "number", integer: true, required: true, missingCode: "MISSING_VERSION_RANGE" },
      },
    },
    restore: { positionals: [PAGE_ID], flags: { ...VERSION, ...PD_YES_FLAG, ...PD_WRITE_OVERRIDE_FLAGS } },
  },
  {
    command: "belz pd history",
    codes: { MISSING_SUBCOMMAND: "MISSING_ACTION", UNKNOWN_SUBCOMMAND: "UNKNOWN_ACTION" },
  },
);

/** Fetch version `vid` and check it belongs to `pageId` (PD-15). */
async function fetchOwnedVersion(pageId: string, vid: number): Promise<RawPageResponse> {
  const raw = await pdApi.historyGet(vid);
  if (!raw) throw new CliError(`Version ${vid} not found.`, { code: "PD_VERSION_NOT_FOUND" });
  const owner = typeof raw.id === "string" ? raw.id : "";
  const sibling = typeof raw.referenceId === "string" ? raw.referenceId : "";
  if (owner !== pageId && sibling !== pageId) {
    throw new CliError(
      `Version ${vid} belongs to page ${owner || "?"} (${String(raw.name ?? "")}), not ${pageId}. ` +
        `List this page's versions with \`belz pd history list ${pageId}\`.`,
      { code: "PD_VERSION_PAGE_MISMATCH", details: { versionId: vid, pageId, ownerId: owner || null } },
    );
  }
  return raw;
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

  writes: (a: HistoryArgs) => a.action === "restore",
  parseArgs(argv) {
    const r = args.parse(argv);
    const out: HistoryArgs = {
      action: r.subcommand,
      pageId: r.positionals.pageId,
      overrides:
        r.subcommand === "restore"
          ? writeOverrides(r.flags)
          : { forceValidation: false, allowPublished: false, deprecatedForce: false },
      yes: r.subcommand === "restore" ? r.flags.yes : false,
      limit: r.subcommand === "list" ? r.flags.limit : 50,
    };
    if (r.subcommand === "show" || r.subcommand === "restore") out.version = r.flags.version;
    if (r.subcommand === "diff") {
      out.from = r.flags.from;
      out.to = r.flags.to;
    }
    return out;
  },

  async execute(args, context) {
    if (args.action === "list") {
      const entries = await pdApi.historyList(args.pageId);
      const rows = entries.map(toRow).sort((a, b) => b.versionId - a.versionId);
      const clipped = rows.slice(0, args.limit);
      const data: HistoryListData = {
        action: "list",
        pageId: args.pageId,
        totalVersions: rows.length,
        versions: clipped,
      };
      if (rows.length === 0) {
        // History is recorded on the PUBLISHED page; a draft id lists nothing.
        const raw = await pdApi.fetchPage(args.pageId);
        const ref = typeof raw?.referenceId === "string" ? raw.referenceId.trim() : "";
        if (raw && String(raw.status).toUpperCase() === "DRAFT" && ref && ref !== args.pageId) {
          data.publishedId = ref;
          data.hint = `History is recorded on the published page: belz pd history list ${ref}`;
          context.warn(`${args.pageId} is a DRAFT; its history is on the published page ${ref}.`);
        }
      }
      return ok<HistoryListData>(data);
    }

    if (args.action === "show") {
      const vid = args.version!;
      const raw = await fetchOwnedVersion(args.pageId, vid);
      const page = parsePage(raw);
      const issues = validateHydrated(page);
      const { errors, warnings } = partitionBySeverity(issues);
      return ok<HistoryShowData>({
        action: "show",
        pageId: args.pageId,
        versionId: vid,
        ownerId: page.id,
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
        fetchOwnedVersion(args.pageId, args.from!),
        fetchOwnedVersion(args.pageId, args.to!),
      ]);
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
        nodesChanged: diff.nodesChanged,
        stylesChanged: diff.styles.changed,
        otherChanged: diff.otherChanged,
      });
    }

    // restore
    const warn = (m: string) => context.warn(m);
    if (args.overrides.deprecatedForce) warn(`⚠ ${DEPRECATED_FORCE_WARNING}`);
    const vid = args.version!;
    const version = await fetchOwnedVersion(args.pageId, vid);
    const ownerId = version.id;
    const ownerRaw = await pdApi.fetchPage(ownerId);
    if (!ownerRaw) throw new CliError(`Page ${ownerId} (owner of version ${vid}) not found.`, { code: "PD_NOT_FOUND" });
    const link = await resolveLinkedPair(ownerRaw);
    if (!link.ok) {
      throw describeDraftGuardFailure({ ok: false, reason: link.reason, publishedId: null, inputId: ownerId, message: link.message });
    }
    const owner = parsePage(ownerRaw);
    if (owner.status === "PUBLISHED" && !args.overrides.allowPublished) {
      throw new CliError(
        `Version ${vid} belongs to the PUBLISHED page ${ownerId} (${owner.name}); PUT /pages/revert rewrites that page. ` +
          `Pass --allow-published to restore it.`,
        { code: "PD_PUBLISHED_NO_DRAFT", details: { ownerId, draftId: link.draftId } },
      );
    }
    const target = parsePage({ ...ownerRaw, configuration: version.configuration });
    const gate = gateValidation(validateEdit(owner, target), args.overrides.forceValidation, warn);

    await requireConfirmation(context, args.yes, "restore", [
      ["Page", `${owner.name} (${ownerId}, ${owner.status})`],
      ["Linked draft", link.draftId ?? "none"],
      ["Restore to version", String(vid)],
    ]);
    logIntent("history-restore", ownerId, { versionId: vid, draftId: link.draftId });

    const lockIds = [...new Set([ownerId, link.draftId].filter((x): x is string => !!x))];
    const runLocked = (ids: string[], fn: () => Promise<void>): Promise<void> =>
      ids.length === 0 ? fn() : withLock(ids[0]!, () => runLocked(ids.slice(1), fn));
    await runLocked(lockIds, () => pdApi.historyRestore(vid));

    const after = await pdApi.fetchPage(ownerId);
    const newVersionId =
      after && typeof after.versionId === "number" && after.versionId !== owner.versionId ? after.versionId : null;

    return ok<HistoryRestoreData>({
      action: "restore",
      pageId: args.pageId,
      ownerId,
      draftId: link.draftId,
      restoredVersionId: vid,
      newVersionId,
      validation: { errorCount: gate.errors.length, warnCount: gate.warnings.length },
      bypassedErrors: gate.bypassedErrors,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as HistoryData;

    if (data.action === "list") {
      ui.kv("Page", data.pageId);
      ui.kv("Total versions", data.totalVersions);
      if (data.versions.length === 0) {
        ui.info(
          data.hint ??
            "No version history yet. History is recorded on the PUBLISHED page; a page never published or updated lists none.",
        );
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
      reportGroup("HTTP Requests", data.httpRequests.added, data.httpRequests.removed, data.httpRequests.changed);
      if (data.nodesAdded.length + data.nodesRemoved.length + data.nodesKindChanged.length + data.nodesChanged.length > 0) {
        ui.section("Layout Nodes");
        if (data.nodesAdded.length > 0) ui.text(`+ ${data.nodesAdded.join(", ")}`);
        if (data.nodesRemoved.length > 0) ui.text(`- ${data.nodesRemoved.join(", ")}`);
        if (data.nodesChanged.length > 0) ui.text(`~ ${data.nodesChanged.join(", ")}`);
        for (const c of data.nodesKindChanged) ui.text(`~ ${c.nodeId}: ${c.before} → ${c.after}`);
      }
      if (data.otherChanged.length > 0) ui.kv("Other config changed", data.otherChanged.join(", "));
      return;
    }

    // restore
    ui.success(`Restored page ${data.ownerId} to version ${data.restoredVersionId}.`);
    if (data.newVersionId) ui.kv("New version", data.newVersionId);
  },
};

export default command;
