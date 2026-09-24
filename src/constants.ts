import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "video-mcp-server";
export const SERVER_VERSION = "1.2.0";

/** Soft cap on markdown/JSON text returned to agents. */
export const CHARACTER_LIMIT = 80_000;

/** Max frames returned as base64 image blocks (vision clients). Paths always included. */
export const MAX_INLINE_IMAGES = Number(process.env.VIDEO_MCP_MAX_INLINE_IMAGES ?? 6);

/**
 * Hard budget for total base64 payload (chars). Grok/hosts often truncate ~20–40KB text;
 * keep images small so vision still works without blowing the tool result.
 */
export const MAX_INLINE_BASE64_CHARS = Number(
  process.env.VIDEO_MCP_MAX_INLINE_BASE64 ?? 180_000,
);

/** Max JPEG edge length for extracted frames on disk. */
export const FRAME_MAX_EDGE = Number(process.env.VIDEO_MCP_FRAME_EDGE ?? 640);

/** Max edge for *inline* thumbs (smaller → less MCP truncation). */
export const INLINE_MAX_EDGE = Number(process.env.VIDEO_MCP_INLINE_EDGE ?? 480);

/** JPEG quality 2–31 (ffmpeg -q:v; lower is higher quality). */
export const FRAME_QV = Number(process.env.VIDEO_MCP_FRAME_QV ?? 5);

/** Inline thumb quality (more compressed). */
export const INLINE_QV = Number(process.env.VIDEO_MCP_INLINE_QV ?? 8);

/** Scene-change threshold for ffmpeg select filter. */
export const DEFAULT_SCENE_THRESHOLD = Number(process.env.VIDEO_MCP_SCENE_THRESHOLD ?? 0.28);

/** In-memory analysis cache TTL. */
export const CACHE_TTL_MS = Number(process.env.VIDEO_MCP_CACHE_TTL_MS ?? 15 * 60 * 1000);

/** Working directory for downloads, frames, audio. */
export const WORK_DIR =
  process.env.VIDEO_MCP_WORK_DIR ?? path.join(os.tmpdir(), "video-mcp-server");

export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".m4v",
  ".wmv",
  ".flv",
  ".mpeg",
  ".mpg",
  ".m2ts",
  ".mts",
  ".3gp",
  ".ogv",
  ".gif",
]);

export type DetailLevel = "brief" | "standard" | "detailed";

export function maxFramesForDetail(detail: DetailLevel, durationSec: number): number {
  if (detail === "brief") return 0;
  if (detail === "detailed") {
    if (durationSec <= 30) return 30;
    if (durationSec <= 120) return 48;
    return 60;
  }
  // standard — duration adaptive
  if (durationSec <= 15) return 8;
  if (durationSec <= 60) return 16;
  if (durationSec <= 300) return 24;
  if (durationSec <= 900) return 36;
  return 48;
}

export function fpsForDetail(
  detail: DetailLevel,
  durationSec: number,
  maxFramesOverride?: number,
): number {
  const target = maxFramesOverride ?? maxFramesForDetail(detail, durationSec);
  if (target <= 0 || durationSec <= 0) return 0.25;
  const fps = target / Math.max(durationSec, 0.5);
  const cap = durationSec <= 15 ? 4 : durationSec <= 60 ? 2 : 1;
  const floor = detail === "detailed" ? 0.25 : 0.1;
  return Math.min(cap, Math.max(floor, fps));
}
