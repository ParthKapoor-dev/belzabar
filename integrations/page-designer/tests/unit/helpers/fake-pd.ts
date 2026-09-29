// An in-memory PD server behind fakeFetch, for command-level tests of the
// write paths (save / publish / history / lock). Pages are stored as raw wire
// bodies; PUT replaces the configuration, or applies partial operations with
// the fake's OWN key parser (`applyWireOps`), written from docs/api-notes.md
// and deliberately independent of belz's serializer (OTH-R1: replaying with
// belz's own `replayOperations` made the partial-save tests circular). It only
// accepts the documented key shape — dot-joined identifiers with `[n]`
// indices — and answers 400 for anything else.
import { fakeFetch, withTempEnvConfig, type FakeFetch, type RecordedRequest, type TempEnvConfig } from "@belzabar/core/testing";
import type { RawConfiguration, RawPageResponse } from "../../../lib/types/wire";

export const ENV = "t-pd";
export const HOST = "https://t-pd.test";
const BASE = "/rest/api/pagedesigner";

export interface FakePd {
  pages: Map<string, RawPageResponse>;
  versions: Map<number, RawPageResponse>;
  ff: FakeFetch;
  cfg: TempEnvConfig;
  /** "METHOD path" of every request, query included (host stripped). */
  log(): string[];
  /** Hook run when a lock is acquired (simulate a concurrent editor). */
  onAcquire?: (id: string) => void;
  /** Status the lock-release endpoint answers with (default 200). */
  releaseStatus: number;
  /** Status the lock-acquire endpoint answers with (default 200; 409 = held by another session). */
  acquireStatus: number;
  /** Status the save PUT answers with (default 200). */
  saveStatus: number;
  /** Hook that may rewrite the stored inner config after a PUT (simulate a server that stores something else). */
  onSave?: (inner: Record<string, unknown>) => void;
  searchRows: Array<Record<string, unknown>>;
  /** Status the name search answers with (default 200). */
  searchStatus: number;
  /** GET /pages/page-dependencies?id=<pubId> → {dependencyJSON: deps[pubId]}. */
  deps: Record<string, Record<string, unknown>>;
  restore(): void;
}

export function page(
  id: string,
  inner: unknown,
  over: Partial<RawPageResponse> & Record<string, unknown> = {},
): RawPageResponse {
  return {
    id,
    name: `page-${id}`,
    status: "DRAFT",
    versionId: 1,
    relativeRoute: `r-${id}`,
    configuration: JSON.stringify(inner),
    ...over,
  };
}

export function innerOf(p: RawPageResponse): RawConfiguration {
  return JSON.parse(p.configuration ?? "{}") as RawConfiguration;
}

interface WireOp {
  key: string;
  value: string;
  operation: string;
  dataType: string;
}

