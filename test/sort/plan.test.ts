import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan, sanitizeTopic } from "../../src/sort/plan.js";
import { renderReport } from "../../src/sort/report.js";
import type { ClipAnalysis, Grouping, Judgement, Metrics, Roll } from "../../src/sort/types.js";

const root = "/shoot";
const metrics: Metrics = {
  blur: 4, yavg: 120, darkShare: 0, blownShare: 0, shake: 0, maxVolumeDb: -6, silentShare: 0, blackShare: 0, frozenShare: 0,
};

function clip(id: string, rel: string, roll: Roll = "b-roll"): ClipAnalysis {
  return {
    id,
    file: { path: path.join(root, rel), rel, rollHint: null },
    durationSec: 12,
    hasAudio: true,
    hasVideo: true,
    width: 1920,
    height: 1080,
    transcript: [],
    ocr: [],
    framePaths: [],
    metrics,
    dhash: null,
    roll,
  };
}

const keep = (summary = "ok"): Judgement => ({ summary, tags: [], verdict: "keep", issues: [], reason: "usable", spokenLine: null });
const reject = (reason: string): Judgement => ({ summary: "bad", tags: [], verdict: "reject", issues: ["shaky"], reason, spokenLine: null });
const grouping = (topics: Grouping["topics"], extra: Partial<Grouping> = {}): Grouping => ({
  topics, takeGroups: [], duplicateRejects: [], ...extra,
});

describe("sanitizeTopic", () => {
  it.each([
    ["A/B: Test", "A B Test"],
    ["  Café  Tour  ", "Café Tour"],
    ["...hidden", "hidden"],
    ["", "Misc"],
    ["???", "Misc"],
    ["_rejects", "Rejects"],
    ["x".repeat(80), "x".repeat(60)],
  ])("%j → %j", (input, expected) => {
    expect(sanitizeTopic(input)).toBe(expected);
  });
});

describe("buildPlan", () => {
  it("files keeps under topic/roll and rejects under _rejects/topic/roll", () => {
    const clips = [clip("c1", "raw/talk.mp4", "a-roll"), clip("c2", "raw/shaky.mp4")];
    const plan = buildPlan(
      root,
      clips,
      new Map([["c1", keep("Host intro")], ["c2", reject("too shaky")]]),
      grouping([{ title: "Intro", clips: ["c1", "c2"] }]),
      () => false,
    );
    expect(plan).toEqual([
      expect.objectContaining({ id: "c1", to: "/shoot/Intro/a-roll/talk.mp4", verdict: "keep", topic: "Intro", summary: "Host intro" }),
      expect.objectContaining({ id: "c2", to: "/shoot/_rejects/Intro/b-roll/shaky.mp4", verdict: "reject" }),
    ]);
    expect(plan[1]!.reasons.join(" ")).toContain("too shaky");
    expect(plan[1]!.reasons.join(" ")).toContain("shaky");
  });

  it("rejects alternate takes and near-duplicates with the kept file named", () => {
    const clips = [clip("c1", "t1.mp4", "a-roll"), clip("c2", "t2.mp4", "a-roll"), clip("c3", "b1.mp4"), clip("c4", "b2.mp4")];
    const plan = buildPlan(
      root,
      clips,
      new Map(clips.map((c) => [c.id, keep()])),
      grouping([{ title: "T", clips: ["c1", "c2", "c3", "c4"] }], {
        takeGroups: [{ best: "c2", others: ["c1"] }],
        duplicateRejects: [{ clip: "c4", duplicateOf: "c3" }],
      }),
      () => false,
    );
    const byId = new Map(plan.map((p) => [p.id, p]));
    expect(byId.get("c1")).toMatchObject({ verdict: "reject", to: "/shoot/_rejects/T/a-roll/t1.mp4" });
    expect(byId.get("c1")!.reasons).toEqual(["alternate take (best: t2.mp4)"]);
    expect(byId.get("c2")!.verdict).toBe("keep");
    expect(byId.get("c4")).toMatchObject({ verdict: "reject", reasons: ["near-duplicate of b1.mp4"] });
  });

  it("keeps a rejected clip's own reason first when grouping also rejects it", () => {
    const clips = [clip("c1", "blip.mp4"), clip("c2", "b.mp4")];
    const plan = buildPlan(
      root,
      clips,
      new Map([["c1", reject("too short (<1s)")], ["c2", keep()]]),
      grouping([{ title: "T", clips: ["c1", "c2"] }], { duplicateRejects: [{ clip: "c1", duplicateOf: "c2" }] }),
      () => false,
    );
    expect(plan[0]!.reasons).toEqual(["too short (<1s)", "issues: shaky", "near-duplicate of b.mp4"]);
  });

  it("suffixes collisions between planned moves and with files already on disk", () => {
    const clips = [clip("c1", "day1/clip.mp4"), clip("c2", "day2/clip.mp4"), clip("c3", "day3/other.MOV")];
    const onDisk = new Set(["/shoot/T/b-roll/other.MOV"]);
    const plan = buildPlan(
      root,
      clips,
      new Map(clips.map((c) => [c.id, keep()])),
      grouping([{ title: "T", clips: ["c1", "c2", "c3"] }]),
      (p) => onDisk.has(p),
    );
    expect(plan.map((p) => p.to)).toEqual([
      "/shoot/T/b-roll/clip.mp4",
      "/shoot/T/b-roll/clip (2).mp4",
      "/shoot/T/b-roll/other (2).MOV",
    ]);
  });

  it("skips unjudged clips and clips already in place", () => {
    const clips = [clip("c1", "T/b-roll/in-place.mp4"), clip("c2", "raw/unjudged.mp4")];
    const plan = buildPlan(
      root,
      clips,
      new Map([["c1", keep()]]),
      grouping([{ title: "T", clips: ["c1", "c2"] }]),
      (p) => p === "/shoot/T/b-roll/in-place.mp4",
    );
    expect(plan).toEqual([]);
  });
});

describe("renderReport", () => {
  it("summarises counts and lists every clip with escaped cells", () => {
    const clips = [clip("c1", "a.mp4", "a-roll"), clip("c2", "b.mp4")];
    const plan = buildPlan(
      root,
      clips,
      new Map([["c1", keep("Host | intro\nline two")], ["c2", reject("blurry")]]),
      grouping([{ title: "Intro", clips: ["c1", "c2"] }]),
      () => false,
    );
    const md = renderReport(root, plan, [{ rel: "c.mp4", error: "grok timed out" }], "grok");
    expect(md).toContain("# Footage report");
    expect(md).toContain("3 clips");
    expect(md).toContain("1 keep");
    expect(md).toContain("1 reject");
    expect(md).toContain("1 not judged");
    expect(md).toContain("## Intro");
    expect(md).toContain("Host \\| intro line two");
    expect(md).toContain("blurry");
    expect(md).toContain("c.mp4");
    expect(md).toContain("grok timed out");
  });
});
