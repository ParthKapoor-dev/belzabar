// Release promotion tracking (`belz release`) command registry.
//
// Hand-maintained and kept sorted. Every `commands/<name>/` folder must be listed here
// (enforced by cli/tests/registry.test.ts). help.txt / desc.txt are imported as text so
// the compiled binary embeds them.

import type { CommandRegistry } from "@belzabar/core";

import * as freezeCmd from "./commands/freeze/index";
import freezeHelp from "./commands/freeze/help.txt" with { type: "text" };
import freezeDesc from "./commands/freeze/desc.txt" with { type: "text" };
import * as matrixCmd from "./commands/matrix/index";
import matrixHelp from "./commands/matrix/help.txt" with { type: "text" };
import matrixDesc from "./commands/matrix/desc.txt" with { type: "text" };

export const registry = {
  freeze: { module: freezeCmd, help: freezeHelp, desc: freezeDesc },
  matrix: { module: matrixCmd, help: matrixHelp, desc: matrixDesc },
} satisfies CommandRegistry;
