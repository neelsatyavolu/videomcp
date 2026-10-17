import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSidecarCaptions, parseVtt, pickCaptionName, preferVideoFilename } from "../../src/media/resolve.js";
import { transcribeVideo } from "../../src/media/transcribe.js";
import { tempDir } from "../sort/helpers.js";

describe("parseVtt", () => {
  it("parses cue settings and does not merge a later line that happens to extend earlier text", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000 align:start position:0%
Hello

00:00:10.000 --> 00:00:12.000
Hello world
`;
    expect(parseVtt(vtt)).toEqual([
      { start: 1, end: 4, text: "Hello" },
      { start: 10, end: 12, text: "Hello world" },
    ]);
  });

  it("still collapses rolling auto-captions that extend the previous cue", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
Hello

00:00:01.000 --> 00:00:02.000
Hello world
`;
    expect(parseVtt(vtt)).toEqual([{ start: 0, end: 2, text: "Hello world" }]);
  });
});

describe("pickCaptionName", () => {
  it("prefers this video's manual captions over another file's subtitles", () => {
    expect(pickCaptionName(["other.vtt", "clip.en.auto.vtt", "clip.en-US.vtt"], "clip")).toBe("clip.en-US.vtt");
    expect(pickCaptionName(["notes.vtt"], "clip")).toBeNull();
    expect(pickCaptionName(["Clip.en.vtt", "clip.vtt"], "clip")).toBe("clip.vtt");
  });
});

describe("preferVideoFilename", () => {
  it("ignores audio-only downloads and prefers mp4", () => {
    expect(preferVideoFilename(["audio.m4a", "clip.webm", "clip.mp4"])).toBe("clip.mp4");
    expect(preferVideoFilename(["only.m4a", "notes.txt"])).toBeNull();
  });
});

describe("loadSidecarCaptions", () => {
  it("does not attach a sibling caption from a different video", async () => {
    const dir = await tempDir();
    const clip = path.join(dir, "clip.mp4");
    await writeFile(clip, "not a video");
    await writeFile(path.join(dir, "other.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nsecret\n");
    await writeFile(path.join(dir, "clip.en-US.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n");
    const side = await loadSidecarCaptions(clip);
    expect(side?.segments.map((s) => s.text)).toEqual(["hello"]);

    const otherOnly = await tempDir();
    const bare = path.join(otherOnly, "clip.mp4");
    await writeFile(bare, "not a video");
    await writeFile(path.join(otherOnly, "other.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nsecret\n");
    expect(await loadSidecarCaptions(bare)).toBeNull();
    await expect(transcribeVideo(bare)).rejects.toThrow();
  });

  it("falls through an empty caption file to the next one for the same video", async () => {
    const dir = await tempDir();
    const clip = path.join(dir, "clip.mp4");
    await writeFile(clip, "not a video");
    await writeFile(path.join(dir, "clip.vtt"), "WEBVTT\n\n");
    await writeFile(path.join(dir, "clip.en.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n");
    const side = await loadSidecarCaptions(clip);
    expect(side?.path.endsWith("clip.en.vtt")).toBe(true);
    expect(side?.segments.map((s) => s.text)).toEqual(["hello"]);
  });
});
