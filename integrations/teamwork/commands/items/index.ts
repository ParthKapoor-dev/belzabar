import { CliError, ok } from "@belzabar/core";
import type { CommandContext, CommandResult, CommandEnvelope, HumanPresenterHelpers } from "@belzabar/core";
import { fetchTask, fetchComments } from "../../lib/api";
import { extractFromText, type ItemPattern, type PdKind } from "../../lib/extract";
import type { TeamworkComment } from "../../lib/types";

// `belz tw items` — the release-prep "linker". Pulls a ticket (and its subtask
// comments), parses every comment for AD/PD/SQL references, and emits a deduped
// item set with provenance plus a recommended set drawn from the latest
// dev-note block. This replaces the manual Stage 2 grep in agents/release-prep.

interface ItemsArgs {
  taskId: number;
}

/** Where a reference was seen — so an agent can audit/override the recommendation. */
interface Occurrence {
  unit: string; // "description" | "comment #<id>" | "subtask <id> comment #<id>"
  date: string | null;
  author: string;
  pattern: ItemPattern;
}

interface AdRef {
  uuid: string;
  category: string | null;
  occurrences: Occurrence[];
}

interface PdRef {
  key: string; // hex id or symbol name
  kinds: PdKind[]; // every kind this key was seen as (draft/published/symbol)
  versionRanges: string[];
  occurrences: Occurrence[];
}

interface SqlRef {
  statement: string;
  kind: "ddl" | "dml";
  unit: string;
  date: string | null;
}

interface DevNoteBlock {
  unit: string;
  date: string | null;
  author: string;
  ad: string[];
  pd: string[];
}

export interface ItemsData {
  taskId: number;
  taskName: string;
  url: string;
  scanned: { comments: number; subtasks: number; subtaskComments: number };
  ad: AdRef[];
  pd: PdRef[];
  sql: { db: SqlRef[]; corrective: SqlRef[] };
  devNoteBlocks: DevNoteBlock[];
  recommended: { ad: string[]; pd: string[]; db: string[]; corrective: string[]; basedOn: string[] };
  warnings: string[];
}

// A single piece of scanned text with its provenance.
interface TextUnit {
  label: string;
  date: string | null;
  author: string;
}

function parseTaskId(input: string): number {
  const urlMatch = input.match(/\/tasks\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1]!, 10);
  const num = parseInt(input, 10);
  if (isNaN(num)) {
    throw new CliError(`Invalid task ID: '${input}'. Provide a numeric ID or Teamwork task URL.`, {
      code: "INVALID_TASK_ID",
    });
  }
  return num;
}

export const schema = "tw.items";
export const version = "1.0";

export function parseArgs(args: string[], _context: CommandContext): ItemsArgs {
  if (args.length === 0) {
    throw new CliError("Missing required argument: <taskId|url>", { code: "MISSING_ARG" });
  }
  return { taskId: parseTaskId(args[0]!) };
}

