import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  measureClip,
  parseDeshakeLog,
  parseMetadataFile,
  parseStderr,
} from "../../src/sort/metrics.js";
import { tempDir } from "./helpers.js";

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("parseMetadataFile", () => {
  it("takes the median of finite blur values and shares of dark/blown frames", () => {
    const m = parseMetadataFile(fixture("meta.txt"));
    expect(m.blur).toBeCloseTo(4.884, 2);
    expect(m.yavg).toBeCloseTo((125.311 + 125.232 + 126.905 + 128.58 + 16 * 4) / 8, 2);
    expect(m.darkShare).toBe(0.5);
    expect(m.blownShare).toBe(0);
  });

  it("returns nulls and zeros for empty input", () => {
    expect(parseMetadataFile("")).toEqual({ blur: null, yavg: null, darkShare: 0, blownShare: 0 });
  });
});

describe("parseDeshakeLog", () => {
  it("returns RMS of the final x/y correction divided by width", () => {
    expect(parseDeshakeLog(fixture("deshake.log"), 640)).toBeCloseTo(0.020986, 5);
  });

  it("returns null without data rows", () => {
    expect(parseDeshakeLog("Ori x, Avg x, Fin x\n", 640)).toBeNull();
    expect(parseDeshakeLog("", 640)).toBeNull();
  });
});

describe("parseStderr", () => {
  it("reads volume, silence, black and open-ended freeze shares", () => {
    const s = parseStderr(fixture("stderr.txt"), 4);
    expect(s.maxVolumeDb).toBeCloseTo(-16.1, 5);
    expect(s.silentShare).toBeCloseTo(0.5, 5);
    // black_end 3.5 is the last 2fps sample of a clip that stays black to 4s
    expect(s.blackShare).toBeCloseTo(0.5, 5);
    expect(s.frozenShare).toBeCloseTo(0.5, 5);
  });

  it("counts an unterminated silence to the end and tolerates no audio lines", () => {
    const s = parseStderr("[silencedetect @ 0x1] silence_start: 1.5\n", 4);
    expect(s.silentShare).toBeCloseTo(2.5 / 4, 5);
    expect(s.maxVolumeDb).toBeNull();
    expect(parseStderr("", 4)).toEqual({ maxVolumeDb: null, silentShare: 0, blackShare: 0, frozenShare: 0 });
  });

  it("does not extend intervals that end well before the clip does", () => {
    expect(parseStderr("black_start:0 black_end:1 black_duration:1\n", 4).blackShare).toBeCloseTo(0.25, 5);
  });

  it("clamps shares to [0, 1]", () => {
    const s = parseStderr("black_start:0 black_end:9 black_duration:9\n", 4);
    expect(s.blackShare).toBe(1);
  });
});

describe.skipIf(!hasFfmpeg())("measureClip", () => {
  it("distinguishes a black clip from a normal one", async () => {
    const dir = await tempDir();
    const normal = path.join(dir, "normal.mp4");
    const black = path.join(dir, "black.mp4");
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-pix_fmt", "yuv420p", normal]);
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=320x240:r=30:d=2", "-pix_fmt", "yuv420p", black]);
    const n = await measureClip(normal, { durationSec: 2, hasAudio: true });
    const b = await measureClip(black, { durationSec: 2, hasAudio: false });
    expect(n.blackShare).toBeLessThan(0.1);
    expect(n.maxVolumeDb).not.toBeNull();
    expect(b.blackShare).toBeGreaterThanOrEqual(0.8);
    expect(b.maxVolumeDb).toBeNull();
    expect(b.darkShare).toBe(1);
  });
});
