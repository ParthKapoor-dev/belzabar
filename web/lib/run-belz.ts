import { spawn } from "node:child_process"
import { homedir } from "node:os"

/** Thrown when the `belz` binary itself could not be launched (e.g. not installed). */
export class BelzSpawnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BelzSpawnError"
  }
}

/** Thrown when `belz` ran but exited non-zero (e.g. a CliError — input not found). */
export class BelzExitError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message)
    this.name = "BelzExitError"
  }
}

/**
 * Run the `belz` CLI with the given args and resolve its trimmed stdout.
 * Rejects with {@link BelzSpawnError} if the binary cannot be launched, or
 * {@link BelzExitError} if it exits non-zero. `~/.local/bin` is prepended to
 * PATH so the user-installed binary is found.
 */
export function runBelz(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("belz", args, {
      env: {
        ...process.env,
        PATH: `${homedir()}/.local/bin:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
      },
    })

    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString() })
    proc.on("close", (code) => {
      if (code !== 0) reject(new BelzExitError(stderr.trim() || `belz exited with code ${code}`, code))
      else resolve(stdout.trim())
    })
    proc.on("error", (err) => reject(new BelzSpawnError(err.message)))
  })
}
