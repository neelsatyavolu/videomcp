import { CHARACTER_LIMIT } from "../constants.js";
import type {
  AnalyzeResult,
  FrameResult,
  TranscriptResult,
  VideoInfo,
} from "../types.js";

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "unknown";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatTime(sec: number): string {
  return formatDuration(sec);
}

export function truncateText(text: string, limit = CHARACTER_LIMIT): string {
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit - 120) +
    `\n\n…truncated (${text.length} → ${limit} chars). Use narrower tools (time range / fewer frames / fields) for more detail.`
  );
}

export function infoMarkdown(info: VideoInfo): string {
  const lines = [
    `# Video info`,
    ``,
    `- **Source**: ${info.source}`,
    `- **Path**: \`${info.path}\``,
    `- **Duration**: ${formatDuration(info.durationSec)} (${info.durationSec.toFixed(2)}s)`,
    `- **Resolution**: ${info.width}×${info.height}`,
    `- **FPS**: ${info.fps ?? "n/a"}`,
    `- **Video codec**: ${info.videoCodec ?? "n/a"}`,
    `- **Audio**: ${info.hasAudio ? info.audioCodec ?? "yes" : "none"}`,
    `- **Format**: ${info.formatName ?? "n/a"}`,
  ];
  if (info.sizeBytes != null) {
    lines.push(`- **Size**: ${(info.sizeBytes / (1024 * 1024)).toFixed(2)} MB`);
  }
  return lines.join("\n");
}

export function transcriptMarkdown(t: TranscriptResult): string {
  const lines = [
    `# Transcript`,
    ``,
    `- **Source**: ${t.source}`,
    `- **Language**: ${t.language ?? "auto"}`,
    `- **Segments**: ${t.segments.length}`,
    ``,
  ];
  for (const seg of t.segments) {
    const sp = seg.speaker ? ` ${seg.speaker}` : "";
    lines.push(`[${formatTime(seg.start)}–${formatTime(seg.end)}]${sp} ${seg.text.trim()}`);
  }
  return lines.join("\n");
}

export function framesMarkdown(frames: FrameResult[]): string {
  const lines = [`# Frames (${frames.length})`, ``];
  for (const f of frames) {
    const ocr = f.ocrText?.trim()
      ? ` — OCR: ${f.ocrText.trim().replace(/\s+/g, " ").slice(0, 120)}`
      : "";
    lines.push(`- **#${f.index}** @ ${formatTime(f.timeSec)} — \`${f.path}\`${ocr}`);
  }
  return lines.join("\n");
}

export function analyzeMarkdown(result: AnalyzeResult): string {
  const parts: string[] = [
    `# Video analysis`,
    ``,
    `- **Detail**: ${result.detail}`,
    `- **Elapsed**: ${result.elapsedMs}ms`,
    `- **OCR hits**: ${result.ocrHitCount ?? 0}`,
    ``,
  ];

  if (result.summary) {
    parts.push(`## At a glance`, ``, result.summary, ``);
  }

  parts.push(infoMarkdown(result.info), ``);

  if (result.transcript) {
    parts.push(transcriptMarkdown(result.transcript), ``);
  } else {
    parts.push(`# Transcript`, ``, `_No transcript available._`, ``);
  }

  // Highlight OCR block for agents
  const ocrFrames = result.frames.filter((f) => f.ocrText?.trim());
  if (ocrFrames.length) {
    parts.push(`# On-screen text (OCR)`, ``);
    for (const f of ocrFrames) {
      parts.push(`### @ ${formatTime(f.timeSec)}`);
      parts.push("```");
      parts.push(f.ocrText!.trim());
      parts.push("```", ``);
    }
  }

  if (result.frames.length) {
    parts.push(framesMarkdown(result.frames), ``);
  }

  if (result.timeline.length) {
    parts.push(`# Timeline`, ``);
    for (const ev of result.timeline.slice(0, 200)) {
      parts.push(`- [${formatTime(ev.timeSec)}] (${ev.kind}) ${ev.text.slice(0, 200)}`);
    }
    if (result.timeline.length > 200) {
      parts.push(`- … ${result.timeline.length - 200} more events`);
    }
    parts.push(``);
  }

  if (result.warnings.length) {
    parts.push(`# Warnings`, ``);
    for (const w of result.warnings) parts.push(`- ${w}`);
  }

  if (result.sidecarPath) {
    parts.push(``, `- **Sidecar**: \`${result.sidecarPath}\``);
  }

  return truncateText(parts.join("\n"));
}

export function toJson(data: unknown): string {
  return truncateText(JSON.stringify(data, null, 2));
}
