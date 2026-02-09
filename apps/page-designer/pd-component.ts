import { file } from "bun";

/**
 * CONFIGURATION
 */
const BEARER_TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InJ3SmM4d2Yydi1PeFdrX1QxZ2F6OHlpeGhQayJ9.eyJhdWQiOiIzMmQ4NWI4YS1lOWI0LTQxZTUtYTM2Zi0yNDUzMDFlZjlkMGYiLCJleHAiOjE3NzA3MTQwNjMsImlhdCI6MTc3MDYyNzY2MywiaXNzIjoibnNtLWRldi5uYy52ZXJpZmkuZGV2Iiwic3ViIjoiZmJiY2Y5NTYtNGMxZC00MGM0LWFlZGQtZjY0MGYzZWE2ZDBjIiwianRpIjoiZDdhM2RkOWUtZGFmYS00ODMxLWIyYjctZjc0OWEzZGRhZWExIiwiYXV0aGVudGljYXRpb25UeXBlIjoiUEFTU1dPUkQiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJydXBpbkB3ZWJpbnRlbnNpdmUuY29tIiwiYXBwbGljYXRpb25JZCI6IjMyZDg1YjhhLWU5YjQtNDFlNS1hMzZmLTI0NTMwMWVmOWQwZiIsInJvbGVzIjpbXSwic2lkIjoiNzlkYzNjNDgtMjZkOS00NjMxLTlmM2MtMDZkNGYxM2FmMDM0IiwiYXV0aF90aW1lIjoxNzcwNjI3NjYzLCJ0aWQiOiJmMTNmYWFkNi01NjEzLTQzMjctYmM2Ni1iZmNhYWVmODlhZTAifQ.A_pzfgW78IYqr2677MBXmRHJN78kmRS4RPn0W_MisqcDYeZehiTlChgRlA6vJVELqFDJkMTmPgwTh8JjwiZkbQELRqIYV8BXsqFOuEM6QF5ubnCFK44aWnV4Sph1LoF3-ZjNs_hzRD2bHGW7xCjXedWgQePl8I07Vt0g_aIfxX3Z-Tw0kudXWeDTvhvZGVa7Jxvo9tXejKoKK_Pq0V7WkMK4GgWXHGpPLeHTdaEvi9ByFoSWNocJtXjNPBRwyf8L_CwR_4uNJ8a9G_Dhh6256NUQ_80-87AgJh8wy26r-BMkiE3dyzCybp1J6hod7QFWq39seM76glkJzR4kENLazg";
const COOKIES = "<PLACEHOLDER>";

const TARGET_PAGE_IDS = [
  "406735d54e938e60517ab6d91a497b20",
];

const BASE_URL = "https://nsm-dev.nc.verifi.dev/rest/api/pagedesigner";

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
 * UTILS & PARSING
 */

const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0",
  "Accept": "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "authorization": BEARER_TOKEN.startsWith("Bearer ") ? BEARER_TOKEN : `Bearer ${BEARER_TOKEN}`,
  "Cookie": COOKIES,
};

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
  const url = `${BASE_URL}/pages?name=${encodeURIComponent(name)}&apiInfoLevel=MEDIUM&status=DRAFT`;
  try {
    const res = await fetch(url, { headers: COMMON_HEADERS });
    if (!res.ok) return null;
    const data = (await res.json()) as ComponentSearchResponse[];
    return data.length > 0 ? data[0].id : null;
  } catch {
    return null;
  }
}

async function getComponentConfig(id: string): Promise<string | null> {
  const url = `${BASE_URL}/pages/phrases/${id}`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: COMMON_HEADERS,
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
    
    const url = `${BASE_URL}/pages/${pageId}`;
    const res = await fetch(url, { headers: COMMON_HEADERS });
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
