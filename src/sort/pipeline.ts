import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readManifest, sortedPaths } from "./apply.js";
import { nearDuplicatePairs } from "./dhash.js";
import { buildPlan } from "./plan.js";
import { groupPrompt, judgePrompt, type ImageMode } from "./prompts.js";
import { renderReport } from "./report.js";
import { metricFlags, preJudge } from "./rules.js";
import { scanFolder } from "./scan.js";
import type { ClipAnalysis, Grouping, Judgement, PlanItem, ScannedFile } from "./types.js";
import { extractJson, parseGrouping, parseJudgement } from "./verdicts.js";

const MAX_JUDGE_IMAGES = 4;
const RETRY_NUDGE = "\n\nYour previous reply could not be parsed. Reply with ONLY the JSON object, nothing else.";

export interface SortOptions {
  readonly concurrency: number;
  /** Agent (+ model) label for the report. */
  readonly agentKey: string;
}

export interface SortDeps {
  analyze(file: ScannedFile, id: string): Promise<ClipAnalysis>;
  ask(prompt: string, images: readonly string[], cwd: string): Promise<string>;
  readonly imageMode: Exclude<ImageMode, "none">;
  cachedJudgement(file: ScannedFile): Promise<Judgement | null>;
  saveJudgement(file: ScannedFile, j: Judgement): Promise<void>;
  log(msg: string): void;
}

export interface Unjudged {
  readonly rel: string;
  readonly error: string;
}

export interface SortResult {
  readonly plan: readonly PlanItem[];
  readonly unjudged: readonly Unjudged[];
  readonly report: string;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs fn over items with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Asks, parses, and asks once more with a nudge when the answer does not parse. */
async function askParsed<T>(deps: SortDeps, prompt: string, images: readonly string[], cwd: string, parse: (raw: unknown) => T): Promise<T> {
  try {
    return parse(extractJson(await deps.ask(prompt, images, cwd)));
  } catch (first) {
    if ((first as Error).name === "AgentError") throw first;
    return parse(extractJson(await deps.ask(prompt + RETRY_NUDGE, images, cwd)));
  }
}

async function judge(deps: SortDeps, a: ClipAnalysis): Promise<Judgement> {
  const rule = preJudge(a);
  if (rule) return rule;
  const cached = await deps.cachedJudgement(a.file);
  if (cached) return cached;
  const images = a.framePaths.slice(0, MAX_JUDGE_IMAGES);
  const prompt = judgePrompt({ ...a, framePaths: images }, metricFlags(a.metrics, a.roll, a.hasAudio), deps.imageMode);
  const cwd = images[0] ? path.dirname(images[0]) : os.tmpdir();
  const j = await askParsed(deps, prompt, images, cwd, parseJudgement);
  await deps.saveJudgement(a.file, j);
  return j;
}

async function group(deps: SortDeps, clips: readonly ClipAnalysis[], judgements: ReadonlyMap<string, Judgement>): Promise<Grouping> {
  const items = clips.map((c) => {
    const j = judgements.get(c.id)!;
    return {
      id: c.id,
      roll: c.roll,
      verdict: j.verdict,
      summary: j.summary,
      tags: j.tags,
      spokenLine: j.spokenLine,
      durationSec: c.durationSec,
      file: path.basename(c.file.path),
    };
  });
  const prompt = groupPrompt(items, nearDuplicatePairs(clips));
  try {
    return await askParsed(deps, prompt, [], os.tmpdir(), (raw) => parseGrouping(raw, clips.map((c) => c.id)));
  } catch (err) {
    throw new Error(`Could not group clips into topics: ${errorText(err)}`);
  }
}

/** Scan → analyze → judge → group → plan. Moves nothing. */
export async function runSort(root: string, opts: SortOptions, deps: SortDeps): Promise<SortResult> {
  const manifest = await readManifest(root);
  const alreadySorted = sortedPaths(root, manifest);
  const files = await scanFolder(root, alreadySorted.dirs, alreadySorted.files);
  deps.log(`Found ${files.length} video${files.length === 1 ? "" : "s"} in ${root}`);
  const width = String(files.length).length;
  const unjudged: Unjudged[] = [];
  let done = 0;

  const judged = await mapLimit(files, opts.concurrency, async (file, i) => {
    const id = `c${String(i + 1).padStart(width, "0")}`;
    try {
      const a = await deps.analyze(file, id);
      const j = await judge(deps, a);
      deps.log(`[${++done}/${files.length}] ${file.rel} → ${a.roll} · ${j.verdict}${j.verdict === "reject" ? ` (${j.reason})` : ""}`);
      return { a, j };
    } catch (err) {
      unjudged.push({ rel: file.rel, error: errorText(err) });
      deps.log(`[${++done}/${files.length}] ${file.rel} → failed: ${errorText(err)}`);
      return null;
    }
  });

  const ok = judged.filter((x): x is { a: ClipAnalysis; j: Judgement } => x !== null);
  const clips = ok.map((x) => x.a);
  const judgements = new Map(ok.map((x) => [x.a.id, x.j]));
  let plan: PlanItem[] = [];
  if (clips.length) {
    deps.log(`Grouping ${clips.length} clips into topics…`);
    const grouping = await group(deps, clips, judgements);
    plan = buildPlan(root, clips, judgements, grouping, existsSync);
  }
  const sortedUnjudged = [...unjudged].sort((x, y) => (x.rel < y.rel ? -1 : 1));
  return { plan, unjudged: sortedUnjudged, report: renderReport(root, plan, sortedUnjudged, opts.agentKey) };
}
