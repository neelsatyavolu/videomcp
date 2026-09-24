import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { which, execOk, execFile } from "../utils/exec.js";
import {
  hashKey,
  isHttpUrl,
  resolveLocalPath,
  workSubdir,
} from "../utils/paths.js";
import type { TranscriptSegment } from "../types.js";

export interface ResolvedMedia {
  path: string;
  source: string;
  sourceKind: "local" | "url" | "youtube_dl";
  title?: string;
  captionsPath?: string;
  captionsText?: string;
  warnings: string[];
}

function parseVtt(content: string): TranscriptSegment[] {
  const lines = content.replace(/\r/g, "").split("\n");
  const segments: TranscriptSegment[] = [];
  let i = 0;
  const ts =
    /(\d{1,2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(\d{1,2}:)?\d{2}:\d{2}\.\d{3}/;

  const toSec = (t: string): number => {
    const parts = t.split(":");
    if (parts.length === 3) {
      return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
    }
    return Number(parts[0]) * 60 + Number(parts[1]);
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (ts.test(line)) {
      const [startRaw, endRaw] = line.split("-->").map((s) => s.trim().split(" ")[0] ?? "");
      const start = toSec(startRaw);
      const end = toSec(endRaw);
      i += 1;
      const textLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim() !== "") {
        const l = (lines[i] ?? "").replace(/<[^>]+>/g, "").trim();
        if (l && !/^\d+$/.test(l)) textLines.push(l);
        i += 1;
      }
      const text = textLines.join(" ").trim();
      if (text) segments.push({ start, end, text });
    } else {
      i += 1;
    }
  }

  // Collapse near-duplicate rolling auto-captions
  const collapsed: TranscriptSegment[] = [];
  for (const seg of segments) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.text === seg.text && seg.start - prev.end < 0.5) {
      prev.end = seg.end;
      continue;
    }
    if (prev && seg.text.startsWith(prev.text) && seg.text.length > prev.text.length) {
      prev.end = seg.end;
      prev.text = seg.text;
      continue;
    }
    collapsed.push({ ...seg });
  }
  return collapsed;
}

export async function loadSidecarCaptions(
  videoPath: string,
): Promise<{ path: string; segments: TranscriptSegment[] } | null> {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const candidates = [
    `${base}.vtt`,
    `${base}.srt`,
    `${base}.en.vtt`,
    `${base}.en.srt`,
  ].map((f) => path.join(dir, f));

  for (const c of candidates) {
    try {
      await access(c);
      const raw = await readFile(c, "utf8");
      let vtt = raw;
      if (c.endsWith(".srt")) {
        vtt = srtToVtt(raw);
      }
      const segments = parseVtt(vtt);
      if (segments.length) return { path: c, segments };
    } catch {
      // next
    }
  }
  return null;
}

function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r/g, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${body}`;
}

export { parseVtt };

export async function resolveSource(source: string): Promise<ResolvedMedia> {
  const warnings: string[] = [];
  const trimmed = source.trim();

  if (!isHttpUrl(trimmed)) {
    const local = await resolveLocalPath(trimmed);
    return {
      path: local,
      source: trimmed,
      sourceKind: "local",
      warnings,
    };
  }

  // Direct media URL vs platform page
  const urlPath = new URL(trimmed).pathname.toLowerCase();
  const looksDirect =
    /\.(mp4|mov|mkv|webm|m4v|avi)(\?|$)/i.test(urlPath) ||
    trimmed.includes("googlevideo.com") ||
    trimmed.includes("cdn");

  const ytdlp = await which("yt-dlp");
  if (!ytdlp && !looksDirect) {
    throw new Error(
      `URL requires yt-dlp for download/captions: ${trimmed}. Install: brew install yt-dlp`,
    );
  }

  if (!ytdlp && looksDirect) {
    // Download with curl/ffmpeg later via ffmpeg protocol — copy with ffmpeg
    const dir = await workSubdir("downloads", hashKey(trimmed));
    const out = path.join(dir, "video.mp4");
    try {
      await access(out);
      return { path: out, source: trimmed, sourceKind: "url", warnings };
    } catch {
      // fall through to ffmpeg download
    }
    const { requireFfmpeg } = await import("./deps.js");
    const { ffmpeg } = await requireFfmpeg();
    await execOk(ffmpeg, ["-y", "-i", trimmed, "-c", "copy", out], {
      timeoutMs: 600_000,
    });
    return { path: out, source: trimmed, sourceKind: "url", warnings };
  }

  if (!ytdlp) {
    throw new Error("yt-dlp not found");
  }

  const dir = await workSubdir("downloads", hashKey(trimmed));
  const outTemplate = path.join(dir, "video.%(ext)s");

  // Reuse existing download
  const existing = await findDownloadedVideo(dir);
  if (existing) {
    const caps = await findCaptionFile(dir);
    return {
      path: existing,
      source: trimmed,
      sourceKind: "youtube_dl",
      captionsPath: caps ?? undefined,
      warnings,
    };
  }

  const args = [
    "--no-playlist",
    "-f",
    "bv*[height<=1080]+ba/b[height<=1080]/b",
    "--merge-output-format",
    "mp4",
    "-o",
    outTemplate,
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs",
    process.env.WHISPER_LANGUAGE
      ? `${process.env.WHISPER_LANGUAGE}.*`
      : "en.*,en",
    "--convert-subs",
    "vtt",
    "--no-warnings",
    trimmed,
  ];

  if (process.env.YTDLP_COOKIES) {
    args.unshift("--cookies", process.env.YTDLP_COOKIES);
  } else if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
    args.unshift("--cookies-from-browser", process.env.YTDLP_COOKIES_FROM_BROWSER);
  }

  const result = await execFile(ytdlp, args, { timeoutMs: 900_000 });
  if (result.code !== 0) {
    throw new Error(
      `yt-dlp failed for ${trimmed}: ${(result.stderr || result.stdout).slice(0, 1500)}`,
    );
  }

  const videoPath = await findDownloadedVideo(dir);
  if (!videoPath) {
    throw new Error(`yt-dlp finished but no video found in ${dir}`);
  }

  // Title via dump
  let title: string | undefined;
  try {
    const meta = await execOk(
      ytdlp,
      ["--skip-download", "--print", "%(title)s", trimmed],
      { timeoutMs: 60_000 },
    );
    title = meta.stdout.trim().split("\n")[0] || undefined;
    if (title) {
      await writeFile(path.join(dir, "title.txt"), title, "utf8");
    }
  } catch {
    warnings.push("Could not fetch video title via yt-dlp.");
  }

  const caps = await findCaptionFile(dir);
  return {
    path: videoPath,
    source: trimmed,
    sourceKind: "youtube_dl",
    title,
    captionsPath: caps ?? undefined,
    warnings,
  };
}

async function findDownloadedVideo(dir: string): Promise<string | null> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const vids = files.filter((f) =>
    /\.(mp4|mkv|webm|mov|m4a)$/i.test(f),
  );
  if (!vids.length) return null;
  // Prefer mp4
  vids.sort((a, b) => Number(b.endsWith(".mp4")) - Number(a.endsWith(".mp4")));
  return path.join(dir, vids[0]!);
}

async function findCaptionFile(dir: string): Promise<string | null> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const vtts = files.filter((f) => f.endsWith(".vtt"));
  if (!vtts.length) return null;
  // Prefer non-auto if both
  vtts.sort((a, b) => {
    const aa = a.includes("auto") ? 1 : 0;
    const bb = b.includes("auto") ? 1 : 0;
    return aa - bb;
  });
  return path.join(dir, vtts[0]!);
}
