#!/usr/bin/env bun
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { runCli } from "@belzabar/core";

const commandsDir = join(import.meta.dir, "../commands");
const commandMap: Record<string, any> = {};

if (existsSync(commandsDir)) {
    const items = readdirSync(commandsDir, { withFileTypes: true });
    for (const item of items) {
        if (item.isDirectory() && !item.name.startsWith(".")) {
             try {
                 const modulePath = join(commandsDir, item.name, "index.ts");
                 if (existsSync(modulePath)) {
                    commandMap[item.name] = await import(modulePath);
                 }
             } catch (e) {
                 console.error(`Failed to load command ${item.name}:`, e);
             }
        }
    }
}

const helpResolver = async (cmd: string) => {
    const p = join(commandsDir, cmd, "help.txt");
    const file = Bun.file(p);
    if (await file.exists()) return await file.text();
    return null;
};

await runCli(process.argv, commandMap, {
    name: "Page Designer CLI",
    description: "A Bun + TypeScript CLI for interacting with Page Designer APIs.",
    binaryName: "pd"
}, helpResolver);
