import { constants, copyFile, mkdir, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { exists, readJson, writeJson } from "./fsutil.js";
import { WORK_DIR_NAME } from "./scan.js";
import type { Manifest, ManifestRun, Move, PlanItem } from "./types.js";

export function manifestPath(root: string): string {
  return path.join(root, WORK_DIR_NAME, "manifest.json");
}

export async function readManifest(root: string): Promise<Manifest> {
  const m = await readJson<Manifest>(manifestPath(root));
  return m && Array.isArray(m.runs) ? m : { runs: [] };
}

/** Every folder any recorded run created (topic folders a re-scan should skip). */
export function createdDirsAll(m: Manifest): string[] {
  return m.runs.flatMap((r) => r.createdDirs);
}

/** mkdir -p that reports which directories it actually created, outermost first. */
async function ensureDir(dir: string): Promise<string[]> {
  if (await exists(dir)) return [];
  const created = await ensureDir(path.dirname(dir));
  try {
    await mkdir(dir);
    return [...created, dir];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return created;
    throw err;
  }
}

/** rename, or copy + size check + unlink across volumes. Never overwrites. */
async function moveFile(from: string, to: string): Promise<void> {
  if (await exists(to)) throw new Error(`destination already exists: ${to}`);
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyFile(from, to, constants.COPYFILE_EXCL);
    const [a, b] = await Promise.all([stat(from), stat(to)]);
    if (a.size !== b.size) {
      await unlink(to);
      throw new Error(`copy size mismatch for ${from}`);
    }
    await unlink(from);
  }
}

export interface ApplyResult {
  readonly run: ManifestRun;
  readonly failures: readonly { readonly item: PlanItem; readonly error: string }[];
}

/**
 * Moves every plan item, recording the run in the manifest before the first move and after
 * each one, so an interrupted run can still be undone.
 */
export async function applyPlan(
  root: string,
  plan: readonly PlanItem[],
  onMove?: (item: PlanItem) => void | Promise<void>,
): Promise<ApplyResult> {
  const prior = (await readManifest(root)).runs;
  let run: ManifestRun = { at: new Date().toISOString(), moves: [], createdDirs: [] };
  const save = () => writeJson(manifestPath(root), { runs: [...prior, run] } satisfies Manifest);
  await save();

  const failures: { item: PlanItem; error: string }[] = [];
  for (const item of plan) {
    try {
      const created = await ensureDir(path.dirname(item.to));
      run = { ...run, createdDirs: [...run.createdDirs, ...created] };
      await moveFile(item.from, item.to);
      const move: Move = { from: item.from, to: item.to };
      run = { ...run, moves: [...run.moves, move] };
      await save();
      await onMove?.(item);
    } catch (err) {
      failures.push({ item, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await save();
  return { run, failures };
}

/** Removes dir when it is empty apart from Finder's .DS_Store. */
async function removeIfEmpty(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => null);
  if (!entries || entries.some((e) => e !== ".DS_Store")) return;
  if (entries.length) await unlink(path.join(dir, ".DS_Store"));
  await rmdir(dir).catch(() => undefined);
}

/** Reverts the most recent run: files go back, emptied folders it created are removed. */
export async function undoLastRun(root: string): Promise<{ restored: number; skipped: string[] }> {
  const { runs } = await readManifest(root);
  const run = runs.at(-1);
  if (!run) return { restored: 0, skipped: [] };

  let restored = 0;
  const skipped: string[] = [];
  for (const m of [...run.moves].reverse()) {
    if (!(await exists(m.to))) {
      skipped.push(`missing (moved or deleted since): ${m.to}`);
      continue;
    }
    if (await exists(m.from)) {
      skipped.push(`original path is occupied: ${m.from}`);
      continue;
    }
    await mkdir(path.dirname(m.from), { recursive: true });
    await moveFile(m.to, m.from);
    restored++;
  }
  const deepestFirst = [...run.createdDirs].sort((a, b) => b.length - a.length);
  for (const dir of deepestFirst) await removeIfEmpty(dir);
  await writeJson(manifestPath(root), { runs: runs.slice(0, -1) } satisfies Manifest);
  return { restored, skipped };
}
