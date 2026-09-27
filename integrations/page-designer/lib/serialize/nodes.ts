// Node-id overlay ops (Stage 7, 7.8): `nodes.update / insert / remove` address
// layout nodes by `id` (or `_elementId`) so an agent never computes
// `children[i]` paths. Resolved against the RAW inner config:
//   - applyNodeOps edits the raw clone (apply.ts) — lossless like every edit;
//   - nodeUpdateOps turns updates into partial-save ops keyed at the node's
//     path (operations.ts); insert/remove and key removals need a full save.
//
// Inserted nodes (and their descendants) without an id get one, derived
// deterministically from the page, the parent and the node content — so the
// dry-run, the first plan and the in-lock re-plan agree.

import { createHash } from "node:crypto";
import type { NodeInsert, NodesOverlay, NodeUpdate, PartialDataType, RawPartialUpdateOperation } from "../types/common";
import type { RawConfiguration } from "../types/wire";
import { encodeValue, guessDataType, hasPath } from "./paths";

type RawNode = Record<string, unknown>;

export interface LocatedNode {
  node: RawNode;
  /** Key path in the inner config (`layout.children[1]`). */
  path: string;
  parent: RawNode | null;
  index: number | null;
}

/** Every layout node with its key path, parent and index (object-keyed children too). */
export function rawNodes(inner: RawConfiguration): LocatedNode[] {
  const out: LocatedNode[] = [];
  const visit = (node: unknown, path: string, parent: RawNode | null, index: number | null) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const n = node as RawNode;
    out.push({ node: n, path, parent, index });
    const kids = n.children;
    if (Array.isArray(kids)) kids.forEach((c, i) => visit(c, `${path}.children[${i}]`, n, i));
    else if (kids && typeof kids === "object") for (const [k, c] of Object.entries(kids)) visit(c, `${path}.children.${k}`, n, null);
  };
  visit((inner as { layout?: unknown }).layout, "layout", null, null);
  return out;
}

const idOf = (n: RawNode) => (typeof n.id === "string" && n.id ? n.id : null);
const elemOf = (n: RawNode) => (typeof n._elementId === "string" && n._elementId ? n._elementId : null);

/** The node whose `id` is `ref` (else whose `_elementId` is). Error text when none / several. */
export function locateNode(inner: RawConfiguration, ref: string): LocatedNode | string {
  const all = rawNodes(inner);
  let hits = all.filter((l) => idOf(l.node) === ref);
  if (hits.length === 0) hits = all.filter((l) => elemOf(l.node) === ref);
  if (hits.length === 0) return `no node with id "${ref}"`;
  if (hits.length > 1) return `node id "${ref}" is not unique (${hits.length} nodes: ${hits.map((h) => h.path).join(", ")})`;
  return hits[0]!;
}

/** The mergeable maps of a node an update may touch. */
const MAPS = ["props", "field", "attrs", "events"] as const;
type MapKey = (typeof MAPS)[number];

function hasRemoval(u: NodeUpdate): boolean {
  return MAPS.some((m) => Object.values(u[m] ?? {}).some((v) => v === null));
}

/** Why a nodes overlay needs a full save, or null when its updates can be partial ops. */
export function nodesFullSaveReason(nodes: NodesOverlay | undefined): string | null {
  if (!nodes) return null;
  if (nodes.insert?.length) return "nodes.insert";
  if (nodes.remove?.length) return "nodes.remove";
  if (nodes.update?.some(hasRemoval)) return "nodes.update removes a key (null)";
  return null;
}

function digits(hash: string, from: number): number {
  return parseInt(hash.slice(from, from + 6), 16) % 100000;
}

/** Give `node` and its descendants the ids the editor would (deterministic, unique within `taken`). */
function assignIds(node: RawNode, seed: string, taken: Set<string>): void {
  let n = 0;
  const visit = (x: unknown) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return;
    const r = x as RawNode;
    const mint = (prefix: string) => {
      for (;;) {
        const h = createHash("sha1").update(`${seed}\u0000${prefix}\u0000${n++}`).digest("hex");
        const id = `${prefix}_${digits(h, 0)}_${digits(h, 6)}_${digits(h, 12)}_${digits(h, 18)}`;
        if (!taken.has(id)) {
          taken.add(id);
          return id;
        }
      }
    };
    if (!idOf(r)) r.id = mint("__node_id");
    if (!elemOf(r)) r._elementId = mint("__element_id");
    const kids = r.children;
    if (Array.isArray(kids)) kids.forEach(visit);
  };
  visit(node);
}

function collectIds(node: unknown, into: string[]): string[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) return into;
  const r = node as RawNode;
  if (idOf(r)) into.push(r.id as string);
  if (elemOf(r)) into.push(r._elementId as string);
  if (Array.isArray(r.children)) for (const c of r.children) collectIds(c, into);
  return into;
}

