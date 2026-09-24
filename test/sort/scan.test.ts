import path from "node:path";
import { describe, expect, it } from "vitest";
import { rollHintFromRel, scanFolder } from "../../src/sort/scan.js";
import { tempDir, touch } from "./helpers.js";

describe("scanFolder", () => {
  it("finds videos recursively and skips junk, hidden, rejects, work dir and sorted dirs", async () => {
    const root = await tempDir();
    await touch(root, [
      "x.mp4",
      "sub/y.MOV",
      "notes.txt",
      ".hidden/z.mp4",
      "_rejects/r.mp4",
      ".footage-sort/c.mp4",
      "Topic A/a-roll/done.mp4",
      "Café “Shoot”/q.mov",
    ]);
    const files = await scanFolder(root, [path.join(root, "Topic A")]);
    expect(files.map((f) => f.rel)).toEqual(["Café “Shoot”/q.mov", "sub/y.MOV", "x.mp4"]);
    expect(files[2]!.path).toBe(path.join(root, "x.mp4"));
  });

  it("attaches roll hints from folder names", async () => {
    const root = await tempDir();
    await touch(root, ["A-Roll/clip.mp4", "broll/x.mp4", "day1/b_roll/cam/y.mp4", "plain/z.mp4"]);
    const hints = Object.fromEntries((await scanFolder(root, [])).map((f) => [f.rel, f.rollHint]));
    expect(hints).toEqual({
      "A-Roll/clip.mp4": "a-roll",
      "broll/x.mp4": "b-roll",
      "day1/b_roll/cam/y.mp4": "b-roll",
      "plain/z.mp4": null,
    });
  });
});

describe("rollHintFromRel", () => {
  it("uses the nearest roll folder", () => {
    expect(rollHintFromRel("a-roll/inserts/b roll/x.mp4")).toBe("b-roll");
    expect(rollHintFromRel("aroll.mp4")).toBeNull();
  });
});
