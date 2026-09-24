# Footage Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `video-mcp sort <dir>` files every clip in a shoot folder into `<Topic>/{a-roll,b-roll}` or `_rejects/<Topic>/…`, using local perception plus a signed-in agent CLI, with a report and `--undo`.

**Architecture:** New `src/sort/` module inside videomcp. Pure logic (metrics parsing, rules, validation, planning) is separated from side effects (ffmpeg, agent CLIs, file moves) so it is unit-testable; side-effecting pieces are injected into the pipeline (`SortDeps`) so the integration test runs with a fake agent.

**Tech Stack:** TypeScript (Node16 ESM, strict), Node ≥ 18, ffmpeg, existing `src/media/*`, vitest (new dev dependency).

**Spec:** `docs/superpowers/specs/2026-09-24-footage-sort-design.md`

## Global Constraints

- Imports use `.js` suffixes (Node16 ESM), matching existing code.
- No new runtime dependencies; `vitest` is the only new devDependency.
- File names of clips are never changed; collisions get ` (2)`, ` (3)` before the extension.
- Never overwrite an existing file; never delete a clip.
- Agent order when `--agent` omitted: grok → codex → claude (first whose `--version` exits 0).
- Agent call timeout 180 s; concurrency default 3.
- A-roll threshold: speech coverage ≥ 0.40 of duration and ≥ 8 words.
- Pre-judge rejects: duration < 1.0 s; black share ≥ 0.8; frozen share ≥ 0.9; no video stream.
- Near-duplicate: dHash Hamming distance ≤ 10.
- Work state lives in `<dir>/.footage-sort/`; report at `<dir>/footage-report.md`.
- Tests live in `test/sort/*.test.ts` (outside `rootDir`, not compiled by `tsc`).

## Review Focus

1. **Folder names with spaces/unicode/quotes, and clips already inside topic folders from a previous run** — re-running must not re-sort already-sorted clips. → test in Task 2 (scan skips `createdDirs`) and Task 8 (topic sanitizing keeps spaces/unicode, strips `/` and `:`).
2. **Agent returns prose around JSON, fenced JSON, or a clip id it invented** → Task 5 tests `extractJson` on fenced/prosy output and grouping validation dropping unknown ids and filling missing ones into "Misc".
3. **Two clips with the same basename from different subfolders headed to the same destination** → Task 8 test asserts ` (2)` suffix and that it also avoids files already on disk.
4. **Crash / Ctrl-C mid-move** → Task 9 test: manifest is written before the first move and after each move; undo after a partial run restores only moved files.
5. **Clip with no audio track or whisper unavailable** → Task 4 test: roll = B-roll, no crash; Task 3 metrics parser tolerates missing `volumedetect`/`silencedetect` lines.

---

## File map

| File | Responsibility |
|------|----------------|
| `src/sort/types.ts` | Shared types (`Clip`, `Metrics`, `Judgement`, `Grouping`, `PlanItem`, `Manifest`, `AgentName`) |
| `src/sort/scan.ts` | Recursive discovery, skip rules, roll hints |
| `src/sort/metrics.ts` | ffmpeg one-pass metrics: arg builder + pure parsers |
| `src/sort/dhash.ts` | dHash from a JPEG via ffmpeg (9×8 gray), hamming |
| `src/sort/rules.ts` | `detectRoll`, `preJudge`, `metricFlags` |
| `src/sort/analyze.ts` | per-clip analysis orchestration + JSON cache |
| `src/sort/prompts.ts` | judge + group prompt text |
| `src/sort/verdicts.ts` | `extractJson`, `parseJudgement`, `parseGrouping` |
| `src/sort/agents/*.ts` | `run.ts` (spawn w/ timeout), `claude.ts`, `codex.ts`, `grok.ts`, `index.ts` (`selectAgent`, `askAgent`) |
| `src/sort/plan.ts` | `buildPlan`, `sanitizeTopic`, collision resolution |
| `src/sort/apply.ts` | `applyPlan`, `undoLastRun`, manifest IO |
| `src/sort/report.ts` | `renderReport` |
| `src/sort/pipeline.ts` | `runSort(dir, opts, deps)` wiring everything |
| `src/sort/index.ts` | `cmdSort(args)` — flag parsing, confirm, progress, exit code |
| `src/index.ts`, `src/cli.ts`, `src/cli/commands.ts` | register `sort` command + help |
| `test/sort/*.test.ts`, `test/sort/fixtures/*` | tests |

---

### Task 1: Test harness + shared types

