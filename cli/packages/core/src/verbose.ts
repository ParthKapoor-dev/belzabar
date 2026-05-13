const START = Date.now();

export function verboseEnabled(): boolean {
  return process.env.BELZ_VERBOSE === "1";
}

function ts(): string {
  return `[+${Date.now() - START}ms]`;
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return "";
  try {
    return " " + JSON.stringify(meta);
  } catch {
    return "";
  }
}

export function vlog(message: string, meta?: Record<string, unknown>): void {
  if (!verboseEnabled()) return;
  process.stderr.write(`${ts()} ${message}${formatMeta(meta)}\n`);
}

export function vtime(label: string): () => void {
  if (!verboseEnabled()) return () => {};
  const startedAt = Date.now();
  process.stderr.write(`${ts()} ${label} start\n`);
  return () => {
    const took = Date.now() - startedAt;
    process.stderr.write(`${ts()} ${label} done (took ${took}ms)\n`);
  };
}
