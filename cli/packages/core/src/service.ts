// Cross-platform per-user "start at login" service manager.
//
// belz uses this to make the web app (and potentially other long-running
// helpers) auto-start when the user logs in — without admin/root. Each OS has
// its own mechanism; this module hides that behind enable/disable/status.
//
//   Linux   : systemd --user unit, falling back to an XDG autostart .desktop
//   macOS   : launchd LaunchAgent (~/Library/LaunchAgents)
//   Windows : a per-user logon Scheduled Task, falling back to the Startup folder
//
// Supervised backends (systemd, launchd) own the process and can restart it on
// failure, so they run the service's `superviseExec` in the foreground.
// Unsupervised backends (XDG autostart, Windows) just fire a command at login,
// so they run the self-detaching `detachExec`.

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface ServiceExec {
  command: string;
  args: string[];
}

export interface ServiceSpec {
  /** Stable id, used for unit/task/file names (e.g. "belz-web"). */
  id: string;
  /** Human-readable name shown in unit descriptions. */
  displayName: string;
  /** Foreground command for supervised backends — the supervisor owns it. */
  superviseExec: ServiceExec;
  /** Self-detaching command for unsupervised backends. */
  detachExec: ServiceExec;
  workingDir?: string;
  env?: Record<string, string>;
}

export type ServiceBackend =
  | "systemd-user"
  | "xdg-autostart"
  | "launchd"
  | "schtasks"
  | "startup-folder";

export interface ServiceStatus {
  /** Whether the service is installed as a login-start service. */
  enabled: boolean;
  backend: ServiceBackend | null;
  /** Path to the unit/plist/task launcher file, when there is one on disk. */
  unitPath: string | null;
  /** Whether it is running right now — null when the backend cannot tell. */
  active: boolean | null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: !r.error && r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

/** True when `systemctl --user` is usable in this session. */
function hasSystemdUser(): boolean {
  const r = spawnSync("systemctl", ["--user", "list-units", "--no-pager"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

/** Double-quote a token for a systemd ExecStart / .desktop Exec line. */
function quoteToken(token: string): string {
  return `"${token.replace(/(["\\])/g, "\\$1")}"`;
}

function quoteExec(exec: ServiceExec): string {
  return [exec.command, ...exec.args].map(quoteToken).join(" ");
}

/** Escape a string for embedding inside a PowerShell single-quoted literal. */
function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ── Linux: systemd --user ────────────────────────────────────────────────────

function systemdUnitPath(spec: ServiceSpec): string {
  return join(homedir(), ".config", "systemd", "user", `${spec.id}.service`);
}

function enableSystemd(spec: ServiceSpec): ServiceStatus {
  const unitPath = systemdUnitPath(spec);
  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });

  const envLines = Object.entries(spec.env ?? {})
    .map(([k, v]) => `Environment=${quoteToken(`${k}=${v}`)}`)
    .join("\n");

  const unit =
    `[Unit]\n` +
    `Description=${spec.displayName}\n\n` +
    `[Service]\n` +
    `Type=simple\n` +
    `ExecStart=${quoteExec(spec.superviseExec)}\n` +
    (spec.workingDir ? `WorkingDirectory=${spec.workingDir}\n` : "") +
    (envLines ? `${envLines}\n` : "") +
    `Restart=on-failure\n` +
    `RestartSec=3\n\n` +
    `[Install]\n` +
    `WantedBy=default.target\n`;

  writeFileSync(unitPath, unit);
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", `${spec.id}.service`]);
  return systemdStatus(spec);
}

function systemdStatus(spec: ServiceSpec): ServiceStatus {
  const unitPath = systemdUnitPath(spec);
  const enabled = run("systemctl", ["--user", "is-enabled", `${spec.id}.service`]).ok;
  const active = run("systemctl", ["--user", "is-active", `${spec.id}.service`]).ok;
  return { enabled: enabled && existsSync(unitPath), backend: "systemd-user", unitPath, active };
}

function disableSystemd(spec: ServiceSpec): void {
  run("systemctl", ["--user", "disable", "--now", `${spec.id}.service`]);
  const unitPath = systemdUnitPath(spec);
  if (existsSync(unitPath)) rmSync(unitPath);
  run("systemctl", ["--user", "daemon-reload"]);
}

// ── Linux: XDG autostart fallback ────────────────────────────────────────────

function xdgDesktopPath(spec: ServiceSpec): string {
  return join(homedir(), ".config", "autostart", `${spec.id}.desktop`);
}

function enableXdg(spec: ServiceSpec): ServiceStatus {
  const desktopPath = xdgDesktopPath(spec);
  mkdirSync(join(homedir(), ".config", "autostart"), { recursive: true });
  const desktop =
    `[Desktop Entry]\n` +
    `Type=Application\n` +
    `Name=${spec.displayName}\n` +
    `Exec=${quoteExec(spec.detachExec)}\n` +
    `X-GNOME-Autostart-enabled=true\n`;
  writeFileSync(desktopPath, desktop);
  return { enabled: true, backend: "xdg-autostart", unitPath: desktopPath, active: null };
}

// ── macOS: launchd LaunchAgent ───────────────────────────────────────────────

function launchdLabel(spec: ServiceSpec): string {
  return `com.belzabar.${spec.id}`;
}

function launchdPlistPath(spec: ServiceSpec): string {
  return join(homedir(), "Library", "LaunchAgents", `${launchdLabel(spec)}.plist`);
}

function enableLaunchd(spec: ServiceSpec): ServiceStatus {
  const plistPath = launchdPlistPath(spec);
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });

