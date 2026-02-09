import { apiFetch } from "../../lib/api";

export async function run(args: string[]) {
  const publishedId = args[0];
  const payloadArg = args[1];

  if (!publishedId) {
    console.error("Error: Missing Published ID.");
    console.error("Run 'cli run-method --help' for usage.");
    process.exit(1);
  }

  let payload = {};

  if (payloadArg) {
    try {
      // Check if file exists
      const file = Bun.file(payloadArg);
      if (await file.exists()) {
        payload = await file.json();
      } else {
        // Treat as raw JSON string
        payload = JSON.parse(payloadArg);
      }
    } catch (e) {
      console.error("❌ Error: Payload argument is neither a valid file path nor valid JSON string.");
      process.exit(1);
    }
  } else {
     console.warn("⚠️  No payload provided. sending empty object '{}'.");
  }

  const path = `/rest/api/automation/chain/execute/${publishedId}?encrypted=true`;
  console.info(`[Exec] POST ${path}`);
  // console.log("Payload:", JSON.stringify(payload, null, 2));

  try {
    const response = await apiFetch(path, {
      method: "POST",
      authMode: "Raw", // Critical: No Bearer prefix
      body: JSON.stringify(payload),
    });

    const text = await response.text();

    if (!response.ok) {
        console.error(`❌ Execution failed (${response.status}): ${text}`);
        process.exit(1);
    }

    try {
        const json = JSON.parse(text);
        console.log("✅ Execution Result:");
        console.log(JSON.stringify(json, null, 2));
    } catch {
        console.log("✅ Execution Result (Text):");
        console.log(text);
    }

  } catch (error) {
    console.error("❌ Unexpected Error:", error);
    process.exit(1);
  }
}
