import { apiFetch, Config } from "@belzabar/core";
import type { PageConfigResponse, ComponentSearchItem } from "./types";

/**
 * API SERVICE for Page Designer
 */

const PD_BASE = "/rest/api/pagedesigner";

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
  return data.length > 0 ? data[0].id : null;
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
