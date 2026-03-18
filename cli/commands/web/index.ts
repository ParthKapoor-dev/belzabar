import { spawn } from "child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CliError, ok, type CommandModule } from "@belzabar/core";

// ── Paths ─────────────────────────────────────────────────────────────────────

const BELZ_DIR = join(homedir(), ".belz");
const WEB_DIR = join(BELZ_DIR, "web", "web");
const SERVER_JS = join(WEB_DIR, "server.js");
const PID_DIR = join(BELZ_DIR, "pids");
const LOG_DIR = join(BELZ_DIR, "logs");
const PID_FILE = join(PID_DIR, "web.pid");
const LOG_FILE = join(LOG_DIR, "web.log");
const WEB_URL = "http://localhost:65535";

// ── Types ─────────────────────────────────────────────────────────────────────

type WebAction = "start" | "stop" | "restart" | "status";

interface WebArgs {
  action: WebAction;
  verbose: boolean;
}

interface WebData {
  action: WebAction;
  status: "started" | "stopped" | "restarted" | "running" | "not-running" | "already-running";
  pid?: number;
  logFile?: string;
  url?: string;
}

// ── Process helpers ───────────────────────────────────────────────────────────

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf8").trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) {
    unlinkSync(PID_FILE);
    return null;
  }
  if (!isProcessRunning(pid)) {
    unlinkSync(PID_FILE);
    return null;
  }
  return pid;
}

function assertWebInstalled(): void {
  if (!existsSync(SERVER_JS)) {
    throw new CliError(
      `Web app is not installed at ${WEB_DIR}.\nRun the install script to build and install it: ./cli/scripts/install.sh`,
      { code: "WEB_NOT_INSTALLED" }
    );
  }
}

function startBackground(): number {
  assertWebInstalled();
  mkdirSync(PID_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });

  const logFd = openSync(LOG_FILE, "a");
  const proc = spawn("node", [SERVER_JS], {
    cwd: WEB_DIR,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, PORT: "65535", HOSTNAME: "0.0.0.0" },
  });
  proc.unref();

  const pid = proc.pid!;
  writeFileSync(PID_FILE, String(pid));
  return pid;
}

function stopProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

// ── Command ───────────────────────────────────────────────────────────────────

const command: CommandModule<WebArgs, WebData> = {
  schema: "belz.web",

  parseArgs(args) {
    const isFlag = (a: string) => a.startsWith("-");
    const sub = args[0];
    const verbose = args.includes("-v") || args.includes("--verbose");

    if (!sub || isFlag(sub)) {
      return { action: "start", verbose };
    }

    const validActions: WebAction[] = ["start", "stop", "restart", "status"];
    if (validActions.includes(sub as WebAction)) {
      return { action: sub as WebAction, verbose };
    }

    throw new CliError(
      `Unknown web subcommand: '${sub}'. Available: start, stop, restart, status`,
      { code: "UNKNOWN_SUBCOMMAND" }
    );
  },

  async execute(args) {
    // ── status ────────────────────────────────────────────────────────────────
    if (args.action === "status") {
      const pid = readPid();
      if (pid) {
        return ok<WebData>({ action: "status", status: "running", pid, url: WEB_URL });
      }
      return ok<WebData>({ action: "status", status: "not-running" });
    }

    // ── stop ──────────────────────────────────────────────────────────────────
    if (args.action === "stop") {
      const pid = readPid();
      if (!pid) {
        throw new CliError("Web app is not running.", { code: "WEB_NOT_RUNNING" });
      }
      stopProcess(pid);
      return ok<WebData>({ action: "stop", status: "stopped", pid });
    }

    // ── start ─────────────────────────────────────────────────────────────────
    if (args.action === "start") {
      const existing = readPid();
      if (existing) {
        throw new CliError(`Web app is already running (PID ${existing}).`, {
          code: "WEB_ALREADY_RUNNING",
          details: { pid: existing, url: WEB_URL },
        });
      }

      if (args.verbose) {
        // Foreground — stream logs to terminal (blocking)
        assertWebInstalled();
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("node", [SERVER_JS], {
            cwd: WEB_DIR,
            stdio: "inherit",
            env: { ...process.env, PORT: "65535", HOSTNAME: "0.0.0.0" },
          });
          proc.on("close", resolve);
          proc.on("error", reject);
        });
        return ok<WebData>({ action: "start", status: "stopped" });
      }

      const pid = startBackground();
      return ok<WebData>({ action: "start", status: "started", pid, logFile: LOG_FILE, url: WEB_URL });
    }

    // ── restart ───────────────────────────────────────────────────────────────
    if (args.action === "restart") {
      const existing = readPid();
      if (existing) {
        stopProcess(existing);
        // Brief wait for port to be released
        await new Promise(r => setTimeout(r, 500));
      }
      const pid = startBackground();
      return ok<WebData>({ action: "restart", status: "restarted", pid, logFile: LOG_FILE, url: WEB_URL });
    }

    throw new CliError("Unhandled web subcommand.", { code: "UNHANDLED_SUBCOMMAND" });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as WebData;

    if (data.action === "status") {
      if (data.status === "running") {
        ui.success(`Web app is running (PID ${data.pid}).`);
        ui.kv("URL", data.url!);
      } else {
        ui.warn("Web app is not running.");
        ui.text(`Start it with: belz web`);
      }
      return;
    }

    if (data.action === "stop") {
      ui.success(`Web app stopped (was PID ${data.pid}).`);
      return;
    }

    if (data.action === "start") {
      if (data.status === "stopped") {
        // Returned after foreground run ended
        ui.text("Web app process exited.");
        return;
      }
      ui.success(`Web app started in background (PID ${data.pid}).`);
      ui.kv("URL", data.url!);
      ui.kv("Logs", data.logFile!);
      ui.text(`Run 'belz web stop' to stop it.`);
      return;
    }

    if (data.action === "restart") {
      ui.success(`Web app restarted (PID ${data.pid}).`);
      ui.kv("URL", data.url!);
      ui.kv("Logs", data.logFile!);
    }
  },
};

export default command;