export async function execute(args: ItemsArgs, _context: CommandContext): Promise<CommandResult<ItemsData>> {
  const task = await fetchTask(args.taskId);

  // Fetch parent comments + every subtask's comments in parallel. Dev notes
  // with the real ID lists often live in BE/FE/QA subtasks, not the parent.
  const [parentComments, subtaskCommentSets] = await Promise.all([
    fetchComments(args.taskId),
    Promise.all(
      task.subtasks.map(async (st) => ({ subtask: st, comments: await fetchComments(st.id) })),
    ),
  ]);

  // ── Assemble scanned text units, oldest-first (date order matters for
  //    "latest dev-note block" selection). ──
  const units: { unit: TextUnit; text: string; isDevNote: boolean }[] = [];

  const ad = new Map<string, AdRef>();
  const pd = new Map<string, PdRef>();
  const db: SqlRef[] = [];
  const corrective: SqlRef[] = [];
  const devNoteBlocks: DevNoteBlock[] = [];

  function ingest(unit: TextUnit, text: string): void {
    if (!text || !text.trim()) return;
    const ex = extractFromText(text);

    for (const r of ex.ad) {
      let ref = ad.get(r.uuid);
      if (!ref) {
        ref = { uuid: r.uuid, category: r.category, occurrences: [] };
        ad.set(r.uuid, ref);
      }
      if (!ref.category && r.category) ref.category = r.category;
      ref.occurrences.push({ unit: unit.label, date: unit.date, author: unit.author, pattern: r.pattern });
    }

    for (const r of ex.pd) {
      let ref = pd.get(r.key);
      if (!ref) {
        ref = { key: r.key, kinds: [], versionRanges: [], occurrences: [] };
        pd.set(r.key, ref);
      }
      if (!ref.kinds.includes(r.kind)) ref.kinds.push(r.kind);
      if (r.versionRange && !ref.versionRanges.includes(r.versionRange)) ref.versionRanges.push(r.versionRange);
      ref.occurrences.push({ unit: unit.label, date: unit.date, author: unit.author, pattern: r.pattern });
    }

    for (const s of ex.sql) {
      const target = s.kind === "ddl" ? db : corrective;
      if (!target.some((e) => e.statement === s.statement)) {
        target.push({ statement: s.statement, kind: s.kind, unit: unit.label, date: unit.date });
      }
    }

    // A unit counts as a dev-note block if it carries a labeled list, or both
    // AD and PD references, or 2+ references of one kind — the shapes the
    // release-prep skill calls an "Items to move" / "Published Id" block.
    const adCount = ex.ad.length;
    const pdCount = ex.pd.length;
    const isDevNote =
      ex.hasLabeledList || (adCount > 0 && pdCount > 0) || adCount >= 2 || pdCount >= 2;
    units.push({ unit, text, isDevNote });

    if (isDevNote) {
      devNoteBlocks.push({
        unit: unit.label,
        date: unit.date,
        author: unit.author,
        ad: dedupe(ex.ad.map((r) => r.uuid)),
        pd: dedupe(ex.pd.map((r) => r.key)),
      });
    }
  }

  // Task description first (treated as oldest).
  ingest({ label: "description", date: task.createdAt, author: "", text: "" } as TextUnit, task.description);

  for (const c of parentComments) {
    ingest(commentUnit(`comment #${c.id}`, c), c.body);
  }
  let subtaskCommentCount = 0;
  for (const { subtask, comments } of subtaskCommentSets) {
    subtaskCommentCount += comments.length;
    for (const c of comments) {
      ingest(commentUnit(`subtask ${subtask.id} comment #${c.id}`, c), c.body);
    }
  }

  // ── Recommended set: prefer the LATEST dev-note block (release-prep Stage 2
  //    "prefer the latest dev-note block" lesson). Fall back per-type so an
  //    AD-only final note still picks up PD from the last PD-bearing note. ──
  const warnings: string[] = [];
  const recommended = pickRecommended(devNoteBlocks, warnings);

  const sortedAd = [...ad.values()].sort((a, b) => a.uuid.localeCompare(b.uuid));
  const sortedPd = [...pd.values()].sort((a, b) => a.key.localeCompare(b.key));

  // Surface PD draft-only references — they must be resolved to published
  // deployables before they can go in release-items.txt.
  const draftOnly = sortedPd.filter((p) => p.kinds.length === 1 && p.kinds[0] === "draft");
  if (draftOnly.length > 0) {
    warnings.push(
      `${draftOnly.length} PD reference(s) seen only as draft page URLs — resolve to published IDs via 'belz pd show'.`,
    );
  }
  if (sortedAd.length === 0 && sortedPd.length === 0) {
    warnings.push("No AD/PD references found in this ticket. If items exist, they were not pasted into comments.");
  }

  const data: ItemsData = {
    taskId: args.taskId,
    taskName: task.name,
    url: `https://projects.webintensive.com/app/tasks/${args.taskId}`,
    scanned: {
      comments: parentComments.length,
      subtasks: task.subtasks.length,
      subtaskComments: subtaskCommentCount,
    },
    ad: sortedAd,
    pd: sortedPd,
    sql: { db, corrective },
    devNoteBlocks,
    recommended: {
      ...recommended,
      db: dedupe(db.map((s) => s.statement)),
      corrective: dedupe(corrective.map((s) => s.statement)),
    },
    warnings,
  };

  return ok(data);
}

function commentUnit(label: string, c: TeamworkComment): TextUnit {
  return { label, date: c.postedDateTime, author: c.postedByName };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

function timeOf(date: string | null): number {
  return date ? new Date(date).getTime() : 0;
}

/** Choose AD/PD from the latest dev-note block, per-type fallback. */
function pickRecommended(
  blocks: DevNoteBlock[],
  warnings: string[],
): { ad: string[]; pd: string[]; basedOn: string[] } {
  if (blocks.length === 0) {
    warnings.push("No dev-note block detected — review the per-reference list manually.");
    return { ad: [], pd: [], basedOn: [] };
  }
  const byDate = [...blocks].sort((a, b) => timeOf(a.date) - timeOf(b.date));
  const lastAd = [...byDate].reverse().find((b) => b.ad.length > 0);
  const lastPd = [...byDate].reverse().find((b) => b.pd.length > 0);
  const basedOn = dedupe([lastAd?.unit, lastPd?.unit].filter(Boolean) as string[]);

  if (blocks.length > 1) {
    warnings.push(
      `${blocks.length} dev-note blocks found — recommended set taken from the latest (${basedOn.join(", ") || "n/a"}). Verify against earlier blocks; rewritten approaches leave stale ID lists.`,
    );
  }
  return { ad: lastAd?.ad ?? [], pd: lastPd?.pd ?? [], basedOn };
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
