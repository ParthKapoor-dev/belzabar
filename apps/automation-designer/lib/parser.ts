import type { RawMethodResponse, HydratedMethod, InnerDefinition } from "./types";

export function parseMethodResponse(raw: RawMethodResponse): HydratedMethod {
  let inner: InnerDefinition = {};
  
  try {
    if (raw.jsonDefinition) {
      inner = JSON.parse(raw.jsonDefinition);
    }
  } catch (e) {
    console.warn("Failed to parse jsonDefinition string:", e);
    // Depending on requirements, we might want to throw or just proceed with partial data
    // For now, we proceed.
  }

  // Priority for Method Name: jsonDefinition.name > raw.aliasName
  const methodName = inner.name || raw.aliasName || "Unknown";
  const category = raw.category?.name || "Uncategorized";

  const method: HydratedMethod = {
    uuid: raw.uuid,
    referenceId: raw.referenceId,
    aliasName: raw.aliasName,
    methodName: methodName,
    category: category,
    version: raw.version || 0,
    state: raw.automationState,
    fetchedAt: Date.now(),
    
    createdOn: raw.createdOn,
    updatedOn: raw.lastUpdatedOn,
    updatedBy: raw.lastUpdatedBy,

    // Prefer summary from inner, fall back to description
    summary: inner.summary || inner.description || "(No description)",
    inputs: inner.inputs || [],
    services: inner.services || []
  };

  return method;
}
