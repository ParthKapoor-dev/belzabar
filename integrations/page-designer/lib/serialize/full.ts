// Full-configuration serializer.
//
// A full save PUTs the whole stringified inner configuration. The HydratedPage
// already carries it: `rawConfiguration` is the parsed config (for an edited
// page, the overlay was applied to a clone of the raw config — see apply.ts).
// Nothing is rebuilt from the parsed variable / HTTP lists, so a full save of
// an unedited page is lossless (tests/unit/real-pages.test.ts).

import type { HydratedPage } from "../types/common";

export function serializeFull(page: HydratedPage): string {
  return JSON.stringify(page.rawConfiguration ?? {});
}
