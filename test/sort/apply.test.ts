import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan, createdDirsAll, readManifest, undoLastRun } from "../../src/sort/apply.js";
import type { PlanItem } from "../../src/sort/types.js";
import { tempDir, touch } from "./helpers.js";

async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.name === ".footage-sort") continue;
      if (e.isDirectory()) await walk(full);
      else out[path.relative(root, full)] = await readFile(full, "utf8");
    }
  }
  await walk(root);
  return out;
}

async function dirs(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === ".footage-sort") continue;
      out.push(path.relative(root, path.join(dir, e.name)));
      await walk(path.join(dir, e.name));
    }
  }
  await walk(root);
  return out.sort();
}

const item = (root: string, from: string, to: string): PlanItem => ({
  id: from,
  from: path.join(root, from),
  to: path.join(root, to),
  topic: "T",
  roll: "b-roll",
  verdict: "keep",
  reasons: [],
  summary: "",
  durationSec: 1,
});

describe("applyPlan / undoLastRun", () => {
  it("round-trips a run exactly", async () => {
    const root = await tempDir();
    await touch(root, ["raw/a.mp4", "raw/b.mp4", "c.mp4"]);
    const before = await tree(root);
    const beforeDirs = await dirs(root);

    const { run, failures } = await applyPlan(root, [
      item(root, "raw/a.mp4", "Intro/a-roll/a.mp4"),
      item(root, "raw/b.mp4", "_rejects/Intro/b-roll/b.mp4"),
    ]);
    expect(failures).toEqual([]);
    expect(run.moves).toHaveLength(2);
    expect(await tree(root)).toEqual({
      "Intro/a-roll/a.mp4": "raw/a.mp4",
      "_rejects/Intro/b-roll/b.mp4": "raw/b.mp4",
      "c.mp4": "c.mp4",
    });
    expect(createdDirsAll(await readManifest(root)).map((d) => path.relative(root, d)).sort()).toEqual([
      "Intro", "Intro/a-roll", "_rejects", "_rejects/Intro", "_rejects/Intro/b-roll",
    ]);

    expect(await undoLastRun(root)).toEqual({ restored: 2, skipped: [] });
    expect(await tree(root)).toEqual(before);
    expect(await dirs(root)).toEqual(beforeDirs);
    expect((await readManifest(root)).runs).toEqual([]);
  });

  it("never overwrites: an occupied destination fails that item only", async () => {
    const root = await tempDir();
    await touch(root, ["a.mp4", "b.mp4", "T/b-roll/a.mp4"]);
    const { run, failures } = await applyPlan(root, [item(root, "a.mp4", "T/b-roll/a.mp4"), item(root, "b.mp4", "T/b-roll/b.mp4")]);
    expect(failures.map((f) => f.item.id)).toEqual(["a.mp4"]);
    expect(failures[0]!.error).toMatch(/exists/);
    expect(run.moves).toHaveLength(1);
    expect(await readFile(path.join(root, "T/b-roll/a.mp4"), "utf8")).toBe("T/b-roll/a.mp4");
    expect(await readFile(path.join(root, "a.mp4"), "utf8")).toBe("a.mp4");
  });

  it("records each move in the manifest as it happens", async () => {
    const root = await tempDir();
    await touch(root, ["a.mp4", "b.mp4"]);
    const seen: number[] = [];
    await applyPlan(root, [item(root, "a.mp4", "T/a.mp4"), item(root, "b.mp4", "T/b.mp4")], async () => {
      const m = await readManifest(root);
      seen.push(m.runs.at(-1)!.moves.length);
    });
    expect(seen).toEqual([1, 2]);
  });

  it("undoes a partial run and skips files that moved or whose source is occupied", async () => {
    const root = await tempDir();
    await touch(root, ["T/a.mp4", "T/b.mp4", "c.mp4", "T/c.mp4"]);
    await mkdir(path.join(root, ".footage-sort"), { recursive: true });
    const manifest = {
      runs: [{
        at: "2026-09-24T00:00:00Z",
        moves: [
          { from: path.join(root, "a.mp4"), to: path.join(root, "T/a.mp4") },
          { from: path.join(root, "gone.mp4"), to: path.join(root, "T/gone.mp4") },
          { from: path.join(root, "c.mp4"), to: path.join(root, "T/c.mp4") },
        ],
        createdDirs: [path.join(root, "T")],
      }],
    };
    await writeFile(path.join(root, ".footage-sort/manifest.json"), JSON.stringify(manifest));
    const res = await undoLastRun(root);
    expect(res.restored).toBe(1);
    expect(res.skipped).toHaveLength(2);
    expect(await readFile(path.join(root, "a.mp4"), "utf8")).toBe("T/a.mp4");
    // T still holds b.mp4 and c.mp4, so it is kept.
    expect(await dirs(root)).toEqual(["T"]);
  });

  it("removes created folders that only hold Finder's .DS_Store", async () => {
    const root = await tempDir();
    await touch(root, ["a.mp4"]);
    await applyPlan(root, [item(root, "a.mp4", "T/b-roll/a.mp4")]);
    await writeFile(path.join(root, "T/b-roll/.DS_Store"), "x");
    await writeFile(path.join(root, "T/.DS_Store"), "x");
    await undoLastRun(root);
    expect(await dirs(root)).toEqual([]);
  });

  it("does nothing when there is no run to undo", async () => {
    const root = await tempDir();
    expect(await undoLastRun(root)).toEqual({ restored: 0, skipped: [] });
  });

  it("undoes only the most recent run", async () => {
    const root = await tempDir();
    await touch(root, ["a.mp4", "b.mp4"]);
    await applyPlan(root, [item(root, "a.mp4", "T/a.mp4")]);
    await applyPlan(root, [item(root, "b.mp4", "U/b.mp4")]);
    await undoLastRun(root);
    expect(Object.keys(await tree(root)).sort()).toEqual(["T/a.mp4", "b.mp4"]);
    expect((await readManifest(root)).runs).toHaveLength(1);
  });
});
