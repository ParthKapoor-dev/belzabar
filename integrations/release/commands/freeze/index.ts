import {
  CliError, ok,
  type CommandModule, type CommandResult, type CommandContext,
  type CommandEnvelope, type HumanPresenterHelpers,
} from "@belzabar/core";
import { loadRelease, saveProdSnapshot, type ProdSnapshot } from "../../lib/ledger";

// `belz release freeze <name>` — record a prod snapshot for a release.
//
// Production is not queryable, so prod state is captured indirectly: when a
// release is pushed, each item's then-current STAGE position is frozen into
// the ledger as the prod pointer. Run `belz release matrix` first (it writes
// the release record); run `freeze` right after the prod push.

interface FreezeArgs {
  name: string;
}

// Shape of the relevant slice of a saved `release matrix` record.
interface SavedRelease {
  name: string;
  stageEnv: string;
  items: {
    uuid: string;
    name: string;
    envs: { env: string; status: string; spinePos: number; spineVersion: number | null }[];
  }[];
}

function parseArgs(args: string[]): FreezeArgs {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    throw new CliError("Usage: belz release freeze <release-name>", { code: "MISSING_NAME" });
  }
  return { name };
}

function execute(args: FreezeArgs, _context: CommandContext): CommandResult<ProdSnapshot> {
  const release = loadRelease<SavedRelease>(args.name);
  if (!release) {
    throw new CliError(
      `No saved release '${args.name}'. Run 'belz release matrix <release.json>' first.`,
      { code: "RELEASE_NOT_FOUND" },
    );
  }

  const stageEnv = release.stageEnv;
  const snapshot: ProdSnapshot = {
    release: release.name,
    frozenAt: new Date().toISOString(),
    capturedFrom: stageEnv,
    items: release.items.map((it) => {
      const stage = it.envs.find((e) => e.env === stageEnv);
      return {
        uuid: it.uuid,
        name: it.name,
        spinePos: stage?.spinePos ?? -1,
        spineVersion: stage?.spineVersion ?? null,
        hash: null,
      };
    }),
  };

  const path = saveProdSnapshot(snapshot);
  return ok(snapshot, { snapshotPath: path });
}

function presentHuman(envelope: CommandEnvelope<ProdSnapshot>, ui: HumanPresenterHelpers): void {
  const s = envelope.data!;
  ui.success(`Froze prod snapshot for release '${s.release}'`);
  ui.kv("Captured from", s.capturedFrom);
  ui.kv("Frozen at", s.frozenAt);
  if (envelope.meta?.snapshotPath) ui.kv("Saved to", String(envelope.meta.snapshotPath));

  ui.section(`Items (${s.items.length})`);
  ui.table(
    ["Item", "Name", "Stage spine pos"],
    s.items.map((i) => [
      i.uuid.slice(0, 12) + "…",
      i.name,
      i.spinePos >= 0 ? `#${i.spinePos} (v${i.spineVersion})` : "not on stage",
    ]),
  );
}

const command: CommandModule<FreezeArgs, ProdSnapshot> = {
  schema: "release.freeze",
  version: "1.0",
  parseArgs,
  execute,
  presentHuman,
};
export default command;