function applyUpdate(target: RawNode, u: NodeUpdate): void {
  for (const m of MAPS) {
    const patch = u[m];
    if (!patch) continue;
    const cur = target[m];
    const map: RawNode = cur && typeof cur === "object" && !Array.isArray(cur) ? (cur as RawNode) : {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete map[k];
      else map[k] = v;
    }
    target[m] = map;
  }
}

/** Apply nodes.update → insert → remove to `inner` (in place). Returns the problems (empty = applied). */
export function applyNodeOps(inner: RawConfiguration, nodes: NodesOverlay, seed: string): string[] {
  const problems: string[] = [];

  for (const u of nodes.update ?? []) {
    if (!u || typeof u.id !== "string") {
      problems.push("nodes.update: every entry needs an `id`");
      continue;
    }
    if (!MAPS.some((m) => u[m] && typeof u[m] === "object")) {
      problems.push(`nodes.update: "${u.id}" changes nothing (give props / field / attrs / events)`);
      continue;
    }
    const loc = locateNode(inner, u.id);
    if (typeof loc === "string") {
      problems.push(`nodes.update: ${loc}`);
      continue;
    }
    applyUpdate(loc.node, u);
  }

  for (const [i, ins] of (nodes.insert ?? []).entries()) {
    const where = `nodes.insert[${i}]`;
    if (!ins || typeof ins.parentId !== "string" || !ins.node || typeof ins.node !== "object" || Array.isArray(ins.node)) {
      problems.push(`${where}: needs {parentId, node:{name, …}, index?}`);
      continue;
    }
    if (typeof (ins.node as RawNode).name !== "string") {
      problems.push(`${where}: the node needs a string "name" (div, span, exp-form-field, a symbol name…)`);
      continue;
    }
    const parent = locateNode(inner, ins.parentId);
    if (typeof parent === "string") {
      problems.push(`${where}: parent ${parent}`);
      continue;
    }
    const kids = parent.node.children;
    if (kids !== undefined && !Array.isArray(kids)) {
      problems.push(`${where}: parent "${ins.parentId}" has object-keyed children (CHILDREN_NOT_ARRAY) — fix that first`);
      continue;
    }
    const list = (kids as unknown[] | undefined) ?? [];
    const index = ins.index ?? list.length;
    if (!Number.isInteger(index) || index < 0 || index > list.length) {
      problems.push(`${where}: index ${String(ins.index)} is outside 0..${list.length}`);
      continue;
    }
    const node = JSON.parse(JSON.stringify(ins.node)) as RawNode;
    const existing = new Set(rawNodes(inner).flatMap((l) => [idOf(l.node), elemOf(l.node)].filter((x): x is string => !!x)));
    const clash = collectIds(node, []).find((id) => existing.has(id));
    if (clash) {
      problems.push(`${where}: id "${clash}" already exists on the page`);
      continue;
    }
    assignIds(node, `${seed}\u0000${ins.parentId}\u0000${index}\u0000${JSON.stringify(ins.node)}`, existing);
    list.splice(index, 0, node);
    parent.node.children = list;
  }

  for (const ref of nodes.remove ?? []) {
    const loc = locateNode(inner, ref);
    if (typeof loc === "string") {
      problems.push(`nodes.remove: ${loc}`);
      continue;
    }
    if (!loc.parent) {
      problems.push(`nodes.remove: "${ref}" is the root layout node`);
      continue;
    }
    const kids = loc.parent.children;
    if (Array.isArray(kids) && loc.index !== null) kids.splice(loc.index, 1);
    else if (kids && typeof kids === "object") {
      const key = Object.keys(kids).find((k) => (kids as Record<string, unknown>)[k] === loc.node);
      if (key !== undefined) delete (kids as Record<string, unknown>)[key];
    }
  }
  return problems;
}

/**
 * Partial-save ops for `nodes.update` (keys set, none removed), keyed at the
 * node's path in the ORIGINAL config. Unknown ids are skipped (applyNodeOps
 * refuses them before this runs); planSave's replay check catches any key the
 * dot-path syntax cannot express (a prop name containing ".").
 */
export function nodeUpdateOps(inner: RawConfiguration, updates: NodeUpdate[]): RawPartialUpdateOperation[] {
  const ops: RawPartialUpdateOperation[] = [];
  for (const u of updates) {
    const loc = locateNode(inner, u.id);
    if (typeof loc === "string") continue;
    for (const m of MAPS) {
      for (const [k, v] of Object.entries(u[m] ?? {})) {
        const key = `${loc.path}.${m}.${k}`;
        const dataType: PartialDataType = m === "events" ? "ARRAY" : guessDataType(v);
        ops.push({ key, value: encodeValue(v, dataType), operation: hasPath(inner, key) ? "UPDATE" : "CREATE", dataType });
      }
    }
  }
  return ops;
}

export type { NodeInsert, NodesOverlay, NodeUpdate, MapKey };
