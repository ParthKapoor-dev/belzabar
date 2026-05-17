// Structural diff between two HydratedPage objects.
//
// Shared by `pd history diff` (two versions of one page) and `pd diff` (the
// same page across two environments). The algorithm is purely structural — it
// compares variables, derived fields, HTTP calls, layout nodes, and styles —
// so it is meaningful regardless of whether the two pages come from version
// history or from different environments.

import { walkParsed } from "./parser/index";
import type { HydratedPage } from "./types/common";

export interface SetDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface StyleDiff {
  changed: boolean;
  linesAdded: number;
  linesRemoved: number;
}

export interface PageDiff {
  variables: SetDiff;
  derived: SetDiff;
  httpRequests: { added: string[]; removed: string[] };
  nodeCountBefore: number;
  nodeCountAfter: number;
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesKindChanged: Array<{ nodeId: string; before: string; after: string }>;
  styles: StyleDiff;
}

export function countNodes(page: HydratedPage): number {
  let n = 0;
  walkParsed(page.layout, () => {
    n++;
  });
  return n;
}

export function collectNodeIds(page: HydratedPage): Map<string, string> {
  const m = new Map<string, string>();
  walkParsed(page.layout, (node) => {
    m.set(node.nodeId, node.kind);
  });
  return m;
}

/** Set difference of two string arrays. `changed` is left empty for callers to fill. */
export function diffStringSets(beforeArr: string[], afterArr: string[]): SetDiff {
  const before = new Set(beforeArr);
  const after = new Set(afterArr);
  const added: string[] = [];
  const removed: string[] = [];
  for (const x of after) if (!before.has(x)) added.push(x);
  for (const x of before) if (!after.has(x)) removed.push(x);
  return { added, removed, changed: [] };
}

function diffStyles(before: string, after: string): StyleDiff {
  if (before === after) return { changed: false, linesAdded: 0, linesRemoved: 0 };
  const lines = (s: string) =>
    s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const beforeSet = new Set(lines(before));
  const afterSet = new Set(lines(after));
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const l of afterSet) if (!beforeSet.has(l)) linesAdded++;
  for (const l of beforeSet) if (!afterSet.has(l)) linesRemoved++;
  return { changed: true, linesAdded, linesRemoved };
}

/** Structural diff: `a` is the "before"/"from" page, `b` is the "after"/"to" page. */
export function diffPages(a: HydratedPage, b: HydratedPage): PageDiff {
  const variables = diffStringSets(
    a.variables.map((v) => v.name),
    b.variables.map((v) => v.name),
  );
  const varMapA = new Map(
    a.variables.map((v) => [v.name, JSON.stringify(v.initialValue)] as const),
  );
  for (const v of b.variables) {
    const prior = varMapA.get(v.name);
    if (prior !== undefined && prior !== JSON.stringify(v.initialValue)) {
      variables.changed.push(v.name);
    }
  }

  const derived = diffStringSets(
    a.derived.map((d) => d.name),
    b.derived.map((d) => d.name),
  );
  const derMapA = new Map(a.derived.map((d) => [d.name, d.spec ?? ""] as const));
  for (const d of b.derived) {
    const prior = derMapA.get(d.name);
    if (prior !== undefined && prior !== (d.spec ?? "")) derived.changed.push(d.name);
  }

  const httpDiff = diffStringSets(
    a.httpRequests.map((h) => h.callId ?? `idx:${h.index}`),
    b.httpRequests.map((h) => h.callId ?? `idx:${h.index}`),
  );

  const nodesA = collectNodeIds(a);
  const nodesB = collectNodeIds(b);
  const nodesAdded: string[] = [];
  const nodesRemoved: string[] = [];
  const nodesKindChanged: Array<{ nodeId: string; before: string; after: string }> = [];
  for (const [id, kind] of nodesB) {
    const prior = nodesA.get(id);
    if (prior === undefined) nodesAdded.push(id);
    else if (prior !== kind) nodesKindChanged.push({ nodeId: id, before: prior, after: kind });
  }
  for (const [id] of nodesA) if (!nodesB.has(id)) nodesRemoved.push(id);

  return {
    variables,
    derived,
    httpRequests: { added: httpDiff.added, removed: httpDiff.removed },
    nodeCountBefore: countNodes(a),
    nodeCountAfter: countNodes(b),
    nodesAdded,
    nodesRemoved,
    nodesKindChanged,
    styles: diffStyles(a.styles, b.styles),
  };
}
