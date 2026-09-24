import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { which } from "../utils/exec.js";

/** Common whisper.cpp binary names after brew install. */
export async function resolveWhisperCppBin(): Promise<string | null> {
  if (process.env.WHISPER_CPP_BIN) return process.env.WHISPER_CPP_BIN;
  return (
    (await which("whisper-cli")) ||
    (await which("whisper-cpp")) ||
    (await which("whisper.cpp"))
  );
}

/**
 * Resolve a ggml model file for whisper.cpp.
 * Order: WHISPER_CPP_MODEL → WHISPER_MODEL_PATH → cache / share paths.
 */
export async function resolveWhisperCppModel(): Promise<string | null> {
  const candidates = [
    process.env.WHISPER_CPP_MODEL,
    process.env.WHISPER_MODEL_PATH,
    path.join(os.homedir(), ".cache", "whisper-cpp", "ggml-base.en.bin"),
    path.join(os.homedir(), ".cache", "whisper-cpp", "ggml-base.bin"),
    path.join(os.homedir(), ".cache", "whisper", "ggml-base.en.bin"),
    path.join(os.homedir(), ".cache", "whisper", "ggml-base.bin"),
    "/opt/homebrew/share/whisper-cpp/ggml-base.bin",
    "/opt/homebrew/share/whisper-cpp/ggml-base.en.bin",
    "/usr/local/share/whisper-cpp/ggml-base.bin",
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      await access(c);
      return c;
    } catch {
      // next
    }
  }
  return null;
}

export function defaultModelDir(): string {
  return path.join(os.homedir(), ".cache", "whisper-cpp");
}

export function defaultModelPath(model = "base"): string {
  // ggml-base.en.bin is smaller/faster for English; base is multilingual
  const name = model.startsWith("ggml-") ? model : `ggml-${model}.bin`;
  return path.join(defaultModelDir(), name);
}

export const WHISPER_MODEL_URLS: Record<string, string> = {
  "base.en":
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  base:
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  "small.en":
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
  small:
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
};
