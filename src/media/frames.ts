import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SCENE_THRESHOLD,
  FRAME_MAX_EDGE,
  FRAME_QV,
  INLINE_MAX_EDGE,
  INLINE_QV,
  type DetailLevel,
  fpsForDetail,
  maxFramesForDetail,
} from "../constants.js";
import { execOk } from "../utils/exec.js";
import { hashKey, workSubdir } from "../utils/paths.js";
import type { FrameResult } from "../types.js";
import { requireFfmpeg } from "./deps.js";

export interface ExtractFramesOptions {
  startSec?: number;
  endSec?: number;
  maxFrames?: number;
  mode?: "scene" | "interval" | "both";
  detail?: DetailLevel;
  sceneThreshold?: number;
  durationSec: number;
}

function scaleFilter(edge = FRAME_MAX_EDGE): string {
  return `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`;
}

async function listFrames(dir: string): Promise<string[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  return files
    .filter((f) => /\.jpe?g$/i.test(f) && !f.includes("_inline"))
    .sort()
    .map((f) => path.join(dir, f));
}

async function writeTimesSidecar(dir: string, times: number[]): Promise<void> {
  await writeFile(path.join(dir, "times.json"), JSON.stringify(times), "utf8");
}

async function readTimesSidecar(dir: string): Promise<number[] | null> {
  try {
    const raw = await readFile(path.join(dir, "times.json"), "utf8");
    const arr = JSON.parse(raw) as number[];
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function parseShowinfoTimes(stderr: string, startOffset = 0): number[] {
  const times: number[] = [];
  const re = /pts_time:\s*(\d+\.?\d*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    times.push(Number(m[1]) + startOffset);
  }
  return times;
}

async function extractWithScene(
  ffmpeg: string,
  videoPath: string,
  outDir: string,
  threshold: number,
  startSec?: number,
  endSec?: number,
): Promise<{ files: string[]; times: number[] }> {
  const pattern = path.join(outDir, "scene_%04d.jpg");
  const vf = [`select='gt(scene,${threshold})'`, scaleFilter(), "showinfo"].join(",");

  const args = ["-y", "-hide_banner", "-loglevel", "info"];
  if (startSec != null) args.push("-ss", String(startSec));
  args.push("-i", videoPath);
  if (endSec != null && startSec != null) {
    args.push("-t", String(Math.max(0.1, endSec - startSec)));
  } else if (endSec != null) {
    args.push("-t", String(endSec));
  }
  args.push(
    "-vf",
    vf,
    "-vsync",
    "vfr",
    "-q:v",
    String(FRAME_QV),
    "-frames:v",
    "200",
    pattern,
  );

  const result = await execOk(ffmpeg, args, { timeoutMs: 300_000 });
  const times = parseShowinfoTimes(result.stderr, startSec ?? 0);
  const files = await listFrames(outDir);
  await writeTimesSidecar(outDir, times.slice(0, files.length));
  return { files, times: times.slice(0, files.length) };
}

async function extractInterval(
  ffmpeg: string,
  videoPath: string,
  outDir: string,
  fps: number,
  startSec?: number,
  endSec?: number,
  maxFrames = 60,
): Promise<{ files: string[]; times: number[] }> {
  const pattern = path.join(outDir, "frame_%04d.jpg");
  const args = ["-y", "-hide_banner"];
  if (startSec != null) args.push("-ss", String(startSec));
  args.push("-i", videoPath);
  if (endSec != null && startSec != null) {
    args.push("-t", String(Math.max(0.1, endSec - startSec)));
  } else if (endSec != null) {
    args.push("-to", String(endSec));
  }
  args.push(
    "-vf",
    `fps=${fps},${scaleFilter()}`,
    "-q:v",
    String(FRAME_QV),
    "-frames:v",
    String(maxFrames),
    pattern,
  );
  await execOk(ffmpeg, args, { timeoutMs: 300_000 });
  const files = await listFrames(outDir);
  const base = startSec ?? 0;
  // ffmpeg fps filter samples at 0, 1/fps, 2/fps, ...
  const times = files.map((_, i) => base + i / fps);
  await writeTimesSidecar(outDir, times);
  return { files, times };
}

export async function extractFrameAt(
  videoPath: string,
  timeSec: number,
): Promise<FrameResult> {
  const { ffmpeg } = await requireFfmpeg();
  const dir = await workSubdir("frames", hashKey(videoPath), "single");
  const out = path.join(dir, `at_${timeSec.toFixed(3).replace(".", "_")}.jpg`);
  try {
    await stat(out);
  } catch {
    await execOk(
      ffmpeg,
      [
        "-y",
        "-hide_banner",
        "-ss",
        String(Math.max(0, timeSec)),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        scaleFilter(),
        "-q:v",
        String(FRAME_QV),
        out,
      ],
      { timeoutMs: 60_000 },
    );
  }
  const st = await stat(out);
  if (!st.size) throw new Error(`Failed to extract frame at ${timeSec}s`);
  return {
    index: 0,
    timeSec,
    path: out,
    mimeType: "image/jpeg",
    width: 0,
    height: 0,
  };
}

export async function extractFrameBurst(
  videoPath: string,
  startSec: number,
  endSec: number,
  count: number,
): Promise<FrameResult[]> {
  const { ffmpeg } = await requireFfmpeg();
  const span = Math.max(0.05, endSec - startSec);
  const n = Math.max(2, Math.min(count, 30));
  const dir = await workSubdir(
    "frames",
    hashKey(`${videoPath}:${startSec}:${endSec}:${n}:v3`),
    "burst",
  );

  const fps = n / span;
  const { files, times } = await extractInterval(
    ffmpeg,
    videoPath,
    dir,
    fps,
    startSec,
    endSec,
    n,
  );
  return files.slice(0, n).map((p, i) => ({
    index: i,
    timeSec: times[i] ?? startSec + (span * i) / Math.max(1, n - 1),
    path: p,
    mimeType: "image/jpeg" as const,
    width: 0,
    height: 0,
  }));
}

export async function extractFrames(
  videoPath: string,
  opts: ExtractFramesOptions,
): Promise<FrameResult[]> {
  const { ffmpeg } = await requireFfmpeg();
  const detail = opts.detail ?? "standard";
  const maxFrames =
    opts.maxFrames ?? maxFramesForDetail(detail, opts.durationSec);
  if (maxFrames <= 0) return [];

  const mode = opts.mode ?? "both";
  const threshold = opts.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD;
  const key = hashKey(
    JSON.stringify({
      videoPath,
      mode,
      maxFrames,
      threshold,
      start: opts.startSec,
      end: opts.endSec,
      detail,
      v: 3, // bust cache after timestamp/size fixes
    }),
  );
  const dir = await workSubdir("frames", key);
  const startSec = opts.startSec ?? 0;
  const durationSec = opts.durationSec;

  // Prefer interval for stable timestamps; scene as supplement when sparse
  const pairs: Array<{ path: string; timeSec: number }> = [];

  if (mode === "scene" || mode === "both") {
    const sceneDir = path.join(dir, "scene");
    await workSubdir("frames", key, "scene");
    try {
      let files = await listFrames(sceneDir);
      let times = (await readTimesSidecar(sceneDir)) ?? [];
      if (files.length === 0) {
        const extracted = await extractWithScene(
          ffmpeg,
          videoPath,
          sceneDir,
          threshold,
          opts.startSec,
          opts.endSec,
        );
        files = extracted.files;
        times = extracted.times;
      }
      for (let i = 0; i < files.length; i++) {
        pairs.push({
          path: files[i]!,
          timeSec: times[i] ?? startSec + (i * durationSec) / Math.max(1, files.length),
        });
      }
    } catch {
      // interval fallback below
    }
  }

  const needInterval =
    mode === "interval" ||
    mode === "both" ||
    pairs.length < Math.min(4, maxFrames);

  if (needInterval) {
    const fps = fpsForDetail(detail, durationSec, maxFrames);
    const intervalDir = path.join(dir, "interval");
    await workSubdir("frames", key, "interval");
    let files = await listFrames(intervalDir);
    let times = (await readTimesSidecar(intervalDir)) ?? [];
    if (files.length < Math.min(maxFrames, 3)) {
      const extracted = await extractInterval(
        ffmpeg,
        videoPath,
        intervalDir,
        fps,
        opts.startSec,
        opts.endSec,
        maxFrames,
      );
      files = extracted.files;
      times = extracted.times;
    }
    for (let i = 0; i < files.length; i++) {
      pairs.push({
        path: files[i]!,
        timeSec: times[i] ?? startSec + i / fps,
      });
    }
  }

  // Sort by time, dedupe near-identical consecutive sizes
  pairs.sort((a, b) => a.timeSec - b.timeSec);
  const unique = await dedupePairs(pairs);
  const limited = unique.slice(0, maxFrames);

  // If still short (e.g. only scene empty), pad by re-interval at higher density
  if (limited.length < Math.min(2, maxFrames) && mode !== "scene") {
    const fps = Math.max(1, maxFrames / Math.max(durationSec, 0.5));
    const padDir = path.join(dir, "pad");
    await workSubdir("frames", key, "pad");
    const extracted = await extractInterval(
      ffmpeg,
      videoPath,
      padDir,
      fps,
      opts.startSec,
      opts.endSec,
      maxFrames,
    );
    return extracted.files.map((p, i) => ({
      index: i,
      timeSec: extracted.times[i] ?? startSec + i / fps,
      path: p,
      mimeType: "image/jpeg" as const,
      width: 0,
      height: 0,
    }));
  }

  return limited.map((p, i) => ({
    index: i,
    timeSec: Math.round(p.timeSec * 1000) / 1000,
    path: p.path,
    mimeType: "image/jpeg" as const,
    width: 0,
    height: 0,
  }));
}

async function dedupePairs(
  pairs: Array<{ path: string; timeSec: number }>,
): Promise<Array<{ path: string; timeSec: number }>> {
  const out: Array<{ path: string; timeSec: number }> = [];
  for (const p of pairs) {
    try {
      const st = await stat(p.path);
      if (st.size < 500) continue;
      const last = out[out.length - 1];
      if (last) {
        const lst = await stat(last.path);
        if (lst.size === st.size && Math.abs(last.timeSec - p.timeSec) < 0.15) {
          continue;
        }
      }
      out.push(p);
    } catch {
      // skip
    }
  }
  return out;
}

export async function readFrameBase64(framePath: string): Promise<string> {
  const buf = await readFile(framePath);
  return buf.toString("base64");
}

/** Smaller JPEG for MCP image blocks (avoids host truncation). */
export async function readInlineFrameBase64(framePath: string): Promise<string> {
  const { ffmpeg } = await requireFfmpeg();
  const dir = path.dirname(framePath);
  const base = path.basename(framePath, path.extname(framePath));
  const thumb = path.join(dir, `${base}_inline.jpg`);

  try {
    const st = await stat(thumb);
    if (st.size > 200) {
      return (await readFile(thumb)).toString("base64");
    }
  } catch {
    // create
  }

  await execOk(
    ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-i",
      framePath,
      "-vf",
      scaleFilter(INLINE_MAX_EDGE),
      "-q:v",
      String(INLINE_QV),
      thumb,
    ],
    { timeoutMs: 30_000 },
  );
  return (await readFile(thumb)).toString("base64");
}
