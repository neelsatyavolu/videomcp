import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile, execOk, which } from "../utils/exec.js";
import { hashKey, workSubdir } from "../utils/paths.js";
import type { TranscriptResult, TranscriptSegment } from "../types.js";
import { requireFfmpeg } from "./deps.js";
import { loadSidecarCaptions, parseVtt } from "./resolve.js";
import {
  resolveWhisperCppBin,
  resolveWhisperCppModel,
} from "./whisper-paths.js";

async function extractAudioWav(videoPath: string): Promise<string> {
  const { ffmpeg } = await requireFfmpeg();
  const dir = await workSubdir("audio", hashKey(videoPath));
  const out = path.join(dir, "audio.wav");
  try {
    await access(out);
    return out;
  } catch {
    // continue
  }

  // Mono 16kHz — optimal for Whisper speed/quality balance
  await execOk(
    ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      out,
    ],
    { timeoutMs: 300_000 },
  );
  return out;
}

async function isSilent(videoPath: string): Promise<boolean> {
  const { ffmpeg } = await requireFfmpeg();
  try {
    const r = await execFile(
      ffmpeg,
      [
        "-hide_banner",
        "-t",
        "120",
        "-i",
        videoPath,
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 60_000 },
    );
    const m = /mean_volume:\s*([-\d.]+)/.exec(r.stderr);
    if (!m) return false;
    const mean = Number(m[1]);
    // near digital silence
    return mean < -50;
  } catch {
    return false;
  }
}

function segmentsToResult(
  segments: TranscriptSegment[],
  source: string,
  language: string | null,
): TranscriptResult {
  return {
    segments,
    language,
    source,
    fullText: segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim(),
  };
}

async function transcribeWhisperCli(
  wavPath: string,
  language?: string,
): Promise<TranscriptResult | null> {
  const bin =
    process.env.WHISPER_BIN ||
    (await which("whisper")) ||
    (await which("whisper-ctranslate2"));
  if (!bin) return null;

  const model = process.env.WHISPER_MODEL || "base";
  const outDir = path.dirname(wavPath);
  const args = [
    wavPath,
    "--model",
    model,
    "--output_dir",
    outDir,
    "--output_format",
    "json",
    "--verbose",
    "False",
  ];
  const lang = language || process.env.WHISPER_LANGUAGE;
  if (lang) args.push("--language", lang);
  if (process.env.WHISPER_DEVICE) args.push("--device", process.env.WHISPER_DEVICE);
  if (process.env.WHISPER_COMPUTE) {
    args.push("--compute_type", process.env.WHISPER_COMPUTE);
  }
  if (process.env.WHISPER_PROMPT) args.push("--initial_prompt", process.env.WHISPER_PROMPT);

  const r = await execFile(bin, args, {
    timeoutMs: 1_200_000,
    env: { PYTHONUTF8: "1" },
  });
  if (r.code !== 0) {
    throw new Error(`whisper CLI failed: ${(r.stderr || r.stdout).slice(0, 1500)}`);
  }

  const base = path.basename(wavPath, path.extname(wavPath));
  const jsonPath = path.join(outDir, `${base}.json`);
  try {
    const raw = JSON.parse(await readFile(jsonPath, "utf8")) as {
      language?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
      text?: string;
    };
    const segments: TranscriptSegment[] = (raw.segments ?? []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));
    if (!segments.length && raw.text) {
      segments.push({ start: 0, end: 0, text: raw.text.trim() });
    }
    return segmentsToResult(segments, `whisper-cli:${model}`, raw.language ?? lang ?? null);
  } catch {
    // try vtt
    const vttPath = path.join(outDir, `${base}.vtt`);
    try {
      const vtt = await readFile(vttPath, "utf8");
      return segmentsToResult(parseVtt(vtt), `whisper-cli:${model}`, lang ?? null);
    } catch {
      return null;
    }
  }
}

async function transcribeWhisperCpp(
  wavPath: string,
  language?: string,
): Promise<TranscriptResult | null> {
  const bin = await resolveWhisperCppBin();
  if (!bin) return null;

  const model = await resolveWhisperCppModel();
  if (!model) {
    throw new Error(
      "whisper-cli found but no ggml model. Run: video-mcp setup  (downloads ggml-base.bin)",
    );
  }
  return transcribeWhisperCppWithModel(bin, wavPath, model, language);
}

async function transcribeWhisperCppWithModel(
  bin: string,
  wavPath: string,
  model: string,
  language?: string,
): Promise<TranscriptResult | null> {
  const outBase = path.join(path.dirname(wavPath), "cpp");
  const args = ["-m", model, "-f", wavPath, "-otxt", "-ovtt", "-of", outBase];
  const lang = language || process.env.WHISPER_LANGUAGE;
  if (lang) args.push("-l", lang);

  const r = await execFile(bin, args, { timeoutMs: 1_200_000 });
  if (r.code !== 0) {
    throw new Error(`whisper.cpp failed: ${(r.stderr || r.stdout).slice(0, 1500)}`);
  }

  try {
    const vtt = await readFile(`${outBase}.vtt`, "utf8");
    return segmentsToResult(parseVtt(vtt), "whisper.cpp", lang ?? null);
  } catch {
    try {
      const txt = (await readFile(`${outBase}.txt`, "utf8")).trim();
      if (!txt) return null;
      return segmentsToResult([{ start: 0, end: 0, text: txt }], "whisper.cpp", lang ?? null);
    } catch {
      return null;
    }
  }
}

