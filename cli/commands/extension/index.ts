import { spawnSync } from "child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  CliError,
  ok,
  lifecycle,
  prompts,
  loadConfigFileRaw,
  writeConfigFile,
  detectBrowsers,
  type CommandModule,
  type DetectedBrowser,
} from "@belzabar/core";
import release from "../../../extension/release.config.json";

// ── published extension identity (see extension/release.config.json) ─────────

const CHROME_FORCELIST_ENTRY = `${release.chromeId};${release.chromeUpdateXmlUrl}`;
const FIREFOX_INSTALL_URL = `${release.pagesBaseUrl}/belzabar-latest.xpi`;

type ExtAction = "load" | "remove" | "list" | "status";

interface ExtArgs {
  action: ExtAction;
  /** explicit browser keys, or empty for interactive selection */
  browsers: string[];
  all: boolean;
}

interface BrowserResult {
  key: string;
  name: string;
  applied: boolean;
  /** a command for the user to run themselves, when elevation is required */
  manualCommand?: string;
  note?: string;
}

interface ExtData {
  action: ExtAction;
  results: BrowserResult[];
  detected?: Array<{ key: string; name: string; family: string; installed: boolean; loaded: boolean }>;
}

// ── policy payloads ───────────────────────────────────────────────────────────

/** Chromium managed-policy JSON (Linux dedicated file — belz owns the whole file). */
function chromiumPolicyJson(): string {
  return JSON.stringify({ ExtensionInstallForcelist: [CHROME_FORCELIST_ENTRY] }, null, 2);
}

/** Merge belz's entry into a Firefox policies.json body. */
function mergeFirefoxPolicy(existing: string | null): string {
  let doc: any = {};
  if (existing) {
    try {
      doc = JSON.parse(existing);
    } catch {
      doc = {};
    }
  }
  doc.policies = doc.policies ?? {};
  doc.policies.ExtensionSettings = doc.policies.ExtensionSettings ?? {};
  doc.policies.ExtensionSettings[release.firefoxId] = {
    installation_mode: "force_installed",
    install_url: FIREFOX_INSTALL_URL,
  };
  return JSON.stringify(doc, null, 2);
}

/** Remove belz's entry from a Firefox policies.json body; null if nothing left to keep. */
function stripFirefoxPolicy(existing: string): string | null {
  let doc: any;
  try {
    doc = JSON.parse(existing);
  } catch {
    return existing;
  }
  const settings = doc?.policies?.ExtensionSettings;
  if (settings && release.firefoxId in settings) delete settings[release.firefoxId];
  return JSON.stringify(doc, null, 2);
}

// ── filesystem / registry helpers ─────────────────────────────────────────────

