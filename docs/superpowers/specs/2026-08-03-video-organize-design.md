# Design: `video-mcp organize` — AI video library organizer

**Date:** 2026-08-03  
**Status:** Draft (spec review fixes applied)  
**Package:** video-mcp-server (this repo)  
**Platform (v1):** **macOS only** (Trash via Finder/`osascript`)

## Problem

Footage dumps are messy: camera filenames, mixed A-roll / B-roll, and junk. Users want a local CLI that analyzes each clip, renames it by subject, trashes junk, and files keepers into `A-roll/` and categorized `B-roll/` folders — with clear progress — using existing agent CLIs (Grok / Codex / Claude) and this project’s video perception stack.

## Goals

- Batch-organize a directory of videos **in place under the scan root**
- Rename keepers to a short subject slug
- Classify A-roll vs B-roll; freeform B-roll subfolder labels from the model
- Send junk to **macOS Trash** (recoverable)
- Apply decisions **as each video finishes** (not a full-batch plan first)
- Nice live progress + final summary
- Reuse media layer (`probeVideo` / `analyzeVideo`) directly — no MCP stdio hop
- Agent model fallback: **Grok 4.5 → GPT 5.6 Luna medium → Haiku 4.5**

## Non-goals (v1)

- GUI / web UI
- Calling cloud APIs without an installed agent CLI
- Fixed B-roll taxonomy / presets
- Hard-delete junk
- Linux/Windows trash (v1 fails with a clear message on non-macOS)
- Parallel agent classification storms
- Automatic re-tagging of files already under `A-roll/` / `B-roll/`
- Preserving source subfolder layout under `A-roll`/`B-roll` (see Layout)

## Architecture (Approach 1)

```
video-mcp organize <dir>
        │
        ▼
   platform check (darwin) + resolve agent CLI
        │
        ▼
   scan (recursive) ── skip A-roll/, B-roll/, work dirs
        │
        ▼  per video (serial by default; apply-as-you-go)
   probe → analyze (organize preset) → agent CLI (JSON, + frames if vision)
        │
        ▼
   rename/move/trash under <dir>/A-roll|B-roll  +  progress  +  log.jsonl
```

Perception stays local. Classification is a thin non-interactive call to the first available agent CLI.

## CLI UX

```bash
video-mcp organize <dir> [options]
```

### Defaults

| Behavior | Default |
|----------|---------|
| Layout | Flatten to scan root: `<dir>/A-roll/…`, `<dir>/B-roll/<label>/…` |
| Junk | macOS Trash |
| Apply | Immediately after each decision |
| Scan | Recursive; skip if any path segment under root is `A-roll` or `B-roll` |
| Rename | Subject slug + **original extension casing preserved** |
| Models | Grok 4.5 → GPT 5.6 Luna medium → Haiku 4.5 |
| Pipeline concurrency | **1** (full serial: probe → analyze → classify → apply) |

### Flags

| Flag | Purpose |
|------|---------|
| `--provider grok\|codex\|claude` | Force backend (skip auto-fallback) |
| `--model <name>` | Override model for chosen provider |
| `--dry-run` | No rename / move / trash (analyze + classify + print plan OK; work-dir/temp side effects allowed) |
| `--ext mp4,mov,…` | Limit extensions (default: `VIDEO_EXTENSIONS` from constants) |
| `--concurrency N` | **v1: only N=1 supported.** If N>1, print warning and run serial (or error). No parallel agent calls. |
| `--yes` | Skip “About to process N videos…” confirm; **required when stdin is not a TTY** (non-interactive must pass `--yes` or auto-yes) |

### Progress example

```
Found 47 videos (skipping 3 already organized)

[3/47] camera_0042.MOV
  · probing… 12.4s · 1080p
  · analyzing (frames + speech)…
  · classifying via grok 4.5…
  → B-roll/city-skyline  city-skyline-dusk.MOV
  ✓ moved

[4/47] IMG_8821.mov
  → junk (black / no content)
  🗑  Trashed

Done  31 A-roll · 12 B-roll · 4 junk · 0 failed  (8m 12s)
```

