// belz pd publish <pageId> [--landing] [--host <id>...] [--yes]
//              [--force-validation] [--allow-published]
//
// POST /pages/<draftId>/publish?landingPage=&hostIds=. The draft is resolved
// via referenceId (a PUBLISHED input publishes its linked draft), validated
// (errors block unless --force-validation), then published inside withLock.
// Afterwards the local cache entries of BOTH the draft and the published page
// are dropped (s0-review: the published sibling used to stay stale).

import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import {
  DEPRECATED_FORCE_WARNING,
  PD_WRITE_OVERRIDE_FLAGS,
  PD_YES_FLAG,
  writeOverrides,
  type WriteOverrides,
} from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { invalidatePageCache } from "../../lib/cache";
import { gateValidation, logIntent, requireConfirmation, resolveWriteTarget } from "../../lib/edit";
import { withLock } from "../../lib/lock";
import { validateHydrated } from "../../lib/validator/index";
import type { ValidationIssue } from "../../lib/types/common";

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
  validation: { errorCount: number; warnCount: number };
  bypassedErrors: ValidationIssue[];
}

export const args = defineArgs({
  command: "belz pd publish",
  positionals: [{ name: "page-id", required: true, missingCode: "MISSING_INPUT", missingMessage: "Missing <pageId>." }],
  flags: {
    landing: { type: "boolean" },
    // PD-16: `--host` without a value is MISSING_VALUE (it used to be dropped,
    // publishing without deploying).
    host: { type: "string", repeatable: true },
    ...PD_YES_FLAG,
    ...PD_WRITE_OVERRIDE_FLAGS,
  },
});

const command: CommandModule<PublishArgs, PublishData> = {
  schema: "pd.publish",

  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return {
      pageId: positionals.pageId,
      landing: flags.landing,
      hostIds: flags.host,
      yes: flags.yes,
      overrides: writeOverrides(flags),
    };
  },

  async execute(args, context) {
    const warn = (m: string) => context.warn(m);
    if (args.overrides.deprecatedForce) warn(`⚠ ${DEPRECATED_FORCE_WARNING}`);

    const target = await resolveWriteTarget(args.pageId, args.overrides, warn, "publishing");
    const { targetId } = target;
    const before = target.snapshot;
    const gate = gateValidation(validateHydrated(before), args.overrides.forceValidation, warn);

    await requireConfirmation(context, args.yes, "publish", [
      ["Page", `${before.name} (${targetId})`],
      ["Deploy to hosts", args.hostIds.length > 0 ? args.hostIds.join(", ") : "none (publish only)"],
      ["Landing page", args.landing ? "yes" : "no"],
    ]);
    logIntent("publish", targetId, { hostIds: args.hostIds, landing: args.landing });

    // The POST /pages/<draftId>/publish response body IS the freshly-published
    // page — it carries the authoritative post-publish versionId.
    const publishResponse = await withLock(targetId, () =>
      pdApi.publishPage(targetId, { landingPage: args.landing, hostIds: args.hostIds }),
    );

    // Verify from that response — NOT by re-reading GET /pages/<publishedId>.
    // The single-page GET is served from a stale server-side cache that keeps
    // returning the PRE-publish version for some time after a publish; trusting
    // it makes every successful publish look like a silent no-op (and fooled
    // every prior "PD publish doesn't work" investigation).
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
      validation: { errorCount: gate.errors.length, warnCount: gate.warnings.length },
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
        "<publishedId>` may lag — GET /pages/<id> is server-side cached.",
    );
  },
};

export default command;