**Files:** Modify `package.json` (add `"test": "vitest run"`, devDep `vitest`); Create `vitest.config.ts`, `src/sort/types.ts`, `test/sort/smoke.test.ts`.

**Produces (types.ts):**
```ts
export type AgentName = "grok" | "codex" | "claude";
export type Roll = "a-roll" | "b-roll";
export type Verdict = "keep" | "reject" | "unjudged";
export type Issue = "out_of_focus"|"exposure"|"shaky"|"audio_clipping"|"no_audio"|"flubbed"|"dead_air"|"junk"|"weak_broll"|"too_short"|"black"|"frozen"|"alternate_take"|"duplicate";
export interface ScannedFile { path: string; rel: string; rollHint: Roll | null }
export interface Metrics { blur: number|null; yavg: number|null; darkShare: number; blownShare: number; shake: number|null; maxVolumeDb: number|null; silentShare: number; blackShare: number; frozenShare: number }
export interface ClipAnalysis { id: string; file: ScannedFile; durationSec: number; hasAudio: boolean; hasVideo: boolean; width: number; height: number; transcript: { start: number; end: number; text: string }[]; ocr: string[]; framePaths: string[]; metrics: Metrics; dhash: string | null; roll: Roll }
export interface Judgement { summary: string; tags: string[]; verdict: Verdict; issues: Issue[]; reason: string; spokenLine: string | null }
export interface Grouping { topics: { title: string; clips: string[] }[]; takeGroups: { best: string; others: string[] }[]; duplicateRejects: { clip: string; duplicateOf: string }[] }
export interface PlanItem { id: string; from: string; to: string; topic: string; roll: Roll; verdict: Verdict; reasons: string[]; summary: string; durationSec: number }
export interface ManifestRun { at: string; moves: { from: string; to: string }[]; createdDirs: string[] }
export interface Manifest { runs: ManifestRun[] }
```

- [ ] `npm i -D vitest@^3` ; add script; `vitest.config.ts` with `test.include: ["test/**/*.test.ts"]`.
- [ ] Smoke test imports a type-only module and asserts `true` → `npm test` PASS.
- [ ] `npm run typecheck` PASS. Commit `chore: vitest harness and sort types`.

### Task 2: Scan

**Files:** `src/sort/scan.ts`, `test/sort/scan.test.ts`
**Produces:** `scanFolder(root: string, skipDirs: readonly string[]): Promise<ScannedFile[]>` (sorted by `rel`), `rollHintFromRel(rel: string): Roll | null`.

Rules: recurse; skip names starting with `.`, `_rejects`, `.footage-sort`, and any absolute dir in `skipDirs`; keep `looksLikeVideoPath`. Roll hint: any dir segment matching `/^(a[-_ ]?roll)$/i` → a-roll, `/^(b[-_ ]?roll)$/i` → b-roll (nearest segment wins).

- [ ] Tests (temp dir via `mkdtemp`): finds `x.mp4`, `sub/y.MOV`; ignores `notes.txt`, `.hidden/z.mp4`, `_rejects/r.mp4`, `.footage-sort/c.mp4`, and `Topic A/a-roll/done.mp4` when `Topic A` in skipDirs; `A-Roll/clip.mp4` → hint a-roll; `broll/x.mp4` → b-roll; `Café “Shoot”/x.mp4` found.
- [ ] Run → FAIL; implement; run → PASS; commit `feat(sort): folder scan`.

### Task 3: Metrics (ffmpeg one pass)

**Files:** `src/sort/metrics.ts`, `test/sort/metrics.test.ts`, `test/sort/fixtures/meta.txt`, `test/sort/fixtures/stderr.txt`, `test/sort/fixtures/deshake.log` (captured from a real run on a testsrc2 clip).
**Produces:**
```ts
export function metricsArgs(input: string, metaFile: string, deshakeFile: string): string[];
export function parseMetadataFile(text: string): { blur: number|null; yavg: number|null; darkShare: number; blownShare: number };
export function parseDeshakeLog(text: string, width: number): number | null; // RMS of Fin x/y ÷ width
export function parseStderr(stderr: string, durationSec: number): { maxVolumeDb: number|null; silentShare: number; blackShare: number; frozenShare: number };
export async function measureClip(input: string, info: { durationSec: number; width: number; hasAudio: boolean }, workDir: string): Promise<Metrics>;
```
Filter graph: `-vf fps=2,scale=640:-2,deshake=filename=<f>,blurdetect,signalstats,blackdetect=d=0.5:pix_th=0.1,freezedetect=n=0.003:d=2,metadata=print:file=<meta>`; audio (only if `hasAudio`): `-af volumedetect,silencedetect=n=-45dB:d=1`; `-f null -`. Blur = median of `lavfi.blur`. Dark = YAVG < 25, blown = YAVG > 235. black/silence/freeze share = sum of `*_duration` ÷ duration (freeze: pair `freeze_start`/`freeze_end`, open start ends at duration), clamped to [0,1].

