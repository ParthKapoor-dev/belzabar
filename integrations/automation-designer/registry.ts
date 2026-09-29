// Automation Designer (`belz ad`) command registry.
//
// Hand-maintained and kept sorted. Every `commands/<name>/` folder must be listed here
// (enforced by apps/cli/tests/registry.test.ts). help.txt / desc.txt are imported as text so
// the compiled binary embeds them.

import type { CommandRegistry } from "@belzabar/core";

import * as callersCmd from "./commands/callers/index";
import callersHelp from "./commands/callers/help.txt" with { type: "text" };
import callersDesc from "./commands/callers/desc.txt" with { type: "text" };
import * as categoriesCmd from "./commands/categories/index";
import categoriesHelp from "./commands/categories/help.txt" with { type: "text" };
import categoriesDesc from "./commands/categories/desc.txt" with { type: "text" };
import * as categoryCmd from "./commands/category/index";
import categoryHelp from "./commands/category/help.txt" with { type: "text" };
import categoryDesc from "./commands/category/desc.txt" with { type: "text" };
import * as changelogCmd from "./commands/changelog/index";
import changelogHelp from "./commands/changelog/help.txt" with { type: "text" };
import changelogDesc from "./commands/changelog/desc.txt" with { type: "text" };
import * as childInfoCmd from "./commands/child-info/index";
import childInfoHelp from "./commands/child-info/help.txt" with { type: "text" };
import childInfoDesc from "./commands/child-info/desc.txt" with { type: "text" };
import * as createCmd from "./commands/create/index";
import createHelp from "./commands/create/help.txt" with { type: "text" };
import createDesc from "./commands/create/desc.txt" with { type: "text" };
import * as deleteCmd from "./commands/delete/index";
import deleteHelp from "./commands/delete/help.txt" with { type: "text" };
import deleteDesc from "./commands/delete/desc.txt" with { type: "text" };
import * as diffCmd from "./commands/diff/index";
import diffHelp from "./commands/diff/help.txt" with { type: "text" };
import diffDesc from "./commands/diff/desc.txt" with { type: "text" };
import * as exportCmd from "./commands/export/index";
import exportHelp from "./commands/export/help.txt" with { type: "text" };
import exportDesc from "./commands/export/desc.txt" with { type: "text" };
import * as exportCategoryCmd from "./commands/export-category/index";
import exportCategoryHelp from "./commands/export-category/help.txt" with { type: "text" };
import exportCategoryDesc from "./commands/export-category/desc.txt" with { type: "text" };
import * as fetchCmd from "./commands/fetch/index";
import fetchHelp from "./commands/fetch/help.txt" with { type: "text" };
import fetchDesc from "./commands/fetch/desc.txt" with { type: "text" };
import * as findCmd from "./commands/find/index";
import findHelp from "./commands/find/help.txt" with { type: "text" };
import findDesc from "./commands/find/desc.txt" with { type: "text" };
import * as historyCmd from "./commands/history/index";
import historyHelp from "./commands/history/help.txt" with { type: "text" };
import historyDesc from "./commands/history/desc.txt" with { type: "text" };
import * as importCmd from "./commands/import/index";
import importHelp from "./commands/import/help.txt" with { type: "text" };
import importDesc from "./commands/import/desc.txt" with { type: "text" };
import * as lintCmd from "./commands/lint/index";
import lintHelp from "./commands/lint/help.txt" with { type: "text" };
import lintDesc from "./commands/lint/desc.txt" with { type: "text" };
import * as outputsCmd from "./commands/outputs/index";
import outputsHelp from "./commands/outputs/help.txt" with { type: "text" };
import outputsDesc from "./commands/outputs/desc.txt" with { type: "text" };
import * as publishCmd from "./commands/publish/index";
import publishHelp from "./commands/publish/help.txt" with { type: "text" };
import publishDesc from "./commands/publish/desc.txt" with { type: "text" };
import * as runCmd from "./commands/run/index";
import runHelp from "./commands/run/help.txt" with { type: "text" };
import runDesc from "./commands/run/desc.txt" with { type: "text" };
import * as runSuitesCmd from "./commands/run-suites/index";
import runSuitesHelp from "./commands/run-suites/help.txt" with { type: "text" };
import runSuitesDesc from "./commands/run-suites/desc.txt" with { type: "text" };
import * as saveCmd from "./commands/save/index";
import saveHelp from "./commands/save/help.txt" with { type: "text" };
import saveDesc from "./commands/save/desc.txt" with { type: "text" };
import * as saveSuiteCmd from "./commands/save-suite/index";
import saveSuiteHelp from "./commands/save-suite/help.txt" with { type: "text" };
import saveSuiteDesc from "./commands/save-suite/desc.txt" with { type: "text" };
import * as servicesCmd from "./commands/services/index";
import servicesHelp from "./commands/services/help.txt" with { type: "text" };
import servicesDesc from "./commands/services/desc.txt" with { type: "text" };
import * as showCmd from "./commands/show/index";
import showHelp from "./commands/show/help.txt" with { type: "text" };
import showDesc from "./commands/show/desc.txt" with { type: "text" };
import * as showCodeCmd from "./commands/show-code/index";
import showCodeHelp from "./commands/show-code/help.txt" with { type: "text" };
import showCodeDesc from "./commands/show-code/desc.txt" with { type: "text" };
import * as sqlCmd from "./commands/sql/index";
import sqlHelp from "./commands/sql/help.txt" with { type: "text" };
import sqlDesc from "./commands/sql/desc.txt" with { type: "text" };
import * as stateCmd from "./commands/state/index";
import stateHelp from "./commands/state/help.txt" with { type: "text" };
import stateDesc from "./commands/state/desc.txt" with { type: "text" };
import * as testCmd from "./commands/test/index";
import testHelp from "./commands/test/help.txt" with { type: "text" };
import testDesc from "./commands/test/desc.txt" with { type: "text" };
import * as testCaseCmd from "./commands/test-case/index";
import testCaseHelp from "./commands/test-case/help.txt" with { type: "text" };
import testCaseDesc from "./commands/test-case/desc.txt" with { type: "text" };
import * as testCasesCmd from "./commands/test-cases/index";
import testCasesHelp from "./commands/test-cases/help.txt" with { type: "text" };
import testCasesDesc from "./commands/test-cases/desc.txt" with { type: "text" };
import * as testReportCmd from "./commands/test-report/index";
import testReportHelp from "./commands/test-report/help.txt" with { type: "text" };
import testReportDesc from "./commands/test-report/desc.txt" with { type: "text" };
import * as traceCmd from "./commands/trace/index";
import traceHelp from "./commands/trace/help.txt" with { type: "text" };
import traceDesc from "./commands/trace/desc.txt" with { type: "text" };
import * as validateCmd from "./commands/validate/index";
import validateHelp from "./commands/validate/help.txt" with { type: "text" };
import validateDesc from "./commands/validate/desc.txt" with { type: "text" };

