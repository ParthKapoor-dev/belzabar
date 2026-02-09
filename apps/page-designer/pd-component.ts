import { file } from "bun";
import { apiFetch, Config } from "@belzabar/core";

/**
 * CONFIGURATION
 */
const TARGET_PAGE_IDS = [
  "406735d54e938e60517ab6d91a497b20",
];

const PD_BASE = "/rest/api/pagedesigner";

/**
 * INTERFACES
 */
interface UserDefinedRequest {
  request?: {
    url?: string;
  };
}

interface LayoutNode {
  name: string;
  children?: LayoutNode[];
}

interface PageConfiguration {
  httpRequests?: {
    userDefined?: UserDefinedRequest[];
  };
  layout?: LayoutNode;
}

interface PageDesignerResponse {
  name: string;
  configuration: string;
}

interface ComponentSearchResponse {
  id: string;
  name: string;
}

/**
 * Core parsing logic shared between pages and components.
 */
function extractFromConfig(configStr: string, componentsWhitelist: Set<string>): { adIds: string[], foundComponents: string[] } {
  let config: PageConfiguration;
  try {
    config = typeof configStr === 'string' ? JSON.parse(configStr) : configStr;
  } catch (e) {
    console.error("  ⚠️ Failed to parse configuration JSON.");
    return { adIds: [], foundComponents: [] };
  }

  // 1. Extract AD IDs
  const adIds = new Set<string>();
  const adIdPattern = /\/rest\/api\/automation\/chain\/execute\/([a-zA-Z0-9]+)/;
  config.httpRequests?.userDefined?.forEach(item => {
    const url = item.request?.url;
    if (url) {
      const match = url.match(adIdPattern);
      if (match && match[1]) adIds.add(match[1]);
    }
  });

  // 2. Extract Components recursively from layout
  const foundComponents = new Set<string>();
  const traverse = (node: LayoutNode | undefined) => {
    if (!node) return;
    if (node.name && componentsWhitelist.has(node.name)) {
      foundComponents.add(node.name);
    }
    node.children?.forEach(traverse);
  };
  traverse(config.layout);

  return {
    adIds: Array.from(adIds),
    foundComponents: Array.from(foundComponents)
  };
}

/**
 * API WRAPPERS
 */

async function getComponentId(name: string): Promise<string | null> {
  const url = `${PD_BASE}/pages?name=${encodeURIComponent(name)}&apiInfoLevel=MEDIUM&status=DRAFT`;
  try {
    const res = await apiFetch(url, { method: "GET", authMode: "Bearer" });
    if (!res.ok) return null;
    const data = (await res.json()) as ComponentSearchResponse[];
    return data.length > 0 ? data[0].id : null;
  } catch {
    return null;
  }
}

async function getComponentConfig(id: string): Promise<string | null> {
  const url = `${PD_BASE}/pages/phrases/${id}`;
  try {
    const res = await apiFetch(url, {
      method: "PUT",
      authMode: "Bearer",
      body: JSON.stringify({
        status: "DRAFT",
        partialUpdate: true,
        pageElementOperations: [{ key: "layout.isSymbol", operation: "UPDATE", dataType: "BOOLEAN", value: "true" }],
        phrasesList: []
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as PageDesignerResponse;
    return data.configuration;
  } catch {
    return null;
  }
}

/**
 * RECURSIVE ENGINE
 */
class Analyzer {
  visitedComponents = new Set<string>();
  masterAdIds = new Set<string>();
  masterComponents = new Set<string>();
  componentsWhitelist: Set<string>;

  constructor(whitelist: string[]) {
    this.componentsWhitelist = new Set(whitelist);
  }

  async analyzeRecursive(componentName: string, depth: number = 0) {
    if (this.visitedComponents.has(componentName)) return;
    this.visitedComponents.add(componentName);
    this.masterComponents.add(componentName);

    const indent = "  ".repeat(depth + 1);
    console.log(`${indent}🔍 Analyzing component: ${componentName}`);

    const id = await getComponentId(componentName);
    if (!id) {
      console.log(`${indent}  ⚠️ Could not find ID for ${componentName}`);
      return;
    }

    const configStr = await getComponentConfig(id);
    if (!configStr) {
      console.log(`${indent}  ⚠️ Could not fetch config for ${componentName}`);
      return;
    }

    const { adIds, foundComponents } = extractFromConfig(configStr, this.componentsWhitelist);
    
    // Add AD IDs to master list
    adIds.forEach(id => this.masterAdIds.add(id));
    if (adIds.length > 0) {
      console.log(`${indent}  👉 Found AD IDs: ${adIds.join(", ")}`);
    }

    // Recurse into nested components
    if (foundComponents.length > 0) {
      await Promise.all(foundComponents.map(comp => this.analyzeRecursive(comp, depth + 1)));
    }
  }

  async analyzeRootPage(pageId: string) {
    console.log(`--- Processing Root Page: ${pageId} ---`);
    
    const url = `${PD_BASE}/pages/${pageId}`;
    const res = await apiFetch(url, { method: "GET", authMode: "Bearer" });
    if (!res.ok) throw new Error(`Failed to fetch root page: ${res.status}`);
    
    const data = (await res.json()) as PageDesignerResponse;
    console.log(`Page Name: ${data.name}`);

    const { adIds, foundComponents } = extractFromConfig(data.configuration, this.componentsWhitelist);
    
    adIds.forEach(id => this.masterAdIds.add(id));
    
    console.log(`  Initial components found: ${foundComponents.length}`);
    await Promise.all(foundComponents.map(comp => this.analyzeRecursive(comp)));
    
    console.log(`
--- Summary for ${data.name} ---`);
    console.log(`Total Unique AD IDs: ${this.masterAdIds.size}`);
    console.log(`Unique AD IDs: [${Array.from(this.masterAdIds).join(", ")}]`);
    console.log(`Total Unique Components: ${this.masterComponents.size}`);
    console.log(`Unique Components: [${Array.from(this.masterComponents).join(", ")}]`);
    console.log("-------------------------------------------");
  }
}

/**
 * MAIN
 */
async function main() {
  try {
    const componentsFile = file("components.json");
    if (!(await componentsFile.exists())) {
      console.error("❌ components.json not found.");
      return;
    }
    const componentsList = await componentsFile.json();

    for (const pageId of TARGET_PAGE_IDS) {
      const analyzer = new Analyzer(componentsList);
      await analyzer.analyzeRootPage(pageId);
    }
    
    console.log("✅ All pages processed.");
  } catch (error) {
    console.error("❌ Critical Error:", error);
  }
}

main();