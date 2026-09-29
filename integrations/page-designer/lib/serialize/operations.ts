// Overlay → pageElementOperations (the partial-save wire format).
//
//   variables.update     → variables.userDefined[i].{initialValue,type,translateInitialValue}
//   httpRequests.update  → <bucket>[i].request.{url,body,method},
//                          .handler.{success,error,inProgress}, .trigger,
//                          .triggerFilter, .responseTransformSpec
//   elements.operations  → pass-through
//   nodes.update         → <node path>.{props,field,attrs,events}.<key> (lib/serialize/nodes.ts)
//   styles.replace       → `styles`
//
// `i` is always the RAW array index. Anything partial ops cannot
// express — adds/removes, derived edits, legacy-format pages — makes
// `partialOperationsFor` return null; the caller then does a full save.
// Every field the overlay sets must be covered by an op: planSave() checks
// that the ops reproduce applyOverlay's config and otherwise falls back to a
// full save.

import type { Overlay, PartialDataType, RawPartialUpdateOperation } from "../types/common";
import type { RawConfiguration } from "../types/wire";
import { locateHttp, locateVariable, usesLegacyHttp, usesLegacyVariables } from "./locate";
import { nodeUpdateOps, nodesFullSaveReason } from "./nodes";
import { encodeValue, guessDataType, hasPath } from "./paths";

/** Why this overlay cannot be a partial save, or null when it can. */
export function fullSaveReason(overlay: Overlay, inner: RawConfiguration): string | null {
  if (overlay.variables?.add?.length) return "variables.add";
  if (overlay.variables?.remove?.length) return "variables.remove";
  if (overlay.derived?.add?.length || overlay.derived?.update?.length || overlay.derived?.remove?.length) return "derived.*";
  if (overlay.httpRequests?.add?.length) return "httpRequests.add";
  if (overlay.httpRequests?.remove?.length) return "httpRequests.remove";
  if (overlay.variables?.update?.length && usesLegacyVariables(inner)) return "legacy context.properties page";
  if (overlay.httpRequests?.update?.length && usesLegacyHttp(inner)) return "legacy http page";
  return nodesFullSaveReason(overlay.nodes);
}

function op(inner: RawConfiguration, key: string, value: unknown, dataType: PartialDataType): RawPartialUpdateOperation {
  return {
    key,
    value: encodeValue(value, dataType),
    operation: hasPath(inner, key) ? "UPDATE" : "CREATE",
    dataType,
  };
}

/**
 * The partial-update operations for `overlay` against the page's raw config,
 * or null when the overlay needs a full save. Unknown targets are skipped here
 * (applyOverlay refuses them before this runs).
 */
export function partialOperationsFor(inner: RawConfiguration, overlay: Overlay): RawPartialUpdateOperation[] | null {
  if (fullSaveReason(overlay, inner)) return null;
  const ops: RawPartialUpdateOperation[] = [];

  for (const upd of overlay.variables?.update ?? []) {
    const loc = locateVariable(inner, upd.name);
    if (!loc) continue;
    const base = `${loc.list}[${loc.index}]`;
    if (upd.initialValue !== undefined) ops.push(op(inner, `${base}.initialValue`, upd.initialValue, guessDataType(upd.initialValue)));
    if (upd.type !== undefined) ops.push(op(inner, `${base}.type`, upd.type, "STRING"));
    if (upd.translateInitialValue !== undefined) ops.push(op(inner, `${base}.translateInitialValue`, upd.translateInitialValue, "BOOLEAN"));
  }

  for (const upd of overlay.httpRequests?.update ?? []) {
    const loc = locateHttp(inner, upd.callId);
    if (!loc) continue;
    const base = `${loc.list}[${loc.index}]`;
    const str = (field: string, v: string | undefined) => {
      if (v !== undefined) ops.push(op(inner, `${base}.${field}`, v, "STRING"));
    };
    const arr = (field: string, v: unknown[] | undefined) => {
      if (v !== undefined) ops.push(op(inner, `${base}.${field}`, v, "ARRAY"));
    };
    str("request.body", upd.request?.body);
    str("request.url", upd.request?.url);
    str("request.method", upd.request?.method);
    arr("handler.success", upd.handler?.success);
    arr("handler.error", upd.handler?.error);
    str("handler.inProgress", upd.handler?.inProgress);
    arr("trigger", upd.trigger);
    str("triggerFilter", upd.triggerFilter);
    str("responseTransformSpec", upd.responseTransformSpec);
  }

  for (const e of overlay.elements?.operations ?? []) {
    ops.push({ key: e.key, value: encodeValue(e.value, e.dataType), operation: e.operation, dataType: e.dataType });
  }

  // nodes.update → ops at the node's path (only reached when nothing is inserted/removed).
  ops.push(...nodeUpdateOps(inner, overlay.nodes?.update ?? []));

  if (overlay.styles?.replace !== undefined) ops.push(op(inner, "styles", overlay.styles.replace, "STRING"));

  return ops;
}
