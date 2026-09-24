import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeVideo } from "../media/analyze.js";
import { probeVideo } from "../media/probe.js";
import { hashKey } from "../utils/paths.js";
import { dhashFile } from "./dhash.js";
import { measureClip } from "./metrics.js";
import { detectRoll } from "./rules.js";
import type { AgentName, ClipAnalysis, Judgement, Metrics, ScannedFile } from "./types.js";

const CACHE_VERSION = 1;
const MAX_FRAMES = 6;

async function fileKey(file: ScannedFile): Promise<string> {
  const st = await stat(file.path);
  return hashKey(`${file.path}|${st.size}|${st.mtimeMs}|v${CACHE_VERSION}`);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

async function allExist(paths: readonly string[]): Promise<boolean> {
  const results = await Promise.all(paths.map((p) => access(p).then(() => true, () => false)));
  return results.every(Boolean);
}

const NO_VIDEO_METRICS: Metrics = {
  blur: null,
  yavg: null,
  darkShare: 0,
  blownShare: 0,
  shake: null,
  maxVolumeDb: null,
  silentShare: 0,
  blackShare: 0,
  frozenShare: 0,
};

type CachedAnalysis = Omit<ClipAnalysis, "id" | "file">;

async function compute(file: ScannedFile): Promise<CachedAnalysis> {
  // analyzeVideo's transcription fails on clips without an audio stream, so skip it for those.
  const info = await probeVideo(file.path, file.path, "local");
  const result = await analyzeVideo(file.path, {
    detail: "standard",
    maxFrames: MAX_FRAMES,
    forceRefresh: true,
    skipTranscript: !info.hasAudio,
    skipFrames: !info.hasVideo,
  });
  const transcript = (result.transcript?.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text }));
  const framePaths = result.frames.map((f) => f.path);
  const middle = framePaths[Math.floor(framePaths.length / 2)];
  const [metrics, dhash] = await Promise.all([
    info.hasVideo
      ? measureClip(file.path, { durationSec: info.durationSec, hasAudio: info.hasAudio })
      : Promise.resolve(NO_VIDEO_METRICS),
    middle ? dhashFile(middle) : Promise.resolve(null),
  ]);
  return {
    durationSec: info.durationSec,
    hasAudio: info.hasAudio,
    hasVideo: info.hasVideo,
    width: info.width,
    height: info.height,
    transcript,
    ocr: result.frames.flatMap((f) => (f.ocrText?.trim() ? [f.ocrText.trim()] : [])),
    framePaths,
    metrics,
    dhash,
    roll: detectRoll(file.rollHint, info.durationSec, transcript),
  };
}

/** Local perception for one clip, cached on disk by (path, size, mtime). */
export async function analyzeClip(
  file: ScannedFile,
  id: string,
  cacheDir: string,
  useCache: boolean,
): Promise<ClipAnalysis> {
  const cacheFile = path.join(cacheDir, `${await fileKey(file)}.analysis.json`);
  if (useCache) {
    const hit = await readJson<CachedAnalysis>(cacheFile);
    if (hit && (await allExist(hit.framePaths))) return { ...hit, id, file };
  }
  const fresh = await compute(file);
  await writeJson(cacheFile, fresh);
  return { ...fresh, id, file };
}

async function judgementFile(cacheDir: string, file: ScannedFile, agent: AgentName): Promise<string> {
  return path.join(cacheDir, `${await fileKey(file)}.judge-${agent}.json`);
}

export async function loadJudgement(cacheDir: string, file: ScannedFile, agent: AgentName): Promise<Judgement | null> {
  return readJson<Judgement>(await judgementFile(cacheDir, file, agent));
}

export async function saveJudgement(cacheDir: string, file: ScannedFile, agent: AgentName, j: Judgement): Promise<void> {
  await writeJson(await judgementFile(cacheDir, file, agent), j);
}
