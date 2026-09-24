export type AgentName = "grok" | "codex" | "claude";
export type Roll = "a-roll" | "b-roll";
export type Verdict = "keep" | "reject" | "unjudged";

export const ISSUES = [
  "out_of_focus",
  "exposure",
  "shaky",
  "audio_clipping",
  "no_audio",
  "flubbed",
  "dead_air",
  "junk",
  "weak_broll",
  "too_short",
  "black",
  "frozen",
  "alternate_take",
  "duplicate",
] as const;
export type Issue = (typeof ISSUES)[number];

export interface ScannedFile {
  /** Absolute path. */
  readonly path: string;
  /** Path relative to the sort root, for display. */
  readonly rel: string;
  readonly rollHint: Roll | null;
}

export interface Metrics {
  /** Median ffmpeg blurdetect value; higher = blurrier. */
  readonly blur: number | null;
  readonly yavg: number | null;
  readonly darkShare: number;
  readonly blownShare: number;
  /** RMS stabilisation correction ÷ frame width; higher = shakier. */
  readonly shake: number | null;
  readonly maxVolumeDb: number | null;
  readonly silentShare: number;
  readonly blackShare: number;
  readonly frozenShare: number;
}

export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface ClipAnalysis {
  readonly id: string;
  readonly file: ScannedFile;
  readonly durationSec: number;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly width: number;
  readonly height: number;
  readonly transcript: readonly Segment[];
  readonly ocr: readonly string[];
  readonly framePaths: readonly string[];
  readonly metrics: Metrics;
  readonly dhash: string | null;
  readonly roll: Roll;
}

export interface Judgement {
  readonly summary: string;
  readonly tags: readonly string[];
  readonly verdict: Verdict;
  readonly issues: readonly Issue[];
  readonly reason: string;
  readonly spokenLine: string | null;
}

export interface Grouping {
  readonly topics: readonly { readonly title: string; readonly clips: readonly string[] }[];
  readonly takeGroups: readonly { readonly best: string; readonly others: readonly string[] }[];
  readonly duplicateRejects: readonly { readonly clip: string; readonly duplicateOf: string }[];
}

export interface PlanItem {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly topic: string;
  readonly roll: Roll;
  readonly verdict: Verdict;
  readonly reasons: readonly string[];
  readonly summary: string;
  readonly durationSec: number;
}

export interface Move {
  readonly from: string;
  readonly to: string;
}

export interface ManifestRun {
  readonly at: string;
  readonly moves: readonly Move[];
  readonly createdDirs: readonly string[];
}

export interface Manifest {
  readonly runs: readonly ManifestRun[];
}
