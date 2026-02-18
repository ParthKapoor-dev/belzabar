import type { ReportNode } from "./types";

/**
 * REPORTER SERVICE
 */

export function printTree(node: ReportNode, prefix: string = "", isLast: boolean = true) {
  for (const line of formatTreeLines(node, prefix, isLast)) {
    console.log(line);
  }
}

export function formatTreeLines(node: ReportNode, prefix: string = "", isLast: boolean = true): string[] {
  const lines: string[] = [];
  const marker = isLast ? "└── " : "├── ";
  const typeLabel = `[${node.type}]`;

  lines.push(`${prefix}${marker}${typeLabel} ${node.name} (ID: ${node.id.substring(0, 8)}...)`);
  const nextPrefix = prefix + (isLast ? "    " : "│   ");

  node.adIds.forEach((adId, index) => {
    const isLastAd = index === node.adIds.length - 1 && node.children.length === 0;
    const adMarker = isLastAd ? "└── " : "├── ";
    lines.push(`${nextPrefix}${adMarker}[AD] ${adId}`);
  });

  node.children.forEach((child, index) => {
    const isLastChild = index === node.children.length - 1;
    lines.push(...formatTreeLines(child, nextPrefix, isLastChild));
  });

  return lines;
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
