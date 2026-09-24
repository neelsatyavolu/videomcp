import path from "node:path";
import { formatDuration } from "../utils/format.js";
import { JUDGE_ISSUES, type ClipAnalysis, type Roll, type Verdict } from "./types.js";

const TRANSCRIPT_BUDGET = 4_000;
const OCR_BUDGET = 800;
const GROUP_BUDGET = 150_000;

export type ImageMode = "paths" | "attached" | "none";

function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function transcriptText(a: ClipAnalysis): string {
  if (!a.transcript.length) return "(no speech detected)";
  const text = a.transcript.map((s) => `[${mmss(s.start)}] ${s.text.trim()}`).join("\n");
  return text.length > TRANSCRIPT_BUDGET ? `${text.slice(0, TRANSCRIPT_BUDGET)}\n… (truncated)` : text;
}

function imagesText(a: ClipAnalysis, mode: ImageMode): string {
  if (mode === "none" || !a.framePaths.length) return "No keyframe images are available; judge from the text.";
  if (mode === "attached") return `${a.framePaths.length} keyframe image(s) from across the clip are attached.`;
  return [
    "Keyframe images from across the clip (open each one with your file-reading tool before judging):",
    ...a.framePaths.map((p) => `- ${p}`),
  ].join("\n");
}

const JUDGE_SCHEMA = `{
  "summary": "one sentence: what is on screen / said",
  "tags": ["up to 8 short subject tags"],
  "verdict": "keep" | "reject",
  "issues": [zero or more of: ${JUDGE_ISSUES.map((i) => `"${i}"`).join(", ")}],
  "reason": "short sentence explaining the verdict",
  "spoken_line": "for A-roll: the first full sentence spoken, else null"
}`;

export function judgePrompt(a: ClipAnalysis, flags: readonly string[], imageMode: ImageMode): string {
  const ocr = a.ocr.join(" | ").slice(0, OCR_BUDGET);
  return `You are an assistant video editor triaging raw footage. Judge ONE clip.

File: ${path.basename(a.file.path)} (folder: ${path.dirname(a.file.rel)})
Duration: ${formatDuration(a.durationSec)} · ${a.width}×${a.height} · ${a.hasAudio ? "has audio" : "no audio"}
Detected type: ${a.roll} (${a.roll === "a-roll" ? "someone talking — primary footage" : "cutaway / visual footage"})
Technical warnings from measurement: ${flags.length ? flags.join("; ") : "none"}

Transcript:
${transcriptText(a)}

On-screen text (OCR): ${ocr || "none"}

${imagesText(a, imageMode)}

Reject a clip only when an editor would not use it:
- technical flaws that ruin it (badly out of focus, unusable exposure, violent shake, clipped/missing audio on A-roll)
- flubbed A-roll: stumbles, restarts ("let me say that again"), cut-off sentences, laughing mid-line
- dead air or junk: accidental recording, lens cap, pocket shots, nothing happening
- weak B-roll: nothing usable or interesting on screen
Minor imperfections are "keep" with the issue listed. The technical warnings are heuristics — trust the images and transcript over them.

Reply with ONLY a JSON object matching:
${JUDGE_SCHEMA}`;
}

export interface GroupItem {
  readonly id: string;
  readonly roll: Roll;
  readonly verdict: Verdict;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly spokenLine: string | null;
  readonly durationSec: number;
  readonly file: string;
}

const GROUP_SCHEMA = `{
  "topics": [{ "title": "Short Title Case topic name", "clips": ["clip ids"] }],
  "take_groups": [{ "best": "clip id of the best take", "others": ["ids of the other takes"] }],
  "duplicate_rejects": [{ "clip": "id to reject", "duplicate_of": "id to keep" }]
}`;

function itemLines(items: readonly GroupItem[], summaryMax: number): string {
  return items
    .map((i) =>
      JSON.stringify({
        id: i.id,
        file: i.file,
        roll: i.roll,
        verdict: i.verdict,
        duration_sec: Math.round(i.durationSec),
        summary: i.summary.slice(0, summaryMax),
        tags: i.tags,
        spoken_line: i.spokenLine,
      }),
    )
    .join("\n");
}

export function groupPrompt(items: readonly GroupItem[], dupPairs: readonly [string, string][]): string {
  let summaryMax = 400;
  let lines = itemLines(items, summaryMax);
  while (lines.length > GROUP_BUDGET && summaryMax > 40) {
    summaryMax = Math.floor(summaryMax / 2);
    lines = itemLines(items, summaryMax);
  }
  const pairs = dupPairs.length ? dupPairs.map(([a, b]) => `${a} ~ ${b}`).join("\n") : "none";
  return `You are an assistant video editor organising one shoot. Below is every clip, one JSON object per line.

${lines}

Visually near-identical pairs (by image hash):
${pairs}

Tasks:
1. Group ALL clips into topics — the subjects or segments an editor would cut together (e.g. "Kitchen Setup", "Interview - Maria"). Prefer 2–10 topics; put B-roll with the topic it illustrates. Every clip id goes in exactly one topic.
2. take_groups: A-roll clips that are repeated takes of the same line. Pick the best take (complete, fluent, not flagged) as "best".
3. duplicate_rejects: B-roll that is redundant with a better clip (use the near-identical pairs as hints; keep the better one).
Use only the ids listed above.

Reply with ONLY a JSON object matching:
${GROUP_SCHEMA}`;
}
