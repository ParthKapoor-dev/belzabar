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

    await withLock(targetId, async () => {
      await pdApi.publishPage(targetId, { landingPage: args.landing, hostIds: args.hostIds });
    });

    // Re-fetch draft to see its (maybe bumped) versionId and find the published sibling.
    const draftAfter = await pdApi.fetchPage(targetId);
    const publishedAfter = guard.ok && guard.publishedId
      ? await pdApi.fetchPage(guard.publishedId)
      : null;

    return ok<PublishData>({
      pageId: args.pageId,
      draftId: targetId,
      publishedId: guard.ok ? guard.publishedId : guard.publishedId,
      switchedFromPublished: guard.ok ? guard.switchedFromPublished : false,
      landing: args.landing,
      hostIds: args.hostIds,
      preVersionId: before.versionId,
      postPublishVersionId:
        (publishedAfter && typeof publishedAfter.versionId === "number"
          ? publishedAfter.versionId
          : null) ??
        (draftAfter && typeof draftAfter.versionId === "number" ? draftAfter.versionId : null),
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
        ["Pre-version", data.preVersionId ?? "N/A"],
        ["Post-publish version", data.postPublishVersionId ?? "N/A"],
      ],
    );
  },
};

export default command;
