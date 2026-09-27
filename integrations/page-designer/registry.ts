// Page Designer (`belz pd`) command registry.
//
// Hand-maintained and kept sorted. Every `commands/<name>/` folder must be listed here
// (enforced by apps/cli/tests/registry.test.ts). help.txt / desc.txt are imported as text so
// the compiled binary embeds them.

import type { CommandRegistry } from "@belzabar/core";

import * as analyzeCmd from "./commands/analyze/index";
import analyzeHelp from "./commands/analyze/help.txt" with { type: "text" };
import analyzeDesc from "./commands/analyze/desc.txt" with { type: "text" };
import * as diffCmd from "./commands/diff/index";
import diffHelp from "./commands/diff/help.txt" with { type: "text" };
import diffDesc from "./commands/diff/desc.txt" with { type: "text" };
import * as findCmd from "./commands/find/index";
import findHelp from "./commands/find/help.txt" with { type: "text" };
import findDesc from "./commands/find/desc.txt" with { type: "text" };
import * as findAdMethodsCmd from "./commands/find-ad-methods/index";
import findAdMethodsHelp from "./commands/find-ad-methods/help.txt" with { type: "text" };
import findAdMethodsDesc from "./commands/find-ad-methods/desc.txt" with { type: "text" };
import * as historyCmd from "./commands/history/index";
import historyHelp from "./commands/history/help.txt" with { type: "text" };
import historyDesc from "./commands/history/desc.txt" with { type: "text" };
import * as lockCmd from "./commands/lock/index";
import lockHelp from "./commands/lock/help.txt" with { type: "text" };
import lockDesc from "./commands/lock/desc.txt" with { type: "text" };
import * as pageDepsCmd from "./commands/page-deps/index";
import pageDepsHelp from "./commands/page-deps/help.txt" with { type: "text" };
import pageDepsDesc from "./commands/page-deps/desc.txt" with { type: "text" };
import * as preflightCmd from "./commands/preflight/index";
import preflightHelp from "./commands/preflight/help.txt" with { type: "text" };
import preflightDesc from "./commands/preflight/desc.txt" with { type: "text" };
import * as publishCmd from "./commands/publish/index";
import publishHelp from "./commands/publish/help.txt" with { type: "text" };
import publishDesc from "./commands/publish/desc.txt" with { type: "text" };
import * as saveCmd from "./commands/save/index";
import saveHelp from "./commands/save/help.txt" with { type: "text" };
import saveDesc from "./commands/save/desc.txt" with { type: "text" };
import * as showCmd from "./commands/show/index";
import showHelp from "./commands/show/help.txt" with { type: "text" };
import showDesc from "./commands/show/desc.txt" with { type: "text" };
import * as snapshotCmd from "./commands/snapshot/index";
import snapshotHelp from "./commands/snapshot/help.txt" with { type: "text" };
import snapshotDesc from "./commands/snapshot/desc.txt" with { type: "text" };
import * as translationsCmd from "./commands/translations/index";
import translationsHelp from "./commands/translations/help.txt" with { type: "text" };
import translationsDesc from "./commands/translations/desc.txt" with { type: "text" };
import * as validateCmd from "./commands/validate/index";
import validateHelp from "./commands/validate/help.txt" with { type: "text" };
import validateDesc from "./commands/validate/desc.txt" with { type: "text" };

export const registry = {
  analyze: { module: analyzeCmd, help: analyzeHelp, desc: analyzeDesc },
  diff: { module: diffCmd, help: diffHelp, desc: diffDesc },
  find: { module: findCmd, help: findHelp, desc: findDesc },
  "find-ad-methods": { module: findAdMethodsCmd, help: findAdMethodsHelp, desc: findAdMethodsDesc },
  history: { module: historyCmd, help: historyHelp, desc: historyDesc },
  lock: { module: lockCmd, help: lockHelp, desc: lockDesc },
  "page-deps": { module: pageDepsCmd, help: pageDepsHelp, desc: pageDepsDesc },
  preflight: { module: preflightCmd, help: preflightHelp, desc: preflightDesc },
  publish: { module: publishCmd, help: publishHelp, desc: publishDesc },
  save: { module: saveCmd, help: saveHelp, desc: saveDesc },
  show: { module: showCmd, help: showHelp, desc: showDesc },
  snapshot: { module: snapshotCmd, help: snapshotHelp, desc: snapshotDesc },
  translations: { module: translationsCmd, help: translationsHelp, desc: translationsDesc },
  validate: { module: validateCmd, help: validateHelp, desc: validateDesc },
} satisfies CommandRegistry;