- [ ] Tests on fixtures: numeric values within tolerance; empty input → nulls/zeros; `parseStderr` without audio lines → `maxVolumeDb: null, silentShare: 0`; silence open at end counted to duration.
- [ ] Integration-lite test (skipped if no ffmpeg): generate 2 s `testsrc2`+sine and 2 s `color=black` clips, `measureClip` → black clip `blackShare ≥ 0.8`, testsrc `blackShare < 0.1`.
- [ ] FAIL → implement → PASS → commit `feat(sort): ffmpeg quality metrics`.

### Task 4: Rules + dHash

**Files:** `src/sort/rules.ts`, `src/sort/dhash.ts`, `test/sort/rules.test.ts`, `test/sort/dhash.test.ts`
**Produces:**
```ts
export function detectRoll(hint: Roll|null, durationSec: number, segs: {start:number;end:number;text:string}[]): Roll;
export function preJudge(a: Pick<ClipAnalysis,"durationSec"|"hasVideo"|"metrics">): Judgement | null;
export function metricFlags(m: Metrics, roll: Roll, hasAudio: boolean): string[]; // human-readable flags for the prompt
export async function dhashFile(jpeg: string): Promise<string|null>; // 16 hex chars
export function hamming(a: string, b: string): number;
export function nearDuplicatePairs(items: {id:string; dhash:string|null}[], max?: number): [string,string][];
```
Flags thresholds: blur > 8 "possibly soft focus"; darkShare > 0.5 "underexposed"; blownShare > 0.3 "overexposed"; shake > 0.01 "shaky"; maxVolumeDb ≥ −0.5 "audio clipping"; A-roll && !hasAudio "no audio"; silentShare > 0.6 on A-roll "mostly silent".
`preJudge` reasons: "too short (<1s)", "mostly black", "frozen frame", "no video stream" with issues `too_short|black|frozen|junk`.

- [ ] Tests: hint wins; 10 s clip with 5 s of 12 words → a-roll; 3 s speech of 20 words in 10 s → b-roll; no segments → b-roll; preJudge each rule + clean clip → null; flags per threshold; hamming("ffff…","0000…")=64; dhash of same frame = identical, of black vs testsrc frame > 10; pairs only below threshold, null hashes ignored.
- [ ] FAIL → implement → PASS → commit `feat(sort): roll detection, pre-judge rules, dhash`.

### Task 5: Verdict parsing + prompts

