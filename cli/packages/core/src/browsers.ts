// Cross-platform browser detection + enterprise-policy locations.
//
// `belz extension load` force-installs the Belzabar extension by writing each
// browser's enterprise-policy file. This module knows, per browser and per OS:
//   - how to tell whether the browser is installed
//   - where its policy file / registry key lives
//   - whether writing there needs elevation (sudo / admin)
//
// Chromium-family browsers force-install via `ExtensionInstallForcelist`;
// Firefox-family browsers via `ExtensionSettings` inside a `policies.json`.

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type BrowserFamily = "chromium" | "firefox";

/** How the extension policy is applied for a given browser on this OS. */
export type PolicyKind = "json-file" | "windows-registry" | "macos-managed";

export interface DetectedBrowser {
  /** Stable key, e.g. "chrome", "edge", "zen". */
  key: string;
  name: string;
  family: BrowserFamily;
  installed: boolean;
  /** Policy file path, or the registry key root on Windows. */
  policyTarget: string;
  policyKind: PolicyKind;
  /** True when writing the policy requires sudo/admin. */
  needsElevation: boolean;
}

interface BrowserSpec {
  key: string;
  name: string;
  family: BrowserFamily;
  /** Per-OS [installProbePaths, policyTarget]. */
  linux?: { probes: string[]; policy: string };
  darwin?: { probes: string[]; policy: string };
  win32?: { probes: string[]; policyRegistry: string };
}

const HOME = homedir();
const PROGRAM_FILES = process.env["ProgramFiles"] ?? "C:\\Program Files";
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(HOME, "AppData", "Local");

// Chromium policy JSON drops into `<policy-dir>/belz-extension.json`; Firefox
// uses a single shared `policies.json` so the extension command merges into it.
const CHROME_POLICY_FILE = "belz-extension.json";

