// Structural check of a user overlay file (OTH-R7). A `null` overlay, a
// section that is not an object, or a list that is not an array used to crash
// the command with UNHANDLED_EXCEPTION; now every shape problem is reported at
// once as PD_OVERLAY_INVALID. Semantic checks (unknown variable / callId /
// node id, unknown section names) stay in apply.ts.

import { CliError, isObj } from "@belzabar/core";
import type { Overlay } from "../types/common";

const DATA_TYPES = new Set(["STRING", "NUMBER", "BOOLEAN", "ARRAY", "OBJECT"]);

type Rec = Record<string, unknown>;

/** Shape problems in `value` as an Overlay (empty = OK). */
export function overlayShapeProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isObj(value)) return [`the overlay must be a JSON object, got ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}`];

  const section = (name: string): Rec | null => {
    const s = value[name];
    if (s === undefined) return null;
    if (!isObj(s)) {
      problems.push(`${name} must be an object`);
      return null;
    }
    return s;
  };
  const list = (where: string, v: unknown): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      problems.push(`${where} must be an array`);
      return [];
    }
    return v;
  };
  const entries = (where: string, v: unknown, requiredString: string, check?: (e: Rec, at: string) => void) => {
    list(where, v).forEach((e, i) => {
      const at = `${where}[${i}]`;
      if (!isObj(e)) return problems.push(`${at} must be an object`);
      if (typeof e[requiredString] !== "string" || e[requiredString] === "") problems.push(`${at}.${requiredString} must be a non-empty string`);
      check?.(e, at);
    });
  };
  const strings = (where: string, v: unknown) => {
    list(where, v).forEach((e, i) => {
      if (typeof e !== "string") problems.push(`${where}[${i}] must be a string`);
    });
  };
  const optObj = (e: Rec, at: string, keys: string[]) => {
    for (const k of keys) if (e[k] !== undefined && !isObj(e[k])) problems.push(`${at}.${k} must be an object`);
  };
  const optArr = (e: Rec, at: string, keys: string[]) => {
    for (const k of keys) if (e[k] !== undefined && !Array.isArray(e[k])) problems.push(`${at}.${k} must be an array`);
  };

  for (const name of ["variables", "derived"]) {
    const s = section(name);
    if (!s) continue;
    entries(`${name}.add`, s.add, "name", name === "derived" ? (e, at) => optArr(e, at, ["from"]) : undefined);
    entries(`${name}.update`, s.update, "name", name === "derived" ? (e, at) => optArr(e, at, ["from"]) : undefined);
    strings(`${name}.remove`, s.remove);
  }

  const http = section("httpRequests");
  if (http) {
    list("httpRequests.add", http.add);
    entries("httpRequests.update", http.update, "callId", (e, at) => {
      optObj(e, at, ["request", "handler"]);
      optArr(e, at, ["trigger"]);
      if (isObj(e.handler)) optArr(e.handler, `${at}.handler`, ["success", "error"]);
    });
    strings("httpRequests.remove", http.remove);
  }

  const el = section("elements");
  if (el) {
    if (el.operations === undefined) problems.push("elements.operations is required");
    entries("elements.operations", el.operations, "key", (e, at) => {
      if (e.operation !== "CREATE" && e.operation !== "UPDATE") problems.push(`${at}.operation must be CREATE or UPDATE`);
      if (typeof e.dataType !== "string" || !DATA_TYPES.has(e.dataType)) problems.push(`${at}.dataType must be one of ${[...DATA_TYPES].join(", ")}`);
    });
  }

  const nodes = section("nodes");
  if (nodes) {
    entries("nodes.update", nodes.update, "id", (e, at) => optObj(e, at, ["props", "field", "attrs", "events"]));
    entries("nodes.insert", nodes.insert, "parentId", (e, at) => {
      if (!isObj(e.node)) problems.push(`${at}.node must be an object`);
      if (e.index !== undefined && typeof e.index !== "number") problems.push(`${at}.index must be a number`);
    });
    strings("nodes.remove", nodes.remove);
  }

  const styles = section("styles");
  if (styles && typeof styles.replace !== "string") problems.push("styles.replace must be a string");

  return problems;
}

/** `value` as an Overlay, or PD_OVERLAY_INVALID listing every shape problem. */
export function assertOverlayShape(value: unknown): Overlay {
  const problems = overlayShapeProblems(value);
  if (problems.length > 0) {
    throw new CliError(`Overlay is malformed: ${problems.join("; ")}`, { code: "PD_OVERLAY_INVALID", details: { problems } });
  }
  return value as Overlay;
}
