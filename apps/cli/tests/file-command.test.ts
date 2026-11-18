// `wi-impl file get`: download a method-generated file with the session (I4).
// No network: fakeFetch serves the file route.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { errorCode, fakeFetch, type FakeFetch, respond, runCommand, type TempEnvConfig, withTempEnvConfig } from "@belzabar/core/testing";
import command, { dispositionFilename, parseFileRef } from "../commands/file/index";

const HASH = "cR7JOfzfY41M7j4W+2+dOA==";
const ENCODED = "cR7JOfzfY41M7j4W%2B2%2BdOA%3D%3D";

describe("file refs", () => {
  test("a file-preview link, a files link (its token ignored) and a bare hash give the same hash", () => {
    expect(parseFileRef(`https://acme-dev.test/file-preview?hash=${ENCODED}`)).toEqual({ hash: HASH, origin: "https://acme-dev.test" });
    expect(parseFileRef(`https://acme-dev.test/rest/api/files/${ENCODED}?token=secret`)).toEqual({ hash: HASH, origin: "https://acme-dev.test" });
    expect(parseFileRef(HASH)).toEqual({ hash: HASH });
    expect(parseFileRef(ENCODED)).toEqual({ hash: HASH });
  });

  test("anything else is FILE_REF_INVALID", () => {
    for (const bad of ["https://acme-dev.test/page", "a b", "x"]) expect(errorCode(() => parseFileRef(bad))).toBe("FILE_REF_INVALID");
  });

  test("Content-Disposition filename", () => {
    expect(dispositionFilename('attachment; filename="report.xlsx"')).toBe("report.xlsx");
    expect(dispositionFilename("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe("résumé.pdf");
    expect(dispositionFilename(null)).toBeUndefined();
  });
});

describe("wi-impl file get", () => {
  let cfg: TempEnvConfig | null = null;
  let ff: FakeFetch | null = null;
  let dir = "";
  afterEach(() => {
    ff?.restore();
    ff = null;
    cfg?.restore();
    cfg = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function setup(status = 200) {
    dir = mkdtempSync(join(tmpdir(), "wi-file-"));
    cfg = withTempEnvConfig({ envs: { "acme-dev": { url: "https://acme-dev.test" }, "acme-qa": { url: "https://acme-qa.test" } }, activeEnv: "acme-dev" });
    ff = fakeFetch([
      {
        method: "GET",
        url: `https://acme-dev.test/rest/api/files/${ENCODED}`,
        response: status === 200
          ? new Response(new Uint8Array([80, 75, 3, 4]), { status: 200, headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="x.xlsx"' } })
          : respond({ status, text: "nope" }),
      },
    ]).install();
  }

  test("downloads with the session and writes --out", async () => {
    setup();
    const out = join(dir, "sub", "x.xlsx");
    const r = await runCommand(command, ["--env", "acme-dev", "get", `https://acme-dev.test/file-preview?hash=${ENCODED}`, "--out", out]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ hash: HASH, path: out, bytes: 4, filename: "x.xlsx", contentType: "application/octet-stream" });
    expect([...readFileSync(out)]).toEqual([80, 75, 3, 4]);
    expect(ff!.requests[0]!.headers.authorization).toBe("Bearer test-token");
  });

  test("a link of another env's host is FILE_ENV_MISMATCH naming that env; nothing is fetched", async () => {
    setup();
    const r = await runCommand(command, ["--env", "acme-dev", "get", `https://acme-qa.test/file-preview?hash=${ENCODED}`, "--out", join(dir, "x")]);
    expect(r.envelope?.error?.code).toBe("FILE_ENV_MISMATCH");
    expect(r.envelope?.error?.message).toContain("Pass --env acme-qa");
    expect(ff!.requests).toHaveLength(0);
  });

  test("an existing --out needs --force; 404 is FILE_NOT_FOUND", async () => {
    setup(404);
    const out = join(dir, "x.xlsx");
    writeFileSync(out, "old");
    expect((await runCommand(command, ["--env", "acme-dev", "get", HASH, "--out", out])).envelope?.error?.code).toBe("FILE_EXISTS");
    expect((await runCommand(command, ["--env", "acme-dev", "get", HASH, "--out", out, "--force"])).envelope?.error?.code).toBe("FILE_NOT_FOUND");
    expect(readFileSync(out, "utf8")).toBe("old");
    expect(existsSync(out)).toBe(true);
  });
});
