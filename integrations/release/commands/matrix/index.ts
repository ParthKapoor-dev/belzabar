import {
  CliError, defineArgs, failWithData, ok,
  type CommandModule, type CommandResult, type CommandContext,
  type CommandEnvelope, type HumanPresenterHelpers,
} from "@belzabar/core";
import { traceMethod } from "@belzabar/ad/lib/trace";
import { extractTicketItems } from "@belzabar/teamwork/lib/items";
import { parseTaskId } from "@belzabar/teamwork/lib/task-id";
import { assertReleaseSlotFree, saveRelease } from "../../lib/ledger";
import { loadReleaseSpec, resolveReleaseEnvs, type ReleaseSpec } from "../../lib/spec";

// `wi-impl release matrix <release.json>` — the release collision/leak detector.
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
// AD only: PD items are listed per ticket but not traced (PD pages are not
// name-resolvable across envs).

interface MatrixArgs {
  specPath: string;
}

type TicketKind = "included" | "excluded";

interface TicketRow {
  id: number;
  name: string;
  kind: TicketKind;
  ad: string[];
  /**
   * Where `ad` came from: the latest dev-note block, or every AD
   * reference on the ticket (excluded tickets always; included tickets when
   * no dev-note block lists AD items).
   */
  adSource: "dev-note" | "all-refs";
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

export interface MatrixData {
  name: string;
  generatedAt: string;
  /** Project whose envs were used: spec.project, the spec envs' project, or the active env's. */
  project: string;
  spineEnv: string;
  stageEnv: string;
  tickets: TicketRow[];
  items: ItemRow[];
  collisions: Collision[];
  /**
   * False when a ticket could not be linked: its items are unknown,
   * so `collisions` may be missing entries. The command then fails with
   * RELEASE_MATRIX_INCOMPLETE and writes no ledger record.
   */
  collisionsComplete: boolean;
  pdNote: string;
  warnings: string[];
}

export const args = defineArgs({
  command: "wi-impl release matrix",
  positionals: [
    {
      name: "spec",
      required: true,
      missingCode: "MISSING_SPEC",
      missingMessage:
        "Usage: wi-impl release matrix <release.json>\n\n" +
        'release.json: { "name": "...", "included": [ids], "excluded"?: [ids], "project"?, "spineEnv"?, "stageEnv"? }',
    },
  ],
});

function parseArgs(argv: string[]): MatrixArgs {
  return { specPath: args.parse(argv).positionals.spec };
}

/** Ticket refs → ids; a junk ref or an id both included and excluded is BAD_SPEC. */
function ticketIds(spec: ReleaseSpec): { id: number; kind: TicketKind }[] {
  const toId = (t: unknown, kind: TicketKind) => {
    try {
      return parseTaskId(String(t));
    } catch (e) {
      throw new CliError(`Release spec: invalid ${kind} ticket '${t}'. Use a numeric id or task URL.`, {
        code: "BAD_SPEC",
        details: { kind, ticket: t },
      });
    }
  };
  const included = spec.included.map((t) => toId(t, "included"));
  const excluded = spec.excluded.map((t) => toId(t, "excluded"));
  const both = [...new Set(included.filter((id) => excluded.includes(id)))];
  if (both.length > 0) {
    throw new CliError(`Release spec lists ticket(s) as both included and excluded: ${both.join(", ")}.`, {
      code: "BAD_SPEC",
      details: { overlap: both },
    });
  }
  return [
    ...included.map((id) => ({ id, kind: "included" as const })),
    ...excluded.map((id) => ({ id, kind: "excluded" as const })),
  ];
}

/**
 * Leak status of a colliding item: has the excluded ticket's change reached
 * stage? Only a traced stage cell at the spine head is "leaked", only one
 * strictly behind it is "clean"; everything else is "unknown".
 */
export function classifyLeak(
  item: Pick<ItemRow, "envs" | "error">,
  stageEnv: string,
): { leak: Collision["leak"]; detail: string } {
  const stage = item.envs.find((e) => e.env === stageEnv);
  if (item.error) return { leak: "unknown", detail: `Trace failed — leak status unknown (${item.error}).` };
  if (!stage) return { leak: "unknown", detail: `No '${stageEnv}' environment configured — cannot check leak.` };
  if (stage.status === "latest") {
    return {
      leak: "leaked",
      detail: `${stageEnv} holds the newest spine content — the excluded ticket's edits to this item have reached stage.`,
    };
  }
  if (stage.status === "behind") {
    return { leak: "clean", detail: `${stageEnv} is behind dev (spine #${stage.spinePos}) — excluded edits not yet on stage.` };
  }
  return { leak: "unknown", detail: `${stageEnv} status is '${stage.status}' — inspect manually.` };
}

async function execute(args: MatrixArgs, context: CommandContext): Promise<CommandResult<MatrixData>> {
  // Everything that can be wrong with the spec fails here, before any network
  // work: shape (zod), ticket refs + overlap, envs, and the ledger slot.
  const spec = loadReleaseSpec(args.specPath);
  const ticketSpecs = ticketIds(spec);
  const { project, spineEnv, stageEnv } = resolveReleaseEnvs(spec, context.env);
  assertReleaseSlotFree(spec.name);
  const warnings: string[] = [];

  // ── 1. Link every ticket → its items (parallel; teamwork auth, no Config). ──

  //    Item selection: a missed collision is the dangerous error,
  //    so an EXCLUDED ticket contributes every AD reference it mentions (a
  //    single plain AD URL forms no dev-note block). An INCLUDED ticket uses
  //    its latest dev-note block, falling back to every reference when that
  //    block lists no AD items. The linker's warnings are passed on.
  const tickets: TicketRow[] = await Promise.all(
    ticketSpecs.map(async ({ id, kind }): Promise<TicketRow> => {
      try {
        const d = await extractTicketItems(id);
        const allRefs = [...new Set(d.ad.map((r) => r.uuid))].sort();
        const useAll = kind === "excluded" || d.recommended.ad.length === 0;
        for (const w of d.warnings) warnings.push(`Ticket #${id}: ${w}`);
        return {
          id, kind, name: d.taskName,
          ad: useAll ? allRefs : d.recommended.ad,
          adSource: useAll ? "all-refs" : "dev-note",
          pd: d.recommended.pd.length > 0 ? d.recommended.pd : [...new Set(d.pd.map((r) => r.key))].sort(),
        };
      } catch (e) {
        return { id, kind, name: "(error)", ad: [], adSource: "all-refs", pd: [], error: e instanceof Error ? e.message : String(e) };
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
      const d = await traceMethod({ uuid, spineEnv });
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
    const { leak, detail } = classifyLeak(item, stageEnv);
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
  const failed = tickets.filter((t) => t.error);
  for (const t of failed) warnings.push(`Ticket #${t.id} could not be linked: ${t.error}`);
  const collisionsComplete = failed.length === 0;

  const data: MatrixData = {
    name: spec.name,
    generatedAt: new Date().toISOString(),
    project,
    spineEnv,
    stageEnv,
    tickets,
    items,
    collisions,
    collisionsComplete,
    pdNote,
    warnings,
  };

  // An unlinked ticket's items were never traced, so "no collisions"
  // would be a guess. Fail and write no ledger record — `freeze` must never
  // snapshot an incomplete audit.
  if (!collisionsComplete) {
    return failWithData(
      "RELEASE_MATRIX_INCOMPLETE",
      `${failed.length} ticket(s) could not be linked (${failed.map((t) => `#${t.id}`).join(", ")}); collisions are unknown and no ledger record was written. Fix the ticket ref(s) or retry.`,
      data,
      { details: { failedTickets: failed.map((t) => ({ id: t.id, kind: t.kind, error: t.error })) } },
    );
  }

  const path = saveRelease(spec.name, data);
  return ok(data, { ledgerPath: path });
}

// ── Human presenter ──────────────────────────────────────────────────────────

function presentHuman(envelope: CommandEnvelope<MatrixData>, ui: HumanPresenterHelpers): void {
  const d = envelope.data!;
  ui.success(`Release matrix: ${d.name}`);
  ui.kv("Project", d.project);
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
  } else if (d.collisionsComplete === false) {
    ui.section("Collisions");
    ui.warn("UNKNOWN — some tickets could not be linked, so their AD items were never compared.");
  } else {
    ui.section("Collisions");
    ui.text("None — no AD item is shared by an included and an excluded ticket.");
  }
  if (d.collisions.length > 0 && d.collisionsComplete === false) {
    ui.warn("Collision list is INCOMPLETE — some tickets could not be linked.");
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
  /** Writes the local promotion ledger (release record) only; no remote state. */
  writesLocal: true,
  parseArgs,
  execute,
  presentHuman,
};
export default command;
