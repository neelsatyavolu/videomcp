import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireFfmpeg } from "../media/deps.js";
import { execFile } from "../utils/exec.js";
import type { Metrics } from "./types.js";

const SAMPLE_FPS = 2;
/** Frames are scaled to this width first, so deshake offsets are relative to it. */
const ANALYSIS_WIDTH = 640;
const DARK_YAVG = 25;
const BLOWN_YAVG = 235;
const MEASURE_TIMEOUT_MS = 20 * 60 * 1000;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** ffmpeg args for the single measuring pass. Paths must not need filter-graph escaping. */
export function metricsArgs(input: string, metaFile: string, deshakeFile: string, hasAudio: boolean): string[] {
  const vf = [
    `fps=${SAMPLE_FPS}`,
    `scale=${ANALYSIS_WIDTH}:-2`,
    `deshake=filename=${deshakeFile}`,
    "blurdetect",
    "signalstats",
    "blackdetect=d=0.5:pix_th=0.1",
    "freezedetect=n=0.003:d=2",
    `metadata=print:file=${metaFile}`,
  ].join(",");
  const audio = hasAudio ? ["-map", "0:a:0?", "-af", "volumedetect,silencedetect=n=-45dB:d=1"] : [];
  return ["-hide_banner", "-nostats", "-i", input, "-map", "0:v:0", "-vf", vf, ...audio, "-f", "null", "-"];
}

export function parseMetadataFile(text: string): Pick<Metrics, "blur" | "yavg" | "darkShare" | "blownShare"> {
  const blurs: number[] = [];
  const yavgs: number[] = [];
  for (const line of text.split("\n")) {
    const blur = /^lavfi\.blur=(.+)$/.exec(line);
    if (blur) {
      const v = Number(blur[1]);
      if (Number.isFinite(v)) blurs.push(v);
      continue;
    }
    const yavg = /^lavfi\.signalstats\.YAVG=(.+)$/.exec(line);
    if (yavg) {
      const v = Number(yavg[1]);
      if (Number.isFinite(v)) yavgs.push(v);
    }
  }
  if (!yavgs.length) return { blur: median(blurs), yavg: null, darkShare: 0, blownShare: 0 };
  return {
    blur: median(blurs),
    yavg: yavgs.reduce((a, b) => a + b, 0) / yavgs.length,
    darkShare: yavgs.filter((v) => v < DARK_YAVG).length / yavgs.length,
    blownShare: yavgs.filter((v) => v > BLOWN_YAVG).length / yavgs.length,
  };
}

/** RMS of deshake's final x/y correction (the high-frequency jitter), relative to frame width. */
export function parseDeshakeLog(text: string, width: number): number | null {
  const rows = text
    .split("\n")
    .slice(1)
    .map((line) => line.split(",").map((c) => Number(c.trim())))
    .filter((cols) => cols.length >= 6 && Number.isFinite(cols[2]) && Number.isFinite(cols[5]));
  if (!rows.length || width <= 0) return null;
  const meanSq = rows.reduce((acc, c) => acc + c[2]! ** 2 + c[5]! ** 2, 0) / rows.length;
  return Math.sqrt(meanSq) / width;
}

/**
 * Sums start/end intervals. An interval still open at the end, or closing within one sample
 * period of it (video filters stop at the last sampled frame), runs to durationSec.
 */
function intervalShare(stderr: string, startRe: RegExp, endRe: RegExp, durationSec: number): number {
  if (durationSec <= 0) return 0;
  const events: { t: number; start: boolean }[] = [];
  for (const m of stderr.matchAll(startRe)) events.push({ t: Number(m[1]), start: true });
  for (const m of stderr.matchAll(endRe)) events.push({ t: Number(m[1]), start: false });
  events.sort((a, b) => a.t - b.t || (a.start ? 1 : -1));
  let total = 0;
  let openAt: number | null = null;
  for (const e of events) {
    if (e.start && openAt === null) openAt = e.t;
    else if (!e.start && openAt !== null) {
      const end = durationSec - e.t <= 1 / SAMPLE_FPS ? durationSec : e.t;
      total += end - openAt;
      openAt = null;
    }
  }
  if (openAt !== null) total += durationSec - openAt;
  return clamp01(total / durationSec);
}

export function parseStderr(
  stderr: string,
  durationSec: number,
): Pick<Metrics, "maxVolumeDb" | "silentShare" | "blackShare" | "frozenShare"> {
  const vol = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  return {
    maxVolumeDb: vol ? (vol[1] === "-inf" ? -Infinity : Number(vol[1])) : null,
    silentShare: intervalShare(stderr, /silence_start:\s*(-?[\d.]+)/g, /silence_end:\s*([\d.]+)/g, durationSec),
    blackShare: intervalShare(stderr, /black_start:\s*([\d.]+)/g, /black_end:\s*([\d.]+)/g, durationSec),
    frozenShare: intervalShare(stderr, /freeze_start:\s*([\d.]+)/g, /freeze_end:\s*([\d.]+)/g, durationSec),
  };
}

/** One ffmpeg pass over the clip; scratch files live in a private temp dir. */
export async function measureClip(
  input: string,
  info: { durationSec: number; hasAudio: boolean },
): Promise<Metrics> {
  const { ffmpeg } = await requireFfmpeg();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "footage-sort-"));
  const metaFile = path.join(scratch, "meta.txt");
  const deshakeFile = path.join(scratch, "deshake.log");
  try {
    const res = await execFile(ffmpeg, metricsArgs(input, metaFile, deshakeFile, info.hasAudio), {
      timeoutMs: MEASURE_TIMEOUT_MS,
    });
    if (res.code !== 0) throw new Error(`ffmpeg metrics failed: ${res.stderr.trim().slice(-500)}`);
    const [meta, deshake] = await Promise.all([
      readFile(metaFile, "utf8").catch(() => ""),
      readFile(deshakeFile, "utf8").catch(() => ""),
    ]);
    return {
      ...parseMetadataFile(meta),
      shake: parseDeshakeLog(deshake, ANALYSIS_WIDTH),
      ...parseStderr(res.stderr, info.durationSec),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