**Files:** `src/sort/verdicts.ts`, `src/sort/prompts.ts`, `test/sort/verdicts.test.ts`
**Produces:**
```ts
export function extractJson(text: string): unknown; // strips ```json fences / surrounding prose; throws Error("no JSON object in agent output")
export function parseJudgement(raw: unknown): Judgement; // throws on invalid verdict; unknown issues dropped; tags ≤ 8
export function parseGrouping(raw: unknown, clipIds: readonly string[]): Grouping; // unknown ids dropped, dup ids keep first, missing → "Misc"; take-group best must exist
export function judgePrompt(a: ClipAnalysis, flags: string[], imageMode: "paths"|"attached"|"none"): string;
export function groupPrompt(items: { id: string; roll: Roll; verdict: Verdict; summary: string; tags: string[]; spokenLine: string|null; durationSec: number; file: string }[], dupPairs: [string,string][]): string;
```
Prompts end with "Reply with ONLY a JSON object matching: …" and the schema from the spec. Transcript ≤ 4000 chars formatted `[m:ss] text`. Group prompt truncates summaries when total > 150 000 chars.

- [ ] Tests: fenced JSON, prose + JSON, nested braces in strings, no JSON → throws; judgement valid/invalid verdict/unknown issue; grouping with invented id, missing id → Misc, duplicate assignment, take group with unknown best dropped; judgePrompt includes flags, transcript, and image paths only in "paths" mode.
- [ ] FAIL → implement → PASS → commit `feat(sort): agent output parsing and prompts`.

### Task 6: Agent adapters

**Files:** `src/sort/agents/run.ts`, `claude.ts`, `codex.ts`, `grok.ts`, `index.ts`, `test/sort/agents.test.ts`
**Produces:**
```ts
// run.ts
export interface RunResult { stdout: string; stderr: string; code: number|null; timedOut: boolean }
export type Runner = (cmd: string, args: readonly string[], o: { cwd: string; timeoutMs: number }) => Promise<RunResult>;
export const runProcess: Runner; // stdin ignored, detached process group, SIGTERM→SIGKILL group on timeout
// each adapter
export interface AgentRequest { prompt: string; images: string[]; cwd: string; model?: string }
export interface AgentAdapter { name: AgentName; imageMode: "paths"|"attached"; prepare?(run: Runner): Promise<string[]>; build(req: AgentRequest, extra: string[]): { cmd: string; args: string[] }; parse(stdout: string): string }
// index.ts
export const ADAPTERS: Record<AgentName, AgentAdapter>;
export async function selectAgent(run: Runner, preferred?: AgentName): Promise<AgentName>; // throws "No agent CLI found…"
export function createAsk(run: Runner, agent: AgentName, model?: string, timeoutMs?: number): (prompt: string, images: string[], cwd: string) => Promise<string>;
```
Invocations exactly as in the spec table. Claude: prompt gets `Keyframe images (read each with the Read tool): <abs paths>`; claude `--add-dir <cwd>`. Codex `prepare` lists `codex mcp list --json -c features.plugins=false` and disables each enabled server; images via repeated `-i`; prompt after `--`. Grok: `--prompt-json` JSON array `[{type:"text",text},{type:"image",mimeType:"image/jpeg",data:<b64>}…]`. Parsers: claude `JSON.parse(stdout).result` (error if `is_error`), codex last `item.completed` agent_message text, grok last `type:"result"` `.result`.

- [ ] Tests with a fake Runner: arg arrays per adapter (model flag included when set; images present); parsers on captured sample stdout (success + error); `selectAgent` order grok→codex→claude with fake `--version` results; preferred missing → throws with name; `createAsk` timeout → throws "timed out".
- [ ] FAIL → implement → PASS → commit `feat(sort): grok/codex/claude adapters`.

### Task 7: Per-clip analysis + cache

**Files:** `src/sort/analyze.ts`, `test/sort/analyze.test.ts`
**Produces:** `analyzeClip(file: ScannedFile, id: string, cacheDir: string, useCache: boolean): Promise<ClipAnalysis>` — `stat` key `(path,size,mtimeMs)`, cache file `<cacheDir>/<hash>.analysis.json`; otherwise `analyzeVideo(file.path, { detail: "standard", maxFrames: 6 })` + `measureClip` + `dhashFile(middle frame)` + `detectRoll`. Also `loadCachedJudgement/saveJudgement(cacheDir, key, j)` keyed by analysis hash + agent name.

- [ ] Test (skipped without ffmpeg): 2 s testsrc2 clip → hasVideo, 0 speech → b-roll, frames ≥ 1, dhash 16 hex; second call with cache returns identical object without spawning (check `elapsed` via spy on a counter export or file mtime unchanged).
- [ ] FAIL → implement → PASS → commit `feat(sort): per-clip analysis with cache`.

### Task 8: Plan + report

**Files:** `src/sort/plan.ts`, `src/sort/report.ts`, `test/sort/plan.test.ts`
**Produces:**
```ts
export function sanitizeTopic(t: string): string; // trim, replace /\\:*?"<>| and control chars with " ", collapse spaces, strip leading dots, ≤60, empty → "Misc"
export function buildPlan(root: string, clips: ClipAnalysis[], judgements: Map<string, Judgement>, grouping: Grouping, existing: (p: string) => boolean): PlanItem[];
export function renderReport(root: string, plan: PlanItem[], unjudged: { rel: string; error: string }[], agent: string): string;
```
Dest: keep → `<root>/<Topic>/<roll>/<basename>`; reject → `<root>/_rejects/<Topic>/<roll>/<basename>`. Take-group `others` and `duplicateRejects` become reject with issue `alternate_take`/`duplicate` and reason naming the kept file. Unjudged clips get no plan item. Collision: track planned targets + `existing()`; append ` (n)`. Items where `from === to` are dropped.

- [ ] Tests: keep/reject destinations; alternate take reason; duplicate reason; two `clip.mp4` from different subfolders → second gets ` (2)`; existing file on disk → ` (2)`; topic sanitizing (`"A/B: Test"` → `"A B Test"`, unicode kept); report contains counts and one row per clip with `|` escaped.
- [ ] FAIL → implement → PASS → commit `feat(sort): move plan and report`.

### Task 9: Apply + undo

**Files:** `src/sort/apply.ts`, `test/sort/apply.test.ts`
**Produces:**
```ts
export async function readManifest(root: string): Promise<Manifest>;
export async function applyPlan(root: string, plan: PlanItem[], onMove?: (i: PlanItem) => void): Promise<ManifestRun>;
export async function undoLastRun(root: string): Promise<{ restored: number; skipped: string[] }>;
export function createdDirsAll(m: Manifest): string[];
```
Apply: push run with empty moves to manifest and write it first; for each item `mkdir -p` (record newly created dirs, top-down), refuse if `to` exists (skip with error), `rename`, on `EXDEV` copy+size check+unlink; append move and rewrite manifest (write to `.tmp` then rename). Undo: last run, reverse order; skip when `to` missing or `from` occupied; `rmdir` created dirs deepest-first if empty; pop run.

- [ ] Tests: apply then undo round-trip restores tree exactly (compare sorted listing + contents); destination exists → that item skipped, others moved; partial run simulated by manifest with 1 of 2 moves → undo restores 1; undo with no runs → restored 0; created dirs removed only when empty.
- [ ] FAIL → implement → PASS → commit `feat(sort): apply moves with manifest and undo`.

### Task 10: Pipeline + CLI wiring

**Files:** `src/sort/pipeline.ts`, `src/sort/index.ts`, modify `src/index.ts` (add `"sort"` to `CLI_COMMANDS`), `src/cli.ts` (`case "sort"`), `src/cli/commands.ts` (help lines), `README.md`/`AGENTS.md` (CLI section), `test/sort/pipeline.test.ts`
**Produces:**
```ts
export interface SortOptions { dryRun: boolean; concurrency: number; useCache: boolean; agent: string }
export interface SortDeps { analyze(f: ScannedFile, id: string): Promise<ClipAnalysis>; ask(prompt: string, images: string[], cwd: string): Promise<string>; imageMode: "paths"|"attached"; log(msg: string): void }
export interface SortResult { plan: PlanItem[]; unjudged: { rel: string; error: string }[]; report: string }
export async function runSort(root: string, opts: SortOptions, deps: SortDeps): Promise<SortResult>;
export async function cmdSort(args: string[]): Promise<number>; // exit code
```
Pipeline: read manifest → scan (skip createdDirs) → analyze with bounded concurrency (failures → unjudged) → preJudge or judge (one retry on parse failure; failure → unjudged) → group (one retry; failure → throw, no moves) → buildPlan → renderReport. `cmdSort`: parse flags, `requireFfmpeg`, `selectAgent`, build deps, `runSort`, print plan summary table; dry-run → print report, exit; else confirm (TTY) / require `--yes`; `applyPlan`; write `footage-report.md`; exit 1 if unjudged > 0. `--undo` → `undoLastRun`.

- [ ] Pipeline test with fake deps: 4 fake analyses (talking a-roll, second take of same line, b-roll, 0.5 s clip); fake ask returns judgement JSON by clip file name and a grouping with a take group → plan has 1 keep a-roll, 1 alternate-take reject, 1 keep b-roll, 1 too-short reject; ask never called for the 0.5 s clip; judge returning garbage twice → clip unjudged, others planned; group failing twice → rejects promise.
- [ ] Manual: `npm run build && node dist/index.js help` shows `sort`.
- [ ] FAIL → implement → PASS → commit `feat(sort): pipeline and video-mcp sort command`.

### Task 11: End-to-end verification

**Files:** `scripts/make-sort-fixture.sh` (synthetic shoot folder)
- [ ] Script builds `<out>/raw/`: `talk1.mp4` & `talk1_take2.mp4` (testsrc2 + `say` "Welcome to the setup tutorial. Today we install the desk lamp." with a stumble variant), `lamp_closeup.mp4` (testsrc2 no speech), `lamp_closeup_copy.mp4` (same content), `black.mp4` (black 3 s), `blip.mp4` (0.5 s).
- [ ] `node dist/index.js sort <out>/raw --dry-run --agent claude` → plan printed, no moves.
- [ ] Apply with `--yes` → layout as spec; `footage-report.md` present; `--undo` → original tree restored.
- [ ] Repeat dry-run with `--agent codex` and `--agent grok`.
- [ ] `npm run typecheck && npm test` green. Commit `test(sort): e2e fixture script`.
