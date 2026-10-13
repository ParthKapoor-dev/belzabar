import { writeFileSync } from "fs";
import { resolve } from "path";
import { CliError, type CommandModule, defineArgs, httpRequest, lifecycle, ok, sleep, str } from "@belzabar/core";
import { EXPORT_FORMATS, pollExport, requestExport } from "../../lib/api";
import { readReport, savedConfiguration } from "../../lib/definition";
import { parseReportId, REPORT_ID_POSITIONAL } from "../../lib/report-id";

type Format = keyof typeof EXPORT_FORMATS;

interface DownloadArgs {
  id: string;
  format: Format;
  out?: string;
  waitSec: number;
}

interface DownloadData {
  id: string;
  format: Format;
  requestId: string;
  /** The server emailed the file to the account instead (slow exports). */
  emailed: boolean;
  path: string | null;
  bytes: number | null;
}

export const args = defineArgs({
  command: "belz rd download",
  positionals: [REPORT_ID_POSITIONAL],
  flags: {
    format: { type: "enum", values: Object.keys(EXPORT_FORMATS) as Format[], default: "csv" },
    out: { type: "string", alias: ["-o"] },
    wait: { type: "number", integer: true, min: 10, max: 3600, default: 300 },
  },
});

/** A file name from the title: letters, digits, `-`, `_`, `.` only. */
function fileNameOf(title: string, format: Format): string {
  const base = title.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "report";
  return `${base}.${format}`;
}

const command: CommandModule<DownloadArgs, DownloadData> = {
  // Runs the datasource method on the server.
  writes: true,
  writesLocal: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { id: parseReportId(positionals.id), format: flags.format as Format, ...(flags.out ? { out: flags.out } : {}), waitSec: flags.wait };
  },
  async execute({ id, format, out, waitSec }, context) {
    const report = await readReport(id);
    const queued = await requestExport(id, savedConfiguration(report), format);
    const requestId = str(queued.requestId);
    if (!requestId) throw new CliError("The export was not queued (no requestId).", { code: "RD_BAD_RESPONSE", details: { id } });

    const pollMs = Math.min(15, Math.max(1, Number(queued.pollTimeInSeconds) || 5)) * 1000;
    const deadline = Date.now() + waitSec * 1000;
    const spin = lifecycle.spinner(`Exporting ${report.meta.title} as ${format}…`);
    spin.start(`Exporting ${report.meta.title} as ${format}…`);
    let fileUrl: string | undefined;
    let emailed = false;
    try {
      for (;;) {
        const status = await pollExport(requestId);
        fileUrl = str(status.fileURL) || undefined;
        emailed = String(status.isEmail) === "true";
        if (fileUrl || emailed) break;
        if (Date.now() + pollMs > deadline) {
          throw new CliError(`The export is still running after ${waitSec}s (request ${requestId}).`, {
            code: "RD_EXPORT_TIMEOUT",
            details: { id, requestId, waitSec },
          });
        }
        await sleep(pollMs);
      }
    } finally {
      spin.stop(fileUrl ? "Export ready" : emailed ? "Export emailed" : "Export not ready");
    }

    if (emailed && !fileUrl) {
      context.warn("The server emails slow exports to the account instead of returning a file.");
      return ok<DownloadData>({ id, format, requestId, emailed: true, path: null, bytes: null });
    }

    // A presigned storage URL: no platform auth header.
    const res = await httpRequest(fileUrl!, { method: "GET", timeoutMs: 0 });
    if (!res.ok) {
      throw new CliError(`Downloading the export failed: HTTP ${res.status}.`, { code: "RD_DOWNLOAD_FAILED", details: { id, requestId, status: res.status } });
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const path = resolve(out ?? fileNameOf(report.meta.title, format));
    try {
      writeFileSync(path, bytes);
    } catch (err) {
      throw new CliError(`Cannot write ${path}: ${(err as Error).message}`, { code: "RD_WRITE_FILE_FAILED", details: { path } });
    }
    return ok<DownloadData>({ id, format, requestId, emailed: false, path, bytes: bytes.length });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as DownloadData;
    if (d.path) ui.success(`Wrote ${d.path} (${d.bytes} bytes)`);
    else ui.info("The export was emailed to your account.");
  },
};

export default command;
