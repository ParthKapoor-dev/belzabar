import readline from "node:readline";

function renderOptions(options: Array<{ label: string }>, selectedIdx: number): void {
  for (let i = 0; i < options.length; i++) {
    const prefix = i === selectedIdx ? "  > " : "    ";
    process.stdout.write(`${prefix}${options[i].label}\n`);
  }
}

function clearOptionLines(count: number): void {
  for (let i = 0; i < count; i++) {
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
  }
}

export async function selectFromList<T>(
  title: string,
  options: Array<{ label: string; value: T }>,
  defaultIndex = 0
): Promise<T> {
  if (options.length === 0) {
    throw new Error("selectFromList: no options provided");
  }

  if (options.length === 1) {
    process.stdout.write(`${title} ${options[0].label}\n`);
    return options[0].value;
  }

  return new Promise((resolve) => {
    let idx = Math.max(0, Math.min(defaultIndex, options.length - 1));

    process.stdout.write(`${title}\n`);
    renderOptions(options, idx);

    const onData = (buf: Buffer): void => {
      const key = buf.toString();

      if (key === "\r" || key === "\n") {
        clearOptionLines(options.length);
        readline.moveCursor(process.stdout, 0, -1);
        readline.clearLine(process.stdout, 0);
        process.stdout.write(`${title} ${options[idx].label}\n`);
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(options[idx].value);
        return;
      }

      if (key === "\x1b[A") {
        clearOptionLines(options.length);
        idx = (idx - 1 + options.length) % options.length;
        renderOptions(options, idx);
        return;
      }

      if (key === "\x1b[B") {
        clearOptionLines(options.length);
        idx = (idx + 1) % options.length;
        renderOptions(options, idx);
        return;
      }

      if (key === "\x03") {
        process.stdout.write("\n");
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        process.exit(0);
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
