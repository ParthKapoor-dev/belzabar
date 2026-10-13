// Report Designer (`belz rd`) command registry.
//
// Hand-maintained and kept sorted. Every `commands/<name>/` folder must be listed here
// (enforced by apps/cli/tests/registry.test.ts). help.txt / desc.txt are imported as text so
// the compiled binary embeds them.

import type { CommandRegistry } from "@belzabar/core";

import * as datasourcesCmd from "./commands/datasources/index";
import datasourcesHelp from "./commands/datasources/help.txt" with { type: "text" };
import datasourcesDesc from "./commands/datasources/desc.txt" with { type: "text" };
import * as downloadCmd from "./commands/download/index";
import downloadHelp from "./commands/download/help.txt" with { type: "text" };
import downloadDesc from "./commands/download/desc.txt" with { type: "text" };
import * as exportCmd from "./commands/export/index";
import exportHelp from "./commands/export/help.txt" with { type: "text" };
import exportDesc from "./commands/export/desc.txt" with { type: "text" };
import * as findCmd from "./commands/find/index";
import findHelp from "./commands/find/help.txt" with { type: "text" };
import findDesc from "./commands/find/desc.txt" with { type: "text" };
import * as runCmd from "./commands/run/index";
import runHelp from "./commands/run/help.txt" with { type: "text" };
import runDesc from "./commands/run/desc.txt" with { type: "text" };
import * as showCmd from "./commands/show/index";
import showHelp from "./commands/show/help.txt" with { type: "text" };
import showDesc from "./commands/show/desc.txt" with { type: "text" };
import * as usesCmd from "./commands/uses/index";
import usesHelp from "./commands/uses/help.txt" with { type: "text" };
import usesDesc from "./commands/uses/desc.txt" with { type: "text" };

export const registry = {
  datasources: { module: datasourcesCmd, help: datasourcesHelp, desc: datasourcesDesc },
  download: { module: downloadCmd, help: downloadHelp, desc: downloadDesc },
  export: { module: exportCmd, help: exportHelp, desc: exportDesc },
  find: { module: findCmd, help: findHelp, desc: findDesc },
  run: { module: runCmd, help: runHelp, desc: runDesc },
  show: { module: showCmd, help: showHelp, desc: showDesc },
  uses: { module: usesCmd, help: usesHelp, desc: usesDesc },
} satisfies CommandRegistry;
