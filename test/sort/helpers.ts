import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function tempDir(prefix = "sort-test-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Creates each relative file under root with its own path as content. */
export async function touch(root: string, rels: readonly string[]): Promise<void> {
  for (const rel of rels) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, rel);
  }
}
