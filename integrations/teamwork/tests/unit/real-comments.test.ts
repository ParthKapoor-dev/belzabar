// fetchComments against real (sanitized) Teamwork captures. Task 25085246 was
// captured with pageSize=2 so its 4 comments span 2 pages (meta.page.hasMore).
// Fixtures: tests/fixtures/real/ (see manifest.json).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { fetchComments } from "../../lib/api";

const FIX = `${import.meta.dir}/../fixtures/real`;
const read = (f: string) => readFileSync(`${FIX}/${f}`, "utf8");

describe("real Teamwork comment pages", () => {
  test("follows hasMore across the 2 captured pages, oldest first, names resolved from included users", async () => {
    const pages = [read("task-25085246-comments-p1.json"), read("task-25085246-comments-p2.json")];
    const raw = pages.map((p) => JSON.parse(p));
    expect(raw[0].meta.page.hasMore).toBe(true);
    expect(raw[1].meta.page.hasMore).toBe(false);

    const paths: string[] = [];
    const comments = await fetchComments(25085246, async (path) => {
      paths.push(path);
      return new Response(pages[paths.length - 1]!, { status: 200 });
    });

    expect(paths.length).toBe(2);
    const expectedIds = raw.flatMap((r) => r.comments.map((c: any) => c.id));
    expect(comments.map((c) => c.id)).toEqual(expectedIds);
    expect(comments.length).toBe(raw[0].meta.page.count);
    for (const c of comments) {
      expect(c.postedByName).not.toMatch(/^User#/);
      expect(typeof c.body).toBe("string");
    }
    const times = comments.map((c) => Date.parse(c.postedDateTime));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  test("single-page task (25807610): hasMore false stops after one request", async () => {
    const page = read("task-25807610-comments-p1.json");
    let calls = 0;
    const comments = await fetchComments(25807610, async () => {
      calls++;
      return new Response(page, { status: 200 });
    });
    expect(calls).toBe(1);
    expect(comments.length).toBe(JSON.parse(page).comments.length);
  });

  test("task records carry the fields `tw task` reads", () => {
    for (const f of ["task-25085246.json", "task-25807610.json"]) {
      const t = JSON.parse(read(f));
      expect(typeof t.task.id).toBe("number");
      expect(typeof t.task.name).toBe("string");
      expect(t.included.users).toBeDefined();
    }
  });
});
