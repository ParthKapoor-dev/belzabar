import { apiFetch as baseApiFetch } from "@belzabar/core";

export const apiFetch = baseApiFetch;

export async function fetchAutomationDefinition(automationId: string) {
  const path = `/rest/api/automations/${automationId}?basicinfo=false`;
  return apiFetch(path, {
    method: "GET",
    authMode: "Bearer"
  });
}

export async function fetchMethodDefinition(uuid: string) {
  const path = `/rest/api/automation/chain/${uuid}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch method: ${response.status} ${response.statusText}`);
  }
  return await response.json(); 
}

export async function testMethod(formData: FormData) {
    const path = "/rest/api/automation/chain/test";
    return apiFetch(path, {
        method: "POST",
        authMode: "Bearer",
        headers: {
            "internal-ad-execution-mode": "debug",
            "Expertly-Auth-Token": "true" // Signal to attachAuth to inject it
        },
        body: formData
    });
}