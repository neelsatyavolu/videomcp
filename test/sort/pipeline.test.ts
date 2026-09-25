import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSortArgs } from "../../src/sort/index.js";
import { runSort, type SortDeps } from "../../src/sort/pipeline.js";
import type { ClipAnalysis, Judgement, Metrics, Roll, ScannedFile } from "../../src/sort/types.js";
import { tempDir, touch } from "./helpers.js";

const metrics: Metrics = {
  blur: 4, yavg: 120, darkShare: 0, blownShare: 0, shake: 0, maxVolumeDb: -6, silentShare: 0, blackShare: 0, frozenShare: 0,
};

const shapes: Record<string, { roll: Roll; durationSec: number; line: string | null; dhash: string }> = {
  "take1.mp4": { roll: "a-roll", durationSec: 20, line: "Welcome to the tutorial", dhash: "0000000000000000" },
  "take2.mp4": { roll: "a-roll", durationSec: 18, line: "Welcome to the tutorial", dhash: "00000000000000ff" },
  "lamp.mp4": { roll: "b-roll", durationSec: 8, line: null, dhash: "ffffffffffffffff" },
  "blip.mp4": { roll: "b-roll", durationSec: 0.5, line: null, dhash: "f0f0f0f0f0f0f0f0" },
};

function fakeAnalyze(f: ScannedFile, id: string): Promise<ClipAnalysis> {
  const s = shapes[path.basename(f.path)];
  if (!s) return Promise.reject(new Error(`cannot decode ${f.rel}`));
  return Promise.resolve({
    id, file: f, durationSec: s.durationSec, hasAudio: true, hasVideo: true, width: 1920, height: 1080,
    transcript: s.line ? [{ start: 0, end: s.durationSec, text: s.line }] : [],
    ocr: [], framePaths: [], metrics, dhash: s.dhash, roll: s.roll,
  });
}

interface Script {
  judge?: (file: string, attempt: number) => string;
  group?: (prompt: string, attempt: number) => string;
}

