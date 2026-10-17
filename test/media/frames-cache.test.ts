import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORK_DIR } from "../../src/constants.js";
import { extractFrameAt } from "../../src/media/frames.js";
import { transcribeVideo } from "../../src/media/transcribe.js";
import { cacheKeyForPath } from "../../src/utils/paths.js";
import { tempDir } from "../sort/helpers.js";

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function colorClip(out: string, color: string): void {
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=160x120:d=1`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${color === "black" ? 440 : 880}:duration=1`,
    "-shortest",
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
}

describe("media cache identity", () => {
  it("extracts a new frame after the video at the same path is replaced", async () => {
    const dir = await tempDir();
    const black = path.join(dir, "black.mp4");
    const white = path.join(dir, "white.mp4");
    const clip = path.join(dir, "clip.mp4");
    colorClip(black, "black");
    colorClip(white, "white");
    await copyFile(black, clip);

    const first = await extractFrameAt(clip, 0);
    const firstHash = sha(await readFile(first.path));
    await copyFile(white, clip);
    const later = new Date(Date.now() + 5_000);
    await utimes(clip, later, later);

    const second = await extractFrameAt(clip, 0);
    expect(second.path).not.toBe(first.path);
    expect(sha(await readFile(second.path))).not.toBe(firstHash);
  });

  it("does not reuse a partial wav or a wav from the previous file contents", async () => {
    const dir = await tempDir();
    const clip = path.join(dir, "clip.mp4");
    colorClip(clip, "black");
    const key = await cacheKeyForPath(clip);
    const audioDir = path.join(WORK_DIR, "audio", key);
    await mkdir(audioDir, { recursive: true });
    await writeFile(path.join(audioDir, "audio.wav"), Buffer.alloc(8));
    await writeFile(
      path.join(audioDir, "transcript.json"),
      JSON.stringify({ segments: [{ start: 0, end: 1, text: "stale" }], fullText: "stale", language: null, source: "cache" }),
    );

    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await transcribeVideo(clip);
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
    }
    const fresh = await stat(path.join(audioDir, "audio.wav"));
    expect(fresh.size).toBeGreaterThan(44);
    await expect(readFile(path.join(audioDir, "transcript.json"), "utf8")).rejects.toThrow();
  });
});
