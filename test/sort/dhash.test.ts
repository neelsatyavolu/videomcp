import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dhashFile, hamming, nearDuplicatePairs } from "../../src/sort/dhash.js";
import { tempDir } from "./helpers.js";

describe("hamming", () => {
  it("counts differing bits of hex hashes", () => {
    expect(hamming("ffffffffffffffff", "0000000000000000")).toBe(64);
    expect(hamming("0f00000000000000", "0000000000000000")).toBe(4);
    expect(hamming("abc", "abc")).toBe(0);
  });
});

describe("nearDuplicatePairs", () => {
  it("pairs hashes within the threshold and ignores nulls", () => {
    const pairs = nearDuplicatePairs([
      { id: "a", dhash: "0000000000000000" },
      { id: "b", dhash: "0000000000000003" },
      { id: "c", dhash: "ffffffffffffffff" },
      { id: "d", dhash: null },
    ]);
    expect(pairs).toEqual([["a", "b"]]);
  });
});

describe("dhashFile", () => {
  it("hashes identical frames equally and different frames far apart", async () => {
    const dir = await tempDir();
    const a = path.join(dir, "a.jpg");
    const b = path.join(dir, "b.jpg");
    const c = path.join(dir, "c.jpg");
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240", "-frames:v", "1", a]);
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240", "-frames:v", "1", b]);
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "smptebars=s=320x240", "-frames:v", "1", c]);
    const [ha, hb, hc] = await Promise.all([dhashFile(a), dhashFile(b), dhashFile(c)]);
    expect(ha).toMatch(/^[0-9a-f]{16}$/);
    expect(ha).toBe(hb);
    expect(hamming(ha!, hc!)).toBeGreaterThan(10);
  });

  it("returns null for a missing file", async () => {
    expect(await dhashFile("/nonexistent/x.jpg")).toBeNull();
  });
});
