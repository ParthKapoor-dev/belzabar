import { ensureTeamworkAuth, teamworkLogin } from "./auth";
import type { TeamworkTask, TeamworkTaskAssignee, TeamworkTag, TeamworkComment } from "./types";

const TEAMWORK_BASE = "https://projects.webintensive.com";

export async function teamworkFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const twAuth = await ensureTeamworkAuth();
  const url = path.startsWith("http") ? path : `${TEAMWORK_BASE}${path}`;

  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": "Bun/1.0 (Belzabar CLI)",
    "Cookie": `tw-auth=${twAuth}`,
    ...(options.headers as Record<string, string> ?? {}),
  };

  const response = await fetch(url, { ...options, headers });

  // Retry on 401
  if (response.status === 401) {
    process.stderr.write("[Teamwork] 401 Unauthorized. Re-authenticating...\n");
    const session = await teamworkLogin();
    headers["Cookie"] = `tw-auth=${session.twAuth}`;
    return fetch(url, { ...options, headers });
  }

  return response;
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

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch task ${taskId} (${response.status}): ${body}`);
  }

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
  };
}

// ── Comments ────────────────────────────────────────────────────────────────

export async function fetchComments(taskId: number): Promise<TeamworkComment[]> {
  const params = new URLSearchParams({
    "include": "users,teams,files",
    "orderBy": "date",
    "orderMode": "asc",
    "limit": "500",
  });

  const path = `/projects/api/v3/tasks/${taskId}/comments.json?${params}`;
  const response = await teamworkFetch(path);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch comments for task ${taskId} (${response.status}): ${body}`);
  }

  const json = await response.json() as any;
  const comments = json.comments ?? [];
  const users = json.included?.users ?? {};

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
