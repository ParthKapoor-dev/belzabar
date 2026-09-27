import { defineArgs, ok, type CommandModule, type CommandResult, type CommandEnvelope, type HumanPresenterHelpers } from "@belzabar/core";
import { traceMethod, type TraceData } from "../../lib/trace";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";

export type { TraceData } from "../../lib/trace";

// `belz ad trace <uuid>` — locate an AD method across every environment.
// The tracing logic lives in lib/trace.ts (shared with `belz release matrix`).

interface TraceArgs {
  uuid: string;
  spineEnv: string;
}

export const args = defineArgs({
  command: "belz ad trace",
  positionals: [
    { name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Usage: belz ad trace <uuid> [--spine <env>]" },
  ],
  flags: {
    ...AD_COMMON_FLAGS,
    spine: { type: "string", default: "nsm-dev" },
  },
});

function parseArgs(argv: string[]): TraceArgs {
  const { positionals, flags } = args.parse(argv);
  resolveAdCommon(flags, "fetch", "trace");
  return { uuid: positionals.uuid, spineEnv: flags.spine };
}

async function execute(args: TraceArgs): Promise<CommandResult<TraceData>> {
  return ok<TraceData>(await traceMethod(args));
}

function presentHuman(envelope: CommandEnvelope<TraceData>, ui: HumanPresenterHelpers): void {
  const d = envelope.data!;
  ui.success(`Trace: ${d.name} (${d.category || "uncategorized"})`);
  ui.kv("UUID", d.uuid);
  ui.kv("Spine env", `${d.spineEnv} (${d.spine.length} versions)`);

  if (d.warnings.length > 0) {
    ui.section("Warnings");
    for (const w of d.warnings) ui.warn(w);
  }

  ui.section("Environments");
  ui.table(
    ["Env", "Version", "Changed", "Spine pos", "Status"],
    d.environments.map((r) => [
      r.env,
      r.version ?? "—",
      r.changedAt ? new Date(r.changedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—",
      r.spinePos >= 0 ? `#${r.spinePos} (v${r.spineVersion})` : "—",
      r.status + (r.note ? ` — ${r.note}` : ""),
    ]),
  );

  ui.section(`Dev spine (${d.spineEnv})`);
  if (d.spine.length === 0) {
    ui.text("(no version history)");
  } else {
    ui.table(
      ["#", "Version", "Published", "Steps", "Hash", "Added"],
      d.spine.map((s) => [
        s.index,
        s.version,
        s.isPublished ? "yes" : "draft",
        s.stepCount,
        s.hash,
        new Date(s.addedWhen).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      ]),
    );
  }
}

const command: CommandModule<TraceArgs, TraceData> = {
  schema: "ad.trace",
  version: "1.0",
  parseArgs,
  execute,
  presentHuman,
};
export default command;
