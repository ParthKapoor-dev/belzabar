import type { InternalConfig, LayoutNode } from "./types";

/**
 * PARSER SERVICE
 */

export function cleanAdId(url: string): string | null {
  const pattern = /\/rest\/api\/automation\/chain\/execute\/([a-zA-Z0-9]+)/;
  const match = url.match(pattern);
  return match ? match[1] : null;
}

export function extractReferences(configStr: string, whitelist: Set<string>) {
  const adIds = new Set<string>();
  const componentNames = new Set<string>();

  try {
    const config: InternalConfig = JSON.parse(configStr);

    // 1. Extract AD IDs
    config.httpRequests?.userDefined?.forEach(item => {
      const url = item.request?.url;
      if (url) {
        const id = cleanAdId(url);
        if (id) adIds.add(id);
      }
    });

    // 2. Extract Components recursively
    const traverse = (node?: LayoutNode) => {
      if (!node) return;
      if (node.name && whitelist.has(node.name)) {
        componentNames.add(node.name);
      }
      node.children?.forEach(traverse);
    };
    traverse(config.layout);

  } catch (e) {
    // Silently handle parse errors or log if necessary
  }

  return {
    adIds: Array.from(adIds),
    componentNames: Array.from(componentNames)
  };
}