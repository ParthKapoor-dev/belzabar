// The CLI's namespace/command wiring, shared by the entry point (bin/cli.ts)
// and tests (`@belzabar/core/testing` `loadDevCliOptions`, the envelope
// contract test). Everything comes from the static registries, so dev mode
// and the compiled binary run exactly the same command set and help text.

import {
  registryHelpResolver,
  registryModules,
  registryNames,
  type CommandRegistry,
  type HelpFullOptions,
  type NamespacedCliOptions,
} from "@belzabar/core";
import { registry as adRegistry } from "@belzabar/ad/registry";
import { registry as pdRegistry } from "@belzabar/pd/registry";
import { registry as twRegistry } from "@belzabar/teamwork/registry";
import { registry as migrateRegistry } from "@belzabar/migrations/registry";
import { registry as releaseRegistry } from "@belzabar/release/registry";
import { registry as topCommands } from "../commands/registry";
import { buildInfo } from "./build-info" with { type: "macro" };

/** Version + git SHA, embedded at build time (macro). */
export const BUILD = buildInfo();

const topRegistry: CommandRegistry = topCommands;

/** Top-level commands that own a namespace and do their own sub-routing. */
const PASSTHROUGH = {
  config: { name: "Config", description: "Manage belz credentials and environments.", envAware: false },
  extension: { name: "Extension", description: "Install and manage the Belzabar browser extension.", envAware: false },
} as const;

/**
 * Namespaces/commands that never talk to an AD/PD environment: their envelopes
 * carry no `meta.env` (a command's own `envAware` still wins). Teamwork, Jenkins
 * migrations (the target comes from the profile) and release (envs come from the
 * release spec) are env-independent; so are the local top-level commands.
 */
const NOT_ENV_AWARE_NAMESPACES = new Set(["tw", "migrate", "release"]);
const NOT_ENV_AWARE_TOP_LEVEL = ["envs", "setup", "onboard", "update"] as const;

const NAMESPACES: Array<{ key: string; name: string; description: string; registry: CommandRegistry; header: string }> = [
  { key: "ad", name: "Automation Designer", description: "Interact with Automation Designer APIs.", registry: adRegistry, header: "belz ad <cmd>  —  Automation Designer" },
  { key: "pd", name: "Page Designer", description: "Analyze Page Designer configuration.", registry: pdRegistry, header: "belz pd <cmd>  —  Page Designer" },
  { key: "tw", name: "Teamwork", description: "Interact with the Teamwork project management API.", registry: twRegistry, header: "belz tw <cmd>  —  Teamwork" },
  { key: "migrate", name: "Migrations (Jenkins)", description: "Trigger Jenkins-backed migration builds.", registry: migrateRegistry, header: "belz migrate <cmd>  —  Migrations (Jenkins)" },
  { key: "release", name: "Release promotion tracking", description: "Audit releases: link tickets, trace items, detect collisions.", registry: releaseRegistry, header: "belz release <cmd>  —  Release promotion tracking" },
];

/** Every registry, keyed by the repo dir that owns its `commands/` folder (for tests). */
export const REGISTRIES: Record<string, CommandRegistry> = {
  "integrations/automation-designer": adRegistry,
  "integrations/page-designer": pdRegistry,
  "integrations/teamwork": twRegistry,
  "integrations/migrations": migrateRegistry,
  "integrations/release": releaseRegistry,
  "apps/cli": topRegistry,
};

export function buildCliOptions(): NamespacedCliOptions {
  const topHelp = registryHelpResolver(topRegistry);
  const namespaces: NamespacedCliOptions["namespaces"] = {};
  for (const ns of NAMESPACES) {
    namespaces[ns.key] = {
      name: ns.name,
      description: ns.description,
      commands: registryModules(ns.registry),
      helpResolver: registryHelpResolver(ns.registry),
      ...(NOT_ENV_AWARE_NAMESPACES.has(ns.key) ? { envAware: false } : {}),
    };
  }
  for (const [key, meta] of Object.entries(PASSTHROUGH)) {
    namespaces[key] = { ...meta, command: topRegistry[key]!.module, helpResolver: topHelp };
  }
  const topLevel = registryModules(topRegistry);
  for (const key of Object.keys(PASSTHROUGH)) delete topLevel[key];

  return {
    name: "Belzabar CLI",
    description: "Unified CLI for Automation Designer and Page Designer.",
    binaryName: "belz",
    namespaces,
    topLevel,
    topLevelHelpResolver: topHelp,
    topLevelEnvAware: Object.fromEntries(NOT_ENV_AWARE_TOP_LEVEL.map((k) => [k, false])),
    build: BUILD,
    helpFull: buildHelpFull,
  };
}

/**
 * `belz --help-full`: every command's desc.txt, sections in fixed order, commands sorted.
 * `namespace` limits it to one section (`top` = top-level commands); `index`
 * prints one line per command (its first desc line) — the full text is ~35 KB.
 * Returns null for an unknown namespace.
 */
export function buildHelpFull(opts: HelpFullOptions = {}): string | null {
  const RULE = "─".repeat(77);
  const all = [
    ...NAMESPACES.map((ns) => ({ key: ns.key, header: ns.header, registry: ns.registry })),
    { key: "top", header: "belz <cmd>  —  Top-level", registry: topRegistry },
  ];
  const sections = opts.namespace ? all.filter((s) => s.key === opts.namespace) : all;
  if (sections.length === 0) return null;
  const lines = [
    "NOTE FOR LLM AGENTS: Always use the --llm flag for structured, parseable output.",
    "  Example: belz ad show <uuid> --llm",
    "  stdout carries only the JSON envelope; stderr carries human notices (the",
    "  `[belz ad write] {…}` audit line of a write, the default-env notice, progress).",
    "  `belz --help-full <module>` prints one module; `--index` one line per command.",
    "",
    "belz — Belzabar CLI",
  ];
  for (const { header, registry } of sections) {
    lines.push("", header, RULE);
    for (const name of registryNames(registry)) {
      const desc = registry[name]!.desc.trimEnd();
      if (!desc) continue;
      if (opts.index) {
        const first = desc.split("\n")[0]!;
        const [inv, what = ""] = first.split("  :->  ");
        const words = inv!.split(" ");
        const cmd = words.slice(0, words[1] && registry !== topRegistry ? 3 : 2).join(" ");
        lines.push(`${cmd}  :->  ${what.length > 110 ? `${what.slice(0, 109)}…` : what}`);
      } else lines.push(desc, "");
    }
  }
  if (opts.index) lines.push("");
  lines.push("Use 'belz <namespace> <cmd> --help' for full flag documentation and examples.");
  return lines.join("\n");
}
