// Read the value at a save-pipeline key path (`layout.children[1].props.x`).
import { parsePath } from "../../../lib/serialize/paths";

export function getPathForTest(root: unknown, key: string): unknown {
  let cur: unknown = root;
  for (const seg of parsePath(key)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}