async function transcribeOpenAI(
  wavPath: string,
  language?: string,
): Promise<TranscriptResult | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const buf = await readFile(wavPath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buf)], { type: "audio/wav" }),
    "audio.wav",
  );
  form.append("model", process.env.OPENAI_WHISPER_MODEL || "whisper-1");
  form.append("response_format", "verbose_json");
  const lang = language || process.env.WHISPER_LANGUAGE;
  if (lang) form.append("language", lang);
  if (process.env.WHISPER_PROMPT) form.append("prompt", process.env.WHISPER_PROMPT);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI Whisper API failed (${res.status}): ${errText.slice(0, 800)}`);
  }
  const data = (await res.json()) as {
    text?: string;
    language?: string;
    segments?: Array<{ start: number; end: number; text: string }>;
  };
  const segments: TranscriptSegment[] = (data.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));
  if (!segments.length && data.text) {
    segments.push({ start: 0, end: 0, text: data.text.trim() });
  }
  return segmentsToResult(segments, "openai-whisper-api", data.language ?? lang ?? null);
}

export interface TranscribeOptions {
  language?: string;
  forceWhisper?: boolean;
  captionsPath?: string;
}

export async function transcribeVideo(
  videoPath: string,
  opts: TranscribeOptions = {},
): Promise<{ transcript: TranscriptResult | null; warnings: string[] }> {
  const warnings: string[] = [];

  // 1. Sidecar captions next to local file
  if (!opts.forceWhisper) {
    const side = await loadSidecarCaptions(videoPath);
    if (side) {
      return {
        transcript: segmentsToResult(side.segments, `sidecar:${path.basename(side.path)}`, null),
        warnings,
      };
    }
  }

  // 2. Captions from yt-dlp download dir
  if (opts.captionsPath && !opts.forceWhisper) {
    try {
      const vtt = await readFile(opts.captionsPath, "utf8");
      const segs = parseVtt(vtt);
      if (segs.length) {
        return {
          transcript: segmentsToResult(
            segs,
            `captions:${path.basename(opts.captionsPath)}`,
            process.env.WHISPER_LANGUAGE ?? null,
          ),
          warnings,
        };
      }
    } catch {
      warnings.push("Caption file unreadable; falling back to ASR.");
    }
  }

  // Also scan sibling vtts in same folder (yt-dlp)
  if (!opts.forceWhisper) {
    try {
      const dir = path.dirname(videoPath);
      const files = await readdir(dir);
      const vtt = files.find((f) => f.endsWith(".vtt"));
      if (vtt) {
        const segs = parseVtt(await readFile(path.join(dir, vtt), "utf8"));
        if (segs.length) {
          return {
            transcript: segmentsToResult(segs, `captions:${vtt}`, null),
            warnings,
          };
        }
      }
    } catch {
      // ignore
    }
  }

  if (await isSilent(videoPath)) {
    warnings.push(
      "Audio track appears silent (mean volume < -50 dB). Empty transcript is expected, not an error.",
    );
    return {
      transcript: segmentsToResult([], "silent", null),
      warnings,
    };
  }

  const wav = await extractAudioWav(videoPath);

  // Cache successful ASR next to wav
  const cacheJson = path.join(path.dirname(wav), "transcript.json");
  if (!opts.forceWhisper) {
    try {
      await access(cacheJson);
      const cached = JSON.parse(await readFile(cacheJson, "utf8")) as TranscriptResult;
      if (cached?.segments) return { transcript: cached, warnings };
    } catch {
      // miss
    }
  }

  const backends: Array<() => Promise<TranscriptResult | null>> = [
    () => transcribeWhisperCpp(wav, opts.language),
    () => transcribeWhisperCli(wav, opts.language),
    () => transcribeOpenAI(wav, opts.language),
  ];

  let lastErr: string | null = null;
  for (const run of backends) {
    try {
      const result = await run();
      if (result && (result.segments.length || result.fullText)) {
        await writeFile(cacheJson, JSON.stringify(result, null, 2), "utf8");
        return { transcript: result, warnings };
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      warnings.push(lastErr);
    }
  }

  warnings.push(
    lastErr
      ? `No transcript backend succeeded. Last error: ${lastErr}`
      : "No transcript backend available. Install whisper (`pip install -U openai-whisper`) or whisper.cpp, or set OPENAI_API_KEY. Platform captions are used automatically when present.",
  );
  return { transcript: null, warnings };
}