export const registry = {
  callers: { module: callersCmd, help: callersHelp, desc: callersDesc },
  categories: { module: categoriesCmd, help: categoriesHelp, desc: categoriesDesc },
  category: { module: categoryCmd, help: categoryHelp, desc: categoryDesc },
  changelog: { module: changelogCmd, help: changelogHelp, desc: changelogDesc },
  "child-info": { module: childInfoCmd, help: childInfoHelp, desc: childInfoDesc },
  create: { module: createCmd, help: createHelp, desc: createDesc },
  delete: { module: deleteCmd, help: deleteHelp, desc: deleteDesc },
  diff: { module: diffCmd, help: diffHelp, desc: diffDesc },
  export: { module: exportCmd, help: exportHelp, desc: exportDesc },
  "export-category": { module: exportCategoryCmd, help: exportCategoryHelp, desc: exportCategoryDesc },
  fetch: { module: fetchCmd, help: fetchHelp, desc: fetchDesc },
  find: { module: findCmd, help: findHelp, desc: findDesc },
  history: { module: historyCmd, help: historyHelp, desc: historyDesc },
  import: { module: importCmd, help: importHelp, desc: importDesc },
  lint: { module: lintCmd, help: lintHelp, desc: lintDesc },
  outputs: { module: outputsCmd, help: outputsHelp, desc: outputsDesc },
  publish: { module: publishCmd, help: publishHelp, desc: publishDesc },
  run: { module: runCmd, help: runHelp, desc: runDesc },
  "run-suites": { module: runSuitesCmd, help: runSuitesHelp, desc: runSuitesDesc },
  save: { module: saveCmd, help: saveHelp, desc: saveDesc },
  "save-suite": { module: saveSuiteCmd, help: saveSuiteHelp, desc: saveSuiteDesc },
  services: { module: servicesCmd, help: servicesHelp, desc: servicesDesc },
  show: { module: showCmd, help: showHelp, desc: showDesc },
  "show-code": { module: showCodeCmd, help: showCodeHelp, desc: showCodeDesc },
  sql: { module: sqlCmd, help: sqlHelp, desc: sqlDesc },
  state: { module: stateCmd, help: stateHelp, desc: stateDesc },
  test: { module: testCmd, help: testHelp, desc: testDesc },
  "test-case": { module: testCaseCmd, help: testCaseHelp, desc: testCaseDesc },
  "test-cases": { module: testCasesCmd, help: testCasesHelp, desc: testCasesDesc },
  "test-report": { module: testReportCmd, help: testReportHelp, desc: testReportDesc },
  trace: { module: traceCmd, help: traceHelp, desc: traceDesc },
  validate: { module: validateCmd, help: validateHelp, desc: validateDesc },
} satisfies CommandRegistry;
