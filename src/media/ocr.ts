import path from "node:path";
import { access } from "node:fs/promises";
import { execFile, execOk, which } from "../utils/exec.js";
import type { FrameResult } from "../types.js";
import { requireFfmpeg } from "./deps.js";

let tesseractPath: string | null | undefined;

async function resolveTesseract(): Promise<string | null> {
  if (tesseractPath !== undefined) return tesseractPath;
  if (process.env.VIDEO_MCP_DISABLE_OCR === "1") {
    tesseractPath = null;
    return null;
  }
  tesseractPath =
    process.env.TESSERACT_BIN ||
    (await which("tesseract"));
  return tesseractPath;
}

export async function ocrAvailable(): Promise<boolean> {
  return Boolean(await resolveTesseract());
}

/** Upscale + grayscale + contrast for better OCR on distant signage/UI. */
async function preprocessForOcr(imagePath: string): Promise<string> {
  const { ffmpeg } = await requireFfmpeg();
  const out = path.join(
    path.dirname(imagePath),
    `${path.basename(imagePath, path.extname(imagePath))}_ocrprep.png`,
  );
  try {
    await access(out);
    return out;
  } catch {
    // create
  }
  await execOk(
    ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-i",
      imagePath,
      "-vf",
      "scale=iw*2:ih*2:flags=lanczos,format=gray,eq=contrast=1.4:brightness=0.05",
      "-frames:v",
      "1",
      out,
    ],
    { timeoutMs: 30_000 },
  );
  return out;
}

/** OCR a single image; returns cleaned text or empty string. */
export async function ocrImage(imagePath: string): Promise<string> {
  const bin = await resolveTesseract();
  if (!bin) return "";

  let target = imagePath;
  try {
    target = await preprocessForOcr(imagePath);
  } catch {
    target = imagePath;
  }

  const langs = process.env.TESSDATA_LANG || process.env.OCR_LANG || "eng";
  // Try sparse text (UI/signage) then uniform block
  for (const psm of ["11", "6"]) {
    const r = await execFile(
      bin,
      [target, "stdout", "-l", langs, "--psm", psm],
      { timeoutMs: 45_000 },
    );
    if (r.code === 0) {
      const text = cleanOcr(r.stdout);
      if (text.length >= 3) return text;
    }
  }
  return "";
}

function cleanOcr(raw: string): string {
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 2)
    .filter((l) => /[A-Za-z0-9]{2,}/.test(l))
    // drop lines that are mostly symbols
    .filter((l) => {
      const alnum = (l.match(/[A-Za-z0-9]/g) || []).length;
      return alnum / l.replace(/\s/g, "").length >= 0.5;
    });

  const text = lines.join("\n").trim().slice(0, 800);
  if (!text) return "";

  // Need a real-looking word (5+ letters) so agents aren't fed OCR noise
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  if (!words.some((w) => w.length >= 5)) return "";

  return text;
}

/**
 * OCR a subset of frames in parallel (capped). Mutates frames with ocrText.
 * Samples evenly across the set for long clips.
 */
export async function ocrFrames(
  frames: FrameResult[],
  maxFrames = 12,
  concurrency = 3,
): Promise<{ ocrCount: number; warnings: string[] }> {
  const warnings: string[] = [];
  if (!frames.length) return { ocrCount: 0, warnings };

  const bin = await resolveTesseract();
  if (!bin) {
    warnings.push(
      "OCR skipped — install tesseract (`brew install tesseract`) for on-screen text.",
    );
    return { ocrCount: 0, warnings };
  }

  const indices = sampleIndices(frames.length, maxFrames);
  let ocrCount = 0;
  let i = 0;

  async function worker(): Promise<void> {
    while (i < indices.length) {
      const idx = indices[i++]!;
      const frame = frames[idx]!;
      try {
        const text = await ocrImage(frame.path);
        if (text) {
          frame.ocrText = text;
          ocrCount += 1;
        }
      } catch (err) {
        // non-fatal
        if (warnings.length < 3) {
          warnings.push(
            `OCR failed on frame ${idx}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, indices.length) }, () => worker()),
  );

  return { ocrCount, warnings };
}

/** Evenly spaced indices into [0, n). */
export function sampleIndices(n: number, k: number): number[] {
  if (n <= 0) return [];
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  if (k <= 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    out.push(Math.round((i * (n - 1)) / (k - 1)));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