## Layout (flatten to scan root)

All outputs live under the **scan root** `<dir>`:

- `<dir>/A-roll/<subject>.<ext>`
- `<dir>/B-roll/<label>/<subject>.<ext>`

Source subfolder structure is **not** preserved. A clip at `<dir>/day1/cam/clip.mov` becomes e.g. `<dir>/A-roll/interview-host.mov`.

## Skip rules

Skip a file if, relative to scan root, any path segment equals `A-roll` or `B-roll` (case-sensitive match to those folder names as created by this tool). Also skip:

- `<dir>/.video-mcp-organize/**`
- Hidden dirs that are clearly system (e.g. `.Trash`, `.git`) when encountered

## Per-video pipeline

1. **Probe** — duration, resolution, codecs
2. **Analyze (organize preset)** — see below (not MCP `detail: brief`)
3. **Classify** — agent CLI with JSON schema; attach up to **4** keyframe images when the CLI supports vision
4. **Apply** — validate decision → sanitize → rename → move or Trash → log
5. **Continue** — failures leave the source file in place; batch continues

### Organize analyze preset

**Do not use `detail: "brief"`.** In this codebase, `brief` means **0 frames and no OCR** (transcript/metadata only).

v1 organize calls `analyzeVideo` with options equivalent to:

| Knob | Value |
|------|--------|
| detail | `"standard"` |
| maxFrames | **cap at 6** (override after `maxFramesForDetail` or pass explicit limit if API allows; else post-slice frame list to ≤6) |
| OCR | on when tesseract available (existing behavior for non-brief) |
| Transcript | caption-first; Whisper if needed |
| Transcript budget | hard cap: first **120s** of speech text fed to the agent (full local analyze may still run; prompt truncates) |
| Per-file wall clock | soft target; agent call timeout **120s** → mark failed, leave in place |

Rationale: silent B-roll needs frames/OCR or vision; interviews need transcript. Cap frames for speed/cost.

### Visual path for classification

1. Prefer **vision**: pass up to 4 frame file paths/images into Grok/Claude/Codex if CLI supports images (`--image` / multimodal prompt).
2. Always include in text prompt: duration, resolution, filename, transcript excerpt, OCR text.
3. Residual risk: if vision fails and OCR/transcript empty, model may mis-label pure-visual silent clips — still attempt classify; low confidence does not auto-junk.

## Agent selection

```
try  grok   + model grok-4.5 (CLI-accepted ID; resolve at impl)
else codex  + model gpt-5.6-luna-medium (CLI-accepted ID)
else claude + model haiku-4.5 / claude-haiku-4-5
else fail before scan with install/login hint
```

`--provider` / `--model` pin a single path.

### Non-interactive invocation (shape)

| Provider | Invocation shape |
|----------|------------------|
| Grok | `grok --print --model … --json-schema …` single-turn; attach images if supported |
| Codex | `codex exec -m …` (+ `-i` images if available) |
| Claude | `claude -p --model … --json-schema …` |

Timeout 120s per call. Exact flags verified against installed CLIs at implementation.

## Classification contract

### JSON response

```json
{
  "action": "keep" | "junk",
  "roll": "A" | "B" | null,
  "broll_label": "city-skyline" | null,
  "subject": "city-skyline-dusk",
  "confidence": 0.0,
  "reason": "one short sentence"
}
```

