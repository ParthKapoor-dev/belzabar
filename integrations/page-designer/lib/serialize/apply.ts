// Pure overlay → HydratedPage transform.
//
// Used by `save`, `preflight` and `history restore` to produce the "what it
// would look like" page the validator runs on before anything hits the wire,
// and (via `rawConfiguration`) the exact config a full save sends.
//
// The edit is applied to a deep clone of the RAW inner configuration — never
// rebuilt from the parsed lists — so everything the overlay does not touch
// round-trips byte-for-byte in structure: duplicate variables, nulls,
// legacy `context.properties` / `http`, component `inputs`/`events`, unknown
// keys. Targets are found by their raw index (lib/serialize/locate.ts).
//
// An overlay that names something that does not exist (update/remove of an
// unknown variable or callId, add of an existing name, an element key whose
// parent does not resolve) is refused with PD_OVERLAY_INVALID instead of being
// silently skipped.

import { CliError } from "@belzabar/core";
import { parsePage } from "../parser/index";
import type { ElementOperation, HydratedPage, Overlay } from "../types/common";
import type { RawConfiguration, RawDerivedVar, RawHttpRequestItem, RawPageResponse, RawUserDefinedVar } from "../types/wire";
import { locateDerived, locateHttp, locateVariable, usesLegacyVariables } from "./locate";
import { applyNodeOps } from "./nodes";
import { assertOverlayShape } from "./overlay-shape";
import { decodeValue, encodeValue, setPath } from "./paths";

function deepClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** The array at a `locate` list key. */
function listAt(inner: RawConfiguration, list: string): unknown[] {
  let cur: unknown = inner;
  for (const seg of list.split(".")) cur = (cur as Record<string, unknown>)[seg];
  return cur as unknown[];
}

const OVERLAY_SECTIONS = new Set(["variables", "derived", "httpRequests", "elements", "nodes", "styles"]);

/** The value an element operation stores, as the server will decode it. */
function elementOpValue(op: ElementOperation): unknown {
  return decodeValue(encodeValue(op.value, op.dataType), op.dataType);
}

