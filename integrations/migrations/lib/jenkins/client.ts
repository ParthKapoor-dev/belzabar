import { CliError } from "@belzabar/core";
import { buildHeaders, type JenkinsAuth } from "./auth";
import { fetchCrumb } from "./crumb";
import type {
  BuildInfo,
  ConsoleChunk,
  JenkinsParameterDefinition,
  QueueItem,
  TriggerBuildInput,
} from "../types";
import { QUEUE_POLL_INTERVAL_MS } from "../constants";

function jobBase(auth: JenkinsAuth): string {
  return `${auth.baseUrl}/job/${encodeURIComponent(auth.job)}`;
}

export async function getJobParameters(auth: JenkinsAuth): Promise<JenkinsParameterDefinition[]> {
  const url = `${jobBase(auth)}/api/json?tree=property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]`;
  const res = await fetch(url, { headers: buildHeaders(auth) });
  if (!res.ok) {
    throw new CliError(`Failed to fetch Jenkins job parameters (${res.status}): ${await res.text()}`, {
      code: "MIGRATE_JENKINS_PARAMS_FAILED",
    });
  }
  const json = (await res.json()) as {
    property?: Array<{ parameterDefinitions?: Array<{
      name: string;
      type: string;
      description?: string;
      choices?: string[];
      defaultParameterValue?: { value?: unknown };
    }> }>;
  };
  const defs = json.property?.find((p) => p.parameterDefinitions)?.parameterDefinitions ?? [];
  return defs.map((d) => ({
    name: d.name,
    type: d.type,
    description: d.description,
    choices: d.choices,
    defaultValue: d.defaultParameterValue?.value as string | boolean | undefined,
  }));
}

function buildParameterFormData(input: TriggerBuildInput): URLSearchParams {
  const params = new URLSearchParams();
  params.set("CLIENT", input.client);
  params.set("PROFILE_NAME", input.profile);
  params.set("MIGRATE_TYPE", input.migrateType);
  params.set("IDS", input.ids.join(","));
  params.set("MIGRATION_ID", input.migrationId ?? "");
  params.set("ASYNC_MIGRATION", input.asyncMigration);
  params.set("MIGRATE_DEPENDENT", input.migrateDependent);
  params.set("DEVOPS_TAG", input.devopsTag ?? "develop");
  params.set("DRY_RUN", String(Boolean(input.dryRun)));
  params.set("AUTO_APPROVE", String(input.autoApprove ?? true));
  return params;
}

export async function triggerBuild(auth: JenkinsAuth, input: TriggerBuildInput): Promise<{ queueUrl: string }> {
  const crumb = await fetchCrumb(auth);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (crumb) {
    headers[crumb.field] = crumb.value;
    if (crumb.cookie) headers["Cookie"] = crumb.cookie;
  }

  const url = `${jobBase(auth)}/buildWithParameters`;
  const body = buildParameterFormData(input);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...buildHeaders(auth), ...headers },
    body: body.toString(),
    redirect: "manual",
  });

  if (res.status !== 201 && res.status !== 200 && res.status !== 303) {
    throw new CliError(`Failed to trigger Jenkins build (${res.status}): ${await res.text()}`, {
      code: "MIGRATE_JENKINS_TRIGGER_FAILED",
      details: { status: res.status, url },
    });
  }

  const queueUrl = res.headers.get("Location");
  if (!queueUrl) {
    throw new CliError("Jenkins did not return a queue Location header.", {
      code: "MIGRATE_JENKINS_NO_QUEUE_LOCATION",
    });
  }

  return { queueUrl };
}

export async function resolveQueueItem(
  auth: JenkinsAuth,
  queueUrl: string,
  options: { signal?: AbortSignal; pollMs?: number; onWait?: (item: QueueItem) => void } = {}
): Promise<QueueItem> {
  const pollMs = options.pollMs ?? QUEUE_POLL_INTERVAL_MS;
  const apiUrl = queueUrl.endsWith("/") ? `${queueUrl}api/json` : `${queueUrl}/api/json`;

  while (true) {
    if (options.signal?.aborted) {
      throw new CliError("Queue resolution aborted.", { code: "MIGRATE_ABORTED" });
    }
    const res = await fetch(apiUrl, { headers: buildHeaders(auth) });
    if (!res.ok) {
      throw new CliError(`Failed to read queue item (${res.status}): ${await res.text()}`, {
        code: "MIGRATE_JENKINS_QUEUE_READ_FAILED",
      });
    }
    const item = (await res.json()) as QueueItem;
    if (item.cancelled) {
      throw new CliError(`Queue item ${item.id} was cancelled before it could run.`, {
        code: "MIGRATE_JENKINS_QUEUE_CANCELLED",
        details: { reason: item.why },
      });
    }
    if (item.executable?.number) return item;
    options.onWait?.(item);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function getBuild(auth: JenkinsAuth, buildNumber: number): Promise<BuildInfo> {
  const url = `${jobBase(auth)}/${buildNumber}/api/json`;
  const res = await fetch(url, { headers: buildHeaders(auth) });
  if (!res.ok) {
    throw new CliError(`Failed to fetch build #${buildNumber} (${res.status}): ${await res.text()}`, {
      code: "MIGRATE_JENKINS_BUILD_READ_FAILED",
    });
  }
  return (await res.json()) as BuildInfo;
}

export async function getConsoleChunk(
  auth: JenkinsAuth,
  buildNumber: number,
  start: number,
): Promise<ConsoleChunk> {
  const url = `${jobBase(auth)}/${buildNumber}/logText/progressiveText?start=${start}`;
  const res = await fetch(url, { headers: buildHeaders(auth) });
  if (!res.ok) {
    throw new CliError(`Failed to fetch console (${res.status}): ${await res.text()}`, {
      code: "MIGRATE_JENKINS_CONSOLE_READ_FAILED",
    });
  }
  const text = await res.text();
  const nextOffset = Number(res.headers.get("X-Text-Size") ?? start + text.length);
  const hasMore = res.headers.get("X-More-Data") === "true";
  return { text, nextOffset, hasMore };
}

export async function getFullConsole(auth: JenkinsAuth, buildNumber: number): Promise<string> {
  const url = `${jobBase(auth)}/${buildNumber}/consoleText`;
  const res = await fetch(url, { headers: buildHeaders(auth) });
  if (!res.ok) {
    throw new CliError(`Failed to fetch full console (${res.status}): ${await res.text()}`, {
      code: "MIGRATE_JENKINS_CONSOLE_READ_FAILED",
    });
  }
  return await res.text();
}

export function buildUrl(auth: JenkinsAuth, buildNumber: number): string {
  return `${jobBase(auth)}/${buildNumber}/`;
}

export function jobUrl(auth: JenkinsAuth): string {
  return `${jobBase(auth)}/`;
}