Parse: strip optional ` ```json ` fences; validate; **one retry** on parse/validation failure.

### Validation matrix

| Response | Code behavior |
|----------|----------------|
| `action: "junk"` | Trash; ignore `roll` / `broll_label` / `subject` for paths (reason logged) |
| `keep` + `roll: "A"` | Require non-empty `subject` after sanitize; else invalid |
| `keep` + `roll: "B"` | Require non-empty `subject`; `broll_label` empty/null → default label **`misc`** |
| `keep` + `roll: null` / missing | **Invalid** → retry once → failed |
| Empty/missing `subject` on keep | **Invalid** → retry once → failed |
| Still invalid after retry | **failed**, leave file in place |
| Name collision | Append `-2`, `-3`, … before extension |
| Sanitize | lowercase, hyphens, strip path chars, max 60 chars for subject and broll_label |

### Junk / roll guidance (prompt)

- **Junk:** black frames, pocket/accidental cams, pure noise, empty test clips, no useful picture **and** speech — not “low quality but usable.”
- **A-roll:** interviews, talking heads, VO, primary spoken narrative, hosts/presenters
- **B-roll:** cutaways, environment, product, lifestyle, motion texture — freeform short labels

## Filesystem safety

- Prefer `fs.rename` same-volume; copy+unlink only if required
- Never overwrite destinations
- Junk → macOS Trash only (`osascript` telling Finder to delete / move to trash)
- Non-macOS: exit 1 before processing with message to use macOS or wait for a later port
- `--dry-run`: no rename, move, or trash

## State / resume

- Append-only: `<dir>/.video-mcp-organize/log.jsonl`
- Fields: source, dest, action, provider, model, reason, timestamp, error?
- Re-run safe via path-segment skip
- Explicit failure replay: post-v1

## Exit codes (locked)

| Condition | Code |
|-----------|------|
| Non-macOS, missing agent, bad args, scan root missing | **1** (before/during setup) |
| Any per-file **failed** | **1** (after summary) |
| All files processed without failure (including dry-run) | **0** |
| User abort (no `--yes` decline) | **1** |

## Packaging / wiring checklist

| Item | Detail |
|------|--------|
| `src/index.ts` | Add `organize` to `CLI_COMMANDS` (required — otherwise MCP starts) |
| `src/cli.ts` | `case "organize":` → `cmdOrganize` |
| `src/cli/commands.ts` or help | `printHelp` documents `organize` |
| Modules | `src/organize/` — see sketch |
| Docs | README section |
| Perception | Import `probeVideo` / `analyzeVideo` from `src/media/*` |

### Module sketch

```
src/organize/
  index.ts          # cmdOrganize entry
  scan.ts           # recursive discovery + skip rules
  pipeline.ts       # probe → analyze → classify → apply
  classify.ts       # provider fallback + JSON parse/retry + validation
  providers/
    grok.ts
    codex.ts
    claude.ts
  apply.ts          # rename, mkdir, move, trash (darwin)
  progress.ts       # live console + summary
  types.ts
```

## Testing

- Unit: sanitize, collision suffix, JSON parse/fences, validation matrix, skip rules, flatten dest paths
- Integration: dry-run with mocked agent stdout
- Manual: small folder copy → dry-run → apply

## Success criteria

1. `video-mcp organize <dir>` discovers videos, prints progress, prints summary  
2. Keepers under `<dir>/A-roll/` or `<dir>/B-roll/<label>/` with subject renames  
3. Junk in Trash, not permanently deleted  
4. Paths under `A-roll`/`B-roll` not reprocessed  
5. Provider fallback order respected when CLIs exist  
6. `--dry-run` never renames/moves/trashes  
7. Exit **1** if any file failed or setup failed; **0** only if all OK  

## Implementation notes (resolved)

| Topic | Decision |
|-------|----------|
| Analyze detail | Organize preset: standard + ≤6 frames + OCR; not `brief` |
| Vision | Prefer up to 4 frame images on agent CLI; always text context |
| Layout | Flatten to scan root |
| Concurrency | Serial only in v1 |
| Platform | macOS only in v1 |
| Extension casing | Preserve original |
| Agent timeout | 120s → failed |
| Empty B label | `misc` |
| Exit codes | Locked table above |
