import path from "node:path";
import { formatDuration } from "../utils/format.js";
import type { PlanItem } from "./types.js";

const cell = (s: string) => s.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();

function topicTable(root: string, items: readonly PlanItem[]): string {
  const rows = items.map((i) =>
    [
      `\`${cell(path.relative(root, i.to))}\``,
      i.roll,
      formatDuration(i.durationSec),
      i.verdict,
      cell(i.reasons.join("; ")),
      cell(i.summary),
    ].join(" | "),
  );
  return ["| File | Roll | Length | Verdict | Reasons | Summary |", "|---|---|---|---|---|---|", ...rows.map((r) => `| ${r} |`)].join(
    "\n",
  );
}

/** Markdown report of a sort: totals, one table per topic, then clips that were not judged. */
export function renderReport(
  root: string,
  plan: readonly PlanItem[],
  unjudged: readonly { rel: string; error: string }[],
  agent: string,
  generatedAt = new Date(),
): string {
  const keep = plan.filter((p) => p.verdict === "keep").length;
  const reject = plan.length - keep;
  const topics = [...new Set(plan.map((p) => p.topic))];
  const lines = [
    "# Footage report",
    "",
    `Sorted \`${root}\` with **${agent}** on ${generatedAt.toISOString().slice(0, 16).replace("T", " ")}.`,
    "",
    `**${plan.length + unjudged.length} clips** · ${keep} keep · ${reject} reject · ${unjudged.length} not judged`,
    "",
    "| Topic | A-roll kept | B-roll kept | Rejected |",
    "|---|---|---|---|",
    ...topics.map((t) => {
      const items = plan.filter((p) => p.topic === t);
      const kept = (roll: string) => items.filter((p) => p.verdict === "keep" && p.roll === roll).length;
      return `| ${cell(t)} | ${kept("a-roll")} | ${kept("b-roll")} | ${items.filter((p) => p.verdict !== "keep").length} |`;
    }),
  ];
  for (const t of topics) {
    lines.push("", `## ${t}`, "", topicTable(root, plan.filter((p) => p.topic === t)));
  }
  if (unjudged.length) {
    lines.push("", "## Not judged (left in place)", "", ...unjudged.map((u) => `- \`${cell(u.rel)}\` — ${cell(u.error)}`));
  }
  return `${lines.join("\n")}\n`;
}
