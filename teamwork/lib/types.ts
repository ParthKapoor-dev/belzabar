export interface TeamworkSession {
  twAuth: string;
}

export interface TeamworkTaskAssignee {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}

export interface TeamworkTag {
  id: number;
  name: string;
  color: string;
}

export interface TeamworkTask {
  id: number;
  name: string;
  description: string;
  status: string;
  priority: string | null;
  dueDate: string | null;
  startDate: string | null;
  createdAt: string;
  updatedAt: string;
  progress: number;
  estimateMinutes: number;
  parentTaskId: number | null;
  parentTaskName: string | null;
  tasklistName: string | null;
  projectName: string | null;
  assignees: TeamworkTaskAssignee[];
  tags: TeamworkTag[];
  workflowStage: string | null;
  commentStats: { total: number; read: number } | null;
  loggedMinutes: number;
}

export interface TeamworkComment {
  id: number;
  body: string;
  htmlBody: string;
  postedByUserId: number;
  postedByName: string;
  postedDateTime: string;
  fileCount: number;
}
