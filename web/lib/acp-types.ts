export const AGENT_REGISTRY: Record<string, string> = {
  codex: "npx @zed-industries/codex-acp",
  claude: "npx -y @zed-industries/claude-agent-acp",
  // TODO(claude-acp): replace with "claude --acp" once that flag ships in the CLI
  "claude-code": "npx -y @zed-industries/claude-agent-acp",
  gemini: "gemini",
  opencode: "opencode acp",
  pi: "npx pi-acp",
};

// Simple emoji/symbol per agent for UI display (no external image dependency)
export const AGENT_EMOJI: Record<string, string> = {
  codex: "◆",
  claude: "✦",
  "claude-code": "◈",
  gemini: "✺",
  opencode: "▶",
  pi: "π",
};

// Known models per agent. Empty array = user provides free text.
export const AGENT_MODELS: Record<string, string[]> = {
  codex: ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
  claude: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  "claude-code": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  gemini: ["gemini-2.0-flash", "gemini-2.5-pro"],
  opencode: ["claude-sonnet-4-6", "gpt-4o", "o3", "gpt-4o-mini"],
  pi: [],
};

// Agents that accept --model <model> as a CLI flag
export const AGENT_MODEL_FLAG: Record<string, string> = {
  opencode: "--model",
  codex: "--model",
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
  name?: string;
  namespace?: string;
  model?: string;
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
  | { type: "session_name"; name: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };
