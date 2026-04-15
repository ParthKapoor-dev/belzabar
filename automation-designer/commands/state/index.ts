import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";

interface StateArgs {
  uuid: string;
  apiVersion: "v1" | "v2";
}

interface StateData {
  input: { uuid: string };
  ok: boolean;
  state: "DRAFT" | "PUBLISHED" | null;
  draftUuid: string | null;
  publishedUuid: string | null;
  draftVersion: number | null;
  publishedVersion: number | null;
  switchedFromPublished: boolean;
  message?: string;
}

const command: CommandModule<StateArgs, StateData> = {
  schema: "ad.state",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "fetch", "state");
    emitFallbackWarning(common, "state");
    const uuid = rest[0];
    if (!uuid || uuid.startsWith("-")) {
      throw new CliError("Missing UUID argument.", { code: "MISSING_UUID" });
    }
    return { uuid, apiVersion: common.apiVersion.version };
  },
  async execute({ uuid, apiVersion }) {
    // First fetch to see state immediately — needed for the UNRESOLVED case.
    const initial = await adApi.fetchMethod(uuid, apiVersion);
    const initialState = initial.state;

    // Try to resolve the full draft/published pair via the guard.
    const guard = await resolveDraftTarget(uuid, apiVersion);

    if (!guard.ok) {
      return ok<StateData>({
        input: { uuid },
        ok: false,
        state: initialState,
        draftUuid: null,
        publishedUuid: guard.publishedUuid,
        draftVersion: null,
        publishedVersion: typeof initial.version === "number" ? initial.version : null,
        switchedFromPublished: false,
        message: guard.message,
      });
    }

    const draft = guard.draft;
    let publishedVersion: number | null = null;
    if (guard.publishedUuid && guard.publishedUuid !== draft.uuid) {
      try {
        const pub = await adApi.fetchMethod(guard.publishedUuid, apiVersion);
        publishedVersion = typeof pub.version === "number" ? pub.version : null;
      } catch {
        publishedVersion = null;
      }
    }

    return ok<StateData>({
      input: { uuid },
      ok: true,
      state: initialState,
      draftUuid: draft.uuid,
      publishedUuid: guard.publishedUuid,
      draftVersion: typeof draft.version === "number" ? draft.version : null,
      publishedVersion,
      switchedFromPublished: guard.switchedFromPublished,
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
    if (data.draftVersion != null && data.publishedVersion != null) {
      if (data.draftVersion > data.publishedVersion) {
        ui.warn(`Draft is ahead of published (v${data.draftVersion} > v${data.publishedVersion}). Re-publish to sync.`);
      } else if (data.draftVersion === data.publishedVersion) {
        ui.success("Draft and published versions are in sync.");
      }
    }
  },
};

export default command;
