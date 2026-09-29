// Regression: the V2 parser read `repeatStepExecution.enabled/source`, which
// the real wire never carries (it is `{type, value, counter, executeParallel,
// numberOfConcurrentThread}`), so every V2 loop parsed as "no loop".
import { describe, expect, test } from "bun:test";
import { readdirSync } from "fs";
import { parseV1Method } from "../../lib/parser/v1";
import { parseV2Method } from "../../lib/parser/v2";
import { parseV2Loop } from "../../lib/parser/steps/v2";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

const FIX = `${import.meta.dir}/../fixtures`;
const LOOP_UUID = "486041dfd02d9fd45a27b608ad2dce0c"; // steps 4 and 5 loop over #{enabledFeatures}

describe("V2 loops (real wire)", () => {
  test("steps 4/5 of a real body parse as loops with type, source and parallelism", async () => {
    const m = parseV2Method((await Bun.file(`${FIX}/real-v2/${LOOP_UUID}.v2.json`).json()) as V2MethodResponse);
    const loops = m.parsedSteps.filter((s) => s.repeatStepExecution);
    expect(loops.map((s) => s.orderIndex)).toEqual([4, 5]);
    expect(loops[0]).toMatchObject({
      repeatStepExecution: true,
      loopExecutionSource: "#{enabledFeatures}",
      loopConfiguration: { type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", executeParallel: false },
    });
    for (const s of m.parsedSteps.filter((s) => ![4, 5].includes(s.orderIndex))) expect(s.repeatStepExecution).toBeUndefined();
  });

  test("V1 and V2 parses agree on every loop across all real bodies", async () => {
    const files = readdirSync(`${FIX}/real-v2`).filter((f) => f.endsWith(".v2.json"));
    let loopCount = 0;
    for (const f of files) {
      const uuid = f.replace(".v2.json", "");
      const v2 = parseV2Method((await Bun.file(`${FIX}/real-v2/${f}`).json()) as V2MethodResponse);
      const v1 = parseV1Method((await Bun.file(`${FIX}/real-v1/${uuid}.v1.json`).json()) as V1RawMethodResponse);
      // A V1 step can keep `repeatStepExecution: true` with no source/config
      // (4ada8d56… step 1); the V2 wire has no loop there — a loop needs a source.
      const isLoop = (s: (typeof v1)["parsedSteps"][number]) => !!s.repeatStepExecution && !!s.loopExecutionSource;
      const view = (m: typeof v1) =>
        m.parsedSteps.map((s) => [s.orderIndex, isLoop(s), isLoop(s) ? s.loopExecutionSource : null, isLoop(s) ? s.loopConfiguration?.type : null]);
      expect(view(v2)).toEqual(view(v1));
      loopCount += v2.parsedSteps.filter((s) => s.repeatStepExecution).length;
    }
    expect(loopCount).toBe(9);
  });
});

describe("parseV2Loop shapes", () => {
  test("absent / null / all-null → no loop", () => {
    expect(parseV2Loop(undefined)).toEqual({});
    expect(parseV2Loop(null)).toEqual({});
    expect(parseV2Loop({ type: null, value: null, counter: null, executeParallel: null })).toEqual({});
  });
  test("counter, threads and range", () => {
    expect(parseV2Loop({ type: "LOOP_EXECUTION_ON_NUMBER", value: "3", counter: "#{i}", executeParallel: true, numberOfConcurrentThread: 4 })).toEqual({
      repeatStepExecution: true,
      loopExecutionSource: "3",
      loopConfiguration: { type: "LOOP_EXECUTION_ON_NUMBER", counter: "#{i}", executeParallel: true, numberOfConcurrentThread: 4 },
    });
    expect(parseV2Loop({ type: "LOOP_EXECUTION_ON_RANGE", rangeStartInclusive: 0, rangeEndExclusive: "#{n}" }).loopExecutionSource).toBe("0..#{n}");
  });
  test("older {enabled, source} shape still works", () => {
    expect(parseV2Loop({ enabled: true, source: "#{xs}" })).toEqual({ repeatStepExecution: true, loopExecutionSource: "#{xs}", loopConfiguration: {} });
    expect(parseV2Loop({ enabled: false })).toEqual({ repeatStepExecution: false });
  });
});
