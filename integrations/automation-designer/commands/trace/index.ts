import { CliError, ok, type CommandModule, type CommandResult, type CommandEnvelope, type HumanPresenterHelpers } from "@belzabar/core";
import { traceMethod, type TraceData } from "../../lib/trace";

export type { TraceData } from "../../lib/trace";

// `belz ad trace <uuid>` — locate an AD method across every environment.
// The tracing logic lives in lib/trace.ts (shared with `belz release matrix`).

interface TraceArgs {
  uuid: string;
  spineEnv: string;
}

function parseArgs(args: string[]): TraceArgs {
  const rest: string[] = [];
  let spineEnv = "nsm-dev";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--spine") {
      spineEnv = args[++i] ?? spineEnv;
    } else {
      rest.push(args[i]!);
    }
  }
  const uuid = rest[0];
  if (!uuid || uuid.startsWith("-")) {
    throw new CliError("Usage: belz ad trace <uuid> [--spine <env>]", { code: "MISSING_UUID" });
  }
  return { uuid, spineEnv };
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
