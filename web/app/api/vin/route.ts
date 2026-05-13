export const runtime = "nodejs";

import { spawn } from "node:child_process";
import { homedir } from "node:os";

const VALID_ENVS = ["nsm-dev", "nsm-qa", "nsm-uat", "nsm-stage"] as const;
type Env = (typeof VALID_ENVS)[number];

// VINs are 17 alphanumeric chars (no I, O, Q) — strict allowlist prevents SQL injection.
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
// Application IDs in NSM are 32 hex (no dashes).
const APP_ID_PATTERN = /^[a-f0-9]{32}$/i;

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

type Direction = "vin" | "appId";

function buildQuery(direction: Direction, value: string): string {
  if (direction === "vin") {
    // VIN → application IDs
    return (
      `SELECT ap.id ` +
      `FROM application ap ` +
      `JOIN application_form_details afd ON afd.id = ap.application_form_id ` +
      `WHERE afd.vin = '${value}';`
    );
  }
  // application ID → VINs (a single application can have multiple form versions)
  return (
    `SELECT DISTINCT afd.vin ` +
    `FROM application_form_details afd ` +
    `JOIN application ap ON ap.application_form_id = afd.id ` +
    `WHERE ap.id = '${value}' AND afd.vin IS NOT NULL;`
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { vin, applicationId, input, env } = body as Record<string, unknown>;

  // Accept three input shapes:
  //   { vin, env }                — forward (vin → application ids)
  //   { applicationId, env }      — reverse (application id → vins)
  //   { input, env }              — auto-detect by pattern
  let direction: Direction;
  let raw: string;
  if (typeof vin === "string" && vin.trim()) {
    direction = "vin";
    raw = vin.trim().toUpperCase();
  } else if (typeof applicationId === "string" && applicationId.trim()) {
    direction = "appId";
    raw = applicationId.trim();
  } else if (typeof input === "string" && input.trim()) {
    const candidate = input.trim();
    if (VIN_PATTERN.test(candidate.toUpperCase())) {
      direction = "vin";
      raw = candidate.toUpperCase();
    } else if (APP_ID_PATTERN.test(candidate)) {
      direction = "appId";
      raw = candidate.toLowerCase();
    } else {
      return Response.json(
        { error: "Input must be a 17-char VIN or a 32-hex application id." },
        { status: 400 },
      );
    }
  } else {
    return Response.json(
      { error: "Provide one of: vin, applicationId, or input." },
      { status: 400 },
    );
  }

  // Final format check on the resolved value, regardless of which input shape was used.
  if (direction === "vin" && !VIN_PATTERN.test(raw)) {
    return Response.json({ error: "Invalid VIN format" }, { status: 400 });
  }
  if (direction === "appId" && !APP_ID_PATTERN.test(raw)) {
    return Response.json({ error: "Invalid application id format" }, { status: 400 });
  }

  const safeEnv: Env = VALID_ENVS.includes(env as Env) ? (env as Env) : "nsm-dev";
  const query = buildQuery(direction, raw);

  let belzOut: string;
  try {
    belzOut = await runBelz(["ad", "sql", "run", query, "--llm", "--env", safeEnv]);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "belz command failed" },
      { status: 500 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(belzOut);
  } catch {
    return Response.json({ error: "Failed to parse belz output", raw: belzOut }, { status: 500 });
  }

  const result = parsed as {
    ok: boolean;
    data?: { rows?: Array<Record<string, string>>; rowCount?: number };
    error?: unknown;
    meta?: { env: string; durationMs: number };
  };

  if (!result.ok) {
    return Response.json({ error: "Query failed", detail: result.error }, { status: 500 });
  }

  const rows = result.data?.rows ?? [];
  const values =
    direction === "vin"
      ? rows.map((r) => r.id).filter(Boolean)
      : rows.map((r) => r.vin).filter(Boolean);

  return Response.json({
    direction,
    // Keep `ids` for backwards compatibility with callers that only do
    // forward (VIN → application id) lookups.
    ids: direction === "vin" ? values : [],
    values,
    rowCount: result.data?.rowCount ?? rows.length,
    env: result.meta?.env ?? safeEnv,
    durationMs: result.meta?.durationMs,
  });
}
