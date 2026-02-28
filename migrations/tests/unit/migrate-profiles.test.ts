import { describe, expect, test } from "bun:test";
import { discoverNsmProfiles, extractProfilesFromText } from "../../lib/migration/profiles";

describe("migrate profiles", () => {
  test("extracts NSM profiles from text blobs", () => {
    const text = `foo devncdns_qancdns bar qancdns_uatncdns qancdns_uatncdns`;
    const profiles = extractProfilesFromText(text);
    expect(profiles).toEqual(["devncdns_qancdns", "qancdns_uatncdns"]);
  });

  test("discovers profiles from live html/script content", async () => {
    const html = `
      <html>
        <head>
          <script src="/assets/main.js"></script>
        </head>
      </html>
    `;

    const script = `const values = ["devncdns_qancdns", "qancdns_uatncdns", "stgncdns_stg2ncdns"];`;

    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("index.html")) {
        return new Response(html, { status: 200 });
      }
      if (url.includes("main.js")) {
        return new Response(script, { status: 200 });
      }
      return new Response("", { status: 404 });
    };

    const result = await discoverNsmProfiles({ refresh: true, fetchFn });
    expect(result.source).toBe("live");
    expect(result.profiles).toEqual(["devncdns_qancdns", "qancdns_uatncdns", "stgncdns_stg2ncdns"]);
  });
});
