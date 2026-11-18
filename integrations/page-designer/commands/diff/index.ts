// wi-impl pd diff — compare the same page/component across two environments.
//
//   wi-impl pd diff <input> --from <envA> --to <envB> [--version draft|published]
//
// <input> is a page id / name / app-url / pd-url. It is resolved INDEPENDENTLY
// in each environment (entity ids are env-local, so the input is resolved per
// env rather than reused; an id missing on one side is resolved there by its
// name from the other side) and the two configs are structurally diffed via
// the shared lib/page-diff module — the same engine `pd history diff` uses.
// Which copy each side read is reported (`resolvedAs`): a name resolves to the
// DRAFT unless --version says otherwise. `changes` names what differs inside
// every changed item, with the value on each side.

import { CliError, Config, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { PD_INPUT_POSITIONAL, PD_VERSION_FLAG } from "../../lib/args/common";
import { noteResolution, resolveInput, type PdCopy } from "../../lib/resolver";
import { parsePage } from "../../lib/parser/index";
import { detailLines, diffDetails, diffPages, isIdentical, type ChangeDetail, type PageDiff } from "../../lib/page-diff";
import type { HydratedPage } from "../../lib/types/common";

interface DiffArgs {
  input: string;
  from: string;
  to: string;
  version: PdCopy | null;
}

interface SideInfo {
  env: string;
  resolvedId: string;
  name: string;
  entityType: "PAGE" | "COMPONENT";
  status: string;
  versionId: number | null;
  /** The copy read on this side: DRAFT or PUBLISHED. */
  resolvedAs: string;
  /** The input id was not on this env: resolved by its name from the other env. */
  byNameFrom?: { env: string; id: string; name: string };
}

interface DiffData {
  input: string;
  /** DRAFT or PUBLISHED when both sides read that copy, else MIXED (see from/to.resolvedAs). */
  resolvedAs: string;
  from: SideInfo;
  to: SideInfo;
  identical: boolean;
  /** How to read the lists: added = only in `to`, removed = only in `from`. */
  direction: { added: string; removed: string };
  diff: PageDiff;
  /** What differs inside each changed item: paths with the `from` and `to` values. */
  changes: ChangeDetail[];
}

/**
 * Resolve `<input>` in `env` and parse it. The active env is restored
 * afterwards, so the envelope's meta.env stays the caller's.
 */
function resolveInEnv(env: string, other: string, input: string, version: PdCopy | null, warn: (m: string) => void): Promise<{ side: SideInfo; page: HydratedPage }> {
  return Config.withEnv(env, () => resolveAndParse(env, other, input, version, warn));
}

async function resolveAndParse(env: string, other: string, input: string, version: PdCopy | null, warn: (m: string) => void): Promise<{ side: SideInfo; page: HydratedPage }> {
  let resolved;
  try {
    resolved = await resolveInput(input, true, { version, nameFromEnv: other });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof CliError && err.code === "PD_VERSION_NOT_FOUND" ? err.code : "PD_DIFF_RESOLVE_FAILED";
    throw new CliError(`Failed to resolve "${input}" in environment "${env}": ${message}`, {
      code,
      details: { env, input },
    });
  }
  noteResolution(resolved, version, warn, env);
  const page = parsePage(resolved.response);
  return {
    side: {
      env,
      resolvedId: resolved.resolvedId,
      name: page.name,
      entityType: resolved.entityType,
      status: page.status,
      versionId: page.versionId,
      resolvedAs: resolved.resolvedAs,
      ...(resolved.byNameFrom ? { byNameFrom: resolved.byNameFrom } : {}),
    },
    page,
  };
}

export const args = defineArgs({
  command: "wi-impl pd diff",
  positionals: [PD_INPUT_POSITIONAL],
  flags: {
    from: { type: "string", required: true, missingCode: "MISSING_ENV_RANGE", missingMessage: "--from <envA> and --to <envB> are both required." },
    to: { type: "string", required: true, missingCode: "MISSING_ENV_RANGE", missingMessage: "--from <envA> and --to <envB> are both required." },
    ...PD_VERSION_FLAG,
  },
});

const command: CommandModule<DiffArgs, DiffData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { input: positionals.input, from: flags.from, to: flags.to, version: flags.version ?? null };
  },

  async execute({ input, from, to, version }, context) {
    const envs = Config.getAllEnvs();
    for (const env of [from, to]) {
      if (!envs[env]) {
        throw new CliError(
          `Unknown environment "${env}". Available: ${Object.keys(envs).join(", ")}`,
          { code: "PD_UNKNOWN_ENV" },
        );
      }
    }
    if (from === to) {
      throw new CliError("--from and --to must be different environments.", {
        code: "PD_DIFF_SAME_ENV",
      });
    }

    const warn = (m: string) => context.warn(m);
    const fromResult = await resolveInEnv(from, to, input, version, warn);
    const toResult = await resolveInEnv(to, from, input, version, warn);
    const diff = diffPages(fromResult.page, toResult.page);
    const identical = isIdentical(diff);
    const a = fromResult.side.resolvedAs;
    const b = toResult.side.resolvedAs;

    return ok<DiffData>({
      input,
      resolvedAs: a === b ? a : "MIXED",
      from: fromResult.side,
      to: toResult.side,
      identical,
      direction: { added: `only in ${to}`, removed: `only in ${from}` },
      diff,
      changes: identical ? [] : diffDetails(fromResult.page, toResult.page, diff),
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as DiffData;

    ui.kv("Input", data.input);
    ui.kv("Resolved as", data.resolvedAs);
    ui.kv("From", `${data.from.env}  (${data.from.resolvedId}, ${data.from.resolvedAs} v${data.from.versionId ?? "?"})`);
    ui.kv("To", `${data.to.env}  (${data.to.resolvedId}, ${data.to.resolvedAs} v${data.to.versionId ?? "?"})`);

    if (data.identical) {
      ui.success("No structural differences — the pages match across environments.");
      return;
    }

    const d = data.diff;
    const onlyTo = `+ ${data.direction.added}`;
    const onlyFrom = `- ${data.direction.removed}`;
    ui.kv("Nodes", `${d.nodeCountBefore} → ${d.nodeCountAfter}`);
    ui.kv(
      "Styles",
      d.styles.changed
        ? `changed (+${d.styles.linesAdded} / -${d.styles.linesRemoved} lines)`
        : "unchanged",
    );

    const reportGroup = (title: string, added: string[], removed: string[], changed?: string[]) => {
      if (added.length + removed.length + (changed?.length ?? 0) === 0) return;
      ui.section(title);
      if (added.length > 0) ui.text(`${onlyTo}: ${added.join(", ")}`);
      if (removed.length > 0) ui.text(`${onlyFrom}: ${removed.join(", ")}`);
      if (changed && changed.length > 0) ui.text(`~ differs: ${changed.join(", ")}`);
    };
    reportGroup("Variables", d.variables.added, d.variables.removed, d.variables.changed);
    reportGroup("Derived", d.derived.added, d.derived.removed, d.derived.changed);
    reportGroup("HTTP Requests", d.httpRequests.added, d.httpRequests.removed, d.httpRequests.changed);
    if (d.nodesAdded.length + d.nodesRemoved.length + d.nodesKindChanged.length + d.nodesChanged.length > 0) {
      ui.section("Layout Nodes");
      if (d.nodesAdded.length > 0) ui.text(`${onlyTo}: ${d.nodesAdded.join(", ")}`);
      if (d.nodesRemoved.length > 0) ui.text(`${onlyFrom}: ${d.nodesRemoved.join(", ")}`);
      if (d.nodesChanged.length > 0) ui.text(`~ differs: ${d.nodesChanged.join(", ")}`);
      for (const c of d.nodesKindChanged) ui.text(`~ ${c.nodeId}: ${c.before} → ${c.after}`);
    }
    if (d.nodesMoved.length > 0) ui.kv("Nodes moved", d.nodesMoved.join(", "));
    if (d.childrenReordered.length > 0) ui.kv("Children reordered under", d.childrenReordered.join(", "));
    if (d.otherChanged.length > 0) ui.kv("Other config changed", d.otherChanged.join(", "));
    if (data.changes.length > 0) {
      ui.section(`What differs (${data.from.env} → ${data.to.env})`);
      for (const line of detailLines(data.changes)) ui.text(line);
    }
  },
};

export default command;
