import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { fingerprintMethod } from "../../lib/fingerprint";
import { resolveMethodRef } from "@belzabar/core/platform";
import type { HydratedMethod } from "../../lib/types/common";

interface StateArgs {
  uuid: string;
}

interface StateData {
  input: { uuid: string };
  ok: boolean;
  state: "DRAFT" | "PUBLISHED" | "UNKNOWN" | null;
  draftUuid: string | null;
  publishedUuid: string | null;
  draftVersion: number | null;
  publishedVersion: number | null;
  /**
   * Version counters of each side. Draft and published counters are
   * independent (a draft save bumps only the draft), so never compare them
   * to decide sync — see `inSync`.
   */
  versions: { draft: number | null; published: number | null };
  /** 12-hex logic fingerprints (lib/fingerprint.ts) of each side. */
  fingerprints: { draft: string | null; published: string | null };
  /**
   * true: draft logic == published logic; false: the draft has unpublished
   * changes; null: no published side (never published) or it could not be read.
   */
  inSync: boolean | null;
  switchedFromPublished: boolean;
  message?: string;
}

export const args = defineArgs({
  command: "belz ad state",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." }],
  flags: {},
});

const command: CommandModule<StateArgs, StateData> = {
  parseArgs(argv) {
    const { positionals } = args.parse(argv);
    return { uuid: positionals.uuid };
  },
  async execute({ uuid: uuidArg }) {
    const uuid = resolveMethodRef(uuidArg);
    // Both sides are read on V2: the sync fingerprint must compare V2 bodies
    // (V1 serialisation noise differs between draft and published).
    const apiVersion = "v2" as const;
    // One fetch per side (AD-39): the guard hands back the input method too.
    const guard = await resolveDraftTarget(uuid, apiVersion);
    const initial = guard.initial;
    const versionOf = (m: HydratedMethod | null) => (m && typeof m.version === "number" ? m.version : null);

    if (!guard.ok) {
      const publishedVersion = initial.state === "PUBLISHED" ? versionOf(initial) : null;
      return ok<StateData>({
        input: { uuid },
        ok: false,
        state: initial.state,
        draftUuid: null,
        publishedUuid: guard.publishedUuid,
        draftVersion: null,
        publishedVersion,
        versions: { draft: null, published: publishedVersion },
        fingerprints: { draft: null, published: initial.state === "PUBLISHED" ? fingerprintMethod(initial) : null },
        inSync: null,
        switchedFromPublished: false,
        message: guard.message,
      });
    }

    const draft = guard.draft;
    let published: HydratedMethod | null = null;
    let message: string | undefined;
    if (guard.switchedFromPublished) {
      published = initial; // already fetched
    } else if (guard.publishedUuid && guard.publishedUuid !== draft.uuid) {
      try {
        published = await adApi.fetchMethod(guard.publishedUuid, apiVersion);
      } catch (e) {
        message = `Could not read the published side ${guard.publishedUuid}: ${(e as Error).message}`;
      }
    }

    // AD-18 / F35: sync is a CONTENT question. Compare logic fingerprints.
    const draftFp = fingerprintMethod(draft);
    const publishedFp = published ? fingerprintMethod(published) : null;
    const inSync = publishedFp === null ? null : draftFp === publishedFp;

    return ok<StateData>({
      input: { uuid },
      ok: true,
      state: initial.state,
      draftUuid: draft.uuid,
      publishedUuid: guard.publishedUuid,
      draftVersion: versionOf(draft),
      publishedVersion: versionOf(published),
      versions: { draft: versionOf(draft), published: versionOf(published) },
      fingerprints: { draft: draftFp, published: publishedFp },
      inSync,
      switchedFromPublished: guard.switchedFromPublished,
      ...(message ? { message } : {}),
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as StateData;
    ui.table(
      ["Property", "Value"],
      [
        ["Input UUID", data.input.uuid],
        ["State", data.state ?? ""],
        ["Draft UUID", data.draftUuid ?? "(none)"],
        ["Published UUID", data.publishedUuid ?? "(none)"],
        ["Draft version", data.draftVersion ?? ""],
        ["Published version", data.publishedVersion ?? ""],
        ["Switched from PUBLISHED", data.switchedFromPublished ? "Yes" : "No"],
      ],
    );
    if (data.message) ui.warn(data.message);
    if (data.inSync === true) {
      ui.success("Draft and published logic are identical (fingerprint match).");
    } else if (data.inSync === false) {
      ui.warn(
        `Draft logic differs from published (fingerprint ${data.fingerprints.draft} vs ${data.fingerprints.published}). Publish to sync.`,
      );
    } else if (data.ok && !data.publishedUuid) {
      ui.text("Never published.");
    }
  },
};

export default command;
