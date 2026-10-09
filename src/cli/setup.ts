import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { checkDeps } from "../media/deps.js";
import {
  WHISPER_MODEL_URLS,
  defaultModelDir,
  defaultModelPath,
  resolveWhisperCppBin,
  resolveWhisperCppModel,
} from "../media/whisper-paths.js";
import { which, execFile } from "../utils/exec.js";
import { enrichPath } from "../utils/env.js";
import { SERVER_NAME, SERVER_VERSION } from "../constants.js";

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function brewInstall(formula: string): Promise<boolean> {
  const brew = await which("brew");
  if (!brew) {
    console.error(`✗ Homebrew not found — install ${formula} manually`);
    return false;
  }
  console.log(`→ brew install ${formula}`);
  const code = await run(brew, ["install", formula]);
  return code === 0;
}

/** ggml-base is ~140MB; anything smaller in the cache is a partial download. */
const MIN_MODEL_BYTES = 1_000_000;

async function usableModel(file: string): Promise<boolean> {
  try {
    const st = await stat(file);
    return st.isFile() && st.size >= MIN_MODEL_BYTES;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  // curl is universal on macOS
  const curl = (await which("curl")) || "curl";
  const tmp = `${dest}.${process.pid}.partial`;
  console.log(`→ downloading ${path.basename(dest)}`);
  const code = await run(curl, [
    "-L",
    "--fail",
    "--progress-bar",
    "-o",
    tmp,
    url,
  ]);
  if (code !== 0) {
    await unlink(tmp).catch(() => undefined);
    throw new Error(`Download failed: ${url}`);
  }
  await rename(tmp, dest);
}

/**
 * Install system deps needed for full video understanding:
 * ffmpeg, tesseract (OCR), whisper-cpp + ggml model (ASR).
 */
export async function cmdSetup(opts: {
  model?: string;
  skipBrew?: boolean;
} = {}): Promise<void> {
  enrichPath();
  const modelKey = opts.model ?? "base";
  if (!Object.keys(WHISPER_MODEL_URLS).includes(modelKey)) {
    throw new Error(
      `Unknown whisper model "${modelKey}". Choose one of: ${Object.keys(WHISPER_MODEL_URLS).join(", ")}`,
    );
  }
  console.log(`${SERVER_NAME} v${SERVER_VERSION} — setup\n`);
  console.log("Installing needed tools: ffmpeg, tesseract, whisper-cpp + model\n");

  const modelUrl = WHISPER_MODEL_URLS[modelKey]!;
  const modelDest = defaultModelPath(modelKey);

  // 1. brew packages
  if (!opts.skipBrew) {
    for (const formula of ["ffmpeg", "tesseract", "whisper-cpp", "yt-dlp"] as const) {
      const binName =
        formula === "whisper-cpp"
          ? "whisper-cli"
          : formula === "ffmpeg"
            ? "ffmpeg"
            : formula === "tesseract"
              ? "tesseract"
              : "yt-dlp";
      const existing = await which(binName);
      if (existing) {
        console.log(`✓ ${formula} already installed (${existing})`);
        continue;
      }
      const ok = await brewInstall(formula);
      if (ok) console.log(`✓ ${formula} installed`);
      else console.error(`✗ ${formula} install failed`);
    }
  }

  // 2. whisper model
  enrichPath(); // refresh after brew
  const fromEnv = process.env.WHISPER_CPP_MODEL || process.env.WHISPER_MODEL_PATH;
  let model: string | null = null;
  if (opts.model) {
    // An explicit --model must be that file, not whichever model happens to be installed.
    if (!(await usableModel(modelDest))) await downloadFile(modelUrl, modelDest);
    model = modelDest;
  } else {
    model = await resolveWhisperCppModel();
    if (model && model !== fromEnv && !(await usableModel(model))) {
      console.error(`✗ whisper model looks incomplete (${model}); downloading again`);
      if (model.startsWith(defaultModelDir() + path.sep)) await unlink(model).catch(() => undefined);
      model = null;
    }
    if (!model) {
      await downloadFile(modelUrl, modelDest);
      model = modelDest;
    }
  }
  console.log(`✓ whisper model: ${model}`);

  // 3. Verify
  console.log("\n— verifying —\n");
  const bin = await resolveWhisperCppBin();
  const tess = process.env.TESSERACT_BIN || (await which("tesseract"));
  const ffmpeg = await which("ffmpeg");

  console.log(`  ffmpeg:      ${ffmpeg ? "OK " + ffmpeg : "MISSING"}`);
  console.log(`  tesseract:   ${tess ? "OK " + tess : "MISSING"}`);
  console.log(`  whisper-cli: ${bin ? "OK " + bin : "MISSING"}`);
  console.log(`  model:       ${model ? "OK " + model : "MISSING"}`);

  // quick whisper-cli smoke if possible
  if (bin && model) {
    const help = await execFile(bin, ["-h"], { timeoutMs: 10_000 });
    if (help.code === 0 || help.stderr || help.stdout) {
      console.log(`  whisper-cli runs: OK`);
    }
  }

  console.log(`
Done. Models live in: ${defaultModelDir()}

Next:
  video-mcp doctor
  video-mcp install          # wire into Claude / Codex / Grok

Env overrides:
  WHISPER_CPP_BIN, WHISPER_CPP_MODEL, TESSERACT_BIN
`);

  // print doctor summary
  const deps = await checkDeps();
  const missing = deps.filter((d) => !d.available && d.note?.includes("NEEDED"));
  if (missing.length) {
    console.log("Still missing NEEDED deps:");
    for (const d of missing) console.log(`  ✗ ${d.name}: ${d.note}`);
  } else {
    console.log("All NEEDED deps available.");
  }
}
