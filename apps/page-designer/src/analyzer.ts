import { fetchPageConfig, fetchComponentConfig, fetchComponentIdByName } from "./api";
import { extractReferences } from "./parser";
import type { ReportNode } from "./types";

/**
 * ANALYZER SERVICE
 */

export async function analyzeItem(
  id: string,
  type: 'PAGE' | 'COMPONENT',
  name: string,
  visited: Set<string>,
  whitelist: Set<string>
): Promise<ReportNode> {
  // Cycle Detection: Add ID to visited
  visited.add(id);

  const node: ReportNode = {
    type,
    name,
    id,
    adIds: [],
    children: []
  };

  try {
    // 1. Fetch Config
    const data = type === 'PAGE' 
      ? await fetchPageConfig(id) 
      : await fetchComponentConfig(id);

    if (!data) return node;
    node.name = data.name || name;

    // 2. Parse References
    const { adIds, componentNames } = extractReferences(data.configuration, whitelist);
    node.adIds = adIds;

    // 3. Parallel Execution for Children
    const childPromises = componentNames.map(async (cName) => {
      const cId = await fetchComponentIdByName(cName);
      
      // Prevent recursion if no ID found or already visited
      if (!cId || visited.has(cId)) return null;

      return analyzeItem(cId, 'COMPONENT', cName, visited, whitelist);
    });

    const results = await Promise.all(childPromises);
    node.children = results.filter((child): child is ReportNode => child !== null);

  } catch (error) {
    console.error(`  ❌ Error analyzing ${type} ${name} (${id}):`, error);
  }

  return node;
}
