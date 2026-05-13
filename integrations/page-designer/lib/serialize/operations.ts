// Overlay → pageElementOperations serializer.
//
// Takes a (current) HydratedPage plus an Overlay and returns the PD partial-
// update operations. The overlay is declarative:
//   variables.update     → UPDATE at variables.userDefined[index].initialValue
//   httpRequests.update  → UPDATE at httpRequests.userDefined[index].request.body (etc.)
//   elements.operations  → pass-through (caller-supplied raw operations)
//   styles.replace       → UPDATE at `styles`
//
// For shapes that *can't* be partialed (variables.add, variables.remove,
// derived.*, httpRequests.add/remove), this serializer emits NO operations —
// the strategy picker in index.ts switches to full-update instead.

import type {
  ElementOperation,
  HydratedPage,
  Overlay,
  PartialDataType,
  RawPartialUpdateOperation,
} from "../types/common";

function guessDataType(value: unknown): PartialDataType {
  if (Array.isArray(value)) return "ARRAY";
  if (value === null) return "OBJECT";
  const t = typeof value;
  if (t === "string") return "STRING";
  if (t === "number") return "NUMBER";
  if (t === "boolean") return "BOOLEAN";
  return "OBJECT";
}

function stringifyValue(value: unknown, dataType: PartialDataType): string {
  if (dataType === "STRING") {
    return typeof value === "string" ? value : String(value);
  }
  if (dataType === "NUMBER") {
    if (typeof value === "number") return String(value);
    if (typeof value === "string" && !Number.isNaN(Number(value))) return value;
    return String(Number(value));
  }
  if (dataType === "BOOLEAN") {
    return value === true ? "true" : "false";
  }
  // ARRAY / OBJECT → JSON.stringify
  return JSON.stringify(value ?? null);
}

function toRawOperation(op: ElementOperation): RawPartialUpdateOperation {
  const dataType = op.dataType;
  return {
    key: op.key,
    value: stringifyValue(op.value, dataType),
    operation: op.operation,
    dataType,
  };
}

// Returns a list of operations ONLY for the shapes partials can express.
// Returns empty array when the overlay has nothing partial-able — callers
// should then route through full serialization.
export function overlayToPartialOperations(
  page: HydratedPage,
  overlay: Overlay,
): RawPartialUpdateOperation[] {
  const ops: RawPartialUpdateOperation[] = [];

  // variables.update → per-var initialValue / type edits
  if (overlay.variables?.update) {
    for (const upd of overlay.variables.update) {
      const idx = page.variables.findIndex((v) => v.name === upd.name);
      if (idx < 0) continue; // silently skip unknowns; full path will fail
      if (upd.initialValue !== undefined) {
        const dt = guessDataType(upd.initialValue);
        ops.push({
          key: `variables.userDefined[${idx}].initialValue`,
          value: stringifyValue(upd.initialValue, dt),
          operation: "UPDATE",
          dataType: dt,
        });
      }
      if (upd.type !== undefined) {
        ops.push({
          key: `variables.userDefined[${idx}].type`,
          value: upd.type,
          operation: "UPDATE",
          dataType: "STRING",
        });
      }
      if (upd.translateInitialValue !== undefined) {
        ops.push({
          key: `variables.userDefined[${idx}].translateInitialValue`,
          value: upd.translateInitialValue ? "true" : "false",
          operation: "UPDATE",
          dataType: "BOOLEAN",
        });
      }
    }
  }

  // httpRequests.update → per-call request body / handler / trigger edits
  if (overlay.httpRequests?.update) {
    for (const upd of overlay.httpRequests.update) {
      const userDefinedList = page.httpRequests.filter((c) => c.source === "userDefined");
      const idx = userDefinedList.findIndex((c) => c.callId === upd.callId);
      if (idx < 0) continue;

      if (upd.request?.body !== undefined) {
        ops.push({
          key: `httpRequests.userDefined[${idx}].request.body`,
          value: upd.request.body,
          operation: "UPDATE",
          dataType: "STRING",
        });
      }
      if (upd.request?.url !== undefined) {
        ops.push({
          key: `httpRequests.userDefined[${idx}].request.url`,
          value: upd.request.url,
          operation: "UPDATE",
          dataType: "STRING",
        });
      }
      if (upd.request?.method !== undefined) {
        ops.push({
          key: `httpRequests.userDefined[${idx}].request.method`,
          value: upd.request.method,
          operation: "UPDATE",
          dataType: "STRING",
        });
      }
      if (upd.handler?.success !== undefined) {
        ops.push({
          key: `httpRequests.userDefined[${idx}].handler.success`,
          value: JSON.stringify(upd.handler.success),
          operation: "UPDATE",
          dataType: "ARRAY",
        });
      }
      if (upd.handler?.inProgress !== undefined) {
        ops.push({
          key: `httpRequests.userDefined[${idx}].handler.inProgress`,
          value: upd.handler.inProgress,
          operation: "UPDATE",
          dataType: "STRING",
        });
      }
      if (upd.trigger !== undefined) {
        ops.push({
          key: `httpRequests.userDefined[${idx}].trigger`,
          value: JSON.stringify(upd.trigger),
          operation: "UPDATE",
          dataType: "ARRAY",
        });
      }
      if (upd.triggerFilter !== undefined) {
        ops.push({
          key: `httpRequests.userDefined[${idx}].triggerFilter`,
          value: upd.triggerFilter,
          operation: "UPDATE",
          dataType: "STRING",
        });
      }
    }
  }

  // elements.operations → pass-through
  if (overlay.elements?.operations) {
    for (const op of overlay.elements.operations) ops.push(toRawOperation(op));
  }

  // styles.replace → single leaf op
  if (overlay.styles?.replace !== undefined) {
    ops.push({
      key: "styles",
      value: overlay.styles.replace,
      operation: "UPDATE",
      dataType: "STRING",
    });
  }

  return ops;
}

// Decide whether the overlay is wholly expressible as partial ops, or if a
// full save is required. Any add/remove of variables/derived/http forces full.
export function overlayRequiresFullSave(overlay: Overlay): boolean {
  if (overlay.variables?.add?.length) return true;
  if (overlay.variables?.remove?.length) return true;
  if (overlay.derived?.add?.length) return true;
  if (overlay.derived?.update?.length) return true;
  if (overlay.derived?.remove?.length) return true;
  if (overlay.httpRequests?.add?.length) return true;
  if (overlay.httpRequests?.remove?.length) return true;
  return false;
}
