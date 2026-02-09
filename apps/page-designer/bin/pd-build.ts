import { CommandRegistry } from "../commands/registry";
import { runCli } from "@belzabar/core";

const helpResolver = async (cmd: string) => {
    return "Help not available in single-binary mode. Please refer to documentation.";
};

await runCli(process.argv, CommandRegistry, {
    name: "Page Designer CLI",
    description: "A Bun + TypeScript CLI for interacting with Page Designer APIs.",
    binaryName: "pd"
}, helpResolver);
