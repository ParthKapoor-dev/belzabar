#!/usr/bin/env bun
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { runCli } from "../lib/runner";

// Dev Mode: Discover commands dynamically
const commandsDir = join(import.meta.dir, "../commands");
const commandMap: Record<string, any> = {};

if (existsSync(commandsDir)) {
    const items = readdirSync(commandsDir, { withFileTypes: true });
    for (const item of items) {
        if (item.isDirectory() && !item.name.startsWith(".")) {
             try {
                 // Dynamic import for dev
                 const modulePath = join(commandsDir, item.name, "index.ts");
                 // Use require or import
                 // Note: Await at top level is fine in Bun
                 commandMap[item.name] = require(modulePath); 
             } catch (e) {
                 // ignore invalid folders
             }
        }
    }
}

// Help resolver for dev mode (read from fs)
const helpResolver = async (cmd: string) => {
    const p = join(commandsDir, cmd, "help.txt");
    const file = Bun.file(p);
    if (await file.exists()) return await file.text();
    return null;
};

await runCli(process.argv, commandMap, helpResolver);