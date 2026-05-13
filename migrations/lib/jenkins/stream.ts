import { CliError } from "@belzabar/core";
import type { JenkinsAuth } from "./auth";
import { getBuild, getConsoleChunk } from "./client";
import { CONSOLE_POLL_INTERVAL_MS, DEFAULT_TIMEOUT_MS } from "../constants";

export interface StreamOptions {
  pollMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

export interface StreamResult {
  consoleText: string;
  result: "SUCCESS" | "FAILURE" | "UNSTABLE" | "ABORTED" | null;
  duration: number;
  buildUrl: string;
}

export async function streamConsole(
  auth: JenkinsAuth,
  buildNumber: number,
  options: StreamOptions = {}
): Promise<StreamResult> {
  const pollMs = options.pollMs ?? CONSOLE_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let offset = 0;
  let consoleText = "";

  while (true) {
    if (options.signal?.aborted) {
      throw new CliError("Stream aborted.", { code: "MIGRATE_ABORTED" });
    }
    if (Date.now() > deadline) {
      throw new CliError(`Timed out waiting for build #${buildNumber} to finish.`, {
        code: "MIGRATE_JENKINS_TIMEOUT",
      });
    }

    const chunk = await getConsoleChunk(auth, buildNumber, offset);
    if (chunk.text.length > 0) {
      consoleText += chunk.text;
      options.onChunk?.(chunk.text);
    }
    offset = chunk.nextOffset;

    if (chunk.hasMore) {
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    const build = await getBuild(auth, buildNumber);
    if (!build.building) {
      const tail = await getConsoleChunk(auth, buildNumber, offset);
      if (tail.text.length > 0) {
        consoleText += tail.text;
        options.onChunk?.(tail.text);
      }
      return {
        consoleText,
        result: build.result,
        duration: build.duration,
        buildUrl: build.url,
      };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
