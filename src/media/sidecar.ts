import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnalyzeResult } from "../types.js";

/**
 * Persist a compact analysis next to local videos for resume / external tools.
 * Enable with VIDEO_MCP_WRITE_SIDECARS=1
 */
export async function maybeWriteSidecar(
  videoPath: string,
  result: AnalyzeResult,
): Promise<string | null> {
  if (process.env.VIDEO_MCP_WRITE_SIDECARS !== "1") return null;
  if (result.info.sourceKind !== "local") return null;

  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  const out = path.join(dir, `${stem}.videomcp.json`);

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: result.info.source,
    detail: result.detail,
    elapsedMs: result.elapsedMs,
    info: {
      durationSec: result.info.durationSec,
      width: result.info.width,
      height: result.info.height,
      fps: result.info.fps,
      hasAudio: result.info.hasAudio,
    },
    transcript: result.transcript
      ? {
          source: result.transcript.source,
          language: result.transcript.language,
          fullText: result.transcript.fullText,
          segments: result.transcript.segments,
        }
      : null,
    frames: result.frames.map((f) => ({
      index: f.index,
      timeSec: f.timeSec,
      path: f.path,
      ocrText: f.ocrText,
    })),
    ocrTexts: result.frames
      .filter((f) => f.ocrText?.trim())
      .map((f) => ({ timeSec: f.timeSec, text: f.ocrText })),
    warnings: result.warnings,
  };

  await writeFile(out, JSON.stringify(payload, null, 2), "utf8");
  return out;
}
