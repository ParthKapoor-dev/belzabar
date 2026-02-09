import type { ReportNode, ComplianceResult, RogueIdInfo } from "./types";

/**
 * COMPARATOR SERVICE
 */

/**
 * Recursively searches the tree for nodes that contain a specific AD ID.
 */
function findNodesWithAdId(nodes: ReportNode[], targetAdId: string): string[] {
  const sources = new Set<string>();

  function traverse(node: ReportNode) {
    if (node.adIds.includes(targetAdId)) {
      sources.add(node.name);
    }
    node.children.forEach(traverse);
  }

  nodes.forEach(traverse);
  return Array.from(sources);
}

/**
 * Verifies if the generated AD IDs are a subset of the master approved list.
 * Identifies rogue IDs and their sources.
 */
export function verifyCompliance(rootNodes: ReportNode[], masterIds: Set<string>): ComplianceResult {
  const allGeneratedAds = new Set<string>();
  
  // Flatten tree to get all unique generated IDs
  function collect(node: ReportNode) {
    node.adIds.forEach(id => allGeneratedAds.add(id));
    node.children.forEach(collect);
  }
  rootNodes.forEach(collect);

  const rogueIds: RogueIdInfo[] = [];
  const commonIds: string[] = [];
  const missingIds: string[] = [];
  
  // 1. Check Generated vs Master (Rogue & Common)
  for (const genId of allGeneratedAds) {
    if (masterIds.has(genId)) {
      commonIds.push(genId);
    } else {
      const foundIn = findNodesWithAdId(rootNodes, genId);
      rogueIds.push({ id: genId, foundIn });
    }
  }

  // 2. Check Master vs Generated (Missing)
  for (const masterId of masterIds) {
    if (!allGeneratedAds.has(masterId)) {
      missingIds.push(masterId);
    }
  }

  return {
    isCompliant: rogueIds.length === 0,
    rogueIds,
    missingIds: missingIds.sort(),
    commonIds: commonIds.sort()
  };
}