/** Apply the overlay to a clone of `page.rawConfiguration`; returns the new inner config. */
function applyOverlayToConfig(page: HydratedPage, overlay: Overlay): RawConfiguration {
  assertOverlayShape(overlay);
  const inner = deepClone((page.rawConfiguration ?? {}) as RawConfiguration) ?? {};
  const problems: string[] = [];
  const legacy = usesLegacyVariables(inner);
  // A typo'd section ("node", "element") would otherwise be silently ignored.
  for (const key of Object.keys(overlay ?? {})) {
    if (!OVERLAY_SECTIONS.has(key)) problems.push(`unknown overlay section "${key}" (expected ${[...OVERLAY_SECTIONS].join(", ")})`);
  }

  // ----- variables ------------------------------------------------------
  const vo = overlay.variables;
  if (vo?.update) {
    for (const upd of vo.update) {
      const loc = locateVariable(inner, upd.name);
      if (!loc) {
        problems.push(
          locateDerived(inner, upd.name)
            ? `variables.update: "${upd.name}" is a derived variable — use derived.update`
            : `variables.update: no variable named "${upd.name}"`,
        );
        continue;
      }
      if (legacy) {
        const tuple = listAt(inner, loc.list)[loc.index] as [string, unknown];
        if (upd.type !== undefined || upd.translateInitialValue !== undefined) {
          problems.push(`variables.update: "${upd.name}" is on a legacy context.properties page — only initialValue can change`);
        }
        if (upd.initialValue !== undefined) tuple[1] = upd.initialValue;
        continue;
      }
      const entry = listAt(inner, loc.list)[loc.index] as RawUserDefinedVar;
      if (upd.initialValue !== undefined) entry.initialValue = upd.initialValue;
      if (upd.type !== undefined) entry.type = upd.type;
      if (upd.translateInitialValue !== undefined) entry.translateInitialValue = upd.translateInitialValue;
    }
  }
  if (vo?.remove) {
    for (const name of vo.remove) {
      const loc = locateVariable(inner, name);
      if (!loc) {
        problems.push(`variables.remove: no variable named "${name}"`);
        continue;
      }
      listAt(inner, loc.list).splice(loc.index, 1);
    }
  }
  if (vo?.add) {
    for (const v of vo.add) {
      if (locateVariable(inner, v.name) || locateDerived(inner, v.name)) {
        problems.push(`variables.add: "${v.name}" already exists`);
        continue;
      }
      if (legacy) {
        inner.context!.properties!.push([v.name, v.initialValue ?? null]);
        continue;
      }
      inner.variables ??= {};
      inner.variables.userDefined ??= [];
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
  const dov = overlay.derived;
  if (dov?.update) {
    for (const upd of dov.update) {
      const loc = locateDerived(inner, upd.name);
      if (!loc) {
        problems.push(`derived.update: no derived variable named "${upd.name}"`);
        continue;
      }
      const entry = listAt(inner, loc.list)[loc.index] as RawDerivedVar;
      if (upd.from !== undefined) entry.from = upd.from;
      if (upd.spec !== undefined) entry.spec = upd.spec;
      if (upd.filterFn !== undefined) entry.filterFn = upd.filterFn;
      if (upd.sideEffect !== undefined) entry.sideEffect = upd.sideEffect;
    }
  }
  if (dov?.remove) {
    for (const name of dov.remove) {
      const loc = locateDerived(inner, name);
      if (!loc) {
        problems.push(`derived.remove: no derived variable named "${name}"`);
        continue;
      }
      listAt(inner, loc.list).splice(loc.index, 1);
    }
  }
  if (dov?.add) {
    for (const d of dov.add) {
      if (locateVariable(inner, d.name) || locateDerived(inner, d.name)) {
        problems.push(`derived.add: "${d.name}" already exists`);
        continue;
      }
      inner.variables ??= {};
      const hasDerivedList = Array.isArray(inner.variables.derived) && inner.variables.derived.length > 0;
      if (hasDerivedList || legacy) {
        inner.variables.derived ??= [];
        inner.variables.derived.push({
          name: d.name,
          from: d.from,
          spec: d.spec,
          ...(d.filterFn !== undefined ? { filterFn: d.filterFn } : {}),
          sideEffect: d.sideEffect ?? false,
        });
      } else {
        // The editor's own shape: a derived var is a userDefined entry with `from`.
        inner.variables.userDefined ??= [];
        inner.variables.userDefined.push({
          name: d.name,
          type: "Any",
          from: d.from,
          spec: d.spec,
          filterFn: d.filterFn ?? "(function (data) {\n\treturn true;\n})",
          sideEffect: d.sideEffect ?? true,
          initial: "",
          compileType: "DERIVED",
          __LAYOUT_CONFIG_METADATA: { description: "" },
        } as RawUserDefinedVar);
      }
    }
  }

  // ----- httpRequests ---------------------------------------------------
  const ho = overlay.httpRequests;
  if (ho?.update) {
    for (const upd of ho.update) {
      const loc = locateHttp(inner, upd.callId);
      if (!loc) {
        problems.push(`httpRequests.update: no HTTP request with callId "${upd.callId}"`);
        continue;
      }
      const entry = listAt(inner, loc.list)[loc.index] as RawHttpRequestItem;
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
  if (ho?.remove) {
    for (const callId of ho.remove) {
      const loc = locateHttp(inner, callId);
      if (!loc) {
        problems.push(`httpRequests.remove: no HTTP request with callId "${callId}"`);
        continue;
      }
      listAt(inner, loc.list).splice(loc.index, 1);
    }
  }
  if (ho?.add?.length) {
    inner.httpRequests ??= {};
    inner.httpRequests.userDefined ??= [];
    for (const item of ho.add) {
      const callId = (item as RawHttpRequestItem)?.meta?.serviceCall?.callId;
      if (typeof callId === "string" && locateHttp(inner, callId)) {
        problems.push(`httpRequests.add: callId "${callId}" already exists`);
        continue;
      }
      inner.httpRequests.userDefined.push(item as RawHttpRequestItem);
    }
  }

  // ----- element operations ---------------------------------------------
  for (const op of overlay.elements?.operations ?? []) {
    if (!setPath(inner, op.key, elementOpValue(op))) {
      problems.push(`elements.operations: key "${op.key}" does not resolve (its parent does not exist)`);
    }
  }

  // ----- node-id ops (after elements: their paths refer to the unedited tree)
  if (overlay.nodes) problems.push(...applyNodeOps(inner, overlay.nodes, page.id));

  // ----- styles ---------------------------------------------------------
  if (overlay.styles?.replace !== undefined) inner.styles = overlay.styles.replace;

  if (problems.length > 0) {
    throw new CliError(`Overlay does not apply to page ${page.id}: ${problems.join("; ")}`, {
      code: "PD_OVERLAY_INVALID",
      details: { problems },
    });
  }
  return inner;
}

/** A HydratedPage for a new inner configuration (the rest of the wire body is kept). */
export function withConfiguration(page: HydratedPage, inner: unknown): HydratedPage {
  const reWrapped = {
    ...(page.raw as Record<string, unknown>),
    configuration: JSON.stringify(inner),
  } as RawPageResponse;
  return parsePage(reWrapped);
}

export function applyOverlay(page: HydratedPage, overlay: Overlay): HydratedPage {
  return withConfiguration(page, applyOverlayToConfig(page, overlay));
}
