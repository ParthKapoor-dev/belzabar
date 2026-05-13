import { spawn } from "child_process";
import { CliError } from "./command";

interface OpenCommand {
  command: string;
  args: string[];
}

function getUrlOpenCommand(url: string): OpenCommand {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

function runCommand(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new CliError(
            `Cannot open URL automatically because '${command}' is not installed.`,
            { code: "OPEN_COMMAND_NOT_FOUND" }
          )
        );
        return;
      }
      reject(error);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      resolve({ code, stderr: stderr.trim() });
    });
  });
}

/**
 * Open a URL in the user's default browser. Cross-platform: macOS `open`,
 * Windows `cmd /c start`, Linux/WSL `xdg-open`.
 */
export async function openUrlInBrowser(url: string): Promise<void> {
  const candidate = getUrlOpenCommand(url);
  const result = await runCommand(candidate.command, candidate.args);
  if (result.code !== 0) {
    throw new CliError(
      `Failed to open browser URL: ${result.stderr || `exit code ${String(result.code)}`}`,
      { code: "OPEN_FAILED" }
    );
  }
}
