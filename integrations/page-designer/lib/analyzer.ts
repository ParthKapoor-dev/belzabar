import { file } from "bun";
import { CliError } from "@belzabar/core";
import { fetchComponentIdByName } from "./api/index";
import { cachedFetchPageConfig as fetchPageConfig, cachedFetchComponentConfig as fetchComponentConfig } from "./cache";
import { extractReferences } from "./parser/index";
import type { ReportNode } from "./types/legacy";

/**
 * ANALYZER SERVICE
 */

/**
 * Load the component-name whitelist (a JSON array of names) used by the
 * recursive analyzers. Anything other than a string array is refused instead
 * of silently producing a whitelist that matches nothing.
 */
export async function loadComponentsWhitelist(
  missingMessage: string,
  path = "components.json",
): Promise<Set<string>> {
  const f = file(path);
  if (!(await f.exists())) {
    throw new CliError(missingMessage, { code: "COMPONENTS_FILE_MISSING" });
  }
  let list: unknown;
  try {
    list = await f.json();
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list) || !list.every((x): x is string => typeof x === "string")) {
    throw new CliError(`${path} must be a JSON array of component names.`, {
      code: "COMPONENTS_FILE_INVALID",
      details: { path },
    });
  }
  return new Set(list);
}

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
    // Keep partial results and continue traversal for resiliency.
  }

  return node;
}
