import { apiFetch, Config } from "@belzabar/core";
import type { PageConfigResponse, ComponentSearchItem } from "./types";

/**
 * API SERVICE for Page Designer
 */

const PD_BASE = "/rest/api/pagedesigner";

type PdStatus = "DRAFT" | "PUBLISHED";

function inferSymbolFlag(item: ComponentSearchItem): boolean | null {
  if (typeof item.isSymbol === "boolean") return item.isSymbol;

  const layout = item.layout as { isSymbol?: unknown } | undefined;
  if (layout && typeof layout.isSymbol === "boolean") return layout.isSymbol;

  const nestedLayout = (item as Record<string, unknown>).pageElement as
    | { layout?: { isSymbol?: unknown } }
    | undefined;
  if (nestedLayout?.layout && typeof nestedLayout.layout.isSymbol === "boolean") {
    return nestedLayout.layout.isSymbol;
  }

  return null;
}

function pickByType(items: ComponentSearchItem[], expectSymbol: boolean): ComponentSearchItem | null {
  if (items.length === 0) return null;

  const strict = items.find(item => inferSymbolFlag(item) === expectSymbol);
  if (strict) return strict;

  return items[0] ?? null;
}

export async function fetchPageConfig(pageId: string): Promise<PageConfigResponse | null> {
  const response = await apiFetch(`${PD_BASE}/pages/${pageId}`, { 
    method: "GET",
    authMode: "Bearer"
  });
  if (!response.ok) return null;
  return response.json();
}

export async function fetchComponentIdByName(name: string): Promise<string | null> {
  const url = `${PD_BASE}/pages?name=${encodeURIComponent(name)}&apiInfoLevel=MEDIUM&status=DRAFT`;
  const response = await apiFetch(url, { 
    method: "GET",
    authMode: "Bearer"
  });
  if (!response.ok) return null;
  const data = (await response.json()) as ComponentSearchItem[];
  const candidate = pickByType(data, true);
  return candidate?.id ?? null;
}

export async function searchPagesByName(
  name: string,
  status: PdStatus
): Promise<ComponentSearchItem[]> {
  const url = `${PD_BASE}/pages?name=${encodeURIComponent(name)}&apiInfoLevel=MEDIUM&status=${status}`;
  const response = await apiFetch(url, {
    method: "GET",
    authMode: "Bearer",
  });
  if (!response.ok) return [];
  return (await response.json()) as ComponentSearchItem[];
}

export async function fetchEntityIdsByName(
  name: string,
  type: "PAGE" | "COMPONENT"
): Promise<{ draftId: string | null; publishedId: string | null }> {
  const [draftItems, publishedItems] = await Promise.all([
    searchPagesByName(name, "DRAFT"),
    searchPagesByName(name, "PUBLISHED"),
  ]);

  const expectSymbol = type === "COMPONENT";
  const draft = pickByType(draftItems, expectSymbol);
  const published = pickByType(publishedItems, expectSymbol);

  return {
    draftId: draft?.id ?? null,
    publishedId: published?.id ?? null,
  };
}

export async function fetchComponentConfig(componentId: string): Promise<PageConfigResponse | null> {
  const url = `${PD_BASE}/pages/phrases/${componentId}`;
  const response = await apiFetch(url, {
    method: "PUT",
    authMode: "Bearer",
    body: JSON.stringify({
      status: "DRAFT",
      partialUpdate: true,
      pageElementOperations: [{ key: "layout.isSymbol", operation: "UPDATE", dataType: "BOOLEAN", value: "true" }],
      phrasesList: []
    }),
  });
  if (!response.ok) return null;
  return response.json();
}
