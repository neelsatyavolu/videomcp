import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { requireFfmpeg } from "../media/deps.js";
import { AGENT_ORDER, ADAPTERS, createAsk, isAgentName, selectAgent } from "./agents/index.js";
import { runProcess } from "./agents/run.js";
import { analyzeClip, loadJudgement, saveJudgement } from "./analyze.js";
import { applyPlan, undoLastRun } from "./apply.js";
import { runSort } from "./pipeline.js";
import { WORK_DIR_NAME } from "./scan.js";
import type { AgentName, PlanItem } from "./types.js";

const DEFAULT_CONCURRENCY = 3;
const REPORT_NAME = "footage-report.md";

export interface SortArgs {
  readonly dir: string;
  readonly agent?: AgentName;
  readonly model?: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly concurrency: number;
  readonly useCache: boolean;
  readonly undo: boolean;
}

export const SORT_USAGE = `Usage:
  video-mcp sort <folder> [--agent ${AGENT_ORDER.join("|")}] [--model <id>] [--dry-run] [--yes]
                          [--concurrency N] [--no-cache]
  video-mcp sort --undo <folder>`;

/** Parses `sort` arguments (everything after the word "sort"). Throws on invalid input. */
export function parseSortArgs(args: readonly string[]): SortArgs {
  const positional: string[] = [];
  let agent: AgentName | undefined;
  let model: string | undefined;
  let concurrency = DEFAULT_CONCURRENCY;
  const flags = { dryRun: false, yes: false, useCache: true, undo: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--agent") {
      const v = value();
      if (!isAgentName(v)) throw new Error(`--agent must be one of ${AGENT_ORDER.join(", ")} (got "${v}")`);
      agent = v;
    } else if (a === "--model") model = value();
    else if (a === "--concurrency") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error("--concurrency must be an integer from 1 to 16");
      concurrency = n;
    } else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--no-cache") flags.useCache = false;
    else if (a === "--undo") flags.undo = true;
    else if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length === 0) throw new Error(`Missing folder to sort.\n\n${SORT_USAGE}`);
  if (positional.length > 1) throw new Error(`Pass exactly one folder (got ${positional.length}).`);
  return { dir: path.resolve(positional[0]!), ...(agent ? { agent } : {}), ...(model ? { model } : {}), concurrency, ...flags };
}

function printPlan(root: string, plan: readonly PlanItem[]): void {
  const rel = (p: string) => path.relative(root, p);
  for (const p of plan) {
    const mark = p.verdict === "keep" ? "keep  " : "reject";
    const why = p.verdict === "keep" ? "" : `  (${p.reasons.join("; ")})`;
    console.log(`  ${mark}  ${rel(p.from)}  →  ${rel(p.to)}${why}`);
  }
  const keep = plan.filter((p) => p.verdict === "keep").length;
  console.log(`\n${plan.length} to move · ${keep} keep · ${plan.length - keep} reject`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function undo(dir: string): Promise<number> {
  const { restored, skipped } = await undoLastRun(dir);
  console.log(`Restored ${restored} file${restored === 1 ? "" : "s"}.`);
  for (const s of skipped) console.log(`  skipped: ${s}`);
  return skipped.length ? 1 : 0;
}

/** `video-mcp sort …`; returns the process exit code. */
export async function cmdSort(argv: readonly string[]): Promise<number> {
  let args: SortArgs;
  try {
    args = parseSortArgs(argv);
    if (!(await stat(args.dir)).isDirectory()) throw new Error(`Not a folder: ${args.dir}`);
  } catch (err) {
    console.error(err instanceof Error && "code" in err ? `Folder not found: ${argv.find((a) => !a.startsWith("-"))}` : (err as Error).message);
    return 1;
  }
  if (args.undo) return undo(args.dir);

  await requireFfmpeg();
  const agent = await selectAgent(runProcess, args.agent);
  const agentKey = args.model ? `${agent}:${args.model}` : agent;
  const cacheDir = path.join(args.dir, WORK_DIR_NAME, "cache");
  console.error(`Using ${agentKey} to judge clips.`);

  const result = await runSort(
    args.dir,
    { concurrency: args.concurrency, agentKey },
    {
      analyze: (f, id) => analyzeClip(f, id, cacheDir, args.useCache),
      ask: createAsk(runProcess, agent, args.model),
      imageMode: ADAPTERS[agent].imageMode,
      cachedJudgement: (f) => (args.useCache ? loadJudgement(cacheDir, f, agentKey) : Promise.resolve(null)),
      saveJudgement: (f, j) => saveJudgement(cacheDir, f, agentKey, j),
      log: (msg) => console.error(msg),
    },
  );

  console.log("");
  printPlan(args.dir, result.plan);
  if (result.unjudged.length) console.log(`${result.unjudged.length} clip(s) could not be judged and stay where they are.`);
  const failedExit = result.unjudged.length ? 1 : 0;

  if (args.dryRun) {
    console.log(`\n${result.report}`);
    return failedExit;
  }
  if (!result.plan.length) return failedExit;
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      console.error("Not a terminal: pass --yes to move files without confirmation.");
      return 1;
    }
    if (!(await confirm(`Move ${result.plan.length} files? [y/N] `))) {
      console.log("Nothing moved.");
      return 1;
    }
  }

  const { run, failures } = await applyPlan(args.dir, result.plan);
  await writeFile(path.join(args.dir, REPORT_NAME), result.report);
  console.log(`Moved ${run.moves.length} file(s). Report: ${path.join(args.dir, REPORT_NAME)}`);
  for (const f of failures) console.error(`  not moved: ${path.relative(args.dir, f.item.from)} — ${f.error}`);
  console.log(`Undo with: video-mcp sort --undo "${args.dir}"`);
  return failures.length ? 1 : failedExit;
}
