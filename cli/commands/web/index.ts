import { spawn } from "child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  CliError,
  ok,
  loadConfigFileRaw,
  writeConfigFile,
  enableService,
  disableService,
  serviceStatus,
  type CommandModule,
  type ServiceSpec,
  type ServiceStatus,
} from "@belzabar/core";

// ── Paths ─────────────────────────────────────────────────────────────────────

const BELZ_DIR = join(homedir(), ".belz");
const WEB_DIR = join(BELZ_DIR, "web", "web");
const SERVER_JS = join(WEB_DIR, "server.js");
const PID_DIR = join(BELZ_DIR, "pids");
const LOG_DIR = join(BELZ_DIR, "logs");
const PID_FILE = join(PID_DIR, "web.pid");
const LOG_FILE = join(LOG_DIR, "web.log");
const WEB_URL = "http://localhost:65535";

// The login-start service runs the belz binary itself — `belz web start -v`
// (foreground) under a supervisor, `belz web start` (detached) otherwise — so
// there is a single source of truth for how the server is launched.
const WEB_SERVICE_SPEC: ServiceSpec = {
  id: "belz-web",
  displayName: "Belzabar Web",
  superviseExec: { command: process.execPath, args: ["web", "start", "-v"] },
  detachExec: { command: process.execPath, args: ["web", "start"] },
};

// ── Types ─────────────────────────────────────────────────────────────────────

type WebAction = "info" | "start" | "stop" | "restart" | "status" | "enable" | "disable";

interface WebArgs {
  action: WebAction;
  verbose: boolean;
}

interface WebData {
  action: WebAction;
  status:
    | "started"
    | "stopped"
    | "restarted"
    | "running"
    | "not-running"
    | "already-running"
    | "enabled"
    | "disabled";
  pid?: number;
  logFile?: string;
  url?: string;
  autostart?: ServiceStatus;
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

/** Persist the advisory autostart flag in config.json. */
function recordAutostart(enabled: boolean): void {
  const config = loadConfigFileRaw();
  config.web = { ...config.web, autostartEnabled: enabled };
  writeConfigFile(config);
}

// ── Command ───────────────────────────────────────────────────────────────────

const command: CommandModule<WebArgs, WebData> = {
  schema: "belz.web",

  parseArgs(args) {
    const isFlag = (a: string) => a.startsWith("-");
    const sub = args[0];
    const verbose = args.includes("-v") || args.includes("--verbose");

    // Bare `belz web` no longer starts the server — it shows status + usage.
    if (!sub || isFlag(sub)) {
      return { action: "info", verbose };
    }

    const validActions: WebAction[] = [
      "start",
      "stop",
      "restart",
      "status",
      "enable",
      "disable",
    ];
    if (validActions.includes(sub as WebAction)) {
      return { action: sub as WebAction, verbose };
    }

    throw new CliError(
      `Unknown web subcommand: '${sub}'. Available: start, stop, restart, status, enable, disable`,
      { code: "UNKNOWN_SUBCOMMAND" }
    );
  },

  async execute(args) {
    // ── info (bare `belz web`) ─────────────────────────────────────────────────
    if (args.action === "info") {
      const pid = readPid();
      return ok<WebData>({
        action: "info",
        status: pid ? "running" : "not-running",
        pid: pid ?? undefined,
        url: pid ? WEB_URL : undefined,
        autostart: serviceStatus(WEB_SERVICE_SPEC),
      });
    }

    // ── status ────────────────────────────────────────────────────────────────
    if (args.action === "status") {
      const pid = readPid();
      return ok<WebData>({
        action: "status",
        status: pid ? "running" : "not-running",
        pid: pid ?? undefined,
        url: pid ? WEB_URL : undefined,
        autostart: serviceStatus(WEB_SERVICE_SPEC),
      });
    }

    // ── enable (login autostart) ───────────────────────────────────────────────
    if (args.action === "enable") {
      assertWebInstalled();
      const autostart = enableService(WEB_SERVICE_SPEC);
      recordAutostart(true);
      // Unsupervised backends only fire at the next login — start it now so
      // `enable` behaves consistently across platforms.
      await new Promise((r) => setTimeout(r, 400));
      if (!readPid()) startBackground();
      return ok<WebData>({ action: "enable", status: "enabled", url: WEB_URL, autostart });
    }

    // ── disable (remove login autostart) ───────────────────────────────────────
    if (args.action === "disable") {
      disableService(WEB_SERVICE_SPEC);
      recordAutostart(false);
      return ok<WebData>({
        action: "disable",
        status: "disabled",
        autostart: serviceStatus(WEB_SERVICE_SPEC),
      });
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
        // Foreground — stream logs to terminal (blocking). Used by the
        // supervised login-start service, so it writes the PID file too,
        // keeping `belz web status` / `stop` accurate under supervision.
        assertWebInstalled();
        mkdirSync(PID_DIR, { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("node", [SERVER_JS], {
            cwd: WEB_DIR,
            stdio: "inherit",
            env: { ...process.env, PORT: "65535", HOSTNAME: "0.0.0.0" },
          });
          if (proc.pid) writeFileSync(PID_FILE, String(proc.pid));
          const clearPid = () => {
            if (existsSync(PID_FILE)) {
              try {
                unlinkSync(PID_FILE);
              } catch {
                /* ignore */
              }
            }
          };
          proc.on("close", () => {
            clearPid();
            resolve();
          });
          proc.on("error", (err) => {
            clearPid();
            reject(err);
          });
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
        await new Promise((r) => setTimeout(r, 500));
      }
      const pid = startBackground();
      return ok<WebData>({ action: "restart", status: "restarted", pid, logFile: LOG_FILE, url: WEB_URL });
    }

    throw new CliError("Unhandled web subcommand.", { code: "UNHANDLED_SUBCOMMAND" });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as WebData;

    const describeAutostart = (s?: ServiceStatus): string => {
      if (!s || !s.enabled) return "disabled";
      return s.backend ? `enabled (${s.backend})` : "enabled";
    };

    if (data.action === "info") {
      ui.section("Belzabar web app");
      if (data.status === "running") {
        ui.kv("Status", `running (PID ${data.pid})`);
        ui.kv("URL", data.url!);
      } else {
        ui.kv("Status", "not running");
      }
      ui.kv("Autostart", describeAutostart(data.autostart));
      ui.text("");
      ui.text("Subcommands:");
      ui.text("  start     Start the web app (background; -v for foreground)");
      ui.text("  stop      Stop the running web app");
      ui.text("  restart   Restart the web app");
      ui.text("  status    Show running + autostart state");
      ui.text("  enable    Start the web app automatically at login");
      ui.text("  disable   Remove the login autostart");
      return;
    }

    if (data.action === "status") {
      if (data.status === "running") {
        ui.success(`Web app is running (PID ${data.pid}).`);
        ui.kv("URL", data.url!);
      } else {
        ui.warn("Web app is not running.");
        ui.text("Start it with: belz web start");
      }
      ui.kv("Autostart", describeAutostart(data.autostart));
      return;
    }

    if (data.action === "enable") {
      const s = data.autostart;
      ui.success(`Web app will now start automatically at login (${s?.backend ?? "autostart"}).`);
      ui.kv("URL", data.url!);
      if (s?.backend === "xdg-autostart") {
        ui.text("Note: XDG autostart triggers on graphical login only.");
      }
      ui.text("Disable with: belz web disable");
      return;
    }

    if (data.action === "disable") {
      ui.success("Login autostart removed.");
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
      ui.text("Run 'belz web stop' to stop it.");
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
