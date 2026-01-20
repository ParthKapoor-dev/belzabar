import { apiFetch } from "../../lib/api";

export async function run(args: string[]) {
  const targetId = args[0];
  if (!targetId) {
    console.error("Error: Missing UUID argument.");
    console.error("Run 'cli fetch-method --help' for usage.");
    process.exit(1);
  }

  const path = `/rest/api/automation/chain/${targetId}`;
  console.info(`[Info] GET ${path}`);

  try {
    const response = await apiFetch(path, {
      method: "GET",
      authMode: "Bearer",
    });

    if (response.status === 404) {
      console.error("❌ Error: 404 Chain Not Found");
      process.exit(1);
    }

    if (!response.ok) {
      console.error(`❌ Error: Request failed ${response.status} ${response.statusText}`);
      process.exit(1);
    }

    const data = await response.json();

    let publishedId = "";
    let draftId = "";

    if (data.automationState === "PUBLISHED") {
      publishedId = data.uuid;
      draftId = data.referenceId;
    } else {
      draftId = data.uuid;
      publishedId = data.referenceId;
    }

    console.log("----------------------");
    console.log(`Name:        ${data.aliasName}`);
    console.log(`State:       ${data.automationState}`);
    console.log(`Draft ID:    ${draftId}`);
    console.log(`Published ID:${publishedId}`);
    console.log("----------------------");

  } catch (error) {
    console.error("❌ Unexpected Error:", error);
    process.exit(1);
  }
}
