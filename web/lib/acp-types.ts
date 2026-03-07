export const AGENT_REGISTRY: Record<string, string> = {
  codex: "npx @zed-industries/codex-acp",
  claude: "npx -y @zed-industries/claude-agent-acp",
  gemini: "gemini",
  opencode: "opencode acp",
  pi: "npx pi-acp",
};

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: string;
};

export type PendingPermissionInfo = {
  requestId: string;
  toolCall: { title: string; kind: string | null };
  options: PermissionOption[];
};

export type SessionInfo = {
  id: string;
  agentName: string;
  agentCommand: string;
  cwd: string;
  status: "idle" | "running" | "closed";
  createdAt: string;
  pendingPermission?: PendingPermissionInfo;
};

export type BridgeEvent =
  | { type: "agent_message_chunk"; text: string }
  | { type: "agent_thought_chunk"; text: string }
  | {
      type: "tool_call";
      toolCallId: string;
      title: string;
      status: string;
      kind: string | null;
      rawInput: unknown;
    }
  | {
      type: "tool_call_update";
      toolCallId: string;
      title?: string;
      status: string;
      rawOutput?: unknown;
      content?: unknown;
    }
  | { type: "plan"; entries: Array<{ status: string; content: string }> }
  | {
      type: "permission_request";
      requestId: string;
      toolCall: { title: string; kind: string | null };
      options: PermissionOption[];
    }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };
