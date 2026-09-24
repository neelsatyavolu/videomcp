import type {
  FrameResult,
  TimelineEvent,
  TranscriptResult,
} from "../types.js";

export function buildTimeline(
  transcript: TranscriptResult | null,
  frames: FrameResult[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  if (transcript) {
    for (const seg of transcript.segments) {
      events.push({
        timeSec: seg.start,
        kind: "speech",
        text: seg.text,
      });
    }
  }

  for (const f of frames) {
    events.push({
      timeSec: f.timeSec,
      kind: "frame",
      text: `Frame #${f.index} (${f.path})`,
      framePath: f.path,
    });
    if (f.ocrText?.trim()) {
      events.push({
        timeSec: f.timeSec,
        kind: "ocr",
        text: f.ocrText.trim(),
        framePath: f.path,
      });
    }
  }

  events.sort((a, b) => a.timeSec - b.timeSec || a.kind.localeCompare(b.kind));
  return events;
}
