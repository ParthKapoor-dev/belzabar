// Teamwork ignores `limit` and caps at 50/page, so comments
// must be paginated with pageSize + page until meta.page.hasMore is false.
import { describe, expect, test } from "bun:test";
import { fetchComments } from "../../lib/api";

function pageResponse(ids: number[], hasMore: boolean, users: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      comments: ids.map((id) => ({ id, body: `c${id}`, postedByUserId: id % 2 ? 1 : 2, postedDateTime: "t" })),
      included: { users },
      meta: { page: { pageSize: 500, count: ids.length, hasMore } },
    }),
    { status: 200 },
  );
}

describe("fetchComments pagination", () => {
  test("follows hasMore across 3 pages, uses pageSize (not limit), keeps order and merges users", async () => {
    const paths: string[] = [];
    const pages = [
      () => pageResponse([1, 2], true, { "1": { firstName: "A", lastName: "One" } }),
      () => pageResponse([3, 4], true, { "2": { firstName: "B", lastName: "Two" } }),
      () => pageResponse([5], false, {}),
    ];
    const fetcher = async (path: string) => {
      paths.push(path);
      return pages[paths.length - 1]!();
    };

    const comments = await fetchComments(42, fetcher);

    expect(comments.map((c) => c.id)).toEqual([1, 2, 3, 4, 5]);
    expect(comments[1]!.postedByName).toBe("B Two"); // user from a later page
    expect(comments[4]!.postedByName).toBe("A One");
    expect(paths).toHaveLength(3);
    paths.forEach((p, i) => {
      const q = new URL(p, "https://x").searchParams;
      expect(q.get("page")).toBe(String(i + 1));
      expect(q.get("pageSize")).toBe("500");
      expect(q.has("limit")).toBe(false);
    });
  });

  test("single page with hasMore=false makes one request", async () => {
    let calls = 0;
    const comments = await fetchComments(1, async () => {
      calls++;
      return pageResponse([7], false, {});
    });
    expect(calls).toBe(1);
    expect(comments[0]!.postedByName).toBe("User#1");
  });

  test("HTTP error on a later page throws (no silently truncated list)", async () => {
    let calls = 0;
    const fetcher = async () => (++calls === 1 ? pageResponse([1], true, {}) : new Response("boom", { status: 500 }));
    await expect(fetchComments(9, fetcher)).rejects.toThrow(/500/);
  });
});
