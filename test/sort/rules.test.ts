import { describe, expect, it } from "vitest";
import { detectRoll, metricFlags, preJudge } from "../../src/sort/rules.js";
import type { Metrics } from "../../src/sort/types.js";

const clean: Metrics = {
  blur: 4,
  yavg: 120,
  darkShare: 0,
  blownShare: 0,
  shake: 0.005,
  maxVolumeDb: -6,
  silentShare: 0.1,
  blackShare: 0,
  frozenShare: 0,
};

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("detectRoll", () => {
  it("lets a folder hint win", () => {
    expect(detectRoll("b-roll", 10, [{ start: 0, end: 10, text: words(40) }])).toBe("b-roll");
  });

  it("calls sustained speech A-roll", () => {
    expect(detectRoll(null, 10, [{ start: 0, end: 5, text: words(12) }])).toBe("a-roll");
  });

  it("calls short or sparse speech B-roll", () => {
    expect(detectRoll(null, 10, [{ start: 0, end: 3, text: words(20) }])).toBe("b-roll");
    expect(detectRoll(null, 10, [{ start: 0, end: 6, text: words(5) }])).toBe("b-roll");
    expect(detectRoll(null, 10, [])).toBe("b-roll");
    expect(detectRoll(null, 0, [])).toBe("b-roll");
  });

  it("does not double count overlapping segments", () => {
    const segs = [
      { start: 0, end: 3, text: words(6) },
      { start: 1, end: 3.5, text: words(6) },
    ];
    expect(detectRoll(null, 10, segs)).toBe("b-roll");
  });
});

describe("preJudge", () => {
  const base = { durationSec: 10, hasVideo: true, metrics: clean };

  it("passes a clean clip to the agent", () => {
    expect(preJudge(base)).toBeNull();
  });

  it.each([
    [{ ...base, durationSec: 0.5 }, "too_short"],
    [{ ...base, hasVideo: false }, "junk"],
    [{ ...base, metrics: { ...clean, blackShare: 0.85 } }, "black"],
  ] as const)("rejects %#", (clip, issue) => {
    const j = preJudge(clip);
    expect(j?.verdict).toBe("reject");
    expect(j?.issues).toContain(issue);
    expect(j?.reason).toBeTruthy();
  });
});

describe("preJudge on static shots", () => {
  it("leaves a still picture to the agent (locked-off shots look frozen to ffmpeg)", () => {
    expect(preJudge({ durationSec: 10, hasVideo: true, metrics: { ...clean, frozenShare: 1 } })).toBeNull();
  });
});

describe("metricFlags", () => {
  it("is empty for a clean clip", () => {
    expect(metricFlags(clean, "a-roll", true)).toEqual([]);
  });

  it("flags each threshold", () => {
    const bad: Metrics = {
      ...clean,
      blur: 9,
      darkShare: 0.6,
      blownShare: 0.4,
      shake: 0.05,
      maxVolumeDb: -0.1,
      silentShare: 0.7,
      frozenShare: 0.95,
    };
    const flags = metricFlags(bad, "a-roll", true).join(" | ");
    for (const f of ["soft focus", "underexposed", "overexposed", "shaky", "clipping", "mostly silent", "static or frozen"]) {
      expect(flags).toContain(f);
    }
  });

  it("flags missing audio only on A-roll and silence only on A-roll", () => {
    expect(metricFlags(clean, "a-roll", false).join()).toContain("no audio");
    expect(metricFlags({ ...clean, silentShare: 0.9 }, "b-roll", false)).toEqual([]);
  });
});