function isWritable(path: string): boolean {
  let probe = path;
  while (probe && !existsSync(probe)) probe = dirname(probe);
  try {
    accessSync(probe, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function reg(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("reg", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Find the forcelist registry value holding belz's entry, plus the next free slot. */
function chromiumForcelistSlots(policyRoot: string): { mineValue: string | null; nextFree: string } {
  const key = `${policyRoot}\\ExtensionInstallForcelist`;
  const q = reg(["query", key]);
  let mine: string | null = null;
  let max = 0;
  if (q.ok) {
    for (const line of q.out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+REG_SZ\s+(.+)$/);
      if (!m) continue;
      const idx = parseInt(m[1]!, 10);
      if (idx > max) max = idx;
      if (m[2]!.startsWith(`${release.chromeId};`)) mine = m[1]!;
    }
  }
  return { mineValue: mine, nextFree: String(max + 1) };
}

// ── apply / unapply per browser ───────────────────────────────────────────────

/** Force-install the extension for one browser; never throws. */
function applyBrowser(b: DetectedBrowser): BrowserResult {
  const base: BrowserResult = { key: b.key, name: b.name, applied: false };

  // Windows Chromium — HKCU registry, no elevation.
  if (b.policyKind === "windows-registry") {
    const key = `${b.policyTarget}\\ExtensionInstallForcelist`;
    const slot = chromiumForcelistSlots(b.policyTarget);
    const r = reg(["add", key, "/v", slot.mineValue ?? slot.nextFree, "/t", "REG_SZ", "/d", CHROME_FORCELIST_ENTRY, "/f"]);
    return r.ok
      ? { ...base, applied: true, note: "restart the browser to pick up the extension" }
      : { ...base, note: `registry write failed: ${r.out.trim()}` };
  }

  // JSON policy file (Chromium dedicated file on Linux, or Firefox policies.json).
  const content =
    b.family === "chromium"
      ? chromiumPolicyJson()
      : mergeFirefoxPolicy(existsSync(b.policyTarget) ? readFileSync(b.policyTarget, "utf8") : null);

  if (!b.needsElevation && isWritable(b.policyTarget)) {
    mkdirSync(dirname(b.policyTarget), { recursive: true });
    writeFileSync(b.policyTarget, content);
    return { ...base, applied: true, note: "restart the browser to pick up the extension" };
  }

  // Elevation required — stage the file and hand the user an exact command.
  const staged = join(mkdtempSync(join(tmpdir(), "belz-ext-")), b.family === "chromium" ? "policy.json" : "policies.json");
  writeFileSync(staged, content);
  const target = b.policyTarget;
  const manualCommand =
    process.platform === "darwin" && b.policyKind === "macos-managed"
      ? `sudo defaults write '${target.replace(/\.plist$/, "")}' ExtensionInstallForcelist -array '${CHROME_FORCELIST_ENTRY}'`
      : `sudo mkdir -p '${dirname(target)}' && sudo cp '${staged}' '${target}'`;
  return { ...base, manualCommand, note: "needs elevation — run the command above, then restart the browser" };
}

/** Remove the force-install policy for one browser; never throws. */
function unapplyBrowser(b: DetectedBrowser): BrowserResult {
  const base: BrowserResult = { key: b.key, name: b.name, applied: false };

  if (b.policyKind === "windows-registry") {
    const slot = chromiumForcelistSlots(b.policyTarget);
    if (!slot.mineValue) return { ...base, applied: true, note: "no belz entry present" };
    const r = reg(["delete", `${b.policyTarget}\\ExtensionInstallForcelist`, "/v", slot.mineValue, "/f"]);
    return r.ok ? { ...base, applied: true } : { ...base, note: `registry delete failed: ${r.out.trim()}` };
  }

  if (!existsSync(b.policyTarget)) return { ...base, applied: true, note: "no policy file present" };

  if (b.family === "chromium") {
    // Linux dedicated file — belz owns it, so just remove it.
    if (!b.needsElevation && isWritable(b.policyTarget)) {
      rmSync(b.policyTarget);
      return { ...base, applied: true };
    }
    return { ...base, manualCommand: `sudo rm -f '${b.policyTarget}'`, note: "needs elevation" };
  }

  // Firefox — merge belz's entry out of the shared policies.json.
  const stripped = stripFirefoxPolicy(readFileSync(b.policyTarget, "utf8"));
  if (stripped === null) return { ...base, applied: true };
  if (!b.needsElevation && isWritable(b.policyTarget)) {
    writeFileSync(b.policyTarget, stripped);
    return { ...base, applied: true };
  }
  const staged = join(mkdtempSync(join(tmpdir(), "belz-ext-")), "policies.json");
  writeFileSync(staged, stripped);
  return {
    ...base,
    manualCommand: `sudo cp '${staged}' '${b.policyTarget}'`,
    note: "needs elevation",
  };
}

// ── config bookkeeping ────────────────────────────────────────────────────────

function recordLoaded(keys: string[], loaded: boolean): void {
  const config = loadConfigFileRaw();
  const set = new Set(config.extension?.loadedBrowsers ?? []);
  for (const k of keys) {
    if (loaded) set.add(k);
    else set.delete(k);
  }
  config.extension = { ...config.extension, loadedBrowsers: [...set] };
  writeConfigFile(config);
}

function loadedSet(): Set<string> {
  return new Set(loadConfigFileRaw().extension?.loadedBrowsers ?? []);
}

// ── browser selection ─────────────────────────────────────────────────────────

async function pickBrowsers(args: ExtArgs, installed: DetectedBrowser[], context: { outputMode: string }): Promise<DetectedBrowser[]> {
  if (args.all) return installed;
  if (args.browsers.length) {
    const chosen = installed.filter((b) => args.browsers.includes(b.key));
    const unknown = args.browsers.filter((k) => !installed.some((b) => b.key === k));
    if (unknown.length) {
      throw new CliError(`Not an installed browser: ${unknown.join(", ")}`, { code: "BROWSER_NOT_FOUND" });
    }
    return chosen;
  }
  if (context.outputMode === "llm") {
    throw new CliError("Specify browsers (e.g. `belz extension load chrome zen`) or --all in non-interactive mode.", {
      code: "BROWSERS_REQUIRED",
    });
  }
  const selected = await prompts.multiselect<string>({
    message: "Which browsers should belz load the extension into?",
    options: installed.map((b) => ({ label: `${b.name}${b.needsElevation ? " (needs sudo)" : ""}`, value: b.key })),
  });
  return installed.filter((b) => selected.includes(b.key));
}

// ── command ───────────────────────────────────────────────────────────────────

const command: CommandModule<ExtArgs, ExtData> = {
  schema: "belz.extension",

  parseArgs(args) {
    // The runner already strips the "extension" token — args[0] is the
    // sub-command (load / remove / list / status).
    const sub = args[0];
    const valid: ExtAction[] = ["load", "remove", "list", "status"];
    const action = (valid.includes(sub as ExtAction) ? sub : "list") as ExtAction;
    const operands = valid.includes(sub as ExtAction) ? args.slice(1) : args;
    const browsers: string[] = [];
    let all = false;
    for (const token of operands) {
      if (token === "--all") all = true;
      else if (token.startsWith("-")) throw new CliError(`Unknown flag: ${token}`, { code: "UNKNOWN_FLAG" });
      else browsers.push(token);
    }
    return { action, browsers, all };
  },

  async execute(args, context) {
    const detected = detectBrowsers();
    const installed = detected.filter((b) => b.installed);

    if (args.action === "list" || args.action === "status") {
      const loaded = loadedSet();
      return ok<ExtData>({
        action: args.action,
        results: [],
        detected: detected.map((b) => ({
          key: b.key,
          name: b.name,
          family: b.family,
          installed: b.installed,
          loaded: loaded.has(b.key),
        })),
      });
    }

    if (installed.length === 0) {
      throw new CliError("No supported browsers detected on this system.", { code: "NO_BROWSERS" });
    }

    if (release.chromeId.startsWith("REPLACE_")) {
      context.warn(
        "extension/release.config.json `chromeId` is still a placeholder — Chromium force-install will not work until the CRX-signed extension ID is filled in (see the extension-release workflow)."
      );
    }

    const targets = await pickBrowsers(args, installed, context);
    if (targets.length === 0) {
      throw new CliError("No browsers selected.", { code: "NOTHING_SELECTED" });
    }

    const apply = args.action === "load" ? applyBrowser : unapplyBrowser;
    const results = targets.map(apply);
    recordLoaded(
      results.filter((r) => r.applied).map((r) => r.key),
      args.action === "load"
    );

    return ok<ExtData>({ action: args.action, results });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ExtData;

    if (data.action === "list" || data.action === "status") {
      ui.section("Browsers");
      ui.table(
        ["Browser", "Family", "Installed", "Extension"],
        (data.detected ?? []).map((b) => [
          b.name,
          b.family,
          b.installed ? "yes" : "—",
          b.loaded ? "loaded" : b.installed ? "not loaded" : "—",
        ])
      );
      ui.text("");
      ui.text("Load with:  belz extension load [browser…|--all]");
      return;
    }

    const verb = data.action === "load" ? "Loaded" : "Removed";
    for (const r of data.results) {
      if (r.applied) {
        ui.success(`${verb} for ${r.name}${r.note ? ` — ${r.note}` : ""}.`);
      } else if (r.manualCommand) {
        ui.warn(`${r.name}: ${r.note ?? "needs a manual step"}`);
        ui.text(`  ${r.manualCommand}`);
      } else {
        ui.warn(`${r.name}: ${r.note ?? "could not apply"}`);
      }
    }
    if (data.results.some((r) => r.manualCommand)) {
      ui.text("");
      ui.text("Run the commands above (they need sudo), then restart those browsers.");
    }
  },
};

export default command;
