// Serializer façade.
//
// Two modes:
//   - "partial" → emit pageElementOperations for the save endpoint (fast path)
//   - "full"    → stringify the inner configuration and PUT the whole thing
//
// pickStrategy() decides automatically based on overlay shape. Callers are
// free to force "full" when in doubt.

import type { HydratedPage, Overlay, RawPartialUpdateOperation } from "../types/common";
import { applyOverlay } from "./apply";
import { serializeFull } from "./full";
import { overlayRequiresFullSave, overlayToPartialOperations } from "./operations";

export type SerializeStrategy = "full" | "partial";

export function pickStrategy(overlay: Overlay): SerializeStrategy {
  return overlayRequiresFullSave(overlay) ? "full" : "partial";
}

export interface PartialSerialization {
  strategy: "partial";
  operations: RawPartialUpdateOperation[];
  /** The overlay post-applied page, used by the validator + diff. */
  patched: HydratedPage;
}

export interface FullSerialization {
  strategy: "full";
  configurationString: string;
  patched: HydratedPage;
}

export type SerializeResult = PartialSerialization | FullSerialization;

export function serialize(
  page: HydratedPage,
  overlay: Overlay,
  forcedStrategy?: SerializeStrategy,
): SerializeResult {
  const patched = applyOverlay(page, overlay);
  const strategy = forcedStrategy ?? pickStrategy(overlay);

  if (strategy === "partial") {
    return {
      strategy: "partial",
      operations: overlayToPartialOperations(page, overlay),
      patched,
    };
  }
  return {
    strategy: "full",
    configurationString: serializeFull(patched),
    patched,
  };
}

export { applyOverlay } from "./apply";
export { serializeFull, hydratedToInnerConfig } from "./full";
export {
  overlayRequiresFullSave,
  overlayToPartialOperations,
} from "./operations";