const SPECS: BrowserSpec[] = [
  {
    key: "chrome",
    name: "Google Chrome",
    family: "chromium",
    linux: {
      probes: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
      policy: `/etc/opt/chrome/policies/managed/${CHROME_POLICY_FILE}`,
    },
    darwin: {
      probes: ["/Applications/Google Chrome.app"],
      policy: "/Library/Managed Preferences/com.google.Chrome.plist",
    },
    win32: {
      probes: [join(PROGRAM_FILES, "Google", "Chrome", "Application", "chrome.exe")],
      policyRegistry: "HKCU\\Software\\Policies\\Google\\Chrome",
    },
  },
  {
    key: "chromium",
    name: "Chromium",
    family: "chromium",
    linux: {
      probes: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
      policy: `/etc/chromium/policies/managed/${CHROME_POLICY_FILE}`,
    },
    darwin: {
      probes: ["/Applications/Chromium.app"],
      policy: "/Library/Managed Preferences/org.chromium.Chromium.plist",
    },
    win32: {
      probes: [join(LOCALAPPDATA, "Chromium", "Application", "chrome.exe")],
      policyRegistry: "HKCU\\Software\\Policies\\Chromium",
    },
  },
  {
    key: "edge",
    name: "Microsoft Edge",
    family: "chromium",
    linux: {
      probes: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"],
      policy: `/etc/opt/edge/policies/managed/${CHROME_POLICY_FILE}`,
    },
    darwin: {
      probes: ["/Applications/Microsoft Edge.app"],
      policy: "/Library/Managed Preferences/com.microsoft.Edge.plist",
    },
    win32: {
      probes: [join(PROGRAM_FILES + " (x86)", "Microsoft", "Edge", "Application", "msedge.exe")],
      policyRegistry: "HKCU\\Software\\Policies\\Microsoft\\Edge",
    },
  },
  {
    key: "brave",
    name: "Brave",
    family: "chromium",
    linux: {
      probes: ["/usr/bin/brave-browser", "/opt/brave.com/brave/brave"],
      policy: `/etc/brave/policies/managed/${CHROME_POLICY_FILE}`,
    },
    darwin: {
      probes: ["/Applications/Brave Browser.app"],
      policy: "/Library/Managed Preferences/com.brave.Browser.plist",
    },
    win32: {
      probes: [join(PROGRAM_FILES, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")],
      policyRegistry: "HKCU\\Software\\Policies\\BraveSoftware\\Brave",
    },
  },
  {
    key: "vivaldi",
    name: "Vivaldi",
    family: "chromium",
    linux: {
      probes: ["/usr/bin/vivaldi", "/opt/vivaldi/vivaldi"],
      policy: `/etc/vivaldi/policies/managed/${CHROME_POLICY_FILE}`,
    },
    darwin: {
      probes: ["/Applications/Vivaldi.app"],
      policy: "/Library/Managed Preferences/com.vivaldi.Vivaldi.plist",
    },
    win32: {
      probes: [join(LOCALAPPDATA, "Vivaldi", "Application", "vivaldi.exe")],
      policyRegistry: "HKCU\\Software\\Policies\\Vivaldi",
    },
  },
  {
    key: "firefox",
    name: "Mozilla Firefox",
    family: "firefox",
    linux: {
      probes: ["/usr/bin/firefox", "/usr/lib/firefox/firefox", "/snap/bin/firefox"],
      policy: "/etc/firefox/policies/policies.json",
    },
    darwin: {
      probes: ["/Applications/Firefox.app"],
      policy: "/Applications/Firefox.app/Contents/Resources/distribution/policies.json",
    },
    win32: {
      probes: [join(PROGRAM_FILES, "Mozilla Firefox", "firefox.exe")],
      policyRegistry: join(PROGRAM_FILES, "Mozilla Firefox", "distribution", "policies.json"),
    },
  },
  {
    key: "zen",
    name: "Zen Browser",
    family: "firefox",
    linux: {
      probes: ["/usr/bin/zen", "/usr/lib/zen/zen", "/opt/zen/zen", join(HOME, ".zen")],
      policy: "/etc/zen/policies/policies.json",
    },
    darwin: {
      probes: ["/Applications/Zen.app", "/Applications/Zen Browser.app"],
      policy: "/Applications/Zen.app/Contents/Resources/distribution/policies.json",
    },
    win32: {
      probes: [join(PROGRAM_FILES, "Zen Browser", "zen.exe")],
      policyRegistry: join(PROGRAM_FILES, "Zen Browser", "distribution", "policies.json"),
    },
  },
  {
    key: "librewolf",
    name: "LibreWolf",
    family: "firefox",
    linux: {
      probes: ["/usr/bin/librewolf", "/opt/librewolf/librewolf"],
      policy: "/etc/librewolf/policies/policies.json",
    },
    darwin: {
      probes: ["/Applications/LibreWolf.app"],
      policy: "/Applications/LibreWolf.app/Contents/Resources/distribution/policies.json",
    },
    win32: {
      probes: [join(PROGRAM_FILES, "LibreWolf", "librewolf.exe")],
      policyRegistry: join(PROGRAM_FILES, "LibreWolf", "distribution", "policies.json"),
    },
  },
];

/** Detect installed browsers and their policy targets for the current OS. */
export function detectBrowsers(): DetectedBrowser[] {
  const out: DetectedBrowser[] = [];

  for (const spec of SPECS) {
    if (process.platform === "win32") {
      const w = spec.win32;
      if (!w) continue;
      out.push({
        key: spec.key,
        name: spec.name,
        family: spec.family,
        installed: w.probes.some((p) => existsSync(p)),
        policyTarget: w.policyRegistry,
        // Chromium writes HKCU (no admin); Firefox writes policies.json inside
        // Program Files (admin).
        policyKind: spec.family === "chromium" ? "windows-registry" : "json-file",
        needsElevation: spec.family === "firefox",
      });
    } else if (process.platform === "darwin") {
      const d = spec.darwin;
      if (!d) continue;
      out.push({
        key: spec.key,
        name: spec.name,
        family: spec.family,
        installed: d.probes.some((p) => existsSync(p)),
        policyTarget: d.policy,
        policyKind: spec.family === "chromium" ? "macos-managed" : "json-file",
        needsElevation: true, // /Library and app bundles both require sudo
      });
    } else {
      const l = spec.linux;
      if (!l) continue;
      out.push({
        key: spec.key,
        name: spec.name,
        family: spec.family,
        installed: l.probes.some((p) => existsSync(p)),
        policyTarget: l.policy,
        policyKind: "json-file",
        needsElevation: true, // /etc/... requires sudo
      });
    }
  }

  return out;
}
