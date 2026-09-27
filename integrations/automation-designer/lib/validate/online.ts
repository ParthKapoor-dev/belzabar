// L4 — online checks (service contract lookup, optional dry-run compile).
import type { FindingInput } from "./types";

export interface OnlineOptions {
  env: string;
  dryRunCompile: boolean;
}

export async function runOnline(_body: unknown, _opts: OnlineOptions): Promise<{ findings: FindingInput[]; layers: string[] }> {
  return { findings: [], layers: [] };
}
