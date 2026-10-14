import { defineArgs, ok, type CommandContext, type CommandModule, type CommandResult, type CommandEnvelope, type HumanPresenterHelpers } from "@belzabar/core";
import { traceMethod, type TraceData } from "../../lib/trace";

export type { TraceData } from "../../lib/trace";

// `wi-impl ad trace <uuid>` — locate an AD method across every environment.
// The tracing logic lives in lib/trace.ts (shared with `wi-impl release matrix`).

interface TraceArgs {
  uuid: string;
  /** Explicit --spine; default: the active env. */
  spineEnv?: string;
  envs?: string[];
}

export const args = defineArgs({
  command: "wi-impl ad trace",
  positionals: [
    { name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Usage: wi-impl ad trace <uuid> [--spine <env>] [--envs a,b]" },
  ],
  flags: {
    spine: { type: "string" },
    envs: { type: "string" },
  },
});

function parseArgs(argv: string[]): TraceArgs {
  const { positionals, flags } = args.parse(argv);
  const envs = flags.envs
    ?.split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  return { uuid: positionals.uuid, spineEnv: flags.spine, ...(envs && envs.length ? { envs } : {}) };
}

async function execute(args: TraceArgs, context: CommandContext): Promise<CommandResult<TraceData>> {
  return ok<TraceData>(
    await traceMethod({ uuid: args.uuid, spineEnv: args.spineEnv ?? context.env.name, envs: args.envs }),
  );
}

function presentHuman(envelope: CommandEnvelope<TraceData>, ui: HumanPresenterHelpers): void {
  const d = envelope.data!;
  ui.success(`Trace: ${d.name} (${d.category || "uncategorized"})`);
  ui.kv("UUID", d.uuid + (d.inputUuid !== d.uuid ? ` (from draft ${d.inputUuid})` : ""));
  ui.kv("Envs", d.envs.join(", "));
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
  parseArgs,
  execute,
  presentHuman,
};
export default command;
