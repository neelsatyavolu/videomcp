import { describe, expect, it } from "vitest";
import { groupPrompt, judgePrompt } from "../../src/sort/prompts.js";
import type { ClipAnalysis } from "../../src/sort/types.js";
import { extractJson, parseGrouping, parseJudgement } from "../../src/sort/verdicts.js";

describe("extractJson", () => {
  it("reads fenced JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("reads JSON surrounded by prose", () => {
    expect(extractJson('Sure! Here it is: {"a":{"b":[1,2]}} Hope that helps.')).toEqual({ a: { b: [1, 2] } });
  });

  it("handles braces inside strings", () => {
    expect(extractJson('{"reason":"use {curly} and \\"quotes\\"","n":2}')).toEqual({
      reason: 'use {curly} and "quotes"',
      n: 2,
    });
  });

  it("skips a non-JSON brace block before the real object", () => {
    expect(extractJson('schema {verdict} then {"verdict":"keep"}')).toEqual({ verdict: "keep" });
  });

  it("throws when there is no object", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow(/no JSON object/);
  });
});

describe("parseJudgement", () => {
  it("normalises a valid judgement", () => {
    const j = parseJudgement({
      summary: "Host explains setup",
      tags: ["host", "desk", 3],
      verdict: "keep",
      issues: ["shaky", "made_up"],
      reason: "clear and in focus",
      spoken_line: "Welcome to the tutorial.",
    });
    expect(j).toEqual({
      summary: "Host explains setup",
      tags: ["host", "desk"],
      verdict: "keep",
      issues: ["shaky"],
      reason: "clear and in focus",
      spokenLine: "Welcome to the tutorial.",
    });
  });

  it("caps tags at 8 and accepts a null spoken line", () => {
    const j = parseJudgement({ summary: "s", tags: Array(12).fill("t"), verdict: "reject", issues: [], reason: "r", spoken_line: null });
    expect(j.tags).toHaveLength(8);
    expect(j.spokenLine).toBeNull();
  });

  it("rejects an invalid verdict or non-object", () => {
    expect(() => parseJudgement({ verdict: "maybe", summary: "s", reason: "r" })).toThrow(/verdict/);
    expect(() => parseJudgement("keep")).toThrow();
  });
});

describe("parseGrouping", () => {
  const ids = ["c1", "c2", "c3", "c4"];

  it("drops invented ids, keeps first assignment, puts missing clips in Misc", () => {
    const g = parseGrouping(
      {
        topics: [
          { title: "Setup", clips: ["c1", "c2", "c99"] },
          { title: "Outro", clips: ["c2"] },
        ],
        take_groups: [],
        duplicate_rejects: [],
      },
      ids,
    );
    expect(g.topics).toEqual([
      { title: "Setup", clips: ["c1", "c2"] },
      { title: "Misc", clips: ["c3", "c4"] },
    ]);
  });

  it("merges missing clips into an existing Misc topic", () => {
    const g = parseGrouping({ topics: [{ title: "misc", clips: ["c1"] }] }, ids);
    expect(g.topics).toEqual([{ title: "misc", clips: ["c1", "c2", "c3", "c4"] }]);
  });

  it("validates take groups and duplicate rejects", () => {
    const g = parseGrouping(
      {
        topics: [{ title: "T", clips: ids }],
        take_groups: [
          { best: "c1", others: ["c2", "c1", "c99"] },
          { best: "c99", others: ["c3"] },
          { best: "c3", others: [] },
        ],
        duplicate_rejects: [
          { clip: "c4", duplicate_of: "c3" },
          { clip: "c1", duplicate_of: "c4" },
          { clip: "c3", duplicate_of: "c3" },
        ],
      },
      ids,
    );
    expect(g.takeGroups).toEqual([{ best: "c1", others: ["c2"] }]);
    expect(g.duplicateRejects).toEqual([{ clip: "c4", duplicateOf: "c3" }]);
  });

  it("throws when topics is missing", () => {
    expect(() => parseGrouping({}, ids)).toThrow(/topics/);
  });
});

const clip: ClipAnalysis = {
  id: "c1",
  file: { path: "/shoot/raw/IMG_1.MOV", rel: "raw/IMG_1.MOV", rollHint: null },
  durationSec: 75,
  hasAudio: true,
  hasVideo: true,
  width: 1920,
  height: 1080,
  transcript: [{ start: 65, end: 70, text: "Welcome to the tutorial." }],
  ocr: ["STEP 1"],
  framePaths: ["/cache/f1.jpg", "/cache/f2.jpg"],
  metrics: {
    blur: 4,
    yavg: 120,
    darkShare: 0,
    blownShare: 0,
    shake: 0,
    maxVolumeDb: -3,
    silentShare: 0,
    blackShare: 0,
    frozenShare: 0,
  },
  dhash: null,
  roll: "a-roll",
};

describe("judgePrompt", () => {
  it("includes file, roll, flags, timestamped transcript and OCR", () => {
    const p = judgePrompt(clip, ["possibly shaky (jitter 0.050)"], "attached");
    expect(p).toContain("IMG_1.MOV");
    expect(p).toContain("a-roll");
    expect(p).toContain("possibly shaky");
    expect(p).toContain("[1:05] Welcome to the tutorial.");
    expect(p).toContain("STEP 1");
    expect(p).toContain('"verdict"');
    expect(p).not.toContain("/cache/f1.jpg");
  });

  it("lists frame paths only in paths mode", () => {
    expect(judgePrompt(clip, [], "paths")).toContain("/cache/f1.jpg");
    expect(judgePrompt(clip, [], "none")).not.toContain("/cache/f1.jpg");
  });

  it("truncates long transcripts", () => {
    const long = { ...clip, transcript: [{ start: 0, end: 60, text: "word ".repeat(3000) }] };
    expect(judgePrompt(long, [], "none").length).toBeLessThan(7000);
  });
});

describe("groupPrompt", () => {
  it("lists every clip and the duplicate pairs", () => {
    const p = groupPrompt(
      [
        { id: "c1", roll: "a-roll", verdict: "keep", summary: "Intro", tags: ["host"], spokenLine: "Hi", durationSec: 10, file: "a.mp4" },
        { id: "c2", roll: "b-roll", verdict: "reject", summary: "Desk", tags: [], spokenLine: null, durationSec: 5, file: "b.mp4" },
      ],
      [["c1", "c2"]],
    );
    expect(p).toContain('"id":"c1"');
    expect(p).toContain('"id":"c2"');
    expect(p).toContain("c1 ~ c2");
    expect(p).toContain('"take_groups"');
  });
});
