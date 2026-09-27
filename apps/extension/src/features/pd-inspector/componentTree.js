// Component-nesting tree.
//
// Built purely from compiled configs (no DOM) — so it is exact: it shows
// precisely which PD components a page embeds, and how they nest. Each entry
// also carries its own config node tree (with visibility conditions) so the
// panel can show what is inside a component, including conditionally-hidden
// nodes.

import { buildTree, summarize } from './tree.js';
import { collectSymbolNames } from './config.js';

/**
 * A node in the component-nesting tree.
 * @typedef {{
 *   name: string,
 *   isPage: boolean,
 *   referencePageId: string,
 *   nodeTree: object | null,
 *   nodeSummary: { total: number, bound: number, hidden: number },
 *   children: ComponentTreeNode[],
 *   error: string | null
 * }} ComponentTreeNode
 */

/**
 * Build the component-nesting tree for a page.
 * @param {object} pageConfig         from fetchPageConfig
 * @param {Map<string,object>} graph  from fetchComponentGraph
 * @returns {ComponentTreeNode}
 */
export function buildComponentTree(pageConfig, graph) {
  // ancestor-path guard: a component may appear several times as a sibling,
  // but must not expand inside itself (true cycle).
  const make = (name, layout, referencePageId, isPage, error, ancestors) => {
    const nodeTree = layout ? buildTree(layout) : null;
    const node = {
      name,
      isPage: !!isPage,
      referencePageId: referencePageId || '',
      nodeTree,
      nodeSummary: nodeTree
        ? summarize(nodeTree)
        : { total: 0, bound: 0, hidden: 0 },
      children: [],
      error: error || null
    };

    if (layout && !ancestors.has(name)) {
      const nextAncestors = new Set(ancestors).add(name);
      for (const childName of collectSymbolNames(layout)) {
        const cc = graph.get(childName);
        if (cc) {
          node.children.push(
            make(cc.name, cc.layout, cc.referencePageId, false, cc.error, nextAncestors)
          );
        } else {
          node.children.push(
            make(childName, null, '', false, 'component not fetched', nextAncestors)
          );
        }
      }
    }
    return node;
  };

  return make(
    pageConfig.path,
    pageConfig.layout,
    pageConfig.referencePageId,
    true,
    null,
    new Set()
  );
}

/** Flatten unique component names embedded in the tree (excludes the page). */
export function componentNames(root) {
  const names = new Set();
  const walk = (n) => {
    if (!n.isPage) names.add(n.name);
    n.children.forEach(walk);
  };
  walk(root);
  return [...names];
}
