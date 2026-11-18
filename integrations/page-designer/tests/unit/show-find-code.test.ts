// F2 (B44, B85, B119): an HTTP call's error variable, and `show --find` over
// variable code, request bodies, service-call ids and node event code — not
// just layout text. Over the real check_permission component.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import show from "../../commands/show/index";
import { errorVariables, findInCode, findNodes } from "../../lib/extract";
import { parsePage } from "../../lib/parser/index";
import { cleanInner, ENV, page, run, startFakePd, type FakePd } from "./helpers/fake-pd";
import { loadReal } from "./helpers/real";
import type { PageHttpRequest } from "../../lib/types/common";
import type { RawPageResponse } from "../../lib/types/wire";

const CHECK = "438fe77cffb8f165a3df9eb2a74cab05";
const real = parsePage(loadReal(CHECK));
const CALL_ID = real.httpRequests[0]!.callId!;

describe("errorVariables", () => {
  test("every handler.error target shape names its variable", () => {
    const call = (error: unknown[]) => ({ errorHandler: error }) as PageHttpRequest;
    expect(errorVariables(call(["{%a%}"]))).toEqual(["a"]);
    expect(errorVariables(call(["this.b", "pageContext.c"]))).toEqual(["b", "c"]);
    expect(errorVariables(call([["{%d%}", "get('$error')"]]))).toEqual(["d"]);
    expect(errorVariables(call([]))).toEqual([]);
  });

  test("the real component's call writes its error variable", () => {
    expect(errorVariables(real.httpRequests[0]!)).toEqual(["permissionsError"]);
  });
});

describe("findInCode", () => {
  test("a service-call id that --http lists is found (B119)", () => {
    expect(findNodes(real, CALL_ID)).toEqual([]);
    expect(findInCode(real, CALL_ID)).toContainEqual(
      expect.objectContaining({ where: "http", callId: CALL_ID, field: "meta.serviceCall.callId", text: CALL_ID }),
    );
  });

  test("derived variable code is searched, one match per line (B44, B85)", () => {
    const hits = findInCode(real, "download").filter((m) => m.where === "derived");
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h).toMatchObject({ name: "permissionOutput", field: "spec", line: expect.any(Number) });
      expect(h.text.toLowerCase()).toContain("download");
    }
  });

  test("request bodies, url and handlers are searched; no match → []", () => {
    const p = parsePage(
      page("a0000000000000000000000000000009", cleanInner({
        httpRequests: {
          generated: [],
          userDefined: [{
            meta: { serviceCall: { callId: "c1", label: "Load" } },
            request: { url: "/rest/api/automation/chain/execute/x1", method: "POST", body: '{"mode": "APP_EXISTS"}' },
            handler: { success: [["{%out%}", "get('$bodyJson')"]], error: ["{%loadError%}"] },
            trigger: [],
          }],
        },
      })),
    );
    expect(findInCode(p, "app_exists")).toEqual([{ where: "http", name: "#1 Load", callId: "c1", field: "request.body", text: '{"mode": "APP_EXISTS"}' }]);
    expect(findInCode(p, "loadError")[0]).toMatchObject({ field: "handler.error[0]" });
    expect(findInCode(p, "no-such-text-xyz")).toEqual([]);
  });

  test("a node's event handler code makes the node match", () => {
    const inner = cleanInner();
    (inner.layout.children[0] as Record<string, unknown>).events = { click: [["this.greeting", "(function(){ return 'APP_EXISTS'; })"]] };
    const p = parsePage(page("a0000000000000000000000000000008", inner));
    expect(findNodes(p, "app_exists").map((m) => m.id)).toEqual(["n1"]);
  });
});

describe("pd show over the fake server", () => {
  let pd: FakePd;
  beforeEach(() => {
    rmSync(join(BELZ_CONFIG_DIR, "cache", "pages", ENV), { recursive: true, force: true });
    pd = startFakePd([{ ...loadReal(CHECK), referenceId: null } as RawPageResponse]);
  });
  afterEach(() => pd.restore());

  test("--http rows carry errorOutputs; --var-graph marks the error writer", async () => {
    const data = (await run(show, [CHECK, "--http", "--var-graph", "--force"])).envelope!.data as any;
    expect(data.http[0]).toMatchObject({ callId: CALL_ID, errorOutputs: ["permissionsError"] });
    const entry = data.varGraph.find((v: { name: string }) => v.name === "permissionsError");
    expect(entry.writtenByHttp).toEqual([expect.objectContaining({ callIndex: 1, on: "error" })]);
  });

  test("--find total counts layout and code matches", async () => {
    const data = (await run(show, [CHECK, "--find", CALL_ID, "--force"])).envelope!.data as any;
    expect(data.find).toMatchObject({ total: 1, matches: [], code: [expect.objectContaining({ callId: CALL_ID })] });
  });
});
