import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalCommandRequest,
  KillTerminalCommandResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  AGENT_REGISTRY,
  type BridgeEvent,
  type PermissionOption,
  type SessionInfo,
} from "./acp-types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ManagedTerminal = {
  process: ChildProcess;
  output: Buffer;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  exitPromise: Promise<WaitForTerminalExitResponse>;
  resolveExit: (r: WaitForTerminalExitResponse) => void;
};

type PendingPermission = {
  requestId: string;
  toolCall: { title: string; kind: string | null };
  options: PermissionOption[];
  resolve: (r: RequestPermissionResponse) => void;
};

type SessionEntry = {
  id: string;
  agentName: string;
  agentCommand: string;
  cwd: string;
  connection: ClientSideConnection;
  child: ChildProcess;
  acpSessionId: string;
  status: "idle" | "running" | "closed";
  createdAt: string;
  subscribers: Set<(event: BridgeEvent) => void>;
  pendingPermission: PendingPermission | undefined;
  terminals: Map<string, ManagedTerminal>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TERMINAL_OUTPUT_LIMIT = 64 * 1024;
const KILL_GRACE_MS = 1_500;

function isWithinRoot(rootDir: string, targetPath: string): boolean {
  const rel = path.relative(rootDir, targetPath);
  return rel.length === 0 || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;

  try {
    child.stdin?.end();
  } catch {
    // best effort
  }

  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
      child.once("close", () => resolve(true));
    }),
    waitMs(100).then(() => false),
  ]);

  if (!exited && child.exitCode == null && child.signalCode == null) {
    try {
      child.kill("SIGTERM");
    } catch {
      // best effort
    }
    await waitMs(KILL_GRACE_MS);
  }

  if (child.exitCode == null && child.signalCode == null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // best effort
    }
  }
}

