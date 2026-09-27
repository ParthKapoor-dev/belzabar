import { CliError, createLimiter, httpError, httpRequest, isReplayableBody, sleep } from "@belzabar/core";
import { ensureTeamworkAuth, refreshTeamworkAuth, TEAMWORK_BASE } from "./auth";
import type {
  TeamworkTask, TeamworkTaskAssignee, TeamworkTag, TeamworkSubtask, TeamworkComment,
  TeamworkTaskSearchResult, AddCommentResult,
} from "./types";

// Teamwork adapter over @belzabar/core/http (TW-7/9/10):
//   - shared transport (timeout, IPv4 pin + eviction, coded network errors);
//   - tw-auth cookie session, 401 → one shared re-login + retry;
//   - 429 → backoff honouring Retry-After (bounded);
//   - at most TEAMWORK_CONCURRENCY requests in flight (release matrix fans out).

export const TEAMWORK_CONCURRENCY = 6;
const MAX_429_RETRIES = 4;
const MAX_BACKOFF_MS = 15_000;
const limit = createLimiter(TEAMWORK_CONCURRENCY);

/** Test seam: override the 429 backoff sleep. */
let backoffSleep: (ms: number) => Promise<void> = sleep;
export function setTeamworkBackoffForTesting(fn: ((ms: number) => Promise<void>) | null): void {
  backoffSleep = fn ?? sleep;
}

function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  const secs = header ? Number(header) : NaN;
  const ms = Number.isFinite(secs) ? secs * 1000 : 1000 * 2 ** attempt;
  return Math.min(Math.max(ms, 250), MAX_BACKOFF_MS);
}

export async function teamworkFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return limit(async () => {
    const url = path.startsWith("http") ? path : `${TEAMWORK_BASE}${path}`;
    let twAuth = await ensureTeamworkAuth();
    const send = () =>
      httpRequest(url, {
        ...options,
        headers: {
          Accept: "application/json",
          "User-Agent": "Bun/1.0 (Belzabar CLI)",
          ...((options.headers as Record<string, string>) ?? {}),
          Cookie: `tw-auth=${twAuth}`,
        },
      });

    let response = await send();
    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      if (response.status === 401 && !reauthed && isReplayableBody(options.body)) {
        reauthed = true;
        process.stderr.write("[Teamwork] 401 Unauthorized. Re-authenticating...\n");
        await response.arrayBuffer().catch(() => undefined);
        twAuth = await refreshTeamworkAuth(twAuth);
        response = await send();
        continue;
      }
      if (response.status === 429 && attempt < MAX_429_RETRIES && isReplayableBody(options.body)) {
        const wait = retryAfterMs(response, attempt);
        await response.arrayBuffer().catch(() => undefined);
        await backoffSleep(wait);
        response = await send();
        continue;
      }
      return response;
    }
  });
}

/** Map a non-OK Teamwork response to TW_NOT_FOUND / TW_HTTP_<status>. */
export async function teamworkError(response: Response, what: string): Promise<CliError> {
  return httpError(response, {
    message: what,
    codePrefix: "TW_HTTP",
    notFoundCode: "TW_NOT_FOUND",
    notFoundMessage: `${what}: not found (HTTP 404)`,
  });
}

// ── Task include params (from Teamwork UI) ──────────────────────────────────

const TASK_INCLUDES = [
  "taskListNames", "tags", "timeTotals", "taskSequences",
  "users.companies", "companies", "users",
  "changeFollowers", "commentFollowers", "completeFollowers",
  "teams", "projects", "tasklists",
  "parentTasks", "subtaskStats", "projects.permissions",
  "predecessors", "cards.columns",
  "workflows", "workflows.stages", "reminders", "taskLists", "projectNames",
].join(",");

const TASK_INCLUDE_PARAMS = [
  `include=${TASK_INCLUDES}`,
  "getSubTasks=true",
  "checkForReminders=true",
  "includeRelatedTasks=true",
  "includeCommentStats=true",
  "includeCompletedPredecessors=true",
].join("&");

