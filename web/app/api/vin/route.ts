export const runtime = "nodejs";

import { spawn } from "node:child_process";
import { homedir } from "node:os";

const VALID_ENVS = ["nsm-dev", "nsm-qa", "nsm-uat"] as const;
type Env = (typeof VALID_ENVS)[number];

function runBelz(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("belz", args, {
      env: {
        ...process.env,
        PATH: `${homedir()}/.local/bin:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
      },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `belz exited with code ${code}`));
      else resolve(stdout.trim());
    });
    proc.on("error", (err) => reject(err));
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { vin, env } = body as Record<string, unknown>;

  if (typeof vin !== "string" || !vin.trim()) {
    return Response.json({ error: "vin is required" }, { status: 400 });
  }

  // VINs are 17 alphanumeric chars (no I, O, Q) — strict allowlist to prevent SQL injection
  const safeVin = vin.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{1,20}$/.test(safeVin)) {
    return Response.json({ error: "Invalid VIN format" }, { status: 400 });
  }

  const safeEnv: Env = VALID_ENVS.includes(env as Env) ? (env as Env) : "nsm-dev";

  const query =
    `SELECT ap.id FROM application ap ` +
    `JOIN application_form_details afd ON afd.id = ap.application_form_id ` +
    `WHERE afd.vin = '${safeVin}';`;

  let raw: string;
  try {
    raw = await runBelz(["ad", "sql", "run", query, "--llm", "--env", safeEnv]);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "belz command failed" },
      { status: 500 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Failed to parse belz output", raw }, { status: 500 });
  }

  const result = parsed as {
    ok: boolean;
    data?: { rows?: Array<{ id: string }>; rowCount?: number };
    error?: unknown;
    meta?: { env: string; durationMs: number };
  };

  if (!result.ok) {
    return Response.json({ error: "Query failed", detail: result.error }, { status: 500 });
  }

  const rows = result.data?.rows ?? [];
  return Response.json({
    ids: rows.map((r) => r.id),
    rowCount: result.data?.rowCount ?? rows.length,
    env: result.meta?.env ?? safeEnv,
    durationMs: result.meta?.durationMs,
  });
}
