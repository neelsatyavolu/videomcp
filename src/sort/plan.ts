import path from "node:path";
import { REJECTS_DIR_NAME } from "./scan.js";
import type { ClipAnalysis, Grouping, Judgement, PlanItem, Verdict } from "./types.js";

const MAX_TOPIC_LENGTH = 60;
const MISC_TOPIC = "Misc";

/** A folder-safe topic name: no path separators or reserved characters, never hidden or empty. */
export function sanitizeTopic(title: string): string {
  const cleaned = title
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .slice(0, MAX_TOPIC_LENGTH)
    .trim();
  if (!cleaned) return MISC_TOPIC;
  if (cleaned.toLowerCase() === REJECTS_DIR_NAME) return "Rejects";
  return cleaned;
}

/** `name.ext`, then `name (2).ext`, `name (3).ext`, … until neither planned nor on disk. */
function freeTarget(dir: string, base: string, taken: Set<string>, existing: (p: string) => boolean): string {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? base : `${stem} (${n})${ext}`);
    if (!taken.has(candidate) && !existing(candidate)) return candidate;
  }
}

function overrides(grouping: Grouping, byId: ReadonlyMap<string, ClipAnalysis>): Map<string, string> {
  const name = (id: string) => path.basename(byId.get(id)?.file.path ?? id);
  const out = new Map<string, string>();
  for (const g of grouping.takeGroups) {
    for (const id of g.others) out.set(id, `alternate take (best: ${name(g.best)})`);
  }
  for (const d of grouping.duplicateRejects) out.set(d.clip, `near-duplicate of ${name(d.duplicateOf)}`);
  return out;
}

function reasonsFor(j: Judgement): string[] {
  const reasons = j.reason ? [j.reason] : [];
  return j.issues.length ? [...reasons, `issues: ${j.issues.join(", ")}`] : reasons;
}

/**
 * Where every judged clip goes. Unjudged clips get no item (they stay put); clips already at their
 * destination are dropped. Items keep the order of `clips`.
 */
export function buildPlan(
  root: string,
  clips: readonly ClipAnalysis[],
  judgements: ReadonlyMap<string, Judgement>,
  grouping: Grouping,
  existing: (p: string) => boolean,
): PlanItem[] {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const topicOf = new Map<string, string>();
  for (const t of grouping.topics) for (const id of t.clips) topicOf.set(id, sanitizeTopic(t.title));
  const forced = overrides(grouping, byId);
  const taken = new Set<string>();
  const plan: PlanItem[] = [];

  for (const c of clips) {
    const j = judgements.get(c.id);
    if (!j) continue;
    const forcedReason = forced.get(c.id);
    const verdict: Verdict = forcedReason ? "reject" : j.verdict;
    const topic = topicOf.get(c.id) ?? MISC_TOPIC;
    const dir = verdict === "keep" ? path.join(root, topic, c.roll) : path.join(root, REJECTS_DIR_NAME, topic, c.roll);
    const base = path.basename(c.file.path);
    if (path.join(dir, base) === c.file.path) continue;
    const to = freeTarget(dir, base, taken, existing);
    taken.add(to);
    plan.push({
      id: c.id,
      from: c.file.path,
      to,
      topic,
      roll: c.roll,
      verdict,
      reasons: !forcedReason ? reasonsFor(j) : j.verdict === "reject" ? [...reasonsFor(j), forcedReason] : [forcedReason],
      summary: j.summary,
      durationSec: c.durationSec,
    });
  }
  return plan;
}
