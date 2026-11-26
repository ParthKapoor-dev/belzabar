import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { fingerprintMethod, storedBodyFingerprint } from "../../lib/fingerprint";
import { lastUpdatedOf } from "../../lib/history";
import { resolveMethodRef } from "@belzabar/core/platform";
import type { HydratedMethod } from "../../lib/types/common";

interface StateArgs {
  uuid: string;
}

interface StateData {
  input: { uuid: string };
  /** false: PUBLISHED with no linked draft, or a side could not be read (`publishedReadFailed`). */
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
  /** When each side was last saved (ISO-8601 UTC; V1 `updatedOn`, else `createdOn`); null when unknown. */
  updatedOn: { draft: string | null; published: string | null };
  /**
   * true: draft logic == published logic; false: the draft has unpublished
   * changes; null: no published side (never published) or it could not be read.
   */
  inSync: boolean | null;
  /**
   * Whether the two STORED bodies differ (storedBodyFingerprint: descriptions,
   * explicit defaults and fields a save normalises count; ids, versions and
   * stamps do not). inSync:true + bodyDiffers:true = logic equal, stored body
   * differs: the draft is still not what is published. null when inSync is null
   * or a side has no wire body.
   */
  bodyDiffers: boolean | null;
  /** The method has a published side but reading it failed (e.g. timed out): its version and fingerprint are unknown, not absent. */
  publishedReadFailed?: true;
  /** The error code of the failed published read. */
  publishedReadError?: string;
  switchedFromPublished: boolean;
  /** Who may call each side (`permissions.methodScope`; UNRESTRICTED when unset), read fresh. */
  scopes: { draft: string | null; published: string | null };
  message?: string;
}

export const args = defineArgs({
  command: "wi-impl ad state",
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
    // One fetch per side: the guard hands back the input method too.
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
        updatedOn: { draft: null, published: initial.state === "PUBLISHED" ? await lastUpdatedOf(initial.uuid) : null },
        inSync: null,
        bodyDiffers: null,
        switchedFromPublished: false,
        scopes: { draft: null, published: initial.state === "PUBLISHED" ? initial.scope ?? null : null },
        message: guard.message,
      });
    }

    const draft = guard.draft;
    const hasPublished = !!guard.publishedUuid && guard.publishedUuid !== draft.uuid;
    let published: HydratedMethod | null = null;
    let readError: string | undefined;
    let message: string | undefined;
    // The V2 GET has no update stamp: the V1 chain's is read beside it (best effort).
    const stamps = Promise.all([lastUpdatedOf(draft.uuid), hasPublished ? lastUpdatedOf(guard.publishedUuid!) : Promise.resolve(null)]);
    if (guard.switchedFromPublished) {
      published = initial; // already fetched
    } else if (hasPublished) {
      try {
        published = await adApi.fetchMethod(guard.publishedUuid!, apiVersion);
      } catch (e) {
        readError = e instanceof CliError ? e.code : "AD_API_ERROR";
        message = `Could not read the published side ${guard.publishedUuid}: ${(e as Error).message} Its version and fingerprint are unknown (not "never published"); retry.`;
      }
    }
    const [draftUpdated, publishedUpdated] = await stamps;

    // sync is a CONTENT question. Compare logic fingerprints.
    const draftFp = fingerprintMethod(draft);
    const publishedFp = published ? fingerprintMethod(published) : null;
    const inSync = publishedFp === null ? null : draftFp === publishedFp;
    const draftBodyFp = storedBodyFingerprint(draft);
    const publishedBodyFp = published ? storedBodyFingerprint(published) : null;
    const bodyDiffers =
      inSync === null ? null : inSync === false ? true : draftBodyFp === null || publishedBodyFp === null ? null : draftBodyFp !== publishedBodyFp;

    return ok<StateData>({
      input: { uuid },
      ok: readError === undefined,
      state: initial.state,
      draftUuid: draft.uuid,
      publishedUuid: guard.publishedUuid,
      draftVersion: versionOf(draft),
      publishedVersion: versionOf(published),
      versions: { draft: versionOf(draft), published: versionOf(published) },
      fingerprints: { draft: draftFp, published: publishedFp },
      updatedOn: { draft: draftUpdated, published: publishedUpdated },
      inSync,
      bodyDiffers,
      ...(readError !== undefined ? { publishedReadFailed: true as const, publishedReadError: readError } : {}),
      switchedFromPublished: guard.switchedFromPublished,
      scopes: { draft: draft.scope ?? null, published: published?.scope ?? null },
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
        ["Published version", data.publishedReadFailed ? "(read failed)" : (data.publishedVersion ?? "")],
        ["Draft updated", data.updatedOn.draft ?? ""],
        ["Published updated", data.updatedOn.published ?? ""],
        ["Switched from PUBLISHED", data.switchedFromPublished ? "Yes" : "No"],
        ["Scope (draft / published)", `${data.scopes.draft ?? "-"} / ${data.scopes.published ?? "-"}`],
      ],
    );
    if (data.message) ui.warn(data.message);
    if (data.inSync === true && data.bodyDiffers === true) {
      ui.warn(
        "Draft and published logic are identical (fingerprint match), but the stored bodies differ (descriptions, or fields a save rewrites). The draft is still unpublished; publish to make them the same.",
      );
    } else if (data.inSync === true) {
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
