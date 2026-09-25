# Design: `video-mcp sort` — sort a shoot folder by topic and quality

**Date:** 2026-09-24
**Status:** Approved (supersedes the unimplemented `2026-08-03-video-organize-design.md`)
**Package:** video-mcp-server (this repo)
**Platform (v1):** macOS (tested there; nothing macOS-only in the code path)

## Problem

A shoot folder holds a mix of A-roll (people talking to camera) and B-roll (cutaways), with junk,
flubbed takes and duplicate shots in between. The user wants one CLI command that files every clip
into topic folders, splits A-roll from B-roll, and separates what is usable from what is not — using
this project's local perception stack plus whichever agent CLI (Grok, Codex, Claude) is signed in.

## Decisions (from brainstorming)

| Topic | Decision |
|-------|----------|
| Where | New `sort` subcommand in videomcp; imports `src/media/*` directly |
| Reasoning | Signed-in agent CLI: `--agent grok\|codex\|claude`; default = first installed in order grok → codex → claude |
| Files | **Move in place**, confirm first, manifest + `--undo` |
| A/B roll | Auto-detect from speech coverage; existing `a-roll`/`b-roll` folder names override |
| Bad = | Technical flaws, flubbed takes, dead air/junk, weak/duplicate B-roll |
| Tiers | Two: keep (topic folder) or reject (`_rejects/`) |
| Agent calls | Two stages: one judge call per clip, then one global grouping call |

## Non-goals (v1)

Renaming clips · Trash/deletion · MCP tool exposure · GUI · cutting clips into sub-ranges ·
cloud API keys · Linux/Windows testing.

## CLI

```bash
video-mcp sort <dir> [--agent grok|codex|claude] [--model <id>] [--dry-run] [--yes]
                     [--concurrency N] [--no-cache]
video-mcp sort --undo <dir>
```

- `--dry-run`: analyze + judge + print plan and write the report to stdout; no moves.
- Without `--yes`, prints the plan summary and asks `Move N files? [y/N]`. Non-TTY stdin without `--yes` → exit 1.
- `--concurrency` (default 3): local analysis and per-clip judge calls in flight at once.

## Output layout

```
<dir>/
  <Topic Title>/a-roll/…  <Topic Title>/b-roll/…
  _rejects/<Topic Title>/{a-roll,b-roll}/…
  footage-report.md
  .footage-sort/cache/<key>.json     # per-clip analysis + judgement
  .footage-sort/manifest.json        # every applied run's moves + created dirs, for --undo
```

File names are never changed. Name collisions get ` (2)`, ` (3)` before the extension.
Topic folder names are sanitized (no `/`, `:`, leading dots; ≤ 60 chars).

## Pipeline

```
scan → analyze (local, cached) → pre-judge rules → judge per clip (agent) → group (agent) → plan → confirm → move → report
```

### 1. Scan
Recursive. Video extensions from `looksLikeVideoPath`. Skips `.footage-sort/`, `_rejects/`, hidden
dirs, and every folder listed in the manifest's `createdDirs` (so re-runs only sort new clips). A path segment named
`a-roll`/`A-roll`/`aroll` or `b-roll`/… sets a roll hint.

### 2. Analyze (local, no LLM)
Per clip, cached by `(path, size, mtime)`:
- `analyzeVideo(path, { detail: "standard", maxFrames: 6 })` → info, transcript, keyframes, OCR.
- One ffmpeg pass at 2 fps (`src/sort/metrics.ts`):
  - `blurdetect` → median blur
  - `signalstats` → mean YAVG, share of frames with YAVG < 25 (dark) or > 235 (blown)
  - `deshake=filename=…` → RMS of the "Fin x/y" correction ÷ width = shake score
  - `volumedetect` → max_volume (≥ −0.5 dB = clipping)
  - `silencedetect=n=-45dB:d=1` → silent share
  - `blackdetect` / `freezedetect` → black share, frozen share
- dHash (64-bit) of the middle keyframe for near-duplicate detection.
- **Roll:** hint wins; else A-roll when transcript segments cover ≥ 40 % of duration and ≥ 8 words.

### 3. Pre-judge rules (no agent call, verdict = reject)
- duration < 1.0 s
- black share ≥ 0.8

(Frozen share ≥ 0.9 is only a warning flag for the judge: locked-off shots read as frozen.)
- no video stream

### 4. Judge (one agent call per remaining clip)
Input: file name, duration, roll, metrics with human-readable flags, transcript (≤ 4 000 chars,
timestamped), OCR text, up to 4 keyframes as images.
Output JSON (validated; fences stripped; one retry on invalid):
```json
{ "summary": "one sentence", "tags": ["..."], "verdict": "keep"|"reject",
  "issues": ["out_of_focus"|"exposure"|"shaky"|"audio_clipping"|"no_audio"|"flubbed"|"dead_air"|"junk"|"weak_broll"],
  "reason": "short sentence", "spoken_line": "first sentence of A-roll or null" }
```

