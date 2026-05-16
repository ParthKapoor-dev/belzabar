import {
  CliError, ok,
  type CommandModule, type CommandResult, type CommandContext,
  type CommandEnvelope, type HumanPresenterHelpers,
} from "@belzabar/core";
import { readFileSync, existsSync } from "fs";
import traceCommand, { type TraceData } from "../../../automation-designer/commands/trace/index";
import { execute as itemsExecute } from "../../../teamwork/commands/items/index";
import { saveRelease } from "../../lib/ledger";

// `belz release matrix <release.json>` — the release collision/leak detector.
//
// Given a release spec (included + excluded ticket lists), it runs the linker
// (`tw items`) for every ticket and the tracer (`ad trace`) for every AD item,
// then reports:
//   - which AD items each ticket touches,
//   - where each item sits on every environment's spine,
//   - COLLISIONS: AD items shared by an included and an excluded ticket — the
//     exact failure mode where shipping the included ticket drags the excluded
//     ticket's edits along,
//   - per collision, whether the excluded change has already LEAKED to stage.
//
// AD-only for now: PD items are listed per ticket but not traced (PD pages are
// not name-resolvable across envs — see plan).

interface ReleaseSpec {
  name: string;
  included: string[];
  excluded: string[];
  spineEnv?: string;
  stageEnv?: string;
}

interface MatrixArgs {
  specPath: string;
}

type TicketKind = "included" | "excluded";

interface TicketRow {
  id: number;
  name: string;
  kind: TicketKind;
  ad: string[];
  pd: string[];
  error?: string;
}

interface ItemEnvCell {
  env: string;
  status: string;
  spinePos: number;
  spineVersion: number | null;
}

interface ItemRow {
  uuid: string;
  name: string;
  category: string;
  kind: TicketKind | "both";
  tickets: number[];
  spineLen: number;
  envs: ItemEnvCell[];
  error?: string;
}

interface Collision {
  uuid: string;
  name: string;
  includedTickets: number[];
  excludedTickets: number[];
  leak: "leaked" | "clean" | "unknown";
  detail: string;
}

interface MatrixData {
  name: string;
  generatedAt: string;
  spineEnv: string;
  stageEnv: string;
  tickets: TicketRow[];
  items: ItemRow[];
  collisions: Collision[];
  pdNote: string;
  warnings: string[];
}

function parseTaskId(input: string): number {
  const m = String(input).match(/\/tasks\/(\d+)/);
  if (m) return parseInt(m[1]!, 10);
  const n = parseInt(String(input), 10);
  if (Number.isNaN(n)) throw new CliError(`Invalid ticket reference: '${input}'`, { code: "BAD_TICKET" });
  return n;
}

function parseArgs(args: string[]): MatrixArgs {
  const specPath = args.find((a) => !a.startsWith("-"));
  if (!specPath) {
    throw new CliError(
      "Usage: belz release matrix <release.json>\n\n" +
        'release.json: { "name": "...", "included": [ids], "excluded": [ids], "spineEnv"?, "stageEnv"? }',
      { code: "MISSING_SPEC" },
    );
  }
  return { specPath };
}

