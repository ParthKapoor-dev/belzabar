// CORE-R8: onboard must not exit 0 when a step failed, and a Ctrl-C inside a
// step ends the flow instead of being recorded as a failure.
import { describe, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import { finishOnboard, runStep } from "../commands/onboard/index";

describe("belz onboard (CORE-R8)", () => {
  test("runStep records an ordinary failure", async () => {
    const step = await runStep("Credentials", async () => {
      throw new CliError("setup failed", { code: "SETUP_FAILED" });
    });
    expect(step).toEqual({ name: "Credentials", status: "failed", detail: "setup failed" });
  });

  test("runStep re-throws USER_ABORT (Ctrl-C)", async () => {
    const abort = new CliError("Aborted by user.", { code: "USER_ABORT", exitCode: 130 });
    await expect(runStep("Credentials", async () => { throw abort; })).rejects.toBe(abort);
  });

  test("a failed step makes the result ok:false (ONBOARD_INCOMPLETE) with the steps as data", () => {
    const res = finishOnboard([
      { name: "Credentials", status: "failed", detail: "boom" },
      { name: "Other step", status: "skipped" },
    ]);
    if (res.ok) throw new Error("expected a failure");
    expect(res.error.code).toBe("ONBOARD_INCOMPLETE");
    expect((res.data as { steps: unknown[] }).steps).toHaveLength(2);
  });

  test("all steps done or skipped → ok", () => {
    const res = finishOnboard([
      { name: "Credentials", status: "done" },
      { name: "Other step", status: "skipped" },
    ]);
    expect(res.ok).toBe(true);
  });
});
