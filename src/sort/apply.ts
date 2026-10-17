import { constants, copyFile, mkdir, readFile, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { exists, writeJson } from "./fsutil.js";
import { WORK_DIR_NAME } from "./scan.js";
import type { Manifest, ManifestRun, Move, PlanItem } from "./types.js";

export function manifestPath(root: string): string {
  return path.join(root, WORK_DIR_NAME, "manifest.json");
}

/**
 * Absolute path for a manifest-relative entry, or null when it escapes `root`.
 * `path.join(root, "../outside")` would otherwise leave the shoot folder.
 */
export function resolveWithin(root: string, rel: string): string | null {
  const base = path.resolve(root);
  const resolved = path.resolve(base, rel);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (resolved !== base && !resolved.startsWith(prefix)) return null;
  return resolved;
}

export async function readManifest(root: string): Promise<Manifest> {
  const file = manifestPath(root);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { runs: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Footage manifest is corrupt (${file}). Repair or remove it before sorting or undoing; that file is the undo history.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as Manifest).runs)) {
    throw new Error(`Footage manifest is invalid (${file}). Expected an object with a runs array.`);
  }
  return parsed as Manifest;
}

/** Every folder any recorded run created, relative to the root. */
export function createdDirsAll(m: Manifest): string[] {
  return m.runs.flatMap((r) => r.createdDirs);
}

/** Absolute folders and files earlier runs created or placed — a re-scan skips these. */
export function sortedPaths(root: string, m: Manifest): { dirs: string[]; files: string[] } {
  return {
    dirs: createdDirsAll(m).map((d) => path.join(root, d)),
    files: m.runs.flatMap((r) => r.moves.filter((mv) => !mv.pending).map((mv) => path.join(root, mv.to))),
  };
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
 * Moves every plan item. Each move is written to the manifest as pending before the rename and
 * confirmed after it, so a run interrupted at any point can still be undone.
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
    const fromRel = path.relative(root, item.from);
    const toRel = path.relative(root, item.to);
    if (!resolveWithin(root, fromRel) || !resolveWithin(root, toRel)) {
      failures.push({ item, error: "refusing to move a file outside the shoot folder" });
      continue;
    }
    const move: Move = { from: fromRel, to: toRel };
    const done = run.moves;
    try {
      const created = await ensureDir(path.dirname(item.to));
      run = {
        ...run,
        createdDirs: [...run.createdDirs, ...created.map((d) => path.relative(root, d))],
        moves: [...done, { ...move, pending: true }],
      };
      await save();
      await moveFile(item.from, item.to);
      run = { ...run, moves: [...done, move] };
      await save();
      await onMove?.(item);
    } catch (err) {
      failures.push({ item, error: err instanceof Error ? err.message : String(err) });
      if (run.moves.length > done.length && run.moves.at(-1)?.pending) {
        run = { ...run, moves: done };
        await save().catch(() => undefined);
      }
    }
  }
  // A run that moved nothing and created nothing would sit on top of real history,
  // so the next --undo would restore zero files and hide the previous run.
  if (run.moves.length === 0 && run.createdDirs.length === 0) {
    await writeJson(manifestPath(root), { runs: prior } satisfies Manifest);
    return { run, failures };
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
    const from = resolveWithin(root, m.from);
    const to = resolveWithin(root, m.to);
    if (!from || !to) {
      skipped.push(`refusing path outside the shoot folder: ${m.from} → ${m.to}`);
      continue;
    }
    const atTo = await exists(to);
    // A pending move whose file never left its source is simply not done.
    if (m.pending && !atTo) continue;
    if (!atTo) {
      skipped.push(`missing (moved or deleted since): ${m.to}`);
      continue;
    }
    if (await exists(from)) {
      skipped.push(`original path is occupied: ${m.from}`);
      continue;
    }
    await mkdir(path.dirname(from), { recursive: true });
    await moveFile(to, from);
    restored++;
  }
  const deepestFirst: string[] = [];
  for (const d of run.createdDirs) {
    const dir = resolveWithin(root, d);
    if (!dir) {
      skipped.push(`refusing folder outside the shoot folder: ${d}`);
      continue;
    }
    if (dir === path.resolve(root)) continue;
    deepestFirst.push(dir);
  }
  deepestFirst.sort((a, b) => b.length - a.length);
  for (const dir of deepestFirst) await removeIfEmpty(dir);
  await writeJson(manifestPath(root), { runs: runs.slice(0, -1) } satisfies Manifest);
  return { restored, skipped };
}
