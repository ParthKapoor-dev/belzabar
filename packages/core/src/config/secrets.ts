// One secret encode/decode helper for every stored password (CORE-11, TW-8, D5).
//
// Stored secrets carry an explicit encoding:
//   { password: "...", passwordEncoding: "plain" }   ← every new write (file is 0600)
//   { password: "..." }                              ← legacy entries: base64
// Decoding never guesses: "base64" is decoded strictly and a value that is not
// valid base64 is a CONFIG_INVALID error naming the config path.

import { CliError } from "../command";

export type SecretEncoding = "plain" | "base64";

export interface StoredSecret {
  password?: string;
  passwordEncoding?: SecretEncoding;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode a stored secret. `encoding` undefined means legacy base64.
 * `path` names the config location for error messages (e.g. "environments.sems-dev.password").
 */
export function decodeSecret(value: string | undefined | null, encoding: SecretEncoding | undefined, path: string): string {
  if (!value) return "";
  const enc = encoding ?? "base64";
  if (enc === "plain") return value;
  if (enc !== "base64") {
    throw new CliError(`Invalid config: ${path}Encoding must be "plain" or "base64" (got ${JSON.stringify(enc)}).`, {
      code: "CONFIG_INVALID",
      details: { path: `${path}Encoding` },
    });
  }
  const compact = value.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
    throw new CliError(
      `Invalid config: ${path} is not valid base64. Store it as plain text with "${lastSegment(path)}Encoding": "plain", or re-enter it with 'belz config edit'.`,
      { code: "CONFIG_INVALID", details: { path } },
    );
  }
  try {
    return atob(compact);
  } catch {
    throw new CliError(`Invalid config: ${path} is not valid base64.`, { code: "CONFIG_INVALID", details: { path } });
  }
}

function lastSegment(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1] ?? "password";
}

/** The fields to store for a newly entered plain-text password (D5: plain + explicit encoding, file 0600). */
export function encodeSecret(plain: string): { password: string; passwordEncoding: "plain" } {
  return { password: plain, passwordEncoding: "plain" };
}

/** Copy the stored secret fields (password + its encoding) from an existing entry, unchanged. */
export function keepSecret(entry: StoredSecret | undefined): StoredSecret {
  if (!entry?.password) return {};
  return entry.passwordEncoding ? { password: entry.password, passwordEncoding: entry.passwordEncoding } : { password: entry.password };
}
