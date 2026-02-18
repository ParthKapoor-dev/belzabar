#!/usr/bin/env bun
import { spawn } from "bun";

// MCP Server Implementation for Belzabar CLI
// Maps MCP tools to CLI commands with --llm flag

const TOOLS = [
  {
    name: "ad.show_method",
    description: "Inspects an Automation Designer method definition. Returns inputs, services, and logic.",
    inputSchema: {
      type: "object",
      properties: {
        methodUuid: { type: "string", description: "UUID of the method" }
      },
      required: ["methodUuid"]
    }
  },
  {
    name: "ad.test_method",
    description: "Runs a draft method with inputs. Returns execution trace and failure details.",
    inputSchema: {
      type: "object",
      properties: {
        methodUuid: { type: "string", description: "UUID of the method" },
        inputFile: { type: "string", description: "Optional path to inputs.json" }
      },
      required: ["methodUuid"]
    }
  }
];

async function runCli(args: string[]): Promise<any> {
  const proc = spawn(["bun", "run", "bin/cli.ts", ...args, "--llm"], {
    stdout: "pipe",
    stderr: "pipe" // Capture stderr to avoid polluting MCP stream
  });

  const output = await new Response(proc.stdout).text();
  const error = await new Response(proc.stderr).text();
  
  if (proc.exitCode !== 0 && output.trim() === "") {
      // If failed and no JSON output, return error text
      throw new Error(`CLI Failed: ${error}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Fallback if non-JSON output (should be avoided by --llm, but safety first)
    return { raw: output, error: error };
  }

  if (parsed && parsed.ok === false) {
    const message = parsed.error?.message || "CLI command failed";
    const details = parsed.error?.details ? ` | Details: ${JSON.stringify(parsed.error.details)}` : "";
    throw new Error(`${message}${details}`);
  }

  return parsed;
}

// Minimal JSON-RPC handler
async function handleMessage(message: any) {
  if (message.jsonrpc !== "2.0") return;

  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "belzabar-ad-mcp", version: "1.0.0" }
      }
    };
  }

  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: TOOLS }
    };
  }

  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;

    try {
      let result;
      if (name === "ad.show_method") {
        result = await runCli(["show-method", args.methodUuid]);
      } else if (name === "ad.test_method") {
        const cliArgs = ["test-method", args.methodUuid];
        if (args.inputFile) {
          cliArgs.push("--inputs", args.inputFile);
        }
        result = await runCli(cliArgs);
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        }
      };
    } catch (e: any) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: e.message }
      };
    }
  }
  
  // Ack notifications
  if (!message.id) return; 
  
  return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" }
  };
}

// Stdio Loop
/* 
   Since Bun doesn't have a simple "readline" for stdin in a loop easily without node compat,
   we use a simple buffer reader or just standard Node streams.
   Bun fully implements node:process.
*/
import * as readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', async (line) => {
  try {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    const response = await handleMessage(msg);
    if (response) {
      console.log(JSON.stringify(response));
    }
  } catch (e) {
    // Ignore parse errors or log to stderr
    console.error("MCP Error:", e);
  }
});
