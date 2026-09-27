import { CliError, httpRequest, readBodySummary, sleep, type HttpInit } from "@belzabar/core";
import { buildHeaders, type JenkinsAuth } from "./auth";
import { fetchCrumb } from "./crumb";
import type {
  BuildInfo,
  ConsoleChunk,
  JenkinsParameterDefinition,
  QueueItem,
  TriggerBuildInput,
} from "./types";
import { QUEUE_POLL_INTERVAL_MS, QUEUE_TIMEOUT_MS } from "./constants";

// Jenkins adapter over @belzabar/core/http (MG-5/7/8, TW-10, F28): shared
// transport (timeout, IPv4 pin + eviction), basic auth, and error messages that
// never carry the HTML error page or the CSRF crumb — only the status and the
// page title, truncated and redacted.

/** One Jenkins request through the shared transport. */
export function jenkinsFetch(auth: JenkinsAuth, url: string, init: HttpInit = {}): Promise<Response> {
  return httpRequest(url, {
    ...init,
    headers: { ...buildHeaders(auth), ...((init.headers as Record<string, string>) ?? {}) },
  });
}

/** CliError for a non-OK Jenkins response: `${what} (HTTP n): <summary>`. */
export async function jenkinsError(res: Response, what: string, code: string, details: Record<string, unknown> = {}): Promise<CliError> {
  const body = await readBodySummary(res, 200);
  return new CliError(`${what} (HTTP ${res.status})${body ? `: ${body}` : ""}`, {
    code,
    details: { ...details, status: res.status, body },
  });
}

async function buildNotFoundOr(res: Response, buildNumber: number, what: string, code: string): Promise<CliError> {
  if (res.status === 404) {
    await res.arrayBuffer().catch(() => undefined);
    return new CliError(`Build #${buildNumber} not found`, {
      code: "MIGRATE_JENKINS_BUILD_NOT_FOUND",
      details: { buildNumber, status: 404 },
    });
  }
  return jenkinsError(res, what, code, { buildNumber });
}

function jobBase(auth: JenkinsAuth): string {
  const segments = auth.job.split("/").filter(Boolean).map(encodeURIComponent);
  return `${auth.baseUrl}/${segments.map((s) => `job/${s}`).join("/")}`;
}

export async function getJobParameters(auth: JenkinsAuth): Promise<JenkinsParameterDefinition[]> {
  const url = `${jobBase(auth)}/api/json?tree=property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]`;
  const res = await jenkinsFetch(auth, url);
  if (!res.ok) throw await jenkinsError(res, "Failed to fetch Jenkins job parameters", "MIGRATE_JENKINS_PARAMS_FAILED");
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
  const res = await jenkinsFetch(auth, url, {
    method: "POST",
    headers,
    body: body.toString(),
    redirect: "manual",
  });

  if (res.status !== 201 && res.status !== 200 && res.status !== 303) {
    throw await jenkinsError(res, "Failed to trigger Jenkins build", "MIGRATE_JENKINS_TRIGGER_FAILED", { url });
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
  options: { signal?: AbortSignal; pollMs?: number; timeoutMs?: number; onWait?: (item: QueueItem) => void } = {}
): Promise<QueueItem> {
  const pollMs = options.pollMs ?? QUEUE_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? QUEUE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const apiUrl = queueUrl.endsWith("/") ? `${queueUrl}api/json` : `${queueUrl}/api/json`;
  let last: QueueItem | null = null;

  while (true) {
    if (options.signal?.aborted) {
      throw new CliError("Queue resolution aborted.", { code: "MIGRATE_ABORTED" });
    }
    if (Date.now() > deadline) {
      throw new CliError(
        `Build is still queued after ${Math.round(timeoutMs / 1000)}s${last?.why ? ` (${last.why})` : ""}. It may still start; check ${queueUrl}`,
        { code: "JENKINS_QUEUE_TIMEOUT", details: { queueUrl, why: last?.why, timeoutMs } },
      );
    }
    const res = await jenkinsFetch(auth, apiUrl);
    if (!res.ok) throw await jenkinsError(res, "Failed to read queue item", "MIGRATE_JENKINS_QUEUE_READ_FAILED");
    const item = (await res.json()) as QueueItem;
    if (item.cancelled) {
      throw new CliError(`Queue item ${item.id} was cancelled before it could run.`, {
        code: "MIGRATE_JENKINS_QUEUE_CANCELLED",
        details: { reason: item.why },
      });
    }
    if (item.executable?.number) return item;
    last = item;
    options.onWait?.(item);
    await sleep(pollMs);
  }
}

export async function getBuild(auth: JenkinsAuth, buildNumber: number): Promise<BuildInfo> {
  const url = `${jobBase(auth)}/${buildNumber}/api/json`;
  const res = await jenkinsFetch(auth, url);
  if (!res.ok) throw await buildNotFoundOr(res, buildNumber, `Failed to fetch build #${buildNumber}`, "MIGRATE_JENKINS_BUILD_READ_FAILED");
  return (await res.json()) as BuildInfo;
}

export async function getConsoleChunk(
  auth: JenkinsAuth,
  buildNumber: number,
  start: number,
): Promise<ConsoleChunk> {
  const url = `${jobBase(auth)}/${buildNumber}/logText/progressiveText?start=${start}`;
  const res = await jenkinsFetch(auth, url);
  if (!res.ok) throw await buildNotFoundOr(res, buildNumber, `Failed to fetch console of build #${buildNumber}`, "MIGRATE_JENKINS_CONSOLE_READ_FAILED");
  const text = await res.text();
  const nextOffset = Number(res.headers.get("X-Text-Size") ?? start + text.length);
  const hasMore = res.headers.get("X-More-Data") === "true";
  return { text, nextOffset, hasMore };
}

export async function getFullConsole(auth: JenkinsAuth, buildNumber: number): Promise<string> {
  const url = `${jobBase(auth)}/${buildNumber}/consoleText`;
  const res = await jenkinsFetch(auth, url);
  if (!res.ok) throw await buildNotFoundOr(res, buildNumber, `Failed to fetch full console of build #${buildNumber}`, "MIGRATE_JENKINS_CONSOLE_READ_FAILED");
  return await res.text();
}

export function buildUrl(auth: JenkinsAuth, buildNumber: number): string {
  return `${jobBase(auth)}/${buildNumber}/`;
}

export function jobUrl(auth: JenkinsAuth): string {
  return `${jobBase(auth)}/`;
}
