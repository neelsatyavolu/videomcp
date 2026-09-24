import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { VIDEO_EXTENSIONS, WORK_DIR } from "../constants.js";

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export function isFileUrl(s: string): boolean {
  return /^file:\/\//i.test(s);
}

export function fileUrlToPath(url: string): string {
  const u = new URL(url);
  // file:///Users/x -> /Users/x ; Windows file:///C:/x handled by pathname decode
  let p = decodeURIComponent(u.pathname);
  if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(p)) {
    p = p.slice(1);
  }
  return p;
}

export function hashKey(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function workSubdir(...parts: string[]): Promise<string> {
  const dir = path.join(WORK_DIR, ...parts);
  return ensureDir(dir);
}

export async function resolveLocalPath(source: string): Promise<string> {
  let p = source.trim();
  if (isFileUrl(p)) p = fileUrlToPath(p);
  if (p.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    p = path.join(home, p.slice(1));
  }
  if (!path.isAbsolute(p)) {
    throw new Error(
      `Local video path must be absolute (got "${source}"). MCP client cwd is unpredictable — use an absolute path or file:// URI.`,
    );
  }
  const resolved = path.resolve(p);
  try {
    const st = await stat(resolved);
    if (!st.isFile()) throw new Error(`Not a file: ${resolved}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Not a file")) throw err;
    throw new Error(`Video file not found: ${resolved}`);
  }
  return resolved;
}

export function looksLikeVideoPath(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

export function cacheKeyForFile(filePath: string, mtimeMs: number, size: number, extra = ""): string {
  return hashKey(`${filePath}|${mtimeMs}|${size}|${extra}`);
}
