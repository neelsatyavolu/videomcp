import {
  MAX_INLINE_BASE64_CHARS,
  MAX_INLINE_IMAGES,
} from "../constants.js";
import { sampleIndices } from "../media/ocr.js";
import { readInlineFrameBase64 } from "../media/frames.js";
import type { FrameResult } from "../types.js";
import { truncateText } from "../utils/format.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function frameMeta(frames: FrameResult[]) {
  return frames.map((f) => ({
    index: f.index,
    timeSec: f.timeSec,
    path: f.path,
    mimeType: f.mimeType,
    ocrText: f.ocrText,
  }));
}

export async function buildFrameContent(
  text: string,
  frames: FrameResult[],
  inlineImages = true,
  extraStructured?: Record<string, unknown>,
): Promise<ToolResult> {
  const content: ContentBlock[] = [{ type: "text", text: truncateText(text) }];

  let inlined = 0;
  let budget = MAX_INLINE_BASE64_CHARS;
  const inlinedIndices: number[] = [];

  if (inlineImages && frames.length > 0) {
    // Prefer frames with OCR, then fill with evenly spaced samples
    const withOcr = frames
      .map((f, i) => ({ f, i }))
      .filter((x) => x.f.ocrText?.trim());
    const want = Math.min(frames.length, MAX_INLINE_IMAGES);
    const chosen = new Set<number>();

    for (const x of withOcr) {
      if (chosen.size >= want) break;
      chosen.add(x.i);
    }
    for (const i of sampleIndices(frames.length, want)) {
      if (chosen.size >= want) break;
      chosen.add(i);
    }

    const order = [...chosen].sort((a, b) => a - b);

    for (const i of order) {
      const f = frames[i]!;
      try {
        const data = await readInlineFrameBase64(f.path);
        if (data.length > budget && inlined > 0) break;
        if (data.length > 900_000) continue;
        content.push({ type: "image", data, mimeType: "image/jpeg" });
        // Caption so agents know which timestamp they are looking at
        content.push({
          type: "text",
          text: `↑ Frame #${f.index} @ ${f.timeSec.toFixed(2)}s${f.ocrText?.trim() ? ` — OCR: ${f.ocrText.trim().replace(/\s+/g, " ").slice(0, 100)}` : ""}`,
        });
        budget -= data.length;
        inlined += 1;
        inlinedIndices.push(i);
        if (budget < 8_000) break;
      } catch {
        // path still in text
      }
    }

    if (frames.length > inlined) {
      content.push({
        type: "text",
        text: `\n(${inlined} inline thumb(s) evenly sampled; ${frames.length - inlined} more as paths — use video_get_frame for a moment.)`,
      });
    }
  }

  return {
    content,
    structuredContent: {
      frames: frameMeta(frames),
      inlineCount: inlined,
      inlineIndices: inlinedIndices,
      ...(extraStructured ?? {}),
    },
  };
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

export function textResult(
  text: string,
  structuredContent?: object,
): ToolResult {
  return {
    content: [{ type: "text", text: truncateText(text) }],
    ...(structuredContent !== undefined
      ? { structuredContent: structuredContent as Record<string, unknown> }
      : {}),
  };
}