/** The documented partial-update semantics (api-notes), independent of lib/serialize. */
export function applyWireOps(inner: unknown, ops: WireOp[]): unknown | null {
  const root = JSON.parse(JSON.stringify(inner ?? {})) as Record<string, unknown>;
  for (const op of ops) {
    const segs: Array<string | number> = [];
    for (const part of op.key.split(".")) {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)((?:\[\d+\])*)$/.exec(part);
      if (!m) return null; // undocumented key shape
      segs.push(m[1]!);
      for (const i of m[2]!.matchAll(/\[(\d+)\]/g)) segs.push(Number(i[1]));
    }
    let cur: unknown = root;
    for (const seg of segs.slice(0, -1)) {
      if (!cur || typeof cur !== "object") return null;
      cur = (cur as Record<string | number, unknown>)[seg];
    }
    if (!cur || typeof cur !== "object") return null;
    let value: unknown = op.value;
    if (op.dataType === "NUMBER") value = Number(op.value);
    else if (op.dataType === "BOOLEAN") value = op.value === "true";
    else if (op.dataType === "ARRAY" || op.dataType === "OBJECT") value = JSON.parse(op.value);
    (cur as Record<string | number, unknown>)[segs[segs.length - 1]!] = value;
  }
  return root;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function startFakePd(initial: RawPageResponse[] = []): FakePd {
  const pages = new Map(initial.map((p) => [p.id, p]));
  const versions = new Map<number, RawPageResponse>();
  const state: FakePd = {
    pages,
    versions,
    releaseStatus: 200,
    acquireStatus: 200,
    saveStatus: 200,
    searchRows: [],
    searchStatus: 200,
    deps: {},
    ff: null as unknown as FakeFetch,
    cfg: null as unknown as TempEnvConfig,
    log: () => state.ff.requests.map((r) => `${r.method} ${new URL(r.url).pathname.replace(BASE, "")}${new URL(r.url).search}`),
    restore() {
      state.ff.restore();
      state.cfg.restore();
    },
  };

  const handler = (req: RecordedRequest): Response => {
    const u = new URL(req.url);
    const path = u.pathname.replace(BASE, "");
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/pages\/lock\/(\w+)$/)) && req.method === "PUT") {
      if (u.searchParams.get("pageLockAction") === "ACQUIRED") {
        if (state.acquireStatus !== 200) return json({ message: "locked by someone" }, state.acquireStatus);
        state.onAcquire?.(m[1]!);
        return json({});
      }
      return json({}, state.releaseStatus);
    }
    if ((m = path.match(/^\/pages\/version\/(\d+)$/))) {
      const v = versions.get(Number(m[1]));
      return v ? json(v) : json({ message: "nope" }, 404);
    }
    if ((m = path.match(/^\/pages\/revert\/(\d+)$/)) && req.method === "PUT") {
      const v = versions.get(Number(m[1]));
      const owner = v && pages.get(v.id);
      if (!v || !owner) return json({}, 404);
      pages.set(owner.id, { ...owner, configuration: v.configuration, versionId: (owner.versionId ?? 0) + 1 });
      return json({});
    }
    if ((m = path.match(/^\/pages\/(\w+)\/publish$/)) && req.method === "POST") {
      const draft = pages.get(m[1]!);
      if (!draft) return json({}, 404);
      const pubId = typeof draft.referenceId === "string" ? draft.referenceId : `${draft.id}-pub`;
      const pub = { ...draft, id: pubId, status: "PUBLISHED" as const, referenceId: draft.id, versionId: 900 };
      pages.set(pubId, pub);
      return json(pub);
    }
    if (path === "/pages/history" && req.method === "GET") {
      const id = u.searchParams.get("pageId");
      return json(
        [...versions.values()]
          .filter((v) => v.id === id)
          .map((v) => ({ id: v.versionId, status: v.status, partialUpdate: false, updatedAt: 0, updatedBy: 1, userName: null })),
      );
    }
    if ((m = path.match(/^\/pages\/(\w+)$/))) {
      const p = pages.get(m[1]!);
      if (!p) return json({ message: "not found" }, 404);
      if (req.method === "GET") return json(p);
      if (req.method === "PUT") {
        if (state.saveStatus !== 200) return json({ message: "boom" }, state.saveStatus);
        const body = req.json();
        let config: string;
        if (body.partialUpdate) {
          const next = applyWireOps(innerOf(p), body.pageElementOperations);
          if (!next) return json({ message: "bad key" }, 400);
          config = JSON.stringify(next);
        } else {
          config = body.configuration;
        }
        if (state.onSave) {
          const inner = JSON.parse(config) as Record<string, unknown>;
          state.onSave(inner);
          config = JSON.stringify(inner);
        }
        const saved = { ...p, configuration: config, versionId: (p.versionId ?? 0) + 1 };
        pages.set(p.id, saved);
        return json({ versionId: saved.versionId });
      }
    }
    if (path === "/pages/page-dependencies") {
      const d = state.deps[u.searchParams.get("id") ?? ""];
      return d ? json({ dependencyJSON: d }) : json({ error: "not found" }, 404);
    }
    if (path === "/pages" && u.searchParams.has("pageType") && !u.searchParams.has("name")) {
      // The finder index lists: every stored page of that type (offset 0 only).
      if (u.searchParams.get("offset") !== "0") return json([]);
      const wantComponent = u.searchParams.get("pageType") === "COMPONENT";
      return json(
        [...pages.values()]
          .filter((p) => (p.isComponent === true) === wantComponent)
          .map(({ configuration: _c, ...row }) => row),
      );
    }
    if (path === "/pages" && u.searchParams.has("name")) {
      if (state.searchStatus !== 200) return new Response("<html><title>Server Error</title></html>", { status: state.searchStatus });
      return json(state.searchRows.filter((r) => r.name === u.searchParams.get("name")));
    }
    return json({ message: `unrouted ${req.method} ${path}` }, 404);
  };

  state.cfg = withTempEnvConfig({ envs: { [ENV]: { url: HOST } }, activeEnv: ENV });
  state.ff = fakeFetch([{ url: /.*/, response: handler }]).install();
  return state;
}

/** A minimal valid page inner config with one used variable. */
export function cleanInner(extra: Record<string, unknown> = {}) {
  return {
    __version: 5,
    layout: {
      id: "__root",
      name: "div",
      props: {},
      unSelectable: true,
      children: [{ id: "n1", name: "div", props: { "[innerHTML]": "{%greeting%}" } }],
    },
    styles: "",
    variables: {
      generated: [],
      userDefined: [
        { name: "greeting", type: "String", initialValue: "hi" },
        { name: "other", type: "String", initialValue: "o" },
      ],
      derived: [],
    },
    httpRequests: { generated: [], userDefined: [] },
    ...extra,
  };
}
