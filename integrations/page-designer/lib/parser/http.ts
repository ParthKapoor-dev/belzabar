// HTTP service-call parser. Merges the new-format (httpRequests.userDefined)
// and the legacy flat `http` array into a single PageHttpRequest[] list,
// preserving order and tagging the source bucket for round-trip serialization.

import { cleanAdId } from "./refs";
import type {
  PageHttpInputBinding,
  PageHttpRequest,
  PageHttpSuccessMapping,
} from "../types/common";
import type { RawConfiguration, RawHttpRequestItem } from "../types/wire";

function stripBindingWrapper(expr: string | null | undefined): string | null {
  if (!expr) return null;
  const match = expr.match(/\{%([^%]+)%\}/);
  return match?.[1] ?? null;
}

function parseOne(
  item: RawHttpRequestItem,
  index: number,
  source: "generated" | "userDefined" | "legacy",
): PageHttpRequest {
  const sc = item.meta?.serviceCall;
  const url = item.request?.url;

  const inputBindings: PageHttpInputBinding[] = [];
  if (Array.isArray(sc?.inputState)) {
    for (const input of sc!.inputState!) {
      if (typeof input?.fieldCode === "string") {
        inputBindings.push({
          fieldCode: input.fieldCode,
          isBinding: input.isBinding === true,
          bindingVariable: typeof input.bindingVariable === "string" ? input.bindingVariable : null,
          value: input.value,
        });
      }
    }
  }

  const successMappings: PageHttpSuccessMapping[] = [];
  if (Array.isArray(item.handler?.success)) {
    for (const entry of item.handler!.success!) {
      if (Array.isArray(entry) && entry.length >= 2) {
        const [target, expr] = entry as [string, string];
        const varName = stripBindingWrapper(target) ?? target;
        successMappings.push({ variable: varName, expression: expr });
      }
    }
  }

  const eventMeta = sc?.eventMeta ?? null;

  return {
    index,
    label: sc?.label ?? "(unnamed)",
    callId: sc?.callId ?? null,
    serviceId: typeof sc?.serviceId === "number" ? sc.serviceId : null,
    serviceUuid: sc?.serviceUuid ?? null,
    adId: url ? cleanAdId(url) : null,
    method: item.request?.method ?? null,
    url: url ?? null,
    triggers: Array.isArray(item.trigger)
      ? item.trigger.map((t) => t.replace(/^this\./, ""))
      : [],
    triggerFilter: item.triggerFilter ?? null,
    inputBindings,
    successMappings,
    errorHandler: Array.isArray(item.handler?.error) ? item.handler!.error! : [],
    inProgressVar: stripBindingWrapper(item.handler?.inProgress),
    responseTransformSpec: item.responseTransformSpec ?? null,
    hasEventMeta: eventMeta !== null && eventMeta !== undefined,
    eventMetaEmpty: eventMeta !== null && eventMeta !== undefined && Object.keys(eventMeta).length === 0,
    eventMeta: eventMeta ?? null,
    requestBody: item.request?.body ?? null,
    source,
    raw: item,
  };
}

export function parseHttpRequests(config: RawConfiguration): PageHttpRequest[] {
  const items: PageHttpRequest[] = [];
  let index = 1;

  const generated = config.httpRequests?.generated ?? [];
  if (Array.isArray(generated)) {
    for (const item of generated) items.push(parseOne(item, index++, "generated"));
  }

  const userDefined = config.httpRequests?.userDefined ?? [];
  if (Array.isArray(userDefined)) {
    for (const item of userDefined) items.push(parseOne(item, index++, "userDefined"));
  }

  if (Array.isArray(config.http)) {
    for (const item of config.http) items.push(parseOne(item, index++, "legacy"));
  }

  return items;
}
