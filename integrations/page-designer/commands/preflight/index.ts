// belz pd preflight <pageId> [--overlay <file>]
//
// Read-only dry-run. Fetches the current page, optionally applies an overlay,
// runs the validator, and reports what would change. Never writes.
//
// Exit code follows validator verdict (0 if no errors, 1 otherwise) so
// agent scripts can chain: `belz pd preflight ... && belz pd save ...`.

import { readFile } from "node:fs/promises";
import { CliError, ok, type CommandModule } from "@belzabar/core";
import { parsePdCommonArgs } from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { parsePage } from "../../lib/parser/index";
import { applyOverlay, pickStrategy } from "../../lib/serialize/index";
import { partitionBySeverity, validateHydrated } from "../../lib/validator/index";
import type { HydratedPage, Overlay, ValidationIssue } from "../../lib/types/common";

interface PreflightArgs {
  pageId: string;
  overlayFile: string | null;
}

interface PreflightData {
  pageId: string;
  name: string;
  entityType: "PAGE" | "COMPONENT";
  status: string;
  hasOverlay: boolean;
  overlayStrategy: "partial" | "full" | null;
  beforeStats: { variables: number; derived: number; httpRequests: number; nodes: number };
  afterStats: { variables: number; derived: number; httpRequests: number; nodes: number };
  diffSummary: {
    variablesAdded: string[];
    variablesRemoved: string[];
    variablesChanged: string[];
    httpAdded: string[];
    httpRemoved: string[];
    stylesChanged: boolean;
  };
  validation: {
    issues: ValidationIssue[];
    errorCount: number;
    warnCount: number;
  };
  parseWarnings: string[];
}

function countNodes(page: HydratedPage): number {
  let n = 0;
  const walk = (node: { children: unknown[] }): void => {
    n++;
    for (const c of node.children) walk(c as { children: unknown[] });
  };
  walk(page.layout);
  return n;
}

const command: CommandModule<PreflightArgs, PreflightData> = {
  schema: "pd.preflight",

  parseArgs(args) {
    const { rest } = parsePdCommonArgs(args);
    const pageId = rest[0];
    if (!pageId || pageId.startsWith("-")) {
      throw new CliError("Missing <pageId>.", { code: "MISSING_INPUT" });
    }
    const oi = rest.indexOf("--overlay");
    const overlayFile = oi !== -1 ? rest[oi + 1] ?? null : null;
    if (oi !== -1 && !overlayFile) {
      throw new CliError("--overlay requires a file path.", { code: "INVALID_FLAG" });
    }
    return { pageId, overlayFile };
  },

  async execute({ pageId, overlayFile }) {
    const raw = await pdApi.fetchPage(pageId);
    if (!raw) throw new CliError(`Page ${pageId} not found.`, { code: "PD_NOT_FOUND" });
    const before = parsePage(raw);

    let after: HydratedPage = before;
    let overlay: Overlay | null = null;
    let overlayStrategy: "partial" | "full" | null = null;
    if (overlayFile) {
      const body = await readFile(overlayFile, "utf8");
      try {
        overlay = JSON.parse(body) as Overlay;
      } catch (err) {
        throw new CliError(`Overlay file parse failed: ${String(err)}`, { code: "INVALID_OVERLAY" });
      }
      after = applyOverlay(before, overlay);
      overlayStrategy = pickStrategy(overlay);
    }

    const issues = validateHydrated(after);
    const { errors, warnings } = partitionBySeverity(issues);

    const variablesBefore = new Set(before.variables.map((v) => v.name));
    const variablesAfter = new Set(after.variables.map((v) => v.name));
    const vAdded: string[] = [];
    const vRemoved: string[] = [];
    for (const n of variablesAfter) if (!variablesBefore.has(n)) vAdded.push(n);
    for (const n of variablesBefore) if (!variablesAfter.has(n)) vRemoved.push(n);
    const vChanged: string[] = [];
    const initBefore = new Map(before.variables.map((v) => [v.name, JSON.stringify(v.initialValue)] as const));
    for (const v of after.variables) {
      const prior = initBefore.get(v.name);
      if (prior !== undefined && prior !== JSON.stringify(v.initialValue)) vChanged.push(v.name);
    }

    const httpBefore = new Set(before.httpRequests.map((c) => c.callId ?? `idx:${c.index}`));
    const httpAfter = new Set(after.httpRequests.map((c) => c.callId ?? `idx:${c.index}`));
    const hAdded: string[] = [];
    const hRemoved: string[] = [];
    for (const n of httpAfter) if (!httpBefore.has(n)) hAdded.push(n);
    for (const n of httpBefore) if (!httpAfter.has(n)) hRemoved.push(n);

    return ok<PreflightData>({
      pageId,
      name: after.name,
      entityType: after.entityType,
      status: after.status,
      hasOverlay: !!overlay,
      overlayStrategy,
      beforeStats: {
        variables: before.variables.length,
        derived: before.derived.length,
        httpRequests: before.httpRequests.length,
        nodes: countNodes(before),
      },
      afterStats: {
        variables: after.variables.length,
        derived: after.derived.length,
        httpRequests: after.httpRequests.length,
        nodes: countNodes(after),
      },
      diffSummary: {
        variablesAdded: vAdded,
        variablesRemoved: vRemoved,
        variablesChanged: vChanged,
        httpAdded: hAdded,
        httpRemoved: hRemoved,
        stylesChanged: before.styles !== after.styles,
      },
      validation: {
        issues,
        errorCount: errors.length,
        warnCount: warnings.length,
      },
      parseWarnings: after.parseWarnings,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as PreflightData;

    ui.table(
      ["Property", "Value"],
      [
        ["Page", data.pageId],
        ["Name", data.name],
        ["Entity Type", data.entityType],
        ["Status", data.status],
        ["Overlay", data.hasOverlay ? `yes (${data.overlayStrategy})` : "none"],
        ["Errors", data.validation.errorCount],
        ["Warnings", data.validation.warnCount],
      ],
    );

    if (data.hasOverlay) {
      ui.section("Diff");
      const d = data.diffSummary;
      if (d.variablesAdded.length > 0) ui.text(`+ variables: ${d.variablesAdded.join(", ")}`);
      if (d.variablesRemoved.length > 0) ui.text(`- variables: ${d.variablesRemoved.join(", ")}`);
      if (d.variablesChanged.length > 0) ui.text(`~ variables: ${d.variablesChanged.join(", ")}`);
      if (d.httpAdded.length > 0) ui.text(`+ http: ${d.httpAdded.join(", ")}`);
      if (d.httpRemoved.length > 0) ui.text(`- http: ${d.httpRemoved.join(", ")}`);
      if (d.stylesChanged) ui.text(`~ styles changed`);
      if (!d.variablesAdded.length && !d.variablesRemoved.length && !d.variablesChanged.length && !d.httpAdded.length && !d.httpRemoved.length && !d.stylesChanged) {
        ui.text("(no scalar differences)");
      }
    }

    if (data.validation.issues.length > 0) {
      ui.section("Validator Issues");
      ui.table(
        ["Sev", "Code", "Message"],
        data.validation.issues.map((i) => [i.severity.toUpperCase(), i.code, i.message]),
      );
    }

    if (data.parseWarnings.length > 0) {
      ui.section("Parse Warnings");
      for (const w of data.parseWarnings) ui.text(`⚠ ${w}`);
    }

    if (data.validation.errorCount === 0) {
      ui.success("Preflight clean — save would be accepted.");
    } else {
      ui.text("");
      ui.text(`Preflight found ${data.validation.errorCount} error(s) — save would be blocked unless --force.`);
    }
  },
};

export default command;
