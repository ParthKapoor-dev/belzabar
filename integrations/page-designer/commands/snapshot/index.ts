// belz pd snapshot <input> [--out <file>] | --compare <file>
//
// A normalized, stable, diff-friendly JSON of a page/component (see
// lib/snapshot.ts for the normalization) to keep as a test baseline, and a
// semantic comparison of such a baseline with the live page. Always reads the
// page fresh (a baseline check must not pass on a stale cache).
//   --out <file>      write the snapshot (data: bytes, sha256 — not the body)
//   (no flag)         return the snapshot in data.snapshot
//   --compare <file>  diff the stored snapshot → live; ok:false
//                     PD_SNAPSHOT_DIFFERS (exit 1, diff in data) on any change

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CliError, defineArgs, failWithData, ok, type CommandModule } from "@belzabar/core";
import { PD_INPUT_POSITIONAL } from "../../lib/args/common";
import { readJsonFile } from "../../lib/edit";
import { resolveInput } from "../../lib/resolver";
import { compareSnapshots, isSnapshot, serializeSnapshot, snapshotOf, type PageSnapshot, type SnapshotComparison } from "../../lib/snapshot";

interface SnapshotArgs {
  input: string;
  out: string | null;
  compare: string | null;
}

interface Source {
  id: string;
  name: string;
  entityType: "PAGE" | "COMPONENT";
  status: string | null;
  versionId: number | null;
}

interface SnapshotData {
  source: Source;
  /** Without --out / --compare. */
  snapshot?: PageSnapshot;
  /** With --out. */
  written?: { path: string; bytes: number; sha256: string };
  /** With --compare. */
  compare?: { file: string } & SnapshotComparison;
}

export const args = defineArgs({
  command: "belz pd snapshot",
  positionals: [PD_INPUT_POSITIONAL],
  flags: {
    out: { type: "string" },
    compare: { type: "string" },
  },
  exclusive: [["out", "compare"]],
});

const command: CommandModule<SnapshotArgs, SnapshotData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { input: positionals.input, out: flags.out ?? null, compare: flags.compare ?? null };
  },

  async execute({ input, out, compare }) {
    const resolved = await resolveInput(input, true);
    const raw = resolved.response;
    const live = snapshotOf(raw);
    const source: Source = {
      id: resolved.resolvedId,
      name: live.entity.name,
      entityType: resolved.entityType,
      status: typeof raw.status === "string" ? raw.status : null,
      versionId: typeof raw.versionId === "number" ? raw.versionId : null,
    };

    if (compare) {
      const stored = await readJsonFile(compare, "INVALID_SNAPSHOT", "Snapshot");
      if (!isSnapshot(stored)) {
        throw new CliError(`${compare} is not a belz pd snapshot (belzSnapshot: 1).`, { code: "INVALID_SNAPSHOT", details: { path: compare } });
      }
      const cmp = compareSnapshots(stored, live);
      const data: SnapshotData = { source, compare: { file: compare, ...cmp } };
      if (!cmp.identical) {
        return failWithData("PD_SNAPSHOT_DIFFERS", `${source.name} differs from the snapshot ${compare}.`, data);
      }
      return ok(data);
    }

    if (out) {
      const text = serializeSnapshot(live);
      const path = resolve(out);
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, "utf8");
      } catch (err) {
        throw new CliError(`Cannot write ${path}: ${String(err)}`, { code: "PD_FILE_UNWRITABLE", details: { path } });
      }
      return ok({
        source,
        written: { path, bytes: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text).digest("hex") },
      });
    }

    return ok({ source, snapshot: live });
  },

  presentHuman(envelope, ui) {
    const data = envelope.data as SnapshotData | undefined;
    if (!data) return;
    ui.kv("Entity", `${data.source.name} (${data.source.entityType}, ${data.source.id}, ${data.source.status ?? "?"} v${data.source.versionId ?? "?"})`);
    if (data.written) {
      ui.success(`Snapshot written: ${data.written.path} (${data.written.bytes} bytes, sha256 ${data.written.sha256.slice(0, 12)})`);
      return;
    }
    if (data.compare) {
      const c = data.compare;
      if (c.identical) {
        ui.success(`Identical to ${c.file}.`);
        return;
      }
      ui.section(`Differences from ${c.file}`);
      if (c.entityChanged.length) ui.text(`~ entity: ${c.entityChanged.join(", ")}`);
      for (const [k, v] of Object.entries(c.changes)) ui.text(`~ ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
      if (c.nodesMoved.length) ui.text(`~ nodes moved: ${c.nodesMoved.join(", ")}`);
      if (c.childrenReordered.length) ui.text(`~ children reordered under: ${c.childrenReordered.join(", ")}`);
      if (c.unclassified) ui.text("~ other differences (array order / unmodelled fields) — diff the files");
      return;
    }
    if (data.snapshot) ui.object(data.snapshot);
  },
};

export default command;
