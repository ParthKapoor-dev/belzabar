import { mkdirSync, statSync } from "fs";
import { basename, dirname, extname, join } from "path";
import type { ArtifactWriteInput, ArtifactWriteResult } from "./types";

function resolveOutputLayout(outPath: string): { dir: string; summaryPath: string; baseName: string } {
  let stats: ReturnType<typeof statSync> | null = null;
  try {
    stats = statSync(outPath);
  } catch {
    stats = null;
  }

  if (stats?.isDirectory()) {
    return {
      dir: outPath,
      summaryPath: join(outPath, "summary.json"),
      baseName: "summary",
    };
  }

  if (extname(outPath).toLowerCase() === ".json") {
    const dir = dirname(outPath);
    return {
      dir,
      summaryPath: outPath,
      baseName: basename(outPath, ".json") || "summary",
    };
  }

  return {
    dir: outPath,
    summaryPath: join(outPath, "summary.json"),
    baseName: "summary",
  };
}

export async function writeMigrationArtifacts(outPath: string, input: ArtifactWriteInput): Promise<ArtifactWriteResult> {
  const layout = resolveOutputLayout(outPath);
  mkdirSync(layout.dir, { recursive: true });

  const streamPath = join(layout.dir, `${layout.baseName}.stream.log`);

  await Bun.write(layout.summaryPath, JSON.stringify(input.summary, null, 2));
  await Bun.write(streamPath, input.outputText);

  let eventsPath: string | undefined;
  if (input.events && input.events.length > 0) {
    eventsPath = join(layout.dir, `${layout.baseName}.events.json`);
    await Bun.write(eventsPath, JSON.stringify(input.events, null, 2));
  }

  return {
    summaryPath: layout.summaryPath,
    streamPath,
    eventsPath,
  };
}