export async function fetchTask(taskId: number): Promise<TeamworkTask> {
  const path = `/projects/api/v3/tasks/${taskId}.json?${TASK_INCLUDE_PARAMS}`;
  const response = await teamworkFetch(path);

  if (!response.ok) throw await teamworkError(response, `Failed to fetch task ${taskId}`);

  const json = await response.json() as any;
  const task = json.task;
  const included = json.included ?? {};

  // Resolve assignees
  const assignees: TeamworkTaskAssignee[] = (task.assigneeUserIds ?? []).map((uid: number) => {
    const u = included.users?.[uid];
    return u
      ? { id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email }
      : { id: uid, firstName: "Unknown", lastName: "", email: "" };
  });

  // Resolve tags
  const tags: TeamworkTag[] = (task.tagIds ?? []).map((tid: number) => {
    const t = included.tags?.[tid];
    return t ? { id: t.id, name: t.name, color: t.color } : { id: tid, name: "Unknown", color: "" };
  });

  // Resolve parent task name
  let parentTaskName: string | null = null;
  if (task.parentTaskId && task.parentTaskId !== 0) {
    parentTaskName = included.tasks?.[task.parentTaskId]?.name ?? null;
  }

  // Resolve subtasks. The /tasks/{id}.json endpoint does NOT include subtask details inline
  // (only `subTaskIds`), so we make a follow-up call to /tasks.json?parentTaskId=… and preserve
  // the parent's `subTaskIds` ordering.
  const subTaskIds: number[] = task.subTaskIds ?? task.subtaskIds ?? [];
  const subtasks: TeamworkSubtask[] = subTaskIds.length > 0
    ? await fetchSubtasks(task.id, subTaskIds)
    : [];

  // Resolve tasklist and project names
  const tasklistName = included.tasklists?.[task.tasklistId]?.name ?? null;
  const projectName = included.tasklists?.[task.tasklistId]?.projectId
    ? included.projects?.[included.tasklists[task.tasklistId].projectId]?.name ?? null
    : null;

  // Resolve workflow stage
  let workflowStage: string | null = null;
  if (task.workflowStages?.length > 0) {
    const stageId = task.workflowStages[0].stageId;
    workflowStage = included.stages?.[stageId]?.name ?? null;
  }

  // Time totals
  const loggedMinutes = included.timeTotals?.[taskId]?.loggedMinutes ?? 0;

  // Comment stats
  const commentStats = task.meta?.commentStats ?? null;

  return {
    id: task.id,
    name: task.name,
    description: task.description ?? "",
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    startDate: task.startDate,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    progress: task.progress,
    estimateMinutes: task.estimateMinutes ?? 0,
    parentTaskId: task.parentTaskId && task.parentTaskId !== 0 ? task.parentTaskId : null,
    parentTaskName,
    tasklistName,
    projectName,
    assignees,
    tags,
    workflowStage,
    commentStats,
    loggedMinutes,
    subtasks,
  };
}

// ── Subtasks ────────────────────────────────────────────────────────────────

async function fetchSubtasks(parentTaskId: number, orderHint: number[]): Promise<TeamworkSubtask[]> {
  const params = new URLSearchParams({
    parentTaskId: String(parentTaskId),
    includeCompletedTasks: "true",
    pageSize: "250",
  });
  const response = await teamworkFetch(`/projects/api/v3/tasks.json?${params}`);
  if (!response.ok) return orderHint.map((id) => ({
    id, name: "Unknown", status: "", priority: null, progress: 0, dueDate: null, assigneeCount: 0,
  }));

  const json = await response.json() as any;
  const byId = new Map<number, any>();
  for (const t of (json.tasks ?? [])) byId.set(t.id, t);

  const ordered = orderHint.length > 0
    ? orderHint.map((id) => byId.get(id) ?? { id })
    : Array.from(byId.values());

  return ordered.map((t: any) => ({
    id: t.id,
    name: t.name ?? "Unknown",
    status: t.status ?? "",
    priority: t.priority ?? null,
    progress: t.progress ?? 0,
    dueDate: t.dueDate ?? null,
    assigneeCount: (t.assigneeUserIds ?? []).length,
  }));
}

// ── Comments ────────────────────────────────────────────────────────────────

// Teamwork v3 ignores `limit` (it silently caps at pageSize=50), so paginate
// with `pageSize` + `page` until meta.page.hasMore is false. Comments are
// ordered oldest-first, so a single page would drop the NEWEST ones.
const COMMENTS_PAGE_SIZE = 500; // Teamwork's max pageSize
const COMMENTS_MAX_PAGES = 100; // runaway guard