  const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const programArgs = [spec.superviseExec.command, ...spec.superviseExec.args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");
  const envEntries = Object.entries(spec.env ?? {})
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");

  const plist =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ` +
    `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n<dict>\n` +
    `  <key>Label</key>\n  <string>${launchdLabel(spec)}</string>\n` +
    `  <key>ProgramArguments</key>\n  <array>\n${programArgs}\n  </array>\n` +
    (spec.workingDir ? `  <key>WorkingDirectory</key>\n  <string>${xmlEscape(spec.workingDir)}</string>\n` : "") +
    (envEntries ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n` : "") +
    `  <key>RunAtLoad</key>\n  <true/>\n` +
    `  <key>KeepAlive</key>\n  <true/>\n` +
    `</dict>\n</plist>\n`;

  writeFileSync(plistPath, plist);
  const uid = String(process.getuid?.() ?? "");
  // launchctl bootstrap is the modern form; load -w is the legacy fallback.
  const bootstrapped = run("launchctl", ["bootstrap", `gui/${uid}`, plistPath]).ok;
  if (!bootstrapped) run("launchctl", ["load", "-w", plistPath]);
  return launchdStatus(spec);
}

function launchdStatus(spec: ServiceSpec): ServiceStatus {
  const plistPath = launchdPlistPath(spec);
  const uid = String(process.getuid?.() ?? "");
  const printed = run("launchctl", ["print", `gui/${uid}/${launchdLabel(spec)}`]);
  return {
    enabled: existsSync(plistPath),
    backend: "launchd",
    unitPath: plistPath,
    active: printed.ok ? /state = running/.test(printed.stdout) : null,
  };
}

function disableLaunchd(spec: ServiceSpec): void {
  const plistPath = launchdPlistPath(spec);
  const uid = String(process.getuid?.() ?? "");
  if (!run("launchctl", ["bootout", `gui/${uid}/${launchdLabel(spec)}`]).ok) {
    run("launchctl", ["unload", "-w", plistPath]);
  }
  if (existsSync(plistPath)) rmSync(plistPath);
}

// ── Windows: logon Scheduled Task ────────────────────────────────────────────

function startupFolderPath(spec: ServiceSpec): string {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${spec.id}.cmd`);
}

function enableWindows(spec: ServiceSpec): ServiceStatus {
  const exec = spec.detachExec;
  const argString = exec.args.join(" ");
  // Register-ScheduledTask handles path/arg quoting cleanly, unlike `schtasks /TR`.
  const ps =
    `$ErrorActionPreference='Stop';` +
    `$a=New-ScheduledTaskAction -Execute ${psSingleQuote(exec.command)}` +
    (argString ? ` -Argument ${psSingleQuote(argString)}` : "") +
    (spec.workingDir ? ` -WorkingDirectory ${psSingleQuote(spec.workingDir)}` : "") +
    `;$t=New-ScheduledTaskTrigger -AtLogOn;` +
    `Register-ScheduledTask -TaskName ${psSingleQuote(spec.id)} -Action $a -Trigger $t -Force | Out-Null`;
  const registered = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]).ok;
  if (registered) {
    return { enabled: true, backend: "schtasks", unitPath: null, active: null };
  }
  // Fallback: a .cmd in the per-user Startup folder.
  const cmdPath = startupFolderPath(spec);
  mkdirSync(join(cmdPath, ".."), { recursive: true });
  writeFileSync(cmdPath, `@echo off\r\nstart "" "${exec.command}" ${argString}\r\n`);
  return { enabled: true, backend: "startup-folder", unitPath: cmdPath, active: null };
}

function windowsStatus(spec: ServiceSpec): ServiceStatus {
  const taskExists = run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `if (Get-ScheduledTask -TaskName ${psSingleQuote(spec.id)} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
  ]).ok;
  if (taskExists) return { enabled: true, backend: "schtasks", unitPath: null, active: null };
  const cmdPath = startupFolderPath(spec);
  if (existsSync(cmdPath)) return { enabled: true, backend: "startup-folder", unitPath: cmdPath, active: null };
  return { enabled: false, backend: null, unitPath: null, active: null };
}

function disableWindows(spec: ServiceSpec): void {
  run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Unregister-ScheduledTask -TaskName ${psSingleQuote(spec.id)} -Confirm:$false -ErrorAction SilentlyContinue`,
  ]);
  const cmdPath = startupFolderPath(spec);
  if (existsSync(cmdPath)) rmSync(cmdPath);
}

// ── public API ───────────────────────────────────────────────────────────────

/** Install `spec` as a per-user login-start service. Idempotent. */
export function enableService(spec: ServiceSpec): ServiceStatus {
  if (process.platform === "darwin") return enableLaunchd(spec);
  if (process.platform === "win32") return enableWindows(spec);
  // linux
  if (hasSystemdUser()) return enableSystemd(spec);
  return enableXdg(spec);
}

/** Remove the login-start service for `spec`. Idempotent. */
export function disableService(spec: ServiceSpec): void {
  if (process.platform === "darwin") {
    disableLaunchd(spec);
    return;
  }
  if (process.platform === "win32") {
    disableWindows(spec);
    return;
  }
  if (hasSystemdUser()) disableSystemd(spec);
  const desktopPath = xdgDesktopPath(spec);
  if (existsSync(desktopPath)) rmSync(desktopPath);
}

/** Report whether `spec` is installed as a login-start service. */
export function serviceStatus(spec: ServiceSpec): ServiceStatus {
  if (process.platform === "darwin") return launchdStatus(spec);
  if (process.platform === "win32") return windowsStatus(spec);
  if (hasSystemdUser()) {
    const s = systemdStatus(spec);
    if (s.enabled) return s;
  }
  const desktopPath = xdgDesktopPath(spec);
  if (existsSync(desktopPath)) {
    return { enabled: true, backend: "xdg-autostart", unitPath: desktopPath, active: null };
  }
  return { enabled: false, backend: null, unitPath: null, active: null };
}
