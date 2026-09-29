import { defineArgs, ok } from "@belzabar/core";
import { parseTaskId, TASK_ID_POSITIONAL } from "../../lib/task-id";
import type { CommandContext, CommandResult, CommandEnvelope, HumanPresenterHelpers } from "@belzabar/core";
import { extractTicketItems, type ItemsData } from "../../lib/items";

export type { ItemsData } from "../../lib/items";

// `belz tw items` — the release "linker". The extraction lives in lib/items.ts
// (shared with `belz release matrix`); this file only parses args and presents.

interface ItemsArgs {
  taskId: number;
}

export const args = defineArgs({
  command: "belz tw items",
  positionals: [TASK_ID_POSITIONAL],
});

export function parseArgs(argv: string[], _context?: CommandContext): ItemsArgs {
  const { positionals } = args.parse(argv);
  return { taskId: parseTaskId(positionals.taskId) };
}

export async function execute(args: ItemsArgs, _context: CommandContext): Promise<CommandResult<ItemsData>> {
  return ok(await extractTicketItems(args.taskId));
}

// ── Human presenter ──────────────────────────────────────────────────────────

export function presentHuman(envelope: CommandEnvelope<ItemsData>, ui: HumanPresenterHelpers): void {
  const d = envelope.data!;

  ui.success(`Linked items for task #${d.taskId} — ${d.taskName}`);
  ui.kv("Scanned", `${d.scanned.comments} comments, ${d.scanned.subtasks} subtasks (${d.scanned.subtaskComments} subtask comments)`);

  if (d.warnings.length > 0) {
    ui.section("Warnings");
    for (const w of d.warnings) ui.warn(w);
  }

  ui.section("Recommended release set (latest dev-note block)");
  ui.kv("AD", d.recommended.ad.join(", ") || "—");
  ui.kv("PD", d.recommended.pd.join(", ") || "—");
  ui.kv("DB", d.recommended.db.length ? `${d.recommended.db.length} statement(s)` : "—");
  ui.kv("Corrective", d.recommended.corrective.length ? `${d.recommended.corrective.length} statement(s)` : "—");
  if (d.recommended.basedOn.length) ui.kv("Based on", d.recommended.basedOn.join(", "));

  if (d.ad.length > 0) {
    ui.section(`All AD references (${d.ad.length})`);
    ui.table(
      ["UUID", "Category", "Seen in"],
      d.ad.map((a) => [a.uuid, a.category ?? "—", a.occurrences.map((o) => o.unit).join("; ")]),
    );
  }

  if (d.pd.length > 0) {
    ui.section(`All PD references (${d.pd.length})`);
    ui.table(
      ["Key", "Kind(s)", "Version ranges", "Seen in"],
      d.pd.map((p) => [
        p.key,
        p.kinds.join(", "),
        p.versionRanges.join(", ") || "—",
        p.occurrences.map((o) => o.unit).join("; "),
      ]),
    );
  }

  if (d.sql.db.length > 0 || d.sql.corrective.length > 0) {
    ui.section("SQL (heuristic extraction — verify)");
    for (const s of d.sql.db) ui.text(`[DB]         ${s.statement}`);
    for (const s of d.sql.corrective) ui.text(`[Corrective] ${s.statement}`);
  }

  if (d.devNoteBlocks.length > 0) {
    ui.section(`Dev-note blocks (${d.devNoteBlocks.length})`);
    ui.table(
      ["Unit", "Date", "Author", "AD", "PD"],
      d.devNoteBlocks.map((b) => [
        b.unit,
        b.date ? new Date(b.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—",
        b.author,
        b.ad.length,
        b.pd.length,
      ]),
    );
  }
}
