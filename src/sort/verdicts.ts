import { ISSUES, type Grouping, type Issue, type Judgement } from "./types.js";

const MAX_TAGS = 8;
const MISC_TOPIC = "Misc";

/** Index just past the brace that closes the object opening at `start`, or -1. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** First parseable JSON object in agent output (tolerates code fences and prose). */
export function extractJson(text: string): unknown {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = closingBrace(text, start);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(start, end));
    } catch {
      // not JSON — try the next opening brace
    }
  }
  throw new Error(`no JSON object in agent output: ${text.slice(0, 200)}`);
}

function asRecord(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${what} is not an object`);
  return raw as Record<string, unknown>;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v.trim() : fallback);
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];

export function parseJudgement(raw: unknown): Judgement {
  const o = asRecord(raw, "judgement");
  if (o.verdict !== "keep" && o.verdict !== "reject") {
    throw new Error(`judgement verdict must be "keep" or "reject", got ${JSON.stringify(o.verdict)}`);
  }
  const spoken = o.spoken_line ?? o.spokenLine;
  return {
    summary: str(o.summary),
    tags: strArray(o.tags).slice(0, MAX_TAGS),
    verdict: o.verdict,
    issues: strArray(o.issues).filter((i): i is Issue => (ISSUES as readonly string[]).includes(i)),
    reason: str(o.reason),
    spokenLine: typeof spoken === "string" && spoken.trim() ? spoken.trim() : null,
  };
}

function parseTopics(raw: unknown, known: ReadonlySet<string>): { title: string; clips: string[] }[] {
  if (!Array.isArray(raw)) throw new Error("grouping.topics must be an array");
  const assigned = new Set<string>();
  const topics: { title: string; clips: string[] }[] = [];
  for (const t of raw) {
    if (typeof t !== "object" || t === null) continue;
    const rec = t as Record<string, unknown>;
    const clips = strArray(rec.clips).filter((id) => known.has(id) && !assigned.has(id));
    clips.forEach((id) => assigned.add(id));
    if (clips.length) topics.push({ title: str(rec.title, MISC_TOPIC) || MISC_TOPIC, clips });
  }
  const missing = [...known].filter((id) => !assigned.has(id));
  if (!missing.length) return topics;
  const miscIdx = topics.findIndex((t) => t.title.toLowerCase() === MISC_TOPIC.toLowerCase());
  if (miscIdx === -1) return [...topics, { title: MISC_TOPIC, clips: missing }];
  return topics.map((t, i) => (i === miscIdx ? { ...t, clips: [...t.clips, ...missing] } : t));
}

/** Validates the grouping call's output against the real clip ids. */
export function parseGrouping(raw: unknown, clipIds: readonly string[]): Grouping {
  const o = asRecord(raw, "grouping");
  const known = new Set(clipIds);
  const topics = parseTopics(o.topics, known);

  const inTakeGroup = new Set<string>();
  const takeGroups: { best: string; others: string[] }[] = [];
  for (const g of Array.isArray(o.take_groups ?? o.takeGroups) ? ((o.take_groups ?? o.takeGroups) as unknown[]) : []) {
    if (typeof g !== "object" || g === null) continue;
    const rec = g as Record<string, unknown>;
    const best = str(rec.best);
    if (!known.has(best) || inTakeGroup.has(best)) continue;
    const others = [...new Set(strArray(rec.others))].filter((id) => known.has(id) && id !== best && !inTakeGroup.has(id));
    if (!others.length) continue;
    [best, ...others].forEach((id) => inTakeGroup.add(id));
    takeGroups.push({ best, others });
  }

  const bests = new Set(takeGroups.map((g) => g.best));
  const dupRejected = new Set<string>();
  const duplicateRejects: { clip: string; duplicateOf: string }[] = [];
  const rawDups = o.duplicate_rejects ?? o.duplicateRejects;
  for (const d of Array.isArray(rawDups) ? rawDups : []) {
    if (typeof d !== "object" || d === null) continue;
    const rec = d as Record<string, unknown>;
    const clip = str(rec.clip);
    const duplicateOf = str(rec.duplicate_of ?? rec.duplicateOf);
    const valid =
      known.has(clip) && known.has(duplicateOf) && clip !== duplicateOf &&
      !bests.has(clip) && !dupRejected.has(clip) && !dupRejected.has(duplicateOf);
    if (!valid) continue;
    dupRejected.add(clip);
    duplicateRejects.push({ clip, duplicateOf });
  }

  return { topics, takeGroups, duplicateRejects };
}
