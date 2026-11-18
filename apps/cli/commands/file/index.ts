import { createHash } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import {
  apiFetch,
  CliError,
  Config,
  defineSubcommands,
  ok,
  readBodySummary,
  type CommandModule,
} from "@belzabar/core";

/**
 * `wi-impl file get <link>`: download a file a method generated (a
 * `…/file-preview?hash=<h>` or `…/rest/api/files/<h>` link) with wi-impl's
 * session. The file route needs a login token; the link a method returns
 * either has none or carries one an agent must not handle.
 */

export const FILE_PATH = (hash: string): string => `/rest/api/files/${encodeURIComponent(hash)}`;

/** Base64-ish file hash (the platform's link hashes are url-encoded base64). */
const HASH = /^[A-Za-z0-9+/=_-]{8,}$/;

export interface FileRef {
  hash: string;
  /** Origin of the link, when a URL was given. */
  origin?: string;
}

/**
 * The file hash from a `file-preview?hash=` link, a `/rest/api/files/<hash>`
 * link (any query, e.g. a token, is ignored) or a bare hash.
 */
export function parseFileRef(input: string): FileRef {
  const raw = input.trim();
  let hash: string | undefined;
  let origin: string | undefined;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new CliError("Not a valid URL.", { code: "FILE_REF_INVALID" });
    }
    origin = url.origin;
    const files = /\/rest\/api\/files\/([^/?#]+)/.exec(url.pathname)?.[1];
    hash = url.searchParams.get("hash") ?? (files ? decodeURIComponent(files) : undefined);
  } else {
    hash = /%[0-9A-Fa-f]{2}/.test(raw) ? decodeURIComponent(raw) : raw;
  }
  if (!hash || !HASH.test(hash)) {
    throw new CliError(
      "Expected a file link (…/file-preview?hash=<h> or …/rest/api/files/<h>) or a file hash.",
      { code: "FILE_REF_INVALID" },
    );
  }
  return { hash, ...(origin ? { origin } : {}) };
}

/** `filename` from a Content-Disposition header (RFC 5987 `filename*` first). */
export function dispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim());
    } catch {
      /* fall through */
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim();
}

interface GetArgs {
  subcommand: "get";
  ref: string;
  out: string;
  force: boolean;
}

interface FileGetData {
  action: "get";
  env: string;
  hash: string;
  /** Absolute path written. */
  path: string;
  bytes: number;
  contentType: string | null;
  /** Server-suggested filename (Content-Disposition), if any. */
  filename?: string;
  sha256: string;
}

export const args = defineSubcommands(
  {
    get: {
      positionals: [{ name: "link", required: true, missingCode: "FILE_REF_REQUIRED", missingMessage: "wi-impl file get needs a file link or hash." }],
      flags: {
        out: { type: "string", required: true, missingCode: "FILE_OUT_REQUIRED" },
        force: { type: "boolean" },
      },
    },
  },
  { command: "wi-impl file" },
);

const command: CommandModule<GetArgs, FileGetData> = {
  /** Reads the env; writes a local file only. */
  writesLocal: true,

  parseArgs(argv) {
    const parsed = args.parse(argv);
    return { subcommand: "get", ref: parsed.positionals.link, out: parsed.flags.out, force: parsed.flags.force };
  },

  async execute(a, context) {
    const ref = parseFileRef(a.ref);
    const envOrigin = new URL(Config.cleanBaseUrl).origin;
    if (ref.origin && ref.origin !== envOrigin) {
      const match = Object.values(Config.getAllEnvs()).find((e) => {
        try {
          return new URL(e.baseUrl).origin === ref.origin;
        } catch {
          return false;
        }
      });
      throw new CliError(
        `The link is on ${ref.origin}, but --env ${context.env.name} is ${envOrigin}.` +
          (match ? ` Pass --env ${match.name}.` : " No configured env has that host."),
        { code: "FILE_ENV_MISMATCH", details: { linkOrigin: ref.origin, env: context.env.name, matchingEnv: match?.name } },
      );
    }

    const path = resolve(a.out);
    if (existsSync(path) && !a.force) {
      throw new CliError(`${path} already exists. Pass --force to overwrite it.`, { code: "FILE_EXISTS", details: { path } });
    }

    const res = await apiFetch(FILE_PATH(ref.hash), { method: "GET", authMode: "Bearer", headers: { Accept: "*/*" } });
    if (!res.ok) {
      const body = await readBodySummary(res);
      throw new CliError(
        res.status === 404
          ? `No file with that hash on ${context.env.name} (HTTP 404).`
          : `Downloading the file failed on ${context.env.name} (HTTP ${res.status}).`,
        { code: res.status === 404 ? "FILE_NOT_FOUND" : "FILE_DOWNLOAD_FAILED", details: { status: res.status, body } },
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    const filename = dispositionFilename(res.headers.get("content-disposition"));
    return ok({
      action: "get",
      env: context.env.name,
      hash: ref.hash,
      path,
      bytes: bytes.byteLength,
      contentType: res.headers.get("content-type"),
      ...(filename ? { filename } : {}),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as FileGetData;
    ui.success(`Saved ${d.bytes} bytes to ${d.path}.`);
    ui.table(
      ["Property", "Value"],
      [
        ["Environment", d.env],
        ["Content type", d.contentType ?? ""],
        ["Server filename", d.filename ?? ""],
        ["SHA-256", d.sha256],
      ],
    );
  },
};

export default command;
