// Teamwork (`belz tw`) command registry.
//
// Hand-maintained and kept sorted. Every `commands/<name>/` folder must be listed here
// (enforced by cli/tests/registry.test.ts). help.txt / desc.txt are imported as text so
// the compiled binary embeds them.

import type { CommandRegistry } from "@belzabar/core";

import * as addCommentCmd from "./commands/add-comment/index";
import addCommentHelp from "./commands/add-comment/help.txt" with { type: "text" };
import addCommentDesc from "./commands/add-comment/desc.txt" with { type: "text" };
import * as commentsCmd from "./commands/comments/index";
import commentsHelp from "./commands/comments/help.txt" with { type: "text" };
import commentsDesc from "./commands/comments/desc.txt" with { type: "text" };
import * as itemsCmd from "./commands/items/index";
import itemsHelp from "./commands/items/help.txt" with { type: "text" };
import itemsDesc from "./commands/items/desc.txt" with { type: "text" };
import * as searchCmd from "./commands/search/index";
import searchHelp from "./commands/search/help.txt" with { type: "text" };
import searchDesc from "./commands/search/desc.txt" with { type: "text" };
import * as taskCmd from "./commands/task/index";
import taskHelp from "./commands/task/help.txt" with { type: "text" };
import taskDesc from "./commands/task/desc.txt" with { type: "text" };

export const registry = {
  "add-comment": { module: addCommentCmd, help: addCommentHelp, desc: addCommentDesc },
  comments: { module: commentsCmd, help: commentsHelp, desc: commentsDesc },
  items: { module: itemsCmd, help: itemsHelp, desc: itemsDesc },
  search: { module: searchCmd, help: searchHelp, desc: searchDesc },
  task: { module: taskCmd, help: taskHelp, desc: taskDesc },
} satisfies CommandRegistry;
