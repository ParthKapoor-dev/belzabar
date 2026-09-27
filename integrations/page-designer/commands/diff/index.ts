// belz pd diff — compare the same page/component across two environments.
//
//   belz pd diff <input> --from <envA> --to <envB>
//
// <input> is a page id / name / app-url / pd-url. It is resolved INDEPENDENTLY
// in each environment (entity ids are env-local, so the input is resolved per
// env rather than reused) and the two configs are structurally diffed via the
// shared lib/page-diff module — the same engine `pd history diff` uses.

import { CliError, Config, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { PD_INPUT_POSITIONAL } from "../../lib/args/common";
import { resolveInput } from "../../lib/resolver";
import { parsePage } from "../../lib/parser/index";
import { diffPages, isIdentical, type PageDiff } from "../../lib/page-diff";
import type { HydratedPage } from "../../lib/types/common";

interface DiffArgs {
  input: string;
  from: string;
  to: string;
}

interface SideInfo {
  env: string;
  resolvedId: string;
  name: string;
  entityType: "PAGE" | "COMPONENT";
  status: string;
  versionId: number | null;
}

interface DiffData {
  input: string;
  from: SideInfo;
  to: SideInfo;
  identical: boolean;
  diff: PageDiff;
}


/** Resolve `<input>` in a specific environment and parse it. Caller restores env. */
async function resolveInEnv(
  env: string,
  input: string,
): Promise<{ side: SideInfo; page: HydratedPage }> {
  Config.setActiveEnv(env);
  let resolved;
  try {
    resolved = await resolveInput(input, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to resolve "${input}" in environment "${env}": ${message}`, {
      code: "PD_DIFF_RESOLVE_FAILED",
      details: { env, input },
    });
  }
  const page = parsePage(resolved.response);
  return {
    side: {
      env,
      resolvedId: resolved.resolvedId,
      name: page.name,
      entityType: resolved.entityType,
      status: page.status,
      versionId: page.versionId,
    },
    page,
  };
}

export const args = defineArgs({
  command: "belz pd diff",
  positionals: [PD_INPUT_POSITIONAL],
  flags: {
    from: { type: "string", required: true, missingCode: "MISSING_ENV_RANGE", missingMessage: "--from <envA> and --to <envB> are both required." },
    to: { type: "string", required: true, missingCode: "MISSING_ENV_RANGE", missingMessage: "--from <envA> and --to <envB> are both required." },
  },
});

const command: CommandModule<DiffArgs, DiffData> = {
  schema: "pd.diff",

  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { input: positionals.input, from: flags.from, to: flags.to };
  },

  async execute({ input, from, to }) {
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

    const original = Config.activeEnv.name;
    let fromResult: { side: SideInfo; page: HydratedPage };
    let toResult: { side: SideInfo; page: HydratedPage };
    try {
      fromResult = await resolveInEnv(from, input);
      toResult = await resolveInEnv(to, input);
    } finally {
      // Restore the original active env so the command envelope's meta.env is sane.
      Config.setActiveEnv(original);
    }

    const diff = diffPages(fromResult.page, toResult.page);

    const identical = isIdentical(diff);

    return ok<DiffData>({
      input,
      from: fromResult.side,
      to: toResult.side,
      identical,
      diff,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as DiffData;

    ui.kv("Input", data.input);
    ui.kv("From", `${data.from.env}  (${data.from.resolvedId}, ${data.from.status})`);
    ui.kv("To", `${data.to.env}  (${data.to.resolvedId}, ${data.to.status})`);

    if (data.identical) {
      ui.success("No structural differences — the pages match across environments.");
      return;
    }

    const d = data.diff;
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
      if (added.length > 0) ui.text(`+ ${added.join(", ")}`);
      if (removed.length > 0) ui.text(`- ${removed.join(", ")}`);
      if (changed && changed.length > 0) ui.text(`~ ${changed.join(", ")}`);
    };
    reportGroup("Variables", d.variables.added, d.variables.removed, d.variables.changed);
    reportGroup("Derived", d.derived.added, d.derived.removed, d.derived.changed);
    reportGroup("HTTP Requests", d.httpRequests.added, d.httpRequests.removed, d.httpRequests.changed);
    if (d.nodesAdded.length + d.nodesRemoved.length + d.nodesKindChanged.length + d.nodesChanged.length > 0) {
      ui.section("Layout Nodes");
      if (d.nodesAdded.length > 0) ui.text(`+ ${d.nodesAdded.join(", ")}`);
      if (d.nodesRemoved.length > 0) ui.text(`- ${d.nodesRemoved.join(", ")}`);
      if (d.nodesChanged.length > 0) ui.text(`~ ${d.nodesChanged.join(", ")}`);
      for (const c of d.nodesKindChanged) ui.text(`~ ${c.nodeId}: ${c.before} → ${c.after}`);
    }
    if (d.otherChanged.length > 0) ui.kv("Other config changed", d.otherChanged.join(", "));
  },
};

export default command;