async function execute(args: MatrixArgs, context: CommandContext): Promise<CommandResult<MatrixData>> {
  if (!existsSync(args.specPath)) {
    throw new CliError(`Release spec not found: ${args.specPath}`, { code: "SPEC_NOT_FOUND" });
  }
  let spec: ReleaseSpec;
  try {
    spec = JSON.parse(readFileSync(args.specPath, "utf-8")) as ReleaseSpec;
  } catch (e) {
    throw new CliError(`Could not parse ${args.specPath}: ${e instanceof Error ? e.message : e}`, {
      code: "BAD_SPEC",
    });
  }
  if (!spec.name || !Array.isArray(spec.included) || !Array.isArray(spec.excluded)) {
    throw new CliError("Release spec needs { name, included[], excluded[] }.", { code: "BAD_SPEC" });
  }

  const spineEnv = spec.spineEnv ?? "nsm-dev";
  const stageEnv = spec.stageEnv ?? "nsm-stage";
  const warnings: string[] = [];

  // ── 1. Link every ticket → its items (parallel; teamwork auth, no Config). ──
  const ticketSpecs: { id: number; kind: TicketKind }[] = [
    ...spec.included.map((t) => ({ id: parseTaskId(t), kind: "included" as const })),
    ...spec.excluded.map((t) => ({ id: parseTaskId(t), kind: "excluded" as const })),
  ];

  const tickets: TicketRow[] = await Promise.all(
    ticketSpecs.map(async ({ id, kind }): Promise<TicketRow> => {
      try {
        const res = await itemsExecute({ taskId: id }, context);
        if (!res.ok) return { id, kind, name: "(error)", ad: [], pd: [], error: res.error.message };
        const d = res.data;
        return { id, kind, name: d.taskName, ad: d.recommended.ad, pd: d.recommended.pd };
      } catch (e) {
        return { id, kind, name: "(error)", ad: [], pd: [], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  // ── 2. Map AD items → referencing tickets. ──
  const itemTickets = new Map<string, { included: Set<number>; excluded: Set<number> }>();
  for (const t of tickets) {
    for (const uuid of t.ad) {
      let entry = itemTickets.get(uuid);
      if (!entry) {
        entry = { included: new Set(), excluded: new Set() };
        itemTickets.set(uuid, entry);
      }
      entry[t.kind].add(t.id);
    }
  }

  // ── 3. Trace every unique AD item. SEQUENTIAL — `ad trace` mutates the
  //       global active env, so concurrent traces would race. ──
  const items: ItemRow[] = [];
  for (const [uuid, refs] of itemTickets) {
    const kind: ItemRow["kind"] =
      refs.included.size > 0 && refs.excluded.size > 0 ? "both"
      : refs.included.size > 0 ? "included" : "excluded";
    const ticketIds = [...refs.included, ...refs.excluded].sort((a, b) => a - b);
    try {
      const res = (await traceCommand.execute({ uuid, spineEnv }, context)) as CommandResult<TraceData>;
      if (!res.ok) {
        items.push({ uuid, name: "(trace error)", category: "", kind, tickets: ticketIds, spineLen: 0, envs: [], error: res.error.message });
        continue;
      }
      const d = res.data;
      items.push({
        uuid,
        name: d.name,
        category: d.category,
        kind,
        tickets: ticketIds,
        spineLen: d.spine.length,
        envs: d.environments.map((e) => ({
          env: e.env, status: e.status, spinePos: e.spinePos, spineVersion: e.spineVersion,
        })),
      });
    } catch (e) {
      items.push({ uuid, name: "(trace error)", category: "", kind, tickets: ticketIds, spineLen: 0, envs: [], error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── 4. Collisions = AD items shared by an included AND an excluded ticket. ──
  const collisions: Collision[] = [];
  for (const item of items) {
    if (item.kind !== "both") continue;
    const refs = itemTickets.get(item.uuid)!;
    const stage = item.envs.find((e) => e.env === stageEnv);

    let leak: Collision["leak"] = "unknown";
    let detail: string;
    if (item.error) {
      detail = `Trace failed — leak status unknown (${item.error}).`;
    } else if (!stage) {
      detail = `No '${stageEnv}' environment configured — cannot check leak.`;
    } else if (stage.status === "latest") {
      leak = "leaked";
      detail = `${stageEnv} holds the newest spine content — the excluded ticket's edits to this item have reached stage.`;
    } else if (stage.status === "behind") {
      leak = "clean";
      detail = `${stageEnv} is behind dev (spine #${stage.spinePos}) — excluded edits not yet on stage.`;
    } else {
      detail = `${stageEnv} status is '${stage.status}' — inspect manually.`;
    }

    collisions.push({
      uuid: item.uuid,
      name: item.name,
      includedTickets: [...refs.included].sort((a, b) => a - b),
      excludedTickets: [...refs.excluded].sort((a, b) => a - b),
      leak,
      detail,
    });
  }

  const pdRefs = new Set<string>();
  for (const t of tickets) for (const p of t.pd) pdRefs.add(p);
  const pdNote =
    pdRefs.size > 0
      ? `${pdRefs.size} PD reference(s) found across tickets but NOT traced — PD tracing is not yet available.`
      : "No PD references found.";

  if (collisions.some((c) => c.leak === "leaked")) {
    warnings.push("LEAKED collision(s) detected — an excluded ticket's change is already on stage.");
  }
  for (const t of tickets) if (t.error) warnings.push(`Ticket #${t.id} could not be linked: ${t.error}`);

  const data: MatrixData = {
    name: spec.name,
    generatedAt: new Date().toISOString(),
    spineEnv,
    stageEnv,
    tickets,
    items,
    collisions,
    pdNote,
    warnings,
  };

  const path = saveRelease(spec.name, data);
  return ok(data, { ledgerPath: path });
}

// ── Human presenter ──────────────────────────────────────────────────────────

function presentHuman(envelope: CommandEnvelope<MatrixData>, ui: HumanPresenterHelpers): void {
  const d = envelope.data!;
  ui.success(`Release matrix: ${d.name}`);
  ui.kv("Spine env", d.spineEnv);
  ui.kv("Stage env", d.stageEnv);
  if (envelope.meta?.ledgerPath) ui.kv("Saved to", String(envelope.meta.ledgerPath));

  if (d.warnings.length > 0) {
    ui.section("Warnings");
    for (const w of d.warnings) ui.warn(w);
  }

  ui.section("Tickets");
  ui.table(
    ["Ticket", "Kind", "Name", "AD", "PD"],
    d.tickets.map((t) => [
      `#${t.id}`, t.kind, t.error ? `(error: ${t.error})` : t.name, t.ad.length, t.pd.length,
    ]),
  );

  if (d.collisions.length > 0) {
    ui.section(`Collisions (${d.collisions.length}) — included ∩ excluded AD items`);
    ui.table(
      ["Item", "Name", "Included", "Excluded", "Leak"],
      d.collisions.map((c) => [
        c.uuid.slice(0, 12) + "…",
        c.name,
        c.includedTickets.map((t) => `#${t}`).join(", "),
        c.excludedTickets.map((t) => `#${t}`).join(", "),
        c.leak.toUpperCase(),
      ]),
    );
    for (const c of d.collisions) ui.text(`  ${c.name}: ${c.detail}`);
  } else {
    ui.section("Collisions");
    ui.text("None — no AD item is shared by an included and an excluded ticket.");
  }

  ui.section(`AD items (${d.items.length})`);
  const envNames = [...new Set(d.items.flatMap((i) => i.envs.map((e) => e.env)))];
  ui.table(
    ["Item", "Name", "Kind", ...envNames],
    d.items.map((i) => [
      i.uuid.slice(0, 10) + "…",
      i.error ? `(error)` : i.name,
      i.kind,
      ...envNames.map((en) => {
        const cell = i.envs.find((e) => e.env === en);
        if (!cell) return "—";
        return cell.spinePos >= 0 ? `${cell.status} #${cell.spinePos}` : cell.status;
      }),
    ]),
  );

  ui.section("Page Designer");
  ui.text(d.pdNote);
}

const command: CommandModule<MatrixArgs, MatrixData> = {
  schema: "release.matrix",
  version: "1.0",
  parseArgs,
  execute,
  presentHuman,
};
export default command;
