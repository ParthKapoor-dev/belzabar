// belz pd publish <pageId> [--landing] [--host <id>...] [--yes]
//              [--force-validation] [--allow-published]
//
// POST /pages/<draftId>/publish?landingPage=&hostIds=. The draft is resolved
// via referenceId (a PUBLISHED input publishes its linked draft) and
// validated, then published inside withLock. Afterwards the local cache
// entries of BOTH the draft and the published page are dropped.
//
// Validation is diff-aware against the currently PUBLISHED version: only
// errors the draft introduces since the last publish block;
// issues the live page already has are reported as pre-existing warnings. A
// never-published draft (or --allow-published on a lone PUBLISHED page) is
// gated on every error. The gate runs once on the pre-lock snapshot (fail
// fast, before --yes) and again on a FRESH fetch inside the lock, so what is
// POSTed is what was validated (data.versionDrift reports a change).

import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import {
  PD_WRITE_OVERRIDE_FLAGS,
  PD_YES_FLAG,
  type WriteOverrides,
} from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { invalidatePageCache } from "../../lib/cache";
import { fetchFresh, fetchPublishedBaseline, gateValidation, logIntent, requireConfirmation, resolveWriteTarget, versionDrift } from "../../lib/edit";
import { withLock } from "../../lib/lock";
import { validateEdit, validateHydrated } from "../../lib/validator/index";
import type { HydratedPage, ValidationIssue } from "../../lib/types/common";

interface PublishArgs {
  pageId: string;
  landing: boolean;
  hostIds: string[];
  yes: boolean;
  overrides: WriteOverrides;
}

interface PublishData {
  pageId: string;
  draftId: string;
  publishedId: string | null;
  switchedFromPublished: boolean;
  landing: boolean;
  hostIds: string[];
  preVersionId: number | null;
  postPublishVersionId: number | null;
  /** What validation was relative to: the PUBLISHED version (diff-aware) or nothing (full). */
  validation: { baseline: "published" | "none"; errorCount: number; warnCount: number; preExistingCount: number };
  /** The draft changed between the first read and the in-lock fetch. */
  versionDrift: { from: number | null; to: number | null } | null;
  bypassedErrors: ValidationIssue[];
}

export const args = defineArgs({
  command: "belz pd publish",
  positionals: [{ name: "page-id", required: true, missingCode: "MISSING_INPUT", missingMessage: "Missing <pageId>." }],
  flags: {
    landing: { type: "boolean" },
    // `--host` without a value is MISSING_VALUE (dropping it would publish
    // without deploying).
    host: { type: "string", repeatable: true },
    ...PD_YES_FLAG,
    ...PD_WRITE_OVERRIDE_FLAGS,
  },
});

const command: CommandModule<PublishArgs, PublishData> = {
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return {
      pageId: positionals.pageId,
      landing: flags.landing,
      hostIds: flags.host,
      yes: flags.yes,
      overrides: { forceValidation: flags.forceValidation, allowPublished: flags.allowPublished },
    };
  },

  async execute(args, context) {
    const warn = (m: string) => context.warn(m);

    const target = await resolveWriteTarget(args.pageId, args.overrides, warn, "publishing");
    const { targetId } = target;
    const before = target.snapshot;

    // Baseline: the live PUBLISHED sibling (not when publishing a PUBLISHED page itself).
    // Read fresh: the GET can lag a recent publish; history is authoritative.
    let baseline: HydratedPage | null = null;
    if (target.publishedId && target.publishedId !== targetId) {
      baseline = await fetchPublishedBaseline(target.publishedId, warn);
    }
    const check = (page: HydratedPage) => (baseline ? validateEdit(baseline, page) : validateHydrated(page));
    gateValidation(check(before), args.overrides.forceValidation, warn);

    await requireConfirmation(context, args.yes, "publish", [
      ["Page", `${before.name} (${targetId})`],
      ["Deploy to hosts", args.hostIds.length > 0 ? args.hostIds.join(", ") : "none (publish only)"],
      ["Landing page", args.landing ? "yes" : "no"],
    ]);
    logIntent("publish", targetId, { hostIds: args.hostIds, landing: args.landing });

    // The POST /pages/<draftId>/publish response body IS the freshly-published
    // page — it carries the authoritative post-publish versionId.
    const { publishResponse, gate, issues, drift } = await withLock(targetId, async () => {
      // Validate what will actually be published — a fresh read inside the lock.
      const fresh = await fetchFresh(targetId);
      const drift = versionDrift(before, fresh, warn);
      const issues = check(fresh);
      const gate = gateValidation(issues, args.overrides.forceValidation, warn, drift !== null);
      const publishResponse = await pdApi.publishPage(targetId, { landingPage: args.landing, hostIds: args.hostIds });
      return { publishResponse, gate, issues, drift };
    });

    // Verify from that response — NOT by re-reading GET /pages/<publishedId>.
    // Verified live (2026-09-29, tests/fixtures/wire/publish.json): after a
    // publish WITHOUT a host the published GET keeps returning the last
    // DEPLOYED version (minutes later, still the old one), while the history
    // and /pages/version/<vid> already hold the new one; a publish WITH a host
    // is visible to the GET at once. Trusting the GET made successful
    // publishes look like silent no-ops.
    const published = (publishResponse ?? {}) as {
      id?: unknown;
      versionId?: unknown;
      status?: unknown;
    };
    const postPublishVersionId =
      typeof published.versionId === "number" ? published.versionId : null;
    const publishedId = typeof published.id === "string" ? published.id : target.publishedId;
    await invalidatePageCache([publishedId, target.publishedId]);

    return ok<PublishData>({
      pageId: args.pageId,
      draftId: targetId,
      publishedId,
      switchedFromPublished: target.switchedFromPublished,
      landing: args.landing,
      hostIds: args.hostIds,
      preVersionId: before.versionId,
      postPublishVersionId,
      validation: {
        baseline: baseline ? "published" : "none",
        errorCount: gate.errors.length,
        warnCount: gate.warnings.length,
        preExistingCount: issues.filter((i) => i.preExisting).length,
      },
      versionDrift: drift,
      bypassedErrors: gate.bypassedErrors,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok || !envelope.data) return;
    const data = envelope.data as PublishData;
    ui.success(`Published ${data.draftId}.`);
    ui.table(
      ["Property", "Value"],
      [
        ["Draft", data.draftId],
        ["Published", data.publishedId ?? "N/A"],
        ["Landing page", data.landing ? "yes" : "no"],
        ["Host IDs", data.hostIds.length > 0 ? data.hostIds.join(", ") : "none"],
        ["Draft version (before)", data.preVersionId ?? "N/A"],
        ["Published version (after)", data.postPublishVersionId ?? "N/A"],
      ],
    );
    ui.info(
      "Published version is read from the publish response. Note: `belz pd show " +
        "<publishedId>` shows the last DEPLOYED version until a publish with --host.",
    );
  },
};

export default command;
