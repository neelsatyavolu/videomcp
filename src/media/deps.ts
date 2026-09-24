import { execFile, which } from "../utils/exec.js";
import type { DepStatus } from "../types.js";
import {
  resolveWhisperCppBin,
  resolveWhisperCppModel,
} from "./whisper-paths.js";

async function versionOf(bin: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await execFile(bin, args, { timeoutMs: 8_000 });
    const text = (r.stdout || r.stderr).trim().split("\n")[0] ?? "";
    return text.slice(0, 120) || undefined;
  } catch {
    return undefined;
  }
}

export async function checkDeps(): Promise<DepStatus[]> {
  const ffmpeg = await which("ffmpeg");
  const ffprobe = await which("ffprobe");
  const ytdlp = await which("yt-dlp");
  const whisperCli = (await which("whisper")) ?? (await which("whisper-ctranslate2"));
  const whisperCppPath = await resolveWhisperCppBin();
  const whisperModel = await resolveWhisperCppModel();
  const tesseract =
    process.env.TESSERACT_BIN || (await which("tesseract"));

  const asrReady = Boolean(
    (whisperCppPath && whisperModel) ||
      whisperCli ||
      process.env.OPENAI_API_KEY,
  );

  const deps: DepStatus[] = [
    {
      name: "ffmpeg",
      available: Boolean(ffmpeg),
      path: ffmpeg ?? undefined,
      version: ffmpeg ? await versionOf(ffmpeg, ["-version"]) : undefined,
      note: ffmpeg ? "Required" : "NEEDED. Install: brew install ffmpeg",
    },
    {
      name: "ffprobe",
      available: Boolean(ffprobe),
      path: ffprobe ?? undefined,
      version: ffprobe ? await versionOf(ffprobe, ["-version"]) : undefined,
      note: ffprobe ? "Required" : "NEEDED (ships with ffmpeg).",
    },
    {
      name: "yt-dlp",
      available: Boolean(ytdlp),
      path: ytdlp ?? undefined,
      version: ytdlp ? await versionOf(ytdlp, ["--version"]) : undefined,
      note: ytdlp
        ? "Optional — YouTube/TikTok/etc."
        : "Optional. brew install yt-dlp",
    },
    {
      name: "whisper.cpp",
      available: Boolean(whisperCppPath),
      path: whisperCppPath ?? undefined,
      note: whisperCppPath
        ? "NEEDED — local ASR (whisper-cli)"
        : "NEEDED. Run: video-mcp setup   or: brew install whisper-cpp",
    },
    {
      name: "whisper_model",
      available: Boolean(whisperModel),
      path: whisperModel ?? undefined,
      note: whisperModel
        ? "NEEDED — ggml model for whisper.cpp"
        : "NEEDED. Run: video-mcp setup   (downloads ggml-base.bin)",
    },
    {
      name: "whisper",
      available: Boolean(whisperCli),
      path: whisperCli ?? undefined,
      note: whisperCli
        ? "Optional alt ASR (openai-whisper CLI)"
        : "Optional alt. pip install -U openai-whisper",
    },
    {
      name: "openai_whisper_api",
      available: Boolean(process.env.OPENAI_API_KEY),
      note: process.env.OPENAI_API_KEY
        ? "Optional cloud ASR fallback"
        : "Optional. set OPENAI_API_KEY",
    },
    {
      name: "tesseract",
      available: Boolean(tesseract),
      path: tesseract || undefined,
      version: tesseract ? await versionOf(tesseract, ["--version"]) : undefined,
      note: tesseract
        ? "NEEDED — OCR for on-screen text"
        : "NEEDED. Run: video-mcp setup   or: brew install tesseract",
    },
    {
      name: "asr_ready",
      available: asrReady,
      note: asrReady
        ? "Speech transcription can run"
        : "No ASR backend ready — install whisper-cpp + model via video-mcp setup",
    },
  ];

  return deps;
}

export async function requireFfmpeg(): Promise<{ ffmpeg: string; ffprobe: string }> {
  const ffmpeg = await which("ffmpeg");
  const ffprobe = await which("ffprobe");
  if (!ffmpeg || !ffprobe) {
    throw new Error(
      "ffmpeg/ffprobe not found on PATH. Install with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux).",
    );
  }
  return { ffmpeg, ffprobe };
}
