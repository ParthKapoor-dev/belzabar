// Full-configuration serializer.
//
// Round-trips a HydratedPage back to the stringified configuration the PD
// save endpoint expects. The strategy is deliberately conservative: we rebuild
// only what we have explicitly modeled (variables, httpRequests, inputs,
// events, styles, __version). Everything else in `rawConfiguration` is
// passed through untouched via the preserved `raw` shapes.
//
// The layout tree is re-serialized from the `raw` of the HydratedPage.layout
// — NOT from the ParsedNode tree. Reason: `applyOverlay` either edits scalars
// via element-operations (which rewrite into `raw`) or does nothing to the
// layout. If callers need to build a layout from scratch, that's a separate
// codepath not covered here.

import type { HydratedPage } from "../types/common";
import type { RawConfiguration, RawLayoutNode } from "../types/wire";

export function hydratedToInnerConfig(page: HydratedPage): RawConfiguration {
  // Start from the original parsed inner config (preserves all fields we
  // don't model explicitly, like __LAYOUT_CONFIG_METADATA, helpText, etc.).
  const source = (page.rawConfiguration as RawConfiguration) ?? {};
  const cloned: RawConfiguration = JSON.parse(JSON.stringify(source));

  // Rebuild variables.userDefined from page.variables (keeping per-var raw
  // when present, so fields like __LAYOUT_CONFIG_METADATA round-trip).
  const userDefined = page.variables.map((v) => {
    const r = (v.raw && typeof v.raw === "object" && !Array.isArray(v.raw)) ? { ...(v.raw as Record<string, unknown>) } : {};
    r.name = v.name;
    r.type = v.type ?? undefined;
    r.initialValue = v.initialValue;
    if (typeof v.translateInitialValue === "boolean") r.translateInitialValue = v.translateInitialValue;
    return r;
  });

  const derived = page.derived.map((d) => {
    const r = (d.raw && typeof d.raw === "object" && !Array.isArray(d.raw)) ? { ...(d.raw as Record<string, unknown>) } : {};
    r.name = d.name;
    r.from = d.from;
    r.spec = d.spec ?? undefined;
    if (d.filterFn !== null) r.filterFn = d.filterFn;
    r.sideEffect = d.sideEffect;
    return r;
  });

  // Use new-format output even when the input was legacy. This is a deliberate
  // one-way migration: `context.properties` pages save in the new shape. If
  // that ever causes trouble we can gate on the input shape.
  cloned.variables = {
    generated: Array.isArray(source.variables?.generated) ? source.variables!.generated! : [],
    userDefined,
    derived,
  };
  delete cloned.context;

  // httpRequests — rebuild generated/userDefined buckets from parsed list.
  const generatedHttp = page.httpRequests.filter((c) => c.source === "generated").map((c) => c.raw);
  const userDefinedHttp = page.httpRequests.filter((c) => c.source === "userDefined").map((c) => c.raw);
  cloned.httpRequests = {
    generated: generatedHttp,
    userDefined: userDefinedHttp,
  };
  // Legacy `http` array is dropped on save; legacy entries are moved into
  // userDefined on round-trip. Document this in docs/api-notes.md if it bites.
  if (page.httpRequests.some((c) => c.source === "legacy")) {
    for (const c of page.httpRequests) {
      if (c.source === "legacy") userDefinedHttp.push(c.raw);
    }
    delete cloned.http;
  }

  cloned.styles = page.styles ?? "";
  if (page.__version !== null) cloned.__version = page.__version;

  if (page.entityType === "COMPONENT") {
    cloned.inputs = page.inputs;
    cloned.events = page.events;
    cloned.helpText = page.helpText;
  } else {
    // Pages shouldn't carry these.
    delete cloned.inputs;
    delete cloned.events;
  }

  // Layout: always take the current raw (may have been mutated by overlay ops).
  cloned.layout = (page.layout.raw as RawLayoutNode) ?? undefined;

  return cloned;
}

export function serializeFull(page: HydratedPage): string {
  const inner = hydratedToInnerConfig(page);
  return JSON.stringify(inner);
}
