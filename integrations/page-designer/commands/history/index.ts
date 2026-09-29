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
// row).
//
// Restore (OTH-R2, verified live 2026-09-29): `PUT
// /pages/revert/<draftId>?versionId=<vid>` copies the version's configuration
// into the DRAFT row (new draft versionId) and leaves the PUBLISHED row and
// the history alone — so restore is a draft edit, made live by `belz pd
// publish`. (The endpoint given the PUBLISHED id rewrites the live row with no
// publish and no history entry; belz never sends that. The old
// `/pages/revert/<vid>` form was a 400, so restore never worked before.)
// Flow: ownership check (PD-15) → the draft of the version's page (none →
// PD_PUBLISHED_NO_DRAFT) → diff-aware validation of the version against the
// draft → --yes → withLock(draft): fresh read + re-validate (OTH-R5) → revert
// → read back and compare with the version (PD_RESTORE_VERIFY_FAILED on a
// mismatch). `--acknowledge-unverified` is a deprecated no-op.

import { isDeepStrictEqual } from "node:util";
import { CliError, defineSubcommands, failWithData, ok, type CommandModule } from "@belzabar/core";
import {
  DEPRECATED_FORCE_WARNING,
  PD_WRITE_OVERRIDE_FLAGS,
  PD_YES_FLAG,
  writeOverrides,
  type WriteOverrides,
} from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { describeDraftGuardFailure, resolveLinkedPair } from "../../lib/draft-guard";
import { gateValidation, logIntent, requireConfirmation, versionDrift } from "../../lib/edit";
import { parsePage } from "../../lib/parser/index";
import { partitionBySeverity, validateEdit, validateHydrated } from "../../lib/validator/index";
import { withLock } from "../../lib/lock";
import { countNodes, diffPages, differingPaths, type SetDiff } from "../../lib/page-diff";
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
  /** restore only: deprecated no-op (revert semantics are verified, OTH-R2). */
  acknowledgeUnverified: boolean;
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
  nodesMoved: string[];
  childrenReordered: string[];
  stylesChanged: boolean;
  otherChanged: string[];
}

interface HistoryRestoreData {
  action: "restore";
  pageId: string;
  /** The page the version belongs to (history lives on the PUBLISHED row). */
  ownerId: string;
  /** The draft the revert rewrote (the only row it touches). */
  draftId: string;
  restoredVersionId: number;
  /** The draft's versionId before and after the revert. */
  oldVersionId: number | null;
  newVersionId: number | null;
  /** Read-back of the draft: does it now hold the version's configuration? */
  verify: { status: "match" | "mismatch"; versionId: number | null; differingPaths?: string[] };
  /** The draft changed between the first read and the in-lock fetch. */
  versionDrift: { from: number | null; to: number | null } | null;
  validation: { errorCount: number; warnCount: number };
  bypassedErrors: ValidationIssue[];
  /** The PUBLISHED page is untouched; `belz pd publish <draftId>` makes the restore live. */
  published: false;
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
    restore: {
      positionals: [PAGE_ID],
      flags: {
        ...VERSION,
        ...PD_YES_FLAG,
        "force-validation": PD_WRITE_OVERRIDE_FLAGS["force-validation"],
        force: PD_WRITE_OVERRIDE_FLAGS.force,
        "acknowledge-unverified": { type: "boolean" },
      },
    },
  },
  {
    command: "belz pd history",
    codes: { MISSING_SUBCOMMAND: "MISSING_ACTION", UNKNOWN_SUBCOMMAND: "UNKNOWN_ACTION" },
  },
);

/**
 * The draft a restore writes: the owner's linked draft. A soft-DELETED owner
 * (its draft lives on) is followed through its referenceId, as long as that
 * draft points back at it.
 */
