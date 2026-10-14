import {
  CliError, defineArgs, ok,
  type CommandModule, type CommandResult, type CommandContext,
  type CommandEnvelope, type HumanPresenterHelpers,
} from "@belzabar/core";
import { loadRelease, saveProdSnapshot, type ProdSnapshot, type ProdSnapshotItem } from "../../lib/ledger";

// `wi-impl release freeze <name>` — record a prod snapshot for a release.
//
// Production is not queryable, so prod state is captured indirectly: when a
// release is pushed, each item's then-current STAGE position is frozen into
// the ledger as the prod pointer. Run `wi-impl release matrix` first (it writes
// the release record); run `freeze` right after the prod push.
//
// An item whose stage cell is absent or a trace error is a MISS, recorded as
// stageStatus "unknown" plus a warning, so it stays distinguishable from "not
// on stage". If every item misses, nothing real would be frozen:
// FREEZE_NO_STAGE_DATA. An existing snapshot needs --force.

interface FreezeArgs {
  name: string;
  force: boolean;
}

export const args = defineArgs({
  command: "wi-impl release freeze",
  positionals: [
    { name: "name", required: true, missingCode: "MISSING_NAME", missingMessage: "Usage: wi-impl release freeze <release-name> [--force]" },
  ],
  flags: {
    force: { type: "boolean" },
  },
});

function parseArgs(argv: string[]): FreezeArgs {
  const { positionals, flags } = args.parse(argv);
  return { name: positionals.name, force: flags.force };
}

function execute(args: FreezeArgs, context: CommandContext): CommandResult<ProdSnapshot> {
  const release = loadRelease(args.name);
  if (!release) {
    throw new CliError(
      `No saved release '${args.name}'. Run 'wi-impl release matrix <release.json>' first.`,
      { code: "RELEASE_NOT_FOUND" },
    );
  }

  const stageEnv = release.stageEnv;
  if (release.items.length === 0) {
    throw new CliError(`Release '${release.name}' has no AD items to freeze.`, {
      code: "FREEZE_NO_STAGE_DATA",
      details: { release: release.name, items: 0 },
    });
  }

  const warnings: string[] = [];
  const items: ProdSnapshotItem[] = release.items.map((it) => {
    const stage = it.envs.find((e) => e.env === stageEnv);
    if (!stage || stage.status === "error") {
      warnings.push(
        `${it.name} (${it.uuid}): no ${stageEnv} data${stage ? " (trace error)" : ""} — recorded as unknown.`,
      );
      return { uuid: it.uuid, name: it.name, spinePos: -1, spineVersion: null, stageStatus: "unknown", hash: null };
    }
    return {
      uuid: it.uuid,
      name: it.name,
      spinePos: stage.spinePos,
      spineVersion: stage.spineVersion,
      stageStatus: stage.status,
      hash: null,
    };
  });

  if (warnings.length === items.length) {
    throw new CliError(
      `No item of release '${release.name}' has ${stageEnv} data, so there is nothing to freeze. ` +
        `Re-run 'wi-impl release matrix' once ${stageEnv} is reachable.`,
      { code: "FREEZE_NO_STAGE_DATA", details: { release: release.name, stageEnv, missing: warnings.length } },
    );
  }

  const snapshot: ProdSnapshot = {
    release: release.name,
    frozenAt: new Date().toISOString(),
    capturedFrom: stageEnv,
    items,
    warnings,
  };

  const path = saveProdSnapshot(snapshot, { force: args.force });
  for (const w of warnings) context.warn(w);
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
      i.spinePos >= 0 ? `#${i.spinePos} (v${i.spineVersion})` : i.stageStatus === "unknown" ? "unknown (no stage data)" : `not on stage (${i.stageStatus})`,
    ]),
  );
}

const command: CommandModule<FreezeArgs, ProdSnapshot> = {
  /** Writes the local promotion ledger (prod snapshot) only; no remote state. */
  writesLocal: true,
  parseArgs,
  execute,
  presentHuman,
};
export default command;
