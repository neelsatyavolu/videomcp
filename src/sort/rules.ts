import type { ClipAnalysis, Judgement, Metrics, Roll, Segment } from "./types.js";

const A_ROLL_SPEECH_SHARE = 0.4;
const A_ROLL_MIN_WORDS = 8;
const MIN_DURATION_SEC = 1;
const MAX_BLACK_SHARE = 0.8;
const MAX_FROZEN_SHARE = 0.9;

const BLUR_SOFT = 8;
const DARK_SHARE = 0.5;
const BLOWN_SHARE = 0.3;
const SHAKE = 0.03;
const CLIPPING_DB = -0.5;
const SILENT_SHARE = 0.6;

/** Seconds covered by at least one segment, within [0, durationSec]. */
function speechSeconds(durationSec: number, segs: readonly Segment[]): number {
  const spans = segs
    .map((s) => [Math.max(0, s.start), Math.min(durationSec, s.end)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of spans) {
    if (cur && a <= cur[1]) cur = [cur[0], Math.max(cur[1], b)];
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  return cur ? total + cur[1] - cur[0] : total;
}

export function detectRoll(hint: Roll | null, durationSec: number, segs: readonly Segment[]): Roll {
  if (hint) return hint;
  if (durationSec <= 0) return "b-roll";
  const wordCount = segs.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  const share = speechSeconds(durationSec, segs) / durationSec;
  return share >= A_ROLL_SPEECH_SHARE && wordCount >= A_ROLL_MIN_WORDS ? "a-roll" : "b-roll";
}

const reject = (issue: Judgement["issues"][number], reason: string): Judgement => ({
  summary: reason,
  tags: [],
  verdict: "reject",
  issues: [issue],
  reason,
  spokenLine: null,
});

/** Obvious rejects decided without an agent call; null means "ask the agent". */
export function preJudge(a: Pick<ClipAnalysis, "durationSec" | "hasVideo" | "metrics">): Judgement | null {
  if (!a.hasVideo) return reject("junk", "no video stream");
  if (a.durationSec < MIN_DURATION_SEC) return reject("too_short", "too short (<1s)");
  if (a.metrics.blackShare >= MAX_BLACK_SHARE) return reject("black", "mostly black");
  if (a.metrics.frozenShare >= MAX_FROZEN_SHARE) return reject("frozen", "frozen frame");
  return null;
}

/** Human-readable technical warnings for the judge prompt. */
export function metricFlags(m: Metrics, roll: Roll, hasAudio: boolean): string[] {
  const flags: string[] = [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (m.blur !== null && m.blur > BLUR_SOFT) flags.push(`possibly soft focus (blur ${m.blur.toFixed(1)})`);
  if (m.darkShare > DARK_SHARE) flags.push(`underexposed (${pct(m.darkShare)} of frames dark)`);
  if (m.blownShare > BLOWN_SHARE) flags.push(`overexposed (${pct(m.blownShare)} of frames blown out)`);
  if (m.shake !== null && m.shake > SHAKE) flags.push(`possibly shaky (jitter ${m.shake.toFixed(3)})`);
  if (m.maxVolumeDb !== null && m.maxVolumeDb >= CLIPPING_DB) flags.push(`audio clipping (peak ${m.maxVolumeDb} dB)`);
  if (roll === "a-roll" && !hasAudio) flags.push("no audio track on A-roll");
  if (roll === "a-roll" && hasAudio && m.silentShare > SILENT_SHARE) {
    flags.push(`mostly silent (${pct(m.silentShare)})`);
  }
  return flags;
}