async function restoreDraftOf(ownerRaw: RawPageResponse): ReturnType<typeof resolveLinkedPair> {
  if (String(ownerRaw.status).toUpperCase() !== "DELETED") return resolveLinkedPair(ownerRaw);
  const ref = typeof ownerRaw.referenceId === "string" ? ownerRaw.referenceId.trim() : "";
  const draftRaw = ref ? await pdApi.fetchPage(ref) : null;
  if (!draftRaw || String(draftRaw.status).toUpperCase() !== "DRAFT" || draftRaw.referenceId !== ownerRaw.id) {
    return { ok: true, draftId: null, publishedId: ownerRaw.id, draftRaw: null };
  }
  return { ok: true, draftId: draftRaw.id, publishedId: null, draftRaw, deletedSiblingId: ownerRaw.id };
}

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
          ? writeOverrides({ ...r.flags, allowPublished: false })
          : { forceValidation: false, allowPublished: false, deprecatedForce: false },
      acknowledgeUnverified: r.subcommand === "restore" ? r.flags.acknowledgeUnverified : false,
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
        nodesMoved: diff.nodesMoved,
        childrenReordered: diff.childrenReordered,
        stylesChanged: diff.styles.changed,
        otherChanged: diff.otherChanged,
      });
    }

    // restore
    const warn = (m: string) => context.warn(m);
    if (args.overrides.deprecatedForce) warn(`⚠ ${DEPRECATED_FORCE_WARNING}`);
    if (args.acknowledgeUnverified) warn("⚠ --acknowledge-unverified is deprecated and ignored: restore semantics are verified (it rewrites the draft only).");
    const vid = args.version!;
    const version = await fetchOwnedVersion(args.pageId, vid);
    const ownerId = version.id;
    const ownerRaw = await pdApi.fetchPage(ownerId);
    if (!ownerRaw) throw new CliError(`Page ${ownerId} (owner of version ${vid}) not found.`, { code: "PD_NOT_FOUND" });
    const link = await restoreDraftOf(ownerRaw);
    if (!link.ok) {
      throw describeDraftGuardFailure({ ok: false, reason: link.reason, publishedId: null, inputId: ownerId, message: link.message });
    }
    if (!link.draftId || !link.draftRaw) {
      throw new CliError(
        `Page ${ownerId} has no linked draft. history restore rewrites the draft (never the live page), so there is nothing to restore into.`,
        { code: "PD_PUBLISHED_NO_DRAFT", details: { ownerId, versionId: vid } },
      );
    }
    const draftId = link.draftId;
    const draft = parsePage(link.draftRaw);
    const target = (current: RawPageResponse) => parsePage({ ...current, configuration: version.configuration });
    const check = (currentRaw: RawPageResponse) => validateEdit(parsePage(currentRaw), target(currentRaw));
    gateValidation(check(link.draftRaw), args.overrides.forceValidation, warn);

    await requireConfirmation(context, args.yes, "restore", [
      ["Page", `${draft.name} (draft ${draftId})`],
      ["Restore to version", `${vid} (of ${ownerId})`],
      ["Effect", "rewrites the DRAFT only; publish to make it live"],
    ]);
    logIntent("history-restore", draftId, { versionId: vid, ownerId });

    const res = await withLock(draftId, async () => {
      // OTH-R5: validate against the draft as it is now, inside the lock.
      const freshRaw = await pdApi.fetchPage(draftId);
      if (!freshRaw) throw new CliError(`Page ${draftId} disappeared before the restore.`, { code: "PD_NOT_FOUND" });
      const fresh = parsePage(freshRaw);
      const drift = versionDrift(draft, fresh, warn);
      const gate = gateValidation(check(freshRaw), args.overrides.forceValidation, warn, drift !== null);
      const answer = await pdApi.historyRestore(draftId, vid);
      const after = await pdApi.fetchPage(draftId);
      return { gate, drift, fresh, freshRaw, answer, after };
    });

    const expected = target(res.freshRaw).rawConfiguration;
    const stored = res.after ? parsePage(res.after) : res.answer ? parsePage(res.answer) : null;
    const newVersionId =
      typeof res.answer?.versionId === "number" ? res.answer.versionId : typeof res.after?.versionId === "number" ? res.after.versionId : null;
    const verify: HistoryRestoreData["verify"] =
      stored && isDeepStrictEqual(stored.rawConfiguration, expected)
        ? { status: "match", versionId: stored.versionId }
        : { status: "mismatch", versionId: stored?.versionId ?? null, differingPaths: differingPaths(expected, stored?.rawConfiguration ?? null) };

    const data: HistoryRestoreData = {
      action: "restore",
      pageId: args.pageId,
      ownerId,
      draftId,
      restoredVersionId: vid,
      oldVersionId: res.fresh.versionId,
      newVersionId,
      verify,
      versionDrift: res.drift,
      validation: { errorCount: res.gate.errors.length, warnCount: res.gate.warnings.length },
      bypassedErrors: res.gate.bypassedErrors,
      published: false,
    };
    if (verify.status === "mismatch") {
      return failWithData(
        "PD_RESTORE_VERIFY_FAILED",
        `Reverted draft ${draftId} to version ${vid}, but the read-back does not hold that version's config ` +
          `(${verify.differingPaths?.length ?? 0} differing path(s)). Inspect with \`belz pd show ${draftId} --force\`.`,
        data,
        { details: { draftId, versionId: vid, differingPaths: verify.differingPaths ?? [] } },
      );
    }
    warn(`ℹ Draft ${draftId} now holds version ${vid}; the published page is unchanged — \`belz pd publish ${draftId}\` makes it live.`);
    return ok<HistoryRestoreData>(data);
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
      if (data.nodesMoved.length > 0) ui.kv("Nodes moved", data.nodesMoved.join(", "));
      if (data.childrenReordered.length > 0) ui.kv("Children reordered under", data.childrenReordered.join(", "));
      if (data.otherChanged.length > 0) ui.kv("Other config changed", data.otherChanged.join(", "));
      return;
    }

    // restore
    ui.success(`Restored draft ${data.draftId} to version ${data.restoredVersionId}.`);
    ui.kv("Draft version", `${data.oldVersionId ?? "?"} → ${data.newVersionId ?? "?"}`);
    ui.info(`The published page is unchanged. Publish with \`belz pd publish ${data.draftId}\`.`);
  },
};

export default command;
