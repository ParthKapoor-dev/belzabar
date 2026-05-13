// Pure overlay → HydratedPage transform.
//
// Used by:
//   - `preflight` and `save` to produce the "what it would look like" state
//     that the validator runs on before anything hits the wire.
//   - Tests to assert that applyOverlay(page, overlay) produces the expected
//     downstream structure.
//
// This function performs NO I/O. It never calls the server. It clones the
// layout `raw` tree by path when an element-operation targets the layout,
// so subsequent serialization round-trips the mutation.

import { parsePage } from "../parser/index";
import type { ElementOperation, HydratedPage, Overlay, PageVariable, PageDerivedVariable } from "../types/common";
import type { RawConfiguration, RawLayoutNode } from "../types/wire";
import { hydratedToInnerConfig } from "./full";

// Deep-clone helper scoped to serialization's needs (handles plain objects,
// arrays, primitives, and drops functions — which shouldn't be in PD config
// anyway).
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// Apply a single element-operation against a parsed (not-stringified) config.
// Mutates in place. Returns true on success, false if the path didn't resolve.
function applyElementOpToConfig(
  config: RawConfiguration,
  op: ElementOperation,
): boolean {
  const path = parsePath(op.key);
  if (path.length === 0) return false;

  // Navigate to parent of target
  let parent: any = config;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    if (parent == null) return false;
    if (typeof seg === "number") {
      if (!Array.isArray(parent)) return false;
      parent = parent[seg];
    } else {
      parent = parent[seg];
    }
  }
  if (parent == null) return false;

  const last = path[path.length - 1]!;
  parent[typeof last === "number" ? last : (last as string)] = op.value;
  return true;
}

// dot-notation with [n] support — produces an array of string | number segments.
function parsePath(key: string): Array<string | number> {
  const out: Array<string | number> = [];
  const regex = /([^.\[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(key)) !== null) {
    if (m[2] !== undefined) out.push(Number(m[2]));
    else if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

export function applyOverlay(page: HydratedPage, overlay: Overlay): HydratedPage {
  // Start from a full (cloned) inner config — this is the source of truth
  // that we'll mutate, then re-parse at the end to produce the new
  // HydratedPage (so every parsed node carries fresh `raw` identity).
  const inner: RawConfiguration = deepClone(hydratedToInnerConfig(page));

  // ----- variables ------------------------------------------------------
  inner.variables ??= { generated: [], userDefined: [], derived: [] };
  inner.variables.userDefined ??= [];
  inner.variables.derived ??= [];

  // remove
  if (overlay.variables?.remove) {
    inner.variables.userDefined = inner.variables.userDefined.filter(
      (v) => !overlay.variables!.remove!.includes(v.name),
    );
  }
  // update
  if (overlay.variables?.update) {
    for (const upd of overlay.variables.update) {
      const entry = inner.variables.userDefined.find((v) => v.name === upd.name);
      if (!entry) continue;
      if (upd.initialValue !== undefined) entry.initialValue = upd.initialValue;
      if (upd.type !== undefined) entry.type = upd.type;
      if (upd.translateInitialValue !== undefined) entry.translateInitialValue = upd.translateInitialValue;
    }
  }
  // add
  if (overlay.variables?.add) {
    for (const v of overlay.variables.add) {
      inner.variables.userDefined.push({
        name: v.name,
        type: v.type ?? "String",
        initialValue: v.initialValue ?? null,
        translateInitialValue: v.translateInitialValue ?? false,
        __LAYOUT_CONFIG_METADATA: {},
      });
    }
  }

  // ----- derived --------------------------------------------------------
  if (overlay.derived?.remove) {
    inner.variables.derived = inner.variables.derived.filter(
      (d) => !overlay.derived!.remove!.includes(d.name),
    );
  }
  if (overlay.derived?.update) {
    for (const upd of overlay.derived.update) {
      const entry = inner.variables.derived.find((d) => d.name === upd.name);
      if (!entry) continue;
      if (upd.from !== undefined) entry.from = upd.from;
      if (upd.spec !== undefined) entry.spec = upd.spec;
      if (upd.filterFn !== undefined) entry.filterFn = upd.filterFn;
      if (upd.sideEffect !== undefined) entry.sideEffect = upd.sideEffect;
    }
  }
  if (overlay.derived?.add) {
    for (const d of overlay.derived.add) {
      inner.variables.derived.push({
        name: d.name,
        from: d.from,
        spec: d.spec,
        filterFn: d.filterFn ?? null,
        sideEffect: d.sideEffect ?? false,
      } as any);
    }
  }

  // ----- httpRequests ---------------------------------------------------
  inner.httpRequests ??= { generated: [], userDefined: [] };
  inner.httpRequests.userDefined ??= [];
  inner.httpRequests.generated ??= [];

  if (overlay.httpRequests?.remove) {
    inner.httpRequests.userDefined = inner.httpRequests.userDefined.filter(
      (h) => !overlay.httpRequests!.remove!.includes(h.meta?.serviceCall?.callId ?? ""),
    );
  }
  if (overlay.httpRequests?.update) {
    for (const upd of overlay.httpRequests.update) {
      const entry = inner.httpRequests.userDefined.find(
        (h) => h.meta?.serviceCall?.callId === upd.callId,
      );
      if (!entry) continue;
      if (upd.request) {
        entry.request ??= {};
        if (upd.request.body !== undefined) entry.request.body = upd.request.body;
        if (upd.request.url !== undefined) entry.request.url = upd.request.url;
        if (upd.request.method !== undefined) entry.request.method = upd.request.method;
      }
      if (upd.handler) {
        entry.handler ??= {};
        if (upd.handler.success !== undefined) entry.handler.success = upd.handler.success;
        if (upd.handler.error !== undefined) entry.handler.error = upd.handler.error;
        if (upd.handler.inProgress !== undefined) entry.handler.inProgress = upd.handler.inProgress;
      }
      if (upd.trigger !== undefined) entry.trigger = upd.trigger;
      if (upd.triggerFilter !== undefined) entry.triggerFilter = upd.triggerFilter;
      if (upd.responseTransformSpec !== undefined) entry.responseTransformSpec = upd.responseTransformSpec;
    }
  }
  if (overlay.httpRequests?.add) {
    inner.httpRequests.userDefined.push(...(overlay.httpRequests.add as any[]));
  }

  // ----- elements ops ---------------------------------------------------
  if (overlay.elements?.operations) {
    for (const op of overlay.elements.operations) {
      applyElementOpToConfig(inner, op);
    }
  }

  // ----- styles ---------------------------------------------------------
  if (overlay.styles?.replace !== undefined) {
    inner.styles = overlay.styles.replace;
  }

  // Re-parse to produce a fresh HydratedPage pointing at the new shapes.
  // Wrap the mutated inner back into a wire-shaped response.
  const reWrapped = {
    ...(page.raw as Record<string, unknown>),
    configuration: JSON.stringify(inner),
  };
  return parsePage(reWrapped as any);
}
