import { readdir } from "node:fs/promises";
import path from "node:path";
import { looksLikeVideoPath } from "../utils/paths.js";
import type { Roll, ScannedFile } from "./types.js";

export const WORK_DIR_NAME = ".footage-sort";
export const REJECTS_DIR_NAME = "_rejects";

const A_ROLL = /^a[-_ ]?roll$/i;
const B_ROLL = /^b[-_ ]?roll$/i;

/** Roll implied by the nearest folder named like a-roll / b-roll, if any. */
export function rollHintFromRel(rel: string): Roll | null {
  const dirs = rel.split(/[\\/]/).slice(0, -1).reverse();
  for (const seg of dirs) {
    if (A_ROLL.test(seg)) return "a-roll";
    if (B_ROLL.test(seg)) return "b-roll";
  }
  return null;
}

/**
 * Recursively lists video files under root, skipping hidden entries, the rejects and work
 * folders, any absolute directory in skipDirs (topic folders created by earlier runs) and any
 * absolute file in skipFiles (clips earlier runs already placed).
 */
export async function scanFolder(
  root: string,
  skipDirs: readonly string[],
  skipFiles: readonly string[] = [],
): Promise<ScannedFile[]> {
  const base = path.resolve(root);
  const skip = new Set(skipDirs.map((d) => path.resolve(d)));
  const skipFile = new Set(skipFiles.map((f) => path.resolve(f)));
  const found: ScannedFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === base && entry.name === REJECTS_DIR_NAME) continue;
        if (skip.has(full)) continue;
        await walk(full);
      } else if (entry.isFile() && looksLikeVideoPath(full) && !skipFile.has(full)) {
        const rel = path.relative(base, full);
        found.push({ path: full, rel, rollHint: rollHintFromRel(rel) });
      }
    }
  }

  await walk(base);
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
