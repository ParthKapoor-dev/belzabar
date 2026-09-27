// Migrations (`belz migrate`) command registry.
//
// Hand-maintained and kept sorted. Every `commands/<name>/` folder must be listed here
// (enforced by cli/tests/registry.test.ts). help.txt / desc.txt are imported as text so
// the compiled binary embeds them.

import type { CommandRegistry } from "@belzabar/core";

import * as logsCmd from "./commands/logs/index";
import logsHelp from "./commands/logs/help.txt" with { type: "text" };
import logsDesc from "./commands/logs/desc.txt" with { type: "text" };
import * as profilesCmd from "./commands/profiles/index";
import profilesHelp from "./commands/profiles/help.txt" with { type: "text" };
import profilesDesc from "./commands/profiles/desc.txt" with { type: "text" };
import * as runCmd from "./commands/run/index";
import runHelp from "./commands/run/help.txt" with { type: "text" };
import runDesc from "./commands/run/desc.txt" with { type: "text" };
import * as statusCmd from "./commands/status/index";
import statusHelp from "./commands/status/help.txt" with { type: "text" };
import statusDesc from "./commands/status/desc.txt" with { type: "text" };

export const registry = {
  logs: { module: logsCmd, help: logsHelp, desc: logsDesc },
  profiles: { module: profilesCmd, help: profilesHelp, desc: profilesDesc },
  run: { module: runCmd, help: runHelp, desc: runDesc },
  status: { module: statusCmd, help: statusHelp, desc: statusDesc },
} satisfies CommandRegistry;
