// Test-only harness: drives runNamespacedCli with fake commands. Spawned by runner.test.ts.
import { runNamespacedCli } from "../../src/runner";
import { ok } from "../../src/command";

const size = Number(process.env.HARNESS_BYTES ?? 300_000);

const big = {
  schema: "harness.big",
  parseArgs: (a: string[]) => a,
  async execute() {
    // A pending timer + network-ish await mimic real commands; the exit must not cut output.
    setTimeout(() => {}, 10_000);
    await new Promise(r => setTimeout(r, 5));
    return ok({ payload: "x".repeat(size), tail: "END" });
  },
  presentHuman(envelope: any, ui: any) {
    ui.text(envelope.data.payload);
    ui.text(envelope.data.tail);
  },
};

const secret = {
  schema: "harness.secret",
  parseArgs: (a: string[]) => a,
  async execute(args: string[]) {
    return ok({ token: "SECRET-TOKEN-VALUE", args });
  },
};

await runNamespacedCli(["bun", "harness", ...process.argv.slice(2)], {
  name: "harness",
  description: "harness",
  binaryName: "harness",
  namespaces: {
    mod: {
      name: "Mod",
      description: "passthrough module",
      command: secret,
      helpResolver: async () => "HARNESS HELP TEXT",
    },
  },
  topLevel: { big, secret },
  topLevelHelpResolver: async () => "HARNESS HELP TEXT",
});
