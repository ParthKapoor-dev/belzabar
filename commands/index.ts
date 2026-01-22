import * as envs from "./envs/index";
import * as fetchMethod from "./fetch-method/index";
import * as runMethod from "./run-method/index";
import * as runSuites from "./run-suites/index";
import * as saveSuite from "./save-suite/index";
import * as showMethod from "./show-method/index";
import * as testMethod from "./test-method/index";

export const CommandRegistry: Record<string, any> = {
  "envs": envs,
  "fetch-method": fetchMethod,
  "run-method": runMethod,
  "run-suites": runSuites,
  "save-suite": saveSuite,
  "show-method": showMethod,
  "test-method": testMethod,
};