function splitCommand(cmd: string): { command: string; args: string[] } {
  const parts = cmd.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

// ---------------------------------------------------------------------------
// AcpBridge
// ---------------------------------------------------------------------------

class AcpBridge {
  private readonly sessions = new Map<string, SessionEntry>();

  async createSession(agentName: string, cwd: string): Promise<SessionInfo> {
    const agentCommand = AGENT_REGISTRY[agentName] ?? agentName;
    const { command, args } = splitCommand(agentCommand);
    const sessionId = randomUUID();

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (err) =>
        reject(new Error(`Failed to start agent "${agentName}": ${err.message}`)),
      );
    });

    // Drain stderr to prevent pipe buffer from filling
    child.stderr?.resume();

    // Use a definite-assignment pattern: the entry is created after the
    // connection so that the connection callbacks can close over `entry`.
    // The callbacks are only invoked during prompt(), which happens after
    // the entry is assigned — so this is safe.
    let entry!: SessionEntry;

    const emitToSubs = (event: BridgeEvent) => {
      for (const sub of entry.subscribers) sub(event);
    };

    const input = Writable.toWeb(child.stdin!);
    const output = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          const u = params.update as Record<string, unknown>;
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const c = u.content as { type: string; text?: string };
              if (c.type === "text" && typeof c.text === "string") {
                emitToSubs({ type: "agent_message_chunk", text: c.text });
              }
              break;
            }
            case "agent_thought_chunk": {
              const c = u.content as { type: string; text?: string };
              if (c.type === "text" && typeof c.text === "string") {
                emitToSubs({ type: "agent_thought_chunk", text: c.text });
              }
              break;
            }
            case "tool_call": {
              emitToSubs({
                type: "tool_call",
                toolCallId: u.toolCallId as string,
                title: (u.title as string | undefined) ?? "",
                status: (u.status as string | undefined) ?? "in_progress",
                kind: (u.kind as string | null | undefined) ?? null,
                rawInput: u.rawInput,
              });
              break;
            }
            case "tool_call_update": {
              emitToSubs({
                type: "tool_call_update",
                toolCallId: u.toolCallId as string,
                title: u.title as string | undefined,
                status: (u.status as string | undefined) ?? "in_progress",
                rawOutput: u.rawOutput,
                content: u.content,
              });
              break;
            }
            case "plan": {
              const entries = u.entries as Array<{ status: string; content: string }>;
              emitToSubs({
                type: "plan",
                entries: entries.map((e) => ({ status: e.status, content: e.content })),
              });
              break;
            }
          }
        },

        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          return new Promise<RequestPermissionResponse>((resolve) => {
            const requestId = randomUUID();
            const options: PermissionOption[] = (params.options ?? []).map((o) => ({
              optionId: o.optionId,
              name: o.name ?? o.optionId,
              kind: (o.kind as string | undefined) ?? "other",
            }));

            entry.pendingPermission = {
              requestId,
              toolCall: {
                title: params.toolCall.title ?? "tool",
                kind: (params.toolCall.kind as string | null | undefined) ?? null,
              },
              options,
              resolve,
            };

            emitToSubs({
              type: "permission_request",
              requestId,
              toolCall: entry.pendingPermission.toolCall,
              options,
            });
          });
        },

        readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
          const rootDir = path.resolve(entry.cwd);
          if (!path.isAbsolute(params.path)) {
            throw new Error(`readTextFile: path must be absolute: ${params.path}`);
          }
          const resolved = path.resolve(params.path);
          if (!isWithinRoot(rootDir, resolved)) {
            throw new Error(`readTextFile: path outside cwd: ${resolved}`);
          }
          const content = await fs.readFile(resolved, "utf8");
          if (params.line == null && params.limit == null) {
            return { content };
          }
          const lines = content.split("\n");
          const start = Math.max(0, (params.line == null ? 1 : Math.trunc(params.line)) - 1);
          const count =
            params.limit == null ? undefined : Math.max(0, Math.trunc(params.limit));
          const end = count == null ? lines.length : Math.min(lines.length, start + count);
          return { content: lines.slice(start, end).join("\n") };
        },

        writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
          const rootDir = path.resolve(entry.cwd);
          if (!path.isAbsolute(params.path)) {
            throw new Error(`writeTextFile: path must be absolute: ${params.path}`);
          }
          const resolved = path.resolve(params.path);
          if (!isWithinRoot(rootDir, resolved)) {
            throw new Error(`writeTextFile: path outside cwd: ${resolved}`);
          }
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, params.content, "utf8");
          return {};
        },

        createTerminal: async (
          params: CreateTerminalRequest,
        ): Promise<CreateTerminalResponse> => {
          const outputByteLimit = Math.max(
            0,
            (params.outputByteLimit as number | undefined) ?? TERMINAL_OUTPUT_LIMIT,
          );

          const envRecord: Record<string, string> = {};
          if (Array.isArray(params.env)) {
            for (const e of params.env as Array<{ name: string; value: string }>) {
              envRecord[e.name] = e.value;
            }
          }

          const proc = spawn(params.command, (params.args as string[] | undefined) ?? [], {
            cwd: (params.cwd as string | undefined) ?? entry.cwd,
            env: { ...process.env, ...envRecord },
            stdio: ["ignore", "pipe", "pipe"],
          });

          await new Promise<void>((resolve, reject) => {
            proc.once("spawn", resolve);
            proc.once("error", reject);
          });

          let resolveExit!: (r: WaitForTerminalExitResponse) => void;
          const exitPromise = new Promise<WaitForTerminalExitResponse>((resolve) => {
            resolveExit = resolve;
          });

          const terminal: ManagedTerminal = {
            process: proc,
            output: Buffer.alloc(0),
            truncated: false,
            outputByteLimit,
            exitCode: undefined,
            signal: undefined,
            exitPromise,
            resolveExit,
          };

          const appendOutput = (chunk: Buffer | string): void => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (!bytes.length) return;
            terminal.output = Buffer.concat([terminal.output, bytes]);
            if (terminal.output.length > outputByteLimit) {
              terminal.output = terminal.output.subarray(
                terminal.output.length - outputByteLimit,
              );
              terminal.truncated = true;
            }
          };

          proc.stdout?.on("data", appendOutput);
          proc.stderr?.on("data", appendOutput);
          proc.once("exit", (exitCode, signal) => {
            terminal.exitCode = exitCode;
            terminal.signal = signal as NodeJS.Signals | null;
            terminal.resolveExit({
              exitCode: exitCode ?? null,
              signal: signal ?? null,
            });
          });

          const terminalId = randomUUID();
          entry.terminals.set(terminalId, terminal);
          return { terminalId };
        },

        terminalOutput: async (
          params: TerminalOutputRequest,
        ): Promise<TerminalOutputResponse> => {
          const terminal = entry.terminals.get(params.terminalId);
          if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);
          const hasExit = terminal.exitCode !== undefined || terminal.signal !== undefined;
          return {
            output: terminal.output.toString("utf8"),
            truncated: terminal.truncated,
            exitStatus: hasExit
              ? { exitCode: terminal.exitCode ?? null, signal: terminal.signal ?? null }
              : undefined,
          };
        },

        waitForTerminalExit: async (
          params: WaitForTerminalExitRequest,
        ): Promise<WaitForTerminalExitResponse> => {
          const terminal = entry.terminals.get(params.terminalId);
          if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);
          return await terminal.exitPromise;
        },

        killTerminal: async (
          params: KillTerminalCommandRequest,
        ): Promise<KillTerminalCommandResponse> => {
          const terminal = entry.terminals.get(params.terminalId);
          if (!terminal) return {};
          if (terminal.exitCode === undefined && terminal.signal === undefined) {
            try {
              terminal.process.kill("SIGTERM");
            } catch {
              // best effort
            }
            await Promise.race([terminal.exitPromise, waitMs(KILL_GRACE_MS)]);
            if (terminal.exitCode === undefined && terminal.signal === undefined) {
              try {
                terminal.process.kill("SIGKILL");
              } catch {
                // best effort
              }
            }
          }
          return {};
        },

        releaseTerminal: async (
          params: ReleaseTerminalRequest,
        ): Promise<ReleaseTerminalResponse> => {
          const terminal = entry.terminals.get(params.terminalId);
          if (!terminal) return {};
          try {
            terminal.process.kill("SIGTERM");
          } catch {
            // best effort
          }
          terminal.output = Buffer.alloc(0);
          entry.terminals.delete(params.terminalId);
          return {};
        },
      }),
      stream,
    );

    // Initialize the ACP protocol
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "belzabar-web", version: "0.1.0" },
    });

    const sessionResult = await connection.newSession({
      cwd,
      mcpServers: [],
    });

    entry = {
      id: sessionId,
      agentName,
      agentCommand,
      cwd,
      connection,
      child,
      acpSessionId: sessionResult.sessionId,
      status: "idle",
      createdAt: new Date().toISOString(),
      subscribers: new Set(),
      pendingPermission: undefined,
      terminals: new Map(),
    };

    this.sessions.set(sessionId, entry);
    return this.toInfo(entry);
  }

  async closeSession(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;

    entry.status = "closed";

    // Unblock any pending permission request
    if (entry.pendingPermission) {
      entry.pendingPermission.resolve({ outcome: { outcome: "cancelled" } });
      entry.pendingPermission = undefined;
    }

    this.sessions.delete(id);

    await terminateChild(entry.child).catch(() => {
      // best effort
    });
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((e) => this.toInfo(e));
  }

  getSessionInfo(id: string): SessionInfo | undefined {
    const entry = this.sessions.get(id);
    return entry ? this.toInfo(entry) : undefined;
  }

  async sendPrompt(
    id: string,
    message: string,
    emit: (event: BridgeEvent) => void,
  ): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`Session not found: ${id}`);
    if (entry.status === "closed") throw new Error("Session is closed");
    if (entry.status === "running") throw new Error("Session is already running a prompt");

    entry.status = "running";
    entry.subscribers.add(emit);

    try {
      const result = await entry.connection.prompt({
        sessionId: entry.acpSessionId,
        prompt: [{ type: "text", text: message }],
      });
      emit({ type: "done", stopReason: result.stopReason });
    } catch (error) {
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      entry.status = "idle";
      entry.subscribers.delete(emit);
    }
  }

  async cancelPrompt(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry || entry.status !== "running") return;
    try {
      await entry.connection.cancel({ sessionId: entry.acpSessionId });
    } catch {
      // best effort
    }
  }

  resolvePermission(id: string, requestId: string, optionId: string | null): void {
    const entry = this.sessions.get(id);
    if (!entry?.pendingPermission) return;
    if (entry.pendingPermission.requestId !== requestId) return;

    const { options, resolve } = entry.pendingPermission;
    entry.pendingPermission = undefined;

    if (optionId) {
      const opt = options.find((o) => o.optionId === optionId);
      if (opt) {
        resolve({ outcome: { outcome: "selected", optionId } });
        return;
      }
    }
    resolve({ outcome: { outcome: "cancelled" } });
  }

  private toInfo(entry: SessionEntry): SessionInfo {
    return {
      id: entry.id,
      agentName: entry.agentName,
      agentCommand: entry.agentCommand,
      cwd: entry.cwd,
      status: entry.status,
      createdAt: entry.createdAt,
      pendingPermission: entry.pendingPermission
        ? {
            requestId: entry.pendingPermission.requestId,
            toolCall: entry.pendingPermission.toolCall,
            options: entry.pendingPermission.options,
          }
        : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton (hot-reload safe in dev)
// ---------------------------------------------------------------------------

const g = global as typeof global & { _acpBridge?: AcpBridge };
export const bridge = g._acpBridge ?? new AcpBridge();
if (process.env.NODE_ENV !== "production") {
  g._acpBridge = bridge;
}
