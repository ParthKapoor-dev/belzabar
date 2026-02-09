import { file } from "bun";

/**
 * CONFIGURATION
 * Update these values with your actual credentials and target pages.
 */
const BEARER_TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InJ3SmM4d2Yydi1PeFdrX1QxZ2F6OHlpeGhQayJ9.eyJhdWQiOiIzMmQ4NWI4YS1lOWI0LTQxZTUtYTM2Zi0yNDUzMDFlZjlkMGYiLCJleHAiOjE3NzA3MTQwNjMsImlhdCI6MTc3MDYyNzY2MywiaXNzIjoibnNtLWRldi5uYy52ZXJpZmkuZGV2Iiwic3ViIjoiZmJiY2Y5NTYtNGMxZC00MGM0LWFlZGQtZjY0MGYzZWE2ZDBjIiwianRpIjoiZDdhM2RkOWUtZGFmYS00ODMxLWIyYjctZjc0OWEzZGRhZWExIiwiYXV0aGVudGljYXRpb25UeXBlIjoiUEFTU1dPUkQiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJydXBpbkB3ZWJpbnRlbnNpdmUuY29tIiwiYXBwbGljYXRpb25JZCI6IjMyZDg1YjhhLWU5YjQtNDFlNS1hMzZmLTI0NTMwMWVmOWQwZiIsInJvbGVzIjpbXSwic2lkIjoiNzlkYzNjNDgtMjZkOS00NjMxLTlmM2MtMDZkNGYxM2FmMDM0IiwiYXV0aF90aW1lIjoxNzcwNjI3NjYzLCJ0aWQiOiJmMTNmYWFkNi01NjEzLTQzMjctYmM2Ni1iZmNhYWVmODlhZTAifQ.A_pzfgW78IYqr2677MBXmRHJN78kmRS4RPn0W_MisqcDYeZehiTlChgRlA6vJVELqFDJkMTmPgwTh8JjwiZkbQELRqIYV8BXsqFOuEM6QF5ubnCFK44aWnV4Sph1LoF3-ZjNs_hzRD2bHGW7xCjXedWgQePl8I07Vt0g_aIfxX3Z-Tw0kudXWeDTvhvZGVa7Jxvo9tXejKoKK_Pq0V7WkMK4GgWXHGpPLeHTdaEvi9ByFoSWNocJtXjNPBRwyf8L_CwR_4uNJ8a9G_Dhh6256NUQ_80-87AgJh8wy26r-BMkiE3dyzCybp1J6hod7QFWq39seM76glkJzR4kENLazg";
const COOKIES = "<PLACEHOLDER>";

const TARGET_PAGE_IDS = [
  "406735d54e938e60517ab6d91a497b20",
];

const BASE_URL = "https://nsm-dev.nc.verifi.dev/rest/api/pagedesigner/pages";

/**
 * INTERFACES
 */
interface UserDefinedRequest {
  request: {
    url: string;
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
  configuration: string; // stringified JSON
}

/**
 * DATA EXTRACTION LOGIC
 */

/**
 * Extracts unique Automation Designer (AD) IDs from the configuration's httpRequests.
 */
function extractAdIds(config: PageConfiguration): string[] {
  const adIds = new Set<string>();
  const userDefinedRequests = config.httpRequests?.userDefined || [];

  const adIdPattern = /\/rest\/api\/automation\/chain\/execute\/([a-zA-Z0-9]+)/;

  for (const item of userDefinedRequests) {
    const url = item.request?.url;
    if (url) {
      const match = url.match(adIdPattern);
      if (match && match[1]) {
        adIds.add(match[1]);
      }
    }
  }

  return Array.from(adIds);
}

/**
 * Recursively traverses the layout tree to collect all component names.
 */
function extractComponentNames(node: LayoutNode | undefined, names: Set<string> = new Set()): string[] {
  if (!node) return Array.from(names);

  if (node.name) {
    names.add(node.name);
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      extractComponentNames(child, names);
    }
  }

  return Array.from(names);
}

/**
 * MAIN EXECUTION
 */
async function run() {
  console.log("🚀 Starting Page Designer Configuration Analysis...");

  // 1. Load components.json
  let componentsList: string[] = [];
  try {
    const componentsFile = file("components.json");
    if (!(await componentsFile.exists())) {
      console.error("❌ Error: components.json not found.");
      return;
    }
    componentsList = await componentsFile.json();
    const componentsSet = new Set(componentsList);

    // 2. Process each Page ID
    for (const pageId of TARGET_PAGE_IDS) {
      console.log(`--- Processing Page ID: ${pageId} ---`);

      try {
        // Fetch Page Data
        const response = await fetch(`${BASE_URL}/${pageId}`, {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0",
            "Accept": "application/json, text/plain, */*",
            "Referer": `https://nsm-dev.nc.verifi.dev/ui-designer/page/${pageId}`,
            "Content-Type": "application/json",
            "authorization": BEARER_TOKEN.startsWith("Bearer ") ? BEARER_TOKEN : `Bearer ${BEARER_TOKEN}`,
            "Cookie": COOKIES,
          },
        });

        if (!response.ok) {
          throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }

        const data = (await response.json()) as PageDesignerResponse;
        const pageName = data.name || "Unknown Page";

        // Parse internal stringified configuration
        let config: PageConfiguration;
        try {
          config = JSON.parse(data.configuration);
        } catch (e) {
          throw new Error(`Failed to parse internal 'configuration' string: ${e instanceof Error ? e.message : String(e)}`);
        }

        // Requirement 1: Extract AD IDs
        const foundAdIds = extractAdIds(config);

        // Requirement 2: Component Cross-Reference
        const allUsedComponents = extractComponentNames(config.layout);
        const matchingComponents = allUsedComponents.filter(name => componentsSet.has(name));

        // Output Results
        console.log(`Page Name: ${pageName}`);
        console.log(`Found AD IDs: ${foundAdIds.length > 0 ? foundAdIds.join(", ") : "None"}`);
        console.log(`Matching Components: ${matchingComponents.length > 0 ? matchingComponents.join(", ") : "None"}`);
        console.log("");

      } catch (error) {
        console.error(`❌ Error processing page ${pageId}:`, error instanceof Error ? error.message : error);
        console.log("");
      }
    }

    console.log("✅ Analysis Complete.");

  } catch (error) {
    console.error("❌ Critical Error:", error instanceof Error ? error.message : error);
  }
}

run();
