import { CommandRegistry } from "../commands/registry";
import { runCli } from "../lib/runner";

// Prod Mode: Use generated registry
// Help text is not bundled in this simple version, but could be added to registry if needed.
// For now, we assume help might be missing or user relies on online docs in prod binary.

const helpResolver = async (cmd: string) => {
    // In a compiled binary, we can't easily read help.txt unless we bundle it.
    // Return null or generic message.
    return "Help not available in single-binary mode. Please refer to documentation.";
};

await runCli(process.argv, CommandRegistry, helpResolver);
