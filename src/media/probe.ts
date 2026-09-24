import { stat } from "node:fs/promises";
import { infoCache } from "../utils/cache.js";
import { execOk } from "../utils/exec.js";
import { cacheKeyForFile } from "../utils/paths.js";
import type { VideoInfo } from "../types.js";
import { requireFfmpeg } from "./deps.js";

interface FfprobeJson {
  format?: {
    filename?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    format_name?: string;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }>;
}

function parseFps(rate?: string): number | null {
  if (!rate || rate === "0/0") return null;
  const [a, b] = rate.split("/").map(Number);
  if (!b) return Number.isFinite(a) ? a : null;
  const v = a / b;
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}

export async function probeVideo(
  filePath: string,
  source: string,
  sourceKind: VideoInfo["sourceKind"],
): Promise<VideoInfo> {
  const st = await stat(filePath);
  const key = cacheKeyForFile(filePath, st.mtimeMs, st.size, "probe");
  const cached = infoCache.get(key) as VideoInfo | undefined;
  if (cached) return { ...cached, source, sourceKind, path: filePath };

  const { ffprobe } = await requireFfmpeg();
  const { stdout } = await execOk(
    ffprobe,
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { timeoutMs: 60_000 },
  );

  const data = JSON.parse(stdout) as FfprobeJson;
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const durationSec = Number(data.format?.duration ?? 0) || 0;

  const info: VideoInfo = {
    path: filePath,
    source,
    sourceKind,
    durationSec,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: parseFps(v?.avg_frame_rate) ?? parseFps(v?.r_frame_rate),
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    hasAudio: Boolean(a),
    hasVideo: Boolean(v),
    bitrate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
    sizeBytes: data.format?.size ? Number(data.format.size) : st.size,
    formatName: data.format?.format_name ?? null,
  };

  infoCache.set(key, info);
  return info;
}
