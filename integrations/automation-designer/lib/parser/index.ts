// Parser façade. Commands never pick a version here — they pass the version
// resolved by lib/args/common.ts through to this function.

import type { ApiVersion } from "../api-version";
import type { HydratedMethod } from "../types/common";
import type { V1RawMethodResponse } from "../types/v1-wire";
import type { V2MethodResponse } from "../types/v2-wire";
import { parseV1Method } from "./v1";
import { parseV2Method } from "./v2";

export { parseV1Method, parseV2Method };

export function parseMethod(raw: unknown, version: ApiVersion): HydratedMethod {
  if (version === "v2") {
    return parseV2Method(raw as V2MethodResponse);
  }
  return parseV1Method(raw as V1RawMethodResponse);
}
