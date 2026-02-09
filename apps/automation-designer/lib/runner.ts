import { runCli as baseRunCli } from "@belzabar/core";

export async function runCli(argv: string[], commandMap: Record<string, any>, helpResolver?: (cmd: string) => Promise<string | null>) {
    return baseRunCli(argv, commandMap, {
        name: "Automation Designer CLI",
        description: "A Bun + TypeScript CLI for interacting with Automation Designer APIs.",
        binaryName: "belz"
    }, helpResolver);
}