export interface VideoInfo {
  path: string;
  source: string;
  sourceKind: "local" | "url" | "youtube_dl";
  durationSec: number;
  width: number;
  height: number;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  hasVideo: boolean;
  bitrate: number | null;
  sizeBytes: number | null;
  formatName: string | null;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
  language: string | null;
  source: string;
  fullText: string;
}

export interface FrameResult {
  index: number;
  timeSec: number;
  path: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  ocrText?: string;
}

export interface TimelineEvent {
  timeSec: number;
  kind: "speech" | "frame" | "ocr";
  text: string;
  framePath?: string;
}

export interface DepStatus {
  name: string;
  available: boolean;
  path?: string;
  version?: string;
  note?: string;
}

export interface AnalyzeResult {
  info: VideoInfo;
  transcript: TranscriptResult | null;
  frames: FrameResult[];
  timeline: TimelineEvent[];
  warnings: string[];
  detail: string;
  elapsedMs: number;
  /** Agent-oriented one-screen brief. */
  summary?: string;
  ocrHitCount?: number;
  sidecarPath?: string | null;
}
