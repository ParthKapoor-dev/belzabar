// Server normalisation the post-write verify must not count as a change.
//
// A V2 save rewrites some fields whose meaning stays the same (live: an
// older method's save, and `ad create` of a body copied from one):
//   - encoding: an input's `encodedBase64` flag flips, or its value moves
//     between base64 and plain text with the same decoded content;
//   - account: a db step's `accountConfiguration.name` gains the account's
//     name, and `properties.databaseRead.account` goes from "null" to the
//     step's account id (live 2026-11-18: sent null / "null", read back
//     "testing_db" / "215");
//   - condition form: an entry or conditional-exit condition goes from the
//     basic form (`expandedExpressions` rows) to the advanced form with the
//     same `expression`.
// Anything else is a real difference and still fails the verify.

import { isObj } from "@belzabar/core";
import { decodeBase64Strict } from "../base64";
import { getAtPath, jsonEqual } from "../serialize/diff";

export interface Normalised {
  path: string;
  kind: "encoding" | "account" | "condition-form";
  from: unknown;
  to: unknown;
}

const CONDITION = /^(.*\.(?:entryCondition|conditionalExit))(?:\.|$)/;

/** Same text once base64 is decoded (either side may be the encoded one). */
function sameDecoded(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a === b) return false;
  return decodeBase64Strict(a) === b || decodeBase64Strict(b) === a;
}

const isUnset = (v: unknown) => v === undefined || v === null || v === "" || v === "null";

/**
 * The normalisation that explains the difference at `path` between `before`
 * and `after`, or null when it is a real change. For a condition, `path` is
 * the condition object (one entry for all its rows).
 */
export function normalisedChange(before: unknown, after: unknown, path: string): Normalised | null {
  const from = getAtPath(before, path);
  const to = getAtPath(after, path);
  const last = path.split(".").pop() ?? "";
  if (last === "encodedBase64") return { path, kind: "encoding", from, to };
  if (last === "value" && /\.inputs\[\d+\]/.test(path) && sameDecoded(from, to)) return { path, kind: "encoding", from, to };
  if (path.endsWith(".accountConfiguration.name") && isUnset(from) && typeof to === "string") return { path, kind: "account", from, to };
  if (path.endsWith(".properties.databaseRead.account")) {
    const step = getAtPath(after, path.slice(0, -".properties.databaseRead.account".length));
    const id = isObj(step) && isObj(step.accountConfiguration) ? step.accountConfiguration.id : undefined;
    if (id !== undefined && id !== null && String(to) === String(id) && (isUnset(from) || String(from) === String(id))) {
      return { path, kind: "account", from, to };
    }
  }
  const m = CONDITION.exec(path);
  if (m) {
    const root = m[1]!;
    const a = getAtPath(before, root);
    const b = getAtPath(after, root);
    if (isObj(a) && isObj(b) && typeof a.expression === "string" && a.expression.trim() !== "" && a.expression.trim() === String(b.expression ?? "").trim()) {
      const rest = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "expression" && k !== "expandedExpressions"));
      const form = (o: Record<string, unknown>) => (Array.isArray(o.expandedExpressions) && o.expandedExpressions.length > 0 ? "basic" : "advanced");
      if (jsonEqual(rest(a), rest(b))) return { path: root, kind: "condition-form", from: form(a), to: form(b) };
    }
  }
  return null;
}

/** Split differing `paths` into server normalisation (deduplicated) and real changes. */
export function splitNormalised(before: unknown, after: unknown, paths: string[]): { normalised: Normalised[]; real: string[] } {
  const normalised = new Map<string, Normalised>();
  const real: string[] = [];
  for (const p of paths) {
    const n = normalisedChange(before, after, p);
    if (n) normalised.set(n.path, n);
    else real.push(p);
  }
  return { normalised: [...normalised.values()], real };
}

/** The warning a write gives when the server normalised fields. */
export function normalisedWarning(n: Normalised[]): string {
  const kinds = [...new Set(n.map((x) => x.kind))].join(", ");
  return (
    `The server normalised ${n.length} field(s) on the write (${kinds}); their meaning is unchanged, so the write counts as verified: ` +
    `${n.slice(0, 10).map((x) => x.path).join(", ")}${n.length > 10 ? ", …" : ""} (data.normalised).`
  );
}
