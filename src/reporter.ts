import type { ReportNode } from "./types";

/**
 * REPORTER SERVICE
 */

export function printTree(node: ReportNode, prefix: string = "", isLast: boolean = true) {
  const marker = isLast ? "└── " : "├── ";
  const typeLabel = `[${node.type}]`;
  
  console.log(`${prefix}${marker}${typeLabel} ${node.name} (ID: ${node.id.substring(0, 8)}...)`);

  const nextPrefix = prefix + (isLast ? "    " : "│   ");

  // Print AD IDs
  node.adIds.forEach((adId, index) => {
    const isLastAd = index === node.adIds.length - 1 && node.children.length === 0;
    const adMarker = isLastAd ? "└── " : "├── ";
    console.log(`${nextPrefix}${adMarker}[AD] ${adId}`);
  });

  // Print Children
  node.children.forEach((child, index) => {
    const isLastChild = index === node.children.length - 1;
    printTree(child, nextPrefix, isLastChild);
  });
}

export function collectAllAdIds(nodes: ReportNode[]): string[] {
  const allAds = new Set<string>();

  function traverse(node: ReportNode) {
    node.adIds.forEach(id => allAds.add(id));
    node.children.forEach(traverse);
  }

  nodes.forEach(traverse);
  return Array.from(allAds).sort();
}
