import { analysisCache } from "../utils/cache.js";
import { cacheKeyForFile } from "../utils/paths.js";
import { stat } from "node:fs/promises";
import type { AnalyzeResult, FrameResult } from "../types.js";
import type { DetailLevel } from "../constants.js";
import { extractFrames } from "./frames.js";
import { ocrFrames } from "./ocr.js";
import { probeVideo } from "./probe.js";
import { resolveSource } from "./resolve.js";
import { maybeWriteSidecar } from "./sidecar.js";
import { buildTimeline } from "./timeline.js";
import { transcribeVideo } from "./transcribe.js";
import { formatDuration } from "../utils/format.js";

export interface AnalyzeOptions {
  detail?: DetailLevel;
  maxFrames?: number;
  language?: string;
  startSec?: number;
  endSec?: number;
  skipFrames?: boolean;
  skipTranscript?: boolean;
  skipOcr?: boolean;
  forceRefresh?: boolean;
  mode?: "scene" | "interval" | "both";
}

function buildSummary(result: AnalyzeResult): string {
  const { info, transcript, frames, warnings } = result;
  const bits: string[] = [];
  bits.push(
    `${formatDuration(info.durationSec)} · ${info.width}×${info.height}` +
      (info.fps ? ` · ${info.fps}fps` : "") +
      (info.hasAudio ? " · has audio" : " · no audio"),
  );

  if (transcript?.fullText?.trim()) {
    const preview = transcript.fullText.replace(/\s+/g, " ").trim().slice(0, 220);
    bits.push(
      `Speech (${transcript.source}, ${transcript.segments.length} segs): “${preview}${transcript.fullText.length > 220 ? "…" : ""}”`,
    );
  } else if (info.hasAudio) {
    bits.push("No transcript (captions/Whisper unavailable or silent).");
  }

  const ocrBits = frames
    .filter((f) => f.ocrText?.trim())
    .map((f) => `[${formatDuration(f.timeSec)}] ${f.ocrText!.replace(/\s+/g, " ").trim().slice(0, 80)}`);
  if (ocrBits.length) {
    bits.push(`On-screen text (${ocrBits.length} frames):\n  - ${ocrBits.slice(0, 6).join("\n  - ")}`);
  }

  bits.push(`${frames.length} keyframe(s) extracted`);
  if (warnings.length) bits.push(`${warnings.length} warning(s)`);

  return bits.join("\n");
}

export async function analyzeVideo(
  source: string,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const started = Date.now();
  const detail = opts.detail ?? "standard";
  const warnings: string[] = [];

  const resolved = await resolveSource(source);
  warnings.push(...resolved.warnings);

  const st = await stat(resolved.path);
  const cacheKey = cacheKeyForFile(
    resolved.path,
    st.mtimeMs,
    st.size,
    JSON.stringify({
      detail,
      maxFrames: opts.maxFrames,
      language: opts.language,
      start: opts.startSec,
      end: opts.endSec,
      skipFrames: opts.skipFrames,
      skipTranscript: opts.skipTranscript,
      skipOcr: opts.skipOcr,
      mode: opts.mode,
      v: 4,
    }),
  );

  if (!opts.forceRefresh) {
    const hit = analysisCache.get(cacheKey) as AnalyzeResult | undefined;
    if (hit) return { ...hit, elapsedMs: Date.now() - started };
  }

  const info = await probeVideo(resolved.path, resolved.source, resolved.sourceKind);

  const wantFrames = !opts.skipFrames && detail !== "brief";
  const wantTranscript = !opts.skipTranscript;
  // brief: still allow OCR on a couple frames if frames requested later — skip for speed
  const wantOcr =
    !opts.skipOcr &&
    wantFrames &&
    process.env.VIDEO_MCP_DISABLE_OCR !== "1";

  const [transcriptOut, framesOut] = await Promise.all([
    wantTranscript
      ? transcribeVideo(resolved.path, {
          language: opts.language,
          captionsPath: resolved.captionsPath,
        })
      : Promise.resolve({ transcript: null, warnings: [] as string[] }),
    wantFrames
      ? extractFrames(resolved.path, {
          durationSec: info.durationSec,
          detail,
          maxFrames: opts.maxFrames,
          startSec: opts.startSec,
          endSec: opts.endSec,
          mode: opts.mode,
        })
      : Promise.resolve([] as FrameResult[]),
  ]);

  warnings.push(...transcriptOut.warnings);

  let frames = framesOut;
  if (detail === "brief") frames = [];

  let ocrHitCount = 0;
  if (wantOcr && frames.length) {
    const maxOcr =
      detail === "detailed"
        ? Math.min(20, frames.length)
        : Math.min(12, frames.length);
    const ocr = await ocrFrames(frames, maxOcr, 3);
    ocrHitCount = ocr.ocrCount;
    warnings.push(...ocr.warnings);
  }

  const timeline = buildTimeline(transcriptOut.transcript, frames);

  const result: AnalyzeResult = {
    info: resolved.title
      ? { ...info, source: `${resolved.source} (${resolved.title})` }
      : info,
    transcript: transcriptOut.transcript,
    frames,
    timeline,
    warnings,
    detail,
    elapsedMs: Date.now() - started,
    ocrHitCount,
  };
  result.summary = buildSummary(result);

  try {
    result.sidecarPath = await maybeWriteSidecar(resolved.path, result);
    if (result.sidecarPath) {
      warnings.push(`Wrote sidecar: ${result.sidecarPath}`);
      result.warnings = warnings;
      result.summary = buildSummary(result);
    }
  } catch (err) {
    warnings.push(
      `Sidecar write failed: ${err instanceof Error ? err.message : err}`,
    );
    result.warnings = warnings;
  }

  analysisCache.set(cacheKey, result);
  return result;
}
