// Serializer façade: plan how an overlay is saved.
//
//   planSave(before, overlay) →
//     { strategy: "partial", operations, patched }   — pageElementOperations
//     { strategy: "full", configurationString, patched, fallbackReason? }
//
// `patched` is applyOverlay(before, overlay): the page the validator scores
// and the config a full save sends. A partial plan is only returned when its
// operations, replayed on the raw config the way the server applies them,
// reproduce `patched` exactly (PD-3: an op the serializer cannot emit — or a
// parent path that does not exist yet — forces a full save instead of a
// silent partial no-op). Ops are also limited to key shapes the server is
// known to parse (`isVerifiedKeyShape`, OTH-R1); any other key → full save.

import { isDeepStrictEqual } from "node:util";
import type { HydratedPage, Overlay, RawPartialUpdateOperation } from "../types/common";
import type { RawConfiguration } from "../types/wire";
import { applyOverlay } from "./apply";
import { serializeFull } from "./full";
import { fullSaveReason, partialOperationsFor } from "./operations";
import { decodeValue, isVerifiedKeyShape, setPath } from "./paths";

type SerializeStrategy = "full" | "partial";

interface PartialPlan {
  strategy: "partial";
  operations: RawPartialUpdateOperation[];
  patched: HydratedPage;
}

interface FullPlan {
  strategy: "full";
  configurationString: string;
  patched: HydratedPage;
  /** Why a full save is used (overlay shape, or the partial ops did not cover the edit). */
  fallbackReason: string | null;
}

export type SavePlan = PartialPlan | FullPlan;

/** Replay partial ops on a clone of `inner` the way the server stores them. Null when a key does not resolve. */
export function replayOperations(inner: RawConfiguration, ops: RawPartialUpdateOperation[]): RawConfiguration | null {
  const clone = JSON.parse(JSON.stringify(inner ?? {})) as RawConfiguration;
  for (const op of ops) {
    if (!setPath(clone, op.key, decodeValue(op.value, op.dataType))) return null;
  }
  return clone;
}

export function planSave(before: HydratedPage, overlay: Overlay, forced?: SerializeStrategy): SavePlan {
  const patched = applyOverlay(before, overlay);
  const inner = (before.rawConfiguration ?? {}) as RawConfiguration;
  const full = (fallbackReason: string | null): FullPlan => ({
    strategy: "full",
    configurationString: serializeFull(patched),
    patched,
    fallbackReason,
  });

  if (forced === "full") return full("forced");
  const reason = fullSaveReason(overlay, inner);
  if (reason) return full(reason);

  const operations = partialOperationsFor(inner, overlay) ?? [];
  const unverified = operations.find((o) => !isVerifiedKeyShape(o.key));
  if (unverified) return full(`unverified partial-op key shape: ${unverified.key}`);
  const replayed = replayOperations(inner, operations);
  if (!replayed || !isDeepStrictEqual(replayed, patched.rawConfiguration)) {
    return full("partial operations do not cover the overlay");
  }
  return { strategy: "partial", operations, patched };
}

export { applyOverlay, withConfiguration } from "./apply";
export { serializeFull } from "./full";
export { fullSaveReason, partialOperationsFor } from "./operations";
