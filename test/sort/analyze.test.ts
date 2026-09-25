import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeClip, loadJudgement, saveJudgement, transcriptSegments } from "../../src/sort/analyze.js";
import type { Judgement } from "../../src/sort/types.js";
import { tempDir } from "./helpers.js";

async function silentClip(dir: string): Promise<string> {
  const file = path.join(dir, "clip.mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=2", "-pix_fmt", "yuv420p", file]);
  return file;
}

describe("analyzeClip", () => {
  it("analyzes a silent clip as B-roll with frames, metrics and a hash, then serves it from cache", async () => {
    const dir = await tempDir();
    const cacheDir = path.join(dir, ".footage-sort", "cache");
    const file = { path: await silentClip(dir), rel: "clip.mp4", rollHint: null };

    const a = await analyzeClip(file, "c01", cacheDir, true);
    expect(a).toMatchObject({ id: "c01", hasVideo: true, hasAudio: false, roll: "b-roll", width: 320 });
    expect(a.durationSec).toBeCloseTo(2, 0);
    expect(a.framePaths.length).toBeGreaterThan(0);
    expect(a.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.metrics.blackShare).toBe(0);

    // Tamper with the cache entry to prove the second call reads it.
    const [entry] = (await readdir(cacheDir)).filter((f) => f.endsWith(".analysis.json"));
    const cached = JSON.parse(await readFile(path.join(cacheDir, entry!), "utf8"));
    await writeFile(path.join(cacheDir, entry!), JSON.stringify({ ...cached, width: 12345 }));
    expect((await analyzeClip(file, "c07", cacheDir, true)).width).toBe(12345);
    expect((await analyzeClip(file, "c07", cacheDir, true)).id).toBe("c07");

    // useCache=false recomputes.
    expect((await analyzeClip(file, "c07", cacheDir, false)).width).toBe(320);
  });

  it("recomputes when cached keyframes were deleted", async () => {
    const dir = await tempDir();
    const cacheDir = path.join(dir, "cache");
    const file = { path: await silentClip(dir), rel: "clip.mp4", rollHint: null };
    const a = await analyzeClip(file, "c01", cacheDir, true);
    await Promise.all(a.framePaths.map((p) => rm(p, { force: true })));
    const b = await analyzeClip(file, "c01", cacheDir, true);
    expect(b.framePaths.length).toBeGreaterThan(0);
    await expect(readFile(b.framePaths[0]!)).resolves.toBeTruthy();
  });

  it("analyzes an audio-only file without frames or video metrics", async () => {
    const dir = await tempDir();
    const audioOnly = path.join(dir, "voice.mp4");
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=d=2", "-c:a", "aac", audioOnly]);
    const a = await analyzeClip({ path: audioOnly, rel: "voice.mp4", rollHint: null }, "c01", path.join(dir, "cache"), false);
    expect(a).toMatchObject({ hasVideo: false, hasAudio: true, framePaths: [], dhash: null });
  });

  it("honours a folder roll hint", async () => {
    const dir = await tempDir();
    const file = { path: await silentClip(dir), rel: "a-roll/clip.mp4", rollHint: "a-roll" as const };
    expect((await analyzeClip(file, "c01", path.join(dir, "cache"), false)).roll).toBe("a-roll");
  });
});

describe("transcriptSegments", () => {
  const seg = { start: 0, end: 1, text: "hi" };

  it("returns segments, or none for clips without audio or with silent audio", () => {
    expect(transcriptSegments(true, { segments: [seg] }, [])).toEqual([seg]);
    expect(transcriptSegments(true, { segments: [] }, [])).toEqual([]);
    expect(transcriptSegments(false, null, [])).toEqual([]);
  });

  it("fails when a clip has audio but transcription produced nothing, instead of calling it silent", () => {
    expect(() => transcriptSegments(true, null, ["whisper.cpp not found"])).toThrow(/transcri.*whisper\.cpp not found/i);
  });
});

describe("judgement cache", () => {
  it("round-trips per clip and agent", async () => {
    const dir = await tempDir();
    const cacheDir = path.join(dir, "cache");
    const file = { path: await silentClip(dir), rel: "clip.mp4", rollHint: null };
    const j: Judgement = { summary: "s", tags: [], verdict: "keep", issues: [], reason: "r", spokenLine: null };
    expect(await loadJudgement(cacheDir, file, "claude")).toBeNull();
    await saveJudgement(cacheDir, file, "claude", j);
    expect(await loadJudgement(cacheDir, file, "claude")).toEqual(j);
    expect(await loadJudgement(cacheDir, file, "grok")).toBeNull();
    expect(await loadJudgement(cacheDir, file, "claude:haiku")).toBeNull();
  });
});