function deps(script: Script = {}) {
  const prompts: string[] = [];
  const attempts = new Map<string, number>();
  let groupAttempts = 0;
  const d: SortDeps = {
    analyze: fakeAnalyze,
    imageMode: "attached",
    log: () => undefined,
    cachedJudgement: async () => null,
    saveJudgement: async () => undefined,
    ask: async (prompt) => {
      prompts.push(prompt);
      if (prompt.includes("Group ALL clips")) {
        groupAttempts++;
        if (script.group) return script.group(prompt, groupAttempts);
        const ids = new Map([...prompt.matchAll(/"id":"(c\d+)","file":"([^"]+)"/g)].map((m) => [m[2]!, m[1]!]));
        return JSON.stringify({
          topics: [{ title: "Setup Tutorial", clips: [...ids.values()] }],
          take_groups: [{ best: ids.get("take2.mp4"), others: [ids.get("take1.mp4")] }],
          duplicate_rejects: [],
        });
      }
      const file = /File: (\S+)/.exec(prompt)![1]!;
      const n = (attempts.get(file) ?? 0) + 1;
      attempts.set(file, n);
      if (script.judge) return script.judge(file, n);
      const j: Record<string, unknown> = {
        summary: `about ${file}`, tags: [], verdict: "keep", issues: [], reason: "fine",
        spoken_line: shapes[file]?.line ?? null,
      };
      return "```json\n" + JSON.stringify(j) + "\n```";
    },
  };
  return { d, prompts };
}

async function shoot(extra: string[] = []): Promise<string> {
  const root = await tempDir();
  await touch(root, ["raw/take1.mp4", "raw/take2.mp4", "raw/lamp.mp4", "raw/blip.mp4", ...extra]);
  return root;
}

const opts = { concurrency: 2, agentKey: "fake" };

describe("runSort", () => {
  it("judges, groups and plans a shoot", async () => {
    const root = await shoot();
    const { d, prompts } = deps();
    const res = await runSort(root, opts, d);
    const byFile = Object.fromEntries(res.plan.map((p) => [path.basename(p.from), p]));
    expect(byFile["take2.mp4"]).toMatchObject({ verdict: "keep", to: path.join(root, "Setup Tutorial/a-roll/take2.mp4") });
    expect(byFile["take1.mp4"]).toMatchObject({ verdict: "reject", reasons: ["alternate take (best: take2.mp4)"] });
    expect(byFile["lamp.mp4"]).toMatchObject({ verdict: "keep", roll: "b-roll" });
    expect(byFile["blip.mp4"]).toMatchObject({ verdict: "reject", to: path.join(root, "_rejects/Setup Tutorial/b-roll/blip.mp4") });
    expect(prompts.some((p) => p.includes("File: blip.mp4"))).toBe(false);
    expect(res.unjudged).toEqual([]);
    expect(res.report).toContain("Setup Tutorial");
  });

  it("retries an unparseable judgement once, then leaves the clip unjudged", async () => {
    const root = await shoot();
    const { d } = deps({
      // lamp.mp4 never answers in JSON; every other clip answers correctly on its second try.
      judge: (file, attempt) => {
        if (file === "lamp.mp4") return "I think it's nice";
        return attempt === 1 ? "not json" : JSON.stringify({ summary: "s", verdict: "keep", reason: "r" });
      },
    });
    const res = await runSort(root, opts, d);
    expect(res.unjudged.map((u) => u.rel)).toEqual([path.join("raw", "lamp.mp4")]);
    expect(res.plan.map((p) => path.basename(p.from)).sort()).toEqual(["blip.mp4", "take1.mp4", "take2.mp4"]);
  });

  it("reports clips that fail analysis as unjudged", async () => {
    const root = await shoot(["raw/corrupt.mp4"]);
    const res = await runSort(root, opts, deps().d);
    expect(res.unjudged).toEqual([{ rel: path.join("raw", "corrupt.mp4"), error: "cannot decode raw/corrupt.mp4" }]);
  });

  it("fails before planning when grouping fails twice", async () => {
    const root = await shoot();
    await expect(runSort(root, opts, deps({ group: () => "no" }).d)).rejects.toThrow(/group/i);
  });

  it("gives the grouping call a longer timeout than per-clip judging", async () => {
    const root = await shoot();
    const { d } = deps();
    const timeouts: (number | undefined)[] = [];
    const res = await runSort(root, opts, {
      ...d,
      ask: (prompt, images, cwd, timeoutMs) => {
        if (prompt.includes("Group ALL clips")) timeouts.push(timeoutMs);
        return d.ask(prompt, images, cwd, timeoutMs);
      },
    });
    expect(res.plan.length).toBeGreaterThan(0);
    expect(timeouts).toEqual([600_000]);
  });

  it("uses cached judgements instead of asking", async () => {
    const root = await shoot();
    const { d, prompts } = deps();
    const cached: Judgement = { summary: "cached", tags: [], verdict: "keep", issues: [], reason: "r", spokenLine: null };
    const res = await runSort(root, opts, { ...d, cachedJudgement: async () => cached });
    expect(prompts.filter((p) => p.includes("File:"))).toEqual([]);
    expect(res.plan.find((p) => p.from.endsWith("lamp.mp4"))!.summary).toBe("cached");
  });

  it("returns an empty plan for a folder without videos", async () => {
    const root = await tempDir();
    await touch(root, ["notes.txt"]);
    const res = await runSort(root, opts, deps().d);
    expect(res.plan).toEqual([]);
  });
});

describe("parseSortArgs", () => {
  it("parses flags", () => {
    expect(parseSortArgs(["./shoot", "--agent", "codex", "--model", "m", "--dry-run", "-y", "--concurrency", "5", "--no-cache"])).toEqual({
      dir: path.resolve("./shoot"), agent: "codex", model: "m", dryRun: true, yes: true, concurrency: 5, useCache: false, undo: false,
    });
    expect(parseSortArgs(["--undo", "/x"])).toMatchObject({ dir: "/x", undo: true, concurrency: 3, useCache: true });
  });

  it.each([
    [[], /folder/],
    [["/x", "--agent", "gemini"], /agent/],
    [["/x", "--concurrency", "0"], /concurrency/],
    [["/x", "--wat"], /Unknown option/],
    [["/x", "/y"], /one folder/],
  ])("rejects %j", (args, message) => {
    expect(() => parseSortArgs(args)).toThrow(message);
  });
});
