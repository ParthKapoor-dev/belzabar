// belz pd publish <pageId> [--landing] [--host <id>] [--yes]
//
// POST /pages/<draftId>/publish with body {landingPage, hostIds?}.
// Must be a DRAFT — refuses PUBLISHED. withLock wraps the call.

import { CliError, ok, type CommandModule } from "@belzabar/core";
import { parsePdCommonArgs } from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { parsePage } from "../../lib/parser/index";
import { resolveDraftTarget, describeDraftGuardFailure } from "../../lib/draft-guard";
import { withLock } from "../../lib/lock";

interface PublishArgs {
  pageId: string;
  landing: boolean;
  hostIds: string[];
  yes: boolean;
  force: boolean;
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
}

const command: CommandModule<PublishArgs, PublishData> = {
  schema: "pd.publish",

  parseArgs(argv) {
    const { common, rest } = parsePdCommonArgs(argv);
    const pageId = rest[0];
    if (!pageId || pageId.startsWith("-")) {
      throw new CliError("Missing <pageId>.", { code: "MISSING_INPUT" });
    }
    const landing = rest.includes("--landing");
    const hostIds: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--host") {
        const v = rest[i + 1];
        if (v && !v.startsWith("-")) hostIds.push(v);
      }
    }
    return { pageId, landing, hostIds, yes: common.yes, force: common.force };
  },

  async execute(args, context) {
    const guard = await resolveDraftTarget(args.pageId);
    if (!guard.ok) {
      if (args.force && guard.reason === "PUBLISHED_NO_DRAFT") {
        context.warn(
          `⚠ --force: publishing PUBLISHED page ${guard.publishedId} directly. This is unusual — expected input is a DRAFT.`,
        );
      } else {
        throw describeDraftGuardFailure(guard);
      }
    }
    const targetId = guard.ok ? guard.draftId : guard.publishedId!;
    const before = guard.ok
      ? guard.draft
      : parsePage((await pdApi.fetchPage(targetId))!);

    if (!args.yes) {
      throw new CliError(
        `"publish" is a write operation. Pass --yes to confirm publishing ${targetId}.`,
        { code: "CONFIRMATION_REQUIRED" },
      );
    }

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

    return ok<PublishData>({
      pageId: args.pageId,
      draftId: targetId,
      publishedId: typeof published.id === "string" ? published.id : guard.publishedId,
      switchedFromPublished: guard.ok ? guard.switchedFromPublished : false,
      landing: args.landing,
      hostIds: args.hostIds,
      preVersionId: before.versionId,
      postPublishVersionId,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
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
