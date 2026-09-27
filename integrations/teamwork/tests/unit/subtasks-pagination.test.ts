// TW-11 regression: subtasks were fetched with one pageSize=250 request, so a
// parent with more subtasks lost the rest. They now follow meta.page.hasMore.
import { describe, expect, test } from "bun:test";
import { fetchSubtasks } from "../../lib/api";

function page(ids: number[], hasMore: boolean) {
  return new Response(
    JSON.stringify({
      tasks: ids.map((id) => ({ id, name: `st${id}`, status: "new", assigneeUserIds: [1] })),
      meta: { page: { pageSize: 500, count: ids.length, hasMore } },
    }),
    { status: 200 },
  );
}

describe("fetchSubtasks pagination", () => {
  test("follows hasMore across pages, keeps the parent's subTaskIds order", async () => {
    const paths: string[] = [];
    const first = Array.from({ length: 500 }, (_, i) => i + 1);
    const pages = [() => page(first, true), () => page([501, 502], false)];
    const fetcher = async (path: string) => {
      paths.push(path);
      return pages[paths.length - 1]!();
    };

    const order = [502, ...first, 501];
    const subtasks = await fetchSubtasks(42, order, fetcher);

    expect(subtasks).toHaveLength(502);
    expect(subtasks.map((s) => s.id)).toEqual(order);
    expect(subtasks[0]).toEqual({
      id: 502, name: "st502", status: "new", priority: null, progress: 0, dueDate: null, assigneeCount: 1,
    });
    expect(paths).toHaveLength(2);
    paths.forEach((p, i) => {
      const q = new URL(p, "https://x").searchParams;
      expect(q.get("parentTaskId")).toBe("42");
      expect(q.get("page")).toBe(String(i + 1));
      expect(q.get("pageSize")).toBe("500");
    });
  });

  test("single page → one request", async () => {
    let calls = 0;
    const subtasks = await fetchSubtasks(1, [7], async () => {
      calls++;
      return page([7], false);
    });
    expect(calls).toBe(1);
    expect(subtasks.map((s) => s.id)).toEqual([7]);
  });

  test("an error on a later page throws (no silently truncated list)", async () => {
    let calls = 0;
    const fetcher = async () => (++calls === 1 ? page([1], true) : new Response("boom", { status: 500 }));
    await expect(fetchSubtasks(9, [1, 2], fetcher)).rejects.toMatchObject({ code: "TW_HTTP_500" });
  });
});
