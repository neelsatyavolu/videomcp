import { spawn } from "node:child_process";
import { requireFfmpeg } from "../media/deps.js";

const NEAR_DUPLICATE_MAX = 10;

/** Raw 9×8 grayscale pixels of an image, via ffmpeg. */
function grayPixels(ffmpeg: string, image: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpeg,
      ["-loglevel", "error", "-i", image, "-vf", "scale=9:8:flags=area,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      resolve(code === 0 && buf.length === 72 ? buf : null);
    });
  });
}

/** 64-bit difference hash as 16 hex chars; null when the image cannot be read. */
export async function dhashFile(image: string): Promise<string | null> {
  const { ffmpeg } = await requireFfmpeg();
  const px = await grayPixels(ffmpeg, image);
  if (!px) return null;
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px[y * 9 + x]! > px[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function hamming(a: string, b: string): number {
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

export function nearDuplicatePairs(
  items: readonly { id: string; dhash: string | null }[],
  max = NEAR_DUPLICATE_MAX,
): [string, string][] {
  const hashed = items.filter((i): i is { id: string; dhash: string } => i.dhash !== null);
  const pairs: [string, string][] = [];
  for (let i = 0; i < hashed.length; i++) {
    for (let j = i + 1; j < hashed.length; j++) {
      if (hamming(hashed[i]!.dhash, hashed[j]!.dhash) <= max) pairs.push([hashed[i]!.id, hashed[j]!.id]);
    }
  }
  return pairs;
}
