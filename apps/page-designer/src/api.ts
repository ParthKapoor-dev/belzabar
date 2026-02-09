import { BASE_URL, HEADERS } from "./config";
import type { PageConfigResponse, ComponentSearchItem } from "./types";

/**
 * API SERVICE
 */

export async function fetchPageConfig(pageId: string): Promise<PageConfigResponse | null> {
  const response = await fetch(`${BASE_URL}/pages/${pageId}`, { headers: HEADERS });
  if (!response.ok) return null;
  return response.json();
}

export async function fetchComponentIdByName(name: string): Promise<string | null> {
  const url = `${BASE_URL}/pages?name=${encodeURIComponent(name)}&apiInfoLevel=MEDIUM&status=DRAFT`;
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) return null;
  const data = (await response.json()) as ComponentSearchItem[];
  return data.length > 0 ? data[0].id : null;
}

export async function fetchComponentConfig(componentId: string): Promise<PageConfigResponse | null> {
  const url = `${BASE_URL}/pages/phrases/${componentId}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: HEADERS,
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