export async function fetchComments(
  taskId: number,
  fetcher: (path: string) => Promise<Response> = teamworkFetch,
): Promise<TeamworkComment[]> {
  const comments: any[] = [];
  const users: Record<string, any> = {};

  for (let page = 1; ; page++) {
    const params = new URLSearchParams({
      "include": "users,teams,files",
      "orderBy": "date",
      "orderMode": "asc",
      "pageSize": String(COMMENTS_PAGE_SIZE),
      "page": String(page),
    });

    const path = `/projects/api/v3/tasks/${taskId}/comments.json?${params}`;
    const response = await fetcher(path);

    if (!response.ok) throw await teamworkError(response, `Failed to fetch comments for task ${taskId}`);

    const json = await response.json() as any;
    const batch = Array.isArray(json.comments) ? json.comments : [];
    comments.push(...batch);
    Object.assign(users, json.included?.users ?? {});

    const hasMore = json.meta?.page?.hasMore === true;
    if (!hasMore || batch.length === 0) break;
    if (page >= COMMENTS_MAX_PAGES) {
      throw new CliError(
        `Comments for task ${taskId} exceed ${COMMENTS_MAX_PAGES} pages of ${COMMENTS_PAGE_SIZE}; refusing to return a truncated list.`,
        { code: "TW_TOO_MANY_COMMENTS" },
      );
    }
  }

  return comments.map((c: any) => {
    const user = users[c.postedByUserId];
    const postedByName = user ? `${user.firstName} ${user.lastName}` : `User#${c.postedByUserId}`;

    return {
      id: c.id,
      body: c.body ?? "",
      htmlBody: c.htmlBody ?? "",
      postedByUserId: c.postedByUserId,
      postedByName,
      postedDateTime: c.postedDateTime,
      fileCount: c.fileCount ?? 0,
    };
  });
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface TaskSearchOptions {
  projectId?: number;
  limit?: number;
  includeCompleted?: boolean;
}

export async function searchTasks(query: string, opts: TaskSearchOptions = {}): Promise<TeamworkTaskSearchResult[]> {
  const params = new URLSearchParams({
    searchTerm: query,
    include: "tasklists,projects",
    pageSize: String(opts.limit ?? 25),
  });
  if (opts.projectId) params.set("projectIds", String(opts.projectId));
  if (opts.includeCompleted) params.set("includeCompletedTasks", "true");

  const path = `/projects/api/v3/tasks.json?${params}`;
  const response = await teamworkFetch(path);

  if (!response.ok) throw await teamworkError(response, "Teamwork search failed");

  const json = await response.json() as any;
  const tasks = json.tasks ?? [];
  const included = json.included ?? {};

  return tasks.map((t: any): TeamworkTaskSearchResult => {
    const tasklist = included.tasklists?.[t.tasklistId];
    const projectName = tasklist?.projectId
      ? included.projects?.[tasklist.projectId]?.name ?? null
      : null;
    return {
      id: t.id,
      name: t.name ?? "Unknown",
      status: t.status ?? "",
      progress: t.progress ?? 0,
      projectName,
      tasklistName: tasklist?.name ?? null,
      url: `${TEAMWORK_BASE}/app/tasks/${t.id}`,
    };
  });
}

// ── Posting a comment (WRITE) ─────────────────────────────────────────────────
// Callers MUST confirm the exact body with the user before invoking this — see
// commands/add-comment and the belz-ai skill's hard rule on Teamwork comments.

export interface AddCommentOptions {
  contentType?: "TEXT" | "HTML";
}

export async function addComment(taskId: number, body: string, opts: AddCommentOptions = {}): Promise<AddCommentResult> {
  const path = `/projects/api/v3/tasks/${taskId}/comments.json`;
  const payload = {
    comment: {
      body,
      contentType: opts.contentType ?? "TEXT",
    },
  };

  const response = await teamworkFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) throw await teamworkError(response, `Failed to post comment to task ${taskId}`);

  const json = await response.json() as any;
  const comment = json.comment ?? {};
  return { id: comment.id ?? 0, taskId };
}
