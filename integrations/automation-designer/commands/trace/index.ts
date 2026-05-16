import { CliError, ok, Config, type CommandModule, type CommandResult, type CommandEnvelope, type HumanPresenterHelpers } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { fingerprintMethod, parseVersionBody } from "../../lib/fingerprint";

// `belz ad trace <uuid>` — locate an AD method across every environment.
//
// The DEV version history is the canonical "spine": a totally-ordered list of
// content states. Each environment is a pointer into that spine, found by
// fingerprinting the env's latest-published version and matching it to a spine
// entry. This answers "which change of this method has reached which env" —
// the foundation of release collision/leak detection.
//
// AD chain UUIDs are stable across environments, so a single UUID resolves
// everywhere. (PD pages are not — see `belz pd trace`.)

interface TraceArgs {
  uuid: string;
  spineEnv: string;
}

interface SpineEntry {
  index: number;
  version: number;
  methodVersionID: string;
  isPublished: boolean;
  addedBy: number;
  addedWhen: string;
  stepCount: number;
  hash: string;
}

interface EnvRow {
  env: string;
  ok: boolean;
  /** Latest published version number on this env (env-local; not comparable across envs). */
  version: number | null;
  changedAt: string | null;
  hash: string | null;
  /** Index into the spine, or -1 when the env content matches no spine entry. */
  spinePos: number;
  spineVersion: number | null;
  status: "latest" | "behind" | "ahead-or-diverged" | "missing" | "error";
  note?: string;
}

export interface TraceData {
  uuid: string;
  name: string;
  category: string;
  spineEnv: string;
  spine: SpineEntry[];
  environments: EnvRow[];
  warnings: string[];
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

// Run async jobs with a concurrency cap so a long history doesn't open dozens
// of sockets at once.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function execute(args: TraceArgs): Promise<CommandResult<TraceData>> {
  const allEnvs = Object.keys(Config.getAllEnvs());
  if (!allEnvs.includes(args.spineEnv)) {
    throw new CliError(`Unknown spine env '${args.spineEnv}'. Available: ${allEnvs.join(", ")}`, {
      code: "UNKNOWN_ENV",
    });
  }

  const original = Config.activeEnv.name;
  const warnings: string[] = [];

  try {
    // ── 1. Build the spine from the dev (spineEnv) version history. ──
    Config.setActiveEnv(args.spineEnv);
    const current = await adApi.fetchMethod(args.uuid, "v1");
    const category = current.category?.name ?? "";
    const methodName = current.name;

    // Published timeline only — drafts are dev-only in-progress edits, never
    // promotable. includeDraft must match between spine and env rows below:
    // the flag changes the body historyGet returns for a given version.
    const versionList = (await adApi.historyListAll(args.uuid, { includeDraft: false }))
      .filter((v) => v.isPublished);
    versionList.sort((a, b) => a.methodVersion - b.methodVersion);

    const spine: SpineEntry[] = await mapLimit(versionList, 6, async (v) => {
      const full = await adApi.historyGet({
        category,
        methodName,
        version: v.methodVersion,
        includeDraft: false,
      });
      const parsed = parseVersionBody(full);
      return {
        index: 0, // assigned below
        version: v.methodVersion,
        methodVersionID: v.methodVersionID,
        isPublished: v.isPublished,
        addedBy: v.addedBy,
        addedWhen: v.addedWhen,
        stepCount: parsed.parsedSteps.length,
        hash: fingerprintMethod(parsed),
      };
    });
    spine.forEach((s, i) => (s.index = i));

    if (spine.length === 0) {
      warnings.push(`No version history on ${args.spineEnv} — cannot build a spine; environment positions are unknown.`);
    }

    // hash → spine indices (a hash can recur if a change was reverted).
    const hashIndex = new Map<string, number[]>();
    for (const s of spine) {
      const arr = hashIndex.get(s.hash) ?? [];
      arr.push(s.index);
      hashIndex.set(s.hash, arr);
    }
    const lastIndex = spine.length - 1;

    // ── 2. Fingerprint every environment's latest-published version. ──
    // Env rows go through the SAME history path as the spine (historyGet +
    // parseVersionBody). parseV1 and parseV2 populate the semantic fields
    // differently enough that mixing a live V1 response with a V2 history
    // spine yields false "diverged" — so both sides must use one path.
    // An env whose history service is unavailable is reported as `error`
    // rather than guessed at.
    const environments: EnvRow[] = [];
    for (const envName of allEnvs) {
      try {
        Config.setActiveEnv(envName);
        const list = await adApi.historyListAll(args.uuid, { includeDraft: false });
        const published = list
          .filter((v) => v.isPublished)
          .sort((a, b) => a.methodVersion - b.methodVersion);
        const head = published[published.length - 1] ?? null;

        if (!head) {
          environments.push({
            env: envName, ok: true, version: null, changedAt: null, hash: null,
            spinePos: -1, spineVersion: null, status: "missing",
            note: "no published version on this env",
          });
          continue;
        }

        const full = await adApi.historyGet({
          category, methodName, version: head.methodVersion, includeDraft: false,
        });
        const hash = fingerprintMethod(parseVersionBody(full));
        const positions = hashIndex.get(hash) ?? [];
        const spinePos = positions.length ? positions[positions.length - 1]! : -1;

        let status: EnvRow["status"];
        if (spinePos === -1) status = "ahead-or-diverged";
        else if (spinePos === lastIndex) status = "latest";
        else status = "behind";

        environments.push({
          env: envName, ok: true,
          version: head.methodVersion,
          changedAt: head.addedWhen,
          hash,
          spinePos,
          spineVersion: spinePos >= 0 ? spine[spinePos]!.version : null,
          status,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const missing = /404|not found/i.test(msg);
        environments.push({
          env: envName, ok: false, version: null, changedAt: null, hash: null,
          spinePos: -1, spineVersion: null,
          status: missing ? "missing" : "error",
          note: msg,
        });
      }
    }

    // Sanity: the spine env's own row should land on the spine.
    const spineRow = environments.find((r) => r.env === args.spineEnv);
    if (spineRow && spineRow.ok && spineRow.spinePos === -1 && spine.length > 0) {
      warnings.push(
        `The spine env (${args.spineEnv}) did not match its own history — fingerprinting may be inconsistent for this method.`,
      );
    }

    return ok<TraceData>({
      uuid: args.uuid,
      name: methodName,
      category,
      spineEnv: args.spineEnv,
      spine,
      environments,
      warnings,
    });
  } finally {
    Config.setActiveEnv(original);
  }
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