### 5. Group (one agent call for the whole folder)
Input: every clip's id, roll, verdict, summary, tags, spoken_line, duration, and the dHash
near-duplicate pairs (Hamming ≤ 10). Output JSON:
```json
{ "topics": [{ "title": "Setup Tutorial", "clips": ["c01","c07"] }],
  "take_groups": [{ "best": "c03", "others": ["c02","c04"] }],
  "duplicate_rejects": [{ "clip": "c09", "duplicate_of": "c08" }] }
```
Validation: every clip id appears in exactly one topic (missing → topic "Misc"); `take_groups`
and `duplicate_rejects` ids must exist. `others` in a take group and `duplicate_rejects` become
reject with reason "alternate take (best: <file>)" / "near-duplicate of <file>".

For large folders the prompt is text-only; if it exceeds ~150 000 chars, summaries are truncated.

### 6. Plan, confirm, move
Plan = list of `{from, to, verdict, topic, roll, reasons}`. Moves use `fs.rename` (same volume);
cross-device falls back to copy + size check + unlink. Never overwrite. Manifest written before the
first move and updated after each move, so a crash leaves an accurate undo record.

### 7. Undo
Reverts the **most recent** run in the manifest: moves each `to` back to `from` (skipping missing files and occupied sources
with a warning), removes now-empty folders that run created, and drops the run from the manifest (repeat `--undo` to go further back).

### 8. Report
`footage-report.md`: counts per topic/roll/verdict, then a table per topic with file, roll,
duration, verdict, reasons, summary.

## Agent adapters (`src/sort/agents/`)

Adapted from the consult project. All headless, read-only, no MCP servers:

| Agent | Invocation | Images |
|-------|-----------|--------|
| claude | `claude -p --output-format json --restricted --tools Read --strict-mcp-config` (cwd = frames dir) | frame paths in prompt, read via `Read` |
| codex | `codex exec --json --skip-git-repo-check -c sandbox_mode="read-only" -c features.plugins=false -c mcp_servers.<n>.enabled=false… -i <img>… -- <prompt>` | `-i` |
| grok | `grok --prompt-json <blocks> --output-format streaming-messages-json --tools read_file --disallowed-tools Agent,search_tool,use_tool` | base64 `{type:"image",mimeType,data}` blocks |

Verified in a spike on 2026-09-24 (grok 1.0.41, codex-cli 0.156.0, Claude Code 2.1.282): all three
read a JPEG and returned JSON. Timeout 180 s per call; a failed judge call marks the clip
`unjudged` — it stays where it is and is listed in the report.

## Error handling

- Missing ffmpeg or no agent CLI → exit 1 before scanning, with install hint.
- Per-clip analysis/judge failure → clip left in place, counted as failed; batch continues.
- Group call failure after one retry → exit 1 before any move (no half-sorted folder).
- Exit 0 when every clip was placed; 1 if any failed, the user declined, or setup failed.

## Module layout

```
src/sort/
  index.ts        cmdSort / cmdUndo entry, arg parsing, confirm
  scan.ts         discovery, skip rules, roll hints
  metrics.ts      one-pass ffmpeg quality metrics + parsers
  dhash.ts        keyframe perceptual hash + hamming
  analyze.ts      per-clip analysis + cache
  rules.ts        roll detection + pre-judge rules
  prompts.ts      judge + group prompt builders
  verdicts.ts     JSON extraction + validation of agent output
  agents/         run.ts, claude.ts, codex.ts, grok.ts, index.ts (selection)
  plan.ts         build plan from verdicts + grouping
  apply.ts        move with manifest; undo
  report.ts       footage-report.md
  types.ts
```

## Testing

- **Unit (vitest):** metric parsers on captured ffmpeg output, dHash/hamming, roll detection,
  pre-judge rules, JSON extraction/validation, grouping validation, plan building + collisions +
  sanitizing, adapter arg building + output parsing, apply/undo on a temp dir.
- **Integration:** synthetic folder (ffmpeg `testsrc2` + macOS `say` speech, a black clip, a
  0.5 s clip, a duplicate) through the full pipeline with a fake agent; assert layout, report, undo.
- **Manual:** real CLI run (`--dry-run`, then apply, then `--undo`) against the synthetic folder
  with each available agent.

## Success criteria

1. `video-mcp sort <dir> --dry-run` prints a plan with topic, roll, verdict and reasons for every clip.
2. Applied run produces the layout above; nothing overwritten; report written.
3. `--undo` restores every file to its original path.
4. Black/tiny clips rejected without an agent call; alternate takes and near-duplicates rejected with reasons.
5. Works with each of grok, codex, claude selected via `--agent`.
6. `npm run typecheck` and `npm test` pass.
