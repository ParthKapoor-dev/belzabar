// Top-level commands (`belz <cmd>`, plus the `config`/`extension` passthroughs) command registry.
//
// Hand-maintained and kept sorted. Every `commands/<name>/` folder must be listed here
// (enforced by cli/tests/registry.test.ts). help.txt / desc.txt are imported as text so
// the compiled binary embeds them.

import type { CommandRegistry } from "@belzabar/core";

import * as cacheCmd from "./cache/index";
import cacheHelp from "./cache/help.txt" with { type: "text" };
import cacheDesc from "./cache/desc.txt" with { type: "text" };
import * as configCmd from "./config/index";
import configHelp from "./config/help.txt" with { type: "text" };
import configDesc from "./config/desc.txt" with { type: "text" };
import * as envsCmd from "./envs/index";
import envsHelp from "./envs/help.txt" with { type: "text" };
import envsDesc from "./envs/desc.txt" with { type: "text" };
import * as extensionCmd from "./extension/index";
import extensionHelp from "./extension/help.txt" with { type: "text" };
import extensionDesc from "./extension/desc.txt" with { type: "text" };
import * as onboardCmd from "./onboard/index";
import onboardHelp from "./onboard/help.txt" with { type: "text" };
import onboardDesc from "./onboard/desc.txt" with { type: "text" };
import * as setupCmd from "./setup/index";
import setupHelp from "./setup/help.txt" with { type: "text" };
import setupDesc from "./setup/desc.txt" with { type: "text" };
import * as updateCmd from "./update/index";
import updateHelp from "./update/help.txt" with { type: "text" };
import updateDesc from "./update/desc.txt" with { type: "text" };

export const registry = {
  cache: { module: cacheCmd, help: cacheHelp, desc: cacheDesc },
  config: { module: configCmd, help: configHelp, desc: configDesc },
  envs: { module: envsCmd, help: envsHelp, desc: envsDesc },
  extension: { module: extensionCmd, help: extensionHelp, desc: extensionDesc },
  onboard: { module: onboardCmd, help: onboardHelp, desc: onboardDesc },
  setup: { module: setupCmd, help: setupHelp, desc: setupDesc },
  update: { module: updateCmd, help: updateHelp, desc: updateDesc },
} satisfies CommandRegistry;
