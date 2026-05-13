import { mkdirSync, statSync } from "fs";
import { basename, dirname, extname, join } from "path";
import type { ArtifactWriteInput, ArtifactWriteResult } from "./types";

function resolveLayout(outPath: string): { dir: string; summaryPath: string; baseName: string } {
  let stats: ReturnType<typeof statSync> | null = null;
  try { stats = statSync(outPath); } catch { stats = null; }

  if (stats?.isDirectory()) {
    return { dir: outPath, summaryPath: join(outPath, "summary.json"), baseName: "summary" };
  }
  if (extname(outPath).toLowerCase() === ".json") {
    const dir = dirname(outPath);
    return { dir, summaryPath: outPath, baseName: basename(outPath, ".json") || "summary" };
  }
  return { dir: outPath, summaryPath: join(outPath, "summary.json"), baseName: "summary" };
}

export async function writeArtifacts(outPath: string, input: ArtifactWriteInput): Promise<ArtifactWriteResult> {
  const layout = resolveLayout(outPath);
  mkdirSync(layout.dir, { recursive: true });
  const consolePath = join(layout.dir, `${layout.baseName}.console.log`);
  await Bun.write(layout.summaryPath, JSON.stringify(input.summary, null, 2));
  await Bun.write(consolePath, input.consoleText);
  return { summaryPath: layout.summaryPath, consolePath };
}
