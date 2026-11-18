import { writeFileSync } from "fs";
import { resolve } from "path";
import { CliError, type CommandModule, defineArgs, httpRequest, isObj, lifecycle, ok, sleep, str } from "@belzabar/core";
import { EXPORT_FORMATS, pollExport, requestExport, runReport } from "../../lib/api";
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
  /** The file name the server gave the export (what the Report Designer screen downloads). */
  fileName: string | null;
}

export const args = defineArgs({
  command: "wi-impl rd download",
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

/** Export states after which polling cannot succeed. */
const FAILED_STATE = /FAIL|ERROR|CANCEL/i;

/** Common non-Latin-1 punctuation and its ASCII form. */
const ASCII_FORMS: Record<string, string> = {
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "−": "-",
  "‘": "'",
  "’": "'",
  "‚": "'",
  "“": "'",
  "”": "'",
  "„": "'",
  "…": "...",
};

const isLatin1 = (s: string) => [...s].every((c) => c.codePointAt(0)! <= 0xff);

/**
 * The export file name the server is asked for, in ISO-8859-1: the file store
 * rejects any other character in it ("Header value cannot be represented using
 * ISO-8859-1"). Dashes and quotes become their ASCII forms, accents are dropped
 * where that leaves a Latin-1 letter, anything else becomes `_`.
 */
function latin1FileName(name: string): string {
  return [...name]
    .map((ch) => {
      if (isLatin1(ch)) return ch;
      if (ASCII_FORMS[ch]) return ASCII_FORMS[ch];
      const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      return base && isLatin1(base) ? base : "_";
    })
    .join("");
}

/** The file name the server gave the export (the presigned URL's content disposition, else its path). */
function serverFileName(fileUrl: string): string | null {
  try {
    const url = new URL(fileUrl);
    const quoted = /filename="([^"]+)"/.exec(url.searchParams.get("response-content-disposition") ?? "")?.[1];
    return quoted ?? (decodeURIComponent(url.pathname.split("/").pop() ?? "") || null);
  } catch {
    return null;
  }
}

/** The file store's own error text (an XML `<Message>`, a JSON `errorMessage`, or the body's start). */
function storeError(body: string): string {
  const xml = /<Message>([^<]*)<\/Message>/.exec(body)?.[1];
  if (xml) return xml;
  try {
    const json = JSON.parse(body) as unknown;
    if (isObj(json) && typeof json.errorMessage === "string") return json.errorMessage;
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 200);
}

/**
 * Why an export failed, from a run of one row: report columns the datasource
 * did not return (empty while others have a value), or the run's own error.
 * Null when one row cannot tell.
 */
async function failureHint(id: string, configuration: string): Promise<{ hint: string; missingColumns: string[] } | null> {
  try {
    const run = await runReport(id, configuration, { offset: 0, limit: 1 });
    const columns = isObj(run.data) && Array.isArray(run.data.columns) ? run.data.columns.filter(isObj) : [];
    const size = (c: (typeof columns)[number]) => (Array.isArray(c.data) ? c.data.length : 0);
    if (!columns.some((c) => size(c) > 0)) return null;
    const missing = columns.filter((c) => size(c) === 0).map((c) => str(c.name) ?? String(c.id));
    if (missing.length === 0) return null;
    return {
      hint: `Report columns not returned by the datasource: ${missing.join(", ")} (remove them from the report, or return them from the method).`,
      missingColumns: missing,
    };
  } catch (err) {
    return err instanceof CliError ? { hint: `A one-row run fails too: ${err.message}`, missingColumns: [] } : null;
  }
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
    // The report's own download name (else its title), made safe for the file store.
    const configuration = JSON.stringify({
      ...(JSON.parse(savedConfiguration(report)) as object),
      downloadFilename: latin1FileName(report.spec.downloadFilename ?? report.meta.title),
    });
    const queued = await requestExport(id, configuration, format);
    const requestId = str(queued.requestId);
    if (!requestId) throw new CliError("The export was not queued (no requestId).", { code: "RD_BAD_RESPONSE", details: { id } });

    const pollMs = Math.min(15, Math.max(1, Number(queued.pollTimeInSeconds) || 5)) * 1000;
    const deadline = Date.now() + waitSec * 1000;
    const spin = lifecycle.spinner(`Exporting ${report.meta.title} as ${format}…`);
    spin.start(`Exporting ${report.meta.title} as ${format}…`);
    let fileUrl: string | undefined;
    let emailed = false;
    let state: string | null = null;
    try {
      for (;;) {
        const status = await pollExport(requestId);
        fileUrl = str(status.fileURL) || undefined;
        emailed = String(status.isEmail) === "true";
        state = str(status.status) || null;
        if (fileUrl || emailed || (state && FAILED_STATE.test(state))) break;
        if (Date.now() + pollMs > deadline) {
          throw new CliError(`The export is still running after ${waitSec}s (request ${requestId}, server state ${state ?? "unknown"}).`, {
            code: "RD_EXPORT_TIMEOUT",
            details: { id, requestId, waitSec, state },
          });
        }
        await sleep(pollMs);
      }
    } finally {
      spin.stop(fileUrl ? "Export ready" : emailed ? "Export emailed" : "Export not ready");
    }

    if (!fileUrl && !emailed) {
      const why = await failureHint(id, configuration);
      throw new CliError(`The export failed on the server (state ${state}, request ${requestId}).${why ? ` ${why.hint}` : ""}`, {
        code: "RD_EXPORT_FAILED",
        details: { id, requestId, state, missingColumns: why?.missingColumns ?? [] },
      });
    }

    if (emailed && !fileUrl) {
      context.warn("The server emails slow exports to the account instead of returning a file.");
      return ok<DownloadData>({ id, format, requestId, emailed: true, path: null, bytes: null, fileName: null });
    }

    // A presigned storage URL: no platform auth header.
    const fileName = serverFileName(fileUrl!);
    const res = await httpRequest(fileUrl!, { method: "GET", timeoutMs: 0 });
    if (!res.ok) {
      const reason = storeError(await res.text().catch(() => "")).replace(/\.+$/, "");
      throw new CliError(`Downloading the export failed: HTTP ${res.status}${reason ? `: ${reason}` : ""}.`, {
        code: "RD_DOWNLOAD_FAILED",
        details: { id, requestId, status: res.status, fileName, ...(reason ? { serverMessage: reason } : {}) },
      });
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const path = resolve(out ?? fileNameOf(report.meta.title, format));
    try {
      writeFileSync(path, bytes);
    } catch (err) {
      throw new CliError(`Cannot write ${path}: ${(err as Error).message}`, { code: "RD_WRITE_FILE_FAILED", details: { path } });
    }
    return ok<DownloadData>({ id, format, requestId, emailed: false, path, bytes: bytes.length, fileName });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as DownloadData;
    if (d.path) ui.success(`Wrote ${d.path} (${d.bytes} bytes)${d.fileName ? `; the server named it ${d.fileName}` : ""}`);
    else ui.info("The export was emailed to your account.");
  },
};

export default command;
