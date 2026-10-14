// Ticket → release items. Pulls a ticket (and its subtask comments), parses
// every comment for AD/PD/SQL references, and returns a deduped item set with
// provenance plus a recommended set drawn from the latest dev-note block.
// Used by `wi-impl tw items` and `wi-impl release matrix`.

import { fetchTask, fetchComments } from "./api";
import { teamworkTaskUrl } from "./auth";
import { extractFromText, type ItemPattern, type PdKind } from "./extract";
import type { TeamworkComment } from "./types";

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

export async function extractTicketItems(taskId: number): Promise<ItemsData> {
  const task = await fetchTask(taskId);

  // Fetch parent comments + every subtask's comments in parallel. Dev notes
  // with the real ID lists often live in BE/FE/QA subtasks, not the parent.
  const [parentComments, subtaskCommentSets] = await Promise.all([
    fetchComments(taskId),
    Promise.all(
      task.subtasks.map(async (st) => ({ subtask: st, comments: await fetchComments(st.id) })),
    ),
  ]);

  // ── Scan text units oldest-first (date order matters for
  //    "latest dev-note block" selection). ──
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
    // usual "Items to move" / "Published Id" dev-note block.
    const adCount = ex.ad.length;
    const pdCount = ex.pd.length;
    const isDevNote =
      ex.hasLabeledList || (adCount > 0 && pdCount > 0) || adCount >= 2 || pdCount >= 2;

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
  ingest({ label: "description", date: task.createdAt, author: "" }, task.description);

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

  // ── Recommended set: prefer the LATEST dev-note block (the latest
  //    note supersedes earlier ones). Fall back per-type so an
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
      `${draftOnly.length} PD reference(s) seen only as draft page URLs — resolve to published IDs via 'wi-impl pd show'.`,
    );
  }
  if (sortedAd.length === 0 && sortedPd.length === 0) {
    warnings.push("No AD/PD references found in this ticket. If items exist, they were not pasted into comments.");
  }

  const data: ItemsData = {
    taskId: taskId,
    taskName: task.name,
    url: teamworkTaskUrl(taskId),
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

  return data;
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
